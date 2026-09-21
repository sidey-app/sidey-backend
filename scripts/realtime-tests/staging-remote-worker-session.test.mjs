import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { STAGING, SOURCE_FILES } from './staging-remote-worker.mjs';
import { remoteCommand, safeMetrics, startRemoteWorker } from './staging-remote-worker-session.mjs';

const runId = '11111111-1111-4111-8111-111111111111';
const hashes = Object.fromEntries(SOURCE_FILES.map(file => [file, 'a'.repeat(64)]));
const options = () => ({ host: 'tester@192.0.2.1', directory: '/srv/sidey-backend', runId, maxSeconds: 60,
  credentials: { serviceRoleKey: 'fixture-secret', account: { project_id: STAGING.project,
    client_email: `worker@${STAGING.project}.iam.gserviceaccount.com`, private_key: '-----BEGIN PRIVATE KEY-----fixture' } } });
const snapshot = type => ({ type, runId, elapsedMs: 10, http: {}, outcomes: {},
  cpu: { user: 10, system: 1 }, memory: { rss: 1, heapTotal: 1, heapUsed: 1, external: 1, arrayBuffers: 1 } });
function fixture({ ready = true, closeOnEnd = true, mismatch = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = []; child.kill = value => { child.kills.push(value); };
  let input = '', invocation;
  child.stdin.on('data', value => {
    input += value;
    if (String(value) === '{"type":"start"}\n') {
      queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'started', runId }) + '\n'));
      return;
    }
    if (ready) queueMicrotask(() => child.stdout.write(JSON.stringify({ type: 'ready', runId, ...STAGING,
      sourceSHA256: mismatch ? {} : hashes, node: '22.20.0', maxSeconds: 60 }) + '\n'));
  });
  child.stdin.on('finish', () => {
    if (closeOnEnd) {
      child.stdout.write(JSON.stringify(snapshot('finished')) + '\n');
      queueMicrotask(() => child.emit('close', 0));
    }
  });
  return { child, input: () => input, invocation: () => invocation,
    deps: { spawnProcess: (...args) => { invocation = args; return child; }, hashProvider: async () => hashes,
      startupTimeoutMs: 50, stopTimeoutMs: 50 } };
}

test('SSH target rejects shell injection/options and preserves strict host key verification', () => {
  for (const host of ['-oProxyCommand=evil', 'a;evil', 'a$(evil)', 'a b', 'a\nb', 'a@b@c']) {
    assert.throws(() => remoteCommand(host, '/srv/worker'), /remote_ssh_target_rejected/);
  }
  for (const directory of ['relative', '/srv/../worker', '/srv/a;bad', '/srv/$(bad)', '/srv/a b']) {
    assert.throws(() => remoteCommand('host', directory), /remote_ssh_target_rejected/);
  }
  const args = remoteCommand('user@host', '/srv/worker');
  assert.ok(args.includes('BatchMode=yes')); assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.equal(args.at(-1), "exec node '/srv/worker/scripts/realtime-tests/staging-remote-worker.mjs'");
});

test('session sends credentials only through stdin and waits for confirmed graceful shutdown', async () => {
  const f = fixture(), values = [];
  const session = await startRemoteWorker({ ...options(), onMetrics: value => values.push(value) }, f.deps);
  assert.equal(session.ready.runId, runId); assert.deepEqual(session.ready.sourceSHA256, hashes);
  assert.ok(!JSON.stringify(f.invocation()).includes('fixture-secret'));
  assert.equal(f.input().trim().split('\n').length, 1);
  assert.equal(JSON.parse(f.input()).credentials.serviceRoleKey, 'fixture-secret');
  await session.start();
  f.child.stdout.write(JSON.stringify({ ...snapshot('metrics'), secret: 'must-not-forward' }) + '\n');
  const stopped = await session.stop(); assert.equal(stopped.type, 'finished');
  assert.equal(await session.stop(), stopped); assert.equal(values.length, 2);
  assert.ok(!JSON.stringify(values).includes('must-not-forward'));
});

test('ready-only session can stop without starting database polling', async () => {
  const f = fixture();
  const session = await startRemoteWorker(options(), f.deps);
  await session.stop();
  assert.ok(!f.input().includes('"type":"start"'));
  await assert.rejects(session.start(), /remote_start_failed/);
});

test('mismatched provenance and startup timeout stop SSH with fixed errors', async () => {
  for (const setup of [{ mismatch: true }, { ready: false }]) {
    const f = fixture(setup), failures = [];
    await assert.rejects(startRemoteWorker({ ...options(), onFailure: value => failures.push(value.message) }, f.deps),
      /remote_protocol_failed|remote_ready_timeout/);
    assert.equal(failures.length, 1); assert.ok(f.child.kills.includes('SIGKILL'));
  }
});

test('unexpected disconnect signals failure and cannot report a successful stop', async () => {
  const f = fixture(), failures = [];
  const session = await startRemoteWorker({ ...options(), onFailure: value => failures.push(value.message) }, f.deps);
  f.child.emit('close', 255);
  assert.deepEqual(failures, ['remote_worker_disconnected']);
  await assert.rejects(session.stop(), /remote_worker_disconnected/);
});

test('missing shutdown confirmation is bounded and reported, not assumed stopped', async () => {
  const f = fixture({ closeOnEnd: false });
  const session = await startRemoteWorker(options(), f.deps);
  await assert.rejects(session.stop(), /remote_stop_unconfirmed/);
  assert.ok(f.child.kills.includes('SIGKILL'));
});

test('remote metrics reject upstream text and sanitize extra fields', () => {
  const value = snapshot('metrics'); value.http = { 'secret response': {} };
  assert.throws(() => safeMetrics(value), /remote_protocol_failed/);
  assert.ok(!Object.hasOwn(safeMetrics({ ...snapshot('metrics'), credentials: 'secret' }), 'credentials'));
});
