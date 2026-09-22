"use strict";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ITEM_PATTERN = /^throwable_[a-z0-9_]{1,60}$/;
const WIRE_ITEM_PATTERN = /^(0|[1-9][0-9]{0,5})$/;
const MAX_ACTIVE_SESSIONS = 16;
const MAX_SOURCE_SESSIONS = 128;
const ROLLOUT_PROTOCOL_VERSION = 2;
const ROLLOUT_CONTRACT_HASH =
  "3c836b40cfc44437e9d069b84787cd3d8793026ce40de46d82b9ece79127b7e5";
const MAX_ROLLOUT_LEASE_MS = 300_000;

class SupabaseBridgeError extends Error {
  constructor(code, {permanent = false, status = 0} = {}) {
    super(code);
    this.name = "SupabaseBridgeError";
    this.code = code;
    this.permanent = permanent;
    this.status = status;
  }
}

function normalizeConfig(config) {
  if (!config || typeof config !== "object") {
    throw new SupabaseBridgeError("supabase_config_missing");
  }
  const url = typeof config.url === "string" ? config.url.replace(/\/$/, "") : "";
  const serviceRoleKey = config.serviceRoleKey;
  if (!url.startsWith("https://") || typeof serviceRoleKey !== "string" || serviceRoleKey.length < 20) {
    throw new SupabaseBridgeError("supabase_config_invalid");
  }
  return {url, serviceRoleKey};
}

function publishableConfig(config) {
  const normalized = normalizeConfig(config);
  if (typeof config.publishableKey !== "string" || config.publishableKey.length < 20) {
    throw new SupabaseBridgeError("supabase_publishable_key_invalid");
  }
  return {...normalized, publishableKey: config.publishableKey};
}

function serviceHeaders(serviceRoleKey) {
  const headers = {apikey: serviceRoleKey};
  // New Supabase secret keys are opaque API keys, not JWTs. Sending one as a
  // Bearer credential makes downstream JWT handling ambiguous and is
  // explicitly unsupported. Preserve legacy service_role JWT compatibility
  // while production migrates to the scoped secret key.
  if (!serviceRoleKey.startsWith("sb_secret_")) {
    headers.authorization = `Bearer ${serviceRoleKey}`;
  }
  return headers;
}

async function responseJson(response, code) {
  try {
    return await response.json();
  } catch {
    throw new SupabaseBridgeError(code, {status: response.status});
  }
}

async function verifySupabaseUser(config, authorization, fetchImpl = fetch) {
  const {url, publishableKey} = publishableConfig(config);
  const token = typeof authorization === "string" ? authorization.slice(7) : "";
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ") ||
    authorization.length > 16_384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new SupabaseBridgeError("authentication_required", {permanent: true, status: 401});
  }
  let response;
  try {
    response = await fetchImpl(`${url}/auth/v1/user`, {
      headers: {apikey: publishableKey, authorization},
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SupabaseBridgeError("supabase_auth_unavailable");
  }
  const payload = await responseJson(response, "supabase_auth_invalid_response");
  if (!response.ok || typeof payload?.id !== "string" || !UUID_PATTERN.test(payload.id)) {
    throw new SupabaseBridgeError("authentication_required", {
      permanent: response.status === 401 || response.status === 403,
      status: response.status,
    });
  }
  // /auth/v1/user above verifies this JWT before any claim is trusted.
  let claims;
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    throw new SupabaseBridgeError("authentication_required", {permanent: true});
  }
  if (claims.sub !== payload.id || !UUID_PATTERN.test(claims.session_id || "")) {
    throw new SupabaseBridgeError("authentication_required", {permanent: true});
  }
  return {id: payload.id.toLowerCase(), sessionId: claims.session_id.toLowerCase()};
}

async function accessRpc(config, name, args, fetchImpl = fetch) {
  const {url, serviceRoleKey} = normalizeConfig(config);
  let response;
  try {
    response = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        ...serviceHeaders(serviceRoleKey),
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SupabaseBridgeError("supabase_access_unavailable");
  }
  const payload = await responseJson(response, "supabase_access_invalid_response");
  if (!response.ok) {
    throw new SupabaseBridgeError("supabase_access_failed", {status: response.status});
  }
  return payload;
}

