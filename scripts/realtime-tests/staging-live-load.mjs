// Explicit, bounded staging-only network test. Does not verify native rendering.
// Never run concurrently with another staging smoke/test or a human test session.
// macOS: use ulimit -n 16384 for the explicitly approved 2400-session profile.
import { readFile, writeFile, mkdtemp, rm, rename } from 'node:fs/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { googleAccessToken, customToken } from '../../supabase/functions/_shared/realtime.mjs';
import { LiveWorker } from './live-worker.mjs';
import { createTokenEndpointLimiter, createLoadActorAuth } from './staging-load-auth.mjs';
import { StagingAuthRateOverride } from './staging-auth-rate.mjs';
import { discoverOwnedLoadUsers, withVerifiedLoadCleanup } from './staging-load-cleanup.mjs';
import { startRemoteWorker } from './staging-remote-worker-session.mjs';
import { StagingEdgeSession } from './staging-edge-session.mjs';
import { LoadConnectionDiagnostics } from './staging-connection-diagnostics.mjs';
import { LoadSnapshotRecovery } from './staging-snapshot-recovery.mjs';
import { createStagingManagementQuery, createStagingManagementToken, safeCLIError, edgeDeploymentMetadata } from './staging-management.mjs';
import { createStagingLoadObserver } from './staging-load-observer.mjs';
import { StagingServerTiming } from './staging-server-timing.mjs';
import { RpcObservation, OBSERVED_RPCS, directDatabaseObservation } from './staging-rpc-observation.mjs';
import { parsePostgrestServerTiming } from '../../supabase/functions/_shared/realtime-server-timing.mjs';
import { validateLoadLease, renewLoadSession, loadAuthorizationDeadline, createLoadAuthorizationTimer } from './staging-load-session.mjs';
import { createLoadRenewalScheduler } from './staging-load-renewal.mjs';
import { loadOptions, LoadBudget, LoadTraffic, parallelMap, quantiles, EventStreamParser, firebaseRedirect, providerErrorCode, deleteOwnedFirebaseUser, workloadKind, TypingActivityPolicy, typingActivityTrace, simulateTypingActivity, requireDirectCapability, requirePublisherWakeCapability, directEventBody, directEventTimings, deliveryLatencyGate, practicalDeliveryLatencyGate } from './staging-load-core.mjs';

// Recovery changes receiver continuity only. Producers never replay transient actions.
export function recoverableStreamFailure(error) {
  return ['sse_ended', 'sse_network_error', 'sse_open_timeout', 'sse_initial_timeout', 'sse_closed_before_initial']
    .includes(error?.message) || /^sse_http_(408|429|5[0-9]{2})$/.test(error?.message ?? '');
}

// Only known transport metadata is retained; never messages, URLs or response bodies.
export function backgroundErrorSummary(error) {
  if (error instanceof LoadPreparationError) {
    const { name, code, causeCode } = error.detail;
    return { name, code, causeCode };
  }
  const names = ['Error', 'TypeError', 'TimeoutError', 'AbortError', 'SyntaxError'];
  const causes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN',
    'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'];
  const known = ['management_timeout', 'management_network_failed', 'management_response_read_failed',
    'management_response_invalid', 'management_response_limit', 'download_budget', 'action_budget',
    'invalid_byte_count', 'invalid_worker_byte_counter', 'renewal_identity_changed', 'invalid_load_lease',
    'invalid_bootstrap', 'renewal_stream_expired', 'renewal_not_extended', 'token_rollover_required', 'sse_authorization_expired', 'sse_permission_revoked', 'sse_network_error', 'sse_open_timeout', 'sse_initial_timeout',
    'sse_ended', 'sse_closed_before_initial', 'sse_invalid_content_type', 'unexpected_cursor_reset', 'reconcile_page_limit',
    'firebase_token_missing', 'firebase_token_expiry_invalid', 'firebase_identity_mismatch', 'supabase_session_mismatch',
    'preparation_stopped', 'preparation_already_started'];
  const message = error?.message ?? '';
  const http = /^(management_http_|direct_event_http_|sse_http_|http_)([1-5][0-9]{2})(?::[A-Za-z0-9_]+)?$/.exec(message);
  return { name: names.includes(error?.name) ? error.name : 'Error',
    code: http ? `${http[1]}${http[2]}` : known.includes(message) ? message
      : error?.name === 'TypeError' && message === 'fetch failed' ? 'network_failed'
      : error?.name === 'TimeoutError' ? 'request_timeout' : 'background_error',
    causeCode: causes.includes(error?.cause?.code) ? error.cause.code
      : causes.includes(error?.code) ? error.code : null };
}

class LoadPreparationError extends Error {
  constructor(detail) {
    super(`preparation_${detail.substep}_${detail.code}`);
    this.detail = { ...detail };
  }
}
export function loadFailureSummary(error) {
  return { code: safeCode(error), detail: backgroundErrorSummary(error),
    ...(error instanceof LoadPreparationError ? { preparation: { ...error.detail } } : {}) };
}
function preparationTransportFailure(error) {
  const detail = backgroundErrorSummary(error);
  // A provider HTTP response (including 429/5xx), authorization rejection or
  // malformed data is not a transport failure and must not be worked around.
  if (/^(?:management_http_|direct_event_http_|sse_http_|http_)/.test(detail.code)) return false;
  return ['network_failed', 'request_timeout'].includes(detail.code)
    || (detail.causeCode !== null && ['Error', 'TypeError'].includes(detail.name));
}

// Initial ramp only. No event/message publication is accepted here. Credential
// retries always acquire a new bootstrap token; after SSE opens, only the same
// actor/session's idempotent initial presence PUT may be retried.
export async function prepareLoadActor(user, { bootstrap, validate, login, cursor, open, presence },
  { actorIndex, roomIndex, record, sleep, stopping = () => false, now = Date.now }) {
  if (![actorIndex, roomIndex].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('invalid_preparation_ordinal');
  if (user.preparationStarted || user.stream || user.ready) throw new Error('preparation_already_started');
  user.preparationStarted = true;
  const ensureRunning = () => { if (stopping()) throw new Error('preparation_stopped'); };
  const failed = (error, substep, attempt) => {
    const detail = { actorIndex, roomIndex, substep, attempt, ...backgroundErrorSummary(error) };
    record({ ...detail });
    return new LoadPreparationError(detail);
  };
  const pause = async (ms, detail) => {
    try { await sleep(ms); }
    catch (error) { throw new LoadPreparationError({ ...detail, ...backgroundErrorSummary(error) }); }
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    let substep = 'bootstrap';
    try {
      ensureRunning();
      const requestedAt = now(), value = await bootstrap(user);
      ensureRunning();
      Object.assign(user, validate(value, user, requestedAt));
      substep = 'firebase_auth';
      await login(user, value.customToken);
      ensureRunning();
      break;
    } catch (error) {
      const failure = failed(error, substep, attempt);
      if (stopping() || !preparationTransportFailure(error) || attempt === 3) throw failure;
      await pause(250 * attempt, failure.detail);
    }
  }
  const step = async (substep, operation, attempts = 3) => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        ensureRunning();
        const result = await operation();
        ensureRunning();
        return result;
      } catch (error) {
        const failure = failed(error, substep, attempt);
        if (stopping() || !preparationTransportFailure(error) || attempt === attempts) throw failure;
        await pause(250 * attempt, failure.detail);
      }
    }
  };
  const initial = await step('cursor', () => cursor(user)); user.cursor = initial.cursor;
  user.stream = await step('sse', () => open(user), 1);
  await step('presence', async () => {
    if (user.stream.closed) throw new Error('sse_ended');
    await presence(user);
    if (user.stream.closed) throw new Error('sse_ended');
  });
  if (user.stream.closed) throw failed(new Error('sse_ended'), 'sse', 1);
  user.ready = true;
}

export function transientLoadFailure(error) {
  const detail = backgroundErrorSummary(error);
  return ['network_failed', 'request_timeout', 'management_timeout', 'management_network_failed',
    'management_response_read_failed'].includes(detail.code)
    || /^(management_http_|http_)(408|429|5[0-9]{2})$/.test(detail.code);
}

// Call only for durable reads and the same identity's lease renewal. Never wrap
// send_message or transient event publication: either may have committed already.
export async function retryTransientLoadOperation(role, operation, { record, sleep,
  stopping = () => false, attempts = 3 }) {
  if (!['reconcile', 'renewal'].includes(role) || !Number.isInteger(attempts) || attempts < 1 || attempts > 3) {
    throw new Error('invalid_load_recovery');
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (stopping()) throw new Error('load_recovery_stopped');
    try {
      const value = await operation();
      if (stopping()) throw new Error('load_recovery_stopped');
      return value;
    } catch (error) {
      if (stopping()) throw error;
      record({ role, attempt, ...backgroundErrorSummary(error) });
      if (!(transientLoadFailure(error) || (role === 'renewal' && recoverableStreamFailure(error)))
          || attempt === attempts) throw error;
      await sleep(250 * attempt);
    }
  }
}

export async function renewLoadSessionWithRecovery(user, operations, recovery) {
  const originalDueAt = user.renewAt;
  return retryTransientLoadOperation('renewal', async () => {
    try { return await renewLoadSession(user, operations); }
    catch (error) {
      // A lost bootstrap response may have extended the server lease. Keep the
      // existing stream and credential deadline; only a validated response can
      // extend local authorization. Never replay an outgoing ephemeral event.
      user.renewAt = originalDueAt;
      throw error;
    }
  }, recovery);
}

export function createBackgroundPolicy({ record, onFatal, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, stopping = () => false }) {
  let queueFailures = 0, queueSince, queueTimer;
  const resetQueue = () => { queueFailures = 0; queueSince = undefined; clearTimer(queueTimer); queueTimer = undefined; };
  return {
    dispose: resetQueue,
    async attempt(role, operation) {
      try {
        await operation();
        if (role === 'queue') resetQueue();
        return true;
      } catch (error) {
        if (stopping()) throw error;
        const detail = backgroundErrorSummary(error);
        record({ role, ...detail });
        const transient = transientLoadFailure(error);
        if (role === 'presence' && transient) return false; // Next regular heartbeat only; no retry.
        if (role === 'queue' && transient) {
          queueFailures++;
          if (queueSince === undefined) {
            queueSince = now();
            queueTimer = setTimer(() => { if (!stopping()) onFatal('queue_observation_unavailable'); }, 60000);
            queueTimer?.unref?.();
          }
          if (queueFailures < 3 && now() - queueSince < 60000) return false;
          resetQueue();
          onFatal('queue_observation_unavailable');
          throw new Error('queue_observation_unavailable');
        }
        // Renewal, publication, reconciliation, authorization and safety failures
        // cannot be skipped: their required state or ownership may have changed.
        throw error;
      }
    },
  };
}

export function loadQualityVerdicts(metrics) {
  return { streamIntegrityVerdict: metrics.streamUnexpectedClose === 0 ? 'PASS' : 'FAIL',
    preparationIntegrityVerdict: (metrics.preparationFailures ?? 0) === 0 ? 'PASS' : 'FAIL',
    backgroundIntegrityVerdict: (metrics.backgroundFailures ?? 0) === 0 ? 'PASS' : 'FAIL',
    directDeliveryVerdict: (metrics.directFunctionFailures ?? 0) === 0 ? 'PASS' : 'FAIL',
    wakeDeliveryVerdict: (metrics.wakeFunctionFailures ?? 0) === 0 ? 'PASS' : 'FAIL',
    latencyGate: deliveryLatencyGate(metrics.remoteLatencyByKind),
    practicalLatencyGate: practicalDeliveryLatencyGate(metrics.remoteLatencyByKind) };
}

