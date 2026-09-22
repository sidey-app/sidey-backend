// Load-test authentication only. Importing performs no I/O. Tokens stay in memory;
// snapshot() deliberately excludes them. Never use credentials() to retry a write.
import { setTimeout as delay } from 'node:timers/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new Error('invalid_load_auth_response');
const aborted = () => Object.assign(new Error('load_auth_aborted'), { name: 'AbortError' });

function checkSignal(signal) { if (signal?.aborted) throw aborted(); }
function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(aborted()); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}

// This decodes claims for response consistency, NOT signature verification or
// authentication. The caller must obtain the response from its trusted Auth origin.
export function validateLoadAuthResponse(response, { requestStartedAt, now = Date.now(), expectedUserId, expectedSessionId } = {}) {
  const token = response?.access_token;
  if (!Number.isSafeInteger(requestStartedAt) || requestStartedAt < 0 || !Number.isSafeInteger(now) || now < requestStartedAt
      || !UUID.test(response?.user?.id ?? '') || typeof token !== 'string' || token.length > 65536
      || typeof response.refresh_token !== 'string' || !response.refresh_token || response.refresh_token.length > 8192
      || response.refresh_token.trim() !== response.refresh_token
      || !Number.isSafeInteger(response.expires_in) || response.expires_in <= 0) throw invalid();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw invalid();
  let claims;
  try {
    const decoded = Buffer.from(parts[1], 'base64url');
    if (decoded.toString('base64url') !== parts[1]) throw invalid();
    claims = JSON.parse(decoded.toString('utf8'));
  } catch { throw invalid(); }
  if (!UUID.test(claims?.sub ?? '') || !UUID.test(claims?.session_id ?? '')
      || !Number.isSafeInteger(claims.exp) || claims.exp <= 0) throw invalid();
  const userId = response.user.id.toLowerCase(), sessionId = claims.session_id.toLowerCase();
  if (claims.sub.toLowerCase() !== userId || (expectedUserId && expectedUserId.toLowerCase() !== userId)
      || (expectedSessionId && expectedSessionId.toLowerCase() !== sessionId)) throw invalid();
  const jwtExpiresAt = claims.exp * 1000;
  const grantExpiresAt = requestStartedAt + response.expires_in * 1000;
  const expiresAt = Math.min(jwtExpiresAt, grantExpiresAt);
  if (!Number.isSafeInteger(jwtExpiresAt) || !Number.isSafeInteger(grantExpiresAt) || expiresAt <= now) throw invalid();
  return Object.freeze({ accessToken: token, userId, sessionId, expiresAt });
}

// Share ONE instance between every provision/login and refresh request. Only
// starts are serialized; a slow response does not block later permitted starts.
export function createTokenEndpointLimiter({ intervalMs = 2100, now = Date.now,
  sleep = (milliseconds, { signal }) => delay(milliseconds, undefined, { signal }) } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) throw new Error('invalid_token_interval');
  let tail = Promise.resolve(), nextStart = -Infinity;
  return Object.freeze({
    run(request, { signal } = {}) {
      const gate = tail.then(async () => {
        checkSignal(signal);
        while (now() < nextStart) {
          await sleep(nextStart - now(), { signal });
          checkSignal(signal);
        }
        const requestStartedAt = now();
        nextStart = requestStartedAt + intervalMs;
        // Do not return the operation promise directly: the queue gates starts,
        // not completion. Synchronous throws still consume this start slot.
        let result;
        try { result = Promise.resolve(request({ signal, requestStartedAt })); }
        catch (error) { result = Promise.reject(error); }
        return { result };
      });
      tail = gate.then(() => undefined, () => undefined);
      return waitWithSignal(gate.then(({ result }) => result), signal);
    },
  });
}

export function createLoadActorAuth({ loginResponse, requestStartedAt, limiter, refresh,
  now = Date.now, refreshBeforeMs = 60_000 }) {
  if (!limiter?.run || typeof refresh !== 'function' || !Number.isSafeInteger(refreshBeforeMs) || refreshBeforeMs < 0) {
    throw new Error('invalid_load_auth_options');
  }
  let current = validateLoadAuthResponse(loginResponse, { requestStartedAt, now: now() });
  let refreshToken = loginResponse.refresh_token, inFlight = null, failed = false;
  let timeHighWater = requestStartedAt;
  const currentTime = () => { timeHighWater = Math.max(timeHighWater, now()); return timeHighWater; };
  return Object.freeze({
    snapshot() {
      const { userId, sessionId, expiresAt } = current;
      return { userId, sessionId, expiresAt, refreshing: inFlight !== null, failed };
    },
    async credentials({ signal, requiredValidityMs = 0 } = {}) {
      checkSignal(signal);
      if (!Number.isSafeInteger(requiredValidityMs) || requiredValidityMs < 0) throw new Error('invalid_required_validity');
      if (failed) throw new Error('load_auth_refresh_failed');
      if (!inFlight && current.expiresAt - currentTime() > Math.max(refreshBeforeMs, requiredValidityMs)) return current;
      if (!inFlight) {
        inFlight = limiter.run(async ({ signal, requestStartedAt }) => {
          const response = await refresh({ refreshToken, signal, requestStartedAt });
          checkSignal(signal);
          if (failed) throw new Error('load_auth_refresh_failed');
          const renewed = validateLoadAuthResponse(response, { requestStartedAt, now: currentTime(),
            expectedUserId: current.userId, expectedSessionId: current.sessionId });
          if (renewed.expiresAt <= current.expiresAt) throw invalid();
          current = renewed;
          refreshToken = response.refresh_token;
        }, { signal }).catch(() => {
          // A lost response may have rotated the refresh token. Never retry it
          // implicitly, expose provider errors containing tokens, or retry writes.
          failed = true;
          refreshToken = null;
          throw new Error('load_auth_refresh_failed');
        }).finally(() => { inFlight = null; });
      }
      await waitWithSignal(inFlight, signal);
      if (current.expiresAt - currentTime() <= requiredValidityMs) throw new Error('insufficient_auth_lifetime');
      return current;
    },
  });
}
