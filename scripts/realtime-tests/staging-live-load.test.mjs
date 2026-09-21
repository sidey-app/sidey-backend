import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLoadLease } from './staging-load-session.mjs';
import { LoadConnectionDiagnostics } from './staging-connection-diagnostics.mjs';
import { LoadSnapshotRecovery } from './staging-snapshot-recovery.mjs';
import { attemptPublisherWake, recoverableStreamFailure, recoverLoadStream, loadQualityVerdicts, attemptDirectLoadEvent, backgroundErrorSummary, createBackgroundPolicy, retryTransientLoadOperation, renewLoadSessionWithRecovery, prepareLoadActor, loadFailureSummary } from './staging-live-load.mjs';

function fixture(overrides = {}) {
  const calls = [], user = { cursor: '42', token: 'existing-session', descriptor: { epoch: 7 } };
  const stream = { closed: false, async close() { this.closed = true; calls.push('close'); } };
  return { calls, user, stream, options: {
    user, sleep: async ms => calls.push(`delay:${ms}`),
    open: async () => { calls.push('open'); return stream; },
    presence: async () => calls.push('presence'),
    reconcile: async value => { assert.equal(value.cursor, '42'); calls.push('reconcile'); },
    onAttempt: () => calls.push('attempt'), onSuccess: () => calls.push('success'), ...overrides,
  } };
}

const recoveryScope = { userId: 'user', sessionId: 'lease-bound-to-auth-session', roomId: 'room', epoch: 7, path: 'room/epochs/7' };
const recoveryEffect = (id, kind = 'character_throw', occurredAt = 1000) => ({ kind, occurredAt,
  expiresAt: occurredAt + 5000, payload: { event_id: id } });

test('same scope recovery admits unseen unexpired effects but never the first snapshot baseline', () => {
  const state = new LoadSnapshotRecovery(), old = recoveryEffect('old'), fresh = recoveryEffect('fresh', 'character_pulse');
  const first = state.begin(recoveryScope);
  assert.equal(state.allow(first, old, { initial: true, now: 1001 }), false);
  state.initializedSnapshot(first);
  const next = state.begin({ ...recoveryScope });
  assert.equal(next.recovery, true);
  assert.equal(state.allow(next, old, { initial: true, now: 1500 }), false);
  assert.equal(state.allow(next, old, { initial: false, now: 1501 }), false);
  assert.equal(state.allow(next, fresh, { initial: true, now: 1500 }), true);
});

test('recovery retains external delivery dedup and does not impose a global revision cutoff', () => {
  const state = new LoadSnapshotRecovery(), first = state.begin(recoveryScope), received = new Set();
  state.initializedSnapshot(first);
  const deliver = (ticket, event, initial) => {
    if (!state.allow(ticket, event, { initial, now: 1500 }) || received.has(event.payload.event_id)) return false;
    received.add(event.payload.event_id); return true;
  };
  const newer = { ...recoveryEffect('newer'), revision: '100' }, older = { ...recoveryEffect('older'), revision: '99' };
  assert.equal(deliver(first, newer, false), true);
  const next = state.begin(recoveryScope);
  assert.equal(deliver(next, newer, true), false);
  assert.equal(deliver(next, older, true), true);
  assert.equal(deliver(next, older, false), false);
});

test('recovery never extends original lifetime, accepts exact remaining window and rejects malformed TTL', () => {
  const state = new LoadSnapshotRecovery(), first = state.begin(recoveryScope);
  state.initializedSnapshot(first); const next = state.begin(recoveryScope), event = recoveryEffect('event');
  assert.equal(state.allow(next, event, { initial: true, now: 5999 }), true);
  assert.equal(state.allow(next, event, { initial: true, now: 6000 }), false);
  for (const invalid of [{ expiresAt: 6001 }, { occurredAt: 7001 }, { expiresAt: Infinity }, { occurredAt: NaN }, { expiresAt: 1000 }]) {
    assert.equal(state.allow(next, { ...event, ...invalid }, { initial: true, now: 2000 }), false);
  }
  assert.equal(event.expiresAt, 6000);
});

test('identity, lease session, room, epoch and path changes start a fresh baseline and fence old callbacks', () => {
  for (const [key, changed] of Object.entries({ userId: 'other', sessionId: 'other', roomId: 'other', epoch: 8, path: 'other' })) {
    const state = new LoadSnapshotRecovery(), first = state.begin(recoveryScope);
    state.initializedSnapshot(first);
    const scope = { ...recoveryScope, [key]: changed }, next = state.begin(scope);
    assert.equal(next.recovery, false, key);
    assert.equal(state.current(first, recoveryScope), false, key);
    assert.equal(state.current(next, recoveryScope), false, key);
    assert.equal(state.current(next, scope), true, key);
    assert.equal(state.allow(first, recoveryEffect('old'), { initial: false, now: 1500 }), false, key);
    assert.equal(state.allow(next, recoveryEffect('new'), { initial: true, now: 1500 }), false, key);
  }
});

test('failed first stream before a root snapshot cannot enable recovery effects', () => {
  const state = new LoadSnapshotRecovery(), first = state.begin(recoveryScope), next = state.begin(recoveryScope);
  state.initializedSnapshot(first);
  assert.equal(next.recovery, false);
  assert.equal(state.allow(next, recoveryEffect('event'), { initial: true, now: 1500 }), false);
  state.initializedSnapshot(next);
  assert.equal(state.begin(recoveryScope).recovery, true);
});

