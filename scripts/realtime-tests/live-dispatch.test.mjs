import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { LiveWorker } from '../../supabase/functions/_shared/realtime-live-publisher.mjs';
import { createLivePublishHandler, drainLiveDispatch, measuredPublisherFetch, stagingLivePublisherConfig, emitPublisherObservation,
  STAGING_REF, STAGING_PROJECT, DISPATCH_BATCH_LIMIT, DISPATCH_BATCH_COUNT } from '../../supabase/functions/_shared/realtime-live-dispatch.mjs';

const dispatch = '11111111-1111-4111-8111-111111111111';
const secret = 'synthetic-only-secret-32-characters-long';
const config = {
  SIDEY_FIREBASE_MODE: 'live', SIDEY_FIREBASE_LIVE_APPROVED: 'true', SIDEY_FIREBASE_LIVE_PUBLISH_SECRET: secret,
  SIDEY_FIREBASE_PROJECT_ID: STAGING_PROJECT, SIDEY_FIREBASE_SUPABASE_PROJECT_REF: STAGING_REF,
  SIDEY_FIREBASE_DATABASE_URL: `https://${STAGING_PROJECT}-default-rtdb.asia-southeast1.firebasedatabase.app`,
  SUPABASE_URL: `https://${STAGING_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
  SIDEY_FIREBASE_API_KEY: 'synthetic-public-key', SIDEY_FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: STAGING_PROJECT,
    client_email: `publisher@${STAGING_PROJECT}.iam.gserviceaccount.com`, private_key: '-----BEGIN PRIVATE KEY-----synthetic' }),
};
const request = (body = { dispatchId: dispatch }, authorization = `Bearer ${secret}`) => new Request('https://local.example', {
  method: 'POST', headers: { authorization }, body: JSON.stringify(body) });
const stats = () => ({ claimed: 0, completed: 0, retries: 0, cleanupSelected: 0, cleanupCompleted: 0, cleanupRetries: 0 });

test('staging gate rejects production bindings and handler authenticates before any RPC or body work', async () => {
  assert.ok(stagingLivePublisherConfig(name => config[name]));
  assert.equal(stagingLivePublisherConfig(name => name === 'SIDEY_FIREBASE_MODE' ? 'off' : config[name]), null);
  assert.throws(() => stagingLivePublisherConfig(name => name === 'SUPABASE_URL' ? 'https://production.supabase.co' : config[name]));
  const handler = createLivePublishHandler({ env: name => config[name], fetcher: () => assert.fail('network') });
  assert.equal((await handler(request({}, 'Bearer wrong'))).status, 401);
  assert.equal((await handler(new Request('https://local.example'))).status, 405);
  assert.equal((await handler(request({ dispatchId: dispatch, maxRows: 100000 }))).status, 400);
});

test('bounded publication drain never waits for ten rows and caps total claims', async () => {
  const calls = [], observed = stats(), signal = new AbortController().signal;
  const worker = { batch: async (_, limit) => { calls.push(['batch', limit]); return { claimed: limit, completed: limit, retries: 0 }; },
    cleanup: async (_, limit) => { calls.push(['cleanup', limit]); return { selected: 3, completed: 3, retries: 0 }; } };
  assert.equal(await drainLiveDispatch(worker, observed, signal, () => 0, 20000), true);
  assert.equal(observed.claimed, 100); assert.equal(observed.cleanupCompleted, 0);
  assert.deepEqual(calls.filter(([name]) => name === 'batch'), Array.from({ length: 4 }, () => ['batch', DISPATCH_BATCH_LIMIT]));
  assert.equal(calls.some(([name]) => name === 'cleanup'), false);
  let batches = 0;
  worker.batch = async () => { batches++; return { claimed: 1, completed: 1, retries: 0 }; };
  assert.equal(await drainLiveDispatch(worker, stats(), signal, () => 0, 20000), true); assert.equal(batches, DISPATCH_BATCH_COUNT);
});

test('drain picks up arrivals after a short batch, stops on empty or retries, and never exceeds the row budget', async () => {
  let batches = 0;
  const worker = { batch: async () => { const claimed = [1, 2, 0][batches++]; return { claimed, completed: claimed, retries: 0 }; },
    cleanup: async () => ({ selected: 0, completed: 0, retries: 0 }) };
  const observed = stats();
  assert.equal(await drainLiveDispatch(worker, observed, new AbortController().signal, () => 0, 20000), true);
  assert.equal(observed.completed, 3); assert.equal(batches, 3);
  batches = 0;
  worker.batch = async () => { batches++; return { claimed: 1, completed: 0, retries: 1 }; };
  assert.equal(await drainLiveDispatch(worker, stats(), new AbortController().signal, () => 0, 20000), false);
  assert.equal(batches, 1);
  const limits = [];
  worker.batch = async (_, limit) => { limits.push(limit); const claimed = limits.length === 1 ? 10 : limit;
    return { claimed, completed: claimed, retries: 0 }; };
  const bounded = stats();
  await drainLiveDispatch(worker, bounded, new AbortController().signal, () => 0, 20000);
  assert.deepEqual(limits, [25, 25, 25, 25, 15]); assert.equal(bounded.claimed, 100);
});

test('deadline or abort stops new publication batches', async () => {
  let cleanup = 0, batches = 0, time = 0;
  const worker = { batch: async () => { batches++; time = 19500; return { claimed: 25, completed: 25, retries: 0 }; },
    cleanup: async () => { cleanup++; return { selected: 0, completed: 0, retries: 0 }; } };
  await drainLiveDispatch(worker, stats(), new AbortController().signal, () => time, 20000);
  assert.equal(batches, 1); assert.equal(cleanup, 0);
  worker.batch = async () => { throw new Error('private upstream detail'); };
  assert.equal(await drainLiveDispatch(worker, stats(), new AbortController().signal, () => 0, 20000), false);
  assert.equal(cleanup, 0);
  const controller = new AbortController(); controller.abort();
  assert.equal(await drainLiveDispatch(worker, stats(), controller.signal, () => 0, 20000), false);
});

function handlerHarness({ accepted = true, failWork = false, finish = true, observe } = {}) {
  const calls = []; let workSettled = false, batches = 0;
  const fetcher = async (url, init) => {
    assert.equal(init.redirect, 'error');
    const name = new URL(url).pathname.split('/').at(-1), args = JSON.parse(init.body);
    calls.push({ name, args });
    if (name === 'begin_claim_firebase_live_dispatch') return Response.json({ accepted, rows: [] });
    if (name === 'begin_firebase_live_cleanup_dispatch' || name === 'finish_firebase_live_cleanup_dispatch') return Response.json(true);
    if (name === 'finish_firebase_live_dispatch') return Response.json(finish);
    throw new Error('unexpected network');
  };
  const handler = createLivePublishHandler({ env: name => config[name], fetcher, observe, makeWorker: options => ({
    batch: async () => {
      if (failWork) throw new Error('upstream secret synthetic-service-key');
      if (batches++) return { claimed: 0, completed: 0, retries: 0 };
      options.log('publish_written'); options.log('publish_expired');
      return { claimed: 2, completed: 2, retries: 0 };
    },
    cleanup: async () => { await Promise.resolve(); workSettled = true; return { selected: 1, completed: 1, retries: 0 }; },
  }) });
  return { handler, calls };
}

test('a duplicate or expired dispatch does no publisher work and does not finish another owner', async () => {
  const h = handlerHarness({ accepted: false });
  const response = await h.handler(request());
  assert.equal(response.status, 200); assert.equal((await response.json()).accepted, false);
  assert.deepEqual(h.calls.map(call => call.name), ['begin_claim_firebase_live_dispatch']);
});

test('per-service timing includes failed requests and body consumption without recording URLs or bodies', async () => {
  let time = 0;
  const observed = { httpRequests: 0, responseBodyBytes: 0, rtdbResponseBodyBytes: 0 };
  const measured = measuredPublisherFetch(async () => {
    time += 7;
    return new Response(new ReadableStream({ start(controller) {
      time += 3; controller.enqueue(new TextEncoder().encode('secret')); controller.close();
    } }));
  }, observed, () => time);
  await measured(`${config.SIDEY_FIREBASE_DATABASE_URL}/v2/access/synthetic.json`, {});
  assert.equal(observed.rtdbRequests, 1); assert.equal(observed.rtdbRequestMs, 10);
  assert.equal(observed.rtdbRequestMaxMs, 10); assert.ok(!JSON.stringify(observed).includes('secret'));
  const failed = measuredPublisherFetch(async () => { time += 4; throw new Error('network'); }, observed, () => time);
  await assert.rejects(failed(`${config.SIDEY_FIREBASE_DATABASE_URL}/v2/access/synthetic.json`, {}));
  assert.equal(observed.rtdbRequests, 2); assert.equal(observed.rtdbRequestMs, 14); assert.equal(observed.rtdbRequestMaxMs, 10);
});

test('warm handler reuses OAuth between invocations and refreshes before expiry', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const vars = { ...config, SIDEY_FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: STAGING_PROJECT,
    client_email: `publisher@${STAGING_PROJECT}.iam.gserviceaccount.com`, private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }) };
  let time = 1800000000000, oauth = 0;
  const handler = createLivePublishHandler({ env: name => vars[name], now: () => time,
    fetcher: async url => {
      if (new URL(url).hostname === 'oauth2.googleapis.com') {
        oauth++; return Response.json({ access_token: 'fixture-token', token_type: 'Bearer', expires_in: 3600 });
      }
      if (new URL(url).pathname.endsWith('/begin_claim_firebase_live_dispatch')) return Response.json({ accepted: true, rows: [] });
      return Response.json(true);
    }, makeWorker: options => ({
      batch: async () => { assert.equal(await options.accessToken(), 'fixture-token'); return { claimed: 0, completed: 0, retries: 0 }; },
      cleanup: async () => ({ selected: 0, completed: 0, retries: 0 }),
    }) });
  for (let i = 0; i < 2; i++) assert.equal((await handler(request())).status, 200);
  assert.equal(oauth, 1);
  time += 3540000;
  assert.equal((await handler(request())).status, 200); assert.equal(oauth, 2);
});

test('publication finish records actual writes/expiry separately from independently finished cleanup', async () => {
  const h = handlerHarness(), response = await h.handler(request());
  assert.equal(response.status, 200);
  const body = await response.json(), finish = h.calls.find(call => call.name === 'finish_firebase_live_dispatch').args;
  assert.equal(body.stats.published, 1); assert.equal(body.stats.expired, 1);
  assert.equal(body.stats.completed, 2); assert.equal(body.stats.cleanupCompleted, 1);
  assert.equal(body.stats.responseBodyBytes, JSON.stringify({ accepted: true, rows: [] }).length);
  assert.deepEqual(finish.p_stats, { ...body.stats, cleanupSelected: 0, cleanupCompleted: 0, cleanupRetries: 0 }); assert.equal(finish.p_dispatch, dispatch);
  assert.ok(!JSON.stringify(body).includes('synthetic-service-key'));
});

test('failed work releases the owned dispatch with failure evidence and lost finish ownership is never PASS', async () => {
  const h = handlerHarness({ failWork: true }), response = await h.handler(request());
  assert.equal(response.status, 503); assert.equal(h.calls.find(call => call.name === 'finish_firebase_live_dispatch').args.p_success, false);
  assert.equal(h.calls.find(call => call.name === 'finish_firebase_live_cleanup_dispatch').args.p_stats.cleanupCompleted, 1);
  assert.ok(!(await response.text()).includes('synthetic-service-key'));
  const lost = handlerHarness({ finish: false });
  assert.equal((await lost.handler(request())).status, 503);
});

test('all response bodies including PUT acknowledgements are counted, with fixed hosts and no body logging', async () => {
  const observed = { httpRequests: 0, responseBodyBytes: 0, rtdbResponseBodyBytes: 0, supabaseResponseBodyBytes: 0, googleAuthResponseBodyBytes: 0 };
  const measured = measuredPublisherFetch(async () => new Response('private response', { status: 200 }), observed);
  const response = await measured(`${config.SIDEY_FIREBASE_DATABASE_URL}/v2/access/synthetic.json`, { method: 'PUT' });
  assert.equal(await response.text(), 'private response');
  assert.equal(observed.rtdbResponseBodyBytes, 16); assert.equal(observed.httpRequests, 1);
  await assert.rejects(measured('https://production.example', {}), /host_not_allowed/);
  assert.equal(observed.httpRequests, 1);
});

function cleanupHandlerHarness(cleanupResponse) {
  const calls = [], event = { id: '1', event_id: '22222222-2222-4222-8222-222222222222',
    room_id: '33333333-3333-4333-8333-333333333333', epoch: 1, expires_at: 1000 };
  const fetcher = async (url, init) => {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    const parsed = new URL(url);
    if (parsed.hostname === `${STAGING_REF}.supabase.co`) {
      const name = parsed.pathname.split('/').at(-1), args = JSON.parse(init.body);
      calls.push({ name, args });
      if (name === 'begin_claim_firebase_live_dispatch') return Response.json({ accepted: true, rows: [] });
      if (['finish_firebase_live_dispatch', 'begin_firebase_live_cleanup_dispatch', 'finish_firebase_live_cleanup_dispatch'].includes(name)) return Response.json(true);
      if (name === 'claim_firebase_live_dispatch') return Response.json([]);
      if (name === 'firebase_live_owned_maintenance') return Response.json({ leases: [], events: [event], epochs: [] });
      if (name === 'finish_firebase_live_owned_cleanup') return cleanupResponse();
    } else if (parsed.hostname === `${STAGING_PROJECT}-default-rtdb.asia-southeast1.firebasedatabase.app`) {
      assert.equal(parsed.pathname, `/v2/rooms/${event.room_id}/epochs/${event.epoch}/events/${event.event_id}.json`);
      if (!init.method || init.method === 'GET') return Response.json({ expiresAt: event.expires_at }, { headers: { etag: 'synthetic-etag' } });
      assert.equal(init.method, 'PUT'); assert.equal(init.body, 'null');
      return Response.json(null);
    }
    assert.fail('unexpected network');
  };
  const handler = createLivePublishHandler({ env: name => config[name], fetcher, now: () => 2000,
    makeWorker: options => new LiveWorker({ ...options, accessToken: async () => 'synthetic-token' }) });
  return { handler, calls };
}

for (const [label, response] of [
  ['204 no content', () => new Response(null, { status: 204 })],
  ['200 empty body', () => new Response('', { status: 200 })],
]) test(`real worker cleanup accepts the void RPC ${label} acknowledgement`, async () => {
  const h = cleanupHandlerHarness(response), result = await h.handler(request());
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.success, true); assert.equal(body.stats.cleanupSelected, 1);
  assert.equal(body.stats.cleanupCompleted, 1); assert.equal(body.stats.cleanupRetries, 0);
  assert.deepEqual(h.calls.find(call => call.name === 'finish_firebase_live_owned_cleanup').args, { p_worker: dispatch, p_kind: 'event', p_id: '1' });
  assert.equal(h.calls.at(-1).name, 'finish_firebase_live_cleanup_dispatch');
  assert.equal(h.calls.find(call => call.name === 'finish_firebase_live_dispatch').args.p_success, true);
});

for (const [label, response] of [
  ['malformed nonempty JSON', () => new Response('private upstream detail', { status: 200 })],
  ['HTTP failure with an empty body', () => new Response(null, { status: 500 })],
]) test(`cleanup still retries on ${label}`, async () => {
  const h = cleanupHandlerHarness(response), result = await h.handler(request());
  assert.equal(result.status, 503);
  const body = await result.json();
  assert.equal(body.success, false); assert.equal(body.stats.cleanupCompleted, 0);
  assert.equal(body.stats.cleanupRetries, 1); assert.equal(h.calls.find(call => call.name === 'finish_firebase_live_dispatch').args.p_success, true);
  assert.equal(h.calls.filter(call => call.name === 'finish_firebase_live_owned_cleanup').length, 1);
  assert.ok(!JSON.stringify(body).includes('private upstream detail'));
});

test('an empty void response cannot satisfy dispatch ownership acknowledgement', async () => {
  let madeWorker = false;
  const handler = createLivePublishHandler({ env: name => config[name],
    fetcher: async () => new Response(null, { status: 204 }),
    makeWorker: () => { madeWorker = true; assert.fail('empty begin ACK must not own a dispatch'); } });
  const result = await handler(request());
  assert.equal(result.status, 200); assert.equal((await result.json()).accepted, false);
  assert.equal(madeWorker, false);
});

test('slow cleanup cannot retain publication ownership or hide its completion', async () => {
  let releaseCleanup, finishPublication;
  const cleanupBlocked = new Promise(resolve => { releaseCleanup = resolve; });
  const publicationFinished = new Promise(resolve => { finishPublication = resolve; });
  let cleanupSettled = false, cleanupOwns = true;
  const calls = [];
  const handler = createLivePublishHandler({ env: name => config[name], fetcher: async (url, init) => {
    const name = new URL(url).pathname.split('/').at(-1); calls.push(name);
    if (name === 'begin_claim_firebase_live_dispatch') return Response.json({ accepted: true, rows: [{ id: 'first' }] });
    if (name === 'begin_firebase_live_cleanup_dispatch') return Response.json(cleanupOwns);
    if (name === 'finish_firebase_live_dispatch') {
      assert.equal(cleanupSettled, false); finishPublication(); return Response.json(true);
    }
    if (name === 'finish_firebase_live_cleanup_dispatch') { assert.equal(cleanupSettled, true); return Response.json(true); }
    assert.fail(name);
  }, makeWorker: () => ({
    batch: async (_, __, rows) => ({ claimed: rows?.length ?? 0, completed: rows?.length ?? 0, retries: 0 }),
    cleanup: async () => { await cleanupBlocked; cleanupSettled = true; return { selected: 1, completed: 1, retries: 0 }; },
  }) });
  const pending = handler(request());
  await publicationFinished;
  assert.equal(calls.includes('finish_firebase_live_cleanup_dispatch'), false);
  // A successor can finish its own publication while the first cleaner still owns expiry work.
  cleanupOwns = false;
  assert.equal((await handler(request())).status, 200);
  releaseCleanup();
  assert.equal((await pending).status, 200);
  assert.equal(calls.filter(name => name === 'finish_firebase_live_dispatch').length, 2);
  assert.equal(calls.filter(name => name === 'finish_firebase_live_cleanup_dispatch').length, 1);
});


test('publisher observations separate admission, wall-clock source age, empty-to-finish and final outcome', async () => {
  const samples = [], calls = []; let elapsed = 0, batch = 0;
  const handler = createLivePublishHandler({ env: name => config[name], now: () => 1000,
    monotonic: () => elapsed, observe: sample => samples.push(sample),
    fetcher: async url => {
      const name = new URL(url).pathname.split('/').at(-1); calls.push(name);
      if (name === 'begin_claim_firebase_live_dispatch') { elapsed += 20; return Response.json({ accepted: true,
        rows: [{ occurred_at: new Date(975).toISOString(), payload: 'private content', id: dispatch },
          { occurred_at: 'invalid' }] }); }
      if (name === 'begin_firebase_live_cleanup_dispatch') return Response.json(false);
      if (name === 'finish_firebase_live_dispatch') { elapsed += 7; return Response.json(true); }
      assert.fail('unexpected RPC');
    }, makeWorker: () => ({ batch: async () => {
      elapsed += 5; const count = batch++ === 0 ? 2 : 0;
      return { claimed: count, completed: count, retries: 0 };
    } }) });
  const response = await handler(request()); assert.equal(response.status, 200);
  assert.deepEqual(samples.map(sample => sample.stage), ['handler_entry', 'handler_admission', 'handler_empty_claim',
    'handler_finish', 'handler_complete']);
  assert.deepEqual(samples[1], { stage: 'handler_admission', admissionMs: 20, accepted: true,
    initialRows: 2, initialSourceAgeSamples: 1, initialSourceAgeWallClockMaxMs: 25 });
  assert.deepEqual(samples[3], { stage: 'handler_finish', finishAcknowledged: true, emptyToFinishMs: 7 });
  assert.equal(samples[4].elapsedMs, 37); assert.equal(samples[4].accepted, true); assert.equal(samples[4].success, true);
  assert.equal(samples[4].supabaseRequests, 2); // Publication admission + finish; separate cleanup excluded.
  assert.equal(calls.length, 3); assert.equal(JSON.stringify(samples).includes('private'), false);
  assert.equal(JSON.stringify(samples).includes(dispatch), false);
  const body = await response.json(); assert.equal('emptyToFinishMs' in body.stats, false);
});

test('observation allowlist rejects identifiers, nonfinite values and unknown stages; observer failures are isolated', async () => {
  const samples = [];
  emitPublisherObservation(sample => samples.push(sample), 'handler_admission', {
    dispatchId: dispatch, origin: 'forged', payload: 'private', admissionMs: Infinity,
    initialRows: NaN, initialSourceAgeWallClockMaxMs: -5, accepted: true, success: 'secret' });
  emitPublisherObservation(sample => samples.push(sample), 'untrusted secret', { accepted: true });
  assert.deepEqual(samples, [{ stage: 'handler_admission', initialSourceAgeWallClockMaxMs: -5, accepted: true }]);
  for (const observe of [() => { throw new Error('private'); }, async () => { throw new Error('private'); }]) {
    const h = handlerHarness({ observe }); assert.equal((await h.handler(request())).status, 200);
    assert.equal(h.calls.filter(call => call.name === 'finish_firebase_live_dispatch').length, 1);
  }
});

test('duplicate admission and lost finish have independent truthful observed outcomes', async () => {
  for (const options of [{ accepted: false }, { finish: false }, { failWork: true }]) {
    const samples = [], h = handlerHarness({ ...options, observe: sample => samples.push(sample) });
    await h.handler(request());
    const completed = samples.find(sample => sample.stage === 'handler_complete');
    assert.equal(completed.accepted, options.accepted !== false); assert.equal(completed.success, false);
    if (options.accepted === false) assert.equal(samples.some(sample => sample.stage === 'handler_finish'), false);
    if (options.finish === false) assert.equal(samples.find(sample => sample.stage === 'handler_finish').finishAcknowledged, false);
  }
});

test('drain reuses combined successor rows and consumes an empty successor without another batch', async () => {
  const initial=[{id:'1'}], next=[{id:'2'}], calls=[], observed=stats(), events=[];
  const worker={batch:async(_signal,limit,rows,options)=>{
    calls.push({limit,rows,options});
    return calls.length===1 ? {claimed:1,completed:1,retries:0,nextRows:next}
      : {claimed:1,completed:1,retries:0,nextRows:[]};
  }};
  assert.equal(await drainLiveDispatch(worker,observed,new AbortController().signal,()=>0,20000,initial,s=>events.push(s.stage)),true);
  assert.equal(calls.length,2);assert.equal(calls[0].rows,initial);assert.equal(calls[1].rows,next);
  assert.equal(calls[1].options.remainingRows,99);assert.equal(calls[1].options.claimBefore,19000);
  assert.deepEqual(events,['handler_empty_claim']);assert.equal(observed.completed,2);
});

test('prefetched rows abandoned at the deadline or abort remain visible as incomplete work', async () => {
  for (const aborted of [false,true]) {
    let clock=0; const controller=new AbortController(), observed=stats();
    const worker={batch:async()=>{
      if (aborted) controller.abort(); else clock=19500;
      return {claimed:1,completed:1,retries:0,nextRows:[{id:'2'},{id:'3'}]};
    }};
    assert.equal(await drainLiveDispatch(worker,observed,controller.signal,()=>clock,20000,[{id:'1'}]),false);
    assert.equal(observed.claimed,3);assert.equal(observed.completed,1);assert.equal(observed.retries,2);
  }
  const observed=stats();
  assert.equal(await drainLiveDispatch({batch:()=>assert.fail('deadline')},observed,new AbortController().signal,()=>19500,20000,[{id:'1'}]),false);
  assert.equal(observed.claimed,1);assert.equal(observed.retries,1);
});

test('drain disables preclaim on the final iteration and bounds successor row allowance', async () => {
  const options=[], observed=stats();
  const worker={batch:async(_signal,limit,_rows,next)=>{
    options.push(next);return {claimed:1,completed:1,retries:0};
  }};
  assert.equal(await drainLiveDispatch(worker,observed,new AbortController().signal,()=>0,20000),true);
  assert.equal(options.length,DISPATCH_BATCH_COUNT);assert.equal(options.at(-1).nextClaimLimit,0);
  assert.equal(options.at(-1).remainingRows,93);
});

test('real Edge handler finishes two batches with four publisher RPCs and unchanged hint CAS', async () => {
  const room='33333333-3333-4333-8333-333333333333', user='44444444-4444-4444-8444-444444444444';
  const rows=[1,2].map(id=>({id:String(id),revision:String(id),event_id:'55555555-5555-4555-8555-555555555555',
    room_id:room,epoch:1,kind:'message_changed',payload:{},occurred_at:new Date(1000).toISOString(),
    access:{enabled:true,epoch:1,revision:'1',members:{[user]:true}}}));
  const rpcs=[], hints=[];let hint=null,combined=0;
  const handler=createLivePublishHandler({env:name=>config[name],now:()=>2000,
    makeWorker:options=>new LiveWorker({...options,accessToken:async()=> 'synthetic-token'}),
    fetcher:async(url,init)=>{
      const path=new URL(url).pathname;
      if (path.includes('/rpc/')) {
        const name=path.split('/').at(-1);rpcs.push(name);const args=JSON.parse(init.body);
        if (name==='begin_claim_firebase_live_dispatch') return Response.json({accepted:true,rows:[rows[0]]});
        if (name==='begin_firebase_live_cleanup_dispatch') return Response.json(false);
        if (name==='finish_claim_firebase_live_dispatch') {
          combined++;assert.equal(args.p_worker,dispatch);assert.equal(args.p_ids[0],String(combined));
          return Response.json({completed:args.p_ids,rows:combined===1?[rows[1]]:[]});
        }
        if (name==='finish_firebase_live_dispatch') {assert.equal(args.p_success,true);return Response.json(true);}
        assert.fail(`unexpected RPC ${name}`);
      }
      assert.ok(path.endsWith('/hint.json'));
      hints.push(init.method??'GET');
      if (init.method==='PUT') {assert.equal(init.headers['if-match'],'synthetic-etag');hint=JSON.parse(init.body);return Response.json(null);}
      return Response.json(hint,{headers:{etag:'synthetic-etag'}});
    }});
  const response=await handler(request());assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.stats.claimed,2);assert.equal(body.stats.completed,2);assert.equal(body.stats.retries,0);
  // The existing durable stats snapshot precedes the final finish RPC itself.
  assert.equal(body.stats.supabaseRequests,3);assert.equal(body.stats.rtdbRequests,4);
  assert.deepEqual(rpcs.filter(name=>name!=='begin_firebase_live_cleanup_dispatch'),
    ['begin_claim_firebase_live_dispatch','finish_claim_firebase_live_dispatch','finish_claim_firebase_live_dispatch','finish_firebase_live_dispatch']);
  assert.deepEqual(hints,['GET','PUT','GET','PUT']);assert.equal(hint.revision,'2');
});
