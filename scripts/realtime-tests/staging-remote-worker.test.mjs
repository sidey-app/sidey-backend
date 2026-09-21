import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STAGING, SOURCE_FILES, sourceHashes, validateConfiguration, measuredFetcher, runRemoteWorker } from './staging-remote-worker.mjs';

const runId = '11111111-1111-4111-8111-111111111111';
const hashes = Object.fromEntries(SOURCE_FILES.map(file => [file, 'a'.repeat(64)]));
const config = () => ({ ...STAGING, runId, maxSeconds: 2, sourceSHA256: hashes,
  credentials: { serviceRoleKey: 'fixture-secret', account: { project_id: STAGING.project,
    client_email: `worker@${STAGING.project}.iam.gserviceaccount.com`, private_key: '-----BEGIN PRIVATE KEY-----fixture' } } });

test('staging worker rejects production binding and excessive duration before I/O', async () => {
  for (const change of [{ project: 'sidey-realtime' }, { databaseURL: 'https://production.example' },
    { supabaseRef: 'whtejsviizgejauasqqt' }, { maxSeconds: 3601 }, { sourceSHA256: {} }]) {
    let touched = false;
    await assert.rejects(runRemoteWorker({ ...config(), ...change }, {
      hashProvider: async () => { touched = true; }, fetcher: () => { touched = true; },
    }), /remote_configuration_rejected/);
    assert.equal(touched, false);
  }
  const wrongJWT = `header.${Buffer.from(JSON.stringify({ ref: 'whtejsviizgejauasqqt', role: 'service_role' })).toString('base64url')}.signature`;
  const value = config(); value.credentials.serviceRoleKey = wrongJWT;
  assert.throws(() => validateConfiguration(value), /remote_configuration_rejected/);
});

test('source mismatch prevents token exchange or DB/RTDB work', async () => {
  await assert.rejects(runRemoteWorker(config(), { hashProvider: async () => ({}),
    tokenProvider: () => { assert.fail('unexpected network'); } }), /remote_source_mismatch/);
  const actual = await sourceHashes();
  assert.deepEqual(Object.keys(actual), SOURCE_FILES);
  assert.ok(Object.values(actual).every(value => /^[0-9a-f]{64}$/.test(value)));
});

test('HTTP metrics consume ignored bodies, preserve ETags, classify CAS conflicts and omit secrets', async () => {
  const metrics = { http: {} }, controller = new AbortController();
  let time = 0;
  const fetcher = measuredFetcher(async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    return new Response('"private response"', { status: 412, headers: { etag: '7' } });
  }, controller.signal, metrics, () => time += 5);
  const result = await fetcher(`${STAGING.databaseURL}/v2/access/${runId}.json`, { method: 'PUT', body: 'secret payload' });
  assert.equal(result.headers.get('etag'), '7'); assert.equal(await result.text(), '"private response"');
  const row = metrics.http['rtdb.access.PUT'];
  assert.equal(row.count, 1); assert.equal(row.errors, 1); assert.equal(row.statuses[412], 1);
  assert.equal(row.requestBodyBytes, 14); assert.equal(row.responseBodyBytes, 18); assert.equal(row.durationMs, 5);
  assert.ok(!JSON.stringify(metrics).includes('private')); assert.ok(!JSON.stringify(metrics).includes('secret'));
  await assert.rejects(fetcher('https://production.example/v2/access/x.json'), /remote_target_rejected/);
});

test('worker uses unchanged LiveWorker and drains aborted in-flight RPCs without leaking errors', async () => {
  const stop = new AbortController(), events = []; let tokenCalls = 0, aborted = 0;
  await runRemoteWorker(config(), { signal: stop.signal, hashProvider: async () => hashes,
    tokenProvider: async () => { tokenCalls++; return 'private token'; }, metricsIntervalMs: 10,
    emit: item => { events.push(item); if (item.type === 'ready') setTimeout(() => stop.abort(), 30); },
    fetcher: async (url, init) => {
      assert.equal(new URL(url).origin, STAGING.supabaseURL);
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => { aborted++; reject(new Error('secret upstream response')); }, { once: true });
      });
    } });
  assert.equal(tokenCalls, 1); assert.equal(aborted, 2);
  assert.equal(events[0].type, 'ready'); assert.equal(events.at(-1).type, 'finished');
  assert.equal(events.at(-1).http['rpc.claim_firebase_live'].errors, 1);
  assert.ok(!JSON.stringify(events).includes('private token')); assert.ok(!JSON.stringify(events).includes('secret upstream'));
  assert.match(events.at(-1).billingNote, /not billing bytes/);
});

test('worker enforces maximum runtime and retains separate claim and cleanup cadence', async () => {
  const events = [];
  await runRemoteWorker({ ...config(), maxSeconds: 1 }, { hashProvider: async () => hashes,
    tokenProvider: async () => 'token', emit: item => events.push(item),
    fetcher: async url => new Response(JSON.stringify(url.endsWith('claim_firebase_live') ? [] : { leases: [], events: [], epochs: [] })) });
  const final = events.at(-1); assert.equal(final.type, 'finished');
  assert.ok(final.elapsedMs >= 950 && final.elapsedMs < 3000);
  assert.ok(final.http['rpc.claim_firebase_live'].count >= 2);
  assert.ok(final.http['rpc.firebase_live_maintenance'].count >= 1);
});

test('ready worker does not poll DB until start and can stop while waiting', async () => {
  const stop = new AbortController(), events = [];
  await runRemoteWorker(config(), { signal: stop.signal, hashProvider: async () => hashes,
    tokenProvider: async () => 'token', emit: item => {
      events.push(item); if (item.type === 'ready') setTimeout(() => stop.abort(), 5);
    },
    waitForStart: signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    fetcher: async () => { assert.fail('ready-only must not poll'); } });
  assert.deepEqual(events.map(item => item.type), ['ready', 'finished']);
  assert.deepEqual(events.at(-1).http, {});
});

test('CLI rejects secret-bearing malformed stdin with fixed output and no network', async () => {
  const path = fileURLToPath(new URL('./staging-remote-worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [path], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
  child.stdin.end('not JSON private-secret\n');
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 1); assert.equal(errors, '');
  assert.equal(output, '{"type":"error","code":"remote_worker_failed"}\n');
});
