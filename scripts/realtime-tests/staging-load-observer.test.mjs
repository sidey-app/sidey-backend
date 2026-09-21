import test from 'node:test';
import assert from 'node:assert/strict';
import { createStagingLoadObserver, parseObserverMetrics, observerStatementDelta,
  OBSERVER_RPCS, OBSERVER_ACTIVITY_SQL, OBSERVER_STATEMENTS_SQL, OBSERVER_PROJECT } from './staging-load-observer.mjs';

const secret = 'sensitive-token-IP-user-label';
const metrics = `# HELP unrelated anything
pgrst_db_pool_max{instance="${secret}"} 20
pgrst_db_pool_waiting{instance="${secret}"} 2
pgrst_db_pool_available 3
pgrst_db_pool_timeouts_total 0
pgrst_jwt_cache_hits_total{instance="${secret}"} 5
node_cpu_seconds_total{cpu="0",mode="idle",instance="${secret}"} 100
node_cpu_seconds_total{cpu="1",mode="idle"} 200
node_cpu_seconds_total{cpu="0",mode="user"} 10
node_memory_MemTotal_bytes 1e9
node_boot_time_seconds 100
process_start_time_seconds 200
unknown_secret_metric{email="${secret}"} 5
`;
function statements(calls = 10) {
  return [{ sampled_at_ms: calls * 1000, stats_reset_ms: 1000, dealloc: 0, postmaster_start_ms: 100,
    rpcs: OBSERVER_RPCS.map(rpc => ({ rpc, calls, total_exec_ms: calls * 3, rows: calls,
      shared_blks_hit: calls, shared_blks_read: calls, temp_blks_read: 0, temp_blks_written: 0,
      shared_blk_read_ms: 0, shared_blk_write_ms: 0 })) }];
}
const activity = () => [{ connections: 5, active: 1, idle: 4, idle_in_transaction: 0,
  lock_waiting: 0, io_waiting: 0, client_waiting: 4, waiting: 4, longest_active_ms: 9 }];
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  const calls = [], timers = new Set(); let statementReads = 0;
  const options = { token: async () => secret, now: () => 10000,
    fetcher: async (url, init) => {
      calls.push({ url, method: init.method });
      assert.equal(init.headers.authorization, `Bearer ${secret}`);
      assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
      return new Response(metrics);
    },
    query: async (sql, { signal }) => {
      assert.ok(signal instanceof AbortSignal);
      if (sql === OBSERVER_STATEMENTS_SQL) { calls.push('statements'); return statements(++statementReads === 1 ? 10 : 15); }
      assert.equal(sql, OBSERVER_ACTIVITY_SQL); calls.push('activity'); return activity();
    },
    setTimer: (callback, ms) => { const timer = { callback, ms }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer), ...overrides };
  const observer = createStagingLoadObserver(options);
  return { observer, calls, timers, fire: () => {
    assert.equal(timers.size, 1); const timer = [...timers][0]; timers.delete(timer); timer.callback();
  } };
}

test('Prometheus exports only allowlisted numeric aggregates and fixed CPU modes', () => {
  const result = parseObserverMetrics(metrics);
  assert.deepEqual(result.cpuSeconds.idle, { sum: 300, min: 100, max: 200, series: 2 });
  assert.equal(result.values.pgrst_db_pool_max.sum, 20);
  assert.ok(result.missing.includes('pgrst_jwt_cache_requests_total'));
  assert.equal(result.cpuMissing, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes('unknown_secret_metric'), false);
});

test('absent or malformed allowed metrics are explicit failures, not fabricated zeros', () => {
  for (const raw of ['# only comments', 'unknown_metric 1', 'pgrst_db_pool_max NaN',
    'pgrst_db_pool_max +Inf', 'pgrst_db_pool_max -1', 'pgrst_db_pool_max invalid', 'a'.repeat(2 * 1024 * 1024 + 1)]) {
    assert.throws(() => parseObserverMetrics(raw));
  }
});

