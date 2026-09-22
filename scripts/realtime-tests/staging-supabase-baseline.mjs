// Explicit, bounded legacy transport comparison. Importing has no side effects.
import { mkdtemp, writeFile, rename, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createStagingManagementQuery, safeCLIError } from './staging-management.mjs';
import { workloadKind, TypingActivityPolicy, typingActivityTrace, quantiles } from './staging-load-core.mjs';
import { openSupabaseWire, STAGING_REF } from './staging-supabase-wire.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const base = `https://${STAGING_REF}.supabase.co`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const count = (object, key) => { object[key] = (object[key] || 0) + 1; };
const stats = values => ({ ...quantiles(values), mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null });
function check(value, code) { if (!value) throw new Error(code); }
function safeCode(error) { return /^[a-z_0-9]{1,80}$/.test(error?.message || '') ? error.message : 'baseline_failed'; }

export function baselineOptions(args) {
  if (args[0] !== '--run-explicit-staging') throw new Error('explicit_staging_required');
  if (args.length === 1) return { holdSeconds: 120 };
  if (args.length !== 3 || args[1] !== '--hold-seconds' || !['30', '120'].includes(args[2])) throw new Error('invalid_baseline_option');
  return { holdSeconds: Number(args[2]) };
}

export const EMPTY_SQL = `select
 (select count(*) from auth.users)=0 as users_empty,
 (select count(*) from public.rooms)=0 as rooms_empty,
 (select count(*) from private.firebase_live_outbox)=0 as outbox_empty,
 (select count(*) from private.firebase_live_access_snapshots)=0 as snapshots_empty,
 (select count(*) from private.firebase_live_leases)=0 as leases_empty,
 (select count(*) from private.firebase_live_users)=0 as enroll_users_empty,
 (select count(*) from private.firebase_live_rooms)=0 as enroll_rooms_empty,
 (select count(*) from pg_trigger where tgname in ('zz_firebase_messages_shadow','zz_firebase_rooms_shadow','zz_firebase_profiles_shadow') and tgenabled='D')=3 as shadow_disabled,
 not exists(select 1 from private.firebase_live_config where enabled) as config_off,
 exists(select 1 from private.firebase_live_dispatch_config where not enabled and owner_run_id is null) as dispatch_off,
 not exists(select 1 from private.firebase_live_dispatch_state where phase is not null) as dispatch_idle,
 not exists(select 1 from cron.job where jobname='sidey-firebase-live-staging') as cron_absent`;

export function checkEmpty(rows) {
  const row = rows?.[0];
  check(row && ['users_empty', 'rooms_empty', 'outbox_empty', 'snapshots_empty', 'leases_empty',
    'enroll_users_empty', 'enroll_rooms_empty', 'shadow_disabled',
    'config_off', 'dispatch_off', 'dispatch_idle', 'cron_absent'].every(key => row[key] === true), 'staging_not_empty_or_off');
}

export async function cleanupOwned({ users, roomIds, sb, query, journal }) {
  // Recover only exact pre-journaled synthetic emails after uncertain HTTP writes.
  const registered = (await sb('/auth/v1/admin/users?page=1&per_page=1000', undefined, {}, true))?.users;
  check(Array.isArray(registered), 'invalid_cleanup_users');
  for (const user of users) {
    const match = registered.find(value => value.email === user.email);
    if (!user.id) user.id = match?.id;
    check(!user.id || (UUID.test(user.id) && (!match || match.id === user.id)), 'invalid_cleanup_ownership');
  }
  const ids = users.filter(user => user.id).map(user => `'${user.id}'`).join(',');
  if (ids) for (const row of await query(`select id from public.rooms where owner_id in(${ids})`)) {
    check(UUID.test(row.id), 'invalid_cleanup_room'); if (!roomIds.includes(row.id)) roomIds.push(row.id);
  }
  check(roomIds.every(id => UUID.test(id)), 'invalid_cleanup_room');
  await journal();
  if (ids && roomIds.length) await query(`delete from public.rooms where id in(${roomIds.map(id => `'${id}'`).join(',')}) and owner_id in(${ids})`);
  // Attempt every owned deletion even if one fails; never delete an unknown ID.
  let failed = false;
  for (const user of users.filter(value => value.id)) {
    try { await sb(`/auth/v1/admin/users/${user.id}`, undefined, { method: 'DELETE' }, true); }
    catch { failed = true; }
  }
  if (failed) throw new Error('cleanup_user_delete_failed');
}

