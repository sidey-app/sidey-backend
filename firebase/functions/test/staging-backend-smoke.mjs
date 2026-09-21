import {randomUUID} from "node:crypto";
import {deleteApp, initializeApp} from "firebase-admin/app";
import {getAuth} from "firebase-admin/auth";
import {getDatabase} from "firebase-admin/database";
import {validateDeliveryStatus} from "./support/delivery-status.mjs";
import {firebaseAdminCredentialFromEnvironment} from "./support/firebase-admin-credential.mjs";

const config = JSON.parse(process.env.SIDEY_SUPABASE_CONFIG || "null");
const wakeToken = process.env.SIDEY_ACCESS_WAKE_TOKEN;
const stagingUrl = "https://fjglrvhvdthntkvrduyi.supabase.co";
if (!config?.url || !config?.publishableKey || !config?.serviceRoleKey) {
  throw new Error("missing_staging_config");
}
if (config.url.replace(/\/$/, "") !== stagingUrl) throw new Error("staging_project_required");
if (process.env.SIDEY_FIREBASE_GATE1_SMOKE_APPROVED !== "10") {
  throw new Error("explicit_10_user_staging_approval_required");
}

const callableUrl =
  "https://asia-southeast1-sidey-realtime.cloudfunctions.net/sendRealtimeChat";
const users = [];
let roomId = null;
let roomDeletedAt = null;
const adminCredential = firebaseAdminCredentialFromEnvironment();
const adminApp = initializeApp({
  projectId: "sidey-realtime",
  databaseURL: "https://sidey.asia-southeast1.firebasedatabase.app",
  ...(adminCredential ? {credential: adminCredential} : {}),
}, `gate1-smoke-${randomUUID()}`);
const adminAuth = getAuth(adminApp);
const adminDatabase = getDatabase(adminApp);

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const candidate = payload?.error_code || payload?.code;
    const safeCode = typeof candidate === "string" && /^[a-z0-9_]{1,80}$/i.test(candidate) ?
      candidate : "request_failed";
    throw new Error(`http_${response.status}:${safeCode}`);
  }
  return payload;
}

function supabaseHeaders(token, apikey = config.publishableKey) {
  return {apikey, authorization: `Bearer ${token}`, "content-type": "application/json"};
}

async function createTemporaryUser(nickname) {
  const email = `codex-smoke-${randomUUID()}@example.invalid`;
  const password = `${randomUUID()}-Smoke9!`;
  // Journal before the request. If the create response is lost, cleanup can
  // resolve the generated email through the Admin API.
  const user = {id: null, email, accessToken: null, nickname};
  users.push(user);
  const created = await json(`${config.url}/auth/v1/admin/users`, {
    method: "POST",
    headers: supabaseHeaders(config.serviceRoleKey, config.serviceRoleKey),
    body: JSON.stringify({email, password, email_confirm: true}),
  });
  user.id = created.id;
  const auth = await json(`${config.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {apikey: config.publishableKey, "content-type": "application/json"},
    body: JSON.stringify({email, password}),
  });
  user.accessToken = auth.access_token;
  await rpc(user, "upsert_profile", {p_nickname: nickname, p_character_id: "pixel_hamster"});
  return user;
}

async function resolveMissingUserIds() {
  if (users.every((user) => user.id)) return;
  let page = 1;
  for (let requestCount = 0; requestCount < 100; requestCount++) {
    const payload = await json(
      `${config.url}/auth/v1/admin/users?page=${page}&per_page=1000`,
      {headers: supabaseHeaders(config.serviceRoleKey, config.serviceRoleKey)},
    );
    const remoteUsers = Array.isArray(payload?.users) ? payload.users :
      (Array.isArray(payload) ? payload : []);
    for (const user of users) {
      if (!user.id) {
        user.id = remoteUsers.find((candidate) => candidate.email === user.email)?.id || null;
      }
    }
    if (users.every((user) => user.id)) return;
    if (!Number.isSafeInteger(payload?.next_page) || payload.next_page <= page) break;
    page = payload.next_page;
  }
}

async function rpc(user, name, body) {
  return json(`${config.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: supabaseHeaders(user.accessToken),
    body: JSON.stringify(body),
  });
}