test('start and stop capture sequential baseline/final SQL and snapshots with a valid delta', async () => {
  const { observer, timers, calls } = fixture();
  assert.equal(calls.length, 0);
  await observer.start();
  assert.equal(timers.size, 1); assert.equal([...timers][0].ms, 60000);
  const result = await observer.stop();
  assert.equal(timers.size, 0);
  assert.equal(result.project, OBSERVER_PROJECT);
  assert.equal(result.intervalMs, 60000);
  assert.equal(result.providerRefreshApproxMs, 60000);
  assert.match(result.providerFreshness, /identical scrapes cannot prove zero load/);
  assert.match(result.providerFreshness, /not provider measurement timestamps/);
  assert.equal(result.providerRefreshSource, 'https://supabase.com/blog/metrics-api-observability');
  assert.deepEqual(result.samples.map(sample => sample.phase), ['baseline', 'final']);
  assert.equal(result.sqlDelta.status, 'OBSERVED');
  assert.equal(result.sqlDelta.rpcs[0].calls, 5);
  assert.equal(result.sqlDelta.rpcs[0].total_exec_ms, 15);
  assert.equal(result.sqlBefore.requestedAtMs, 10000); assert.equal(result.sqlAfter.completedAtMs, 10000);
  assert.equal(result.counterContinuity.counterDecrease, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(calls.filter(value => typeof value === 'object').every(value =>
    value.url === `https://api.supabase.com/v1/projects/${OBSERVER_PROJECT}/analytics/endpoints/metrics` && value.method === 'GET'), true);
  assert.deepEqual(await observer.stop(), result);
});

test('default SQL transport uses only fixed management endpoint and generated read-only statements', async () => {
  let sqlReads = 0;
  const { observer } = fixture({ query: undefined, fetcher: async (url, init) => {
    if (init.method === 'GET') return new Response(metrics);
    assert.equal(url, `https://api.supabase.com/v1/projects/${OBSERVER_PROJECT}/database/query`);
    const { query } = JSON.parse(init.body);
    assert.ok([OBSERVER_ACTIVITY_SQL, OBSERVER_STATEMENTS_SQL].includes(query));
    return Response.json(query === OBSERVER_ACTIVITY_SQL ? activity() : statements(++sqlReads * 10));
  } });
  await observer.start(); const result = await observer.stop();
  assert.equal(result.sqlDelta.status, 'OBSERVED'); assert.equal(sqlReads, 2);
});

test('a pending periodic request never overlaps another read and stop waits for completion', async () => {
  let pendingResolve, reads = 0, running = 0, peak = 0;
  const gate = new Promise(resolve => { pendingResolve = resolve; });
  const { observer, fire, timers } = fixture({ fetcher: async () => {
    running++; peak = Math.max(peak, running);
    if (++reads === 2) await gate;
    running--; return new Response(metrics);
  } });
  await observer.start(); fire(); await turn();
  assert.equal(reads, 2); assert.equal(timers.size, 0);
  let stopped = false; const stopping = observer.stop().then(value => { stopped = true; return value; });
  await turn(); assert.equal(stopped, false); assert.equal(reads, 2);
  pendingResolve(); const report = await stopping;
  assert.equal(peak, 1); assert.equal(reads, 3);
  assert.deepEqual(report.samples.map(sample => sample.phase), ['baseline', 'periodic', 'final']);
  assert.equal(timers.size, 0);
});

test('sample limit reserves final evidence and snapshot cannot mutate internal state', async () => {
  const { observer, fire, timers } = fixture({ maxSamples: 3 });
  await observer.start(); fire(); await turn();
  assert.equal(timers.size, 0);
  const snapshot = observer.snapshot(); snapshot.samples.length = 0;
  const result = await observer.stop();
  assert.equal(result.samples.length, 3); assert.equal(result.sampleLimitReached, true);
});

test('read errors and HTTP failures are sanitized without zero-filled metrics', async () => {
  const { observer } = fixture({ token: async () => { throw new Error(secret); },
    query: async () => { throw new Error(`raw SQL ${secret}`); } });
  await observer.start(); const result = await observer.stop();
  assert.equal(result.sqlDelta.status, 'UNAVAILABLE');
  assert.equal(result.samples[0].metrics.status, 'UNAVAILABLE');
  assert.equal(result.samples[0].metrics.code, 'read_failed');
  assert.equal('value' in result.samples[0].metrics, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  const other = fixture({ fetcher: async () => new Response(secret, { status: 403 }) }).observer;
  await other.start(); assert.equal((await other.stop()).samples[0].metrics.code, 'http_403');
});

test('each request receives the ten-second timeout and honors an expired signal', async () => {
  let signals = 0;
  const { observer } = fixture({ timeoutSignal: ms => {
    assert.equal(ms, 10000); signals++;
    return AbortSignal.abort(new Error(secret));
  } });
  await observer.start(); const result = await observer.stop();
  assert.equal(signals, 6);
  assert.equal(result.sqlBefore.code, 'request_timeout');
  assert.equal(result.samples[0].metrics.code, 'request_timeout');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('malformed or unallowlisted SQL fields cannot enter reports', async () => {
  for (const bad of [[{ ...statements()[0], rpcs: [{ rpc: secret }] }],
    [{ ...statements()[0], stats_reset_ms: null }], [{ ...statements()[0], dealloc: '0' }]]) {
    const { observer } = fixture({ query: async () => bad });
    await observer.start(); const result = await observer.stop();
    assert.equal(result.sqlBefore.status, 'UNAVAILABLE');
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('counter decreases, changed restart markers and CPU series topology are explicit', async () => {
  let calls = 0;
  const { observer } = fixture({ fetcher: async () => new Response(++calls === 1 ? metrics :
    'pgrst_db_pool_timeouts_total 0\nnode_cpu_seconds_total{cpu="0",mode="idle"} 1\nnode_boot_time_seconds 500\nprocess_start_time_seconds 600\n') });
  await observer.start(); const { counterContinuity: value } = await observer.stop();
  assert.equal(value.counterDecrease, true); assert.equal(value.topologyChanged, true);
  assert.equal(value.restartMarkerChanged, true);
  assert.match(value.limitations, /Zero cumulative pool timeouts does not prove zero historical pool waiting/);
  assert.match(value.limitations, /subminute or identical cached scrapes cannot prove zero load/);
});

test('SQL deltas reject stats reset, deallocation, restart and cumulative counter decreases', () => {
  const before = { status: 'OBSERVED', value: statements(10)[0] };
  for (const changes of [{ stats_reset_ms: 2000 }, { dealloc: 1 }, { postmaster_start_ms: 200 }]) {
    assert.equal(observerStatementDelta(before, { status: 'OBSERVED', value: { ...statements(15)[0], ...changes } }).status, 'UNAVAILABLE');
  }
  const after = statements(15)[0]; after.rpcs[0].calls = 9;
  assert.equal(observerStatementDelta(before, { status: 'OBSERVED', value: after }).reason, 'statement_counter_reset');
});

test('stopping before start and repeated start calls cannot create hidden observers', async () => {
  const { observer, calls } = fixture(); await observer.stop();
  await assert.rejects(observer.start(), /observer_stopped/); assert.equal(calls.length, 0);
  const second = fixture(); await Promise.all([second.observer.start(), second.observer.start()]);
  assert.equal(second.timers.size, 1); assert.equal(second.calls.filter(value => value === 'statements').length, 1);
  await second.observer.stop();
});

test('live notifications receive sanitized independent copies and callback errors stay separate', async () => {
  const notifications = [];
  const { observer } = fixture({ onSample: sample => {
    assert.equal(JSON.stringify(sample).includes(secret), false);
    notifications.push(sample.phase);
    sample.metrics.value.values.pgrst_db_pool_max.sum = 999;
    throw new Error(secret);
  } });
  await observer.start(); const result = await observer.stop();
  assert.deepEqual(notifications, ['baseline', 'final']);
  assert.equal(result.callbackErrors, 2);
  assert.equal(result.samples[0].metrics.value.values.pgrst_db_pool_max.sum, 20);
  assert.equal(result.sqlDelta.status, 'OBSERVED');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('async callbacks are explicitly unsupported and cannot leak unhandled rejections', async () => {
  const { observer } = fixture({ onSample: async () => { throw new Error(secret); } });
  await observer.start(); const result = await observer.stop(); await turn();
  assert.equal(result.callbackErrors, 2); assert.match(result.callbackPolicy, /unsupported async/);
});

test('large or unreadable HTTP bodies produce explicit sanitized errors', async () => {
  for (const makeResponse of [() => new Response('a'.repeat(2 * 1024 * 1024 + 1)),
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(secret)); } }))]) {
    const { observer } = fixture({ fetcher: async () => makeResponse() });
    await observer.start(); const report = await observer.stop();
    assert.equal(report.samples[0].metrics.status, 'UNAVAILABLE');
    assert.equal(JSON.stringify(report).includes(secret), false);
  }
});

test('sample and cadence bounds cannot be expanded past the approved observation budget', () => {
  for (const options of [{ maxSamples: 181 }, { maxSamples: 1 }, { intervalMs: 4999 }, { intervalMs: 60001 }]) {
    assert.throws(() => createStagingLoadObserver({ token: async () => secret, ...options }), /invalid_observer_options/);
  }
});

test('metrics 429 cools down periodic and final GETs while SQL observations continue', async () => {
  let clock = 10000, requests = 0;
  const { observer, fire, calls } = fixture({ now: () => clock, fetcher: async () => {
    requests++;
    return new Response(secret, { status: 429, headers: { 'retry-after': '5', 'x-unrelated-secret': secret } });
  } });
  await observer.start();
  let result = observer.snapshot();
  assert.equal(result.samples[0].metrics.status, 'UNAVAILABLE');
  assert.equal(result.samples[0].metrics.code, 'http_429');
  assert.equal(result.samples[0].metrics.category, 'observer_rate_limit');
  assert.equal(result.samples[0].metrics.retryAtMs, 70000);
  clock = 25000; fire(); await turn();
  result = await observer.stop();
  assert.equal(requests, 1);
  assert.deepEqual(result.samples.map(row => row.metrics.status), ['UNAVAILABLE', 'SKIPPED', 'SKIPPED']);
  assert.equal(result.samples[2].metrics.code, 'metrics_cooldown');
  assert.equal(result.metricsRateLimit.responses, 1);
  assert.equal(result.metricsRateLimit.skipped, 2);
  assert.equal(calls.filter(value => value === 'activity').length, 3);
  assert.equal(result.sqlDelta.status, 'OBSERVED');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('only allowlisted numeric duration headers select the bounded cooldown', async () => {
  const cases = [
    [{ 'retry-after': '90' }, 90000],
    [{ 'x-ratelimit-reset': '120' }, 120000],
    [{ 'retry-after': '70', 'x-ratelimit-reset': '140' }, 140000],
    [{ 'retry-after': '9999' }, 300000],
    [{ 'x-ratelimit-reset': '9999' }, 300000],
    [{ 'retry-after': '-4', 'x-ratelimit-reset': secret }, 60000],
    [{ 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }, 60000],
    [{ 'retry-after': '9007199254740999' }, 60000],
    [{ 'retry-after': '2.5', 'x-ratelimit-reset': 'NaN' }, 60000],
    [{}, 60000],
  ];
  for (const [headers, delay] of cases) {
    const { observer } = fixture({ now: () => 1700000000000,
      fetcher: async () => new Response(secret, { status: 429, headers }) });
    await observer.start(); const result = await observer.stop();
    assert.equal(result.metricsRateLimit.cooldownUntilMs, 1700000000000 + delay);
    assert.equal(result.samples[1].metrics.status, 'SKIPPED');
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('metrics resumes once cooldown expires without an immediate retry loop', async () => {
  let clock = 10000, requests = 0;
  const { observer, fire } = fixture({ now: () => clock, fetcher: async () => {
    requests++;
    return requests === 1 ? new Response('', { status: 429 }) : new Response(metrics);
  } });
  await observer.start();
  clock = 69999; fire(); await turn(); assert.equal(requests, 1);
  clock = 70000; fire(); await turn(); assert.equal(requests, 2);
  const result = observer.snapshot();
  assert.equal(result.samples[2].metrics.status, 'OBSERVED');
  assert.equal(result.metricsRateLimit.skipped, 1);
  await observer.stop();
});

test('SQL 429 does not activate metrics cooldown and metrics limiting does not suppress SQL', async () => {
  let metricsReads = 0, sqlReads = 0;
  const { observer } = fixture({ query: undefined, fetcher: async (_url, init) => {
    if (init.method === 'GET') { metricsReads++; return new Response(metrics); }
    sqlReads++; return new Response(secret, { status: 429, headers: { 'retry-after': '300' } });
  } });
  await observer.start(); const result = await observer.stop();
  assert.equal(metricsReads, 2); assert.equal(sqlReads, 4);
  assert.equal(result.metricsRateLimit.responses, 0);
  assert.equal(result.samples[0].metrics.status, 'OBSERVED');
  assert.equal(result.samples[0].activity.code, 'http_429');
  assert.equal(result.sqlDelta.status, 'UNAVAILABLE');
});

test('429 received by an in-flight periodic request also suppresses the waiting final GET', async () => {
  let reads = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const { observer, fire } = fixture({ fetcher: async () => {
    if (++reads === 1) return new Response(metrics);
    await pending;
    return new Response(secret, { status: 429 });
  } });
  await observer.start(); fire(); await turn();
  const stopping = observer.stop();
  release(); const result = await stopping;
  assert.equal(reads, 2);
  assert.equal(result.samples.at(-1).metrics.status, 'SKIPPED');
  assert.equal(result.samples.at(-1).activity.status, 'OBSERVED');
  assert.equal(result.sqlDelta.status, 'OBSERVED');
});