test('initial suppression cache fails closed on capacity and removes only expired entries', () => {
  const state = new LoadSnapshotRecovery({ limit: 1 }), first = state.begin(recoveryScope);
  assert.equal(state.allow(first, recoveryEffect('a'), { initial: true, now: 1500 }), false);
  assert.throws(() => state.allow(first, recoveryEffect('b'), { initial: true, now: 1500 }), /snapshot_recovery_capacity/);
  assert.equal(state.allow(first, recoveryEffect('b', 'character_pulse', 6000), { initial: true, now: 6000 }), false);
  assert.equal(state.suppressed.size, 1);
  assert.equal(state.allow(first, { kind: 'typing_stop' }, { initial: true, now: 6000 }), true);
});

test('scope expiration high water survives reconnect and clock rollback without excluding fresh UUIDs', () => {
  const state = new LoadSnapshotRecovery(), first = state.begin(recoveryScope), baseline = recoveryEffect('baseline');
  assert.equal(state.allow(first, baseline, { initial: true, now: 1000 }), false);
  state.initializedSnapshot(first);
  let next = state.begin(recoveryScope);
  assert.equal(state.allow(next, baseline, { initial: true, now: 6000 }), false);
  assert.equal(state.suppressed.size, 0, 'the expired baseline UUID was pruned');
  next = state.begin(recoveryScope);
  assert.equal(state.allow(next, baseline, { initial: true, now: 2000 }), false, 'clock rollback cannot revive a pruned UUID');
  assert.equal(state.allow(next, baseline, { initial: false, now: 2000 }), false, 'a later patch cannot revive it either');
  assert.equal(state.allow(next, recoveryEffect('fresh', 'character_pulse', 5900), { initial: true, now: 2000 }), true,
    'fresh UUID uses its own expiry, not a publication revision or occurredAt cutoff');
  assert.equal(state.nowHighWater, 6000);
  const changed = state.begin({ ...recoveryScope, epoch: 8, path: 'room/epochs/8' });
  state.initializedSnapshot(changed);
  const changedRecovery = state.begin({ ...recoveryScope, epoch: 8, path: 'room/epochs/8' });
  assert.equal(state.allow(changedRecovery, recoveryEffect('new-scope'), { initial: true, now: 2000 }), true,
    'a new authorization scope owns a new expiration clock');
  assert.equal(state.nowHighWater, 2000);
});

test('connection diagnostics anchor real wall times to hold without counting preparation as workload', () => {
  const at = 1790000000000, emitted = [];
  const diagnostics = new LoadConnectionDiagnostics({ emit: value => emitted.push(value) });
  const identity = { userIndex: 2, roomIndex: 0, streamIndex: 0 };
  diagnostics.record('stream_open', identity, at - 3000);
  diagnostics.record('stream_closed', { ...identity, reason: 'sse_ended', leaseRemainingMs: -50 }, at - 2000);
  assert.equal(emitted[0].elapsedMs, null);
  diagnostics.startHold(at); diagnostics.startHold(at + 1);
  diagnostics.record('renewal_success', { ...identity, oldLeaseRemainingMs: 12000,
    newLeaseRemainingMs: 599000, durationMs: 1000, renewing: false }, at + 1000);
  assert.deepEqual(diagnostics.report.timeline.map(value => value.elapsedMs), [-3000, -2000, 1000]);
  assert.equal(diagnostics.report.timeline[1].leaseRemainingMs, -50);
  assert.equal(diagnostics.report.timeline[2].newLeaseRemainingMs, 599000);
  assert.equal(emitted[0].elapsedMs, null, 'already emitted pre-hold line must not be mutated');
});

test('connection diagnostics strictly discard identifiers, provider text and invalid numbers', () => {
  const diagnostics = new LoadConnectionDiagnostics();
  const secret = 'https://provider.invalid/user@example.invalid?token=SECRET-UUID';
  diagnostics.startHold(1790000000000);
  diagnostics.record('stream_closed', { userIndex: 0, roomIndex: 1, streamIndex: 2, reason: secret,
    durationMs: NaN, leaseRemainingMs: Infinity, lastChunkAgeMs: 10, renewing: 'true',
    token: secret, url: secret, message: secret, uuid: secret }, 1790000000010);
  diagnostics.record(secret, { userIndex: 0, roomIndex: 1 }, 1790000000010);
  diagnostics.record('stream_open', { userIndex: secret, roomIndex: 1 }, 1790000000010);
  assert.deepEqual(diagnostics.report.timeline, [{ stage: 'stream_closed', elapsedMs: 10,
    userIndex: 0, roomIndex: 1, streamIndex: 2, lastChunkAgeMs: 10, reason: 'unclassified' }]);
  diagnostics.missing('character_throw', 1790000000001, { userIndex: 0, roomIndex: 1,
    connected: false, streamIndex: 2, token: secret }, 1790000000020);
  assert.equal(JSON.stringify(diagnostics.report).includes(secret), false);
});

