// Shared v2 wire/security helpers. No network activity at import time.
import { firebaseConfig, signJWT } from "./realtime.mjs";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REVISION = /^[1-9][0-9]{0,18}$/;
export const DB_KINDS = new Set(["message_changed", "structure_changed", "messages_pruned"]);
export const EVENT_KINDS = new Set(["typing_start", "typing_stop", "character_pulse", "character_throw"]);
export function liveFirebaseConfig(env) {
  if (env("SIDEY_FIREBASE_MODE") !== "live" || env("SIDEY_FIREBASE_LIVE_APPROVED") !== "true") return null;
  const config = firebaseConfig(key => key === "SIDEY_FIREBASE_MODE" ? "shadow"
    : key === "SIDEY_FIREBASE_SHADOW_APPROVED" ? "true" : env(key));
  const supabase = new URL(env("SUPABASE_URL"));
  if (supabase.protocol !== "https:" || supabase.pathname !== "/" || supabase.search || supabase.hash
      || supabase.username || supabase.password || supabase.port
      || !config.account.client_email.endsWith(`@${config.account.project_id}.iam.gserviceaccount.com`)) {
    throw new Error("live_environment_binding_mismatch");
  }
  return config;
}
export function liveRoomPath(room, epoch) {
  if (!UUID.test(room) || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error("invalid_live_room");
  return `v2/rooms/${room}/epochs/${epoch}`;
}
export async function liveCustomToken(account, uid, sessionId, now = Date.now()) {
  if (!UUID.test(uid) || !UUID.test(sessionId)) throw new Error("invalid_live_identity");
  const iat = Math.floor(now / 1000);
  return signJWT(account, { iss: account.client_email, sub: account.client_email,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat, exp: iat + 300, uid, claims: { sideySessionId: sessionId, sideyProtocol: 2 } });
}
export function liveFirebaseRequest(config, token, path, init = {}, fetcher = fetch) {
  if (!/^v2\/[a-zA-Z0-9/_-]+$/.test(path)) throw new Error("invalid_live_path");
  return fetcher(`${config.databaseURL}/${path}.json`, { ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), redirect: "error" });
}
export function validateAccess(value) {
  if (!value || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.epoch) || value.epoch < 1
      || !REVISION.test(value.revision) || typeof value.revision !== "string"
      || (value.members !== undefined && (!value.members || typeof value.members !== "object" || Array.isArray(value.members)))) {
    throw new Error("invalid_live_access");
  }
  const members = value.members ?? {};
  if (Object.keys(members).length > 12 || Object.entries(members).some(([uid, allowed]) => !UUID.test(uid) || allowed !== true)) {
    throw new Error("invalid_live_members");
  }
  return { enabled: value.enabled, epoch: value.epoch, revision: value.revision, members };
}
export function liveHint(row) {
  liveRoomPath(row.room_id, row.epoch);
  if (!UUID.test(row.event_id) || !DB_KINDS.has(row.kind) || typeof row.revision !== "string"
      || !REVISION.test(row.revision) || !Number.isFinite(Date.parse(row.occurred_at))) throw new Error("invalid_live_hint");
  return { protocolVersion: 2, eventId: row.event_id, kind: row.kind, roomId: row.room_id,
    epoch: row.epoch, revision: row.revision, occurredAt: row.occurred_at };
}
export function liveEvent(row) {
  liveRoomPath(row.room_id, row.epoch);
  const occurredAt = Date.parse(row.occurred_at);
  if (!UUID.test(row.event_id) || !EVENT_KINDS.has(row.kind) || typeof row.revision !== "string"
      || !REVISION.test(row.revision) || !Number.isFinite(occurredAt) || !row.payload
      || typeof row.payload !== "object" || Array.isArray(row.payload)
      || JSON.stringify(row.payload).length > 4096) throw new Error("invalid_live_event");
  return { kind: row.kind, payload: row.payload, occurredAt, expiresAt: occurredAt + 5000, revision: row.revision };
}
