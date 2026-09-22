// Synthetic session renewal, separate from native app verification. No import I/O.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validateLoadLease(value, { user, database, apiKey, now = Date.now(), requestStartedAt = now }) {
  if (value?.enabled !== true || value.protocolVersion !== 2 || value.mode !== 'live'
      || value.databaseURL !== database || value.firebaseApiKey !== apiKey
      || !UUID.test(value.sessionId || '') || !Array.isArray(value.streams) || value.streams.length !== 1
      || !Number.isSafeInteger(value.serverTime) || !Number.isSafeInteger(value.leaseExpiresAt)
      || typeof value.customToken !== 'string' || !value.customToken) throw new Error('invalid_bootstrap');
  const descriptor = value.streams.find(stream => stream.roomId === user.room.id);
  const remaining = value.leaseExpiresAt - value.serverTime;
  if (!descriptor || !Number.isSafeInteger(descriptor.epoch) || descriptor.epoch < 1
      || descriptor.path !== `v2/rooms/${user.room.id}/epochs/${descriptor.epoch}`
      || remaining < 120000 || remaining > 601000) throw new Error('invalid_load_lease');
  if (user.sessionId && (value.sessionId !== user.sessionId || descriptor.epoch !== user.descriptor?.epoch
      || descriptor.path !== user.descriptor?.path)) throw new Error('renewal_identity_changed');
  return { descriptor, sessionId: value.sessionId, serverClockOffset: value.serverTime - now,
    leaseExpiresAt: value.leaseExpiresAt, leaseAuthorizationExpiresAt: requestStartedAt + remaining,
    renewAt: requestStartedAt + remaining - 60000 };
}

// This deadline belongs to the credential actually used to open the SSE stream.
// A bootstrap custom token does not extend an already-exchanged ID token.
export function loadAuthorizationDeadline(user) {
  return Math.min(user.leaseAuthorizationExpiresAt, user.firebaseTokenExpiresAt);
}

// setTimeout may wake before the wall-clock deadline. Re-read the current
// approved lease and original credential expiry before terminating the stream.
export function createLoadAuthorizationTimer({ user, expire, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer, generation = 0, cancelled = false;
  function cancel() { cancelled = true; generation++; clearTimer(timer); timer = undefined; }
  function update() {
    if (cancelled) return;
    clearTimer(timer); timer = undefined;
    const ticket = ++generation, remaining = loadAuthorizationDeadline(user) - now();
    if (!Number.isFinite(remaining)) { cancel(); throw new Error('invalid_load_lease'); }
    if (remaining <= 0) { cancel(); expire(new Error('sse_authorization_expired')); return; }
    timer = setTimer(() => {
      if (cancelled || ticket !== generation) return;
      try { update(); }
      catch (error) { expire(error); }
    }, Math.ceil(remaining));
  }
  return Object.freeze({ update, cancel });
}

export async function renewLoadSession(user, { bootstrap, validate, now = Date.now }) {
  if (!user.ready || user.renewing || now() < user.renewAt) return false;
  const stream = user.stream;
  user.renewing = true;
  try {
    const requestedAt = now();
    const value = await bootstrap(user);
    const lease = validate(value, user, requestedAt);
    if (user.stream !== stream || stream.closed || now() >= loadAuthorizationDeadline(user)) {
      throw new Error('renewal_stream_expired');
    }
    if (!(lease.leaseExpiresAt > user.leaseExpiresAt)) throw new Error('renewal_not_extended');
    // This bounded test does not simulate a seamless one-hour credential rollover.
    if (!(user.firebaseTokenExpiresAt > now() + 60000)) throw new Error('token_rollover_required');
    Object.assign(user, lease);
    stream.updateAuthorizationDeadline();
    user.renewals = (user.renewals || 0) + 1;
    return true;
  } finally { user.renewing = false; }
}
