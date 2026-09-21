// User-authenticated, one-shot fast wake. Message commit and pg_net recovery are independent.
import { json } from './realtime.mjs';
import { directEventConfig } from './realtime-direct-event.mjs';
import { createLivePublishHandler, emitPublisherObservation } from './realtime-live-dispatch.mjs';
import { UUID } from './realtime-live.mjs';
import { regionalLiveCapability } from './realtime-region.mjs';
export const PUBLISHER_WAKE = Object.freeze({ endpoint: 'realtime-wake', protocolVersion: 1 });
// The DB still authorizes the existing capability. Only the advertised route
// changes; never accept an arbitrary DB endpoint as a client invocation target.
export function sharedPublisherWakeCapability(value) {
  const approved = regionalLiveCapability(value, PUBLISHER_WAKE);
  return approved ? { ...approved, endpoint: 'realtime-event/wake' } : undefined;
}
const statuses = new Map([['authentication_required',401],['active_session_required',401],['session_refresh_required',401],
  ['membership_required',403],['message_ownership_required',403],['publisher_wake_disabled',403],
  ['stale_realtime_epoch',409],['invalid_publish_wake',400],['publisher_wake_rate_limited',429]]);
const noopReasons = new Set(['duplicate','delivered','running','contended','disabled','unavailable']);
export function publishWakeInput(body) {
  const normalized = value => typeof value === 'string' ? value.toLowerCase() : '';
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 3
    || Object.keys(body).some(key => !['roomId','epoch','messageId'].includes(key))
    || !UUID.test(normalized(body.roomId)) || !UUID.test(normalized(body.messageId))
    || !Number.isSafeInteger(body.epoch) || body.epoch < 1) throw new Error('invalid_publish_wake');
  return { p_room_id: normalized(body.roomId), p_epoch: body.epoch, p_message_id: normalized(body.messageId) };
}
async function boundedJSON(response, limit) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('invalid_json');
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > limit) { await reader.cancel(); throw new Error('invalid_json'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function createPublishWakeHandler({ env, defer, fetcher = fetch, observe = _sample => {},
  monotonic = () => performance.now(), publish = createLivePublishHandler({ env, fetcher, observe, monotonic }) }) {
  // One publisher instance per warm isolate preserves its OAuth cache.
  return async request => {
    if (request.method !== 'POST') return json({error:'method_not_allowed'},405);
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ') || authorization.length > 16384) return json({error:'authentication_required'},401);
    try {
      if (!directEventConfig(env)) return json({error:'publisher_wake_disabled'},403);
      const secret = env('SIDEY_FIREBASE_LIVE_PUBLISH_SECRET');
      const key = env('SUPABASE_ANON_KEY') || env('SIDEY_SUPABASE_PUBLISHABLE_KEY');
      if (!key || !secret || secret.length < 32 || typeof defer !== 'function') throw new Error('wake_configuration');
      let parameters;
      try { parameters = publishWakeInput(await boundedJSON(request,1024)); }
      catch { return json({error:'invalid_publish_wake'},400); }
      const authorizeStarted = monotonic();
      let response, result;
      try { response = await fetcher(`${env('SUPABASE_URL')}/rest/v1/rpc/authorize_firebase_publish_wake`, {
        method:'POST', headers:{authorization,apikey:key,'content-type':'application/json'},body:JSON.stringify(parameters),
        redirect:'error',signal:AbortSignal.any([request.signal,AbortSignal.timeout(10000)]) });
      if (response.status === 401) { await response.body?.cancel(); return json({error:'authentication_required'},401); }
      result = await boundedJSON(response,4096);
      } finally { emitPublisherObservation(observe, 'wake_authorize', { authorizeMs: Math.max(0, monotonic() - authorizeStarted) }); }
      if (!response.ok) {
        const status = statuses.get(result?.message);
        return status ? json({error:result.message},status) : json({error:'realtime_wake_unavailable'},503);
      }
      if (noopReasons.has(result?.reason) && Object.keys(result).length === 1) {
        emitPublisherObservation(observe, `wake_noop_${result.reason}`, { accepted: false });
        return json({accepted:false,reason:result.reason});
      }
      if (result?.reason !== 'queued' || typeof result.dispatchId !== 'string' || !UUID.test(result.dispatchId)
          || Object.keys(result).length !== 2) throw new Error('invalid_wake_authorization');
      // Runtime-managed work outlives the caller's response/cancellation and uses
      // the publisher's own 20-second budget. No service HTTP request or secret
      // ever goes back to the client. pg_net races this exact queued dispatch.
      let registered = false, registeredAt;
      const work = Promise.resolve().then(async () => {
        if (!registered) return;
        emitPublisherObservation(observe, 'wake_inner_entry', { registrationToEntryMs: Math.max(0, monotonic() - registeredAt) });
        const published = await publish(new Request(`${env('SUPABASE_URL')}/functions/v1/realtime-publish-live`, {
          method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},
          body:JSON.stringify({dispatchId:result.dispatchId}) }), sample => {
            emitPublisherObservation(observe, sample.stage, { ...sample,
              ...(sample.stage === 'handler_admission' ? { registrationToAdmissionMs: Math.max(0, monotonic() - registeredAt) } : {}) });
          });
        await published.body?.cancel();
      }).catch(() => { emitPublisherObservation(observe, 'wake_inner_failed', { success: false }); });
      // Durable outbox/scheduler handles failure; never replay the message here.
      defer(work); registeredAt = monotonic(); registered = true;
      emitPublisherObservation(observe, 'wake_registered', { accepted: true });
      return json({accepted:true},202);
    } catch { return json({error:'realtime_wake_unavailable'},503); }
  };
}
