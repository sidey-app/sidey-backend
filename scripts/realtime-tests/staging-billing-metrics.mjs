// Read-only evidence, never an invoice or a budget cap. No I/O on import.
// Official definitions checked 2026-09-18:
// https://firebase.google.com/docs/database/usage/monitor-usage
// https://docs.cloud.google.com/monitoring/api/metrics_gcp_d_h#firebasedatabase
// https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.timeSeries/list
import { execFile } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { signJWT } from '../../supabase/functions/_shared/realtime.mjs';

export const PROJECT = 'sidey-realtime-staging';
const PREFIX = 'firebasedatabase.googleapis.com/';
const API = `https://monitoring.googleapis.com/v3/projects/${PROJECT}`;
const MAX_PAGES = 10, MAX_POINTS = 10000, MAX_BODY = 2 * 1024 * 1024;
export const METRICS = Object.freeze([
  { path: 'network/sent_bytes_count', metricKind: 'DELTA', valueType: 'INT64', unit: 'By' },
  { path: 'network/sent_payload_and_protocol_bytes_count', metricKind: 'DELTA', valueType: 'INT64', unit: 'By' },
  { path: 'network/sent_payload_bytes_count', metricKind: 'DELTA', valueType: 'INT64', unit: 'By' },
  { path: 'network/https_requests_count', metricKind: 'DELTA', valueType: 'INT64', unit: '1' },
  { path: 'io/database_load', metricKind: 'GAUGE', valueType: 'DOUBLE', unit: '1', sampleSeconds: 60, ingestDelaySeconds: 1800 },
  { path: 'network/active_connections', metricKind: 'GAUGE', valueType: 'INT64', unit: '1', sampleSeconds: 60, ingestDelaySeconds: 1800 },
  // A 15-minute window normally cannot establish storage: daily samples, up to a day of delay.
  { path: 'storage/total_bytes', metricKind: 'GAUGE', valueType: 'INT64', unit: 'By', sampleSeconds: 86400, ingestDelaySeconds: 86400 },
].map(Object.freeze));

class EvidenceError extends Error {}
function fail(code) { throw new EvidenceError(code); }
function code(error) { return error instanceof EvidenceError ? error.message : 'collection_failed'; }
function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) fail('invalid_iso_time');
  return new Date(value).toISOString();
}
export function parseArguments(argv, now = Date.now()) {
  const values = new Map();
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!['--read-staging', '--start', '--end'].includes(name) || values.has(name)) fail('invalid_arguments');
    values.set(name, name === '--read-staging' ? true : argv[++i]);
  }
  if (!values.get('--read-staging')) fail('explicit_staging_read_required');
  const start = iso(values.get('--start')), end = iso(values.get('--end'));
  const duration = Date.parse(end) - Date.parse(start);
  if (duration <= 0 || duration > 2 * 60 * 60 * 1000 || Date.parse(end) > now) fail('invalid_time_window');
  return { start, end };
}

export async function readAccessToken(run = promisify(execFile)) {
  try {
    // No login, account change, project mutation, token file, shell interpolation or inherited stdout.
    const result = await run('gcloud', ['auth', 'print-access-token', '--project', PROJECT, '--quiet'],
      { timeout: 15000, maxBuffer: 16384, windowsHide: true });
    const token = result.stdout?.trim();
    if (!token || token.length > 12000 || /\s/.test(token)) fail('authentication_unavailable');
    return token;
  } catch { fail('authentication_unavailable'); }
}

