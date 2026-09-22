// Bounded numeric observations only. No URL, token, body or arbitrary header is retained.
import { quantiles } from './staging-load-core.mjs';
export const OBSERVED_RPCS = new Set(['send_message', 'firebase_realtime_changes',
  'authorize_firebase_direct_event', 'authorize_firebase_publish_wake']);
const stages = ['jwt', 'parse', 'plan', 'transaction', 'response'];
export function directDatabaseObservation(detail) {
  const stage = detail?.failureStage;
  const passedDB = detail?.published === true || ['authorized_event', 'google_auth', 'rtdb_write'].includes(stage);
  if (!passedDB && stage !== 'db_validation') return undefined;
  return { name: 'authorize_firebase_direct_event', status: passedDB ? 200 : detail.upstreamStatus,
    headersMs: detail.timing?.dbHeadersMs, bodyMs: detail.timing?.dbBodyMs,
    totalMs: detail.timing?.dbValidationMs, serverTiming: detail.dbServerTiming,
    ...(!passedDB ? { failure: ['timeout', 'aborted', 'transport'].includes(detail.failureCode) ? detail.failureCode : 'other' } : {}) };
}
export class RpcObservation {
  constructor({ sampleLimit = 4096 } = {}) {
    if (!Number.isSafeInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 20000) throw new Error('invalid_sample_limit');
    this.sampleLimit = sampleLimit; this.rows = {};
  }
  record({ name, status, headersMs, bodyMs, totalMs, serverTiming = {}, failure }) {
    if (!OBSERVED_RPCS.has(name)) return;
    const row = this.rows[name] ||= { attempts: 0, responses: 0, statuses: {}, failures: {}, timings: {} };
    row.attempts++;
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      row.responses++; row.statuses[status] = (row.statuses[status] || 0) + 1;
    }
    if (failure) {
      const code = ['timeout', 'aborted', 'stopped', 'transport', 'body', 'other'].includes(failure) ? failure : 'other';
      row.failures[code] = (row.failures[code] || 0) + 1;
    }
    const values = { headersMs, bodyMs, totalMs };
    for (const key of stages) values[`server_${key}Ms`] = serverTiming?.[key];
    if (Number.isFinite(headersMs) && headersMs >= 0 && headersMs <= 120000
        && stages.every(key => Number.isFinite(serverTiming?.[key]) && serverTiming[key] >= 0 && serverTiming[key] <= 120000)) {
      values.serverStageTotalMs = stages.reduce((sum, key) => sum + serverTiming[key], 0);
      // Pair durations from the same request. This includes network/gateway and
      // uninstrumented server work, not just a queue. Keep rounding negatives.
      values.unattributedHeadersMs = headersMs - values.serverStageTotalMs;
    }
    for (const [key, value] of Object.entries(values)) {
      if (!Number.isFinite(value) || value < (key === 'unattributedHeadersMs' ? -120000 : 0) || value > 120000) continue;
      const metric = row.timings[key] ||= { count: 0, sum: 0, max: value, samples: [] };
      metric.count++; metric.sum += value; metric.max = Math.max(metric.max, value);
      if (metric.samples.length < this.sampleLimit) metric.samples.push(value);
    }
  }
  snapshot() {
    return { scope: 'Client RPCs initiated during the hold plus direct-event DB phases reported by returned handlers. Cancelled direct calls without handler responses have no DB-phase observation. Timing includes HTTP and response body; server stages exist only when provided.',
      sampling: 'Quantiles use the first bounded samples; mean and max use all observations. Truncation is explicit.',
      rpcs: Object.fromEntries(Object.entries(this.rows).map(([name, row]) => [name, {
        attempts: row.attempts, responses: row.responses, statuses: { ...row.statuses }, failures: { ...row.failures },
        timings: Object.fromEntries(Object.entries(row.timings).map(([key, value]) => [key, {
          ...quantiles(value.samples), count: value.count, sampleCount: value.samples.length,
          truncated: value.count > value.samples.length, mean: value.sum / value.count, max: value.max,
        }])),
      }])) };
  }
}