// A rejected transient event is never replayed. Keep the normal-network run
// failed, but observe later independent events for the full bounded duration.
export async function attemptDirectLoadEvent(operation, onFailure, { stopping = () => false } = {}) {
  try { await operation(); return true; }
  catch (error) {
    onFailure(error);
    if (!stopping() && (transientLoadFailure(error) || /^direct_event_http_(408|429|5[0-9]{2})$/.test(error?.message ?? ''))) return false;
    throw error;
  }
}

export async function recoverLoadStream({ user, open, presence, reconcile, sleep, stopping = () => false,
  onAttempt = () => {}, onSuccess = () => {}, onFailure = () => {}, maxAttempts = 3, maxTotalAttempts = 12 }) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (stopping()) return false;
    if ((user.streamRecoveryAttempts ?? 0) >= maxTotalAttempts) throw new Error('stream_recovery_budget_exhausted');
    await sleep(250 * (2 ** attempt));
    if (stopping()) return false;
    user.streamRecoveryAttempts = (user.streamRecoveryAttempts ?? 0) + 1; onAttempt();
    let candidate;
    try {
      candidate = await open(user);
      if (stopping()) { await candidate.close(); return false; }
      if (candidate.closed) throw new Error('sse_ended');
      user.stream = candidate;
      await presence(user);
      await reconcile(user);
      if (candidate.closed) throw new Error('sse_ended');
      onSuccess(); return true;
    } catch (error) {
      try { onFailure(error)?.catch?.(() => {}); } catch { /* Observation cannot change recovery. */ }
      await candidate?.close();
      if (stopping()) return false;
      if (!recoverableStreamFailure(error)) throw error;
    }
  }
  throw new Error('stream_reconnect_exhausted');
}

const ref = 'fjglrvhvdthntkvrduyi', project = 'sidey-realtime-staging';
const base = `https://${ref}.supabase.co`;
const database = `https://${project}-default-rtdb.asia-southeast1.firebasedatabase.app`;
const firebaseAPIKey = process.env.SIDEY_FIREBASE_STAGING_WEB_API_KEY;
const root = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile), startedAt = Date.now(), runId = randomUUID();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
function check(condition, code = 'validation_failed') { if (!condition) throw new Error(code); }
const stop = new AbortController(), workerStop = new AbortController();
let stage = 'explicit_staging_guard', stopReason, options, budget, adminKey, anonKey, account, googleToken, googleAt = 0;
let cleanupAllowed = false, recoveryDirectory, originalSecrets, activeTimer, totalTimer, preparationTimer, workerLoops = [], closing = false, remoteWorker, edgePublisher, publisherStopped = true;
let journalWrites = Promise.resolve(), tokenLimiter, authRate, authPreparationFinished = false;
let traffic, edgeObservation = Promise.resolve(), directSecretsMayBeChanged = false;
let loadObserver, observationStop, serverTimingSetting, renewalScheduler;
const rpcObservation = new RpcObservation();
function stopObservation() {
  // Stop scheduling immediately. Never give delivery or renewal extra grace by
  // blocking on remote diagnostics before the normal workload/drain boundary.
  if (loadObserver && !observationStop) observationStop = loadObserver.stop().catch(() => ({ status: 'UNAVAILABLE', code: 'observer_stop_failed' }));
}
const users = [], rooms = [], streams = [], expected = new Map(), reconcileWork = new Set(), streamRecoveryWork = new Set(), wakeWork = new Set(), cleanupFailures = [];
const metrics = { runId, usersRequested: 0, connectionsCurrent: 0, connectionsPeak: 0, connectionsOpened: 0,
  preparationFailures: 0, preparationFailuresByStep: {}, preparationErrorSamples: [],
  preparationRecoveryLimits: { credentialAttempts: 3, cursorAttempts: 3, sseAttempts: 1, presenceAttempts: 3,
    retryDelaysMs: [250, 500], policy: 'Transport failures only; every failed preparation attempt remains reported. No HTTP-response retries, no whole-actor replay after SSE, no message/event retries.' },
  backgroundFailures: 0, backgroundFailuresByRole: {}, backgroundErrorCounts: {}, backgroundErrorSamples: [],
  backgroundRecoveryLimits: { queueConsecutiveFailures: 3, queueUnavailableMs: 60000, presence: 'next scheduled 45-second heartbeat only', reconcileAttempts: 3, renewalAttempts: 3, retryDelaysMs: [250, 500] },
  streamUnexpectedClose: 0, streamReconnectAttempts: 0, streamReconnectSucceeded: 0, streamReconnectFailures: 0,
  streamInterruptionReasons: {}, streamRecoveryLimits: { perInterruption: 3, perUserRun: 12 }, httpRequests: 0, httpErrors: {}, worker: {}, accepted: {}, received: {}, expiredDeliveries: 0,
  messagePayloadFailures: 0, duplicateDeliveries: 0, recoverySnapshotDeliveries: {}, presenceWrites: 0, presenceFanoutVerified: false, queue: [], checkpoints: [],
  latency: { bootstrap: [], renewal: [], action: [], message: [], ephemeral: [] }, nativeRenderingVerified: false,
  latencyByKind: {}, remoteLatencyByKind: {},
  messageStages: { notification: [], fetch: [] }, directStages: {}, directFunctionCalls: 0, directFunctionResponses: 0, directFunctionFailures: 0,
  wakeFunctionCalls: 0, wakeFunctionResponses: 0, wakeFunctionFailures: 0, wakeErrors: {}, wakeNoopReasons: {},
  directCallCountNote: 'Calls are client attempts; responses confirm handler execution. Neither is a provider-billed invocation count.',
  directTimingNote: 'RTT minus handler time combines network transit, provider queue/cold work and measurement error. Pure pre-execution wait is unavailable without provider timestamps.',
  leaseRenewalVerified: false, transport: 'REST SSE; native apps not exercised',
  workload: 'audited event proportions, rotating sender per room, at most one action every 2 seconds per room; presence every 45 seconds; actual offered rate is measured',
  billingNote: 'Observed decoded HTTP body bytes are not billable bytes. TLS/protocol overhead, billing lag, other project usage and non-Firebase charges are excluded; this is not a monetary cap.' };
let connectionDiagnostics = new LoadConnectionDiagnostics({ emit: sample => console.log(`STREAM_DIAGNOSTIC ${JSON.stringify(sample)}`) });
metrics.connectionDiagnostics = connectionDiagnostics.report;
const connectionOrdinal = user => ({ userIndex: users.indexOf(user), roomIndex: rooms.indexOf(user.room) });
const connectionRemaining = (user, at) => ({ leaseRemainingMs: user.leaseAuthorizationExpiresAt - at,
  idTokenRemainingMs: user.firebaseTokenExpiresAt - at, renewing: user.renewing === true });
const count = (object, name) => { object[name] = (object[name] || 0) + 1; };
function abort(reason) { if (!stop.signal.aborted) { stopReason = reason; stop.abort(new Error(reason)); } }

function recordBackgroundFailure(detail) {
  metrics.backgroundFailures++; count(metrics.backgroundFailuresByRole, detail.role);
  count(metrics.backgroundErrorCounts, `${detail.role}:${detail.name}:${detail.code}:${detail.causeCode ?? 'none'}`);
  const sample = { elapsedMs: Date.now() - startedAt, ...detail };
  if (metrics.backgroundErrorSamples.length < 100) metrics.backgroundErrorSamples.push(sample);
  console.log(`BACKGROUND_FAILURE ${JSON.stringify(sample)}`);
}
function recordPreparationFailure(detail) {
  metrics.preparationFailures++; count(metrics.preparationFailuresByStep, detail.substep);
  const sample = { elapsedMs: Date.now() - startedAt, ...detail };
  if (metrics.preparationErrorSamples.length < 100) metrics.preparationErrorSamples.push(sample);
  console.log(`PREPARATION_FAILURE ${JSON.stringify(sample)}`);
}
const loadStopping = () => closing || stop.signal.aborted || workerStop.signal.aborted;
const backgroundPolicy = createBackgroundPolicy({ stopping: loadStopping, onFatal: abort, record: recordBackgroundFailure });
const boundedRecovery = { stopping: loadStopping, record: recordBackgroundFailure,
  sleep: ms => delay(ms, undefined, { signal: AbortSignal.any([stop.signal, workerStop.signal]) }) };

