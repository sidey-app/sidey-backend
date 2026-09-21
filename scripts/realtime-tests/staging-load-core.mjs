// Pure load-test primitives; importing never performs network or filesystem I/O.
export function loadOptions(args) {
  const options = { users: 10, holdSeconds: 120, byteLimit: 512 * 1024 * 1024, actionLimit: 30000, typingWorkload: 'historical' };
  if (args[0] !== '--run-explicit-staging') throw new Error('explicit_staging_required');
  const seen = new Set();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--users', '--hold-seconds', '--worker-host', '--worker-directory', '--publisher', '--typing-workload', '--direct-events', '--edge-region', '--observe'].includes(key) || seen.has(key) || !value) throw new Error('invalid_option');
    seen.add(key);
    if (key === '--observe') {
      if (value !== 'true') throw new Error('invalid_observe');
      options.observe = true;
    }
    else if (key === '--edge-region') {
      if (!['ap-northeast-2', 'ap-southeast-1'].includes(value)) throw new Error('invalid_edge_region');
      options.edgeRegion = value;
    }
    else if (key === '--direct-events') {
      if (value !== 'true') throw new Error('invalid_direct_events');
      options.directEvents = true;
    }
    else if (key === '--typing-workload') {
      if (value !== 'activity') throw new Error('invalid_typing_workload');
      options.typingWorkload = value;
    }
    else if (key === '--publisher') {
      if (value !== 'edge') throw new Error('invalid_publisher');
      options.edgePublisher = true;
    }
    else if (key === '--worker-host') options.workerHost = value;
    else if (key === '--worker-directory') options.workerDirectory = value;
    else {
      if (!/^\d+$/.test(value)) throw new Error('invalid_option');
      options[key === '--users' ? 'users' : 'holdSeconds'] = Number(value);
    }
  }
  if (!Number.isSafeInteger(options.users) || options.users < 2 || options.users > 2400
      || !Number.isSafeInteger(options.holdSeconds) || options.holdSeconds < 20 || options.holdSeconds > 900) throw new Error('unsafe_load_size');
  if (options.users > 500) {
    if (!options.edgePublisher || !options.directEvents || options.typingWorkload !== 'activity') {
      throw new Error('large_load_requires_edge_direct_activity');
    }
    if (options.holdSeconds > 600) throw new Error('large_load_duration_limit');
  }
  if (!!options.workerHost !== !!options.workerDirectory) throw new Error('incomplete_remote_worker');
  if (options.edgeRegion && !options.edgePublisher) throw new Error('region_requires_edge');
  if (options.directEvents && !options.edgePublisher) throw new Error('direct_events_require_edge');
  if (options.edgePublisher && options.workerHost) throw new Error('conflicting_publishers');
  if (options.workerHost && (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(options.workerHost)
      || !/^\/[a-zA-Z0-9_/-]+$/.test(options.workerDirectory) || options.workerDirectory.split('/').includes('..'))) throw new Error('invalid_remote_worker');
  if (options.holdSeconds > 180 && !options.workerHost && !options.edgePublisher) throw new Error('external_worker_required');
  if (options.holdSeconds <= 180) options.actionLimit = 5000;
  if (options.users > 500) {
    // This is a bounded workload profile, not authorization to increase Auth
    // request rates. The runner must independently verify approval and quotas.
    Object.assign(options, { largeScale: true, actionLimit: 120000, byteLimit: 2 * 1024 * 1024 * 1024,
      tokenStartIntervalMs: 250, provisionConcurrency: 8, rampConcurrency: 32, producerConcurrency: 64,
      renewalConcurrency: 32, presenceConcurrency: 48, finalReconcileConcurrency: 32, timelineLimit: 12000,
      preparationTimeoutMs: 45 * 60 * 1000, rampTimeoutMs: 15 * 60 * 1000, totalTimeoutMs: 90 * 60 * 1000 });
  }
  return options;
}