test('diagnostics bound both retained collections and still emit every close after overflow', async () => {
  let emitted = 0;
  const diagnostics = new LoadConnectionDiagnostics({ timelineLimit: 2, missingLimit: 2,
    emit: () => { emitted++; if (emitted === 1) throw new Error('observer'); return Promise.reject(new Error('observer')); } });
  diagnostics.startHold(1000);
  for (let index = 0; index < 5; index++) {
    diagnostics.record('stream_closed', { userIndex: 0, roomIndex: 0, reason: 'sse_ended' }, 1000 + index);
    diagnostics.missing('typing_stop', 1000 + index, { userIndex: 0, roomIndex: 0 }, 1010);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(emitted, 5);
  assert.equal(diagnostics.report.timeline.length, 2); assert.equal(diagnostics.report.timelineOverflow, 3);
  assert.equal(diagnostics.report.missing.length, 2); assert.equal(diagnostics.report.missingOverflow, 3);
  assert.throws(() => new LoadConnectionDiagnostics({ timelineLimit: 12001 }), /invalid_diagnostic_limit/);
  assert.throws(() => new LoadConnectionDiagnostics({ missingLimit: 1001 }), /invalid_diagnostic_limit/);
});

test('missing samples correlate synthetic receiver connection gaps without claiming causation', () => {
  const diagnostics = new LoadConnectionDiagnostics(), identity = { userIndex: 4, roomIndex: 1 };
  diagnostics.startHold(1000);
  diagnostics.record('stream_open', { ...identity, streamIndex: 0 }, 900);
  diagnostics.record('stream_closed', { ...identity, streamIndex: 0, reason: 'sse_ended' }, 1200);
  diagnostics.record('stream_open', { ...identity, streamIndex: 1 }, 1500);
  diagnostics.record('stream_closed', { userIndex: 5, roomIndex: 1, streamIndex: 0 }, 1250);
  diagnostics.missing('character_throw', 1300, { ...identity, connected: true, streamIndex: 1 }, 2000);
  assert.deepEqual(diagnostics.report.missing[0], { kind: 'character_throw', sentElapsedMs: 300,
    userIndex: 4, roomIndex: 1, verificationElapsedMs: 1000, historyTruncated: false,
    connectedAtVerification: true, streamIndexAtVerification: 1, hasConnectionHistory: true,
    connectedAtSend: false, streamIndexAtSend: 0, previousCloseBeforeSentMs: 100 });
  diagnostics.missing('character_pulse', 1100, identity, 2000);
  assert.equal(diagnostics.report.missing[1].connectedAtSend, true);
  assert.equal(diagnostics.report.missing[1].nextCloseAfterSentMs, 100);
});

test('truncated or unanchored history never asserts the connection state at send', () => {
  const diagnostics = new LoadConnectionDiagnostics({ timelineLimit: 1 }), identity = { userIndex: 0, roomIndex: 0 };
  diagnostics.record('stream_open', identity, 1000);
  diagnostics.missing('message', 1050, identity, 1100);
  assert.equal(diagnostics.report.missing[0].sentElapsedMs, null);
  assert.equal(diagnostics.report.missing[0].connectedAtSend, undefined);
  diagnostics.startHold(1000);
  diagnostics.record('stream_closed', identity, 1100);
  diagnostics.missing('typing_stop', 1150, identity, 1200);
  assert.equal(diagnostics.report.missing[1].historyTruncated, true);
  assert.equal(diagnostics.report.missing[1].connectedAtSend, undefined);
});

test('failed recovery observation cannot change retries or fatal rejection', async () => {
  let failures = 0, attempts = 0;
  const { options, user, stream } = fixture({ open: async () => {
    if (++attempts === 1) throw new Error('sse_network_error'); return stream;
  }, onFailure: () => { failures++; throw new Error('observer'); } });
  assert.equal(await recoverLoadStream(options), true);
  assert.equal(failures, 1); assert.equal(user.streamRecoveryAttempts, 2);
  const fatal = fixture({ open: async () => { throw new Error('sse_permission_revoked'); },
    onFailure: async () => { throw new Error('observer'); } });
  await assert.rejects(recoverLoadStream(fatal.options), /sse_permission_revoked/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fatal.user.streamRecoveryAttempts, 1);
});

test('only transient transport failures permit receiver reconnection', () => {
  for (const code of ['sse_ended', 'sse_network_error', 'sse_open_timeout', 'sse_initial_timeout',
    'sse_closed_before_initial', 'sse_http_408', 'sse_http_429', 'sse_http_500', 'sse_http_503']) {
    assert.equal(recoverableStreamFailure(new Error(code)), true, code);
  }
  for (const code of ['sse_permission_revoked', 'sse_http_401', 'sse_http_403', 'sse_invalid_content_type',
    'invalid_json', 'renewal_identity_changed', 'http_403', 'request_failed']) {
    assert.equal(recoverableStreamFailure(new Error(code)), false, code);
  }
});

test('recovery restores receiver and reconciles durable messages without replacing identity or replaying producers', async () => {
  const { calls, user, stream, options } = fixture();
  assert.equal(await recoverLoadStream(options), true);
  assert.deepEqual(calls, ['delay:250', 'attempt', 'open', 'presence', 'reconcile', 'success']);
  assert.equal(user.stream, stream); assert.equal(user.token, 'existing-session');
  assert.equal(user.descriptor.epoch, 7); assert.equal(user.streamRecoveryAttempts, 1);
});

test('repeated network failure has a finite per-interruption attempt budget and backoff', async () => {
  const { calls, user, options } = fixture({ open: async () => { throw new Error('sse_network_error'); } });
  await assert.rejects(recoverLoadStream(options), /stream_reconnect_exhausted/);
  assert.equal(user.streamRecoveryAttempts, 3);
  assert.deepEqual(calls, ['delay:250', 'attempt', 'delay:500', 'attempt', 'delay:1000', 'attempt']);
});

test('per-user attempt budget survives successive interruptions', async () => {
  const { user, options, calls } = fixture();
  user.streamRecoveryAttempts = 11;
  assert.equal(await recoverLoadStream(options), true);
  calls.length = 0;
  await assert.rejects(recoverLoadStream(options), /stream_recovery_budget_exhausted/);
  assert.deepEqual(calls, []); assert.equal(user.streamRecoveryAttempts, 12);
});

test('permission rejection aborts immediately and never retries', async () => {
  const { user, calls, options } = fixture({ open: async () => { throw new Error('sse_permission_revoked'); } });
  await assert.rejects(recoverLoadStream(options), /sse_permission_revoked/);
  assert.equal(user.streamRecoveryAttempts, 1);
  assert.deepEqual(calls, ['delay:250', 'attempt']);
});

test('replacement lost during reconciliation is closed before another bounded attempt', async () => {
  const { calls, user, options } = fixture(); let count = 0;
  options.open = async () => ({ closed: false, async close() { this.closed = true; calls.push('close'); } });
  options.reconcile = async () => { calls.push('reconcile'); if (++count === 1) user.stream.closed = true; };
  assert.equal(await recoverLoadStream(options), true);
  assert.equal(user.streamRecoveryAttempts, 2); assert.equal(user.stream.closed, false);
  assert.deepEqual(calls, ['delay:250', 'attempt', 'presence', 'reconcile', 'close', 'delay:500', 'attempt', 'presence', 'reconcile', 'success']);
});

test('shutdown during opening closes the candidate before recovery settles', async () => {
  const { calls, options, stream } = fixture(); let stopping = false;
  options.stopping = () => stopping;
  options.open = async () => { stopping = true; return stream; };
  assert.equal(await recoverLoadStream(options), false);
  assert.equal(stream.closed, true); assert.deepEqual(calls, ['delay:250', 'attempt', 'close']);
});

test('shutdown during backoff starts no request', async () => {
  const { calls, options } = fixture(); let stopping = false;
  options.stopping = () => stopping; options.sleep = async () => { stopping = true; };
  assert.equal(await recoverLoadStream(options), false); assert.deepEqual(calls, []);
});

test('presence authorization failure closes the candidate and remains fatal', async () => {
  const { options, stream, user } = fixture({ presence: async () => { throw new Error('http_403'); } });
  await assert.rejects(recoverLoadStream(options), /http_403/);
  assert.equal(stream.closed, true); assert.equal(user.streamRecoveryAttempts, 1);
});

test('stream and latency verdicts remain independent, including aborted runs', () => {
  const interrupted = loadQualityVerdicts({ streamUnexpectedClose: 1,
    remoteLatencyByKind: { message: [25], character_throw: [45] } });
  assert.equal(interrupted.streamIntegrityVerdict, 'FAIL');
  assert.equal(interrupted.latencyGate.message.passed, true);
  assert.equal(interrupted.latencyGate.character_throw.passed, true);
  const slow = loadQualityVerdicts({ streamUnexpectedClose: 0,
    remoteLatencyByKind: { message: [1200], character_throw: [] } });
  assert.equal(slow.streamIntegrityVerdict, 'PASS');
  assert.equal(slow.latencyGate.message.passed, false);
  assert.equal(slow.latencyGate.character_throw.passed, false);
});

test('503 drops exactly one transient attempt and preserves a failing delivery verdict', async () => {
  let attempts = 0; const metrics = { directFunctionFailures: 0, streamUnexpectedClose: 0,
    remoteLatencyByKind: { message: [25], character_throw: [45] } };
  assert.equal(await attemptDirectLoadEvent(async () => {
    attempts++; throw new Error('direct_event_http_503');
  }, () => { metrics.directFunctionFailures++; }), false);
  assert.equal(attempts, 1);
  const verdicts = loadQualityVerdicts(metrics);
  assert.equal(verdicts.directDeliveryVerdict, 'FAIL');
  assert.equal(verdicts.latencyGate.character_throw.passed, true);
});

test('direct auth, epoch and contract failures remain fatal after one attempt', async () => {
  for (const code of ['direct_event_http_401', 'direct_event_http_403', 'direct_event_http_409', 'direct_event_not_published']) {
    let attempts = 0, failures = 0;
    await assert.rejects(attemptDirectLoadEvent(async () => { attempts++; throw new Error(code); },
      () => { failures++; }), { message: code });
    assert.equal(attempts, 1); assert.equal(failures, 1);
  }
});

function backgroundFixture() {
  const records = [], fatals = [], timers = new Set(); let now = 0, stopped = false;
  const policy = createBackgroundPolicy({ record: detail => records.push(detail), onFatal: code => fatals.push(code),
    now: () => now, stopping: () => stopped,
    setTimer: (callback, ms) => { assert.equal(ms, 60000); timers.add(callback); return callback; },
    clearTimer: timer => timers.delete(timer) });
  return { policy, records, fatals, timers, advance: ms => { now += ms; }, stop: () => { stopped = true; } };
}
const failBackground = code => async () => { throw new Error(code); };

test('background diagnostics never retain error bodies, URLs, arbitrary names or causes', () => {
  const unsafe = new Error('https://secret.example/?token=private');
  unsafe.name = 'private-name'; unsafe.cause = { code: 'private-value' };
  assert.deepEqual(backgroundErrorSummary(unsafe), { name: 'Error', code: 'background_error', causeCode: null });
  const network = new TypeError('fetch failed', { cause: { code: 'ECONNRESET', message: 'private' } });
  assert.deepEqual(backgroundErrorSummary(network), { name: 'TypeError', code: 'network_failed', causeCode: 'ECONNRESET' });
  assert.equal(backgroundErrorSummary(new Error('http_403:private_provider_code')).code, 'http_403');
});

test('individual transient presence failure is recorded once and never retried', async () => {
  const { policy, records, timers } = backgroundFixture(); let calls = 0;
  assert.equal(await policy.attempt('presence', async () => { calls++; throw new TypeError('fetch failed'); }), false);
  assert.equal(calls, 1); assert.equal(records[0].role, 'presence'); assert.equal(timers.size, 0);
  assert.equal(await policy.attempt('presence', async () => { calls++; }), true);
  assert.equal(calls, 2); // An explicitly requested later heartbeat, not an internal retry.
});

test('three consecutive observation failures terminate the bounded observation grace', async () => {
  const { policy, records, fatals, timers } = backgroundFixture();
  assert.equal(await policy.attempt('queue', failBackground('management_network_failed')), false);
  assert.equal(await policy.attempt('queue', failBackground('management_http_503')), false);
  await assert.rejects(policy.attempt('queue', failBackground('management_timeout')), /queue_observation_unavailable/);
  assert.deepEqual(fatals, ['queue_observation_unavailable']); assert.equal(records.length, 3); assert.equal(timers.size, 0);
});

test('successful queue observation resets consecutive limits but preserves recorded failures', async () => {
  const { policy, records, timers } = backgroundFixture();
  for (let i = 0; i < 2; i++) await policy.attempt('queue', failBackground('management_timeout'));
  assert.equal(timers.size, 1);
  await policy.attempt('queue', async () => {}); assert.equal(timers.size, 0);
  assert.equal(await policy.attempt('queue', failBackground('management_timeout')), false);
  assert.equal(records.length, 3); policy.dispose(); assert.equal(timers.size, 0);
});

test('observation outage watchdog aborts after 60 seconds even while a later sample is pending', async () => {
  const { policy, fatals, timers, advance } = backgroundFixture();
  await policy.attempt('queue', failBackground('management_network_failed'));
  advance(60000); for (const callback of timers) callback();
  assert.deepEqual(fatals, ['queue_observation_unavailable']); policy.dispose();
});

test('auth, epoch, malformed data and safety limits always remain fatal for optional background roles', async () => {
  for (const role of ['queue', 'presence']) for (const code of ['http_401', 'http_403', 'management_http_401',
    'management_http_403', 'renewal_identity_changed', 'sse_permission_revoked', 'download_budget',
    'action_budget', 'invalid_worker_byte_counter', 'management_response_invalid']) {
    const { policy, records, timers } = backgroundFixture();
    await assert.rejects(policy.attempt(role, failBackground(code)), { message: code });
    assert.equal(records.length, 1); assert.equal(timers.size, 0);
  }
});

test('renewal, worker and reconcile errors are tagged and fatal even for network failures', async () => {
  for (const role of ['renewal', 'worker', 'worker_cleanup', 'reconcile']) {
    const { policy, records } = backgroundFixture();
    await assert.rejects(policy.attempt(role, async () => { throw new TypeError('fetch failed'); }), /fetch failed/);
    assert.deepEqual(records, [{ role, name: 'TypeError', code: 'network_failed', causeCode: null }]);
  }
});

test('cleanup cancellation does not become new background evidence or arm a watchdog', async () => {
  const { policy, records, timers, stop } = backgroundFixture(); stop();
  await assert.rejects(policy.attempt('queue', failBackground('management_timeout')), /management_timeout/);
  assert.equal(records.length, 0); assert.equal(timers.size, 0);
});

test('background failure makes quality FAIL independently of latency, stream and event success', () => {
  const verdict = loadQualityVerdicts({ backgroundFailures: 1, streamUnexpectedClose: 0,
    directFunctionFailures: 0, remoteLatencyByKind: { message: [100], character_throw: [100] } });
  assert.equal(verdict.backgroundIntegrityVerdict, 'FAIL'); assert.equal(verdict.streamIntegrityVerdict, 'PASS');
  assert.equal(verdict.directDeliveryVerdict, 'PASS'); assert.equal(verdict.latencyGate.message.passed, true);
});

function boundedFixture() {
  const records = [], delays = []; let stopped = false;
  return { records, delays, stop: () => { stopped = true; },
    options: { record: detail => records.push(detail), sleep: async ms => delays.push(ms), stopping: () => stopped } };
}
const dnsFailure = () => new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });

