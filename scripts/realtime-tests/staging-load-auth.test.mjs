import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoadActorAuth, createTokenEndpointLimiter, validateLoadAuthResponse } from './staging-load-auth.mjs';

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const START = 1_800_000_000_000;
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const jwt = claims => `${Buffer.from('{"alg":"fixture"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
function response({ at = START, ttl = 3600, user = USER, sub = user, session = SESSION, exp = Math.floor(at / 1000) + ttl,
  refreshToken = 'private-refresh-fixture' } = {}) {
  return { user: { id: user }, access_token: jwt({ sub, session_id: session, exp }), refresh_token: refreshToken, expires_in: ttl };
}
class Clock {
  time = START;
  waiters = new Set();
  now = () => this.time;
  sleep = (milliseconds, { signal } = {}) => new Promise((resolve, reject) => {
    const waiter = { at: this.time + milliseconds, resolve: () => { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); };
    const cleanup = () => { this.waiters.delete(waiter); signal?.removeEventListener('abort', abort); };
    this.waiters.add(waiter);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  advance(milliseconds) {
    this.time += milliseconds;
    for (const waiter of [...this.waiters]) if (waiter.at <= this.time) waiter.resolve();
  }
  limiter(intervalMs = 2100) { return createTokenEndpointLimiter({ intervalMs, now: this.now, sleep: this.sleep }); }
}

test('trusted login response validates user, subject, session and both conservative expiry bounds', () => {
  const login = response();
  const parsed = validateLoadAuthResponse(login, { requestStartedAt: START, now: START + 3000 });
  assert.equal(parsed.userId, USER); assert.equal(parsed.sessionId, SESSION);
  assert.equal(parsed.expiresAt, START + 3600_000);
  assert.equal(parsed.refreshToken, undefined);
  assert.equal(validateLoadAuthResponse(response({ exp: START / 1000 + 100 }), { requestStartedAt: START, now: START }).expiresAt, START + 100_000);
  assert.equal(validateLoadAuthResponse(response({ at: START + 2000 }), { requestStartedAt: START, now: START + 3000 }).expiresAt, START + 3600_000);
});

test('malformed identity, response fields, claims, tokens and expired grants are rejected without echoing secrets', () => {
  const invalid = [
    response({ user: 'not-a-user' }), response({ sub: OTHER }), response({ session: 'not-a-session' }),
    response({ exp: START / 1000 }), response({ exp: '3600' }), response({ exp: 1.2 }),
    response({ ttl: 0 }), response({ ttl: -1 }), response({ ttl: Infinity }), response({ ttl: '3600' }),
    response({ refreshToken: '' }), response({ refreshToken: ' private ' }),
    { ...response(), access_token: 'private-access-fixture' },
    { ...response(), access_token: 'e30.%%%25.fixture' }, { ...response(), access_token: 'e30.bnVsbA.fixture' },
  ];
  for (const item of invalid) {
    assert.throws(() => validateLoadAuthResponse(item, { requestStartedAt: START, now: START }),
      { message: 'invalid_load_auth_response' });
  }
  assert.throws(() => validateLoadAuthResponse(response(), { requestStartedAt: START, now: START, expectedUserId: OTHER }));
  assert.throws(() => validateLoadAuthResponse(response(), { requestStartedAt: START, now: START, expectedSessionId: OTHER }));
});

test('global limiter spaces provision and refresh starts while earlier responses remain in flight', async () => {
  const clock = new Clock(), limiter = clock.limiter(), slow = deferred(), starts = [];
  const login = limiter.run(({ requestStartedAt }) => { starts.push(['login', requestStartedAt]); return slow.promise; });
  const refresh = limiter.run(({ requestStartedAt }) => { starts.push(['refresh', requestStartedAt]); return 'refreshed'; });
  const nextLogin = limiter.run(({ requestStartedAt }) => { starts.push(['login2', requestStartedAt]); return 'logged-in'; });
  await flush(); assert.deepEqual(starts, [['login', START]]);
  clock.advance(2099); await flush(); assert.equal(starts.length, 1);
  clock.advance(1); await flush(); assert.equal(await refresh, 'refreshed');
  clock.advance(2100); await flush(); assert.equal(await nextLogin, 'logged-in');
  assert.deepEqual(starts.map(item => item[1]), [START, START + 2100, START + 4200]);
  slow.resolve('login-completed'); assert.equal(await login, 'login-completed');
});

test('aborting rate-limit waits is prompt, starts no request and does not poison the shared queue', async () => {
  const clock = new Clock(), limiter = clock.limiter(), controller = new AbortController();
  await limiter.run(() => 'first');
  let calls = 0;
  const waiting = limiter.run(() => { calls++; }, { signal: controller.signal });
  const rejected = assert.rejects(waiting, { name: 'AbortError' });
  await flush(); controller.abort(); await rejected;
  assert.equal(calls, 0); assert.equal(clock.waiters.size, 0);
  const next = limiter.run(() => { calls++; return 'next'; });
  await flush(); clock.advance(2100); await flush(); assert.equal(await next, 'next');
  assert.equal(calls, 1);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(limiter.run(() => { calls++; }, { signal: alreadyAborted.signal }), { name: 'AbortError' });
  await flush(); assert.equal(calls, 1);
});

test('a queued caller aborts even while another caller owns the limiter wait', async () => {
  const clock = new Clock(), limiter = clock.limiter(), controller = new AbortController();
  await limiter.run(() => 'first');
  const head = limiter.run(() => 'head');
  let cancelledCalls = 0;
  const queued = limiter.run(() => { cancelledCalls++; }, { signal: controller.signal });
  const rejected = assert.rejects(queued, { name: 'AbortError' });
  await flush(); controller.abort(); await rejected;
  assert.equal(clock.time, START); assert.equal(clock.waiters.size, 1);
  clock.advance(2100); await flush(); assert.equal(await head, 'head');
  assert.equal(cancelledCalls, 0);
});

test('healthy token survives ten-minute preparation and refreshes only when needed, with rotated token kept private', async () => {
  const clock = new Clock(), limiter = clock.limiter(0), used = [];
  const auth = createLoadActorAuth({ loginResponse: response(), requestStartedAt: START, now: clock.now, limiter,
    refresh: async ({ refreshToken }) => {
      used.push(refreshToken);
      return response({ at: clock.now(), refreshToken: `private-rotation-${used.length}` });
    } });
  clock.advance(600_000); assert.equal((await auth.credentials()).accessToken, response().access_token);
  assert.equal(used.length, 0);
  clock.advance(2950_000); await auth.credentials(); assert.deepEqual(used, ['private-refresh-fixture']);
  clock.advance(3550_000); await auth.credentials(); assert.deepEqual(used, ['private-refresh-fixture', 'private-rotation-1']);
  assert.doesNotMatch(JSON.stringify(auth), /private|access_token|refresh_token/);
  assert.deepEqual(Object.keys(auth.snapshot()).sort(), ['expiresAt', 'failed', 'refreshing', 'sessionId', 'userId']);
  assert.equal(auth.snapshot().failed, false);
});

test('actor concurrency shares exactly one refresh and an aborted secondary waiter does not cancel it', async () => {
  const clock = new Clock(), reply = deferred(); let requests = 0;
  const auth = createLoadActorAuth({ loginResponse: response({ ttl: 100 }), requestStartedAt: START, now: clock.now,
    limiter: clock.limiter(0), refresh: () => { requests++; return reply.promise; } });
  clock.advance(50_000);
  const first = auth.credentials(), second = auth.credentials();
  const controller = new AbortController(), cancelled = auth.credentials({ signal: controller.signal });
  const cancellation = assert.rejects(cancelled, { name: 'AbortError' });
  await flush(); controller.abort(); await cancellation;
  assert.equal(requests, 1); assert.equal(auth.snapshot().refreshing, true);
  reply.resolve(response({ at: clock.now() }));
  const [a, b] = await Promise.all([first, second]); assert.equal(a.accessToken, b.accessToken);
  assert.equal(requests, 1); assert.equal(auth.snapshot().failed, false);
});

test('refresh failures and lost responses are single-shot, sanitized and never trigger an implicit retry', async () => {
  for (const failure of [() => { throw new Error('private-refresh-fixture'); },
    () => response({ at: START + 50_000, user: OTHER }),
    () => response({ at: START + 50_000, session: OTHER }),
    () => response({ ttl: 100 })]) {
    const clock = new Clock(); let requests = 0;
    const auth = createLoadActorAuth({ loginResponse: response({ ttl: 100 }), requestStartedAt: START,
      now: clock.now, limiter: clock.limiter(0), refresh: () => { requests++; return failure(); } });
    clock.advance(50_000);
    await assert.rejects(auth.credentials(), { message: 'load_auth_refresh_failed' });
    await assert.rejects(auth.credentials(), { message: 'load_auth_refresh_failed' });
    assert.equal(requests, 1); assert.equal(auth.snapshot().failed, true);
  }
});

test('owner abort prevents a late refresh response from reviving an actor', async () => {
  const clock = new Clock(), reply = deferred(), controller = new AbortController(); let requests = 0;
  const auth = createLoadActorAuth({ loginResponse: response({ ttl: 100 }), requestStartedAt: START,
    now: clock.now, limiter: clock.limiter(0), refresh: () => { requests++; return reply.promise; } });
  clock.advance(50_000);
  const pending = auth.credentials({ signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await flush(); controller.abort(); await rejected;
  reply.resolve(response({ at: clock.now() })); await flush();
  await assert.rejects(auth.credentials(), { message: 'load_auth_refresh_failed' });
  assert.equal(auth.snapshot().expiresAt, START + 100_000); assert.equal(requests, 1);
});

test('a requested operation lifetime refreshes in advance, without adding a write or retry API', async () => {
  const clock = new Clock(); let refreshes = 0;
  const auth = createLoadActorAuth({ loginResponse: response(), requestStartedAt: START,
    now: clock.now, limiter: clock.limiter(0), refresh: () => { refreshes++; return response({ at: clock.now() }); } });
  const credentials = await auth.credentials({ requiredValidityMs: 2400_000 });
  assert.equal(credentials.userId, USER); assert.equal(refreshes, 0);
  clock.advance(120_000);
  const fresh = await auth.credentials({ requiredValidityMs: 3550_000 });
  assert.equal(refreshes, 1); assert.equal(fresh.expiresAt - clock.now(), 3600_000);
  assert.deepEqual(Object.keys(auth).sort(), ['credentials', 'snapshot']);
});

test('actor refresh and provision share one global token start limiter', async () => {
  const clock = new Clock(), limiter = clock.limiter(), starts = [];
  const auth = createLoadActorAuth({ loginResponse: response({ ttl: 100 }), requestStartedAt: START,
    now: clock.now, limiter, refresh: ({ requestStartedAt }) => {
      starts.push(['refresh', requestStartedAt]); return response({ at: clock.now() });
    } });
  clock.advance(50_000);
  await limiter.run(({ requestStartedAt }) => { starts.push(['provision', requestStartedAt]); });
  const refreshed = auth.credentials();
  await flush(); assert.equal(starts.length, 1);
  clock.advance(2100); await flush(); await refreshed;
  assert.deepEqual(starts, [['provision', START + 50_000], ['refresh', START + 52_100]]);
});
