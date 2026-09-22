// Fixed staging destination; no token, query, provider body or subprocess output is logged.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const endpoint = 'https://api.supabase.com/v1/projects/fjglrvhvdthntkvrduyi/database/query';
const executeDefault = promisify(execFile);
const fail = code => { throw new Error(code); };

export function edgeDeploymentMetadata(entries, expectedBundleHash, slug = 'realtime-publish-live') {
  if (!Array.isArray(entries) || !['realtime-publish-live', 'realtime-event', 'realtime-wake'].includes(slug)) fail('edge_deployment_invalid');
  const matching = entries.filter(entry => entry.slug === slug || entry.name === slug);
  const entry = matching[0];
  if (matching.length !== 1 || entry.status !== 'ACTIVE') fail('edge_publisher_not_deployed');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.id || '')
    || !Number.isSafeInteger(entry.version) || entry.version < 1
    || !Number.isSafeInteger(entry.updated_at) || entry.updated_at <= 0
    || !/^[0-9a-f]{64}$/.test(entry.ezbr_sha256 || '')) fail('edge_deployment_invalid');
  if (expectedBundleHash !== undefined && entry.ezbr_sha256 !== expectedBundleHash) fail('edge_deployment_changed');
  return { id: entry.id, version: entry.version, updatedAt: entry.updated_at, bundleHash: entry.ezbr_sha256 };
}

export function safeCLIError(error) {
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new Error('cli_output_limit');
  if (error?.killed || error?.code === 'ETIMEDOUT') return new Error('cli_timeout');
  if (error?.code === 'ENOENT') return new Error('cli_unavailable');
  if (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255) return new Error(`cli_exit_${error.code}`);
  return new Error('cli_failed');
}

function decodeToken(value) {
  if (typeof value !== 'string') fail('management_token_invalid');
  let token = value.trim();
  for (const prefix of ['go-keyring-base64:', 'base64:']) if (token.startsWith(prefix)) {
    const encoded = token.slice(prefix.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) fail('management_token_invalid');
    token = Buffer.from(encoded, 'base64').toString('utf8').trim();
    break;
  }
  if (!/^[\x21-\x7e]{1,4096}$/.test(token)) fail('management_token_invalid');
  return token;
}

export function createStagingManagementToken({ execute = executeDefault, env = process.env, platform = process.platform } = {}) {
  let tokenPromise;
  return () => tokenPromise ||= (async () => {
    if (env.SUPABASE_ACCESS_TOKEN !== undefined) return decodeToken(env.SUPABASE_ACCESS_TOKEN);
    if (platform !== 'darwin') fail('management_token_required');
    let result;
    try {
      result = await execute('/usr/bin/security', ['find-generic-password', '-s', 'Supabase CLI', '-a', 'supabase', '-w'],
        { timeout: 10000, maxBuffer: 16384 });
    } catch { fail('management_token_unavailable'); }
    return decodeToken(result.stdout);
  })();
}

export function createStagingManagementQuery({ fetch: fetcher = globalThis.fetch, execute = executeDefault,
  env = process.env, platform = process.platform, timeoutSignal = milliseconds => AbortSignal.timeout(milliseconds),
  maxResponseBytes = 1024 * 1024, token = createStagingManagementToken({ execute, env, platform }) } = {}) {
  return async function query(sql) {
    if (typeof sql !== 'string' || !sql.trim()) fail('management_query_invalid');
    const authorization = `Bearer ${await token()}`;
    const signal = timeoutSignal(25000);
    let response;
    try {
      // Deliberately one attempt: an absent response cannot prove a mutation rolled back.
      response = await fetcher(endpoint, { method: 'POST', redirect: 'error', signal,
        headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ query: sql }) });
    } catch { fail(signal.aborted ? 'management_timeout' : 'management_network_failed'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail(`management_http_${response.status}`);
    }
    if (Number(response.headers.get('content-length')) > maxResponseBytes) {
      await response.body?.cancel().catch(() => {});
      fail('management_response_limit');
    }
    const reader = response.body?.getReader();
    if (!reader) fail('management_response_invalid');
    const chunks = []; let size = 0;
    try {
      for (;;) {
        let next;
        try { next = await reader.read(); }
        catch { fail(signal.aborted ? 'management_timeout' : 'management_response_read_failed'); }
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxResponseBytes) {
          await reader.cancel().catch(() => {});
          fail('management_response_limit');
        }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { fail('management_response_invalid'); }
    if (!Array.isArray(result)) fail('management_response_invalid');
    return result;
  };
}