test('read recovery records every failed attempt including DNS cause, preserves response and is bounded', async () => {
  const { records, delays, options } = boundedFixture(); let calls = 0;
  const result = await retryTransientLoadOperation('reconcile', async () => {
    if (++calls < 3) throw dnsFailure(); return { changes: ['durable'], cursor: '42' };
  }, options);
  assert.deepEqual(result, { changes: ['durable'], cursor: '42' }); assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
  assert.deepEqual(records.map(row => [row.role, row.attempt, row.causeCode]), [['reconcile', 1, 'ENOTFOUND'], ['reconcile', 2, 'ENOTFOUND']]);
  let exhausted = 0;
  await assert.rejects(retryTransientLoadOperation('reconcile', async () => { exhausted++; throw dnsFailure(); }, options), /fetch failed/);
  assert.equal(exhausted, 3);
});

test('read recovery retries 408/429/5xx but rejects auth, epoch, malformed data and send roles immediately', async () => {
  for (const code of ['http_408', 'http_429', 'http_503']) {
    const { records, options } = boundedFixture(); let calls = 0;
    await retryTransientLoadOperation('reconcile', async () => { if (++calls === 1) throw new Error(code); }, options);
    assert.equal(calls, 2); assert.equal(records.length, 1);
  }
  for (const code of ['http_401', 'http_403', 'renewal_identity_changed', 'unexpected_cursor_reset', 'invalid_bootstrap']) {
    const { records, delays, options } = boundedFixture();
    await assert.rejects(retryTransientLoadOperation('reconcile', failBackground(code), options), { message: code });
    assert.equal(records.length, 1); assert.deepEqual(delays, []);
  }
  const { options } = boundedFixture(); let calls = 0;
  await assert.rejects(retryTransientLoadOperation('send_message', async () => { calls++; }, options), /invalid_load_recovery/);
  assert.equal(calls, 0);
});

