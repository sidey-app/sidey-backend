import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StagingEdgeSession, edgeCounters } from './staging-edge-session.mjs';
const runId = '11111111-1111-4111-8111-111111111111';
const state = phase => ({ phase, sampled_at: '2026-09-18T12:00:00Z', lease_expired: false,
  cleanup_running: false, direct_inflight: false, cleanup_totals: {}, enqueue_count: '3', started_count: '2', finished_count: '1', cumulative_totals: { responseBodyBytes: 120 } });

test('preflight refuses missing credentials, an active dispatcher or an existing cron before start', async () => {
  for (const key of ['pipeline_ready', 'region_off', 'direct_off', 'cleanup_idle', 'fast_dispatch_ready', 'secret_ready', 'config_off', 'dispatch_idle', 'cron_absent']) {
    const row = { pipeline_ready: true, region_off: true, direct_off: true, cleanup_idle: true, fast_dispatch_ready: true, secret_ready: true, config_off: true, dispatch_idle: true, cron_absent: true, [key]: false };
    const session = new StagingEdgeSession({ runId, query: async () => [row] });
    await assert.rejects(session.preflight(), /baseline_not_ready/);
    assert.equal(session.mayBeRunning, false);
  }
  assert.throws(() => new StagingEdgeSession({ runId: "';drop table x;" }), /invalid_edge_run/);
});

test('a lost start response still requires confirmed shutdown and waits for active work', async () => {
  let clock = 0, failStart = true;
  const phases = ['running', 'running', null];
  const session = new StagingEdgeSession({ runId, now: () => clock, sleep: async ms => { clock += ms; },
    query: async sql => {
      if (failStart) { failStart = false; throw new Error('response_lost_after_commit'); }
      return sql.startsWith('select phase,') ? [state(phases.shift())] : [];
    } });
  await assert.rejects(session.start(), /response_lost/);
  assert.equal(session.mayBeRunning, true);
  await session.stop();
  assert.equal(clock, 2000);
  assert.equal(session.mayBeRunning, false);
});

test('a stuck or expired running dispatch never permits destructive cleanup', async () => {
  let clock = 0;
  const session = new StagingEdgeSession({ runId, now: () => clock, sleep: async ms => { clock += ms; },
    query: async sql => sql.startsWith('select phase,') ? [state('running')] : [] });
  await session.start();
  await assert.rejects(session.stop(), /edge_stop_unconfirmed/);
  assert.equal(session.mayBeRunning, true);
});

test('ownership rejection does not report a successful stop', async () => {
  let denied = false;
  const session = new StagingEdgeSession({ runId, query: async () => {
    if (denied) throw new Error('edge_stop_owner_mismatch');
    return [];
  } });
  await session.start(); denied = true;
  await assert.rejects(session.stop(), /owner_mismatch/);
  assert.equal(session.mayBeRunning, true);
});

test('Edge metrics accept initial zero totals but reject absent or unsafe measurements', async () => {
  assert.equal(edgeCounters({}).responseBodyBytes, 0);
  assert.equal(edgeCounters({ responseBodyBytes: 22, upstreamSecret: 'never returned' }).responseBodyBytes, 22);
  assert.equal(edgeCounters({ rtdbRequests: 2, rtdbRequestMs: 71 }).rtdbRequestMs, 71);
  assert.equal(Object.hasOwn(edgeCounters({ rtdbRequestMaxMs: 71 }), 'rtdbRequestMaxMs'), false);
  assert.equal(Object.hasOwn(edgeCounters({ upstreamSecret: 'never returned' }), 'upstreamSecret'), false);
  for (const value of [null, undefined, [], { responseBodyBytes: -1 }, { responseBodyBytes: '12' }, { responseBodyBytes: Infinity }]) {
    assert.throws(() => edgeCounters(value), /invalid_edge_metrics/);
  }
  const session = new StagingEdgeSession({ runId, query: async () => [{ ...state(null), started_count: '9007199254740993' }] });
  await assert.rejects(session.sample(), /invalid_edge_metrics/);
});

test('combined metrics include independently completed cleanup without losing either source', async () => {
  const session = new StagingEdgeSession({ runId, query: async () => [{ ...state(null),
    cumulative_totals: { responseBodyBytes: 120, rtdbRequests: 2 },
    cleanup_totals: { responseBodyBytes: 70, rtdbRequests: 4, cleanupCompleted: 3 } }] });
  const sample = await session.sample();
  assert.equal(sample.totals.responseBodyBytes, 190);
  assert.equal(sample.totals.rtdbRequests, 6);
  assert.equal(sample.totals.cleanupCompleted, 3);
  assert.equal(sample.publicationTotals.responseBodyBytes, 120);
  assert.equal(sample.cleanupTotals.responseBodyBytes, 70);
});

test('stop waits for a separate cleaner and potentially in-flight direct writes after publication settles', async () => {
  let clock = 0;
  const pending = [
    { cleanup_running: true, direct_inflight: true },
    { cleanup_running: false, direct_inflight: true },
    { cleanup_running: false, direct_inflight: false },
  ];
  const calls = [];
  const session = new StagingEdgeSession({ runId, directEvents: true, now: () => clock,
    sleep: async ms => { clock += ms; }, query: async sql => {
      calls.push(sql);
      return sql.startsWith('select phase,') ? [{ ...state(null), ...pending.shift() }] : [];
    } });
  await session.start();
  assert.match(calls[0], /direct_events_enabled=true/);
  await session.stop();
  assert.equal(clock, 2000); assert.equal(session.mayBeRunning, false);
  assert.match(calls[1], /direct_events_enabled=false/);
  assert.match(calls.at(-1), /firebase_live_cleanup_state set dispatch_id=null,owner_run_id=null/);
});

for (const field of ['cleanup_running', 'direct_inflight']) test(`stuck ${field} prevents deletion even after publication ends`, async () => {
  let clock = 0;
  const session = new StagingEdgeSession({ runId, now: () => clock, sleep: async ms => { clock += ms; },
    query: async sql => sql.startsWith('select phase,') ? [{ ...state(null), [field]: true }] : [] });
  await session.start();
  await assert.rejects(session.stop(), /edge_stop_unconfirmed/);
  assert.equal(session.mayBeRunning, true);
});

test('dispatch timing only includes a matched enqueue/admission pair and validates bounded numeric evidence', async () => {
  for (const [raw, expected] of [[null, null], ['1250.5', 1250.5], [0, 0]]) {
    const session = new StagingEdgeSession({ runId, query: async () => [{ ...state(null), enqueue_to_admission_ms: raw }] });
    assert.equal((await session.sample()).enqueueToAdmissionMs, expected);
  }
  for (const raw of [-1, 'NaN', Infinity]) {
    const session = new StagingEdgeSession({ runId, query: async () => [{ ...state(null), enqueue_to_admission_ms: raw }] });
    await assert.rejects(session.sample(), /invalid_edge_metrics/);
  }
});

test('region is server-owned for one staging run and reset only after confirmed stop', async () => {
  assert.throws(() => new StagingEdgeSession({ runId, edgeRegion: "bad';--" }), /invalid_edge_region/);
  const calls = [];
  const session = new StagingEdgeSession({ runId, edgeRegion: 'ap-southeast-1',
    query: async sql => { calls.push(sql); return sql.startsWith('select phase,') ? [state(null)] : []; } });
  await session.start();
  assert.match(calls[0], /edge_region='ap-southeast-1'/);
  await session.stop();
  assert.match(calls.at(-1), /edge_region=null/);
});