async function bootstrap(user) {
  const result = await json(
    "https://asia-southeast1-sidey-realtime.cloudfunctions.net/bootstrapRealtime",
    {method: "POST", headers: {authorization: `Bearer ${user.accessToken}`}},
  );
  if (result.databaseURL !== "https://sidey.asia-southeast1.firebasedatabase.app") {
    throw new Error("wrong_database_instance");
  }
  const firebase = await json(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(result.firebaseApiKey)}`,
    {method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({token: result.customToken, returnSecureToken: true})},
  );
  user.firebaseApiKey = result.firebaseApiKey;
  user.firebaseIdToken = firebase.idToken;
}

async function wakeWorkers() {
  if (typeof wakeToken !== "string" || wakeToken.length < 32) {
    return false;
  }
  const results = await Promise.all([
    "syncRealtimeAccess",
    "syncRealtimeRoomRevisions",
    "syncRealtimeChat",
  ].map(async (endpoint) => {
    try {
      await json(`https://asia-southeast1-sidey-realtime.cloudfunctions.net/${endpoint}`, {
        method: "POST",
        headers: {"x-sidey-wake-token": wakeToken},
        signal: AbortSignal.timeout(15_000),
      });
      return true;
    } catch {
      return false;
    }
  }));
  return results.every(Boolean);
}

async function supabaseUserAbsent(userId) {
  const response = await fetch(`${config.url}/auth/v1/admin/users/${userId}`, {
    headers: supabaseHeaders(config.serviceRoleKey, config.serviceRoleKey),
  });
  if (response.status === 404) return true;
  if (response.ok) return false;
  throw new Error(`auth_readback_${response.status}`);
}

async function deliveryStatus(ids, requireSettled = true) {
  const value = await json(`${config.url}/rest/v1/rpc/firebase_delivery_status`, {
    method: "POST",
    headers: supabaseHeaders(config.serviceRoleKey, config.serviceRoleKey),
    body: JSON.stringify({p_user_ids: ids, p_room_id: roomId}),
  });
  return validateDeliveryStatus(value, ids.length, {requireSettled});
}

async function finalizeDeletedDelivery(ids) {
  return json(`${config.url}/rest/v1/rpc/firebase_finalize_deleted_delivery`, {
    method: "POST",
    headers: supabaseHeaders(config.serviceRoleKey, config.serviceRoleKey),
    body: JSON.stringify({p_user_ids: ids, p_room_id: roomId}),
  });
}

async function cleanupBackendState(requireSettled = true) {
  const ids = users.map((user) => user.id).filter(Boolean);
  if (ids.length !== users.length) return false;
  const firebaseUsers = await adminAuth.getUsers(ids.map((uid) => ({uid})));
  const access = await Promise.all(ids.map((uid) =>
    adminDatabase.ref(`/v2/a/u/${uid}`).get()));
  const roomLive = roomId ? await adminDatabase.ref(`/v2/l/${roomId}`).get() : null;
  const accessDenyAll = access.every((snapshot) => {
    if (!snapshot.exists()) return true;
    const value = snapshot.val();
    return value?.active === false &&
      Object.keys(value.rooms || {}).length === 0 &&
      Object.keys(value.sessions || {}).length === 0 &&
      Object.keys(value.cleanup_rooms || {}).length === 0 &&
      Object.keys(value.cleanup_sessions || {}).length === 0;
  });
  const deliveryReady = roomId ? (await deliveryStatus(ids, requireSettled)).ready : true;
  // Direct table reads are intentionally unavailable even to service_role.
  // The finalizer below locks and verifies every database source row before
  // deleting delivery tombstones, so this polling path does not duplicate it.
  const state = {
    firebaseAuthAbsent: firebaseUsers.users.length === 0,
    supabaseAuthAbsent: (await Promise.all(ids.map(supabaseUserAbsent))).every(Boolean),
    accessDenyAll,
    roomLiveAbsent: !roomLive || !roomLive.exists(),
    deliveryReady,
  };
  return {...state, ready: Object.values(state).every(Boolean)};
}