test('read recovery retains durable progress after a later page fails', async () => {
  const { options } = boundedFixture(); let cursor = '0', first = true; const queried = [], received = [];
  await retryTransientLoadOperation('reconcile', async () => {
    queried.push(cursor);
    if (cursor === '0') { received.push('message1'); cursor = '1'; }
    if (first) { first = false; throw dnsFailure(); }
    received.push('message2'); cursor = '2';
  }, options);
  assert.deepEqual(queried, ['0', '1']); assert.deepEqual(received, ['message1', 'message2']);
});

test('stop during retry backoff performs no next attempt and remains fatal', async () => {
  const { options, stop, records } = boundedFixture(); let calls = 0;
  options.sleep = async () => stop();
  await assert.rejects(retryTransientLoadOperation('reconcile', async () => { calls++; throw dnsFailure(); }, options), /load_recovery_stopped/);
  assert.equal(calls, 1); assert.equal(records.length, 1);
});

function renewalFixture() {
  const id = '11111111-1111-4111-8111-111111111111';
  const descriptor = { roomId: id, epoch: 1, path: `v2/rooms/${id}/epochs/1` };
  const config = { database: 'https://staging.example', apiKey: 'synthetic' };
  const lease = { enabled: true, protocolVersion: 2, mode: 'live', databaseURL: config.database,
    firebaseApiKey: config.apiKey, sessionId: id, streams: [descriptor], serverTime: 1000000,
    leaseExpiresAt: 1600000, customToken: 'synthetic' };
  const stream = { closed: false, updateAuthorizationDeadline() {}, close() { throw new Error('must_not_close'); } };
  const user = { ready: true, renewAt: 0, sessionId: id, room: { id }, descriptor, cursor: '42', stream,
    leaseExpiresAt: 1060000, leaseAuthorizationExpiresAt: 1060000, serverClockOffset: 0, firebaseTokenExpiresAt: 4600000 };
  const operations = { now: () => 1000000, bootstrap: async () => lease,
    validate: value => validateLoadLease(value, { ...config, user, now: 1000000 }) };
  return { user, operations, stream, lease };
}

