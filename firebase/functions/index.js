"use strict";

const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getDatabase} = require("firebase-admin/database");
const logger = require("firebase-functions/logger");
const {defineJsonSecret, defineSecret} = require("firebase-functions/params");
const {onValueWritten} = require("firebase-functions/v2/database");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {HttpsError, onCall, onRequest} = require("firebase-functions/v2/https");
const {applyAccessSnapshot, authorizedWake, synchronizeAccess} = require("./lib/access-sync");
const {synchronizeRoomRevisions} = require("./lib/room-revision");
const {BootstrapContractError, parseBootstrapRequest} = require("./lib/bootstrap-contract");
const {
  RealtimeGlobalGateError,
  assertRealtimeGlobalEnabled,
} = require("./lib/global-gate");
const {
  RealtimeChatError,
  parseChatEvent,
  parseRealtimeChatRequest,
  synchronizeRealtimeChat,
} = require("./lib/realtime-chat");
const {
  bridgeClientTransient,
  synchronizeTransientPublications,
} = require("./lib/realtime-transients");
const {
  SupabaseBridgeError,
  accessRpc,
  getRealtimeAccess,
  getRealtimeBootstrapAuthorization,
  persistRealtimeMessage,
  verifySupabaseUser,
} = require("./lib/supabase");

initializeApp({
  databaseURL: "https://sidey.asia-southeast1.firebasedatabase.app",
});

const supabaseConfig = defineJsonSecret("SIDEY_SUPABASE_CONFIG");
const accessWakeToken = defineSecret("SIDEY_ACCESS_WAKE_TOKEN");
const transientWakeToken = defineSecret("SIDEY_TRANSIENT_WAKE_TOKEN");
const BOOTSTRAP_WINDOW_MS = 60 * 1000;
const BOOTSTRAP_WINDOW_LIMIT = 12;

async function consumeBootstrapLimit(database, userId, now) {
  const result = await database
    .ref(`/v2/a/b/${userId}`)
    .transaction((current) => {
      if (
        !current ||
        !Number.isSafeInteger(current.window_started) ||
        current.window_started < now - BOOTSTRAP_WINDOW_MS
      ) {
        return {window_started: now, attempts: 1};
      }
      if (!Number.isSafeInteger(current.attempts) || current.attempts >= BOOTSTRAP_WINDOW_LIMIT) {
        return;
      }
      return {window_started: current.window_started, attempts: current.attempts + 1};
    }, undefined, false);
  return result.committed;
}

function sendJson(response, status, body) {
  response.status(status).set("cache-control", "no-store").json(body);
}

