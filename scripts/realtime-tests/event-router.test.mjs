import test from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeEventRouter } from '../../supabase/functions/_shared/realtime-event-router.mjs';
import { createDirectEventHandler } from '../../supabase/functions/_shared/realtime-direct-event.mjs';
import { createPublishWakeHandler, sharedPublisherWakeCapability, PUBLISHER_WAKE } from '../../supabase/functions/_shared/realtime-publish-wake.mjs';

const paths = ['/realtime-event', '/functions/v1/realtime-event', '/realtime-event/wake', '/functions/v1/realtime-event/wake'];
const request = (path, options = {}) => new Request(`https://edge.invalid${path}`, {
  method: 'POST', headers: { authorization: 'Bearer synthetic-user', 'x-region': 'ap-southeast-1' }, body: '{}', ...options });

test('only exact runtime and external routes forward the original request to its own handler', async () => {
  const calls = [];
  const router = createRealtimeEventRouter({
    direct: req => { calls.push(['direct', req]); return new Response('direct', { status: 200 }); },
    wake: req => { calls.push(['wake', req]); return new Response('wake', { status: 202 }); },
  });
  for (const path of paths) {
    const req = request(path), wake = path.endsWith('/wake');
    const response = await router(req);
    assert.equal(response.status, wake ? 202 : 200);
    assert.deepEqual(calls.at(-1), [wake ? 'wake' : 'direct', req]);
    assert.equal(req.bodyUsed, false);
    assert.equal(req.headers.get('authorization'), 'Bearer synthetic-user');
    assert.equal(req.headers.get('x-region'), 'ap-southeast-1');
  }
  assert.equal(calls.length, paths.length);
});

test('wrong paths, trailing slashes, duplicate separators and encoded route pieces never reach a handler', async () => {
  let calls = 0;
  const handler = () => { calls++; return new Response(); };
  const router = createRealtimeEventRouter({ direct: handler, wake: handler });
  for (const path of ['/', '/wake', '/realtime-wake', '/realtime-event/', '/realtime-event/wake/',
    '//realtime-event/wake', '/realtime-event//wake', '/functions//v1/realtime-event/wake',
    '/prefix/realtime-event/wake', '/realtime-event/wake/extra', '/realtime-event%2fwake',
    '/realtime-event/%77ake', '/realtime-event/%2Fwake', '/REALTIME-event/wake']) {
    const response = await router(request(path));
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  }
  assert.equal(calls, 0);
});

test('query values cannot select or normalize a route', async () => {
  const calls = [];
  const router = createRealtimeEventRouter({ direct: () => { calls.push('direct'); return new Response(); },
    wake: () => { calls.push('wake'); return new Response(); } });
  await router(request('/realtime-event?route=/wake&path=/functions/v1/realtime-event/wake'));
  await router(request('/realtime-event/wake?route=direct&path=%2frealtime-event'));
  assert.equal((await router(request('/wrong?path=/realtime-event/wake'))).status, 404);
  assert.deepEqual(calls, ['direct', 'wake']);
});

test('every invocation including the first is dispatched once with no hidden warmup request', async () => {
  for (const firstPath of ['/realtime-event', '/realtime-event/wake']) {
    const calls = [];
    const handler = req => { calls.push(req.url); return new Response(); };
    const router = createRealtimeEventRouter({ direct: handler, wake: handler });
    assert.equal(calls.length, 0);
    const offered = [firstPath, '/realtime-event/wake', '/realtime-event', firstPath];
    for (const path of offered) await router(request(path));
    assert.deepEqual(calls, offered.map(path => `https://edge.invalid${path}`));
  }
});