test('lost bootstrap response retries lease validation without replacing the live stream', async () => {
  const { user, operations, stream, lease } = renewalFixture();
  const { options, records } = boundedFixture(); let attempts = 0;
  operations.bootstrap = async () => { if (++attempts === 1) throw dnsFailure(); return lease; };
  assert.equal(await renewLoadSessionWithRecovery(user, operations, options), true);
  assert.equal(user.renewals, 1); assert.equal(user.renewing, false); assert.equal(user.cursor, '42');
  assert.equal(user.renewAt, 1540000); assert.equal(user.stream, stream); assert.equal(stream.closed, false);
  assert.equal(records.length, 1); assert.equal(records[0].role, 'renewal'); assert.equal(records[0].causeCode, 'ENOTFOUND');
  assert.equal(attempts, 2);
});

test('retry still rejects a changed session or epoch after an unknown bootstrap outcome', async () => {
  for (const change of ['session', 'epoch']) {
    const { user, operations, lease, stream } = renewalFixture(); let count = 0;
    operations.bootstrap = async () => {
      if (++count === 1) throw dnsFailure();
      if (change === 'session') return { ...lease, sessionId: '22222222-2222-4222-8222-222222222222' };
      return { ...lease, streams: [{ ...lease.streams[0], epoch: 2, path: lease.streams[0].path.replace('/epochs/1', '/epochs/2') }] };
    };
    const { options, records } = boundedFixture();
    await assert.rejects(renewLoadSessionWithRecovery(user, operations, options), /renewal_identity_changed/);
    assert.equal(records.length, 2); assert.equal(user.renewals, undefined); assert.equal(user.descriptor.epoch, 1);
    assert.equal(user.stream, stream); assert.equal(user.leaseExpiresAt, 1060000);
  }
});

test('lease recovery stops at three attempts and preserves the previous authorization deadline', async () => {
  const { user, operations, stream } = renewalFixture(); const { options, records, delays } = boundedFixture();
  let calls = 0; operations.bootstrap = async () => { calls++; throw dnsFailure(); };
  await assert.rejects(renewLoadSessionWithRecovery(user, operations, options), /fetch failed/);
  assert.equal(calls, 3); assert.equal(records.length, 3); assert.deepEqual(delays, [250, 500]);
  assert.equal(user.renewals, undefined); assert.equal(user.renewAt, 0); assert.equal(user.renewing, false);
  assert.equal(user.stream, stream); assert.equal(stream.closed, false); assert.equal(user.leaseExpiresAt, 1060000);
});

test('transient direct network/timeouts are dropped once but stopped aborts and auth stay fatal', async () => {
  for (const error of [dnsFailure(), new DOMException('timeout', 'TimeoutError'), new Error('direct_event_http_408')]) {
    let calls = 0, failures = 0;
    assert.equal(await attemptDirectLoadEvent(async () => { calls++; throw error; }, () => failures++), false);
    assert.equal(calls, 1); assert.equal(failures, 1);
  }
  const error = dnsFailure();
  await assert.rejects(attemptDirectLoadEvent(async () => { throw error; }, () => {}, { stopping: () => true }), /fetch failed/);
  await assert.rejects(attemptDirectLoadEvent(async () => { throw new DOMException('stopped', 'AbortError'); }, () => {}), { name: 'AbortError' });
});

test('stream reconnect retains the new receiver when its optional presence heartbeat has one network failure', async () => {
  const { options, user, stream } = fixture(); const { policy, records } = backgroundFixture();
  options.presence = () => policy.attempt('presence', async () => { throw dnsFailure(); });
  assert.equal(await recoverLoadStream(options), true); assert.equal(user.stream, stream); assert.equal(stream.closed, false);
  assert.equal(records.length, 1); assert.equal(records[0].causeCode, 'ENOTFOUND');
});

