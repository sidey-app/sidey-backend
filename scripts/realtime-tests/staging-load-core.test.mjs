import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOptions, LoadBudget, LoadTraffic, parallelMap, quantiles, EventStreamParser, firebaseRedirect, providerErrorCode, deleteOwnedFirebaseUser, workloadKind, TypingActivityPolicy, typingActivityTrace, simulateTypingActivity } from './staging-load-core.mjs';

test('read-only observation is explicit and cannot select a different project', () => {
  assert.equal(loadOptions(['--run-explicit-staging', '--observe', 'true']).observe, true);
  assert.throws(() => loadOptions(['--run-explicit-staging', '--observe', 'false']), /invalid_observe/);
  assert.throws(() => loadOptions(['--run-explicit-staging', '--observe', 'production']), /invalid_observe/);
});

test('remote run is explicit, bounded, and rejects unknown or duplicate options', () => {
  assert.equal(loadOptions(['--run-explicit-staging', '--users', '500']).users, 500);
  for (const args of [[], ['--users', '500'], ['--run-explicit-staging', '--users', '501'],
    ['--run-explicit-staging', '--users', '1'], ['--run-explicit-staging', '--users', 'NaN'],
    ['--run-explicit-staging', '--hold-seconds', '181'], ['--run-explicit-staging', '--project', 'production'],
    ['--run-explicit-staging', '--users', '10', '--users', '20']]) assert.throws(() => loadOptions(args));
});
test('large runs require the approved Edge direct activity combination and remain at most ten minutes', () => {
  const required = ['--publisher', 'edge', '--direct-events', 'true', '--typing-workload', 'activity'];
  for (const users of ['501', '2400']) {
    for (const seconds of ['20', '600']) {
      const value = loadOptions(['--run-explicit-staging', '--users', users, '--hold-seconds', seconds, ...required]);
      assert.equal(value.users, Number(users)); assert.equal(value.holdSeconds, Number(seconds));
      assert.equal(value.largeScale, true);
    }
    for (let omitted = 0; omitted < required.length; omitted += 2) {
      const subset = required.filter((_, index) => index !== omitted && index !== omitted + 1);
      assert.throws(() => loadOptions(['--run-explicit-staging', '--users', users, ...subset]), /large_load_requires_edge_direct_activity/);
    }
  }
  for (const seconds of ['601', '900']) {
    assert.throws(() => loadOptions(['--run-explicit-staging', '--users', '2400', '--hold-seconds', seconds, ...required]), /large_load_duration_limit/);
  }
  for (const users of ['2401', '9007199254740992']) {
    assert.throws(() => loadOptions(['--run-explicit-staging', '--users', users, ...required]), /unsafe_load_size/);
  }
  assert.throws(() => loadOptions(['--run-explicit-staging', '--users', '2400', ...required,
    '--worker-host', 'worker@example.com', '--worker-directory', '/opt/worker']), /conflicting_publishers/);
});

test('large profile exposes finite independent preparation, ramp, concurrency and resource budgets', () => {
  const value = loadOptions(['--run-explicit-staging', '--users', '2400', '--hold-seconds', '600',
    '--publisher', 'edge', '--direct-events', 'true', '--typing-workload', 'activity']);
  assert.deepEqual(value, { users: 2400, holdSeconds: 600, typingWorkload: 'activity', edgePublisher: true, directEvents: true,
    largeScale: true, actionLimit: 120000, byteLimit: 2147483648, tokenStartIntervalMs: 250,
    provisionConcurrency: 8, rampConcurrency: 32, producerConcurrency: 64, renewalConcurrency: 32,
    presenceConcurrency: 48, finalReconcileConcurrency: 32, timelineLimit: 12000,
    preparationTimeoutMs: 2700000, rampTimeoutMs: 900000, totalTimeoutMs: 5400000 });
  const short = loadOptions(['--run-explicit-staging', '--users', '501', '--hold-seconds', '20',
    '--publisher', 'edge', '--direct-events', 'true', '--typing-workload', 'activity']);
  assert.equal(short.actionLimit, 120000, 'the short-pilot default must not silently replace the large profile');
  assert.throws(() => loadOptions(['--run-explicit-staging', '--users', '2400', '--action-limit', '999999']), /invalid_option/);
});

