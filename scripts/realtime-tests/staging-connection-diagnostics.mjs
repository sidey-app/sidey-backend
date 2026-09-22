// Synthetic ordinals and relative times only. No import I/O or delivery decisions.
const stages = new Set(['stream_open', 'stream_closed', 'reconnect_start', 'reconnect_success', 'reconnect_failed', 'renewal_success']);
const kinds = new Set(['message', 'typing_start', 'typing_stop', 'character_pulse', 'character_throw']);
const numbers = new Set(['streamAgeMs', 'lastChunkAgeMs', 'lastDataFrameAgeMs', 'leaseRemainingMs', 'idTokenRemainingMs',
  'durationMs', 'oldLeaseRemainingMs', 'newLeaseRemainingMs']);
const ordinal = value => Number.isSafeInteger(value) && value >= 0 && value < 100000;
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e12;
const timestamp = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 1e15;
function safeReason(value) {
  if (typeof value !== 'string') return 'unclassified';
  return ['sse_ended', 'sse_network_error', 'sse_open_timeout', 'sse_initial_timeout', 'sse_closed_before_initial',
    'sse_authorization_expired', 'sse_permission_revoked', 'sse_invalid_content_type', 'stream_reconnect_exhausted',
    'stream_recovery_budget_exhausted', 'download_budget', 'action_budget'].includes(value)
    || /^sse_http_[1-5][0-9]{2}$/.test(value ?? '') ? value : 'unclassified';
}

export class LoadConnectionDiagnostics {
  constructor({ timelineLimit = 2000, missingLimit = 200, now = Date.now, emit = () => {} } = {}) {
    if (!Number.isSafeInteger(timelineLimit) || timelineLimit < 1 || timelineLimit > 12000
        || !Number.isSafeInteger(missingLimit) || missingLimit < 1 || missingLimit > 1000) throw new Error('invalid_diagnostic_limit');
    Object.assign(this, { now, emit, timelineLimit, missingLimit });
    this.times = []; this.holdAt = undefined;
    this.report = { timelineLimit, missingLimit, timeline: [], timelineOverflow: 0, missing: [], missingOverflow: 0,
      note: 'Zero-based synthetic ordinals; times relative to workload hold. Null elapsed means hold never started. Missing/connection proximity is correlation, not cause. Truncated history cannot establish connection state.' };
  }
  startHold(at) {
    if (!timestamp(at) || this.holdAt !== undefined) return;
    this.holdAt = at;
    this.report.timeline.forEach((sample, index) => { sample.elapsedMs = this.times[index] - at; });
  }
  record(stage, values, at = this.now()) {
    if (!stages.has(stage) || !timestamp(at) || !ordinal(values?.userIndex) || !ordinal(values?.roomIndex)) return;
    const sample = { stage, elapsedMs: this.holdAt === undefined ? null : at - this.holdAt,
      userIndex: values.userIndex, roomIndex: values.roomIndex };
    for (const key of ['streamIndex', 'attempt']) if (ordinal(values[key])) sample[key] = values[key];
    for (const key of numbers) if (finite(values[key])) sample[key] = values[key];
    for (const key of ['renewing', 'final']) if (typeof values[key] === 'boolean') sample[key] = values[key];
    if (values.reason !== undefined) sample.reason = safeReason(values.reason);
    if (this.report.timeline.length < this.timelineLimit) { this.report.timeline.push(sample); this.times.push(at); }
    else this.report.timelineOverflow++;
    // Every unexpected close gets an immediate safe line, even if retained
    // history is full. Existing per-user recovery/run limits bound close count.
    if (stage === 'stream_closed') {
      try { this.emit({ ...sample })?.catch?.(() => {}); } catch { /* Diagnostics never alter stream recovery. */ }
    }
  }
  missing(kind, sentAt, recipient, verificationAt = this.now()) {
    if (!kinds.has(kind) || !timestamp(sentAt) || !timestamp(verificationAt)
        || !ordinal(recipient?.userIndex) || !ordinal(recipient?.roomIndex)) return;
    if (this.report.missing.length >= this.missingLimit) { this.report.missingOverflow++; return; }
    const sentElapsedMs = this.holdAt === undefined ? null : sentAt - this.holdAt;
    const sample = { kind, sentElapsedMs, userIndex: recipient.userIndex, roomIndex: recipient.roomIndex,
      verificationElapsedMs: this.holdAt === undefined ? null : verificationAt - this.holdAt,
      historyTruncated: this.report.timelineOverflow > 0 };
    if (typeof recipient.connected === 'boolean') sample.connectedAtVerification = recipient.connected;
    if (ordinal(recipient.streamIndex)) sample.streamIndexAtVerification = recipient.streamIndex;
    const history = this.report.timeline.filter(value => value.userIndex === recipient.userIndex
      && value.roomIndex === recipient.roomIndex && ['stream_open', 'stream_closed'].includes(value.stage)
      && value.elapsedMs !== null);
    if (!sample.historyTruncated && sentElapsedMs !== null) {
      const before = history.filter(value => value.elapsedMs <= sentElapsedMs).at(-1);
      sample.hasConnectionHistory = !!before;
      if (before) {
        sample.connectedAtSend = before.stage === 'stream_open';
        sample.streamIndexAtSend = before.streamIndex;
      }
      const previousClose = history.filter(value => value.stage === 'stream_closed' && value.elapsedMs <= sentElapsedMs).at(-1);
      const nextClose = history.find(value => value.stage === 'stream_closed' && value.elapsedMs >= sentElapsedMs);
      if (previousClose) sample.previousCloseBeforeSentMs = sentElapsedMs - previousClose.elapsedMs;
      if (nextClose) sample.nextCloseAfterSentMs = nextClose.elapsedMs - sentElapsedMs;
    }
    this.report.missing.push(sample);
  }
}
