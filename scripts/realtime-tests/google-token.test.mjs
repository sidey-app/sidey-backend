import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createGoogleAccessTokenCache } from '../../supabase/functions/_shared/realtime-google-token.mjs';

const account = { project_id: 'sidey-realtime-staging', client_email: 'publisher@sidey-realtime-staging.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----synthetic-only' };
const tokenResponse = (token = 'synthetic-token', expires = 3600) => Response.json({ access_token: token, token_type: 'Bearer', expires_in: expires });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('warm calls reuse the same token until exactly expiry minus margin', async () => {
  let at = 100000, calls = 0;
  const cache = createGoogleAccessTokenCache({ now: () => at, signer: async () => 'synthetic-assertion' });
  const fetcher = async () => tokenResponse(`synthetic-${++calls}`);
  assert.equal(await cache(account, { fetcher }), 'synthetic-1');
  at += 3539999;
  assert.equal(await cache({ ...account }, { fetcher }), 'synthetic-1');
  at++;
  assert.equal(await cache(account, { fetcher }), 'synthetic-2');
  assert.equal(calls, 2);
});

test('concurrent calls share one OAuth exchange and use a bounded independent signal', async () => {
  const ready = deferred(), response = deferred(); let calls = 0;
  const cache = createGoogleAccessTokenCache({ now: () => 100000, signer: async (_, claims) => {
    assert.equal(claims.iss, account.client_email); assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
    assert.equal(claims.exp - claims.iat, 300);
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email');
    return 'synthetic-assertion';
  } });
  const firstCaller = new AbortController();
  const fetcher = async (url, init) => {
    calls++; assert.equal(url, 'https://oauth2.googleapis.com/token'); assert.equal(init.redirect, 'error');
    assert.equal(init.method, 'POST'); assert.ok(init.signal instanceof AbortSignal);
    assert.notEqual(init.signal, firstCaller.signal);
    assert.equal(init.body.get('assertion'), 'synthetic-assertion');
    ready.resolve(init.signal); return response.promise;
  };
  const first = cache(account, { fetcher, signal: firstCaller.signal });
  const firstAborted = assert.rejects(first, { name: 'AbortError' });
  const oauthSignal = await ready.promise;
  const second = cache(account, { fetcher });
  firstCaller.abort(new Error('private caller error'));
  await firstAborted; assert.equal(oauthSignal.aborted, false);
  response.resolve(tokenResponse());
  assert.equal(await second, 'synthetic-token');
  assert.equal(await cache(account, { fetcher }), 'synthetic-token'); assert.equal(calls, 1);
});

test('an already aborted caller starts no OAuth exchange', async () => {
  const controller = new AbortController(); controller.abort();
  const cache = createGoogleAccessTokenCache({ signer: () => assert.fail('sign') });
  await assert.rejects(cache(account, { signal: controller.signal }), { name: 'AbortError' });
});

test('failed shared exchange is removed and its private error is never exposed', async () => {
  let calls = 0;
  const cache = createGoogleAccessTokenCache({ signer: async () => 'synthetic-assertion' });
  const fetcher = async () => { if (++calls === 1) throw new Error('private token key response'); return tokenResponse(); };
  const outcomes = await Promise.allSettled([cache(account, { fetcher }), cache(account, { fetcher })]);
  for (const result of outcomes) assert.equal(result.reason.message, 'firebase_service_auth_failed');
  assert.equal(calls, 1); assert.equal(await cache(account, { fetcher }), 'synthetic-token'); assert.equal(calls, 2);
});

test('a synchronous signer failure is also evicted', async () => {
  let calls = 0;
  const cache = createGoogleAccessTokenCache({ signer: () => { if (++calls === 1) throw new Error('private key'); return 'synthetic-assertion'; } });
  await assert.rejects(cache(account), /^Error: firebase_service_auth_failed$/);
  assert.equal(await cache(account, { fetcher: async () => tokenResponse() }), 'synthetic-token');
});

