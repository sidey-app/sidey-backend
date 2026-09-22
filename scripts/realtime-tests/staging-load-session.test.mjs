import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLoadLease, renewLoadSession, loadAuthorizationDeadline, createLoadAuthorizationTimer } from './staging-load-session.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const config = { database: 'https://staging.example', apiKey: 'synthetic' };
const descriptor = { roomId: id, epoch: 1, path: `v2/rooms/${id}/epochs/1` };
const lease = { enabled: true, protocolVersion: 2, mode: 'live', databaseURL: config.database,
  firebaseApiKey: config.apiKey, sessionId: id, streams: [descriptor], serverTime: 1000000,
  leaseExpiresAt: 1600000, customToken: 'synthetic' };
test('renewal deadline uses server time without trusting the local clock', () => {
  const value = validateLoadLease(lease, { ...config, user: { room: { id } }, now: 2000000 });
  assert.equal(value.renewAt, 2540000); assert.equal(value.serverClockOffset, -1000000);
  for (const invalid of [{ ...lease, leaseExpiresAt: 1001000 }, { ...lease, leaseExpiresAt: 1800000 },
    { ...lease, databaseURL: 'https://production.example' }, { ...lease, streams: [] }]) {
    assert.throws(() => validateLoadLease(invalid, { ...config, user: { room: { id } } }));
  }
  assert.throws(() => validateLoadLease(lease, { ...config, user: { room: { id }, sessionId: id, descriptor: { epoch: 2 } } }), /identity_changed/);
});
function fixture() {
  const steps = [], seen = new Set(['old-event']);
  const stream = { closed: false, updateAuthorizationDeadline() { steps.push('deadline'); },
    close() { throw new Error('must_not_close'); } };
  const user = { ready: true, renewAt: 0, cursor: '123', stream, seen,
    room: { id }, sessionId: id, descriptor, leaseExpiresAt: 1060000, leaseAuthorizationExpiresAt: 1060000,
    serverClockOffset: 0, firebaseTokenExpiresAt: 4600000, firebaseToken: 'original' };
  const ops = { now: () => 1000000, bootstrap: async () => { steps.push('bootstrap'); return lease; },
    validate: value => validateLoadLease(value, { ...config, user, now: 1000000 }) };
  return { steps, user, stream, seen, ops };
}
test('same identity renewal preserves stream, token, cursor and dedup without an initial snapshot gap', async () => {
  const { steps, user, stream, seen, ops } = fixture();
  ops.bootstrap = async () => { steps.push('bootstrap'); seen.add('during-renewal'); return lease; };
  assert.equal(await renewLoadSession(user, ops), true);
  assert.deepEqual(steps, ['bootstrap', 'deadline']);
  assert.equal(user.stream, stream); assert.equal(user.seen, seen); assert.equal(user.cursor, '123');
  assert.equal(user.seen.has('during-renewal'), true); assert.equal(user.firebaseToken, 'original');
  assert.equal(user.firebaseTokenExpiresAt, 4600000);
  assert.equal(loadAuthorizationDeadline(user), 1600000);
  assert.equal(user.renewals, 1); assert.equal(user.renewing, false);
  assert.equal(await renewLoadSession(user, ops), false);
});
test('pending renewal cannot install on a closed, expired or replaced stream', async () => {
  for (const change of ['closed', 'expired', 'replaced']) {
    const { user, ops } = fixture();
    ops.bootstrap = async () => {
      if (change === 'closed') user.stream.closed = true;
      if (change === 'expired') user.leaseAuthorizationExpiresAt = 1000000;
      if (change === 'replaced') user.stream = {};
      return lease;
    };
    await assert.rejects(renewLoadSession(user, ops), /renewal_stream_expired/);
    assert.equal(user.renewals, undefined); assert.equal(user.renewing, false);
  }
});
test('token expiry and unextended or changed leases cannot gain authorization from renewal', async () => {
  for (const change of ['token', 'unextended', 'session', 'epoch', 'extra-room']) {
    const { user, ops } = fixture();
    if (change === 'token') user.firebaseTokenExpiresAt = 1059999;
    ops.bootstrap = async () => change === 'unextended' ? { ...lease, leaseExpiresAt: 1060000, leaseAuthorizationExpiresAt: 1060000, serverTime: 500000 }
      : change === 'session' ? { ...lease, sessionId: '22222222-2222-4222-8222-222222222222' }
      : change === 'epoch' ? { ...lease, streams: [{ ...descriptor, epoch: 2, path: `v2/rooms/${id}/epochs/2` }] }
      : change === 'extra-room' ? { ...lease, streams: [descriptor, descriptor] } : lease;
    await assert.rejects(renewLoadSession(user, ops));
    assert.equal(user.leaseExpiresAt, 1060000); assert.equal(user.renewals, undefined);
  }
});
test('concurrent renewals are suppressed and failure leaves existing stream usable', async () => {
  const { user, ops, stream } = fixture();
  let release; const pending = new Promise(resolve => { release = resolve; });
  ops.bootstrap = async () => { await pending; throw new Error('network'); };
  const first = renewLoadSession(user, ops);
  assert.equal(await renewLoadSession(user, ops), false); release();
  await assert.rejects(first, /network/);
  assert.equal(user.stream, stream); assert.equal(stream.closed, false);
  assert.equal(user.renewals, undefined); assert.equal(user.renewing, false);
});