export async function runSupabaseBaseline(options, { fetcher = fetch, execute = promisify(execFile),
  query: suppliedQuery, openWire = openSupabaseWire, log = console.log } = {}) {
  check([30, 120].includes(options?.holdSeconds), 'invalid_baseline_option');
  const started = Date.now(), deadline = started + 300000, runId = randomUUID();
  const stop = new AbortController(), users = [], roomIds = [], wires = [], expected = new Map(), pendingReads = new Set();
  let admin, anon, recovery, cleanupAllowed = false, closing = false, room, epoch, stage = 'preflight';
  let writes = Promise.resolve(), lastTokenStart = 0;
  const metrics = { runId, transport: 'Supabase Phoenix v1 private Broadcast + Presence; native rendering not exercised',
    usersRequested: 10, holdSeconds: options.holdSeconds, accepted: {}, received: {}, expectedDeliveries: {},
    missingDeliveriesByKind: {}, remoteExpectedDeliveries: {}, remoteMissingDeliveriesByKind: {},
    duplicateDeliveries: 0, actionsAttempted: 0, downloadBytesObserved: 0, httpRequests: 0,
    latencyByKindMs: {}, remoteLatencyByKindMs: {}, sourceRPCByKindMs: {}, messageStagesMs: {},
    billingNote: 'Decoded HTTP response and WebSocket frame body bytes only; not billed messages or billing bytes. Excludes Management API/CLI, TLS and protocol overhead.',
    workload: 'Same activity trace and 2-second non-typing workload ticks as Firebase; one room, one fixed typing actor' };
  const source = {}, received = {}, remote = {}, notification = [], fetchLatency = [], rawNotification = {};
  const abort = code => { if (!stop.signal.aborted) { metrics.failure ||= code; stop.abort(new Error(code)); } };
  const onSignal = () => abort('interrupted');
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  // Reserve one minute for bounded cleanup inside the five-minute wall-clock cap.
  const timer = setTimeout(() => abort('runtime_limit'), 240000);
  const remaining = max => { check(deadline > Date.now(), 'total_runtime_limit'); return Math.max(1, Math.min(max, deadline - Date.now())); };
  const query = suppliedQuery || createStagingManagementQuery({ timeoutSignal: ms => AbortSignal.timeout(remaining(ms)) });
  const bytes = length => {
    metrics.downloadBytesObserved += length;
    if (!closing && metrics.downloadBytesObserved > 128 * 1024 * 1024) { abort('byte_limit'); throw new Error('byte_limit'); }
  };
  async function cli(args) {
    try { return JSON.parse((await execute('supabase', args, { cwd: root, timeout: remaining(30000), maxBuffer: 2 * 1024 * 1024 })).stdout); }
    catch (error) { throw safeCLIError(error); }
  }
  async function flags() {
    const rows = await cli(['secrets', 'list', '--project-ref', STAGING_REF, '--output', 'json']);
    const map = new Map(rows.map(row => [row.name, row.value]));
    for (const [key, value] of Object.entries({ SIDEY_FIREBASE_MODE: 'off', SIDEY_FIREBASE_SHADOW_APPROVED: 'false', SIDEY_FIREBASE_LIVE_APPROVED: 'false' })) {
      check(map.get(key) === digest(value), 'firebase_flags_not_off');
    }
  }
  async function sb(path, token = admin, init = {}, cleanup = false) {
    if (!cleanup) stop.signal.throwIfAborted();
    const response = await fetcher(`${base}${path}`, { ...init, redirect: 'error', headers: {
      apikey: anon, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(remaining(10000)), ...(!cleanup ? [stop.signal] : [])]) });
    metrics.httpRequests++;
    const reader = response.body?.getReader(); let text = '', size = 0; const decoder = new TextDecoder();
    if (reader) try {
      while (true) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength;
        bytes(result.value.byteLength); check(size <= 2 * 1024 * 1024, 'http_body_limit'); text += decoder.decode(result.value, { stream: true }); }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    check([200, 201, 204].includes(response.status), `http_${response.status}`);
    try { return text ? JSON.parse(text) : null; } catch { throw new Error('invalid_http_json'); }
  }
  const rpc = (name, user, body) => sb(`/rest/v1/rpc/${name}`, user.token, { method: 'POST', body: JSON.stringify(body) });
  async function journal() {
    writes = writes.then(async () => {
      const file = join(recovery, 'synthetic-identifiers.json');
      await writeFile(file + '.tmp', JSON.stringify({ runId, supabaseRef: STAGING_REF,
        users: users.map(({ email, id }) => ({ email, id })), roomIds }), { mode: 0o600 });
      await rename(file + '.tmp', file);
    });
    await writes;
  }
  function receive(user, kind, payload) {
    if (closing || stop.signal.aborted || payload.room_id !== room) return;
    const id = kind === 'message_changed' ? payload.message_id : payload.event_id;
    const item = expected.get(id), normalized = kind === 'message_changed' ? 'message' : kind;
    if (!item || item.kind !== normalized) return;
    if (item.notified.has(user.id)) { metrics.duplicateDeliveries++; return; }
    item.notified.add(user.id); const now = Date.now();
    (rawNotification[normalized] ||= []).push(now - item.started);
    const complete = () => {
      item.received.add(user.id); count(metrics.received, normalized);
      (received[normalized] ||= []).push(Date.now() - item.started);
      if (user.id !== item.sender) (remote[normalized] ||= []).push(Date.now() - item.started);
    };
    if (normalized !== 'message') { complete(); return; }
    notification.push(now - item.started);
    const work = (async () => {
      const rows = await sb(`/rest/v1/messages?select=*&id=eq.${id}&room_id=eq.${room}&limit=1`, user.token);
      check(rows?.length === 1 && rows[0].id === id && rows[0].room_id === room && rows[0].body === item.body, 'message_body_mismatch');
      fetchLatency.push(Date.now() - now); complete();
    })().catch(error => abort(safeCode(error))).finally(() => pendingReads.delete(work));
    pendingReads.add(work);
  }
  async function action(sequence, typingAction) {
    const kind = typingAction?.kind || workloadKind(sequence, 0);
    if (!typingAction && kind.startsWith('typing_')) return;
    stop.signal.throwIfAborted(); check(++metrics.actionsAttempted <= 1000, 'action_limit');
    const user = typingAction ? users[0] : users[sequence % 10], id = randomUUID();
    const item = { kind, sender: user.id, started: Date.now(), body: `synthetic load ${runId.slice(0, 8)} ${sequence}`,
      notified: new Set(), received: new Set(), accepted: false };
    expected.set(id, item);
    if (kind === 'message') await rpc('send_message', user, { p_id: id, p_room_id: room, p_body: item.body });
    else if (kind === 'character_throw') await rpc('broadcast_character_throw', user, {
      p_room_id: room, p_realtime_epoch: epoch, p_event_id: id, p_target_user_id: users[(sequence + 1) % 10].id });
    else await rpc('broadcast_room_event', user, { p_room_id: room, p_realtime_epoch: epoch, p_event: kind, p_event_id: id });
    item.accepted = true; count(metrics.accepted, kind); (source[kind] ||= []).push(Date.now() - item.started);
  }
  try {
    try { check((await readFile(join(root, 'supabase/.temp/project-ref'), 'utf8')).trim() === STAGING_REF, 'wrong_linked_project'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const keys = await cli(['projects', 'api-keys', '--project-ref', STAGING_REF, '--output', 'json']);
    admin = keys.find(row => row.name === 'service_role')?.api_key; anon = keys.find(row => row.name === 'anon')?.api_key;
    check(admin && anon, 'missing_staging_keys'); await flags(); checkEmpty(await query(EMPTY_SQL));
    recovery = await mkdtemp(join(tmpdir(), 'sidey-supabase-baseline-'));
    for (let i = 0; i < 10; i++) users.push({ email: `sidey-baseline-${runId}-${i}@example.invalid`, password: randomBytes(32).toString('base64url') });
    await journal(); cleanupAllowed = true; log(`RECOVERY ${recovery}`); stage = 'provision';
    for (const [index, user] of users.entries()) {
      const created = await sb('/auth/v1/admin/users', admin, { method: 'POST', body: JSON.stringify({ email: user.email, password: user.password, email_confirm: true }) });
      user.id = created.id; check(UUID.test(user.id), 'invalid_user_id'); await journal();
      await delay(Math.max(0, lastTokenStart + 2100 - Date.now()), undefined, { signal: stop.signal }); lastTokenStart = Date.now();
      const session = await sb('/auth/v1/token?grant_type=password', anon, { method: 'POST', body: JSON.stringify({ email: user.email, password: user.password }) });
      check(session.user?.id === user.id && session.access_token, 'invalid_user_session'); user.token = session.access_token;
      await rpc('upsert_profile', user, { p_nickname: `비교${index + 1}`, p_character_id: 'minty_pup' });
    }
    stage = 'room';
    const created = (await rpc('create_room', users[0], { p_name: 'staging baseline' }))?.[0];
    check(UUID.test(created?.room_id), 'invalid_room'); room = created.room_id; roomIds.push(room); await journal();
    for (const user of users.slice(1)) { const joined = (await rpc('join_room', user, { p_invite_code: created.invite_code }))?.[0]; check(joined?.room_id === room && !joined.error_code, 'join_failed'); }
    const rooms = await sb(`/rest/v1/rooms?select=id,realtime_epoch&id=eq.${room}`, users[0].token);
    epoch = rooms?.[0]?.realtime_epoch; check(/^\d+$/.test(String(epoch)), 'invalid_epoch');
    stage = 'subscribe';
    for (const user of users) wires.push(await openWire({ anonKey: anon, token: user.token, userId: user.id, roomId: room, epoch,
      signal: stop.signal, onBroadcast: (kind, payload) => receive(user, kind, payload), onFailure: abort, onBytes: bytes }));
    const presenceDeadline = Date.now() + 10000;
    while (!wires.every(wire => users.every(user => wire.presence.has(user.id)))) {
      check(Date.now() < presenceDeadline, 'presence_fanout_timeout'); await delay(50, undefined, { signal: stop.signal });
    }
    metrics.presenceFanoutVerified = true; metrics.connectionsOpened = wires.length;
    stage = 'workload'; const holdStart = Date.now(), duration = options.holdSeconds * 1000;
    metrics.measurementStartISO = new Date(holdStart).toISOString(); metrics.measurementStartBytes = metrics.downloadBytesObserved;
    const policy = new TypingActivityPolicy(), trace = typingActivityTrace(duration, 0);
    const producers = await Promise.allSettled([
      (async () => { let sequence = 0; while (Date.now() - holdStart < duration) {
        const tick = Date.now(); await action(sequence++); await delay(Math.max(0, 2000 - (Date.now() - tick)), undefined, { signal: stop.signal });
      } })(),
      (async () => { let cursor = 0; while (true) {
        const now = Math.min(duration, Date.now() - holdStart);
        while (cursor < trace.length && trace[cursor].at <= now) { const input = trace[cursor++]; if (input.kind === 'edit') policy.edit(input.at); else policy.stop(); }
        const event = policy.poll(now); if (event) { await action(0, event); policy.acknowledge(event, Date.now() - holdStart); }
        if (now >= duration) break; await delay(50, undefined, { signal: stop.signal });
      } })(),
    ].map(work => work.catch(error => { abort(safeCode(error)); throw error; })));
    const failed = producers.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
    metrics.measurementEndISO = new Date().toISOString(); metrics.holdActualMs = Date.now() - holdStart;
    metrics.measurementBodyBytes = metrics.downloadBytesObserved - metrics.measurementStartBytes;
    stage = 'drain';
    const drainEnd = Date.now() + 10000;
    while ([...expected.values()].some(item => item.accepted && item.received.size < 10) && Date.now() < drainEnd) await delay(50, undefined, { signal: stop.signal });
    await Promise.allSettled([...pendingReads]); metrics.drainEndISO = new Date().toISOString();
  } catch (error) { metrics.failure ||= safeCode(error); metrics.failedStage = stage; }
  finally {
    closing = true; clearTimeout(timer); stop.abort();
    await Promise.allSettled(wires.map(wire => wire.close())); await Promise.allSettled([...pendingReads]); await writes.catch(() => {});
    metrics.cleanupFailures = [];
    if (cleanupAllowed) {
      try { await cleanupOwned({ users, roomIds, sb, query, journal }); await flags(); checkEmpty(await query(EMPTY_SQL)); }
      catch (error) { metrics.cleanupFailures.push(safeCode(error)); }
      if (!metrics.cleanupFailures.length) await rm(recovery, { recursive: true, force: true });
      else metrics.recoveryDirectory = recovery;
    }
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
  for (const item of expected.values()) if (item.accepted) {
    metrics.expectedDeliveries[item.kind] = (metrics.expectedDeliveries[item.kind] || 0) + 10;
    metrics.missingDeliveriesByKind[item.kind] = (metrics.missingDeliveriesByKind[item.kind] || 0) + 10 - item.received.size;
    metrics.remoteExpectedDeliveries[item.kind] = (metrics.remoteExpectedDeliveries[item.kind] || 0) + 9;
    const remoteCount = [...item.received].filter(id => id !== item.sender).length;
    metrics.remoteMissingDeliveriesByKind[item.kind] = (metrics.remoteMissingDeliveriesByKind[item.kind] || 0) + 9 - remoteCount;
  }
  for (const [field, values] of Object.entries({ latencyByKindMs: received, remoteLatencyByKindMs: remote, sourceRPCByKindMs: source,
    notificationLatencyByKindMs: rawNotification, messageStagesMs: { notification, fetch: fetchLatency } })) metrics[field] = Object.fromEntries(Object.entries(values).map(([kind, list]) => [kind, stats(list)]));
  metrics.uniqueAcceptedOriginals = Object.values(metrics.accepted).reduce((a, b) => a + b, 0);
  metrics.elapsedMs = Date.now() - started;
  metrics.latencyMs = { message: stats(received.message || []),
    ephemeral: stats(Object.entries(received).filter(([kind]) => kind !== 'message').flatMap(([, list]) => list)) };
  metrics.deliveryVerdict = !metrics.failure && !metrics.cleanupFailures.length && !metrics.duplicateDeliveries
    && Object.values(metrics.missingDeliveriesByKind).every(value => value === 0) ? 'PASS' : 'FAIL';
  metrics.latencyCriteria = { p95MaxMs: 1000, p99MaxMs: 2000, groups: ['message', 'ephemeral'] };
  metrics.latencyVerdict = Object.values(metrics.latencyMs).every(value => value.count > 0 && value.p95 <= 1000 && value.p99 <= 2000) ? 'PASS' : 'FAIL';
  metrics.verdict = metrics.deliveryVerdict === 'PASS' && metrics.latencyVerdict === 'PASS' ? 'PASS' : 'FAIL';
  return metrics;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runSupabaseBaseline(baselineOptions(process.argv.slice(2)));
    console.log(`RESULT ${JSON.stringify(result)}`); process.exitCode = result.verdict === 'PASS' ? 0 : 1;
  } catch (error) { console.log(`FAIL ${safeCode(error)}`); process.exitCode = 1; }
}