// Explicit alternative to gcloud. The supplied account can only identify staging;
// monitoring.read limits this token's scope but does not grant missing IAM access.
export async function readMonitoringAccessToken(account, { fetcher = fetch, signer = signJWT, now = Date.now() } = {}) {
  try {
    if (account?.type !== 'service_account' || account.project_id !== PROJECT
        || !/^[a-zA-Z0-9_-]+@sidey-realtime-staging\.iam\.gserviceaccount\.com$/.test(account.client_email || '')
        || typeof account.private_key !== 'string' || account.private_key.length > 16384
        || !account.private_key.startsWith('-----BEGIN PRIVATE KEY-----')
        || createPrivateKey(account.private_key).asymmetricKeyType !== 'rsa'
        || !Number.isFinite(now)) fail('authentication_unavailable');
    const iat = Math.floor(now / 1000);
    const assertion = await signer(account, { iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/monitoring.read',
      aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 300 });
    const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
    if (!response.ok) { await response.body?.cancel(); fail('authentication_unavailable'); }
    const reader = response.body?.getReader();
    if (!reader) fail('authentication_unavailable');
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 16384) { await reader.cancel(); fail('authentication_unavailable'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const token = result.access_token;
    if (typeof token !== 'string' || !token || token.length > 12000 || /\s/.test(token)
        || result.token_type?.toLowerCase() !== 'bearer') fail('authentication_unavailable');
    return token;
  } catch { fail('authentication_unavailable'); }
}

async function getJSON(url, token, fetcher) {
  let response;
  try {
    response = await fetcher(url, { method: 'GET', headers: { authorization: `Bearer ${token}` },
      redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch { fail('monitoring_request_failed'); }
  if (!response.ok) {
    await response.body?.cancel();
    if ([401, 403].includes(response.status)) fail('monitoring_permission_denied');
    if (response.status === 404) fail('metric_unavailable');
    if (response.status === 429) fail('monitoring_rate_limited');
    fail('monitoring_http_error');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('invalid_monitoring_response');
  let size = 0; const chunks = [];
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); fail('monitoring_response_limit'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('invalid_monitoring_response'); }
}

function durationSeconds(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?s$/.test(value)) return null;
  const number = Number(value.slice(0, -1)); return Number.isFinite(number) && number > 0 ? number : null;
}
function seriesKey(series) {
  const sorted = object => Object.entries(object || {}).sort(([a], [b]) => a.localeCompare(b));
  // Kept in memory only to join pages; resource and label identities are never emitted.
  return JSON.stringify([sorted(series.resource?.labels), sorted(series.metric?.labels)]);
}
function summarizeSeries(points, metric, start, end, sampleSeconds) {
  const unique = new Map(); let duplicates = 0;
  for (const point of points) {
    const finish = Date.parse(point.interval?.endTime);
    const begin = metric.metricKind === 'DELTA' ? Date.parse(point.interval?.startTime) : finish;
    const raw = metric.valueType === 'INT64' ? point.value?.int64Value : point.value?.doubleValue;
    if (!Number.isFinite(finish) || !Number.isFinite(begin) || begin > finish
        || (metric.metricKind === 'DELTA' && begin === finish)) fail('invalid_metric_point');
    if (metric.valueType === 'INT64' ? typeof raw !== 'string' || !/^\d+$/.test(raw)
      : typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) fail('invalid_metric_value');
    const key = `${begin}/${finish}`;
    if (unique.has(key)) {
      if (unique.get(key).raw !== raw) fail('conflicting_metric_points');
      duplicates++; continue;
    }
    unique.set(key, { begin, finish, raw });
  }
  const ordered = [...unique.values()].sort((a, b) => a.begin - b.begin);
  const included = ordered.filter(point => point.begin >= start && point.finish <= end);
  const excludedBoundaryPoints = ordered.length - included.length;
  const summary = { sampleCount: included.length, duplicatePointsIgnored: duplicates, excludedBoundaryPoints,
    firstSampleAt: included.length ? new Date(included[0].finish).toISOString() : null,
    lastSampleAt: included.length ? new Date(included.at(-1).finish).toISOString() : null };
  if (!included.length) return { ...summary, status: 'BLOCKED', reason: 'no_samples_in_window' };
  if (metric.metricKind === 'DELTA') {
    let total = 0n, covered = 0, previous = start;
    for (const point of included) {
      if (point.begin < previous) fail('overlapping_delta_intervals');
      total += BigInt(point.raw); covered += point.finish - point.begin; previous = point.finish;
    }
    // Never prorate a partial DELTA interval or extrapolate gaps as zero.
    const complete = covered === end - start && excludedBoundaryPoints === 0;
    return { ...summary, status: complete ? 'PASS' : 'BLOCKED', reason: complete ? null : 'incomplete_delta_coverage',
      observedDeltaSum: total.toString(), coveredSeconds: covered / 1000, coverageRatio: covered / (end - start) };
  }
  const values = included.map(point => Number(point.raw));
  if (values.some(value => !Number.isFinite(value) || (metric.valueType === 'INT64' && !Number.isSafeInteger(value)))) fail('metric_value_out_of_range');
  const gaps = [included[0].finish - start, end - included.at(-1).finish,
    ...included.slice(1).map((point, index) => point.finish - included[index].finish)];
  const enough = sampleSeconds !== null && end - start >= sampleSeconds * 1000
    && Math.max(...gaps) <= sampleSeconds * 1500;
  return { ...summary, status: enough ? 'PASS' : 'BLOCKED', reason: enough ? null : 'insufficient_gauge_coverage',
    sampleMean: values.reduce((sum, value) => sum + value, 0) / values.length,
    samplePeak: Math.max(...values), maximumSampleGapSeconds: Math.max(...gaps) / 1000,
    sampledSpanSeconds: (included.at(-1).finish - included[0].finish) / 1000,
    averageMethod: 'arithmetic mean of observed samples in this series; not a time-weighted or cross-series mean' };
}

async function collectMetric(metric, window, token, fetcher, now) {
  const type = PREFIX + metric.path;
  const descriptor = await getJSON(`${API}/metricDescriptors/${type}`, token, fetcher);
  if (descriptor.type !== type || descriptor.metricKind !== metric.metricKind || descriptor.valueType !== metric.valueType
      || descriptor.unit !== metric.unit) fail('metric_descriptor_mismatch');
  const sampleSeconds = durationSeconds(descriptor.metadata?.samplePeriod) ?? metric.sampleSeconds ?? null;
  const ingestDelaySeconds = durationSeconds(descriptor.metadata?.ingestDelay) ?? metric.ingestDelaySeconds ?? null;
  const groups = new Map(), pagesSeen = new Set(); let pageToken = '', pages = 0, pointCount = 0;
  do {
    if (pages++ >= MAX_PAGES || pagesSeen.has(pageToken)) fail('pagination_limit');
    pagesSeen.add(pageToken);
    const url = new URL(`${API}/timeSeries`);
    url.search = new URLSearchParams({ filter: `metric.type="${type}" AND resource.type="firebase_namespace" AND resource.labels.project_id="${PROJECT}"`,
      'interval.startTime': window.start, 'interval.endTime': window.end, view: 'FULL', pageSize: '1000', ...(pageToken ? { pageToken } : {}) }).toString();
    const result = await getJSON(url.href, token, fetcher);
    if (result.executionErrors?.length) fail('partial_monitoring_response');
    if (result.timeSeries !== undefined && !Array.isArray(result.timeSeries)) fail('invalid_monitoring_response');
    for (const series of result.timeSeries || []) {
      if (series.metric?.type !== type || series.resource?.type !== 'firebase_namespace'
          || series.resource?.labels?.project_id !== PROJECT || series.metricKind !== metric.metricKind
          || series.valueType !== metric.valueType || !Array.isArray(series.points)) fail('unexpected_metric_series');
      pointCount += series.points.length;
      if (pointCount > MAX_POINTS) fail('metric_point_limit');
      const key = seriesKey(series);
      if (!groups.has(key)) {
        if (groups.size >= 100) fail('metric_point_limit');
        groups.set(key, []);
      }
      groups.get(key).push(...series.points);
    }
    if (result.nextPageToken !== undefined && (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 4096)) fail('invalid_page_token');
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  const start = Date.parse(window.start), end = Date.parse(window.end);
  const series = [...groups.values()].map(points => summarizeSeries(points, metric, start, end, sampleSeconds));
  const immature = ingestDelaySeconds !== null && now - end < ingestDelaySeconds * 1000;
  const complete = series.length > 0 && series.every(item => item.status === 'PASS') && !immature;
  return { metric: type, metricKind: descriptor.metricKind, valueType: descriptor.valueType, unit: descriptor.unit,
    status: complete ? 'PASS' : 'BLOCKED', reason: !series.length ? 'no_samples' : immature ? 'provider_ingestion_delay' : complete ? null : 'incomplete_coverage',
    sampleSeconds, ingestDelaySeconds, collectionPages: pages, seriesCount: series.length, series,
    ...(metric.metricKind === 'DELTA' && series.some(item => item.sampleCount > 0)
      ? { observedDeltaSum: series.reduce((sum, item) => sum + BigInt(item.observedDeltaSum || '0'), 0n).toString() } : {}) };
}

export async function collectBillingMetrics(argv, { fetcher = fetch, getToken = readAccessToken, now = Date.now() } = {}) {
  const report = { status: 'BLOCKED', project: PROJECT, collectedAt: new Date(now).toISOString(), metrics: [],
    evidenceType: 'Cloud Monitoring RTDB service metrics; not an invoice, paid-resource inventory or charge cap',
    limitations: [
      'Project traffic includes setup, workers, cleanup and any unrelated concurrent staging use; no run attribution is inferred.',
      'Never monthly-extrapolate a 15-minute run, free allowances or its initial connection traffic.',
      'DELTA sums include only complete source intervals inside the requested window. Missing data is not zero.',
      'GAUGE means and peaks are per series sampled observations, not summed counters or exact instantaneous peaks.',
      'Storage is sampled daily; a short window normally cannot establish storage usage.',
    ] };
  let window, token;
  try { window = parseArguments(argv, now); report.window = window; token = await getToken(); }
  catch (error) { report.reason = error instanceof EvidenceError ? code(error) : 'authentication_unavailable'; return report; }
  for (const metric of METRICS) {
    try { report.metrics.push(await collectMetric(metric, window, token, fetcher, now)); }
    catch (error) { report.metrics.push({ metric: PREFIX + metric.path, metricKind: metric.metricKind,
      valueType: metric.valueType, unit: metric.unit, status: 'BLOCKED', reason: code(error) }); }
  }
  report.status = report.metrics.every(metric => metric.status === 'PASS') ? 'PASS' : 'BLOCKED';
  return report;
}

export async function main(argv = process.argv.slice(2), options) {
  const accountFile = process.env.SIDEY_STAGING_SERVICE_ACCOUNT_FILE;
  const getToken = accountFile ? async () => {
    try {
      // Only this explicit CLI boundary reads credentials. Never persist the OAuth token.
      const contents = await readFile(accountFile, 'utf8');
      if (Buffer.byteLength(contents) > 65536) fail('authentication_unavailable');
      return await readMonitoringAccessToken(JSON.parse(contents));
    } catch { fail('authentication_unavailable'); }
  } : readAccessToken;
  const report = await collectBillingMetrics(argv, { getToken, ...options });
  console.log(JSON.stringify(report, null, 2));
  return report.status === 'PASS' ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(status => { process.exitCode = status; }).catch(() => {
    console.log(JSON.stringify({ status: 'BLOCKED', project: PROJECT, reason: 'collection_failed' })); process.exitCode = 2;
  });
}