test('publisher wake failure cannot undo a committed message and never retries its request', async () => {
  for (const error of [dnsFailure(), new Error('http_401'), new Error('http_503')]) {
    let requests = 0, failures = 0;
    const committed = true;
    assert.equal(await attemptPublisherWake(async () => { requests++; throw error; }, () => failures++), false);
    assert.equal(committed, true); assert.equal(requests, 1); assert.equal(failures, 1);
  }
  assert.equal(loadQualityVerdicts({ streamUnexpectedClose: 0, remoteLatencyByKind: {}, wakeFunctionFailures: 1 }).wakeDeliveryVerdict, 'FAIL');
});

test('large CLI run without the separate auth preparation approval stops before any staging operation', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  let result;
  try {
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./staging-live-load.mjs', import.meta.url)),
      '--run-explicit-staging', '--users', '2400', '--hold-seconds', '600', '--publisher', 'edge',
      '--direct-events', 'true', '--typing-workload', 'activity'], {
      env: { ...process.env, SIDEY_STAGING_AUTH_LOAD_APPROVED: '' }, timeout: 5000, maxBuffer: 65536 });
    assert.fail('unapproved large run must stop');
  } catch (error) { result = error; }
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAIL explicit_staging_guard code=auth_rate_approval_required/);
  assert.doesNotMatch(result.stdout, /STEP baseline|STEP provision|RECOVERY /);
  const metrics = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice(7));
  assert.equal(metrics.httpRequests, 0);
  assert.equal(metrics.connectionsOpened, 0);
});

test('CLI requires the staging Firebase API key through environment before any remote operation', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  let result;
  try {
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./staging-live-load.mjs', import.meta.url)),
      '--run-explicit-staging', '--users', '10', '--hold-seconds', '30'], {
      env: { ...process.env, SIDEY_FIREBASE_STAGING_WEB_API_KEY: '' }, timeout: 5000, maxBuffer: 65536 });
    assert.fail('missing staging API key must stop');
  } catch (error) { result = error; }
  assert.equal(result.code, 1);
  assert.match(result.stdout, /FAIL explicit_staging_guard code=firebase_api_key_required/);
  assert.doesNotMatch(result.stdout, /STEP baseline|STEP provision|RECOVERY /);
  const metrics = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('RESULT ')).slice(7));
  assert.equal(metrics.httpRequests, 0);
  assert.equal(metrics.connectionsOpened, 0);
});

function preparationFixture() {
  const user = {}, calls = [], records = [], delays = [];
  let sequence = 0, clock = 1000, stopped = false;
  const operations = {
    bootstrap: async () => { calls.push('bootstrap'); clock += 10; return { customToken: `custom-${++sequence}` }; },
    validate: (value, actor, requestedAt) => {
      assert.equal(actor, user); calls.push(`validate:${requestedAt}`);
      return { descriptor: { epoch: 7 }, leaseAuthorizationExpiresAt: requestedAt + 600000 };
    },
    login: async (_user, token) => { calls.push(`login:${token}`); },
    cursor: async () => { calls.push('cursor'); return { cursor: '42' }; },
    open: async () => { calls.push('sse'); return { closed: false }; },
    presence: async () => { calls.push('presence'); },
  };
  const recovery = { actorIndex: 799, roomIndex: 66, record: row => records.push(row),
    sleep: async ms => { delays.push(ms); clock += ms; }, stopping: () => stopped, now: () => clock };
  return { user, calls, records, delays, operations, recovery, stop: () => { stopped = true; },
    run: () => prepareLoadActor(user, operations, recovery) };
}

test('ramp preparation performs the normal sequence once with request-start lease anchoring', async () => {
  const { user, calls, records, run } = preparationFixture();
  await run();
  assert.deepEqual(calls, ['bootstrap', 'validate:1000', 'login:custom-1', 'cursor', 'sse', 'presence']);
  assert.equal(user.cursor, '42'); assert.equal(user.ready, true);
  assert.equal(user.leaseAuthorizationExpiresAt, 601000);
  assert.deepEqual(records, []);
  await assert.rejects(run(), /preparation_already_started/);
  assert.equal(calls.length, 6);
});

test('ramp bootstrap transport failures are bounded and each failed attempt retains safe context', async () => {
  const { operations, records, delays, run, calls } = preparationFixture();
  let attempts = 0;
  operations.bootstrap = async () => { attempts++; throw dnsFailure(); };
  let caught;
  try { await run(); } catch (error) { caught = error; }
  assert.equal(attempts, 3); assert.deepEqual(delays, [250, 500]); assert.deepEqual(calls, []);
  assert.deepEqual(records.map(row => [row.actorIndex, row.roomIndex, row.substep, row.attempt, row.causeCode]),
    [[799, 66, 'bootstrap', 1, 'ENOTFOUND'], [799, 66, 'bootstrap', 2, 'ENOTFOUND'], [799, 66, 'bootstrap', 3, 'ENOTFOUND']]);
  assert.equal(loadFailureSummary(caught).preparation.attempt, 3);
  assert.deepEqual(loadFailureSummary(caught).detail, { name: 'TypeError', code: 'network_failed', causeCode: 'ENOTFOUND' });
});

test('ramp Firebase auth lost response obtains a fresh bootstrap token before retry', async () => {
  const { operations, calls, records, run, user } = preparationFixture();
  let attempts = 0;
  operations.login = async (actor, token) => {
    calls.push(`login:${token}`); actor.firebaseToken = `cleanup-token-${++attempts}`;
    if (attempts === 1) throw new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET', message: 'secret' } });
  };
  await run();
  assert.deepEqual(calls, ['bootstrap', 'validate:1000', 'login:custom-1', 'bootstrap', 'validate:1260', 'login:custom-2', 'cursor', 'sse', 'presence']);
  assert.equal(user.firebaseToken, 'cleanup-token-2'); assert.equal(user.ready, true);
  assert.equal(records[0].substep, 'firebase_auth'); assert.equal(records[0].attempt, 1);
  assert.equal(records[0].causeCode, 'UND_ERR_SOCKET');
  assert.equal(JSON.stringify(records).includes('secret'), false);
});

