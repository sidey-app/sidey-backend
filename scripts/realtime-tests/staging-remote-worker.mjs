// Explicit staging-only entry point. Configuration/secrets arrive once over SSH stdin.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LiveWorker } from './live-worker.mjs';
import { googleAccessToken } from '../../supabase/functions/_shared/realtime.mjs';

export const STAGING = Object.freeze({
  project: 'sidey-realtime-staging', supabaseRef: 'fjglrvhvdthntkvrduyi',
  supabaseURL: 'https://fjglrvhvdthntkvrduyi.supabase.co',
  databaseURL: 'https://sidey-realtime-staging-default-rtdb.asia-southeast1.firebasedatabase.app',
});
export const SOURCE_FILES = Object.freeze([
  'scripts/realtime-tests/staging-remote-worker.mjs', 'scripts/realtime-tests/live-worker.mjs',
  'supabase/functions/_shared/realtime.mjs', 'supabase/functions/_shared/realtime-live.mjs',
  'supabase/functions/_shared/realtime-live-publisher.mjs',
]);
const root = fileURLToPath(new URL('../../', import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const rpcNames = new Set(['claim_firebase_live', 'finish_firebase_live', 'firebase_live_maintenance', 'finish_firebase_live_cleanup']);
const outcomes = new Set(['publish_ok', 'publish_retry', 'cleanup_lease_ok', 'cleanup_lease_retry',
  'cleanup_event_ok', 'cleanup_event_retry', 'cleanup_epoch_ok', 'cleanup_epoch_retry', 'batch_retry', 'maintenance_retry']);
export const BILLING_NOTE = 'Decoded HTTP body bytes are not billing bytes; TLS, protocol overhead and other project traffic are excluded.';
export async function sourceHashes(directory = root) {
  return Object.fromEntries(await Promise.all(SOURCE_FILES.map(async file => [file,
    createHash('sha256').update(await readFile(resolve(directory, file))).digest('hex')])));
}
export function validateConfiguration(config) {
  if (!config || !uuid.test(config.runId) || !Number.isInteger(config.maxSeconds)
      || config.maxSeconds < 1 || config.maxSeconds > 3600
      || Object.entries(STAGING).some(([name, value]) => config[name] !== value)
      || !config.sourceSHA256 || Object.keys(config.sourceSHA256).length !== SOURCE_FILES.length
      || SOURCE_FILES.some(file => !/^[0-9a-f]{64}$/.test(config.sourceSHA256[file] || ''))
      || typeof config.credentials?.serviceRoleKey !== 'string' || !config.credentials.serviceRoleKey
      || config.credentials.serviceRoleKey.length > 16384
      || config.credentials.account?.project_id !== STAGING.project
      || typeof config.credentials.account?.private_key !== 'string'
      || !config.credentials.account.private_key.includes('BEGIN PRIVATE KEY')
      || !/^[a-zA-Z0-9_-]+@sidey-realtime-staging\.iam\.gserviceaccount\.com$/.test(config.credentials.account.client_email || '')) {
    throw new Error('remote_configuration_rejected');
  }
  // Legacy JWT keys carry a ref claim. Never accept an explicitly different project.
  const key = config.credentials.serviceRoleKey;
  if (key.split('.').length === 3) {
    let claims;
    try { claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()); }
    catch { throw new Error('remote_configuration_rejected'); }
    if (claims.ref !== STAGING.supabaseRef || claims.role !== 'service_role') throw new Error('remote_configuration_rejected');
  }
}

function requestKind(url, init) {
  const parsed = new URL(url), method = init.method || 'GET';
  if (parsed.origin === STAGING.supabaseURL) {
    const name = parsed.pathname.split('/').at(-1);
    if (!rpcNames.has(name) || parsed.pathname !== `/rest/v1/rpc/${name}` || method !== 'POST') throw new Error('remote_target_rejected');
    return `rpc.${name}`;
  }
  if (parsed.origin === STAGING.databaseURL && /^\/v2\//.test(parsed.pathname) && ['GET', 'PUT', 'DELETE'].includes(method)) {
    const category = parsed.pathname.startsWith('/v2/access/') ? 'access' : parsed.pathname.startsWith('/v2/leases/') ? 'lease'
      : parsed.pathname.endsWith('/hint.json') ? 'hint' : parsed.pathname.includes('/events/') ? 'event'
      : parsed.pathname.includes('/presence/') ? 'presence' : 'epoch';
    return `rtdb.${category}.${method}`;
  }
  if (parsed.href === 'https://oauth2.googleapis.com/token' && method === 'POST') return 'oauth.token';
  throw new Error('remote_target_rejected');
}
export function measuredFetcher(fetcher, signal, metrics, now = performance.now.bind(performance)) {
  return async (url, init = {}) => {
    const kind = requestKind(url, init);
    const item = metrics.http[kind] ||= { count: 0, errors: 0, requestBodyBytes: 0, responseBodyBytes: 0,
      durationMs: 0, maxDurationMs: 0, statuses: {} };
    item.count++;
    item.requestBodyBytes += Buffer.byteLength(init.body === undefined ? '' : String(init.body));
    const started = now();
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10000), ...(init.signal ? [init.signal] : [])]);
      const response = await fetcher(url, { ...init, signal: requestSignal, redirect: 'error' });
      item.statuses[response.status] = (item.statuses[response.status] || 0) + 1;
      if (!response.ok) item.errors++;
      // Consume even ignored PUT/DELETE bodies; count decoded bytes, never payloads.
      const chunks = []; let length = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            requestSignal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            length += value.length; item.responseBodyBytes += value.length;
            if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('remote_response_too_large'); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
      }
      return new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks),
        { status: response.status, headers: response.headers });
    } catch { item.errors++; throw new Error('remote_request_failed'); }
    finally {
      const elapsed = Math.max(0, now() - started);
      item.durationMs += elapsed; item.maxDurationMs = Math.max(item.maxDurationMs, elapsed);
    }
  };
}

