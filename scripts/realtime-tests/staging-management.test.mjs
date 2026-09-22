import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStagingManagementQuery, createStagingManagementToken, safeCLIError, edgeDeploymentMetadata } from './staging-management.mjs';

const token = 'sbp_fixture_secret';
const env = { SUPABASE_ACCESS_TOKEN: token };
const response = value => new Response(JSON.stringify(value));

test('extracted token provider is shared by independent callers without another credential lookup', async () => {
  let executions = 0;
  const sharedToken = createStagingManagementToken({ env: {}, platform: 'darwin', execute: async () => {
    executions++; return { stdout: token };
  } });
  const query = createStagingManagementQuery({ token: sharedToken,
    execute: () => assert.fail('must use shared provider'), fetch: async (_url, init) => {
      assert.equal(init.headers.authorization, `Bearer ${token}`); return response([]);
    } });
  const [first, second] = await Promise.all([sharedToken(), sharedToken(), query('select 1')]);
  assert.equal(first, token); assert.equal(second, token); assert.equal(executions, 1);
});

test('records the active post-secret version and rejects a changed or unknown deployment bundle', () => {
  const entry = { slug: 'realtime-publish-live', id: '11111111-1111-4111-8111-111111111111',
    status: 'ACTIVE', version: 2, updated_at: 1234, ezbr_sha256: 'a'.repeat(64) };
  const before = edgeDeploymentMetadata([entry]);
  const active = edgeDeploymentMetadata([{ ...entry, version: 3, updated_at: 5678 }], before.bundleHash);
  assert.equal(active.version, 3);
  assert.equal(before.version, 2);
  assert.equal(active.bundleHash, before.bundleHash);
  assert.equal(active.id, entry.id);
  assert.throws(() => edgeDeploymentMetadata([{ ...entry, ezbr_sha256: 'b'.repeat(64) }], before.bundleHash), /edge_deployment_changed/);
  assert.throws(() => edgeDeploymentMetadata([{ ...entry, ezbr_sha256: undefined }]), /edge_deployment_invalid/);
  assert.throws(() => edgeDeploymentMetadata([{ ...entry, status: 'INACTIVE' }]), /edge_publisher_not_deployed/);
  assert.throws(() => edgeDeploymentMetadata([entry, entry]), /edge_publisher_not_deployed/);
});

test('uses the fixed staging endpoint and env token without invoking Keychain', async () => {
  const calls = [];
  const query = createStagingManagementQuery({ env, execute: () => assert.fail('unexpected process'),
    timeoutSignal: milliseconds => { assert.equal(milliseconds, 25000); return new AbortController().signal; },
    fetch: async (url, init) => { calls.push({ url, init }); return response([{ count: 1 }]); } });
  assert.deepEqual(await query('select 1'), [{ count: 1 }]);
  assert.equal(calls[0].url, 'https://api.supabase.com/v1/projects/fjglrvhvdthntkvrduyi/database/query');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { query: 'select 1' });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('reads macOS Keychain once, including concurrent calls and encoded tokens', async () => {
  for (const prefix of ['', 'base64:', 'go-keyring-base64:']) {
    let executions = 0;
    const query = createStagingManagementQuery({ env: {}, platform: 'darwin',
      execute: async (file, args, options) => {
        executions++;
        assert.equal(file, '/usr/bin/security');
        assert.deepEqual(args, ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w']);
        assert.equal(options.timeout, 10000);
        return { stdout: (prefix ? prefix + Buffer.from(token).toString('base64') : token) + '\n' };
      }, fetch: async (_url, init) => { assert.equal(init.headers.authorization, `Bearer ${token}`); return response([]); } });
    await Promise.all([query('select 1'), query('select 2')]);
    assert.equal(executions, 1);
  }
});

test('credential failures are cached and sanitized, with no network request', async () => {
  let executions = 0;
  const query = createStagingManagementQuery({ env: {}, platform: 'darwin',
    execute: async () => { executions++; throw new Error(`provider stderr ${token}`); },
    fetch: () => assert.fail('unexpected request') });
  for (let i = 0; i < 2; i++) await assert.rejects(query('select 1'), { message: 'management_token_unavailable' });
  assert.equal(executions, 1);
  await assert.rejects(createStagingManagementQuery({ env: {}, platform: 'linux' })('select 1'), { message: 'management_token_required' });
  for (const value of ['', 'has a space', 'base64:invalid!', 'base64:AA==']) {
    await assert.rejects(createStagingManagementQuery({ env: { SUPABASE_ACCESS_TOKEN: value } })('select 1'),
      { message: 'management_token_invalid' });
  }
});

test('never retries a mutation with a lost, HTTP failure or invalid response', async () => {
  const cases = [
    [() => { throw new Error(`request includes ${token} update private.table`); }, 'management_network_failed'],
    [() => new Response(token, { status: 503 }), 'management_http_503'],
    [() => new Response(token), 'management_response_invalid'],
    [() => response({ rows: [] }), 'management_response_invalid'],
  ];
  for (const [fetchResponse, code] of cases) {
    let calls = 0;
    const query = createStagingManagementQuery({ env, fetch: async () => { calls++; return fetchResponse(); } });
    await assert.rejects(query('update private.table set enabled=false'), { message: code });
    assert.equal(calls, 1);
  }
});

test('enforces response limits on headers and chunked bodies', async () => {
  for (const headers of [{ 'content-length': '100' }, {}]) {
    let cancelled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('123456789')); },
      cancel() { cancelled = true; } });
    const query = createStagingManagementQuery({ env, maxResponseBytes: 8,
      fetch: async () => new Response(stream, { headers }) });
    await assert.rejects(query('select 1'), { message: 'management_response_limit' });
    assert.equal(cancelled, true);
  }
});

