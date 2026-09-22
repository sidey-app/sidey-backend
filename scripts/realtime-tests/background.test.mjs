import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundPublishHandler } from '../../supabase/functions/_shared/realtime-publish-background.mjs';
import { createLivePublishHandler, STAGING_REF, STAGING_PROJECT } from '../../supabase/functions/_shared/realtime-live-dispatch.mjs';

const dispatch = 'bf000000-0000-4000-8000-000000000001';
const secret = 'synthetic-background-scheduler-secret-32';
const values = {
  SIDEY_FIREBASE_MODE: 'live', SIDEY_FIREBASE_LIVE_APPROVED: 'true', SIDEY_FIREBASE_LIVE_PUBLISH_SECRET: secret,
  SIDEY_FIREBASE_PROJECT_ID: STAGING_PROJECT, SIDEY_FIREBASE_SUPABASE_PROJECT_REF: STAGING_REF,
  SIDEY_FIREBASE_DATABASE_URL: `https://${STAGING_PROJECT}-default-rtdb.asia-southeast1.firebasedatabase.app`,
  SUPABASE_URL: `https://${STAGING_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
  SIDEY_FIREBASE_API_KEY: 'synthetic-public-key', SIDEY_FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: STAGING_PROJECT,
    client_email: `publisher@${STAGING_PROJECT}.iam.gserviceaccount.com`, private_key: '-----BEGIN PRIVATE KEY-----synthetic' }),
};
const env = key => values[key];
const request = (body = { dispatchId: dispatch }, extra = {}) => new Request('https://incoming.example', {
  method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body), ...extra,
});
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function setup({ publish = async () => Response.json({ accepted: true }), defer, override = {} } = {}) {
  const work = [], calls = [];
  const handler = createBackgroundPublishHandler({ env: key => ({ ...values, ...override })[key],
    defer: defer ?? (value => work.push(value)),
    publish: async owned => { calls.push(owned); return publish(owned); } });
  return { handler, work, calls };
}

test('scheduler returns 202 after registration while the detached publisher continues after HTTP abort', async () => {
  const gate = deferred(); let done = false;
  const h = setup({ publish: async owned => { await gate.promise; assert.equal(owned.signal.aborted, false); done = true; return Response.json({}); } });
  const cancellation = new AbortController();
  const response = await h.handler(request(undefined, { signal: cancellation.signal }));
  assert.equal(response.status, 202); assert.deepEqual(await response.json(), { accepted: true });
  assert.equal(done, false); assert.equal(h.work.length, 1); assert.equal(h.calls.length, 1);
  cancellation.abort(); assert.equal(h.calls[0].signal.aborted, false);
  assert.equal(h.calls[0].url, `https://${STAGING_REF}.supabase.co/functions/v1/realtime-publish-live`);
  assert.deepEqual(await h.calls[0].json(), { dispatchId: dispatch });
  assert.equal(h.calls[0].headers.get('authorization'), `Bearer ${secret}`);
  gate.resolve(); await Promise.all(h.work); assert.equal(done, true);
});

test('failed runtime registration never starts unowned background work', async () => {
  const h = setup({ defer: () => { throw new Error('private runtime detail'); } });
  const response = await h.handler(request()); assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'live_dispatch_unavailable' });
  await Promise.resolve(); assert.equal(h.calls.length, 0);
});

test('POST and scheduler secret are required before body access or any work', async () => {
  const h = setup();
  assert.equal((await h.handler(new Request('https://incoming.example'))).status, 405);
  for (const authorization of ['', 'Bearer user-jwt', `Bearer ${secret}wrong`]) {
    const untrusted = { method: 'POST', headers: new Headers({ authorization }), get body() { assert.fail('body read before authorization'); } };
    assert.equal((await h.handler(untrusted)).status, 401);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.work.length, 0);
});

test('bounded body and exact UUID-only shape reject untrusted scheduling controls', async () => {
  const h = setup();
  for (const body of [null, [], {}, { dispatchId: dispatch, maxRows: 100 }, { dispatchId: 'invalid' },
    { dispatchId: dispatch.toUpperCase() }, { dispatchId: dispatch, url: 'https://elsewhere' }]) {
    assert.equal((await h.handler(request(body))).status, 400);
  }
  assert.equal((await h.handler(request({}, { body: '{' }))).status, 400);
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(513)); }, cancel() { cancelled = true; } });
  assert.equal((await h.handler(request({}, { body, duplex: 'half' }))).status, 400);
  assert.equal(cancelled, true); assert.equal(h.work.length, 0); assert.equal(h.calls.length, 0);
});

test('disabled or incorrectly bound runtime registers no publisher', async () => {
  for (const override of [{ SIDEY_FIREBASE_MODE: 'off' }, { SIDEY_FIREBASE_LIVE_APPROVED: 'false' }]) {
    const h = setup({ override }); const response = await h.handler(request());
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { enabled: false, accepted: false });
    assert.equal(h.work.length, 0);
  }
  const h = setup({ override: { SUPABASE_URL: 'https://other.supabase.co' } });
  assert.equal((await h.handler(request())).status, 503); assert.equal(h.work.length, 0);
});