// Deterministic representative mix from the audited day. Aggregate proportions
// only: neither per-user activity nor maximum service capacity is inferred.
const EVENT_WEIGHTS = [['character_throw', 309545], ['typing_start', 219371],
  ['typing_stop', 129998], ['message', 106733], ['character_pulse', 35377]];
export function workloadKind(sequence, roomIndex = 0) {
  // A coprime step scatters kinds across both time and rooms without RNG variance.
  let value = ((sequence * 104729 + roomIndex * 7919 + 40000) % 801024 + 801024) % 801024;
  for (const [kind, weight] of EVENT_WEIGHTS) { if (value < weight) return kind; value -= weight; }
  throw new Error('invalid_workload_kind');
}

export class LoadBudget {
  constructor({ byteLimit, actionLimit, abort }) { Object.assign(this, { byteLimit, actionLimit, abort }); this.bytes = 0; this.actions = 0; }
  download(count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid_byte_count');
    this.bytes += count;
    if (this.bytes > this.byteLimit) { this.abort('download_budget'); throw new Error('download_budget'); }
  }
  action() {
    if (++this.actions > this.actionLimit) { this.abort('action_budget'); throw new Error('action_budget'); }
  }
}

// Observation remains complete after shutdown; budget enforcement is only an
// early-stop mechanism and must not discard the worker's final counters.
export class LoadTraffic {
  constructor(budget) { this.budget = budget; this.generator = 0; this.worker = 0; }
  addGenerator(count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid_byte_count');
    this.generator += count; this.budget.download(count);
  }
  updateWorker(total, enforce = true) {
    if (!Number.isSafeInteger(total) || total < this.worker) throw new Error('invalid_worker_byte_counter');
    const delta = total - this.worker; this.worker = total;
    if (enforce) this.budget.download(delta);
  }
  get total() { return this.generator + this.worker; }
}

export async function parallelMap(values, concurrency, operation) {
  let cursor = 0;
  // Wait for every started operation even after a failure. Cleanup may not race in-flight writes.
  let failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length && !failure) {
      const index = cursor++;
      try { await operation(values[index], index); } catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
}

export function quantiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = percentile => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)] : null;
  return { count: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) ?? null };
}

export class EventStreamParser {
  constructor(onEvent) { this.onEvent = onEvent; this.pending = ''; this.decoder = new TextDecoder(); }
  push(bytes) {
    this.pending += this.decoder.decode(bytes, { stream: true });
    this.pending = this.pending.replaceAll('\r\n', '\n');
    if (this.pending.length > 1024 * 1024) throw new Error('oversized_sse_frame');
    let boundary;
    while ((boundary = this.pending.indexOf('\n\n')) >= 0) {
      const frame = this.pending.slice(0, boundary); this.pending = this.pending.slice(boundary + 2);
      let name = 'message'; const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) this.onEvent({ name, data: ['cancel', 'auth_revoked'].includes(name) ? null : JSON.parse(data.join('\n')) });
    }
  }
}

export function firebaseRedirect(location, previous) {
  if (!location) throw new Error('missing_redirect');
  const next = new URL(location, previous);
  if (next.protocol !== 'https:' || next.username || next.password || next.port
      || !(next.hostname.endsWith('.firebaseio.com') || next.hostname.endsWith('.firebasedatabase.app'))) throw new Error('unsafe_redirect');
  return next;
}

const PROVIDER_ERROR_CODES = new Set([
  'CREDENTIAL_TOO_OLD_LOGIN_AGAIN', 'TOKEN_EXPIRED', 'INVALID_ID_TOKEN',
  'USER_NOT_FOUND', 'USER_DISABLED', 'INVALID_CUSTOM_TOKEN', 'CREDENTIAL_MISMATCH',
  'TOO_MANY_ATTEMPTS_TRY_LATER', 'QUOTA_EXCEEDED', 'RESOURCE_EXHAUSTED',
  'OPERATION_NOT_ALLOWED', 'INVALID_ARGUMENT', 'PERMISSION_DENIED', 'API_KEY_INVALID',
]);

