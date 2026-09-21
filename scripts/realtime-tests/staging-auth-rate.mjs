// Temporary preparation-only override. No import I/O; never changes production.
import { createStagingManagementToken } from './staging-management.mjs';

const PROJECT = 'fjglrvhvdthntkvrduyi';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT}/config/auth`;
const BEFORE = 150, DESIRED = 1500, MAX_RESPONSE = 256 * 1024;
const fail = code => { throw new Error(code); };

// The caller must await restore() in finally around apply AND account preparation.
// checkpoint persists only the non-secret recovery snapshot, before any PATCH.
export class StagingAuthRateOverride {
  #approved; #token; #fetch; #timeout; #checkpoint;
  #before = null; #pending = false; #applied = false; #restored = false; #busy = false;
  constructor({ approved2400 = false, token = createStagingManagementToken(), fetch: fetcher = globalThis.fetch,
    timeoutSignal = milliseconds => AbortSignal.timeout(milliseconds), checkpoint = async () => {} } = {}) {
    this.#approved = approved2400 === true; this.#token = token; this.#fetch = fetcher;
    this.#timeout = timeoutSignal; this.#checkpoint = checkpoint;
  }
  snapshot() {
    return { project: PROJECT, before: this.#before, desired: DESIRED,
      pending: this.#pending, applied: this.#applied, restored: this.#restored };
  }
  async #save() {
    try { await this.#checkpoint(this.snapshot()); }
    catch { fail('auth_rate_checkpoint_failed'); }
  }
  async #request(method, rate) {
    if (method === 'PATCH' && !this.#approved) fail('auth_rate_approval_required');
    let token;
    try { token = await this.#token(); }
    catch { fail('auth_rate_token_unavailable'); }
    if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) fail('auth_rate_token_invalid');
    const authorization = `Bearer ${token}`, signal = this.#timeout(25000);
    let response;
    try {
      response = await this.#fetch(ENDPOINT, { method, redirect: 'error', signal,
        headers: { authorization, ...(method === 'PATCH' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'PATCH' ? { body: JSON.stringify({ rate_limit_token_refresh: rate }) } : {}) });
    } catch { fail(signal.aborted ? 'auth_rate_timeout' : 'auth_rate_network_failed'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      fail(`auth_rate_http_${response.status}`);
    }
    // PATCH response may contain the full secret-bearing auth configuration.
    // Only the subsequent allowlisted GET proves the requested state.
    if (method === 'PATCH') { await response.body?.cancel().catch(() => {}); return; }
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE) {
      await response.body?.cancel().catch(() => {}); fail('auth_rate_response_limit');
    }
    const reader = response.body?.getReader(); if (!reader) fail('auth_rate_response_invalid');
    const chunks = []; let size = 0;
    try {
      for (;;) {
        let item;
        try { item = await reader.read(); }
        catch { fail(signal.aborted ? 'auth_rate_timeout' : 'auth_rate_response_read_failed'); }
        if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_RESPONSE) { await reader.cancel().catch(() => {}); fail('auth_rate_response_limit'); }
        chunks.push(item.value);
      }
    } finally { reader.releaseLock(); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
    catch { fail('auth_rate_response_invalid'); }
    if (!body || Array.isArray(body) || !Number.isSafeInteger(body.jwt_exp) || body.jwt_exp < 1
        || !Number.isSafeInteger(body.rate_limit_token_refresh) || body.rate_limit_token_refresh < 0) fail('auth_rate_response_invalid');
    return { jwt_exp: body.jwt_exp, rate_limit_token_refresh: body.rate_limit_token_refresh };
  }
  async read() { return this.#request('GET'); }
  async apply() {
    if (!this.#approved) fail('auth_rate_approval_required');
    if (this.#busy) fail('auth_rate_operation_in_progress');
    if (this.#pending || this.#applied || this.#restored) fail('auth_rate_already_started');
    this.#busy = true;
    try {
      const before = await this.read();
      if (before.rate_limit_token_refresh !== BEFORE) fail('auth_rate_baseline_conflict');
      this.#before = BEFORE; this.#pending = true;
      await this.#save(); // Even a lost PATCH response must leave a recovery address.
      await this.#request('PATCH', DESIRED);
      if ((await this.read()).rate_limit_token_refresh !== DESIRED) fail('auth_rate_apply_unverified');
      this.#applied = true;
      await this.#save();
      return this.snapshot();
    } finally { this.#busy = false; }
  }
  async restore() {
    if (this.#busy) fail('auth_rate_operation_in_progress');
    if (!this.#pending) return this.snapshot();
    if (!this.#approved) fail('auth_rate_approval_required');
    this.#busy = true;
    try {
      const current = await this.read();
      if (current.rate_limit_token_refresh === DESIRED) {
        await this.#request('PATCH', BEFORE);
        if ((await this.read()).rate_limit_token_refresh !== BEFORE) fail('auth_rate_restore_unverified');
      } else if (current.rate_limit_token_refresh !== BEFORE) fail('auth_rate_restore_conflict');
      this.#pending = false; this.#restored = true;
      await this.#save();
      return this.snapshot();
    } finally { this.#busy = false; }
  }
}
