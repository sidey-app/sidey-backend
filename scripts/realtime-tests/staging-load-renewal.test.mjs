import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoadRenewalScheduler } from './staging-load-renewal.mjs';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(count, concurrency = 32) {
  let clock = 0;
  const users = Array.from({ length: count }, (_, index) => ({ index, ready: true, renewAt: 0,
    leaseAuthorizationExpiresAt: 60000 + index, firebaseTokenExpiresAt: 3600000 }));
  const started = [], pending = new Map(), failures = [];
  const scheduler = createLoadRenewalScheduler({ users: () => users, concurrency, now: () => clock,
    onFailure: error => failures.push(error), renew: user => {
      assert.equal(pending.has(user.index), false, 'one renewal per actor including retry waits');
      started.push(user.index);
      return new Promise((resolve, reject) => pending.set(user.index, { resolve, reject }));
    } });
  function finish(index, error) {
    const operation = pending.get(index); pending.delete(index); users[index].renewAt = Infinity;
    if (error) operation.reject(error); else operation.resolve(true);
  }
  async function stop() {
    const done = scheduler.stop();
    for (const index of [...pending.keys()]) finish(index);
    await done;
  }
  return { users, started, pending, failures, scheduler, finish, stop, setTime: value => { clock = value; } };
}

test('one slow renewal does not block 31 newly due actors on the next one-second tick', async () => {
  const f = fixture(32);
  for (const user of f.users.slice(1)) user.renewAt = 1000;
  f.scheduler.tick(); await flush(); assert.deepEqual(f.started, [0]);
  f.setTime(999); f.scheduler.tick(); await flush(); assert.equal(f.started.length, 1);
  f.setTime(1000); f.scheduler.tick(); await flush();
  assert.equal(f.started.length, 32); assert.equal(f.pending.has(0), true);
  await f.stop();
});

test('each free slot admits the currently earliest hard deadline, including token expiry', async () => {
  const f = fixture(4, 1);
  f.users[1].renewAt = -10000;
  f.users[2].leaseAuthorizationExpiresAt = 10000;
  f.users[3].firebaseTokenExpiresAt = 9000;
  f.scheduler.tick(); await flush(); assert.deepEqual(f.started, [3]);
  f.users[0].leaseAuthorizationExpiresAt = 5000;
  f.finish(3); await flush(); assert.deepEqual(f.started, [3, 0]);
  f.finish(0); await flush(); assert.deepEqual(f.started, [3, 0, 2]);
  await f.stop();
});

test('admission caps at 32, refills immediately, and never overlaps an actor during retry waits', async () => {
  const f = fixture(70);
  f.scheduler.tick(); await flush(); assert.equal(f.pending.size, 32);
  for (let i = 0; i < 10; i++) f.scheduler.tick();
  await flush(); assert.equal(f.started.length, 32);
  f.users[0].renewing = false; // Between retry attempts, ownership stays with the scheduler.
  f.finish(1); await flush();
  assert.equal(f.pending.size, 32); assert.equal(f.started.length, 33);
  assert.equal(f.started.filter(index => index === 0).length, 1);
  await f.stop(); assert.equal(f.scheduler.snapshot().active, 0);
});

test('stop drains every admitted request without starting queued or newly due actors', async () => {
  const f = fixture(4, 2);
  f.scheduler.tick(); await flush();
  let drained = false;
  const done = f.scheduler.stop().then(() => { drained = true; });
  assert.equal(f.scheduler.stop(), f.scheduler.stop());
  f.finish(0); await flush(); assert.equal(drained, false);
  f.scheduler.tick(); assert.deepEqual(f.started, [0, 1]);
  f.finish(1); await done; assert.equal(drained, true);
  assert.equal(f.scheduler.snapshot().active, 0);
  const second = fixture(1); second.scheduler.tick(); await second.stop();
  assert.deepEqual(second.started, [], 'stop also cancels admitted but not yet invoked work');
});

test('a failed renewal retains the original error and stops admission while draining its peers', async () => {
  const f = fixture(4, 2), failure = new Error('http_503');
  f.scheduler.tick(); await flush(); f.finish(0, failure); await flush();
  assert.deepEqual(f.failures, [failure]); assert.equal(f.scheduler.snapshot().failed, true);
  f.scheduler.tick(); await flush(); assert.deepEqual(f.started, [0, 1]);
  assert.equal(f.pending.has(1), true); await f.stop();
});

test('actors not ready, reconnecting, or already renewing are ineligible', async () => {
  const f = fixture(4);
  f.users[0].ready = false; f.users[1].reconnecting = true; f.users[2].renewing = true;
  f.scheduler.tick(); await flush(); assert.deepEqual(f.started, [3]); await f.stop();
});
