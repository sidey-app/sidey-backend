"use strict";

const {createHash, randomUUID} = require("node:crypto");
const {SupabaseBridgeError, accessRpc} = require("./supabase");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WIRE_CODE_PATTERN = /^(0|[1-9][0-9]{0,5})$/;
const TRANSIENT_KINDS = new Set([
  "typing_start", "typing_stop", "character_pulse", "character_throw",
]);
const TRANSIENT_FRESHNESS_MS = 5_000;
const BATCH_SIZE = 100;

function stableEventUuid(cloudEventId, kind) {
  if (typeof cloudEventId !== "string" || cloudEventId.length < 1 || cloudEventId.length > 512 ||
      !TRANSIENT_KINDS.has(kind)) {
    throw new Error("invalid_transient_event_identity");
  }
  const bytes = createHash("sha256")
    .update(`sidey-firebase-transient-v2\0${kind}\0${cloudEventId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)}-${hex.slice(20)}`;
}

function eventTimestamp(event) {
  const parsed = Date.parse(event?.time);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("invalid_transient_event_time");
  }
  return parsed;
}

function snapshotValue(snapshot) {
  return snapshot?.exists() ? snapshot.val() : null;
}

function parseClientTransientWrite(event, family) {
  if (!["typing", "pulse", "throw"].includes(family)) {
    throw new Error("invalid_transient_family");
  }
  if (event?.authType === "admin") return null;
  if (event?.authType !== "app_user") {
    throw new Error("invalid_transient_auth");
  }
  const roomId = event?.params?.roomId;
  const actorId = event?.params?.uid;
  const sessionId = event?.params?.sessionId ?? null;
  if (!UUID_PATTERN.test(roomId || "") || !UUID_PATTERN.test(actorId || "") ||
      (family === "typing" && !UUID_PATTERN.test(sessionId || "")) ||
      (family !== "typing" && sessionId !== null) || event?.authId !== actorId) {
    throw new Error("invalid_transient_actor");
  }

  const before = snapshotValue(event?.data?.before);
  const after = snapshotValue(event?.data?.after);
  let kind;
  let targetUserId = null;
  let wireCode = null;
  let occurredAtMs;
  if (family === "typing") {
    if (after === null) {
      if (!Number.isSafeInteger(before) || before <= 0) return null;
      kind = "typing_stop";
      occurredAtMs = eventTimestamp(event);
    } else {
      if (!Number.isSafeInteger(after) || after <= 0) {
        throw new Error("invalid_transient_payload");
      }
      kind = "typing_start";
      occurredAtMs = after;
    }
  } else if (family === "pulse") {
    if (after === null) return null;
    if (!Number.isSafeInteger(after) || after <= 0) {
      throw new Error("invalid_transient_payload");
    }
    kind = "character_pulse";
    occurredAtMs = after;
  } else {
    if (after === null) return null;
    if (!after || typeof after !== "object" || Array.isArray(after) ||
        Object.keys(after).sort().join(",") !== "k,t,u" ||
        !UUID_PATTERN.test(after.u || "") || after.u === actorId ||
        !WIRE_CODE_PATTERN.test(after.k || "") ||
        !Number.isSafeInteger(after.t) || after.t <= 0) {
      throw new Error("invalid_transient_payload");
    }
    kind = "character_throw";
    targetUserId = after.u.toLowerCase();
    wireCode = after.k;
    occurredAtMs = after.t;
  }

  return {
    eventId: stableEventUuid(event.id, kind),
    roomId: roomId.toLowerCase(),
    actorId: actorId.toLowerCase(),
    sessionId: sessionId?.toLowerCase() ?? null,
    kind,
    targetUserId,
    wireCode,
    occurredAtMs,
  };
}

async function bridgeClientTransient(event, family, config, rpc = accessRpc) {
  let transient;
  try {
    transient = parseClientTransientWrite(event, family);
  } catch (error) {
    if (typeof error?.message === "string" && error.message.startsWith("invalid_transient_")) {
      return {skipped: true, reason: "invalid_event"};
    }
    throw error;
  }
  if (transient === null) return {skipped: true};
  try {
    return await rpc(config, "bridge_firebase_transient_to_legacy", {
      p_event_id: transient.eventId,
      p_room_id: transient.roomId,
      p_actor_id: transient.actorId,
      p_session_id: transient.sessionId,
      p_kind: transient.kind,
      p_target_user_id: transient.targetUserId,
      p_wire_code: transient.wireCode,
      p_occurred_at_ms: transient.occurredAtMs,
    });
  } catch (error) {
    if (error instanceof SupabaseBridgeError && error.status >= 400 && error.status < 500) {
      return {skipped: true, reason: "rejected"};
    }
    throw error;
  }
}