function mark(name) { stage = name; console.log(`STEP ${name} elapsed_ms=${Date.now() - startedAt}`); }
function safeCode(error) { return /^[a-zA-Z0-9_:-]{1,80}$/.test(error?.message || '') ? error.message : 'request_failed'; }
async function cli(args) {
  try { return (await execute('supabase', args, { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) { throw safeCLIError(error); }
}
const query = createStagingManagementQuery();
async function secrets() {
  const rows = JSON.parse(await cli(['secrets', 'list', '--project-ref', ref, '--output', 'json']));
  check(Array.isArray(rows)); return new Map(rows.map(row => [row.name, row.value]));
}
async function setSecrets(values) {
  const directory = await mkdtemp(join(tmpdir(), 'sidey-load-secrets-'));
  try {
    const file = join(directory, 'secrets.env');
    await writeFile(file, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
    await cli(['secrets', 'set', '--project-ref', ref, '--env-file', file]);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function journal() {
  // IDs and generated test emails only. Passwords, tokens and invite codes never reach disk.
  journalWrites = journalWrites.then(async () => {
    const snapshot = { runId, project, supabaseRef: ref, createdAt: new Date(startedAt).toISOString(),
      users: users.map(user => ({ email: user.email, id: user.id, firebaseAttempted: !!user.firebaseAttempted })),
      roomIds: rooms.map(room => room.id), ...(authRate ? { authRate: authRate.snapshot() } : {}),
      ...(serverTimingSetting ? { serverTiming: serverTimingSetting.snapshot() } : {}) };
    const file = join(recoveryDirectory, 'synthetic-identifiers.json');
    await writeFile(file + '.tmp', JSON.stringify(snapshot), { mode: 0o600 }); await rename(file + '.tmp', file);
  });
  await journalWrites;
}
async function accessToken() {
  if (!googleToken || Date.now() - googleAt > 240000) {
    googleAt = Date.now();
    googleToken = googleAccessToken(account).catch(error => { googleToken = undefined; googleAt = 0; throw error; });
  }
  return googleToken;
}
async function measuredFetch(url, init = {}, cleanup = false, sse = false) {
  if (!cleanup) stop.signal.throwIfAborted();
  const signals = sse ? [] : [AbortSignal.timeout(15000)];
  if (!cleanup) signals.push(stop.signal);
  if (init.signal) signals.push(init.signal);
  const target = new URL(url);
  const rpcName = target.origin === base && target.pathname.startsWith('/rest/v1/rpc/')
    ? target.pathname.slice('/rest/v1/rpc/'.length) : undefined;
  const observe = options?.observe && !cleanup && metrics.holdStartedAt && !metrics.measurementEndISO && OBSERVED_RPCS.has(rpcName);
  const requestStarted = performance.now();
  let response, headersMs, bodyMs, serverTiming, observationFailure;
  const regionalFunction = target.origin === base && /^\/functions\/v1\/(realtime-event(?:\/wake)?|realtime-wake|realtime-bootstrap)$/.test(target.pathname);
  const headers = new Headers(init.headers);
  if (regionalFunction && options?.edgeRegion) headers.set('x-region', options.edgeRegion);
  try {
    response = await fetch(url, { ...init, headers, redirect: init.redirect || 'error', signal: AbortSignal.any(signals) });
    headersMs = performance.now() - requestStarted;
    if (observe) serverTiming = parsePostgrestServerTiming(response.headers.get('server-timing'));
    if (regionalFunction) {
      const actual = response.headers.get('x-sb-edge-region');
      metrics.edgeRegions ||= {};
      count(metrics.edgeRegions, `${target.pathname.slice('/functions/v1/'.length)}:${/^[a-z]+-[a-z]+-[0-9]$/.test(actual ?? '') ? actual : 'unverified'}`);
      if (response.ok && options?.edgeRegion && actual !== options.edgeRegion) {
        await response.body?.cancel(); throw new Error('edge_region_not_verified');
      }
    }
    metrics.httpRequests++;
    if (!response.ok && response.status !== 307) count(metrics.httpErrors, String(response.status));
    if (sse) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    bodyMs = performance.now() - requestStarted - headersMs;
    if (!cleanup) {
      traffic.addGenerator(bytes.length);
      const host = new URL(url).hostname;
      const component = host.endsWith('.supabase.co') ? 'supabase' : host.endsWith('.googleapis.com') ? 'google_auth' : 'firebase_rtdb';
      metrics.downloadBytesByComponent ||= {}; metrics.downloadBytesByComponent[component] = (metrics.downloadBytesByComponent[component] || 0) + bytes.length;
    }
    else metrics.cleanupBytes = (metrics.cleanupBytes || 0) + bytes.length;
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, headers: response.headers });
  } catch (error) {
    observationFailure = stop.signal.aborted ? 'stopped' : error?.name === 'TimeoutError' ? 'timeout'
      : response ? 'body' : error?.name === 'TypeError' ? 'transport' : 'other';
    throw error;
  } finally {
    if (observe) rpcObservation.record({ name: rpcName, status: response?.status, headersMs, bodyMs,
      totalMs: performance.now() - requestStarted, serverTiming, failure: observationFailure });
  }
}
async function request(url, init = {}, expectedStatus = [200], cleanup = false) {
  const response = await measuredFetch(url, init, cleanup);
  const text = await response.text();
  if (!expectedStatus.includes(response.status)) {
    const code = providerErrorCode(text);
    throw new Error(`http_${response.status}${code ? `:${code}` : ''}`);
  }
  return text ? JSON.parse(text) : null;
}
function sb(path, token = adminKey, init = {}, cleanup = false) {
  return request(`${base}${path}`, { ...init, headers: { apikey: anonKey, authorization: `Bearer ${token}`,
    'content-type': 'application/json', ...init.headers } }, [200, 201, 204], cleanup);
}
const rpc = (name, token, body, signal) => sb(`/rest/v1/rpc/${name}`, token, { method: 'POST', body: JSON.stringify(body), signal });
async function fb(path, { token, method = 'GET', body, cleanup = false } = {}) {
  const url = new URL(`${database}/${path}.json`); if (token) url.searchParams.set('auth', token);
  return request(url, { method, headers: { 'content-type': 'application/json', ...(token ? {} : { authorization: `Bearer ${await accessToken()}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, [200], cleanup);
}
async function firebaseLogin(user, token, cleanup = false) {
  user.firebaseAttempted = true; await journal();
  const tokenRequestedAt = Date.now();
  const result = await request(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${firebaseAPIKey}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, returnSecureToken: true }) }, [200], cleanup);
  check(typeof result.idToken === 'string', 'firebase_token_missing');
  // Store first, so a failed identity lookup still leaves a usable cleanup credential.
  user.firebaseToken = result.idToken;
  const tokenSeconds = Number(result.expiresIn);
  check(Number.isSafeInteger(tokenSeconds) && tokenSeconds > 0 && tokenSeconds <= 3600, 'firebase_token_expiry_invalid');
  user.firebaseTokenExpiresAt = tokenRequestedAt + tokenSeconds * 1000;
  const identity = await request(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${firebaseAPIKey}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: result.idToken }) }, [200], cleanup);
  check(identity.users?.length === 1 && identity.users[0].localId === user.id && identity.users[0].disabled !== true, 'firebase_identity_mismatch');
}
function received(id, user, kind, payload, initialSnapshot = false) {
  const item = expected.get(id);
  if (!item || !item.recipients.has(user.id) || item.kind !== kind) return;
  if (kind === 'message' && payload !== item.body) { metrics.messagePayloadFailures++; abort('message_payload_mismatch'); return; }
  if (item.received.has(user.id)) {
    if (initialSnapshot) count(metrics, 'snapshotReplaysIgnored'); else metrics.duplicateDeliveries++;
    return;
  }
  item.received.add(user.id); count(metrics.received, kind);
  const elapsed = Date.now() - item.started;
  if (kind === 'message' && user.id !== item.senderID) (item.remoteLatencies ||= []).push(elapsed);
  metrics.latency[kind === 'message' ? 'message' : 'ephemeral'].push(elapsed);
  (metrics.latencyByKind[kind] ||= []).push(elapsed);
  if (user.id !== item.senderID) (metrics.remoteLatencyByKind[kind] ||= []).push(elapsed);
  return true;
}
function reconcile(user) {
  user.dirty = true;
  if (user.reconciling || closing || stop.signal.aborted) return user.reconcileWork;
  const work = (async () => {
    user.reconciling = true;
    try {
      await retryTransientLoadOperation('reconcile', async () => {
        user.dirty = true;
        while (user.dirty && !closing && !stop.signal.aborted) {
          user.dirty = false;
          for (let page = 0; page < 20; page++) {
            const fetchStarted = Date.now();
            await ensureAuth(user);
            const changes = await rpc('firebase_realtime_changes', user.token,
              { p_room_id: user.room.id, p_after_revision: user.cursor, p_limit: 100 });
            check(changes.resetRequired === false && Array.isArray(changes.changes), 'unexpected_cursor_reset');
            for (const change of changes.changes) if (change.operation === 'INSERT') {
              const item = expected.get(change.messageId), notifiedAt = user.hintArrival?.get(change.revision);
              if (item?.kind === 'message' && !item.received.has(user.id)) {
                metrics.messageStages.fetch.push(Date.now() - fetchStarted);
                if (notifiedAt !== undefined) metrics.messageStages.notification.push(notifiedAt - item.started);
              }
              received(change.messageId, user, 'message', change.message?.body);
            }
            user.cursor = changes.cursor;
            if (changes.changes.length < 100) break;
            if (page === 19) throw new Error('reconcile_page_limit');
          }
        }
      }, boundedRecovery);
    } catch (error) {
      if (!closing && !stop.signal.aborted) {
        abort(`reconcile_${backgroundErrorSummary(error).code}`);
      }
    }
    finally { user.reconciling = false; }
  })();
  reconcileWork.add(work); void work.finally(() => reconcileWork.delete(work));
  user.reconcileWork = work; return work;
}
function inspectUpdate(user, value, initialSnapshot = false, recoveryTicket) {
  if (!value || typeof value !== 'object') return;
  if (value.kind === 'message_changed') {
    // Only exact matching revisions establish notification latency; a newer
    // collapsed hint must not be attributed to every message returned by reconciliation.
    if (!initialSnapshot && typeof value.revision === 'string') {
      user.hintArrival ||= new Map();
      if (!user.hintArrival.has(value.revision)) user.hintArrival.set(value.revision, Date.now());
      if (user.hintArrival.size > 200) user.hintArrival.delete(user.hintArrival.keys().next().value);
    }
    reconcile(user);
  }
  if (['typing_start', 'typing_stop', 'character_pulse', 'character_throw'].includes(value.kind) && value.payload?.event_id) {
    // The first subscription seeds suppressed UUIDs. Only the same authorized
    // scope may recover unseen, still-valid effects from a reconnect snapshot.
    const allowed = user.snapshotRecovery.allow(recoveryTicket, value,
      { initial: initialSnapshot, now: Date.now() + user.serverClockOffset });
    if (value.expiresAt <= Math.max(Date.now() + user.serverClockOffset, user.snapshotRecovery.nowHighWater)) {
      if (!initialSnapshot) metrics.expiredDeliveries++;
      return;
    }
    if (!allowed) return;
    const delivered = received(value.payload.event_id, user, value.kind, undefined, initialSnapshot);
    if (delivered && initialSnapshot && recoveryTicket.recovery
        && ['character_pulse', 'character_throw'].includes(value.kind)) count(metrics.recoverySnapshotDeliveries, value.kind);
  }
  for (const child of Object.values(value)) if (child && typeof child === 'object') inspectUpdate(user, child, initialSnapshot, recoveryTicket);
}
function inspectPresence(user, value, path) {
  if (path[0] === 'presence' && path.length === 3 && uuid.test(path[1]) && uuid.test(path[2])) {
    user.presenceSeen ||= new Map();
    if (value === null) user.presenceSeen.delete(path[1]);
    else if (typeof value?.updatedAt === 'number' && typeof value?.active === 'boolean') user.presenceSeen.set(path[1], value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) inspectPresence(user, child, [...path, key]);
}
function scheduleStreamRecovery(user, failedStream) {
  if (user.reconnectWork || closing || stop.signal.aborted) return;
  user.reconnecting = true;
  let reconnectStartedAt;
  const work = Promise.resolve().then(async () => {
    try {
      // An in-progress lease renewal owns the replacement stream. Never race it.
      await user.renewalWork;
      if (closing || stop.signal.aborted || user.stream !== failedStream) return;
      await recoverLoadStream({ user, open: openStream,
        presence: value => backgroundPolicy.attempt('presence', () => presence(value)), reconcile,
        sleep: ms => delay(ms, undefined, { signal: AbortSignal.any([stop.signal, workerStop.signal]) }),
        stopping: () => closing || stop.signal.aborted || workerStop.signal.aborted,
        onAttempt: () => {
          metrics.streamReconnectAttempts++; reconnectStartedAt = Date.now();
          connectionDiagnostics.record('reconnect_start', { ...connectionOrdinal(user), attempt: user.streamRecoveryAttempts,
            streamIndex: user.diagnosticStreamCount, ...connectionRemaining(user, reconnectStartedAt) }, reconnectStartedAt);
        },
        onSuccess: () => {
          metrics.streamReconnectSucceeded++; const at = Date.now();
          connectionDiagnostics.record('reconnect_success', { ...connectionOrdinal(user), attempt: user.streamRecoveryAttempts,
            streamIndex: user.diagnosticStreamCount, durationMs: at - reconnectStartedAt, ...connectionRemaining(user, at) }, at);
        },
        onFailure: error => {
          const at = Date.now();
          connectionDiagnostics.record('reconnect_failed', { ...connectionOrdinal(user), attempt: user.streamRecoveryAttempts,
            streamIndex: user.diagnosticStreamCount, durationMs: at - reconnectStartedAt, reason: error?.message,
            final: false, ...connectionRemaining(user, at) }, at);
        } });
    } catch (error) {
      if (!closing && !stop.signal.aborted) {
        const at = Date.now();
        connectionDiagnostics.record('reconnect_failed', { ...connectionOrdinal(user), attempt: user.streamRecoveryAttempts,
          streamIndex: user.diagnosticStreamCount, durationMs: at - reconnectStartedAt, reason: error?.message,
          final: true, ...connectionRemaining(user, at) }, at);
        metrics.streamReconnectFailures++; abort(safeCode(error));
      }
    } finally {
      user.reconnecting = false; user.reconnectWork = undefined;
      // A replacement can close between its final readiness check and this
      // continuation. Do not lose that interruption while recovery is occupied.
      if (user.stream?.closed) scheduleStreamRecovery(user, user.stream);
    }
  });
  user.reconnectWork = work;
  streamRecoveryWork.add(work); void work.finally(() => streamRecoveryWork.delete(work));
}
async function openStream(user) {
  const scope = () => ({ userId: user.id, sessionId: user.sessionId, roomId: user.room.id,
    epoch: user.descriptor.epoch, path: user.descriptor.path });
  user.snapshotRecovery ||= new LoadSnapshotRecovery();
  const recoveryTicket = user.snapshotRecovery.begin(scope());
  const streamIndex = user.diagnosticStreamCount = (user.diagnosticStreamCount ?? -1) + 1;
  const controller = new AbortController();
  const authorizationTimer = createLoadAuthorizationTimer({ user, expire: error => controller.abort(error) });
  const updateAuthorizationDeadline = authorizationTimer.update;
  updateAuthorizationDeadline();
  const url = new URL(`${database}/${user.descriptor.path}.json`); url.searchParams.set('auth', user.firebaseToken);
  let target = url, response;
  const headersTimer = setTimeout(() => controller.abort(new Error('sse_open_timeout')), 15000);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        response = await measuredFetch(target, { headers: { accept: 'text/event-stream' }, redirect: 'manual', signal: controller.signal }, false, true);
      } catch (error) {
        if (stop.signal.aborted) throw error;
        throw new Error(controller.signal.aborted ? 'sse_open_timeout' : 'sse_network_error');
      }
      if (response.status !== 307) break;
      const next = firebaseRedirect(response.headers.get('location'), target); await response.body?.cancel(); target = next;
    }
  } catch (error) { authorizationTimer.cancel(); throw error; }
  finally { clearTimeout(headersTimer); }
  if (response.status !== 200) {
    authorizationTimer.cancel();
    await response.body?.cancel();
    throw new Error([401, 403].includes(response.status) ? 'sse_permission_revoked' : `sse_http_${response.status}`);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    authorizationTimer.cancel();
    await response.body?.cancel(); throw new Error('sse_invalid_content_type');
  }
  const streamOpenedAt = Date.now(); let lastChunkAt, lastDataFrameAt;
  const reader = response.body.getReader(); let initialResolve, initialReject, first = true, intendedClose = false;
  const initial = new Promise((resolve, reject) => { initialResolve = resolve; initialReject = reject; });
  void initial.catch(() => {});
  const timer = setTimeout(() => { initialReject(new Error('sse_initial_timeout')); controller.abort(); }, 15000);
  const parser = new EventStreamParser(event => {
    check(user.snapshotRecovery.current(recoveryTicket, scope()), 'renewal_identity_changed');
    if (['cancel', 'auth_revoked'].includes(event.name)) throw new Error('sse_permission_revoked');
    if (['put', 'patch'].includes(event.name)) {
      lastDataFrameAt = Date.now();
      const initialSnapshot = first;
      if (first && event.name === 'put' && event.data?.path === '/') {
        first = false; clearTimeout(timer);
        metrics.connectionsCurrent++; metrics.connectionsOpened++;
        metrics.connectionsPeak = Math.max(metrics.connectionsPeak, metrics.connectionsCurrent);
        initialResolve();
        connectionDiagnostics.record('stream_open', { ...connectionOrdinal(user), streamIndex,
          streamAgeMs: lastDataFrameAt - streamOpenedAt, ...connectionRemaining(user, lastDataFrameAt) }, lastDataFrameAt);
      }
      inspectUpdate(user, event.data?.data, initialSnapshot, recoveryTicket);
      if (initialSnapshot && !first) user.snapshotRecovery.initializedSnapshot(recoveryTicket);
      inspectPresence(user, event.data?.data, (event.data?.path || '/').split('/').filter(Boolean));
    }
  });
  let failure;
  const pump = (async () => {
    try {
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); } catch {
          throw new Error(controller.signal.reason?.message === 'sse_authorization_expired'
            ? 'sse_authorization_expired' : 'sse_network_error');
        }
        if (Date.now() >= loadAuthorizationDeadline(user)) throw new Error('sse_authorization_expired');
        if (chunk.done) break;
        lastChunkAt = Date.now();
        traffic.addGenerator(chunk.value.byteLength);
        metrics.downloadBytesByComponent ||= {};
        metrics.downloadBytesByComponent.firebase_rtdb = (metrics.downloadBytesByComponent.firebase_rtdb || 0) + chunk.value.byteLength;
        parser.push(chunk.value);
      }
      if (!intendedClose && !closing && !stop.signal.aborted) throw new Error('sse_ended');
    } catch (error) {
      initialReject(error);
      if (!intendedClose && !closing && !stop.signal.aborted) {
        const at = Date.now();
        connectionDiagnostics.record('stream_closed', { ...connectionOrdinal(user), streamIndex,
          streamAgeMs: at - streamOpenedAt, lastChunkAgeMs: lastChunkAt === undefined ? undefined : at - lastChunkAt,
          lastDataFrameAgeMs: lastDataFrameAt === undefined ? undefined : at - lastDataFrameAt,
          reason: error?.message, ...connectionRemaining(user, at) }, at);
        failure = error; metrics.streamUnexpectedClose++; count(metrics.streamInterruptionReasons, safeCode(error));
        if (!recoverableStreamFailure(error) || !user.ready) abort(safeCode(error));
      }
    } finally {
      authorizationTimer.cancel(); clearTimeout(timer); initialReject(new Error('sse_closed_before_initial'));
      stream.closed = true;
      if (!first) metrics.connectionsCurrent--;
      await reader.cancel().catch(() => {});
      // Schedule only after the old pump fully settles, so connection counters
      // and cleanup never race an old stream or its new replacement.
      if (failure && recoverableStreamFailure(failure) && user.ready) scheduleStreamRecovery(user, stream);
    }
  })();
  const stream = { closed: false, diagnosticIndex: streamIndex, updateAuthorizationDeadline, async close() { intendedClose = true; authorizationTimer.cancel(); controller.abort(); await reader.cancel().catch(() => {}); await pump; } };
  streams.push(stream); await initial; return stream;
}
async function presence(user) {
  if (closing) return;
  await fb(`${user.descriptor.path}/presence/${user.id}/${user.sessionId}`, { token: user.firebaseToken, method: 'PUT',
    body: { state: 'online', active: true, updatedAt: { '.sv': 'timestamp' } } });
  metrics.presenceWrites++;
}
async function ensureAuth(user, requiredValidityMs = 60000) {
  if (!user.auth) return;
  const value = await user.auth.credentials({ signal: stop.signal, requiredValidityMs });
  check(value.userId === user.id, 'supabase_session_mismatch');
  user.token = value.accessToken;
}
const bootstrapUser = async user => {
  await ensureAuth(user);
  return sb('/functions/v1/realtime-bootstrap', user.token,
    { method: 'POST', body: '{"protocolVersion":2}' });
};
function validateLease(value, user, requestedAt = Date.now()) {
  if (options.directEvents) { requireDirectCapability(value); requirePublisherWakeCapability(value, 'realtime-event/wake'); }
  if (options.edgeRegion && options.directEvents) check(
    value.directEvents.region === options.edgeRegion && value.publisherWake.region === options.edgeRegion, 'regional_capability_missing');
  return { ...validateLoadLease(value, { user, database, apiKey: firebaseAPIKey, requestStartedAt: requestedAt }),
    ...(options.directEvents ? { publisherWakeEndpoint: requirePublisherWakeCapability(value, 'realtime-event/wake') } : {}) };
}
async function renewUser(user) {
  const at = Date.now(), oldLeaseDeadline = user.leaseAuthorizationExpiresAt;
  metrics.renewalQueueDelayMaxMs = Math.max(metrics.renewalQueueDelayMaxMs || 0, at - user.renewAt);
  user.renewalWork = renewLoadSessionWithRecovery(user, { bootstrap: bootstrapUser, validate: validateLease }, boundedRecovery);
  try {
    if (await user.renewalWork) {
      count(metrics, 'leaseRenewals'); metrics.latency.renewal.push(Date.now() - at);
      const completedAt = Date.now();
      connectionDiagnostics.record('renewal_success', { ...connectionOrdinal(user), streamIndex: user.stream?.diagnosticIndex,
        durationMs: completedAt - at, oldLeaseRemainingMs: oldLeaseDeadline - completedAt,
        newLeaseRemainingMs: user.leaseAuthorizationExpiresAt - completedAt, ...connectionRemaining(user, completedAt) }, completedAt);
    }
  } finally { user.renewalWork = undefined; }
}
async function provision(user, index) {
  stop.signal.throwIfAborted(); await journal();
  const created = await sb('/auth/v1/admin/users', adminKey, { method: 'POST',
    body: JSON.stringify({ email: user.email, password: user.password, email_confirm: true }) });
  user.id = created.id; check(uuid.test(user.id)); await journal();
  // Password and refresh grants share the same bounded start limiter.
  let requestedAt;
  const session = await tokenLimiter.run(async ({ requestStartedAt, signal }) => {
    requestedAt = requestStartedAt;
    return sb('/auth/v1/token?grant_type=password', anonKey, { method: 'POST', signal,
      body: JSON.stringify({ email: user.email, password: user.password }) });
  }, { signal: stop.signal });
  check(session.user?.id === user.id && session.access_token, 'supabase_session_mismatch');
  user.auth = createLoadActorAuth({ loginResponse: session, requestStartedAt: requestedAt, limiter: tokenLimiter,
    refresh: ({ refreshToken, signal }) => sb('/auth/v1/token?grant_type=refresh_token', anonKey,
      { method: 'POST', signal, body: JSON.stringify({ refresh_token: refreshToken }) }) });
  await ensureAuth(user);
  await rpc('upsert_profile', user.token, { p_nickname: `부하${index + 1}`, p_character_id: 'minty_pup' });
  if ((index + 1) % 25 === 0 || index + 1 === options.users) console.log(`PROVISION completed_at_least=${index + 1} requested=${options.users}`);
}
async function sampleQueue() {
  const row = (await query("select count(*) filter(where delivered_at is null)::int as pending, coalesce(extract(epoch from clock_timestamp()-min(occurred_at) filter(where delivered_at is null))*1000,0)::float8 as oldest_pending_ms, count(*) filter(where delivered_at is not null)::int as delivered, (select count(*)::int from pg_stat_activity where datname=current_database() and wait_event_type='Lock') as db_lock_waiters, (select count(*)::int from pg_stat_activity where datname=current_database() and state='active') as db_active_sessions from private.firebase_live_outbox"))[0];
  metrics.queue.push({ elapsed_ms: Date.now() - startedAt, ...row });
  console.log(`QUEUE ${JSON.stringify(row)}`);
  if (edgePublisher) {
    await observeEdge();
    if (metrics.edgePublisher.phase === 'running' && metrics.edgePublisher.leaseExpired) abort('edge_dispatch_stalled');
  }
  if (Number(row.pending) > 1000 || Number(row.oldest_pending_ms) > 15000) abort('worker_backlog_limit');
}
function observeEdge(enforce = true) {
  // Serialize boundary and periodic samples so slower older results cannot move
  // the cumulative byte counter backwards.
  const work = edgeObservation.then(async () => {
    metrics.edgePublisher = await edgePublisher.sample();
    metrics.dispatchTimingSamples ||= [];
    if (metrics.edgePublisher.enqueueToAdmissionMs !== null
        && metrics.dispatchTimingSamples.at(-1)?.startedCount !== metrics.edgePublisher.started_count) {
      metrics.dispatchTimingSamples.push({ sampledAt: metrics.edgePublisher.sampledAt,
        startedCount: metrics.edgePublisher.started_count,
        enqueueToAdmissionMs: metrics.edgePublisher.enqueueToAdmissionMs });
    }
    const bytes = metrics.edgePublisher.totals.responseBodyBytes - metrics.edgeBaseline.totals.responseBodyBytes;
    traffic.updateWorker(bytes, enforce && !closing && !stop.signal.aborted);
  });
  edgeObservation = work.catch(() => {});
  return work;
}
async function databaseCounters() {
  // Aggregate counters only. No SQL text, client addresses or customer records.
  return (await query("select clock_timestamp() as sampled_at, xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted, temp_bytes, deadlocks, stats_reset from pg_stat_database where datname=current_database()"))[0];
}
// A committed message stays successful regardless of this optional wake. Keep
// every failed wake visible; the durable queue remains responsible for recovery.
export async function attemptPublisherWake(operation, onFailure) {
  try { await operation(); return true; }
  catch (error) { onFailure(error); return false; }
}
function schedulePublisherWake(user, messageId) {
  const at = Date.now(), item = expected.get(messageId);
  metrics.wakeFunctionCalls++;
  const work = attemptPublisherWake(async () => {
    const result = await request(`${base}/functions/v1/${requirePublisherWakeCapability({ publisherWake: { endpoint: user.publisherWakeEndpoint, protocolVersion: 1 } })}`, { method: 'POST',
      headers: { apikey: anonKey, authorization: `Bearer ${user.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: user.room.id, epoch: user.descriptor.epoch, messageId }) }, [200, 202]);
    metrics.wakeFunctionResponses++;
    check(typeof result?.accepted === 'boolean', 'invalid_publisher_wake_response');
    count(metrics, result.accepted ? 'wakeAccepted' : 'wakeAlreadyOwnedOrComplete');
    if (item) { item.wakeMs = Date.now() - at; item.wakeReason = result.accepted ? 'accepted' : result.reason; }
    if (!result.accepted && ['duplicate', 'delivered', 'running', 'contended', 'disabled', 'unavailable'].includes(result.reason)) {
      count(metrics.wakeNoopReasons, result.reason);
    }
  }, error => {
    metrics.wakeFunctionFailures++; count(metrics.wakeErrors, safeCode(error));
  });
  wakeWork.add(work); void work.finally(() => wakeWork.delete(work));
}
async function action(room, sequence, roomIndex, typingAction) {
  const kind = typingAction?.kind ?? workloadKind(sequence, roomIndex);
  if (!typingAction && options.typingWorkload === 'activity' && kind.startsWith('typing_')) {
    metrics.typingActivity.historicalSlotsReplaced++; return;
  }
  stop.signal.throwIfAborted(); budget.action();
  const user = typingAction ? room.members[0] : room.members[sequence % room.members.length], target = room.members[(sequence + 1) % room.members.length];
  const id = randomUUID(), started = Date.now(), body = `synthetic load ${runId.slice(0, 8)} ${sequence}`;
  const item = { kind, started, body, senderID: user.id, recipients: new Set(room.members.map(member => member.id)), received: new Set(), accepted: false };
  expected.set(id, item);
  await ensureAuth(user);
  if (kind === 'message') {
    await rpc('send_message', user.token, { p_id: id, p_room_id: room.id, p_body: body });
    item.commitMs = Date.now() - started;
    if (options.directEvents) schedulePublisherWake(user, id);
  }
  else if (options.directEvents) {
    if (kind.startsWith('typing_')) user.directSequence = (user.directSequence ?? 0n) + 1n;
    const payload = directEventBody({ roomId: room.id, epoch: user.descriptor.epoch, eventId: id, kind,
      targetUserId: target.id, sequence: user.directSequence });
    metrics.directFunctionCalls++;
    const entered = performance.now();
    const published = await attemptDirectLoadEvent(async () => {
      const response = await measuredFetch(`${base}/functions/v1/realtime-event`, { method: 'POST',
        headers: { apikey: anonKey, authorization: `Bearer ${user.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload) });
      metrics.directFunctionResponses++;
      if (!response.ok) {
        // Preserve the status even if a provider error body is not JSON. Record
        // only the handler's known numeric timings, never error/body text.
        let failureTiming, failureStage, upstreamStatus, failureCode;
        try {
          const detail = await response.json();
          failureTiming = directEventTimings(detail.timing, performance.now() - entered);
          if (['configuration','input','db_validation','authorized_event','google_auth','rtdb_write'].includes(detail.failureStage)) failureStage = detail.failureStage;
          if (Number.isInteger(detail.upstreamStatus) && detail.upstreamStatus >= 100 && detail.upstreamStatus <= 599) upstreamStatus = detail.upstreamStatus;
          if (['timeout','aborted','transport','invalid_response','http','internal'].includes(detail.failureCode)) failureCode = detail.failureCode;
          const observed = directDatabaseObservation(detail);
          if (options.observe && observed) rpcObservation.record(observed);
        } catch { }
        metrics.directFailureTimings ||= [];
        if (metrics.directFailureTimings.length < 100) metrics.directFailureTimings.push({
          elapsedMs: Date.now() - startedAt, status: response.status,
          handlerTimingAvailable: failureTiming !== undefined, failureStage, failureCode, upstreamStatus, ...(failureTiming ?? {}) });
        throw new Error(`direct_event_http_${response.status}`);
      }
      const result = await response.json();
      const observed = directDatabaseObservation(result);
      if (options.observe && observed) rpcObservation.record(observed);
      for (const [key, value] of Object.entries(directEventTimings(result.timing, performance.now() - entered))) {
        (metrics.directStages[key] ||= []).push(value);
      }
      check(result.published === true && result.eventId === id && /^[1-9][0-9]{0,18}$/.test(result.revision), 'direct_event_not_published');
    }, error => {
      metrics.directFunctionFailures++;
      metrics.directFailureCodes ||= {}; count(metrics.directFailureCodes, safeCode(error));
      metrics.directFailureKinds ||= {}; count(metrics.directFailureKinds, kind);
      const detail = backgroundErrorSummary(error);
      metrics.directTransportFailureCounts ||= {};
      count(metrics.directTransportFailureCounts, `${detail.name}:${detail.code}:${detail.causeCode ?? 'none'}`);
      const sample = { elapsedMs: Date.now() - startedAt, role: 'direct_event', ...detail };
      metrics.directFailureSamples ||= [];
      if (metrics.directFailureSamples.length < 100) metrics.directFailureSamples.push(sample);
      console.log(`DIRECT_FAILURE ${JSON.stringify(sample)}`);
    }, { stopping: loadStopping });
    if (!published) return;
  }
  else if (kind === 'character_throw') await rpc('broadcast_character_throw', user.token,
    { p_room_id: room.id, p_realtime_epoch: user.descriptor.epoch, p_event_id: id, p_target_user_id: target.id });
  else await rpc('broadcast_room_event', user.token,
    { p_room_id: room.id, p_realtime_epoch: user.descriptor.epoch, p_event: kind, p_event_id: id });
  item.accepted = true; count(metrics.accepted, kind); metrics.latency.action.push(Date.now() - started);
  if (typingAction) {
    count(metrics.typingActivity.actualAccepted, typingAction.reason); metrics.typingActivity.actualAccepted.total++;
    count(metrics.typingActivity.actualAcceptedByScenario, typingAction.scenario);
  }

}
async function clean(name, operation) {
  try { await operation(); } catch (error) {
    cleanupFailures.push(name);
    const code = safeCode(error);
    metrics.cleanupErrorCodes ||= {}; count(metrics.cleanupErrorCodes, `${name}:${code}`);
    console.log(`FAIL cleanup_${name} code=${code}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort(signal));
try {
  options = loadOptions(process.argv.slice(2)); metrics.directEvents = options.directEvents === true; metrics.usersRequested = options.users; metrics.holdSeconds = options.holdSeconds;
  metrics.requestedEdgeRegion = options.edgeRegion ?? 'automatic';
  if (options.largeScale) check(process.env.SIDEY_STAGING_AUTH_LOAD_APPROVED === '2400', 'auth_rate_approval_required');
  check(typeof firebaseAPIKey === 'string' && firebaseAPIKey.length >= 20, 'firebase_api_key_required');
  budget = new LoadBudget({ ...options, abort });
  traffic = new LoadTraffic(budget);
  totalTimer = setTimeout(() => abort('total_runtime_limit'), options.totalTimeoutMs ?? 60 * 60 * 1000);
  preparationTimer = setTimeout(() => abort('preparation_runtime_limit'), options.preparationTimeoutMs ?? 45 * 60 * 1000);
  const preparationLimiter = createTokenEndpointLimiter({ intervalMs: options.tokenStartIntervalMs ?? 2100 });
  const normalLimiter = createTokenEndpointLimiter({ intervalMs: 2100 });
  tokenLimiter = { run: (...args) => (authPreparationFinished ? normalLimiter : preparationLimiter).run(...args) };
  if (options.timelineLimit) {
    connectionDiagnostics = new LoadConnectionDiagnostics({ timelineLimit: options.timelineLimit,
      emit: sample => console.log(`STREAM_DIAGNOSTIC ${JSON.stringify(sample)}`) });
    metrics.connectionDiagnostics = connectionDiagnostics.report;
  }
  metrics.loadProfile = { users: options.users, rooms: Math.ceil(options.users / 10),
    producerConcurrency: options.producerConcurrency ?? 8, rampConcurrency: options.rampConcurrency ?? 4,
    renewalConcurrency: options.renewalConcurrency ?? 4, presenceConcurrency: options.presenceConcurrency ?? 12,
    actionLimit: options.actionLimit, byteLimit: options.byteLimit };
  check(typeof process.env.SIDEY_STAGING_SERVICE_ACCOUNT_FILE === 'string', 'service_account_file_required');
  account = JSON.parse(await readFile(process.env.SIDEY_STAGING_SERVICE_ACCOUNT_FILE, 'utf8'));
  check(account.project_id === project && account.client_email?.endsWith(`@${project}.iam.gserviceaccount.com`) && typeof account.private_key === 'string', 'staging_account_required');
  try { check((await readFile(join(root, 'supabase/.temp/project-ref'), 'utf8')).trim() === ref, 'wrong_linked_project'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const keys = JSON.parse(await cli(['projects', 'api-keys', '--project-ref', ref, '--output', 'json']));
  adminKey = keys.find(key => key.name === 'service_role')?.api_key; anonKey = keys.find(key => key.name === 'anon')?.api_key; check(adminKey && anonKey);
  mark('baseline_flags'); originalSecrets = await secrets();
  check(originalSecrets.get('SIDEY_FIREBASE_MODE') === digest('off') && originalSecrets.get('SIDEY_FIREBASE_SHADOW_APPROVED') === digest('false')
    && originalSecrets.get('SIDEY_FIREBASE_LIVE_APPROVED') === digest('false') && originalSecrets.get('SIDEY_FIREBASE_PROJECT_ID') === digest(project)
    && originalSecrets.get('SIDEY_FIREBASE_SUPABASE_PROJECT_REF') === digest(ref)
    && [digest(database), digest(database + '/')].includes(originalSecrets.get('SIDEY_FIREBASE_DATABASE_URL')), 'staging_flags_mismatch');
  if (options.directEvents) check(!originalSecrets.has('SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED')
    || originalSecrets.get('SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED') === digest('false'), 'direct_events_already_enabled');
  mark('baseline_rules');
  const lockedRules = JSON.parse(await readFile(new URL('../../supabase/firebase/database.rules.json', import.meta.url), 'utf8'));
  check(JSON.stringify(await fb('.settings/rules')) === JSON.stringify(lockedRules), 'rules_not_locked');
  mark('baseline_empty');
  const baseline = (await query("select (select count(*) from auth.users)=0 as users_empty, (select count(*) from public.rooms)=0 as rooms_empty, (select count(*) from private.firebase_live_outbox)=0 as outbox_empty, (select count(*) from private.firebase_live_access_snapshots)=0 as access_snapshots_empty, (select count(*) from private.firebase_live_leases)=0 as leases_empty, (select count(*) from private.firebase_direct_events)=0 as direct_events_empty, (select count(*) from private.firebase_direct_typing_sequences)=0 as direct_sequences_empty, not exists(select 1 from private.firebase_live_config where enabled or direct_events_enabled) as config_off, (select count(*) from pg_trigger where tgname in ('zz_firebase_messages_shadow','zz_firebase_rooms_shadow','zz_firebase_profiles_shadow') and tgenabled='D')=3 as triggers_disabled"))[0];
  check(Object.values(baseline).every(value => value === true), 'staging_not_empty');
  metrics.publisher = options.edgePublisher ? 'cloud Edge publisher with SQL conditional dispatch'
    : options.workerHost ? 'separate SSH cloud worker' : 'embedded local worker';
  if (options.edgePublisher) {
    mark('edge_publisher_preflight');
    const deployed = JSON.parse(await cli(['functions', 'list', '--project-ref', ref, '--output', 'json']));
    metrics.edgeDeploymentBefore = edgeDeploymentMetadata(deployed);
    if (options.directEvents) {
      metrics.directDeploymentBefore = edgeDeploymentMetadata(deployed, undefined, 'realtime-event');
      metrics.wakeDeploymentBefore = edgeDeploymentMetadata(deployed, undefined, 'realtime-event');
    }
    check(originalSecrets.has('SIDEY_FIREBASE_LIVE_PUBLISH_SECRET'), 'edge_publisher_secret_missing');
    edgePublisher = new StagingEdgeSession({ runId, query, sleep: ms => delay(ms), directEvents: options.directEvents === true, edgeRegion: options.edgeRegion ?? null });
    metrics.edgeBaseline = await edgePublisher.preflight();
  }
  // Establish provenance and connectivity before creating any synthetic users.
  // The remote worker only runs the existing staging publisher, never deploys it.
  if (options.workerHost) {
    mark('remote_worker_preflight');
    remoteWorker = await startRemoteWorker({ host: options.workerHost, directory: options.workerDirectory,
      runId, credentials: { serviceRoleKey: adminKey, account }, maxSeconds: 3600,
      onFailure: () => abort('remote_worker_failed'),
      onMetrics: value => {
        metrics.remoteWorker = value;
        const total = Object.values(value.http || {}).reduce((sum, item) => sum + item.responseBodyBytes, 0);
        try { traffic.updateWorker(total, !closing && !stop.signal.aborted); }
        catch (error) { abort(safeCode(error)); }
      } });
    metrics.remoteWorkerProvenance = remoteWorker.ready;
    publisherStopped = false;
  }
  recoveryDirectory = await mkdtemp(join(tmpdir(), 'sidey-load-recovery-'));
  for (let index = 0; index < options.users; index++) users.push({ email: `sidey-load-${runId}-${index}@example.invalid`, password: randomBytes(32).toString('base64url') });
  await journal(); cleanupAllowed = true;
  console.log(`RECOVERY ${recoveryDirectory}`);
  if (options.largeScale) {
    authRate = new StagingAuthRateOverride({ approved2400: true, checkpoint: () => journal() });
    const config = await authRate.read();
    check(config.jwt_exp === 3600, 'auth_lifetime_configuration_changed');
    metrics.authPreparation = { originalRatePerFiveMinutes: config.rate_limit_token_refresh,
      temporaryRatePerFiveMinutes: 1500, requestStartIntervalMs: options.tokenStartIntervalMs };
  }
  mark('provision_real_auth_sessions');
  try {
    if (authRate) await authRate.apply();
    await parallelMap(users, options.provisionConcurrency ?? 4, provision);
  } finally {
    if (authRate) await authRate.restore();
    authPreparationFinished = true;
  }
  mark('create_rooms_and_join');
  for (let offset = 0; offset < users.length; offset += 10) {
    stop.signal.throwIfAborted();
    const members = users.slice(offset, offset + 10);
    // Keep the final group at >=2 users for throwing; 500 and pilot10 are exact groups.
    if (members.length === 1 && rooms.length) {
      await ensureAuth(members[0]);
      const room = rooms.at(-1), result = (await rpc('join_room', members[0].token, { p_invite_code: room.inviteCode }))[0];
      check(result.room_id === room.id && !result.error_code, 'join_failed'); room.members.push(members[0]); members[0].room = room; continue;
    }
    await ensureAuth(members[0]);
    const value = (await rpc('create_room', members[0].token, { p_name: `staging load ${rooms.length + 1}` }))[0];
    check(uuid.test(value.room_id), 'invalid_room');
    const room = { id: value.room_id, inviteCode: value.invite_code, members }; rooms.push(room); await journal();
    for (const member of members) member.room = room;
    await parallelMap(members.slice(1), 3, async member => {
      await ensureAuth(member);
      const result = (await rpc('join_room', member.token, { p_invite_code: room.inviteCode }))[0];
      check(result.room_id === room.id && !result.error_code, 'join_failed');
    });
  }
  if (options.largeScale) {
    const minimumLifetime = options.rampTimeoutMs + options.holdSeconds * 1000 + 120000;
    check(users.every(user => user.auth.snapshot().expiresAt - Date.now() > minimumLifetime), 'prepared_auth_lifetime_insufficient');
  }
  clearTimeout(preparationTimer);
  mark('enable_owned_cohort');
  await query(`begin; insert into private.firebase_live_users(user_id,enabled) values ${users.map(user => `('${user.id}',true)`).join(',')}; insert into private.firebase_live_rooms(room_id,enabled) values ${rooms.map(room => `('${room.id}',true)`).join(',')}; update private.firebase_live_config set enabled=true; commit;`);
  await fb('.settings/rules', { method: 'PUT', body: JSON.parse(await readFile(new URL('../../supabase/firebase/database.live.rules.json', import.meta.url), 'utf8')) });
  await setSecrets({ SIDEY_FIREBASE_MODE: 'live', SIDEY_FIREBASE_LIVE_APPROVED: 'true' });
  if (remoteWorker) await remoteWorker.start();
  if (edgePublisher) {
    publisherStopped = false; await edgePublisher.start();
    if (options.directEvents) {
      // SQL owner must be ours before touching the direct gateway's global flag.
      directSecretsMayBeChanged = true;
      await setSecrets({ SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED: 'true' });
    }
    // Updating secrets creates another function version even when its bundle is unchanged.
    mark('edge_publisher_active_provenance');
    const activeDeployments = JSON.parse(await cli(['functions', 'list', '--project-ref', ref, '--output', 'json']));
    metrics.edgeDeployment = edgeDeploymentMetadata(activeDeployments, metrics.edgeDeploymentBefore.bundleHash);
    if (options.directEvents) {
      metrics.directDeployment = edgeDeploymentMetadata(activeDeployments, metrics.directDeploymentBefore.bundleHash, 'realtime-event');
      metrics.wakeDeployment = edgeDeploymentMetadata(activeDeployments, metrics.wakeDeploymentBefore.bundleHash, 'realtime-event');
    }
  }
  const worker = (remoteWorker || edgePublisher) ? null : new LiveWorker({ config: { databaseURL: database, account }, rpc: (name, body, signal) => rpc(name, adminKey, body, signal),
    accessToken, fetcher: (url, init) => measuredFetch(url, init), log: name => count(metrics.worker, name) });
  mark('publish_initial_controls');
  const initialControlAttempts = options.largeScale ? 120 : 30;
  for (let attempt = 0; attempt < initialControlAttempts; attempt++) {
    if (worker) await worker.batch(stop.signal);
    const pending = (await query('select count(*)::int as pending from private.firebase_live_outbox where delivered_at is null'))[0].pending;
    if (Number(pending) === 0) break;
    check(attempt < initialControlAttempts - 1, 'initial_control_backlog');
    if (remoteWorker || edgePublisher) await delay(options.largeScale ? 5000 : 500, undefined, { signal: stop.signal });
  }
  const workerSignal = AbortSignal.any([stop.signal, workerStop.signal]);
  async function loop(role, operation, interval) {
    while (!workerSignal.aborted) {
      const at = Date.now();
      try {
        // Presence records each user independently so one failed heartbeat does
        // not prevent healthy users from receiving their scheduled heartbeat.
        if (role === 'presence' || role === 'renewal') await operation(workerSignal);
        else await backgroundPolicy.attempt(role, () => operation(workerSignal));
      } catch (error) { if (!workerSignal.aborted) abort(`${role}_${backgroundErrorSummary(error).code}`); }
      try { await delay(Math.max(0, interval - (Date.now() - at)), undefined, { signal: workerSignal }); } catch { break; }
    }
  }
  renewalScheduler = createLoadRenewalScheduler({ users: () => users, renew: renewUser,
    concurrency: options.renewalConcurrency ?? 4, stopping: loadStopping,
    onFailure: error => { if (!workerSignal.aborted) abort(`renewal_${backgroundErrorSummary(error).code}`); } });
  workerLoops = [
    ...(worker ? [loop('worker', signal => worker.batch(signal), 500), loop('worker_cleanup', signal => worker.cleanup(signal), 1000)] : []),
    loop('presence', () => parallelMap(users.filter(user => user.ready && !user.renewing), options.presenceConcurrency ?? 12,
      user => backgroundPolicy.attempt('presence', () => presence(user))), 45000),
    loop('renewal', () => renewalScheduler.tick(), 1000), loop('queue', sampleQueue, 15000)];
  mark('ramp_authenticated_streams'); metrics.activeStartedAt = Date.now();
  activeTimer = setTimeout(() => abort('ramp_runtime_limit'), options.rampTimeoutMs ?? (options.holdSeconds + 8 * 60 + 60) * 1000);
  const rampBatch = options.largeScale ? 100 : 25;
  for (let offset = 0; offset < users.length; offset += rampBatch) {
    await parallelMap(users.slice(offset, offset + rampBatch), options.rampConcurrency ?? 4, async user => {
      const at = Date.now();
      await prepareLoadActor(user, { bootstrap: bootstrapUser, validate: validateLease, login: firebaseLogin,
        cursor: actor => rpc('firebase_realtime_changes', actor.token, { p_room_id: actor.room.id }),
        open: openStream, presence }, { actorIndex: users.indexOf(user), roomIndex: rooms.indexOf(user.room),
        record: recordPreparationFailure, sleep: boundedRecovery.sleep, stopping: loadStopping });
      metrics.latency.bootstrap.push(Date.now() - at);
    });
    metrics.checkpoints.push({ connected: metrics.connectionsCurrent, elapsed_ms: Date.now() - metrics.activeStartedAt });
    console.log(`RAMP connected=${metrics.connectionsCurrent} peak=${metrics.connectionsPeak}`);
    await delay(250, undefined, { signal: stop.signal });
  }
  check(metrics.connectionsCurrent === options.users, 'peak_not_reached');
  clearTimeout(activeTimer);
  activeTimer = setTimeout(() => abort('active_runtime_limit'), (options.holdSeconds + 120) * 1000);
  metrics.databaseBefore = await databaseCounters();
  if (edgePublisher) await observeEdge();
  if (options.observe) {
    serverTimingSetting = new StagingServerTiming({ query, checkpoint: () => journal() });
    await serverTimingSetting.apply();
    let timingVerified = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      // OpenAPI's gateway requires the service API key to match the service JWT.
      const response = await measuredFetch(`${base}/rest/v1/`, { headers: { apikey: adminKey, authorization: `Bearer ${adminKey}` } });
      const values = parsePostgrestServerTiming(response.headers.get('server-timing'));
      await response.body?.cancel();
      check(response.ok, `server_timing_probe_http_${response.status}`);
      if (Object.keys(values).length) { timingVerified = true; break; }
      await delay(250, undefined, { signal: stop.signal });
    }
    check(timingVerified, 'server_timing_header_unavailable');
    loadObserver = createStagingLoadObserver({ token: createStagingManagementToken(),
      onSample: sample => console.log(`OBSERVATION ${JSON.stringify(sample)}`) });
    const initialObservation = await loadObserver.start();
    check(initialObservation.sqlBefore?.status === 'OBSERVED'
      && initialObservation.samples[0]?.metrics.status === 'OBSERVED'
      && initialObservation.samples[0]?.activity.status === 'OBSERVED', 'observer_preflight_failed');
  }
  mark('bounded_workload'); metrics.holdStartedAt = Date.now();
  connectionDiagnostics.startHold(metrics.holdStartedAt);
  metrics.measurementStartISO = new Date(metrics.holdStartedAt).toISOString();
  metrics.measurementStart = { observedBodyBytes: budget.bytes, remoteWorker: metrics.remoteWorker, edgePublisher: metrics.edgePublisher,
    renewals: metrics.leaseRenewals || 0, connections: metrics.connectionsCurrent };
  const renewalsBefore = new Map(users.map(user => [user.id, user.renewals || 0]));
  const holdEnd = Date.now() + options.holdSeconds * 1000;
  // Both producers are independently bounded; a slow typing RPC does not delay
  // the historical message/throw/pulse ticks. Each producer caps concurrency at 8.
  const durationMs = options.holdSeconds * 1000;
  const activityRooms = options.typingWorkload === 'activity' ? rooms.map((room, index) => ({
    room, index, trace: typingActivityTrace(durationMs, index), cursor: 0, policy: new TypingActivityPolicy() })) : [];
  if (activityRooms.length) {
    metrics.workload = 'historical message/throw/pulse ticks; typing replaced by fixed-actor 20-second SIDEY editing traces';
    const sums = baseline => activityRooms.reduce((total, entry) => {
      for (const [key, value] of Object.entries(simulateTypingActivity(entry.trace, durationMs, baseline))) total[key] = (total[key] || 0) + value;
      return total;
    }, {});
    const previous = sums(true), optimized = sums(false);
    metrics.typingActivity = { traceVersion: 1, cycleMs: 20000, actor: 'one fixed room member',
      previousPolicy: 'immediate first start, unconditional 2-second keepalive, 5-second edit idle stop',
      optimizedPolicy: 'fixed 500ms first start, 2-second tick only for edits not covered by last successful publish, 5-second idle stop',
      previousSynthetic: previous, optimizedSynthetic: optimized,
      syntheticReduction: { events: previous.total - optimized.total, fraction: previous.total ? 1 - optimized.total / previous.total : null },
      actualAccepted: { initial: 0, keepalive: 0, stop: 0, total: 0 }, historicalSlotsReplaced: 0,
      actualAcceptedByScenario: { short: 0, continuous_then_idle: 0, resume: 0, run_end: 0 },
      inputCounts: {}, inputLatenessMaxMs: 0, cancelledPending: 0,
      note: 'Same synthetic input compared locally; baseline is not a second cloud run. Not measured production savings or native UI verification. Trace stops are input lifecycle actions and do not create extra messages.' };
  }
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  const cpuBefore = process.cpuUsage(); eventLoop.enable();
  let peakRSS = 0, peakHeap = 0;
  const sampleMemory = () => {
    const memory = process.memoryUsage();
    peakRSS = Math.max(peakRSS, memory.rss); peakHeap = Math.max(peakHeap, memory.heapUsed);
    if (options.largeScale && memory.rss > 3 * 1024 ** 3) abort('generator_memory_budget');
  };
  sampleMemory(); const memoryTimer = setInterval(sampleMemory, 1000);
  metrics.offeredWorkload = { ticks: 0, tickOverruns: 0, maximumTickMs: 0, expectedTicks: Math.ceil(options.holdSeconds / 2) };
  try {
    const producerResults = await Promise.allSettled([
      (async () => {
        let sequence = 0;
        while (Date.now() < holdEnd) {
          const tick = Date.now(); stop.signal.throwIfAborted();
          await parallelMap(rooms, options.producerConcurrency ?? 8, (room, index) => action(room, sequence, index)); sequence++;
          const tickMs = Date.now() - tick;
          metrics.offeredWorkload.ticks++;
          if (tickMs > 2000) metrics.offeredWorkload.tickOverruns++;
          metrics.offeredWorkload.maximumTickMs = Math.max(metrics.offeredWorkload.maximumTickMs, tickMs);
          await delay(Math.max(0, 2000 - (Date.now() - tick)), undefined, { signal: stop.signal });
        }
      })(),
      (async () => {
        if (!activityRooms.length) return;
        while (true) {
          const now = Math.min(durationMs, Date.now() - metrics.holdStartedAt);
          await parallelMap(activityRooms, options.producerConcurrency ?? 8, async entry => {
            const roomNow = Math.min(durationMs, Date.now() - metrics.holdStartedAt);
            while (entry.cursor < entry.trace.length && entry.trace[entry.cursor].at <= roomNow) {
              const input = entry.trace[entry.cursor++]; entry.scenario = input.scenario;
              count(metrics.typingActivity.inputCounts, `${input.scenario}:${input.kind}`);
              metrics.typingActivity.inputLatenessMaxMs = Math.max(metrics.typingActivity.inputLatenessMaxMs, roomNow - input.at);
              if (input.kind === 'edit') entry.policy.edit(input.at); else entry.policy.stop();
            }
            const event = entry.policy.poll(roomNow);
            if (event) {
              await action(entry.room, 0, entry.index, { ...event, scenario: entry.scenario });
              entry.policy.acknowledge(event, Date.now() - metrics.holdStartedAt);
            }
          });
          if (now >= durationMs) break;
          await delay(50, undefined, { signal: stop.signal });
        }
        metrics.typingActivity.cancelledPending = activityRooms.reduce((sum, entry) => sum + entry.policy.cancelledPending, 0);
      })(),
    ].map(work => work.catch(error => { abort(safeCode(error)); throw error; })));
    const failedProducer = producerResults.find(result => result.status === 'rejected');
    if (failedProducer) throw failedProducer.reason;
  } finally {
    metrics.holdActualMs = Date.now() - metrics.holdStartedAt;
    metrics.measurementEndISO = new Date().toISOString();
    metrics.renewedUsersDuringHold = users.filter(user => (user.renewals || 0) > renewalsBefore.get(user.id)).length;
    eventLoop.disable(); clearInterval(memoryTimer); sampleMemory();
    const cpu = process.cpuUsage(cpuBefore);
    metrics.generatorRuntime = { peakRSSBytes: peakRSS, peakHeapBytes: peakHeap, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
      eventLoopDelayMs: { p50: eventLoop.percentile(50) / 1e6, p95: eventLoop.percentile(95) / 1e6,
        p99: eventLoop.percentile(99) / 1e6, max: eventLoop.max / 1e6 },
      note: 'Load-generator process during workload only; not cloud publisher CPU or end-to-end delivery latency.' };
    stopObservation();
  }
  if (edgePublisher) await observeEdge();
  metrics.measurementEnd = { observedBodyBytes: budget.bytes, remoteWorker: metrics.remoteWorker, edgePublisher: metrics.edgePublisher,
    renewals: metrics.leaseRenewals || 0, connections: metrics.connectionsCurrent };
  metrics.leaseRenewalVerified = metrics.renewedUsersDuringHold === users.length;
  if (options.holdSeconds >= 600) check(metrics.leaseRenewalVerified, 'lease_renewal_coverage_failed');
  mark('drain_and_verify_delivery');
  await delay(10000, undefined, { signal: stop.signal });
  await Promise.all([...wakeWork]);
  await Promise.all([...streamRecoveryWork]);
  await Promise.all([...reconcileWork]);
  metrics.messageMissingBeforeForcedReconcile = [...expected.values()].filter(item => item.accepted && item.kind === 'message')
    .reduce((sum, item) => sum + item.recipients.size - item.received.size, 0);
  const messagesBeforeForcedReconcile = metrics.received.message || 0;
  await parallelMap(users, options.finalReconcileConcurrency ?? 32, user => reconcile(user));
  await Promise.all([...reconcileWork]); await sampleQueue();
  metrics.forcedReconcileRecovered = (metrics.received.message || 0) - messagesBeforeForcedReconcile;
  check(metrics.connectionsCurrent === options.users, 'connections_lost');
  const missing = [...expected.values()].filter(item => item.accepted).reduce((sum, item) => sum + item.recipients.size - item.received.size, 0);
  metrics.missingDeliveries = missing;
  check(missing === 0 && metrics.messageMissingBeforeForcedReconcile === 0 && metrics.expiredDeliveries === 0
    && metrics.messagePayloadFailures === 0, 'delivery_verification_failed');
  check(['message', 'typing_start', 'typing_stop', 'character_pulse', 'character_throw'].every(kind => metrics.accepted[kind] > 0), 'incomplete_action_coverage');
  metrics.presenceExpectedPairs = users.reduce((sum, user) => sum + user.room.members.length, 0);
  metrics.presenceFreshPairs = users.reduce((sum, user) => sum + user.room.members.filter(member => {
    const value = user.presenceSeen?.get(member.id);
    return value?.active === true && value.state === 'online' && Date.now() + user.serverClockOffset - value.updatedAt < 90000;
  }).length, 0);
  check(metrics.presenceExpectedPairs === metrics.presenceFreshPairs, 'presence_fanout_or_freshness_failed');
  metrics.presenceFanoutVerified = true;
  mark('final_database_counters');
  metrics.databaseAfter = await databaseCounters();
  mark('verify_latency');
  metrics.latencyTargetsMs = { p95: 500, p99: 1000, kinds: ['message', 'character_throw'], recipients: 'other room members' };
  Object.assign(metrics, loadQualityVerdicts(metrics));
  check(metrics.backgroundIntegrityVerdict === 'PASS', 'background_operation_failed');
  check(metrics.directDeliveryVerdict === 'PASS', 'direct_event_delivery_failed');
  check(metrics.wakeDeliveryVerdict === 'PASS', 'publisher_wake_failed');
  metrics.practicalLatencyTargetsMs = { p95: 1000, p99: 1500, kinds: ['message', 'character_throw'], recipients: 'other room members' };
  for (const [name, observed] of Object.entries(metrics.practicalLatencyGate)) check(observed.passed, `${name}_latency_target_failed`);
  stop.signal.throwIfAborted();
  check(metrics.streamUnexpectedClose === 0, 'stream_interruption_detected');
  check(metrics.preparationIntegrityVerdict === 'PASS', 'preparation_operation_failed');
  console.log('PASS staging_live_load');
} catch (error) {
  metrics.failure = { stage, ...loadFailureSummary(error), stopReason };
  console.log(`FAIL ${stage} code=${metrics.failure.code} stop=${stopReason || 'none'} detail=${JSON.stringify(metrics.failure.detail)}${metrics.failure.preparation ? ` preparation=${JSON.stringify(metrics.failure.preparation)}` : ''}`); process.exitCode = 1;
} finally {
  stopObservation();
  const diagnosticVerificationAt = Date.now();
  const diagnosticRecipients = new Map(users.map(user => [user.id, { ...connectionOrdinal(user),
    connected: user.stream?.closed === false, streamIndex: user.stream?.diagnosticIndex }]));
  clearTimeout(activeTimer); clearTimeout(totalTimer); clearTimeout(preparationTimer); closing = true; workerStop.abort(); backgroundPolicy.dispose();
  await renewalScheduler?.stop();
  // An admin worker bypasses RTDB Rules. Do not delete cleanup addresses until
  // its shutdown is positively confirmed, even after locking client access.
  if (authRate) await clean('auth_rate_restore', async () => { await authRate.restore(); metrics.authRate = authRate.snapshot(); });
  if (serverTimingSetting) await clean('server_timing_restore', async () => {
    await serverTimingSetting.restore(); metrics.serverTimingSetting = serverTimingSetting.snapshot();
  });
  await Promise.allSettled([...wakeWork]);
  if (remoteWorker) await clean('remote_worker_stop', async () => { await remoteWorker.stop(); publisherStopped = true; });
  if (edgePublisher?.mayBeRunning) await clean('edge_publisher_stop', async () => {
    await edgePublisher.stop(); publisherStopped = true; await observeEdge(false);
  });
  await Promise.allSettled(workerLoops);
  await Promise.allSettled([...streamRecoveryWork]);
  await Promise.allSettled(streams.map(stream => stream.close()));
  await Promise.allSettled([...reconcileWork]); await journalWrites.catch(() => {});
  if (cleanupAllowed) {
    mark('cleanup');
    await clean('locked_rules', async () => {
      const rules = JSON.parse(await readFile(new URL('../../supabase/firebase/database.rules.json', import.meta.url), 'utf8'));
      await fb('.settings/rules', { method: 'PUT', body: rules, cleanup: true });
      check(JSON.stringify(await fb('.settings/rules', { cleanup: true })) === JSON.stringify(rules));
    });
    await clean('flags_off', async () => {
      await setSecrets({ SIDEY_FIREBASE_MODE: 'off', SIDEY_FIREBASE_SHADOW_APPROVED: 'false', SIDEY_FIREBASE_LIVE_APPROVED: 'false',
        ...(directSecretsMayBeChanged ? { SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED: 'false' } : {}) });
      if (directSecretsMayBeChanged && !originalSecrets.has('SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED')) {
        await cli(['secrets', 'unset', 'SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED', '--project-ref', ref, '--yes']);
      }
    });
    await clean('rollout_disabled', () => query('update private.firebase_live_config set enabled=false'));
    if (!publisherStopped) {
      cleanupFailures.push('publisher_unconfirmed_data_preserved');
      console.log('FAIL cleanup_data_preserved_until_worker_stopped');
    } else {
    await withVerifiedLoadCleanup({ verify: async () => {
      const registered = await discoverOwnedLoadUsers(users, { listUsers: ({ page, perPage }) =>
        sb(`/auth/v1/admin/users?page=${page}&per_page=${perPage}`, adminKey, {}, true) });
      for (const user of users) if (registered.has(user.email)) user.id = registered.get(user.email);
      const ids = users.filter(user => user.id).map(user => `'${user.id}'`).join(',');
      if (ids) for (const row of await query(`select id from public.rooms where owner_id in(${ids})`)) {
        check(uuid.test(row.id)); if (!rooms.some(room => room.id === row.id)) rooms.push({ id: row.id });
      }
      await journal();
    }, preserve: async error => {
      cleanupFailures.push('owned_identity_unconfirmed_data_preserved');
      metrics.cleanupErrorCodes ||= {}; count(metrics.cleanupErrorCodes, `recover_owned_ids:${safeCode(error)}`);
      console.log('FAIL cleanup_data_preserved_until_owned_identity_verified');
    }, remove: async () => {
    // Bounded deletion starts stay below Firebase's 10 deletes/sec. Reauthenticate every
    // exact journaled UID immediately before deletion, including users with valid
    // existing tokens: the API additionally requires a recent authentication time.
    const ownedFirebaseIds = new Set(users.filter(user => uuid.test(user.id || '')).map(user => user.id));
    const deletionLimiter = createTokenEndpointLimiter({ intervalMs: 150 });
    let cleanedFirebaseUsers = 0;
    await parallelMap(users.filter(user => user.firebaseAttempted && uuid.test(user.id || '')), options.largeScale ? 4 : 1, async user => {
      await clean('firebase_auth_user', async () => {
        await deleteOwnedFirebaseUser(user, {
          ownedIds: ownedFirebaseIds,
          reauthenticate: async ownedUser => {
            await firebaseLogin(ownedUser, await customToken(account, ownedUser.id, randomUUID()), true);
            return ownedUser.firebaseToken;
          },
          deleteWithToken: token => deletionLimiter.run(() => request(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${firebaseAPIKey}`,
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: token }) }, [200], true)),
        });
      });
      cleanedFirebaseUsers++;
      if (cleanedFirebaseUsers % 100 === 0) console.log(`CLEANUP firebase_accounts_processed=${cleanedFirebaseUsers}`);
      if (!options.largeScale) await delay(125);
    });
    for (const room of rooms) {
      await clean('firebase_room', () => fb(`v2/rooms/${room.id}`, { method: 'DELETE', cleanup: true }));
      await clean('firebase_access', () => fb(`v2/access/${room.id}`, { method: 'DELETE', cleanup: true }));
    }
    await parallelMap(users.filter(user => uuid.test(user.id || '')), 4, async user => {
      await clean('firebase_lease', () => fb(`v2/leases/${user.id}`, { method: 'DELETE', cleanup: true }));
    });
    await clean('private_rows', async () => {
      const userIDs = users.filter(user => uuid.test(user.id || '')).map(user => `'${user.id}'`).join(',');
      const roomIDs = rooms.map(room => `'${room.id}'`).join(',');
      await query(`begin; ${userIDs ? `delete from private.firebase_live_users where user_id in(${userIDs}); delete from private.firebase_live_leases where user_id in(${userIDs});` : ''}
        ${roomIDs && userIDs ? `delete from private.firebase_direct_events where room_id in(${roomIDs}) and user_id in(${userIDs}); delete from private.firebase_direct_typing_sequences where room_id in(${roomIDs}) and auth_session_id in(select id from auth.sessions where user_id in(${userIDs})); delete from public.rooms where id in(${roomIDs}) and owner_id in(${userIDs}); delete from private.firebase_live_rooms where room_id in(${roomIDs}); delete from private.firebase_live_outbox where room_id in(${roomIDs}); delete from private.firebase_live_cursors where room_id in(${roomIDs}); delete from private.firebase_live_epochs where room_id in(${roomIDs});delete from private.firebase_live_access_snapshots where room_id in(${roomIDs});` : ''} commit;`);
    });
    await parallelMap(users.filter(user => uuid.test(user.id || '')), 4, async user => {
      await clean('supabase_user', () => sb(`/auth/v1/admin/users/${user.id}`, adminKey, { method: 'DELETE' }, true));
    });
    await clean('verify_off_and_empty', async () => {
      if (authRate) check((await authRate.read()).rate_limit_token_refresh === 150, 'auth_rate_not_restored');
      const flags = await secrets();
      for (const [name, value] of originalSecrets) if (name.startsWith('SIDEY_FIREBASE_')) check(flags.get(name) === value, 'flags_not_restored');
      if (options.directEvents && !originalSecrets.has('SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED')) check(!flags.has('SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED'), 'direct_flag_not_restored');
      const result = (await query("select (select count(*) from auth.users)=0 as users_empty, (select count(*) from public.rooms)=0 as rooms_empty, (select count(*) from private.firebase_live_outbox)=0 as outbox_empty, (select count(*) from private.firebase_live_access_snapshots)=0 as access_snapshots_empty, (select count(*) from private.firebase_live_leases)=0 as leases_empty, (select count(*) from private.firebase_direct_events)=0 as direct_events_empty, (select count(*) from private.firebase_direct_typing_sequences)=0 as direct_sequences_empty, not exists(select 1 from private.firebase_live_config where enabled or direct_events_enabled) as config_off"))[0];
      check(Object.values(result).every(value => value === true), 'cleanup_not_empty');
    });
    } });
    }
  }
  // Compute every quality verdict even when an earlier verification aborted.
  Object.assign(metrics, loadQualityVerdicts(metrics));
  metrics.elapsedMs = Date.now() - startedAt;
  if (observationStop) metrics.observation = await observationStop;
  if (options?.observe) metrics.rpcObservation = rpcObservation.snapshot();
  metrics.downloadBytesObserved = traffic?.total || 0;
  metrics.generatorDownloadBytesObserved = traffic?.generator || 0;
  metrics.workerDownloadBytesObserved = traffic?.worker || 0;
  metrics.byteObservationScope = options?.edgePublisher
    ? 'generator plus completed Edge publication and independently completed cleanup reported response bodies; excludes unreported failed invocations, direct-event function internal response bodies, bootstrap internal calls, management queries, TLS, headers and billing lag'
    : 'combined generator and worker decoded response bodies; excludes bootstrap function internal calls, TLS, headers and billing lag';
  metrics.actionsAttempted = budget?.actions || 0; metrics.cleanupFailures = cleanupFailures;
  metrics.messageDeliverySamples = [...expected.values()].filter(item => item.kind === 'message').map(item => ({
    accepted: item.accepted, commitMs: item.commitMs, wakeReason: item.wakeReason, wakeMs: item.wakeMs,
    elapsedMs: item.started - metrics.holdStartedAt, remoteLatencyMs: quantiles(item.remoteLatencies ?? []),
    missing: item.accepted ? item.recipients.size - item.received.size : null }));
  metrics.expectedDeliveries = {};
  metrics.missingDeliveriesByKind = {}; metrics.missingDeliveries = 0;
  for (const item of expected.values()) if (item.accepted) {
    metrics.expectedDeliveries[item.kind] = (metrics.expectedDeliveries[item.kind] || 0) + item.recipients.size;
    const missing = item.recipients.size - item.received.size;
    metrics.missingDeliveriesByKind[item.kind] = (metrics.missingDeliveriesByKind[item.kind] || 0) + missing;
    metrics.missingDeliveries += missing;
    for (const recipient of item.recipients) if (!item.received.has(recipient)) {
      connectionDiagnostics.missing(item.kind, item.started, diagnosticRecipients.get(recipient), diagnosticVerificationAt);
    }
  }
  metrics.latencyMs = Object.fromEntries(Object.entries(metrics.latency).map(([name, values]) => [name, quantiles(values)])); delete metrics.latency;
  for (const field of ['latencyByKind', 'remoteLatencyByKind', 'messageStages', 'directStages']) {
    metrics[field + 'Ms'] = Object.fromEntries(Object.entries(metrics[field]).map(([kind, values]) => [kind,
      { ...quantiles(values), mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null }]));
    delete metrics[field];
  }
  console.log(`RESULT ${JSON.stringify(metrics)}`);
  if (cleanupFailures.length) { console.log(`FAIL cleanup_incomplete RECOVERY=${recoveryDirectory}`); process.exitCode = 2; }
  else if (recoveryDirectory) { await rm(recoveryDirectory, { recursive: true, force: true }); console.log('PASS cleanup_complete'); }
}
}
