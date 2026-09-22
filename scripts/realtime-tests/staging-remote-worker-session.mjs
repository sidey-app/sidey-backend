// Local SSH controller. Secrets are only sent via stdin, never argv/env/files/logs.
import { spawn } from 'node:child_process';
import { BILLING_NOTE, SOURCE_FILES, STAGING, sourceHashes, validateConfiguration } from './staging-remote-worker.mjs';

export function remoteCommand(host, directory) {
  if (typeof host !== 'string' || host.length > 253
      || !/^(?:[a-zA-Z_][a-zA-Z0-9_-]*@)?[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)
      || host.includes('..') || typeof directory !== 'string'
      || !/^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(directory)) {
    throw new Error('remote_ssh_target_rejected');
  }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3',
    host, `exec node ${quote(`${directory}/scripts/realtime-tests/staging-remote-worker.mjs`)}`];
}
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const fields = ['count', 'errors', 'requestBodyBytes', 'responseBodyBytes', 'durationMs', 'maxDurationMs'];
const outcomes = new Set(['publish_ok', 'publish_retry', 'cleanup_lease_ok', 'cleanup_lease_retry',
  'cleanup_event_ok', 'cleanup_event_retry', 'cleanup_epoch_ok', 'cleanup_epoch_retry', 'batch_retry', 'maintenance_retry']);
// Treat all remote output as untrusted. Never forward arbitrary fields or error text.
export function safeMetrics(value) {
  if (!finite(value.elapsedMs) || !value.http || !value.outcomes || !value.cpu || !value.memory) throw new Error('remote_protocol_failed');
  const http = {}, resultOutcomes = {};
  for (const [key, row] of Object.entries(value.http)) {
    if (!/^(?:oauth\.token|rpc\.(?:claim_firebase_live|finish_firebase_live|firebase_live_maintenance|finish_firebase_live_cleanup)|rtdb\.(?:access|lease|hint|event|presence|epoch)\.(?:GET|PUT|DELETE))$/.test(key)
        || fields.some(field => !finite(row[field])) || !row.statuses) throw new Error('remote_protocol_failed');
    const statuses = {};
    for (const [code, count] of Object.entries(row.statuses)) {
      if (!/^[1-5][0-9]{2}$/.test(code) || !finite(count)) throw new Error('remote_protocol_failed');
      statuses[code] = count;
    }
    http[key] = { ...Object.fromEntries(fields.map(field => [field, row[field]])), statuses };
  }
  for (const [key, count] of Object.entries(value.outcomes)) {
    if (!outcomes.has(key) || !finite(count)) throw new Error('remote_protocol_failed');
    resultOutcomes[key] = count;
  }
  const cpu = {}, memory = {};
  for (const key of ['user', 'system']) {
    if (!finite(value.cpu[key])) throw new Error('remote_protocol_failed');
    cpu[key] = value.cpu[key];
  }
  for (const key of ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']) {
    if (!finite(value.memory[key])) throw new Error('remote_protocol_failed');
    memory[key] = value.memory[key];
  }
  return { elapsedMs: value.elapsedMs, http, outcomes: resultOutcomes, cpu, memory, billingNote: BILLING_NOTE };
}

