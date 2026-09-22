// Read-only, fixed-staging evidence. No import I/O; no tokens, SQL text, labels,
// addresses or provider error bodies enter the returned report or callbacks.
export const OBSERVER_PROJECT = 'fjglrvhvdthntkvrduyi';
const BASE = `https://api.supabase.com/v1/projects/${OBSERVER_PROJECT}`;
export const OBSERVER_RPCS = Object.freeze([
  'authorize_firebase_direct_event', 'firebase_realtime_changes', 'send_message',
  'authorize_firebase_publish_wake', 'request_firebase_live_wake',
  'begin_claim_firebase_live_dispatch', 'claim_firebase_live_dispatch',
  'complete_firebase_live_dispatch', 'finish_firebase_live_dispatch',
  'finish_firebase_live_batch', 'finish_claim_firebase_live_dispatch', 'begin_firebase_live_cleanup_dispatch',
  'firebase_live_owned_maintenance', 'finish_firebase_live_owned_cleanup',
  'finish_firebase_live_cleanup_dispatch',
]);
export const OBSERVER_METRICS = Object.freeze([
  'pgrst_db_pool_max', 'pgrst_db_pool_waiting', 'pgrst_db_pool_available', 'pgrst_db_pool_timeouts_total',
  'pgrst_jwt_cache_requests_total', 'pgrst_jwt_cache_hits_total', 'pgrst_jwt_cache_evictions_total',
  'node_memory_MemTotal_bytes', 'node_memory_MemAvailable_bytes', 'node_memory_SwapTotal_bytes',
  'node_memory_SwapFree_bytes', 'node_load1', 'node_load5', 'node_load15',
  'node_boot_time_seconds', 'process_start_time_seconds',
]);
const CPU_MODES = ['idle', 'user', 'system', 'nice', 'iowait', 'irq', 'softirq', 'steal', 'guest', 'guest_nice'];
const SQL_COUNTERS = ['calls', 'total_exec_ms', 'rows', 'shared_blks_hit', 'shared_blks_read',
  'temp_blks_read', 'temp_blks_written', 'shared_blk_read_ms', 'shared_blk_write_ms'];
const ACTIVITY_FIELDS = ['connections', 'active', 'idle', 'idle_in_transaction', 'lock_waiting',
  'io_waiting', 'client_waiting', 'waiting', 'longest_active_ms'];
export const OBSERVER_ACTIVITY_SQL = `select count(*)::int as connections,
 count(*) filter(where state='active')::int as active,
 count(*) filter(where state='idle')::int as idle,
 count(*) filter(where state='idle in transaction')::int as idle_in_transaction,
 count(*) filter(where wait_event_type='Lock')::int as lock_waiting,
 count(*) filter(where wait_event_type='IO')::int as io_waiting,
 count(*) filter(where wait_event_type='Client')::int as client_waiting,
 count(*) filter(where wait_event is not null)::int as waiting,
 coalesce(max(greatest(0,extract(epoch from clock_timestamp()-query_start)*1000)) filter(where state='active'),0)::float8 as longest_active_ms
 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()`;
// Match the exact schema-qualified function invocation, not substrings such as
// claim_firebase_live_dispatch inside begin_claim_firebase_live_dispatch.
export const OBSERVER_STATEMENTS_SQL = `with wanted(rpc) as (values ${OBSERVER_RPCS.map(name => `('${name}')`).join(',')}),
 totals as (select w.rpc,coalesce(sum(s.calls),0)::float8 as calls,
 coalesce(sum(s.total_exec_time),0)::float8 as total_exec_ms,coalesce(sum(s.rows),0)::float8 as rows,
 coalesce(sum(s.shared_blks_hit),0)::float8 as shared_blks_hit,coalesce(sum(s.shared_blks_read),0)::float8 as shared_blks_read,
 coalesce(sum(s.temp_blks_read),0)::float8 as temp_blks_read,coalesce(sum(s.temp_blks_written),0)::float8 as temp_blks_written,
 coalesce(sum(s.shared_blk_read_time),0)::float8 as shared_blk_read_ms,
 coalesce(sum(s.shared_blk_write_time),0)::float8 as shared_blk_write_ms
 from wanted w left join extensions.pg_stat_statements s on s.dbid=(select oid from pg_database where datname=current_database())
 and lower(ltrim(s.query)) like 'with pgrst%'
 and s.query ~ ('(^|[^a-zA-Z0-9_])"?public"?[.]"?'||w.rpc||'"?[[:space:]]*[(]') group by w.rpc)
 select (extract(epoch from clock_timestamp())*1000)::float8 as sampled_at_ms,
 (extract(epoch from stats_reset)*1000)::float8 as stats_reset_ms,dealloc::float8,
 (extract(epoch from pg_postmaster_start_time())*1000)::float8 as postmaster_start_ms,
 (select jsonb_agg(to_jsonb(totals) order by rpc) from totals) as rpcs
 from extensions.pg_stat_statements_info`;