// Error bodies can contain tokens, email addresses or request details. Return only
// a known constant code; never propagate the provider's free-form description.
export function providerErrorCode(body) {
  try {
    const error = JSON.parse(body)?.error;
    for (const value of [error?.message, error?.status]) {
      if (typeof value !== 'string') continue;
      const code = value.split(':', 1)[0].trim();
      if (PROVIDER_ERROR_CODES.has(code)) return code;
    }
  } catch { /* Non-JSON response bodies are intentionally not exposed. */ }
  return null;
}

export async function deleteOwnedFirebaseUser(user, { ownedIds, reauthenticate, deleteWithToken }) {
  if (!user?.firebaseAttempted || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(user.id || '')
      || !ownedIds.has(user.id)) throw new Error('firebase_cleanup_ownership_required');
  // Firebase account deletion requires recent authentication, even while an old
  // ID token is otherwise valid. Never reuse a token retained from the test ramp.
  const token = await reauthenticate(user);
  if (typeof token !== 'string' || token.length === 0) throw new Error('firebase_cleanup_token_missing');
  await deleteWithToken(token);
}

// Synthetic SIDEY-field edits only. No global keyboard observation or native UI claim.
export class TypingActivityPolicy {
  constructor({ baseline = false } = {}) {
    this.baseline = baseline; this.active = false; this.pendingAt = null;
    this.lastEdit = -Infinity; this.lastPublishedEdit = -Infinity; this.nextTick = Infinity;
    this.needsStop = false; this.inFlight = null; this.cancelledPending = 0;
  }
  edit(at) {
    this.lastEdit = at;
    if (this.pendingAt === null && (this.needsStop || this.inFlight?.kind === 'typing_stop'
        || (!this.active && !this.inFlight))) this.pendingAt = at + (this.baseline ? 0 : 500);
  }
  stop() {
    if (this.pendingAt !== null && !this.active && !this.inFlight) this.cancelledPending++;
    this.pendingAt = null;
    if (this.active || this.inFlight?.kind === 'typing_start') this.needsStop = true;
  }
  poll(now) {
    if (this.inFlight) return null;
    let reason;
    if (now - this.lastEdit >= 5000) {
      if (this.active) this.needsStop = true;
      else if (this.pendingAt !== null) this.stop();
    }
    if (this.needsStop) reason = 'stop';
    else if (this.pendingAt !== null && now >= this.pendingAt) reason = 'initial';
    else if (this.active && now >= this.nextTick) {
      this.nextTick = now + 2000;
      if (this.baseline || this.lastEdit > this.lastPublishedEdit) reason = 'keepalive';
    }
    if (!reason) return null;
    if (reason === 'initial') this.pendingAt = null;
    return this.inFlight = { kind: reason === 'stop' ? 'typing_stop' : 'typing_start', reason, editCutoff: this.lastEdit };
  }
  acknowledge(action, at) {
    if (action !== this.inFlight) throw new Error('invalid_typing_acknowledgement');
    this.inFlight = null; this.lastPublishedEdit = action.editCutoff;
    if (action.kind === 'typing_stop') { this.active = false; this.needsStop = false; this.nextTick = Infinity; }
    else { this.active = true; this.nextTick = at + 2000; }
  }
}

export function typingActivityTrace(durationMs, roomIndex = 0) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 900000
      || !Number.isSafeInteger(roomIndex) || roomIndex < 0) throw new Error('invalid_typing_trace');
  const trace = [], phase = (roomIndex % 10) * 50;
  const cycle = [{ at: 0, kind: 'edit', scenario: 'short' }, { at: 200, kind: 'stop', scenario: 'short' }];
  for (let at = 1000; at <= 4600; at += 600) cycle.push({ at, kind: 'edit', scenario: 'continuous_then_idle' });
  for (const at of [11000, 11400, 12000, 12400]) cycle.push({ at, kind: 'edit', scenario: 'resume' });
  cycle.push({ at: 13000, kind: 'stop', scenario: 'resume' });
  for (let start = phase; start < durationMs; start += 20000) {
    for (const item of cycle) if (start + item.at < durationMs) trace.push({ ...item, at: start + item.at });
  }
  // A run boundary closes the current input explicitly; no typing survives into the next run.
  trace.push({ at: durationMs, kind: 'stop', scenario: 'run_end' });
  return trace;
}