function parseAccessSnapshot(payload, userId) {
  if (
    typeof userId !== "string" || !UUID_PATTERN.test(userId) ||
    payload?.user_id !== userId ||
    typeof payload.revision !== "string" || !/^[0-9]{20}$/.test(payload.revision) ||
    typeof payload.active !== "boolean" ||
    !payload.sessions || typeof payload.sessions !== "object" || Array.isArray(payload.sessions) ||
    Object.keys(payload.sessions).length > MAX_SOURCE_SESSIONS ||
    Object.entries(payload.sessions).some(([id, expires]) =>
      !UUID_PATTERN.test(id) || !Number.isSafeInteger(expires) || expires <= 0) ||
    !Array.isArray(payload.rooms) ||
    payload.rooms.length > 5 ||
    payload.rooms.some((roomId) => typeof roomId !== "string" || !UUID_PATTERN.test(roomId)) ||
    !Array.isArray(payload.items) ||
    payload.items.length > 20 ||
    payload.items.some((itemId) => typeof itemId !== "string" || !ITEM_PATTERN.test(itemId)) ||
    !Array.isArray(payload.wire_items) ||
    (payload.active ? payload.wire_items.length !== 1 : payload.wire_items.length > 1) ||
    payload.wire_items.some((itemId) =>
      typeof itemId !== "string" || !WIRE_ITEM_PATTERN.test(itemId))
  ) {
    throw new SupabaseBridgeError("supabase_access_mismatch");
  }
  const selectedSessions = Object.entries(payload.sessions)
    .sort(([leftId, leftExpiry], [rightId, rightExpiry]) => {
      if (leftExpiry !== rightExpiry) return leftExpiry > rightExpiry ? -1 : 1;
      return leftId.localeCompare(rightId);
    })
    .slice(0, MAX_ACTIVE_SESSIONS);
  return {
    userId,
    revision: payload.revision,
    active: payload.active,
    // Auth can temporarily contain more sessions than the compact RTDB wire
    // contract. Select a stable expiry-priority 16 instead of quarantining
    // every session for that user; Gate 2 adds the source-side lifecycle policy.
    sessions: Object.fromEntries(selectedSessions),
    rooms: [...new Set(payload.rooms.map((roomId) => roomId.toLowerCase()))],
    items: [...new Set(payload.items)],
    wireItems: [...new Set(payload.wire_items)],
  };
}

async function getRealtimeAccess(config, userId, fetchImpl = fetch) {
  if (typeof userId !== "string" || !UUID_PATTERN.test(userId)) {
    throw new SupabaseBridgeError("invalid_user_id", {permanent: true});
  }
  return parseAccessSnapshot(
    await accessRpc(config, "firebase_access_snapshot", {p_user_id: userId}, fetchImpl), userId,
  );
}

async function getRealtimeBootstrapAuthorization(
    config, userId, sessionId, fetchImpl = fetch, now = Date.now()) {
  if (!UUID_PATTERN.test(userId || "") || !UUID_PATTERN.test(sessionId || "") ||
      !Number.isSafeInteger(now) || now <= 0) {
    throw new SupabaseBridgeError("authentication_required", {permanent: true});
  }
  const payload = await accessRpc(config, "firebase_realtime_bootstrap_authorization", {
    p_user_id: userId,
    p_session_id: sessionId,
  }, fetchImpl);
  if (payload?.allowed !== true) {
    throw new SupabaseBridgeError("realtime_rollout_disabled", {permanent: true});
  }
  if (
    payload.protocolVersion !== ROLLOUT_PROTOCOL_VERSION ||
    payload.contractHash !== ROLLOUT_CONTRACT_HASH ||
    !Number.isSafeInteger(payload.leaseExpiresAt) ||
    payload.leaseExpiresAt <= now ||
    payload.leaseExpiresAt > now + MAX_ROLLOUT_LEASE_MS + 5_000
  ) {
    throw new SupabaseBridgeError("realtime_rollout_invalid");
  }
  return {
    leaseExpiresAt: payload.leaseExpiresAt,
    protocolVersion: payload.protocolVersion,
    contractHash: payload.contractHash,
  };
}

async function persistRealtimeMessage(config, command, fetchImpl = fetch) {
  const {url, serviceRoleKey} = normalizeConfig(config);
  let response;
  try {
    response = await fetchImpl(`${url}/rest/v1/rpc/firebase_persist_realtime_message`, {
      method: "POST",
      headers: {
        ...serviceHeaders(serviceRoleKey),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        p_id: command.messageId,
        p_room_id: command.roomId,
        p_sender_id: command.senderId,
        p_session_id: command.sessionId,
        p_body: command.body,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new SupabaseBridgeError("supabase_unavailable", {status: 0, cause: error});
  }

  const payload = await responseJson(response, "supabase_invalid_response");
  if (!response.ok) {
    const code = typeof payload?.message === "string" ? payload.message : "supabase_request_failed";
    throw new SupabaseBridgeError(code, {
      permanent: response.status < 500 && response.status !== 429,
      status: response.status,
    });
  }
  return payload;
}

module.exports = {
  SupabaseBridgeError,
  accessRpc,
  parseAccessSnapshot,
  getRealtimeAccess,
  getRealtimeBootstrapAuthorization,
  MAX_ACTIVE_SESSIONS,
  MAX_SOURCE_SESSIONS,
  MAX_ROLLOUT_LEASE_MS,
  ROLLOUT_CONTRACT_HASH,
  ROLLOUT_PROTOCOL_VERSION,
  serviceHeaders,
  persistRealtimeMessage,
  verifySupabaseUser,
};