test('bootstrap and Firebase auth share one three-attempt credential budget', async () => {
  const { operations, records, run, delays } = preparationFixture();
  let bootstraps = 0, logins = 0;
  operations.bootstrap = async () => {
    if (++bootstraps === 1) throw dnsFailure();
    return { customToken: `token-${bootstraps}` };
  };
  operations.login = async () => { logins++; throw dnsFailure(); };
  await assert.rejects(run(), /preparation_firebase_auth_network_failed/);
  assert.equal(bootstraps, 3); assert.equal(logins, 2);
  assert.deepEqual(delays, [250, 500]);
  assert.deepEqual(records.map(row => row.substep), ['bootstrap', 'firebase_auth', 'firebase_auth']);
});

test('cursor and initial presence retry independently without replaying an opened actor', async () => {
  const { operations, calls, records, run, delays, user } = preparationFixture();
  let cursors = 0, writes = 0;
  operations.cursor = async () => { if (++cursors < 3) throw dnsFailure(); return { cursor: '99' }; };
  operations.presence = async () => { if (++writes < 3) throw new DOMException('private timeout', 'TimeoutError'); };
  await run();
  assert.equal(cursors, 3); assert.equal(writes, 3); assert.equal(user.cursor, '99');
  assert.equal(calls.filter(value => value === 'bootstrap').length, 1);
  assert.equal(calls.filter(value => value === 'sse').length, 1);
  assert.deepEqual(delays, [250, 500, 250, 500]);
  assert.deepEqual(records.map(row => row.substep), ['cursor', 'cursor', 'presence', 'presence']);
  assert.equal(loadQualityVerdicts({ preparationFailures: records.length, remoteLatencyByKind: {} }).preparationIntegrityVerdict, 'FAIL');
});

test('ramp never retries HTTP responses, identity failures or malformed results at any step', async () => {
  for (const step of ['bootstrap', 'login', 'cursor', 'presence']) {
    for (const error of [new Error('http_429:provider_private'), new Error('http_503'), new Error('http_401'),
      new Error('firebase_identity_mismatch'), new SyntaxError('private body')]) {
      const { operations, records, delays, run } = preparationFixture();
      let attempts = 0;
      operations[step] = async () => { attempts++; throw error; };
      await assert.rejects(run());
      assert.equal(attempts, 1, step); assert.equal(records.length, 1, step); assert.deepEqual(delays, []);
      assert.doesNotMatch(JSON.stringify(records), /provider_private|private body/);
    }
  }
});

test('SSE preparation failure remains fatal without repeating credentials or stream creation', async () => {
  const { operations, calls, records, delays, run, user } = preparationFixture();
  let attempts = 0;
  operations.open = async () => { attempts++; throw dnsFailure(); };
  await assert.rejects(run(), /preparation_sse_network_failed/);
  assert.equal(attempts, 1); assert.equal(user.ready, undefined);
  assert.equal(records[0].substep, 'sse'); assert.deepEqual(delays, []);
  assert.equal(calls.filter(value => value === 'bootstrap').length, 1);
});

test('presence exhaustion preserves its stream for normal cleanup and never replays actor setup', async () => {
  const { operations, calls, records, run, user } = preparationFixture();
  let writes = 0;
  operations.presence = async () => { writes++; throw dnsFailure(); };
  await assert.rejects(run(), /preparation_presence_network_failed/);
  assert.equal(writes, 3); assert.equal(user.ready, undefined); assert.equal(user.stream.closed, false);
  assert.equal(calls.filter(value => value === 'bootstrap').length, 1);
  assert.equal(calls.filter(value => value === 'sse').length, 1);
  assert.deepEqual(records.map(row => row.attempt), [1, 2, 3]);
  await assert.rejects(run(), /preparation_already_started/);
});

test('stop during preparation backoff retains actor context without another network attempt', async () => {
  const { operations, recovery, run, stop } = preparationFixture(); let attempts = 0;
  operations.bootstrap = async () => { attempts++; throw dnsFailure(); };
  recovery.sleep = async () => { stop(); throw new DOMException('private stop', 'AbortError'); };
  let caught; try { await run(); } catch (error) { caught = error; }
  assert.equal(attempts, 1);
  const report = loadFailureSummary(caught);
  assert.equal(report.preparation.actorIndex, 799); assert.equal(report.preparation.substep, 'bootstrap');
  assert.equal(report.detail.name, 'AbortError'); assert.equal(JSON.stringify(report).includes('private stop'), false);
});

test('a stream closed during presence cannot mark a preparing actor ready', async () => {
  const { operations, user, run, records } = preparationFixture();
  operations.presence = async () => { user.stream.closed = true; };
  await assert.rejects(run(), /sse_ended/);
  assert.equal(user.ready, undefined); assert.equal(records.length, 1);
});

test('top-level summary keeps allowlisted failure detail and no raw transport context', () => {
  const result = loadFailureSummary(new TypeError('fetch failed', { cause: { code: 'ECONNRESET', url: 'secret-url' } }));
  assert.deepEqual(result, { code: 'request_failed', detail: { name: 'TypeError', code: 'network_failed', causeCode: 'ECONNRESET' } });
  assert.equal(JSON.stringify(result).includes('secret-url'), false);
});