function parseTransientJob(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isSafeInteger(value.id) || value.id < 1 ||
      !UUID_PATTERN.test(value.event_id || "") ||
      !UUID_PATTERN.test(value.room_id || "") ||
      !UUID_PATTERN.test(value.actor_id || "") ||
      !TRANSIENT_KINDS.has(value.kind) ||
      !Number.isSafeInteger(value.occurred_at_ms) || value.occurred_at_ms <= 0 ||
      !UUID_PATTERN.test(value.session_id || "") ||
      (value.kind === "character_throw" &&
        (!UUID_PATTERN.test(value.target_user_id || "") ||
         value.target_user_id === value.actor_id ||
         !WIRE_CODE_PATTERN.test(value.wire_code || ""))) ||
      (value.kind !== "character_throw" &&
        (value.target_user_id !== null || value.wire_code !== null))) {
    throw new Error("invalid_transient_job");
  }
  return {
    id: value.id,
    eventId: value.event_id.toLowerCase(),
    roomId: value.room_id.toLowerCase(),
    actorId: value.actor_id.toLowerCase(),
    sessionId: value.session_id?.toLowerCase() ?? null,
    kind: value.kind,
    targetUserId: value.target_user_id?.toLowerCase() ?? null,
    wireCode: value.wire_code,
    occurredAtMs: value.occurred_at_ms,
  };
}

function parseRemoteTimestamp(value, code) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

async function applyTransientJob(database, job) {
  if ((await database.ref(`/v2/a/g/e`).get()).val() !== true ||
      (await database.ref(`/v2/a/d/${job.roomId}`).get()).val() !== null) {
    return false;
  }
  if (job.kind === "typing_start" || job.kind === "typing_stop") {
    const ref = database.ref(`/v2/l/${job.roomId}/t/${job.actorId}/${job.sessionId}`);
    await ref.transaction((current) => {
      const timestamp = parseRemoteTimestamp(current, "invalid_typing_remote");
      if (job.kind === "typing_stop") {
        if (timestamp === null || timestamp > job.occurredAtMs) return;
        return null;
      }
      if (timestamp !== null && timestamp >= job.occurredAtMs) return;
      return job.occurredAtMs;
    }, undefined, false);
    return true;
  }
  if (job.kind === "character_pulse") {
    const ref = database.ref(`/v2/l/${job.roomId}/c/${job.actorId}`);
    await ref.transaction((current) => {
      const timestamp = parseRemoteTimestamp(current, "invalid_pulse_remote");
      if (timestamp !== null && timestamp >= job.occurredAtMs) return;
      return job.occurredAtMs;
    }, undefined, false);
    return true;
  }
  const ref = database.ref(`/v2/l/${job.roomId}/x/${job.actorId}`);
  await ref.transaction((current) => {
    if (current !== null && current !== undefined) {
      if (!current || typeof current !== "object" || Array.isArray(current) ||
          !UUID_PATTERN.test(current.u || "") || !WIRE_CODE_PATTERN.test(current.k || "")) {
        throw new Error("invalid_throw_remote");
      }
      const timestamp = parseRemoteTimestamp(current.t, "invalid_throw_remote");
      if (timestamp >= job.occurredAtMs) return;
    }
    return {u: job.targetUserId, k: job.wireCode, t: job.occurredAtMs};
  }, undefined, false);
  return true;
}

async function removeExactTransientJob(database, job) {
  let path;
  if (job.kind.startsWith("typing_")) {
    path = `/v2/l/${job.roomId}/t/${job.actorId}/${job.sessionId}`;
  } else if (job.kind === "character_pulse") {
    path = `/v2/l/${job.roomId}/c/${job.actorId}`;
  } else {
    path = `/v2/l/${job.roomId}/x/${job.actorId}`;
  }
  await database.ref(path).transaction((current) => {
    const timestamp = job.kind === "character_throw" ? current?.t : current;
    if (timestamp === job.occurredAtMs) return null;
  }, undefined, false);
}

async function synchronizeTransientPublications({
  database,
  config,
  rpc = accessRpc,
  workerId = randomUUID(),
  now = Date.now,
}) {
  if (!UUID_PATTERN.test(workerId)) throw new Error("invalid_transient_worker");
  const rows = await rpc(config, "claim_firebase_transient_publications", {
    p_worker: workerId,
    p_limit: BATCH_SIZE,
  });
  if (!Array.isArray(rows) || rows.length > BATCH_SIZE) {
    throw new Error("invalid_transient_batch");
  }
  let delivered = 0;
  let expired = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const job = parseTransientJob(row);
      const fresh = now() <= job.occurredAtMs + TRANSIENT_FRESHNESS_MS;
      const before = await rpc(config, "validate_firebase_transient_publication", {
        p_worker: workerId, p_id: job.id,
      });
      if (before === true && fresh) await applyTransientJob(database, job);
      else await removeExactTransientJob(database, job);
      const after = await rpc(config, "validate_firebase_transient_publication", {
        p_worker: workerId, p_id: job.id,
      });
      if (after !== true || !fresh) await removeExactTransientJob(database, job);
      const acknowledged = await rpc(config, "ack_firebase_transient_publication", {
        p_worker: workerId, p_id: job.id,
      });
      if (acknowledged !== true) throw new Error("transient_claim_lost");
      delivered++;
      if (!fresh) expired++;
    } catch {
      failed++;
    }
  }
  return {claimed: rows.length, delivered, expired, failed};
}

module.exports = {
  BATCH_SIZE,
  TRANSIENT_FRESHNESS_MS,
  applyTransientJob,
  bridgeClientTransient,
  parseClientTransientWrite,
  parseTransientJob,
  removeExactTransientJob,
  stableEventUuid,
  synchronizeTransientPublications,
};