test('500-user and smaller runs keep the original options and short-run budgets', () => {
  assert.deepEqual(loadOptions(['--run-explicit-staging']), { users: 10, holdSeconds: 120,
    byteLimit: 512 * 1024 * 1024, actionLimit: 5000, typingWorkload: 'historical' });
  const value = loadOptions(['--run-explicit-staging', '--users', '500', '--hold-seconds', '900', '--publisher', 'edge']);
  assert.deepEqual(value, { users: 500, holdSeconds: 900, byteLimit: 512 * 1024 * 1024,
    actionLimit: 30000, typingWorkload: 'historical', edgePublisher: true });
  const direct = loadOptions(['--run-explicit-staging', '--users', '500', '--hold-seconds', '600',
    '--publisher', 'edge', '--direct-events', 'true', '--typing-workload', 'activity']);
  assert.equal(direct.largeScale, undefined); assert.equal(direct.tokenStartIntervalMs, undefined);
  assert.equal(direct.actionLimit, 30000); assert.equal(direct.byteLimit, 512 * 1024 * 1024);
});
test('fifteen-minute runs require a paired external worker and retain bounded work', () => {
  const args = ['--run-explicit-staging', '--users', '500', '--hold-seconds', '900', '--worker-host', 'worker@host.example', '--worker-directory', '/opt/sidey'];
  const value = loadOptions(args);
  assert.equal(value.holdSeconds, 900); assert.equal(value.actionLimit, 30000);
  for (const invalid of [args.map(v => v === '900' ? '901' : v), args.slice(0, 7),
    args.map(v => v === 'worker@host.example' ? '-oProxyCommand=bad' : v),
    args.map(v => v === '/opt/sidey' ? '/opt/../secret' : v),
    args.map(v => v === '/opt/sidey' ? '/opt/$(bad)' : v)]) assert.throws(() => loadOptions(invalid));
});
test('audited event mix has the exact source proportions over its deterministic cycle', () => {
  const counts = {};
  for (let i = 0; i < 801024; i++) { const kind = workloadKind(i); counts[kind] = (counts[kind] || 0) + 1; }
  assert.deepEqual(counts, { character_throw: 309545, typing_start: 219371, typing_stop: 129998, message: 106733, character_pulse: 35377 });
  assert.equal(new Set(Array.from({ length: 15 }, (_, sequence) => workloadKind(sequence))).size, 5);
});
test('Edge cloud publishing permits 15 minutes without an SSH host and cannot mix publishers', () => {
  const options = loadOptions(['--run-explicit-staging', '--users', '500', '--hold-seconds', '900', '--publisher', 'edge']);
  assert.equal(options.edgePublisher, true);
  assert.equal(options.holdSeconds, 900);
  assert.throws(() => loadOptions(['--run-explicit-staging', '--publisher', 'production']), /invalid_publisher/);
  assert.throws(() => loadOptions(['--run-explicit-staging', '--publisher', 'edge', '--worker-host', 'worker@example.com', '--worker-directory', '/opt/worker']), /conflicting_publishers/);
});
test('byte and action limits abort instead of allowing unbounded work', () => {
  const aborted = [], budget = new LoadBudget({ byteLimit: 5, actionLimit: 1, abort: reason => aborted.push(reason) });
  budget.download(5); assert.throws(() => budget.download(1)); budget.action(); assert.throws(() => budget.action());
  assert.deepEqual(aborted, ['download_budget', 'action_budget']);
});
test('final worker counters are retained after shutdown without double counting or rearming the budget', () => {
  const reasons = [], budget = new LoadBudget({ byteLimit: 100, actionLimit: 1, abort: reason => reasons.push(reason) });
  const traffic = new LoadTraffic(budget);
  traffic.addGenerator(40); traffic.updateWorker(50); traffic.updateWorker(50);
  assert.equal(traffic.total, 90); assert.equal(budget.bytes, 90);
  traffic.updateWorker(80, false);
  assert.equal(traffic.total, 120); assert.equal(traffic.worker, 80); assert.equal(budget.bytes, 90);
  assert.deepEqual(reasons, []);
  assert.throws(() => traffic.updateWorker(79, false), /invalid_worker/);
});
test('parallel failure drains in-flight mutations before returning', async () => {
  const completed = [];
  await assert.rejects(parallelMap([0, 1, 2], 2, async value => {
    if (value === 0) throw new Error('failed');
    await new Promise(resolve => setTimeout(resolve, 15)); completed.push(value);
  }));
  assert.deepEqual(completed, [1]);
});
test('SSE parser handles fragmented UTF8, CRLF, terminal events and multiple frames', () => {
  const values = [], parser = new EventStreamParser(value => values.push(value));
  const bytes = new TextEncoder().encode('event: put\r\ndata: {"value":"안녕"}\r\n\r\nevent: cancel\ndata: permission_denied\n\n');
  for (const byte of bytes) parser.push(new Uint8Array([byte]));
  assert.deepEqual(values, [{ name: 'put', data: { value: '안녕' } }, { name: 'cancel', data: null }]);
});
test('redirects may not expose ID token to non Firebase destinations', () => {
  const base = 'https://test.firebasedatabase.app/a.json?auth=secret';
  assert.equal(firebaseRedirect('https://s-1.firebaseio.com/a.json?auth=secret', base).hostname, 's-1.firebaseio.com');
  for (const destination of ['https://firebasedatabase.app.evil.test/', 'http://s-1.firebaseio.com/', 'https://evil.test/', 'https://u@s-1.firebaseio.com/', null]) {
    assert.throws(() => firebaseRedirect(destination, base));
  }
});
test('latency summaries make empty observations explicit', () => {
  assert.equal(quantiles([]).p95, null);
  assert.equal(quantiles(Array.from({ length: 100 }, (_, index) => index + 1)).p95, 95);
});