test('reports deadline failures during connection and response reading without leaking causes', async () => {
  for (const bodyTimeout of [false, true]) {
    const controller = new AbortController();
    const query = createStagingManagementQuery({ env, timeoutSignal: () => controller.signal,
      fetch: async () => {
        if (!bodyTimeout) { controller.abort(); throw new Error(token); }
        return new Response(new ReadableStream({ pull(stream) { controller.abort(); stream.error(new Error(token)); } }));
      } });
    await assert.rejects(query('select 1'), { message: 'management_timeout' });
  }
});

test('CLI error codes preserve safe diagnostics and discard original output', () => {
  for (const [source, code] of [
    [{ killed: true }, 'cli_timeout'], [{ code: 'ETIMEDOUT' }, 'cli_timeout'],
    [{ code: 1 }, 'cli_exit_1'], [{ code: 'ENOENT' }, 'cli_unavailable'],
    [{ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'cli_output_limit'],
    [{ code: token }, 'cli_failed'],
  ]) {
    const error = safeCLIError({ ...source, message: token, stdout: token, stderr: token });
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    assert.equal(error.stderr, undefined);
  }
});

test('direct gateway deployment is independently pinned and must be ACTIVE', () => {
  const entry = { slug: 'realtime-event', id: '11111111-1111-4111-8111-111111111111', status: 'ACTIVE',
    version: 3, updated_at: 1800000000000, ezbr_sha256: 'a'.repeat(64) };
  assert.equal(edgeDeploymentMetadata([entry], undefined, 'realtime-event').version, 3);
  assert.throws(() => edgeDeploymentMetadata([entry]), /not_deployed/);
  assert.throws(() => edgeDeploymentMetadata([{ ...entry, status: 'INACTIVE' }], undefined, 'realtime-event'), /not_deployed/);
  assert.throws(() => edgeDeploymentMetadata([entry], 'b'.repeat(64), 'realtime-event'), /changed/);
  assert.throws(() => edgeDeploymentMetadata([entry], undefined, 'production'), /invalid/);
});

test('wake deployment provenance is independently pinned to the exact bundle', () => {
  const entry = { slug: 'realtime-wake', id: '11111111-1111-4111-8111-111111111111', version: 1,
    updated_at: 12345, status: 'ACTIVE', ezbr_sha256: 'a'.repeat(64) };
  assert.equal(edgeDeploymentMetadata([entry], undefined, 'realtime-wake').version, 1);
  assert.throws(() => edgeDeploymentMetadata([entry], 'b'.repeat(64), 'realtime-wake'), /changed/);
});