test('duplicate registered HTTP calls still use the unchanged atomic admission once', async () => {
  let acquired = false, workers = 0, finishes = 0; const samples = [];
  const publish = createLivePublishHandler({ env, observe: sample => samples.push(sample),
    fetcher: async url => {
      const rpc = new URL(url).pathname.split('/').at(-1);
      if (rpc === 'begin_claim_firebase_live_dispatch') { const accepted = !acquired; acquired = true; return Response.json({ accepted, rows: [] }); }
      if (rpc === 'begin_firebase_live_cleanup_dispatch') return Response.json(false);
      if (rpc === 'finish_firebase_live_dispatch') { finishes++; return Response.json(true); }
      assert.fail(rpc);
    }, makeWorker: () => { workers++; return { batch: async () => ({ claimed: 0, completed: 0, retries: 0 }) }; } });
  const h = setup({ publish });
  const responses = await Promise.all([h.handler(request()), h.handler(request())]);
  assert.deepEqual(responses.map(response => response.status), [202, 202]); await Promise.all(h.work);
  assert.equal(workers, 1); assert.equal(finishes, 1);
  assert.deepEqual(samples.filter(sample => sample.stage === 'handler_admission').map(sample => sample.accepted).sort(), [false, true]);
});

test('SQL disable after HTTP registration prevents a late background task from claiming work', async () => {
  const admission = deferred(); let enabled = true, workers = 0; const calls = [];
  const publish = createLivePublishHandler({ env, fetcher: async url => {
    const rpc = new URL(url).pathname.split('/').at(-1); calls.push(rpc);
    assert.equal(rpc, 'begin_claim_firebase_live_dispatch'); await admission.promise;
    return Response.json({ accepted: enabled, rows: [] });
  }, makeWorker: () => { workers++; assert.fail('disabled work'); } });
  const h = setup({ publish }); assert.equal((await h.handler(request())).status, 202);
  enabled = false; admission.resolve(); await Promise.all(h.work);
  assert.equal(workers, 0); assert.deepEqual(calls, ['begin_claim_firebase_live_dispatch']);
});

test('slow cleanup does not delay 202, and publication plus cleanup finish remain separate completion evidence', async () => {
  const cleanup = deferred(), publication = deferred(); let cleanupDone = false; const calls = [];
  const publish = createLivePublishHandler({ env, fetcher: async url => {
    const rpc = new URL(url).pathname.split('/').at(-1); calls.push(rpc);
    if (rpc === 'begin_claim_firebase_live_dispatch') return Response.json({ accepted: true, rows: [] });
    if (rpc === 'begin_firebase_live_cleanup_dispatch') return Response.json(true);
    if (rpc === 'finish_firebase_live_dispatch') { assert.equal(cleanupDone, false); publication.resolve(); return Response.json(true); }
    if (rpc === 'finish_firebase_live_cleanup_dispatch') { assert.equal(cleanupDone, true); return Response.json(true); }
    assert.fail(rpc);
  }, makeWorker: () => ({ batch: async () => ({ claimed: 0, completed: 0, retries: 0 }),
    cleanup: async () => { await cleanup.promise; cleanupDone = true; return { selected: 1, completed: 1, retries: 0 }; } }) });
  const h = setup({ publish }); assert.equal((await h.handler(request())).status, 202);
  await publication.promise; assert.equal(cleanupDone, false);
  assert.equal(calls.includes('finish_firebase_live_cleanup_dispatch'), false);
  cleanup.resolve(); await Promise.all(h.work); assert.equal(calls.at(-1), 'finish_firebase_live_cleanup_dispatch');
});

test('failed publication after 202 remains a failed SQL finish and observation without an extra attempt', async () => {
  const finishes = [], samples = [];
  const publish = createLivePublishHandler({ env, observe: sample => samples.push(sample), fetcher: async (url, init) => {
    const rpc = new URL(url).pathname.split('/').at(-1);
    if (rpc === 'begin_claim_firebase_live_dispatch') return Response.json({ accepted: true, rows: [] });
    if (rpc === 'begin_firebase_live_cleanup_dispatch') return Response.json(false);
    if (rpc === 'finish_firebase_live_dispatch') { finishes.push(JSON.parse(init.body)); return Response.json(true); }
    assert.fail(rpc);
  }, makeWorker: () => ({ batch: async () => { throw new Error('private upstream secret'); } }) });
  const h = setup({ publish }); const response = await h.handler(request());
  assert.equal(response.status, 202); assert.deepEqual(await response.json(), { accepted: true });
  await Promise.all(h.work); assert.equal(h.calls.length, 1); assert.equal(finishes.length, 1);
  assert.equal(finishes[0].p_success, false); assert.equal(finishes[0].p_stats.retries, 1);
  assert.equal(samples.find(sample => sample.stage === 'handler_complete').success, false);
});

test('unexpected background rejection stays private and is never retried', async () => {
  const h = setup({ publish: async () => { throw new Error('private upstream secret'); } });
  assert.deepEqual(await (await h.handler(request())).json(), { accepted: true });
  await Promise.all(h.work); assert.equal(h.calls.length, 1);
});