class ObserverError extends Error {}
class MetricsRateLimit extends ObserverError {}
const fail = code => { throw new ObserverError(code); };
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function metricsCooldownMs(headers) {
  // Supabase defines X-RateLimit-Reset as seconds REMAINING, not an epoch.
  // Only numeric duration seconds are accepted. Dates and arbitrary text are
  // neither interpreted nor retained. The minimum also covers missing headers.
  const seconds = ['retry-after', 'x-ratelimit-reset'].map(name => {
    const raw = headers.get(name);
    if (typeof raw !== 'string' || !/^\d{1,16}$/.test(raw)) return 0;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : 0;
  });
  return Math.min(300, Math.max(60, ...seconds)) * 1000;
}
function fields(row, names) {
  if (!row || names.some(name => !numeric(row[name]))) fail('invalid_numeric_response');
  return Object.fromEntries(names.map(name => [name, row[name]]));
}
function aggregate(values) {
  const sum = values.reduce((total, value) => total + value, 0);
  if (!numeric(sum)) fail('metric_value_limit');
  return { sum, min: Math.min(...values), max: Math.max(...values), series: values.length };
}
export function parseObserverMetrics(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) fail('response_limit');
  const series = new Map(), cpu = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const name = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)/)?.[1];
    if (!OBSERVER_METRICS.includes(name) && name !== 'node_cpu_seconds_total') continue;
    const match = line.match(/^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\{((?:[^"}]|"(?:\\.|[^"\\])*")*)\})?\s+(\S+)(?:\s+\d+)?\s*$/);
    if (!match || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(match[2])) fail('invalid_metric_value');
    const value = Number(match[2]); if (!numeric(value)) fail('invalid_metric_value');
    if (name === 'node_cpu_seconds_total') {
      const mode = match[1]?.match(/(?:^|,)\s*mode="([a-z_]+)"(?:,|$)/)?.[1];
      if (!CPU_MODES.includes(mode)) continue;
      if (!cpu.has(mode)) cpu.set(mode, []);
      cpu.get(mode).push(value);
    } else {
      if (!series.has(name)) series.set(name, []);
      series.get(name).push(value);
    }
  }
  if (!series.size && !cpu.size) fail('metrics_missing');
  return { values: Object.fromEntries([...series].map(([key, values]) => [key, aggregate(values)])),
    cpuSeconds: Object.fromEntries([...cpu].map(([key, values]) => [key, aggregate(values)])),
    missing: OBSERVER_METRICS.filter(name => !series.has(name)), cpuMissing: !cpu.size };
}
function parseStatements(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) fail('invalid_statements_response');
  const row = rows[0], output = fields(row, ['sampled_at_ms', 'stats_reset_ms', 'dealloc', 'postmaster_start_ms']);
  if (!Array.isArray(row.rpcs) || row.rpcs.length !== OBSERVER_RPCS.length) fail('invalid_statements_response');
  const seen = new Set();
  output.rpcs = row.rpcs.map(item => {
    if (!OBSERVER_RPCS.includes(item?.rpc) || seen.has(item.rpc)) fail('invalid_statements_response');
    seen.add(item.rpc); return { rpc: item.rpc, ...fields(item, SQL_COUNTERS) };
  });
  return output;
}
export function observerStatementDelta(before, after) {
  if (before?.status !== 'OBSERVED' || after?.status !== 'OBSERVED') return { status: 'UNAVAILABLE', reason: 'endpoint_snapshot_unavailable' };
  const a = before.value, b = after.value;
  if (b.sampled_at_ms < a.sampled_at_ms || a.stats_reset_ms !== b.stats_reset_ms || a.postmaster_start_ms !== b.postmaster_start_ms) {
    return { status: 'UNAVAILABLE', reason: 'stats_reset_or_restart' };
  }
  if (a.dealloc !== b.dealloc) return { status: 'UNAVAILABLE', reason: 'statement_history_deallocated' };
  const rpcs = b.rpcs.map(row => {
    const initial = a.rpcs.find(item => item.rpc === row.rpc);
    return { rpc: row.rpc, ...Object.fromEntries(SQL_COUNTERS.map(key => [key, row[key] - initial[key]])) };
  });
  if (rpcs.some(row => SQL_COUNTERS.some(key => !numeric(row[key])))) return { status: 'UNAVAILABLE', reason: 'statement_counter_reset' };
  return { status: 'OBSERVED', startAtMs: a.sampled_at_ms, endAtMs: b.sampled_at_ms, rpcs };
}
function continuity(samples) {
  const observed = samples.filter(sample => sample.metrics.status === 'OBSERVED');
  let counterDecrease = false, topologyChanged = false, restartMarkerChanged = false;
  for (let i = 1; i < observed.length; i++) {
    const a = observed[i - 1].metrics.value, b = observed[i].metrics.value;
    for (const name of OBSERVER_METRICS.filter(name => name.endsWith('_total'))) {
      if (a.values[name] && b.values[name] && b.values[name].sum < a.values[name].sum) counterDecrease = true;
    }
    for (const mode of CPU_MODES) if (a.cpuSeconds[mode] && b.cpuSeconds[mode]) {
      if (b.cpuSeconds[mode].sum < a.cpuSeconds[mode].sum) counterDecrease = true;
      if (b.cpuSeconds[mode].series !== a.cpuSeconds[mode].series) topologyChanged = true;
    }
    for (const name of ['node_boot_time_seconds', 'process_start_time_seconds']) if (a.values[name] && b.values[name]) {
      if (JSON.stringify(a.values[name]) !== JSON.stringify(b.values[name])) restartMarkerChanged = true;
    }
  }
  return { comparableSamples: observed.length, counterDecrease, topologyChanged, restartMarkerChanged,
    limitations: 'Aggregate counters only: missing scrapes, unexported restarts or replacement series may hide resets. Provider metrics refresh approximately once per minute; subminute or identical cached scrapes cannot prove zero load. Zero cumulative pool timeouts does not prove zero historical pool waiting.' };
}