exports.bootstrapRealtime = onRequest(
  {
    region: "asia-southeast1",
    secrets: [supabaseConfig],
    timeoutSeconds: 30,
    memory: "256MiB",
    minInstances: 0,
    concurrency: 20,
    maxInstances: 10,
    cors: false,
  },
  async (request, response) => {
    if (request.method !== "POST") {
      sendJson(response, 405, {error: "method_not_allowed"});
      return;
    }
    try {
      const {minimumAccessRevision} = parseBootstrapRequest(request.body);
      const config = supabaseConfig.value();
      if (
        typeof config.firebaseApiKey !== "string" ||
        config.firebaseApiKey.length < 20 ||
        config.firebaseApiKey.length > 200
      ) {
        throw new SupabaseBridgeError("firebase_api_key_invalid");
      }
      const user = await verifySupabaseUser(config, request.get("authorization"));
      const database = getDatabase();
      if (!(await consumeBootstrapLimit(database, user.id, Date.now()))) {
        sendJson(response, 429, {error: "realtime_bootstrap_rate_limited"});
        return;
      }
      // Emergency kill is a live Firebase-side gate. Unlike the five-minute
      // cohort lease, it is checked on every bootstrap and never cached.
      await assertRealtimeGlobalEnabled(database);
      const rollout = await getRealtimeBootstrapAuthorization(
        config, user.id, user.sessionId,
      );
      const access = await getRealtimeAccess(config, user.id);
      if (minimumAccessRevision !== null && access.revision < minimumAccessRevision) {
        throw new BootstrapContractError("realtime_grant_not_converged");
      }
      const mirrored = await applyAccessSnapshot(database, access);
      if (!mirrored?.active || !(mirrored.sessions?.[user.sessionId] > Date.now())) {
        throw new SupabaseBridgeError("authentication_required", {permanent: true});
      }
      // Bootstrap never extends sync health; only the outbox worker may do that.
      const syncUntil = (await database.ref("/v2/a/s/v").get()).val();
      if (!(syncUntil > Date.now())) throw new SupabaseBridgeError("access_sync_unavailable");
      const customToken = await getAuth().createCustomToken(user.id, {
        sideyProtocol: 2,
        sideySessionId: user.sessionId,
        sideyRolloutUntil: rollout.leaseExpiresAt,
      });
      sendJson(response, 200, {
        protocolVersion: 2,
        databaseURL: "https://sidey.asia-southeast1.firebasedatabase.app",
        firebaseApiKey: config.firebaseApiKey,
        customToken,
        permissionSync: "event-driven",
        authTokenLifetimeSeconds: 3600,
        refreshAfter: Math.max(Date.now(), rollout.leaseExpiresAt - 30_000),
        rolloutLeaseExpiresAt: rollout.leaseExpiresAt,
        accessRevision: mirrored.revision,
        rooms: Object.keys(mirrored.rooms || {}),
        wireItems: Object.keys(mirrored.wire_items || {}),
      });
    } catch (error) {
      const authenticationFailure =
        error instanceof SupabaseBridgeError && error.code === "authentication_required";
      const invalidArgument =
        error instanceof BootstrapContractError && error.code === "invalid_argument";
      const grantPending = error instanceof BootstrapContractError &&
        error.code === "realtime_grant_not_converged";
      const rolloutDisabled =
        (error instanceof SupabaseBridgeError || error instanceof RealtimeGlobalGateError) &&
        error.code === "realtime_rollout_disabled";
      if (!authenticationFailure && !invalidArgument && !grantPending && !rolloutDisabled) {
        const code = error instanceof SupabaseBridgeError ? error.code :
          (typeof error?.code === "string" ? error.code : "bootstrap_failed");
        logger.error(`Firebase realtime bootstrap failed: ${code}`);
      }
      const status = authenticationFailure ? 401 : invalidArgument ? 400 :
        (grantPending || rolloutDisabled) ? 409 : 503;
      const code = authenticationFailure ? "authentication_required" :
        invalidArgument ? "invalid_argument" :
          grantPending ? "realtime_grant_not_converged" :
            rolloutDisabled ? "realtime_rollout_disabled" : "realtime_bootstrap_unavailable";
      sendJson(
        response,
        status,
        {error: code},
      );
    }
  },
);

const accessWorkerOptions = {
  region: "asia-southeast1", secrets: [supabaseConfig],
  timeoutSeconds: 240, memory: "256MiB", minInstances: 0,
  concurrency: 1, maxInstances: 1,
};

async function runAccessWorker() {
  const result = await synchronizeAccess({
    database: getDatabase(),
    config: supabaseConfig.value(),
    onFailure: (error) => {
      const candidate = typeof error?.code === "string" ? error.code : error?.message;
      const code = typeof candidate === "string" && /^[a-z0-9_]{1,80}$/i.test(candidate) ?
        candidate : "access_item_failed";
      logger.error("Access synchronization item failed", {code});
    },
  });
  if (result.failed) logger.error("Access synchronization pending retries", result);
  if (result.quarantined) logger.error("Access snapshots quarantined as deny-all", result);
  return result;
}

function wakeCredential(request) {
  return request.get("x-sidey-wake-token") || request.get("authorization");
}

// Webhook is a latency optimization, never the durable queue itself.
exports.syncRealtimeAccess = onRequest(
  {...accessWorkerOptions, secrets: [supabaseConfig, accessWakeToken], cors: false},
  async (request, response) => {
    if (request.method !== "POST") return sendJson(response, 405, {error: "method_not_allowed"});
    const credential = wakeCredential(request);
    const presented = request.get("x-sidey-wake-token") ? `Bearer ${credential}` : credential;
    if (!authorizedWake(presented, accessWakeToken.value())) {
      return sendJson(response, 401, {error: "authentication_required"});
    }
    try {
      const result = await runAccessWorker();
      return sendJson(response, result.failed ? 503 : 200, result);
    } catch {
      logger.error("Access synchronization failed");
      return sendJson(response, 503, {error: "access_sync_unavailable"});
    }
  },
);

