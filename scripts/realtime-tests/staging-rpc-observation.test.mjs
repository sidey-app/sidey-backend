import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcObservation, directDatabaseObservation } from './staging-rpc-observation.mjs';
test('RTDB or OAuth HTTP failures cannot become database HTTP failures', () => {
  for (const failureStage of ['google_auth', 'rtdb_write']) {
    const result = directDatabaseObservation({ failureStage, upstreamStatus: 503, failureCode: 'http', timing: { dbValidationMs: 20 } });
    assert.equal(result.status, 200); assert.equal(result.failure, undefined);
  }
  assert.equal(directDatabaseObservation({ failureStage: 'input' }), undefined);
  const failed = directDatabaseObservation({ failureStage: 'db_validation', failureCode: 'timeout' });
  assert.equal(failed.status, undefined); assert.equal(failed.failure, 'timeout');
});
test('bounded samples retain complete mean/max and explicitly disclose truncation', () => {
  const state = new RpcObservation({ sampleLimit: 2 });
  for (const totalMs of [1, 2, 90]) state.record({ name: 'send_message', status: 200, totalMs });
  const row = state.snapshot().rpcs.send_message;
  assert.equal(row.attempts, 3); assert.equal(row.timings.totalMs.mean, 31);
  assert.equal(row.timings.totalMs.max, 90); assert.equal(row.timings.totalMs.count, 3);
  assert.equal(row.timings.totalMs.sampleCount, 2); assert.equal(row.timings.totalMs.truncated, true);
});
test('missing timing is absent, unknown fields and sensitive values never survive', () => {
  const state = new RpcObservation();
  state.record({ name: 'https://secret.invalid', totalMs: 1 });
  state.record({ name: 'firebase_realtime_changes', status: 200, bodyMs: NaN,
    serverTiming: { jwt: 3, transaction: -1, privateToken: 'SECRET' }, headers: { authorization: 'SECRET' } });
  const out = state.snapshot(); assert.equal(JSON.stringify(out).includes('SECRET'), false);
  const row = out.rpcs.firebase_realtime_changes;
  assert.deepEqual(Object.keys(row.timings), ['server_jwtMs']);
  out.rpcs.firebase_realtime_changes.statuses[200] = 99;
  assert.equal(state.snapshot().rpcs.firebase_realtime_changes.statuses[200], 1);
});
test('stop and timeout remain failures rather than successful zero-latency samples', () => {
  const state = new RpcObservation();
  state.record({ name: 'send_message', failure: 'stopped', totalMs: 25 });
  state.record({ name: 'send_message', failure: 'timeout', totalMs: 15000 });
  state.record({ name: 'send_message', failure: 'SECRET' });
  const row = state.snapshot().rpcs.send_message;
  assert.equal(row.responses, 0); assert.deepEqual(row.failures, { stopped: 1, timeout: 1, other: 1 });
  assert.equal(row.timings.totalMs.count, 2);
});
test('unattributed headers pair all five server stages within one request and preserve negatives', () => {
  const state = new RpcObservation();
  const timing = { jwt: 1, parse: 2, plan: 3, transaction: 4, response: 5 };
  state.record({ name: 'send_message', headersMs: 14.9, serverTiming: timing });
  let metric = state.snapshot().rpcs.send_message.timings.unattributedHeadersMs;
  assert.ok(metric.max < 0); assert.ok(metric.mean < 0);
  state.record({ name: 'send_message', headersMs: 1015, serverTiming: timing });
  state.record({ name: 'send_message', headersMs: 9999, serverTiming: { jwt: 1 } });
  metric = state.snapshot().rpcs.send_message.timings.unattributedHeadersMs;
  assert.equal(metric.count, 2); assert.equal(metric.max, 1000);
  assert.ok(Math.abs(metric.mean - 499.95) < 0.0001);
});