async function cleanupBackendConverged(requireSettled = true) {
  return (await cleanupBackendState(requireSettled)).ready;
}

async function cleanupResidualsAbsent() {
  const ids = users.map((user) => user.id).filter(Boolean);
  const snapshots = await Promise.all(ids.flatMap((uid) => [
    adminDatabase.ref(`/v2/a/u/${uid}`).get(),
    adminDatabase.ref(`/v2/a/b/${uid}`).get(),
    adminDatabase.ref(`/v2/n/${uid}`).get(),
  ]));
  if (roomId) {
    snapshots.push(await adminDatabase.ref(`/v2/a/d/${roomId}`).get());
    snapshots.push(await adminDatabase.ref(`/v2/l/${roomId}`).get());
  }
  return snapshots.every((snapshot) => !snapshot.exists());
}

async function removeExactTestResiduals(ids) {
  const updates = {};
  for (const uid of ids) {
    updates[`v2/a/u/${uid}`] = null;
    updates[`v2/a/b/${uid}`] = null;
    updates[`v2/n/${uid}`] = null;
  }
  if (roomId) {
    updates[`v2/a/d/${roomId}`] = null;
    updates[`v2/l/${roomId}`] = null;
  }
  await adminDatabase.ref().update(updates);
}

async function cleanup() {
  const failures = new Set();
  const cleanupStartedAt = Date.now();
  try { await resolveMissingUserIds(); } catch { failures.add("resolve_users"); }
  if (roomId && users[0]?.accessToken) {
    try {
      await rpc(users[0], "delete_room", {p_room_id: roomId});
      roomDeletedAt = Date.now();
    } catch { failures.add("room"); }
  }
  for (const user of users) {
    if (!user.id) {
      failures.add("unknown_user");
      continue;
    }
    try {
      await json(`${config.url}/auth/v1/admin/users/${user.id}`, {
        method: "DELETE",
        headers: supabaseHeaders(config.serviceRoleKey, config.serviceRoleKey),
      });
    } catch { failures.add("supabase_user"); }
  }
  const ids = users.map((user) => user.id).filter(Boolean);
  if (ids.length) {
    try {
      const deleted = await adminAuth.deleteUsers(ids);
      if (deleted.failureCount) failures.add("firebase_user");
    } catch { failures.add("firebase_user"); }
  }

  // The first room-deletion delivery intentionally remains unacknowledged for
  // one 90-second claim lease. Re-wake bounded workers until the service-role
  // delivery RPC proves every exact user/room/chat outbox revision is ACKed.
  const deadline = Date.now() + 240_000;
  let converged = false;
  let lastCleanupDiagnostic = {error: "not_checked"};
  while (Date.now() < deadline) {
    try {
      lastCleanupDiagnostic = await cleanupBackendState();
      if (lastCleanupDiagnostic.ready &&
          (!roomId || Date.now() - (roomDeletedAt || cleanupStartedAt) >= 95_000)) {
        converged = true;
        break;
      }
    } catch (error) {
      const candidate = error?.message;
      lastCleanupDiagnostic = {error:
        typeof candidate === "string" && /^[a-z0-9_:,-]{1,120}$/i.test(candidate) ?
          candidate : "cleanup_readback_error"};
    }
    await wakeWorkers();
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (!converged) {
    console.error(JSON.stringify({cleanupDiagnostic: lastCleanupDiagnostic}));
    failures.add("cleanup_not_converged");
  }

  // Finalize fully delivered source tombstones transactionally before removing
  // their exact RTDB mirrors. This also prevents daily reconciliation from
  // recreating deleted test users after the final zero-residual read-back.
  let finalized = !roomId;
  if (converged && roomId) {
    try {
      finalized = await finalizeDeletedDelivery(ids) === true;
      if (!finalized) failures.add("delivery_finalize");
    } catch { failures.add("delivery_finalize"); }
  }
  if (converged && finalized) {
    try {
      await removeExactTestResiduals(ids);
    } catch { failures.add("exact_rtdb_cleanup"); }
  }
  if (converged && finalized) {
    const finalDeadline = Date.now() + 60_000;
    let consecutiveReadbacks = 0;
    while (Date.now() < finalDeadline && consecutiveReadbacks < 3) {
      try {
        const workersReady = await wakeWorkers();
        const sourceReady = roomId ? (await deliveryStatus(ids, false)).ready : true;
        const clean = workersReady && sourceReady &&
          await cleanupBackendConverged(false) && await cleanupResidualsAbsent();
        consecutiveReadbacks = clean ? consecutiveReadbacks + 1 : 0;
      } catch {
        consecutiveReadbacks = 0;
      }
      if (consecutiveReadbacks < 3) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
    if (consecutiveReadbacks < 3) failures.add("cleanup_final_readback");
  }
  try {
    await deleteApp(adminApp);
  } catch {
    failures.add("admin_app");
  }
  if (failures.size) throw new Error(`cleanup_failed:${[...failures].join(",")}`);
}

let smokeResult = null;
try {
  const owner = await createTemporaryUser(`검증${Date.now().toString().slice(-4)}`.slice(0, 8));
  const peers = [];
  for (let index = 0; index < 9; index++) {
    peers.push(await createTemporaryUser(`상대${index}${Date.now().toString().slice(-3)}`.slice(0, 8)));
  }
  const peer = peers[0];
  const created = await rpc(owner, "create_room", {p_name: "v2 staging"});
  const room = Array.isArray(created) ? created[0] : created;
  roomId = room.room_id;
  for (const joiningPeer of peers) {
    const joined = await rpc(joiningPeer, "join_room", {p_invite_code: room.invite_code});
    const joinResult = Array.isArray(joined) ? joined[0] : joined;
    if (joinResult.room_id !== roomId || joinResult.error_code) throw new Error("join_failed");
  }

  await Promise.all(users.map(bootstrap));

  const messageId = randomUUID();
  const callable = await json(callableUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${owner.firebaseIdToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({data: {r: roomId, i: messageId, b: "staging smoke"}}),
  });
  const sent = callable.result;
  if (sent?.i !== messageId || !Number.isSafeInteger(sent.n) || sent.n < 1) {
    throw new Error("callable_projection_invalid");
  }

  const live = await json(
    `https://sidey.asia-southeast1.firebasedatabase.app/v2/l/${roomId}/e.json?auth=${encodeURIComponent(owner.firebaseIdToken)}`,
  );
  if (live?.i !== messageId || live?.n !== sent.n || live?.b !== "staging smoke") {
    throw new Error("chat_publish_not_converged");
  }

  await json(
    `https://sidey.asia-southeast1.firebasedatabase.app/v2/l/${roomId}/x/${owner.id}.json?auth=${encodeURIComponent(owner.firebaseIdToken)}&print=silent`,
    {method: "PUT", headers: {"content-type": "application/json"},
      body: JSON.stringify({u: peer.id, k: "0", t: {".sv": "timestamp"}})},
  );
  const thrown = await json(
    `https://sidey.asia-southeast1.firebasedatabase.app/v2/l/${roomId}/x/${owner.id}.json?auth=${encodeURIComponent(peer.firebaseIdToken)}`,
  );
  if (thrown?.u !== peer.id || thrown?.k !== "0" || !Number.isSafeInteger(thrown?.t)) {
    throw new Error("compact_throw_not_converged");
  }

  smokeResult = {
    status: "pass",
    databaseInstance: "sidey",
    callable: true,
    chatSequence: sent.n,
    compactThrow: true,
    users: users.length,
  };
} finally {
  await cleanup();
}
console.log(JSON.stringify(smokeResult));