test('cleanup obtains fresh authentication despite an existing usable ID token', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const user = { id, firebaseAttempted: true, firebaseToken: 'old-id-token' }, steps = [];
  await deleteOwnedFirebaseUser(user, {
    ownedIds: new Set([id]),
    reauthenticate: async value => { assert.equal(value.id, id); steps.push('reauthenticated'); return 'fresh-id-token'; },
    deleteWithToken: async token => { assert.equal(token, 'fresh-id-token'); steps.push('deleted'); },
  });
  assert.deepEqual(steps, ['reauthenticated', 'deleted']);
});

test('cleanup never falls back to stale authentication or touches an unowned UID', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const user = { id, firebaseAttempted: true, firebaseToken: 'old-id-token' };
  let logins = 0, deletions = 0;
  const operations = {
    ownedIds: new Set([id]),
    reauthenticate: async () => { logins++; throw new Error('reauth_failed'); },
    deleteWithToken: async () => { deletions++; },
  };
  await assert.rejects(deleteOwnedFirebaseUser(user, operations), /reauth_failed/);
  assert.equal(logins, 1); assert.equal(deletions, 0);
  await assert.rejects(deleteOwnedFirebaseUser(user, { ...operations, ownedIds: new Set() }), /ownership_required/);
  await assert.rejects(deleteOwnedFirebaseUser({ ...user, firebaseAttempted: false }, operations), /ownership_required/);
  assert.equal(logins, 1); assert.equal(deletions, 0);
});