export function simulateTypingActivity(trace, durationMs, baseline = false) {
  const policy = new TypingActivityPolicy({ baseline }), counts = { initial: 0, keepalive: 0, stop: 0, total: 0 };
  let cursor = 0;
  // Inputs win ties over timers: submit at exactly the debounce deadline cancels it.
  for (let now = 0; now <= durationMs; now += 50) {
    while (cursor < trace.length && trace[cursor].at <= now) {
      const item = trace[cursor++]; if (item.kind === 'edit') policy.edit(item.at); else policy.stop();
    }
    const action = policy.poll(now);
    if (action) { counts[action.reason]++; counts.total++; policy.acknowledge(action, now); }
  }
  return { ...counts, cancelledPending: policy.cancelledPending };
}

// A capability must be supplied by the authenticated bootstrap, including renewals.
export function requireDirectCapability(value) {
  if (value?.directEvents?.endpoint !== 'realtime-event' || value.directEvents.protocolVersion !== 1) {
    throw new Error('direct_capability_missing');
  }
}

export function requirePublisherWakeCapability(value, expectedEndpoint) {
  if (!['realtime-wake', 'realtime-event/wake'].includes(value?.publisherWake?.endpoint) || value.publisherWake.protocolVersion !== 1
      || expectedEndpoint !== undefined && value.publisherWake.endpoint !== expectedEndpoint) {
    throw new Error('publisher_wake_capability_missing');
  }
  return value.publisherWake.endpoint;
}

export function directEventBody({ roomId, epoch, eventId, kind, targetUserId, sequence }) {
  const body = { roomId, epoch, eventId, kind, payload: kind === 'character_throw' ? { target_user_id: targetUserId } : {} };
  if (kind === 'typing_start' || kind === 'typing_stop') {
    if (typeof sequence !== 'bigint' || sequence < 1n || sequence > 9223372036854775807n) throw new Error('invalid_typing_sequence');
    body.sequence = sequence.toString();
  }
  return body;
}

export function directEventTimings(timing, roundTripMs) {
  const keys = ['dbValidationMs', 'googleAuthMs', 'rtdbWriteMs', 'handlerMs'];
  if (!Number.isFinite(roundTripMs) || roundTripMs < 0 || !timing || keys.some(key => !Number.isFinite(timing[key]) || timing[key] < 0)) {
    throw new Error('direct_timing_missing');
  }
  const optional = ['dbHeadersMs', 'dbBodyMs'].filter(key => Number.isFinite(timing[key]) && timing[key] >= 0);
  return { ...Object.fromEntries([...keys, ...optional].map(key => [key, timing[key]])), roundTripMs,
    // Includes transport, provider queue/cold work and clock/measurement error;
    // provider ingress timestamps are required to isolate pre-execution queue.
    roundTripResidualMs: roundTripMs - timing.handlerMs };
}

export function deliveryLatencyGate(latencyByKind) {
  return Object.fromEntries(['message', 'character_throw'].map(kind => {
    const observed = quantiles(latencyByKind[kind] ?? []);
    return [kind, { ...observed, passed: observed.count > 0 && observed.p95 <= 500 && observed.p99 <= 1000 }];
  }));
}

// Practical staging acceptance requested after the original aspirational target.
// Keep deliveryLatencyGate's 500/1000ms result separately; never relabel it PASS.
export function practicalDeliveryLatencyGate(latencyByKind) {
  return Object.fromEntries(['message', 'character_throw'].map(kind => {
    const observed = quantiles(latencyByKind[kind] ?? []);
    return [kind, { ...observed, passed: observed.count > 0 && observed.p95 <= 1000 && observed.p99 <= 1500 }];
  }));

}