export async function runRemoteWorker(config, { signal, fetcher = fetch, emit = () => {},
  tokenProvider = googleAccessToken, hashProvider = sourceHashes, metricsIntervalMs = 5000,
  waitForStart = async () => {} } = {}) {
  validateConfiguration(config);
  const hashes = await hashProvider();
  if (SOURCE_FILES.some(file => hashes[file] !== config.sourceSHA256[file])) throw new Error('remote_source_mismatch');
  const stop = new AbortController();
  const parentSignal = signal || new AbortController().signal;
  const combined = AbortSignal.any([parentSignal, stop.signal]);
  const timer = setTimeout(() => stop.abort(), config.maxSeconds * 1000);
  const started = Date.now(), cpuStarted = process.cpuUsage();
  const metrics = { http: {}, outcomes: {}, billingNote: BILLING_NOTE };
  const measuredFetch = measuredFetcher(fetcher, combined, metrics);
  const sendMetrics = type => emit({ type, runId: config.runId, elapsedMs: Date.now() - started,
    ...structuredClone(metrics), cpu: process.cpuUsage(cpuStarted), memory: process.memoryUsage() });
  let token, tokenExpires = 0, metricsTimer;
  const accessToken = async () => {
    combined.throwIfAborted();
    if (!token || Date.now() >= tokenExpires) {
      tokenExpires = Date.now() + 240000;
      token = Promise.resolve().then(() => tokenProvider(config.credentials.account, measuredFetch))
        .catch(() => { token = undefined; tokenExpires = 0; throw new Error('remote_auth_failed'); });
    }
    return token;
  };
  const rpc = async (name, body, workSignal) => {
    if (!rpcNames.has(name)) throw new Error('remote_rpc_rejected');
    const key = config.credentials.serviceRoleKey;
    const response = await measuredFetch(`${STAGING.supabaseURL}/rest/v1/rpc/${name}`, { method: 'POST',
      headers: { authorization: `Bearer ${key}`, apikey: key, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: workSignal });
    if (!response.ok) throw new Error('remote_rpc_failed');
    const text = await response.text(); return text ? JSON.parse(text) : null;
  };
  const log = name => { if (outcomes.has(name)) metrics.outcomes[name] = (metrics.outcomes[name] || 0) + 1; };
  const worker = new LiveWorker({ config: { databaseURL: STAGING.databaseURL }, rpc, accessToken,
    fetcher: measuredFetch, log });
  const loop = async (work, interval, failure) => {
    while (!combined.aborted) {
      const at = Date.now();
      try { await work(); } catch { if (!combined.aborted) log(failure); }
      try { await delay(Math.max(0, interval - (Date.now() - at)), undefined, { signal: combined }); }
      catch { if (!combined.aborted) throw new Error('remote_loop_failed'); }
    }
  };
  try {
    await accessToken(); combined.throwIfAborted();
    emit({ type: 'ready', runId: config.runId, sourceSHA256: hashes, node: process.versions.node,
      ...STAGING, maxSeconds: config.maxSeconds });
    try { await waitForStart(combined); }
    catch { if (!combined.aborted) throw new Error('remote_start_failed'); }
    if (combined.aborted) { sendMetrics('finished'); return; }
    emit({ type: 'started', runId: config.runId });
    metricsTimer = setInterval(() => sendMetrics('metrics'), metricsIntervalMs);
    await Promise.all([loop(() => worker.batch(combined), 500, 'batch_retry'),
      loop(() => worker.cleanup(combined), 1000, 'maintenance_retry')]);
    sendMetrics('finished');
  } finally { stop.abort(); clearTimeout(timer); clearInterval(metricsTimer); }
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('remote_node_version');
  const stop = new AbortController();
  let startRequested = false, resolveStart;
  const startRequest = new Promise(resolve => { resolveStart = resolve; });
  let forceTimer;
  const halt = () => {
    stop.abort();
    forceTimer ||= setTimeout(() => process.exit(1), 25000);
    forceTimer.unref();
  };
  process.once('SIGTERM', halt); process.once('SIGINT', halt);
  process.stdin.once('end', halt); process.stdin.once('error', halt);
  process.stdout.on('error', halt);
  try {
    const config = await new Promise((resolveConfig, reject) => {
      let buffer = '';
      const timer = setTimeout(() => fail(), 10000);
      const fail = () => { clearTimeout(timer); process.stdin.off('data', read); reject(new Error('remote_configuration_rejected')); };
      const read = chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 65536) return fail();
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        process.stdin.off('data', read); clearTimeout(timer);
        if (buffer.slice(newline + 1).trim()) return fail();
        try { resolveConfig(JSON.parse(buffer.slice(0, newline))); } catch { fail(); }
        buffer = '';
        // Only a single non-secret start command is accepted after configuration.
        let commandBuffer = '';
        process.stdin.on('data', chunk => {
          commandBuffer += chunk;
          if (Buffer.byteLength(commandBuffer) > 128) return halt();
          if (!commandBuffer.includes('\n')) return;
          try {
            const command = JSON.parse(commandBuffer.trim());
            if (startRequested || command.type !== 'start' || Object.keys(command).length !== 1) return halt();
            startRequested = true; commandBuffer = ''; resolveStart();
          } catch { halt(); }
        });
      };
      process.stdin.setEncoding('utf8'); process.stdin.on('data', read);
    });
    await runRemoteWorker(config, { signal: stop.signal, emit: item => process.stdout.write(`${JSON.stringify(item)}\n`),
      waitForStart: signal => new Promise((resolveStartWait, reject) => {
        const abort = () => reject(new Error('remote_start_aborted'));
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
        startRequest.then(() => { signal.removeEventListener('abort', abort); resolveStartWait(); });
      }) });
  } finally {
    clearTimeout(forceTimer); process.stdin.destroy();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.stdout.write('{"type":"error","code":"remote_worker_failed"}\n'); process.exitCode = 1; });
}