export function createStagingLoadObserver({ token, fetcher = globalThis.fetch, query,
  now = Date.now, intervalMs = 60000, maxSamples = 180, onSample,
  setTimer = setTimeout, clearTimer = clearTimeout,
  timeoutSignal = () => AbortSignal.timeout(10000) } = {}) {
  if (typeof token !== 'function' || typeof fetcher !== 'function' || (query !== undefined && typeof query !== 'function')
      || (onSample !== undefined && typeof onSample !== 'function')
      || !Number.isSafeInteger(intervalMs) || intervalMs < 5000 || intervalMs > 60000
      || !Number.isSafeInteger(maxSamples) || maxSamples < 2 || maxSamples > 180) fail('invalid_observer_options');
  const report = { project: OBSERVER_PROJECT, intervalMs, maxSamples, samples: [], sampleLimitReached: false, callbackErrors: 0,
    providerRefreshApproxMs: 60000,
    providerFreshness: 'Supabase documents approximately one-minute metrics refresh. Management endpoint scrapes may return cached values; subminute or identical scrapes cannot prove zero load. Client requestedAtMs/completedAtMs are observation times, not provider measurement timestamps.',
    providerRefreshSource: 'https://supabase.com/blog/metrics-api-observability',
    metricsRateLimit: { responses: 0, skipped: 0, cooldownUntilMs: null,
      policy: 'Metrics observer API limits are not application-service failures. Numeric Retry-After and X-RateLimit-Reset are duration seconds; cooldown is 60–300 seconds. Periodic and final metrics reads respect cooldown; SQL observations remain independent.' },
    callbackPolicy: 'Synchronous safe-copy notification; thrown errors or unsupported async callbacks are counted separately and never stop sampling.',
    sqlBefore: { status: 'UNAVAILABLE', code: 'not_started' }, sqlAfter: { status: 'UNAVAILABLE', code: 'not_stopped' } };
  let started = false, stopped = false, timer, active = Promise.resolve(), startWork, stopWork;
  async function body(response, signal) {
    if (!response.ok) { await response.body?.cancel(); fail(`http_${response.status}`); }
    const reader = response.body?.getReader(); if (!reader) fail('invalid_response');
    const chunks = []; let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); fail('response_limit'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size).toString('utf8');
  }
  async function request(path, sql, signal) {
    const credential = await token(); signal.throwIfAborted();
    if (typeof credential !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(credential)) fail('token_unavailable');
    const response = await fetcher(`${BASE}${path}`, { method: sql ? 'POST' : 'GET', redirect: 'error', signal,
      headers: { authorization: `Bearer ${credential}`, ...(sql ? { 'content-type': 'application/json' } : {}) },
      ...(sql ? { body: JSON.stringify({ query: sql }) } : {}) });
    if (path === '/analytics/endpoints/metrics' && response.status === 429) {
      report.metricsRateLimit.responses++;
      report.metricsRateLimit.cooldownUntilMs = now() + metricsCooldownMs(response.headers);
      await response.body?.cancel().catch(() => {});
      throw new MetricsRateLimit('http_429');
    }
    return body(response, signal);
  }
  async function read(kind) {
    const requestedAtMs = now();
    if (kind === 'metrics' && requestedAtMs < report.metricsRateLimit.cooldownUntilMs) {
      report.metricsRateLimit.skipped++;
      return { status: 'SKIPPED', requestedAtMs, completedAtMs: now(), code: 'metrics_cooldown',
        category: 'observer_rate_limit', retryAtMs: report.metricsRateLimit.cooldownUntilMs };
    }
    const signal = timeoutSignal(10000);
    try {
      let value;
      if (kind === 'metrics') value = parseObserverMetrics(await request('/analytics/endpoints/metrics', null, signal));
      else {
        const sql = kind === 'activity' ? OBSERVER_ACTIVITY_SQL : OBSERVER_STATEMENTS_SQL;
        const rows = query ? await query(sql, { signal }) : JSON.parse(await request('/database/query', sql, signal));
        signal.throwIfAborted();
        if (kind === 'statements') value = parseStatements(rows);
        else {
          if (!Array.isArray(rows) || rows.length !== 1) fail('invalid_activity_response');
          value = fields(rows[0], ACTIVITY_FIELDS);
        }
      }
      signal.throwIfAborted();
      return { status: 'OBSERVED', requestedAtMs, completedAtMs: now(), value };
    } catch (error) {
      if (error instanceof MetricsRateLimit) return {
        status: 'UNAVAILABLE', requestedAtMs, completedAtMs: now(), code: 'http_429',
        category: 'observer_rate_limit', retryAtMs: report.metricsRateLimit.cooldownUntilMs,
      };
      return { status: 'UNAVAILABLE', requestedAtMs, completedAtMs: now(),
        code: signal.aborted ? 'request_timeout' : error instanceof ObserverError ? error.message : 'read_failed' };
    }
  }
  async function sample(phase) {
    const sample = { phase, requestedAtMs: now(), metrics: await read('metrics'), activity: await read('activity') };
    sample.completedAtMs = now(); report.samples.push(sample);
    try {
      const result = onSample?.(structuredClone(sample));
      if (result && typeof result.then === 'function') {
        report.callbackErrors++;
        // Async callbacks are unsupported: do not let their work block the load,
        // retain callbacks, or leak an unhandled rejection containing provider data.
        void Promise.resolve(result).catch(() => {});
      }
    } catch { report.callbackErrors++; }
  }
  function schedule() {
    if (stopped) return;
    if (report.samples.length >= maxSamples - 1) { report.sampleLimitReached = true; return; }
    const due = Math.max(0, intervalMs - (now() - report.samples.at(-1).requestedAtMs));
    timer = setTimer(() => { if (!stopped) active = sample('periodic').then(schedule); }, due);
    timer?.unref?.();
  }
  function snapshot() {
    return structuredClone({ ...report, sqlDelta: observerStatementDelta(report.sqlBefore, report.sqlAfter),
      counterContinuity: continuity(report.samples) });
  }
  return Object.freeze({
    start() {
      if (stopped) return Promise.reject(new ObserverError('observer_stopped'));
      if (!started) {
        started = true;
        startWork = active = (async () => {
          report.startedAtMs = now(); report.sqlBefore = await read('statements'); await sample('baseline'); schedule();
        })();
      }
      return startWork.then(snapshot);
    },
    stop() {
      if (!stopWork) {
        stopped = true; clearTimer(timer);
        stopWork = (async () => {
          await active;
          if (started) { report.sqlAfter = await read('statements'); await sample('final'); report.stoppedAtMs = now(); }
          return snapshot();
        })();
      }
      return stopWork;
    },
    snapshot,
  });
}