// One global call/minute (43,200/month), NOT one call per connected user.
exports.retryRealtimeAccess = onSchedule(
  {...accessWorkerOptions, schedule: "every 1 minutes", retryCount: 0},
  runAccessWorker,
);

exports.reconcileRealtimeAccess = onSchedule(
  {...accessWorkerOptions, schedule: "30 3 * * *", timeZone: "Asia/Seoul", retryCount: 3},
  async () => {
    // Bounded, resumable batches are processed by the ordinary worker afterwards.
    // The SQL RPC coalesces duplicate daily scheduler deliveries.
    await accessRpc(supabaseConfig.value(), "firebase_access_reconcile", {});
    await runAccessWorker();
  },
);

// A room claim lasts 90 seconds in PostgreSQL. Keep every invocation strictly
// shorter so a tombstone cannot overtake a still-running revision publisher.
const roomRevisionWorkerOptions = {
  region: "asia-southeast1", secrets: [supabaseConfig],
  timeoutSeconds: 60, memory: "256MiB", minInstances: 0,
  concurrency: 1, maxInstances: 1,
};

async function runRoomRevisionWorker() {
  const result = await synchronizeRoomRevisions({
    database: getDatabase(),
    config: supabaseConfig.value(),
  });
  if (result.failed) logger.error("Room revision synchronization pending retries", result);
  return result;
}

exports.syncRealtimeRoomRevisions = onRequest(
  {...roomRevisionWorkerOptions, secrets: [supabaseConfig, accessWakeToken], cors: false},
  async (request, response) => {
    if (request.method !== "POST") return sendJson(response, 405, {error: "method_not_allowed"});
    const credential = wakeCredential(request);
    const presented = request.get("x-sidey-wake-token") ? `Bearer ${credential}` : credential;
    if (!authorizedWake(presented, accessWakeToken.value())) {
      return sendJson(response, 401, {error: "authentication_required"});
    }
    try {
      const result = await runRoomRevisionWorker();
      return sendJson(response, result.failed ? 503 : 200, result);
    } catch {
      logger.error("Room revision synchronization failed");
      return sendJson(response, 503, {error: "room_revision_sync_unavailable"});
    }
  },
);

exports.retryRealtimeRoomRevisions = onSchedule(
  {...roomRevisionWorkerOptions, schedule: "every 1 minutes", retryCount: 0},
  runRoomRevisionWorker,
);

const realtimeChatWorkerOptions = {
  region: "asia-southeast1", secrets: [supabaseConfig],
  timeoutSeconds: 60, memory: "256MiB", minInstances: 0,
  concurrency: 1, maxInstances: 1,
};

async function runRealtimeChatWorker() {
  const result = await synchronizeRealtimeChat({
    database: getDatabase(),
    config: supabaseConfig.value(),
  });
  if (result.failed) logger.error("Realtime chat synchronization pending retries", result);
  return result;
}

exports.syncRealtimeChat = onRequest(
  {...realtimeChatWorkerOptions, secrets: [supabaseConfig, accessWakeToken], cors: false},
  async (request, response) => {
    if (request.method !== "POST") return sendJson(response, 405, {error: "method_not_allowed"});
    const credential = wakeCredential(request);
    const presented = request.get("x-sidey-wake-token") ? `Bearer ${credential}` : credential;
    if (!authorizedWake(presented, accessWakeToken.value())) {
      return sendJson(response, 401, {error: "authentication_required"});
    }
    try {
      const result = await runRealtimeChatWorker();
      return sendJson(response, result.failed ? 503 : 200, result);
    } catch {
      logger.error("Realtime chat synchronization failed");
      return sendJson(response, 503, {error: "realtime_chat_sync_unavailable"});
    }
  },
);

exports.retryRealtimeChat = onSchedule(
  {...realtimeChatWorkerOptions, schedule: "every 1 minutes", retryCount: 0},
  runRealtimeChatWorker,
);

const transientWorkerOptions = {
  region: "asia-southeast1", secrets: [supabaseConfig],
  timeoutSeconds: 60, memory: "256MiB", minInstances: 0,
  concurrency: 1, maxInstances: 1,
};

async function runTransientWorker() {
  const result = await synchronizeTransientPublications({
    database: getDatabase(),
    config: supabaseConfig.value(),
  });
  if (result.failed) logger.error("Transient publication pending retries", result);
  return result;
}