test('provider errors expose only allowlisted constants, never free-form secret material', () => {
  assert.equal(providerErrorCode('{"error":{"message":"CREDENTIAL_TOO_OLD_LOGIN_AGAIN"}}'), 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN');
  assert.equal(providerErrorCode('{"error":{"message":"TOKEN_EXPIRED : Bearer secret-token user@example.invalid"}}'), 'TOKEN_EXPIRED');
  assert.equal(providerErrorCode('{"error":{"status":"RESOURCE_EXHAUSTED","message":"private request data"}}'), 'RESOURCE_EXHAUSTED');
  for (const body of ['Bearer secret-token', '{"error":{"message":"private request data"}}',
    '{"error":{"message":"TOKEN_EXPIRED secret-token"}}', '{"error":{"message":{"token":"secret"}}}', 'null']) {
    assert.equal(providerErrorCode(body), null);
  }
});

test('activity typing is explicit and historical remains the default', () => {
  assert.equal(loadOptions(['--run-explicit-staging']).typingWorkload, 'historical');
  assert.equal(loadOptions(['--run-explicit-staging', '--typing-workload', 'activity']).typingWorkload, 'activity');
  assert.throws(() => loadOptions(['--run-explicit-staging', '--typing-workload', 'unknown']));
  assert.throws(() => loadOptions(['--run-explicit-staging', '--typing-workload', 'activity', '--typing-workload', 'activity']));
});

test('short input and an exact-deadline explicit stop cancel without any RPC', () => {
  for (const at of [200, 500]) {
    const policy = new TypingActivityPolicy(); policy.edit(0);
    assert.equal(policy.poll(100), null); policy.stop();
    assert.equal(policy.poll(at), null); assert.equal(policy.poll(5000), null);
    assert.equal(policy.cancelledPending, 1);
  }
});

test('first start deadline is fixed, not extended by further edits', () => {
  const policy = new TypingActivityPolicy(); policy.edit(0); policy.edit(400);
  assert.equal(policy.poll(499), null);
  const start = policy.poll(500); assert.equal(start.reason, 'initial');
  assert.equal(policy.poll(501), null, 'only one in-flight publication');
  policy.acknowledge(start, 700);
  assert.throws(() => policy.acknowledge(start, 701), /invalid_typing_acknowledgement/);
});

test('keepalive consumes only the edit snapshot of the successful publication and idle wins ties', () => {
  const policy = new TypingActivityPolicy(); policy.edit(0);
  policy.acknowledge(policy.poll(500), 600);
  policy.edit(550); // Input during the successful RPC must remain pending.
  const duringRequest = policy.poll(2600); assert.equal(duringRequest.reason, 'keepalive');
  policy.acknowledge(duringRequest, 2600);
  policy.edit(3000);
  const refresh = policy.poll(4600); assert.equal(refresh.reason, 'keepalive');
  policy.acknowledge(refresh, 4700);
  assert.equal(policy.poll(6700), null);
  const stop = policy.poll(8000); assert.equal(stop.reason, 'stop');
  policy.acknowledge(stop, 8000); assert.equal(policy.poll(10000), null);
  policy.edit(11000); assert.equal(policy.poll(11499), null);
  assert.equal(policy.poll(11500).reason, 'initial');
});

test('explicit stop sends immediately for active state and delayed starts cannot revive idle input', () => {
  const policy = new TypingActivityPolicy(); policy.edit(0);
  policy.acknowledge(policy.poll(500), 500); policy.stop();
  const stopped = policy.poll(501); assert.equal(stopped.reason, 'stop');
  policy.acknowledge(stopped, 501); assert.equal(policy.poll(2500), null);
  policy.edit(10000); assert.equal(policy.poll(15000), null);
});

test('20-second input trace covers short input, continuous edits, idle stop, and resume', () => {
  const trace = typingActivityTrace(20000);
  const previous = simulateTypingActivity(trace, 20000, true);
  const optimized = simulateTypingActivity(trace, 20000);
  assert.deepEqual(previous, { initial: 3, keepalive: 4, stop: 3, total: 10, cancelledPending: 0 });
  assert.deepEqual(optimized, { initial: 2, keepalive: 2, stop: 2, total: 6, cancelledPending: 1 });
  assert.equal(typingActivityTrace(30000, 9).filter(item => item.scenario === 'resume' && item.kind === 'edit').length, 4);
  assert.equal(typingActivityTrace(30000, 9).at(-1).scenario, 'run_end');
  assert.throws(() => typingActivityTrace(900001));
});

test('new input during stop RPC survives acknowledgement and is not sent before its fixed delay', () => {
  const policy = new TypingActivityPolicy(); policy.edit(0);
  policy.acknowledge(policy.poll(500), 600); policy.stop();
  const stop = policy.poll(700); policy.edit(800); policy.acknowledge(stop, 900);
  assert.equal(policy.poll(1299), null); assert.equal(policy.poll(1300).reason, 'initial');
});

test('explicit stop during start RPC followed by input preserves stop then restart', () => {
  const policy = new TypingActivityPolicy(); policy.edit(0);
  const start = policy.poll(500); policy.stop(); policy.edit(600);
  policy.acknowledge(start, 700);
  const stop = policy.poll(701); assert.equal(stop.reason, 'stop');
  policy.acknowledge(stop, 800);
  assert.equal(policy.poll(1099), null); assert.equal(policy.poll(1100).reason, 'initial');
});

test('a second stop during stop RPC cancels the pending restart', () => {
  const policy = new TypingActivityPolicy(); policy.edit(0);
  policy.acknowledge(policy.poll(500), 600); policy.stop();
  const stop = policy.poll(700); policy.edit(800); policy.stop(); policy.acknowledge(stop, 900);
  assert.equal(policy.poll(1400), null);
});

test('direct events are explicit and restricted to the bounded Edge publisher run', () => {
  const args = ['--run-explicit-staging', '--publisher', 'edge', '--direct-events', 'true'];
  assert.equal(loadOptions(args).directEvents, true);
  for (const invalid of [
    ['--run-explicit-staging', '--direct-events', 'true'], [...args, '--direct-events', 'true'],
    args.map(value => value === 'true' ? 'false' : value),
  ]) assert.throws(() => loadOptions(invalid));
});

test('direct event bodies obey the locked gateway contract and preserve decimal typing order', async () => {
  const { directEventBody, requireDirectCapability } = await import('./staging-load-core.mjs');
  const { directEventInput } = await import('../../supabase/functions/_shared/realtime-direct-event.mjs');
  const input = { roomId: '11111111-1111-4111-8111-111111111111', eventId: '22222222-2222-4222-8222-222222222222',
    epoch: 1, targetUserId: '33333333-3333-4333-8333-333333333333', sequence: 9007199254740993n };
  for (const kind of ['typing_start', 'typing_stop', 'character_pulse', 'character_throw']) {
    const body = directEventBody({ ...input, kind });
    assert.equal(directEventInput(body).p_kind, kind);
    assert.equal(Object.hasOwn(body, 'sequence'), kind.startsWith('typing_'));
    if (kind.startsWith('typing_')) assert.equal(body.sequence, '9007199254740993');
  }
  requireDirectCapability({ directEvents: { endpoint: 'realtime-event', protocolVersion: 1 } });
  for (const value of [{}, { directEvents: { endpoint: 'other', protocolVersion: 1 } },
    { directEvents: { endpoint: 'realtime-event', protocolVersion: 2 } }]) {
    assert.throws(() => requireDirectCapability(value), /direct_capability_missing/);
  }
});

test('gateway timings keep network/queue residual distinct from measured handler stages', async () => {
  const { directEventTimings } = await import('./staging-load-core.mjs');
  const timing = { dbValidationMs: 50, googleAuthMs: 0, rtdbWriteMs: 80, handlerMs: 140 };
  const result = directEventTimings(timing, 240);
  assert.equal(result.roundTripResidualMs, 100); assert.equal(result.googleAuthMs, 0);
  assert.equal(Object.hasOwn(result, 'queueMs'), false);
  assert.equal(directEventTimings(timing, 139.5).roundTripResidualMs, -0.5);
  assert.throws(() => directEventTimings({ ...timing, handlerMs: undefined }, 240), /timing_missing/);
});

test('new latency gate requires both messages and throws, p95 500ms and p99 1000ms', async () => {
  const { deliveryLatencyGate } = await import('./staging-load-core.mjs');
  const passed = deliveryLatencyGate({ message: [500], character_throw: [499] });
  assert.equal(passed.message.passed, true); assert.equal(passed.character_throw.passed, true);
  assert.equal(deliveryLatencyGate({ message: [1] }).character_throw.passed, false);
  assert.equal(deliveryLatencyGate({ message: [501], character_throw: [1] }).message.passed, false);
  const tail = [...Array(98).fill(100), 1001, 1001];
  const failed = deliveryLatencyGate({ message: tail, character_throw: [100] });
  assert.equal(failed.message.p95, 100); assert.equal(failed.message.p99, 1001);
  assert.equal(failed.message.passed, false);
});

test('publisher wake is explicitly enabled only by the exact bootstrap capability', async () => {
  const { requirePublisherWakeCapability } = await import('./staging-load-core.mjs');
  for (const endpoint of ['realtime-wake', 'realtime-event/wake']) {
    assert.equal(requirePublisherWakeCapability({ publisherWake: { endpoint, protocolVersion: 1 } }), endpoint);
  }
  assert.equal(requirePublisherWakeCapability({ publisherWake: { endpoint: 'realtime-event/wake', protocolVersion: 1 } }, 'realtime-event/wake'), 'realtime-event/wake');
  assert.throws(() => requirePublisherWakeCapability({ publisherWake: { endpoint: 'realtime-wake', protocolVersion: 1 } }, 'realtime-event/wake'), /capability_missing/);
  for (const endpoint of ['realtime-event/wake/', '/realtime-event/wake', 'realtime-event%2fwake', 'realtime-event//wake', 'realtime-event/wake?x=1', 'https://example.com']) {
    assert.throws(() => requirePublisherWakeCapability({ publisherWake: { endpoint, protocolVersion: 1 } }), /capability_missing/);
  }
  for (const value of [{}, { publisherWake: { endpoint: 'elsewhere', protocolVersion: 1 } },
    { publisherWake: { endpoint: 'realtime-wake', protocolVersion: 2 } }]) {
    assert.throws(() => requirePublisherWakeCapability(value), /capability_missing/);
  }
});

test('practical acceptance preserves stricter aspiration evidence and rejects out-of-bound tails', async () => {
  const { practicalDeliveryLatencyGate, deliveryLatencyGate } = await import('./staging-load-core.mjs');
  const observed = { message: [800], character_throw: [600] };
  assert.equal(practicalDeliveryLatencyGate(observed).message.passed, true);
  assert.equal(deliveryLatencyGate(observed).message.passed, false);
  assert.equal(practicalDeliveryLatencyGate({ ...observed, message: [1501] }).message.passed, false);
  assert.equal(practicalDeliveryLatencyGate({}).message.passed, false);
});

test('regional diagnostic is explicitly limited to the two approved Edge regions', () => {
  for (const region of ['ap-northeast-2', 'ap-southeast-1']) {
    assert.equal(loadOptions(['--run-explicit-staging','--publisher','edge','--edge-region',region]).edgeRegion, region);
  }
  assert.throws(() => loadOptions(['--run-explicit-staging','--edge-region','ap-southeast-1']), /requires_edge/);
  assert.throws(() => loadOptions(['--run-explicit-staging','--publisher','edge','--edge-region','us-east-1']), /invalid_edge_region/);
});
