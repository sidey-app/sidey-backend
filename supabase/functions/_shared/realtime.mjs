// Shared by Deno Edge Functions and dependency-free Node contract tests.
export const disabledBootstrap = Object.freeze({ protocolVersion: 1, enabled: false, transport: "supabase" });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const kinds = new Set(["message_changed", "structure_changed", "messages_pruned"]);

export function firebaseConfig(env) {
  if (env("SIDEY_FIREBASE_MODE") !== "shadow") return null;
  if (env("SIDEY_FIREBASE_SHADOW_APPROVED") !== "true") return null;
  const url = new URL(env("SIDEY_FIREBASE_DATABASE_URL") || "");
  if (url.protocol !== "https:" || !/^[a-z0-9-]+\.(?:[a-z0-9-]+\.)?firebasedatabase\.app$/.test(url.hostname)
      || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("invalid_firebase_database_url");
  }
  const account = JSON.parse(env("SIDEY_FIREBASE_SERVICE_ACCOUNT") || "{}");
  if (typeof account.private_key !== "string" || !account.private_key.includes("BEGIN PRIVATE KEY")
      || typeof account.client_email !== "string" || !account.client_email.endsWith(".iam.gserviceaccount.com")
      || typeof account.project_id !== "string" || !account.project_id) throw new Error("invalid_firebase_service_account");
  const project = env("SIDEY_FIREBASE_PROJECT_ID");
  const supabaseRef = env("SIDEY_FIREBASE_SUPABASE_PROJECT_REF");
  if (!project || project !== account.project_id || url.hostname.split(".")[0] !== `${project}-default-rtdb`
      || !/^[a-z0-9]+$/.test(supabaseRef || "")
      || new URL(env("SUPABASE_URL") || "").hostname !== `${supabaseRef}.supabase.co`) {
    throw new Error("firebase_environment_binding_mismatch");
  }
  const apiKey = env("SIDEY_FIREBASE_API_KEY");
  if (!apiKey) throw new Error("missing_firebase_api_key");
  return { databaseURL: url.origin, account, apiKey };
}

export function streamPath(roomId, epoch) {
  if (!uuid.test(roomId) || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error("invalid_stream");
  return `v1/rooms/${roomId}/epochs/${epoch}/hint`;
}

export function hintPayload(row) {
  if (!uuid.test(row.event_id) || !kinds.has(row.kind) || typeof row.publication_revision !== "string" || !/^[1-9][0-9]*$/.test(row.publication_revision)
      || !Number.isFinite(Date.parse(row.occurred_at))) throw new Error("invalid_hint");
  streamPath(row.room_id, row.epoch);
  return { protocolVersion: 1, eventId: row.event_id, kind: row.kind, roomId: row.room_id,
    epoch: row.epoch, revision: row.publication_revision, occurredAt: row.occurred_at };
}

export function shouldReplaceHint(current, next) {
  if (current === null) return true;
  if (current.protocolVersion !== 1 || current.roomId !== next.roomId || current.epoch !== next.epoch
      || typeof current.revision !== "string" || !/^[1-9][0-9]*$/.test(current.revision)) {
    throw new Error("invalid_existing_hint");
  }
  return BigInt(next.revision) > BigInt(current.revision);
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
const encode = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));

export async function signJWT(account, payload) {
  const pem = account.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const body = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

export async function customToken(account, userId, sessionId, now = Date.now()) {
  if (!uuid.test(userId) || !uuid.test(sessionId)) throw new Error("invalid_identity");
  const iat = Math.floor(now / 1000);
  return await signJWT(account, { iss: account.client_email, sub: account.client_email,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat, exp: iat + 300, uid: userId, claims: { sideySessionId: sessionId, sideyProtocol: 1 } });
}

export async function googleAccessToken(account, fetcher = fetch) {
  const iat = Math.floor(Date.now() / 1000);
  const assertion = await signJWT(account, { iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 300 });
  const response = await fetcher("https://oauth2.googleapis.com/token", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("firebase_service_auth_failed");
  const result = await response.json();
  if (typeof result.access_token !== "string") throw new Error("firebase_service_auth_failed");
  return result.access_token;
}

export function firebaseRequest(config, accessToken, path, init = {}, fetcher = fetch) {
  if (!/^v1\/[a-zA-Z0-9/_-]+$/.test(path)) throw new Error("invalid_firebase_path");
  return fetcher(`${config.databaseURL}/${path}.json`, { ...init,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(10000) });
}

// ETag compare-and-set prevents slow/retried workers from replacing a newer hint.
export async function publishHint(config, accessToken, row, fetcher = fetch) {
  const next = hintPayload(row);
  const path = streamPath(next.roomId, next.epoch);
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await firebaseRequest(config, accessToken, path,
      { headers: { "X-Firebase-ETag": "true" } }, fetcher);
    if (!snapshot.ok) throw new Error("firebase_hint_read_failed");
    if (!shouldReplaceHint(await snapshot.json(), next)) return;
    const etag = snapshot.headers.get("etag");
    if (!etag) throw new Error("firebase_etag_missing");
    const response = await firebaseRequest(config, accessToken, path,
      { method: "PUT", headers: { "if-match": etag }, body: JSON.stringify(next) }, fetcher);
    if (response.status === 412) continue;
    if (!response.ok) throw new Error("firebase_hint_write_failed");
    return;
  }
  throw new Error("firebase_hint_contention");
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json", "cache-control": "no-store" } });
}
