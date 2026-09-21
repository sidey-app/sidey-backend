import { signJWT } from "./realtime.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email";
const failure = () => new Error("firebase_service_auth_failed");

function waitForToken(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Token request aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(new DOMException("Token request aborted", "AbortError")); };
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(value => { signal.removeEventListener("abort", aborted); resolve(value); },
      error => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}

async function tokenBody(response) {
  if (!response.ok) { await response.body?.cancel(); throw failure(); }
  const reader = response.body?.getReader();
  if (!reader) throw failure();
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 16384) { await reader.cancel(); throw failure(); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Keep one instance per warm isolate. Caller cancellation only stops that caller's
// wait; the shared exchange has its own bounded lifetime and may serve another call.
export function createGoogleAccessTokenCache({ now = Date.now, signer = signJWT,
  refreshMarginMs = 60000, requestTimeoutMs = 10000 } = {}) {
  if (!Number.isSafeInteger(refreshMarginMs) || refreshMarginMs < 0 || refreshMarginMs > 300000
      || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 10000) throw failure();
  let current;
  return async (account, { fetcher = fetch, signal } = {}) => {
    if (signal?.aborted) throw new DOMException("Token request aborted", "AbortError");
    if (!account || typeof account.project_id !== "string" || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(account.project_id)
        || typeof account.client_email !== "string" || !/^[a-zA-Z0-9._-]+@/.test(account.client_email)
        || !account.client_email.endsWith(`@${account.project_id}.iam.gserviceaccount.com`)
        || typeof account.private_key !== "string" || !account.private_key.includes("-----BEGIN PRIVATE KEY-----")
        || (account.type !== undefined && account.type !== "service_account")) throw failure();
    const snapshot = { project_id: account.project_id, client_email: account.client_email, private_key: account.private_key };
    // A single retained binding bounds memory and prevents reuse across rotation/project changes.
    const binding = JSON.stringify(snapshot), at = now();
    if (!Number.isFinite(at)) throw failure();
    if (!current || current.binding !== binding) current = { binding };
    const entry = current;
    if (entry.token && at >= entry.issuedAt && at < entry.refreshAt) return entry.token;
    if (!entry.pending) {
      entry.token = undefined;
      entry.pending = Promise.resolve().then(async () => {
        try {
          const iat = Math.floor(at / 1000);
          const assertion = await signer(snapshot, { iss: snapshot.client_email, scope: SCOPE,
            aud: TOKEN_URL, iat, exp: iat + 300 });
          const response = await fetcher(TOKEN_URL, { method: "POST", redirect: "error",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
            signal: AbortSignal.timeout(requestTimeoutMs) });
          const result = await tokenBody(response);
          if (typeof result.access_token !== "string" || !result.access_token || result.access_token.length > 12000
              || /\s/.test(result.access_token) || result.token_type?.toLowerCase() !== "bearer"
              || !Number.isSafeInteger(result.expires_in) || result.expires_in < 1 || result.expires_in > 3600) throw failure();
          // Count expiry conservatively from exchange start, never from the later response.
          if (now() >= at + result.expires_in * 1000) throw failure();
          entry.token = result.access_token; entry.issuedAt = at;
          entry.refreshAt = at + result.expires_in * 1000 - refreshMarginMs;
          return entry.token;
        } catch { entry.token = undefined; throw failure(); }
        finally { entry.pending = undefined; }
      });
    }
    return waitForToken(entry.pending, signal);
  };
}