const values = { SIDEY_FIREBASE_MODE: 'live', SIDEY_FIREBASE_LIVE_APPROVED: 'true', SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED: 'true',
  SUPABASE_URL: 'https://fjglrvhvdthntkvrduyi.supabase.co', SUPABASE_ANON_KEY: 'public-key',
  SIDEY_FIREBASE_LIVE_PUBLISH_SECRET: 'synthetic-scheduler-secret-longer-than-32',
  SIDEY_FIREBASE_PROJECT_ID: 'sidey-realtime-staging', SIDEY_FIREBASE_SUPABASE_PROJECT_REF: 'fjglrvhvdthntkvrduyi',
  SIDEY_FIREBASE_DATABASE_URL: 'https://sidey-realtime-staging-default-rtdb.asia-southeast1.firebasedatabase.app', SIDEY_FIREBASE_API_KEY: 'public-key',
  SIDEY_FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'sidey-realtime-staging', client_email: 'test@sidey-realtime-staging.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY----- synthetic' }) };
const room = '72abcdef-0000-4000-8000-000000000001', id = '73abcdef-0000-4000-8000-000000000001';
const directBody = { roomId: room, epoch: 2, eventId: id, kind: 'character_pulse', payload: {} };
const wakeBody = { roomId: room, epoch: 2, messageId: id };
function realRouter(override = {}) {
  const calls = [], env = key => ({ ...values, ...override })[key];
  const fetcher = async (url, init) => { calls.push({ url, init }); return Response.json({ message: 'membership_required' }, { status: 403 }); };
  const unexpected = () => { throw new Error('must_not_publish'); };
  return { calls, router: createRealtimeEventRouter({ direct: createDirectEventHandler({ env, fetcher, accessToken: unexpected }),
    wake: createPublishWakeHandler({ env, fetcher, defer: unexpected, publish: unexpected }) }) };
}

test('shared routing preserves POST-only, auth, staging gate and each strict body contract', async () => {
  for (const path of paths) {
    const h = realRouter();
    for (const method of ['GET', 'OPTIONS', 'PUT']) {
      assert.equal((await h.router(request(path, { method, body: undefined }))).status, 405);
    }
    assert.equal((await h.router(request(path, { headers: {} }))).status, 401);
    const wrongBody = path.endsWith('/wake') ? directBody : wakeBody;
    assert.equal((await h.router(request(path, { body: JSON.stringify(wrongBody) }))).status, 400);
    assert.equal(h.calls.length, 0);
    const off = realRouter({ SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED: 'false' });
    assert.equal((await off.router(request(path))).status, 403);
    assert.equal(off.calls.length, 0);
  }
});

test('each shared route still uses its own user JWT authorization RPC and cannot bypass denial', async () => {
  for (const path of paths) {
    const h = realRouter(), wake = path.endsWith('/wake');
    const response = await h.router(request(path, { body: JSON.stringify(wake ? wakeBody : directBody) }));
    assert.equal(response.status, 403);
    assert.equal(h.calls.length, 1);
    assert.ok(h.calls[0].url.endsWith(wake ? '/rpc/authorize_firebase_publish_wake' : '/rpc/authorize_firebase_direct_event'));
    assert.equal(h.calls[0].init.headers.authorization, 'Bearer synthetic-user');
  }
});

test('bootstrap advertises shared wake only after validating the unchanged SQL capability and region', () => {
  assert.deepEqual(PUBLISHER_WAKE, { endpoint: 'realtime-wake', protocolVersion: 1 });
  assert.deepEqual(sharedPublisherWakeCapability(PUBLISHER_WAKE), { endpoint: 'realtime-event/wake', protocolVersion: 1 });
  for (const region of ['ap-northeast-2', 'ap-southeast-1']) {
    assert.deepEqual(sharedPublisherWakeCapability({ ...PUBLISHER_WAKE, region, token: 'not forwarded' }),
      { endpoint: 'realtime-event/wake', protocolVersion: 1, region });
  }
  for (const value of [undefined, null, [], {}, { ...PUBLISHER_WAKE, endpoint: 'realtime-event/wake' },
    { ...PUBLISHER_WAKE, endpoint: 'https://other.invalid' }, { ...PUBLISHER_WAKE, protocolVersion: 2 },
    { ...PUBLISHER_WAKE, region: 'auto' }, { ...PUBLISHER_WAKE, region: null }]) {
    assert.equal(sharedPublisherWakeCapability(value), undefined);
  }
});