export async function startRemoteWorker({ host, directory, runId, credentials, onMetrics = () => {},
  onFailure = () => {}, maxSeconds = 3600, signal },
  { spawnProcess = spawn, hashProvider = sourceHashes, startupTimeoutMs = 45000, stopTimeoutMs = 30000 } = {}) {
  const args = remoteCommand(host, directory), hashes = await hashProvider();
  const config = { ...STAGING, runId, credentials, maxSeconds, sourceSHA256: hashes };
  validateConfiguration(config);
  signal?.throwIfAborted();
  const wireConfig = `${JSON.stringify(config)}\n`;
  if (Buffer.byteLength(wireConfig) > 65536) throw new Error('remote_configuration_rejected');
  let child;
  // Do not inherit credential-bearing shell environment variables into SSH.
  const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'SSH_AUTH_SOCK']
    .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
  try { child = spawnProcess('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env }); }
  catch { throw new Error('remote_ssh_failed'); }
  let stopping = false, closed = false, failure, ready, finished, started, lineBuffer = '', startTimer, lifeTimer, stopPromise;
  let startPromise, resolveStarted, rejectStarted, startedTimer;
  let resolveReady, rejectReady, resolveClose;
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closePromise = new Promise(resolve => { resolveClose = resolve; });
  const fail = code => {
    if (failure) return;
    failure = new Error(code);
    rejectReady(failure);
    rejectStarted?.(failure);
    try { onFailure(failure); } catch { /* Callback errors must not prevent shutdown. */ }
    child.stdin.destroy(); child.kill('SIGTERM');
  };
  const abort = () => fail('remote_parent_aborted');
  signal?.addEventListener('abort', abort, { once: true });
  const dispose = () => {
    clearTimeout(startTimer); clearTimeout(lifeTimer); clearTimeout(startedTimer);
    signal?.removeEventListener('abort', abort);
  };
  child.once('error', () => { fail('remote_ssh_failed'); closed = true; dispose(); resolveClose(); });
  child.once('close', code => {
    closed = true; dispose();
    if (!stopping || !finished || code !== 0) fail('remote_worker_disconnected');
    resolveClose();
  });
  child.stdin.on('error', () => { if (!stopping) fail('remote_stdin_failed'); });
  child.stderr.resume(); // Discard SSH diagnostics: never forward arbitrary remote stderr.
  child.stderr.on('error', () => fail('remote_ssh_failed'));
  child.stdout.on('error', () => fail('remote_protocol_failed'));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (failure) return;
    lineBuffer += chunk;
    if (Buffer.byteLength(lineBuffer) > 262144) return fail('remote_protocol_failed');
    let newline;
    while ((newline = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, newline); lineBuffer = lineBuffer.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        if (value.runId !== runId) throw new Error('remote_protocol_failed');
        if (value.type === 'ready' && !ready && !finished) {
          if (value.maxSeconds !== maxSeconds || !/^22\.[0-9]+\.[0-9]+$/.test(value.node)
              || Object.entries(STAGING).some(([key, item]) => value[key] !== item)
              || !value.sourceSHA256 || Object.keys(value.sourceSHA256).length !== SOURCE_FILES.length
              || SOURCE_FILES.some(file => value.sourceSHA256[file] !== hashes[file])) throw new Error('remote_protocol_failed');
          ready = { ...STAGING, runId, sourceSHA256: hashes, node: value.node, maxSeconds };
          clearTimeout(startTimer); resolveReady(ready);
        } else if (ready && startPromise && !started && !finished && value.type === 'started') {
          started = { type: 'started', runId };
          clearTimeout(startedTimer); resolveStarted(started);
        } else if (ready && !finished && ['metrics', 'finished'].includes(value.type)) {
          if (value.type === 'metrics' && !started) throw new Error('remote_protocol_failed');
          const snapshot = { type: value.type, runId, ...safeMetrics(value) };
          if (value.type === 'finished') {
            finished = snapshot;
            if (!stopping) return fail('remote_worker_ended_early');
          }
          onMetrics(snapshot);
        } else throw new Error('remote_protocol_failed');
      } catch { return fail('remote_protocol_failed'); }
    }
  });
  startTimer = setTimeout(() => fail('remote_ready_timeout'), startupTimeoutMs);
  lifeTimer = setTimeout(() => fail('remote_lifetime_exceeded'), maxSeconds * 1000 + startupTimeoutMs);
  child.stdin.write(wireConfig); // Keep stdin open; EOF is the remote graceful-stop signal.
  try { await readyPromise; }
  catch {
    dispose(); child.stdin.destroy(); child.kill('SIGKILL');
    throw failure || new Error('remote_start_failed');
  }
  return {
    ready,
    start() {
      if (startPromise) return startPromise;
      if (stopping || closed || failure) return Promise.reject(failure || new Error('remote_start_failed'));
      startPromise = new Promise((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
      startedTimer = setTimeout(() => fail('remote_start_timeout'), startupTimeoutMs);
      child.stdin.write('{"type":"start"}\n');
      return startPromise;
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      if (startPromise && !started) rejectStarted(new Error('remote_start_aborted'));
      stopPromise = (async () => {
        if (!closed) child.stdin.end();
        let timer;
        try {
          await Promise.race([closePromise, new Promise((_, reject) => {
            timer = setTimeout(() => {
              fail('remote_stop_unconfirmed'); child.kill('SIGKILL'); reject(new Error('remote_stop_unconfirmed'));
            }, stopTimeoutMs);
          })]);
          if (failure) throw failure;
          if (!finished) throw new Error('remote_stop_unconfirmed');
          return finished;
        } finally { clearTimeout(timer); dispose(); }
      })();
      return stopPromise;
    },
  };
}