exports.syncRealtimeTransients = onRequest(
  {...transientWorkerOptions, secrets: [supabaseConfig, transientWakeToken], cors: false},
  async (request, response) => {
    if (request.method !== "POST") return sendJson(response, 405, {error: "method_not_allowed"});
    const credential = wakeCredential(request);
    const presented = request.get("x-sidey-wake-token") ? `Bearer ${credential}` : credential;
    if (!authorizedWake(presented, transientWakeToken.value())) {
      return sendJson(response, 401, {error: "authentication_required"});
    }
    try {
      const result = await runTransientWorker();
      return sendJson(response, result.failed ? 503 : 200, result);
    } catch {
      logger.error("Transient publication failed");
      return sendJson(response, 503, {error: "transient_publish_unavailable"});
    }
  },
);

exports.retryRealtimeTransients = onSchedule(
  {...transientWorkerOptions, schedule: "every 1 minutes", retryCount: 0},
  runTransientWorker,
);

const transientTriggerOptions = (ref) => ({
  ref,
  instance: "sidey",
  region: "asia-southeast1",
  secrets: [supabaseConfig],
  timeoutSeconds: 30,
  memory: "256MiB",
  minInstances: 0,
  concurrency: 20,
  maxInstances: 20,
  retry: true,
});

async function bridgeTransientWrite(event, family) {
  try {
    await bridgeClientTransient(event, family, supabaseConfig.value());
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : error?.message;
    logger.error("Firebase transient bridge failed", {
      code: typeof code === "string" && /^[a-z0-9_]{1,80}$/i.test(code) ?
        code : "transient_bridge_failed",
    });
    throw error;
  }
}

exports.bridgeRealtimeTyping = onValueWritten(
  transientTriggerOptions("/v2/l/{roomId}/t/{uid}/{sessionId}"),
  (event) => bridgeTransientWrite(event, "typing"),
);

exports.bridgeRealtimePulse = onValueWritten(
  transientTriggerOptions("/v2/l/{roomId}/c/{uid}"),
  (event) => bridgeTransientWrite(event, "pulse"),
);

exports.bridgeRealtimeThrow = onValueWritten(
  transientTriggerOptions("/v2/l/{roomId}/x/{uid}"),
  (event) => bridgeTransientWrite(event, "throw"),
);

function callableError(error) {
  const code = error instanceof RealtimeChatError || error instanceof SupabaseBridgeError ||
    error instanceof RealtimeGlobalGateError
    ? error.code
    : "realtime_chat_unavailable";
  if (code === "authentication_required") return new HttpsError("unauthenticated", code);
  if (code === "membership_required") return new HttpsError("permission-denied", code);
  if (code === "message_rate_limited") return new HttpsError("resource-exhausted", code);
  if (code === "message_id_conflict" || code === "message_sequence_exhausted") {
    return new HttpsError("failed-precondition", code);
  }
  if (code === "realtime_rollout_disabled") {
    return new HttpsError("failed-precondition", code);
  }
  if (["invalid_argument", "invalid_message_body", "message_id_required"].includes(code)) {
    return new HttpsError("invalid-argument", code);
  }
  return new HttpsError("unavailable", "realtime_chat_unavailable");
}

exports.sendRealtimeChat = onCall(
  {
    region: "asia-southeast1",
    secrets: [supabaseConfig],
    timeoutSeconds: 30,
    memory: "256MiB",
    minInstances: 0,
    concurrency: 20,
    maxInstances: 10,
    enforceAppCheck: false,
  },
  async (request) => {
    try {
      const command = parseRealtimeChatRequest(request.data, request.auth);
      // The callable must observe emergency kill immediately even while the
      // signed rollout lease in an existing Firebase ID token remains valid.
      await assertRealtimeGlobalEnabled(getDatabase());
      const persisted = parseChatEvent(await persistRealtimeMessage(
        supabaseConfig.value(), command,
      ));
      // Publication is best-effort on the request path. PostgreSQL already
      // committed a durable outbox row, so failure here must not turn a stored
      // message into a client-visible reject or invite duplicate sends.
      try {
        await runRealtimeChatWorker();
      } catch {
        logger.warn("Immediate realtime chat publication deferred");
      }
      const response = {
        i: persisted.i,
        b: persisted.b,
        t: persisted.t,
        n: persisted.n,
      };
      if (persisted.k !== undefined) response.k = persisted.k;
      return response;
    } catch (error) {
      throw callableError(error);
    }
  },
);