test('project, email and signing-key changes never reuse another binding', async () => {
  let calls = 0;
  const cache = createGoogleAccessTokenCache({ signer: async () => 'synthetic-assertion' });
  const fetcher = async () => tokenResponse(`synthetic-${++calls}`);
  assert.equal(await cache(account, { fetcher }), 'synthetic-1');
  assert.equal(await cache({ ...account, private_key: account.private_key + '-rotated' }, { fetcher }), 'synthetic-2');
  assert.equal(await cache({ ...account, client_email: 'other@sidey-realtime-staging.iam.gserviceaccount.com' }, { fetcher }), 'synthetic-3');
  assert.equal(await cache({ ...account, project_id: 'other-project', client_email: 'publisher@other-project.iam.gserviceaccount.com' }, { fetcher }), 'synthetic-4');
  await assert.rejects(cache({ ...account, client_email: 'publisher@other-project.iam.gserviceaccount.com' }, { fetcher }), /firebase_service_auth_failed/);
  assert.equal(calls, 4);
});

test('a late exchange for an old binding cannot overwrite the current cached token', async () => {
  const started = deferred(), delayed = deferred();
  const cache = createGoogleAccessTokenCache({ signer: async () => 'synthetic-assertion' });
  const first = cache(account, { fetcher: async () => { started.resolve(); return delayed.promise; } });
  await started.promise;
  const rotated = { ...account, private_key: account.private_key + '-rotated' };
  assert.equal(await cache(rotated, { fetcher: async () => tokenResponse('new-token') }), 'new-token');
  delayed.resolve(tokenResponse('old-token')); assert.equal(await first, 'old-token');
  assert.equal(await cache(rotated, { fetcher: () => assert.fail('unexpected exchange') }), 'new-token');
});

for (const [label, response] of [
  ['HTTP error', () => new Response('private error body', { status: 403 })],
  ['invalid JSON', () => new Response('private invalid body')],
  ['oversize response', () => new Response('x'.repeat(16385))],
  ['missing expiry', () => Response.json({ access_token: 'secret-token', token_type: 'Bearer' })],
  ['zero expiry', () => tokenResponse('secret-token', 0)],
  ['excessive expiry', () => tokenResponse('secret-token', 3601)],
  ['invalid token type', () => Response.json({ access_token: 'secret-token', token_type: 'other', expires_in: 3600 })],
]) test(`${label} never enters the cache`, async () => {
  const cache = createGoogleAccessTokenCache({ signer: async () => 'synthetic-assertion' });
  await assert.rejects(cache(account, { fetcher: async () => response() }), /^Error: firebase_service_auth_failed$/);
  assert.equal(await cache(account, { fetcher: async () => tokenResponse() }), 'synthetic-token');
});

test('response delay and clock rollback cannot extend cache validity', async () => {
  let at = 100000, calls = 0;
  const cache = createGoogleAccessTokenCache({ now: () => at, signer: async () => 'synthetic-assertion' });
  const fetcher = async () => { calls++; at += 10000; return tokenResponse(); };
  await cache(account, { fetcher });
  at = 99999; await cache(account, { fetcher }); assert.equal(calls, 2);
  at = 99999 + 3540000; await cache(account, { fetcher }); assert.equal(calls, 3);
  await assert.rejects(cache({ ...account, private_key: account.private_key + '-other' }, {
    fetcher: async () => { at += 3600000; return tokenResponse(); },
  }), /firebase_service_auth_failed/);
});

test('OAuth timeout is evicted so a later call can recover', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const cache = createGoogleAccessTokenCache({ signer: async () => 'synthetic-assertion', requestTimeoutMs: 10 });
    const fetcher = async (_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    await assert.rejects(cache(account, { fetcher }), /^Error: firebase_service_auth_failed$/);
    assert.equal(await cache(account, { fetcher: async () => tokenResponse() }), 'synthetic-token');
  } finally { clearTimeout(keepAlive); }
});

test('the default signer produces a verifiable service-account JWT without network access', async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signingAccount = { ...account, private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const cache = createGoogleAccessTokenCache({ now: () => 100000 });
  assert.equal(await cache(signingAccount, { fetcher: async (_, init) => {
    const [header, payload, signature] = init.body.get('assertion').split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
    assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, account.client_email);
    assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, 'base64url')), true);
    return tokenResponse();
  } }), 'synthetic-token');
});