test('a delayed bootstrap response cannot extend the lease by its request duration', async () => {
  const { user, ops } = fixture(); let clock = 1000000;
  ops.now = () => clock;
  ops.bootstrap = async () => { clock += 9000; return lease; };
  ops.validate = (value, owner, requestedAt) => validateLoadLease(value, { ...config, user: owner, now: clock, requestStartedAt: requestedAt });
  await renewLoadSession(user, ops);
  assert.equal(user.renewAt, 1540000);
  assert.equal(user.serverClockOffset, -9000);
  assert.equal(loadAuthorizationDeadline(user), 1600000);
});

function timerFixture() {
  let clock = 1000, sequence = 0;
  const scheduled = new Map(), expired = [];
  const user = { leaseAuthorizationExpiresAt: 2000, firebaseTokenExpiresAt: 5000 };
  const timer = createLoadAuthorizationTimer({ user, now: () => clock, expire: error => expired.push(error.message),
    setTimer(callback, delay) { const id = ++sequence; scheduled.set(id, { callback, delay }); return id; },
    clearTimer(id) { scheduled.delete(id); } });
  return { user, timer, scheduled, expired, setTime: value => { clock = value; },
    next: () => { assert.equal(scheduled.size, 1); return [...scheduled.values()][0]; } };
}

test('early authorization timer callback rechecks the hard deadline without granting more time', () => {
  const f = timerFixture(); f.timer.update(); assert.equal(f.next().delay, 1000);
  f.setTime(1957); f.next().callback();
  assert.deepEqual(f.expired, []); assert.equal(f.next().delay, 43);
  assert.equal(loadAuthorizationDeadline(f.user), 2000);
  f.setTime(2000); f.next().callback();
  assert.deepEqual(f.expired, ['sse_authorization_expired']); assert.equal(f.scheduled.size, 0);
});

test('renewal fences an already queued old callback and preserves the immutable token deadline', () => {
  const f = timerFixture(); f.timer.update(); const oldCallback = f.next().callback;
  f.setTime(1500); f.user.leaseAuthorizationExpiresAt = 6000; f.timer.update();
  assert.equal(f.next().delay, 3500); oldCallback();
  assert.equal(f.next().delay, 3500); assert.deepEqual(f.expired, []);
  f.setTime(5000); f.next().callback();
  assert.deepEqual(f.expired, ['sse_authorization_expired']);
  assert.equal(f.user.firebaseTokenExpiresAt, 5000);
});

test('authorization callback reads the latest approved deadline even before explicit rearm', () => {
  const f = timerFixture(); f.timer.update();
  f.user.leaseAuthorizationExpiresAt = 3000; f.setTime(2000); f.next().callback();
  assert.equal(f.next().delay, 1000); assert.deepEqual(f.expired, []);
  f.setTime(3001); f.next().callback(); assert.deepEqual(f.expired, ['sse_authorization_expired']);
});

test('stream cleanup cancels current and already queued timers and cannot be undone by renewal', () => {
  const f = timerFixture(); f.timer.update(); const queued = f.next().callback;
  f.timer.cancel(); f.setTime(9000); queued(); f.timer.update();
  assert.deepEqual(f.expired, []); assert.equal(f.scheduled.size, 0);
});

test('already expired authorization closes immediately and invalid deadlines never schedule a timer', () => {
  const f = timerFixture(); f.setTime(2000); f.timer.update(); f.timer.update();
  assert.deepEqual(f.expired, ['sse_authorization_expired']); assert.equal(f.scheduled.size, 0);
  const invalid = timerFixture(); invalid.user.leaseAuthorizationExpiresAt = NaN;
  assert.throws(() => invalid.timer.update(), /invalid_load_lease/); assert.equal(invalid.scheduled.size, 0);
});
