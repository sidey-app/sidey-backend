// One authenticated DB validation and one immutable RTDB write. Never queues or retries.
import { json } from "./realtime.mjs";
import { createGoogleAccessTokenCache } from "./realtime-google-token.mjs";
import { stagingLivePublisherConfig } from "./realtime-live-dispatch.mjs";
import { UUID, REVISION, EVENT_KINDS, liveEvent, liveRoomPath, liveFirebaseRequest } from "./realtime-live.mjs";
import { parsePostgrestServerTiming } from "./realtime-server-timing.mjs";

export const DIRECT_EVENTS = Object.freeze({ endpoint: "realtime-event", protocolVersion: 1 });
const errors = new Map([
  ["authentication_required", 401], ["active_session_required", 401], ["session_refresh_required", 401],
  ["membership_required", 403], ["target_membership_required", 403], ["direct_events_disabled", 403],
  ["stale_realtime_epoch", 409], ["stale_typing_sequence", 409], ["duplicate_event", 409],
  ["realtime_event_rate_limited", 429], ["invalid_realtime_event", 400],
]);
class EventError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
export function directEventConfig(env) {
  return env("SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED") === "true" ? stagingLivePublisherConfig(env) : null;
}
const normalizedUUID = value => typeof value === "string" ? value.toLowerCase() : value;
export function directEventInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => !["roomId", "epoch", "eventId", "kind", "payload", "sequence"].includes(key))
      || !UUID.test(normalizedUUID(body.roomId)) || !UUID.test(normalizedUUID(body.eventId)) || !Number.isSafeInteger(body.epoch) || body.epoch < 1
      || !EVENT_KINDS.has(body.kind) || !body.payload || typeof body.payload !== "object" || Array.isArray(body.payload)) {
    throw new EventError("invalid_realtime_event", 400);
  }
  const typing = body.kind === "typing_start" || body.kind === "typing_stop";
  if (typing ? typeof body.sequence !== "string" || !REVISION.test(body.sequence) || BigInt(body.sequence) > 9223372036854775807n
    : body.sequence !== undefined) throw new EventError("invalid_realtime_event", 400);
  const keys = Object.keys(body.payload);
  if (body.kind === "character_throw" ? keys.length !== 1 || keys[0] !== "target_user_id" || !UUID.test(normalizedUUID(body.payload.target_user_id))
    : keys.length !== 0) throw new EventError("invalid_realtime_event", 400);
  return { p_room_id: normalizedUUID(body.roomId), p_epoch: body.epoch, p_event_id: normalizedUUID(body.eventId), p_kind: body.kind,
    p_target_user_id: normalizedUUID(body.payload.target_user_id) ?? null, p_sequence: body.sequence ?? null };
}
async function boundedJSON(response, limit = 8192) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty_response");
  let size = 0; const chunks = [];
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new EventError("invalid_realtime_event", 400); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function createDirectEventHandler({ env, fetcher = fetch, now = Date.now, monotonic = () => performance.now(),
  accessToken = createGoogleAccessTokenCache({ now }) }) {
  return async request => {
    const entered = monotonic();
    const timing = { dbValidationMs: 0, dbHeadersMs: 0, dbBodyMs: 0, googleAuthMs: 0, rtdbWriteMs: 0, handlerMs: 0 };
    let dbServerTiming;
    const reply = (body, status = 200) => {
      timing.handlerMs = Math.max(0, monotonic() - entered);
      // Provider queue/cold execution before this entry and peer reception are measured by the harness separately.
      return json({ ...body, timing, ...(dbServerTiming ? { dbServerTiming } : {}) }, status);
    };
    if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.length > 16384) return reply({ error: "authentication_required" }, 401);
    let failureStage = "configuration", upstreamStatus, signal, failureCode = "internal";
    try {
      const config = directEventConfig(env);
      if (!config) return reply({ error: "direct_events_disabled" }, 403);
      failureStage = "input";
      let body;
      try { body = await boundedJSON(request, 4096); }
      catch { throw new EventError("invalid_realtime_event", 400); }
      const parameters = directEventInput(body);
      signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
      const key = env("SUPABASE_ANON_KEY") || env("SIDEY_SUPABASE_PUBLISHABLE_KEY");
      if (!key) throw new Error("missing_public_key");
      failureStage = "db_validation";
      let started = monotonic(), response, row;
      try {
        // PostgREST verifies the user's JWT; SQL checks session, enrollment, membership, epoch, rights and rate limits.
        failureCode = "transport";
        try {
          response = await fetcher(`${env("SUPABASE_URL")}/rest/v1/rpc/authorize_firebase_direct_event`, {
            method: "POST", headers: { authorization, apikey: key, "content-type": "application/json" },
            body: JSON.stringify(parameters), signal, redirect: "error" });
        } finally { timing.dbHeadersMs = Math.max(0, monotonic() - started); }
        upstreamStatus = response.status;
        const parsedTiming = parsePostgrestServerTiming(response.headers.get("server-timing"));
        if (Object.keys(parsedTiming).length) dbServerTiming = parsedTiming;
        const bodyStarted = monotonic();
        try { row = await boundedJSON(response); }
        catch (error) { failureCode = error instanceof SyntaxError ? "invalid_response" : "transport"; throw error; }
        finally { timing.dbBodyMs = Math.max(0, monotonic() - bodyStarted); }
      } finally { timing.dbValidationMs = Math.max(0, monotonic() - started); }
      if (!response.ok) {
        failureCode = "http";
        if (response.status === 401) throw new EventError("authentication_required", 401);
        const status = errors.get(row?.message);
        if (status) throw new EventError(status === 401 ? "authentication_required" : row.message, status);
        throw new Error("validation_unavailable");
      }
      failureStage = "authorized_event"; upstreamStatus = undefined; failureCode = "internal";
      if (row?.room_id !== parameters.p_room_id || row?.epoch !== body.epoch || row?.event_id !== parameters.p_event_id || row?.kind !== body.kind) {
        throw new Error("invalid_authorized_event");
      }
      const event = liveEvent(row);
      if (event.occurredAt > now() + 1000 || event.expiresAt <= now()) throw new EventError("event_expired", 410);
      failureStage = "google_auth";
      failureCode = "transport";
      started = monotonic(); let token;
      try { token = await accessToken(config.account, { fetcher: async (...args) => {
        const result = await fetcher(...args); upstreamStatus = result.status;
        if (!result.ok) failureCode = "http";
        return result;
      }, signal }); }
      finally { timing.googleAuthMs = Math.max(0, monotonic() - started); }
      signal.throwIfAborted();
      // Recheck after OAuth, immediately before the sole RTDB request. Never extends SQL's TTL.
      if (event.expiresAt <= now()) throw new EventError("event_expired", 410);
      failureStage = "rtdb_write"; upstreamStatus = undefined;
      failureCode = "transport";
      started = monotonic();
      try {
        const written = await liveFirebaseRequest(config, token, `${liveRoomPath(row.room_id, row.epoch)}/events/${row.event_id}`, {
          method: "PUT", headers: { "if-match": "null_etag" }, body: JSON.stringify(event), signal }, fetcher);
        upstreamStatus = written.status;
        await written.body?.cancel();
        if (written.status === 412) throw new EventError("duplicate_event", 409);
        if (!written.ok) { failureCode = "http"; throw new Error("event_write_failed"); }
      } finally { timing.rtdbWriteMs = Math.max(0, monotonic() - started); }
      return reply({ published: true, eventId: row.event_id, revision: row.revision });
    } catch (error) {
      return reply({ error: error instanceof EventError ? error.message : "realtime_event_unavailable",
        ...(error instanceof EventError ? {} : { failureStage,
          failureCode: signal?.aborted ? (signal.reason?.name === "TimeoutError" ? "timeout" : "aborted")
            : error?.name === "TimeoutError" ? "timeout" : error?.name === "AbortError" ? "aborted" : failureCode,
          ...(Number.isInteger(upstreamStatus) ? { upstreamStatus } : {}) }) },
        error instanceof EventError ? error.status : 503);
    }
  };
}
