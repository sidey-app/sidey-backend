import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectEventHandler, directEventInput } from '../../supabase/functions/_shared/realtime-direct-event.mjs';
const room='72abcdef-0000-4000-8000-000000000001', event='73abcdef-0000-4000-8000-000000000001';
const user='71000000-0000-4000-8000-000000000001';
const input={roomId:room,epoch:2,eventId:event,kind:'typing_start',payload:{},sequence:'1800000000000000'};
const values={SIDEY_FIREBASE_MODE:'live',SIDEY_FIREBASE_LIVE_APPROVED:'true',SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED:'true',
  SUPABASE_URL:'https://fjglrvhvdthntkvrduyi.supabase.co',SUPABASE_ANON_KEY:'public-key',
  SIDEY_FIREBASE_PROJECT_ID:'sidey-realtime-staging',SIDEY_FIREBASE_SUPABASE_PROJECT_REF:'fjglrvhvdthntkvrduyi',
  SIDEY_FIREBASE_DATABASE_URL:'https://sidey-realtime-staging-default-rtdb.asia-southeast1.firebasedatabase.app',SIDEY_FIREBASE_API_KEY:'public-key',
  SIDEY_FIREBASE_SERVICE_ACCOUNT:JSON.stringify({project_id:'sidey-realtime-staging',client_email:'test@sidey-realtime-staging.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY----- synthetic'})};
function setup({dbError,writeStatus=200,failWrite=false,advanceAuth=0,override={},onDB=()=>{}}={}) {
  let at=1800000000000; const calls=[];
  const handler=createDirectEventHandler({env:key=>({...values,...override})[key],now:()=>at,
    accessToken:async()=>{at+=advanceAuth;return 'service-token';},fetcher:async(url,init)=>{
      calls.push({url,init});
      if(url.includes('/rest/v1/rpc/')) {
        onDB(JSON.parse(init.body));
        if(dbError)return Response.json({message:dbError[0]},{status:dbError[1]});
        return Response.json({event_id:event,room_id:room,epoch:2,kind:input.kind,revision:'123',
          payload:{user_id:user,room_id:room,event_id:event},occurred_at:new Date(at).toISOString()});
      }
      if(failWrite)throw new Error('provider credentials must never leak');
      return Response.json(null,{status:writeStatus});
    }});
  return {calls,handler,send:(body=input,headers={authorization:'Bearer user-token'})=>handler(new Request('https://edge/realtime-event',{
    method:'POST',headers,body:JSON.stringify(body)}))};
}
test('direct event uses user-auth DB once and immutable PUT once, without access read or completion RPC',async()=>{
  const {send,calls}=setup({onDB:body=>assert.deepEqual(body,{p_room_id:room,p_epoch:2,p_event_id:event,p_kind:'typing_start',p_target_user_id:null,p_sequence:input.sequence})});
  const response=await send();assert.equal(response.status,200);const result=await response.json();
  assert.equal(result.published,true);assert.equal(result.revision,'123');assert.equal(calls.length,2);
  assert.equal(calls[0].init.headers.authorization,'Bearer user-token');
  assert.match(calls[0].url,/authorize_firebase_direct_event$/);
  assert.match(calls[1].url,new RegExp(`/epochs/2/events/${event}.json$`));
  assert.equal(calls[1].init.method,'PUT');assert.equal(calls[1].init.headers['if-match'],'null_etag');
  assert.equal(JSON.parse(calls[1].init.body).payload.user_id,user);
  assert.deepEqual(Object.keys(result.timing).sort(),['dbBodyMs','dbHeadersMs','dbValidationMs','googleAuthMs','handlerMs','rtdbWriteMs']);
  assert.equal(result.dbServerTiming, undefined);
});

test('DB header wait and body read are measured separately, with only allowlisted server stages', async () => {
  let clock = 0, calls = 0;
  const row = { event_id:event,room_id:room,epoch:2,kind:input.kind,revision:'123',
    payload:{user_id:user,room_id:room,event_id:event},occurred_at:new Date(1800000000000).toISOString() };
  const handler = createDirectEventHandler({ env:key=>values[key], now:()=>1800000000000, monotonic:()=>clock,
    accessToken:async()=>{ clock += 5; return 'service-token'; }, fetcher:async()=> {
      calls++;
      if (calls === 2) { clock += 2; return Response.json(null); }
      clock += 40; let read = false;
      return { status:200, ok:true, headers:new Headers({ 'server-timing':'jwt;dur=1, transaction;dur=2, private;desc="secret token"' }),
        body:{getReader:()=>({read:async()=>{
          if (read) return {done:true}; read=true; clock += 7;
          return {done:false,value:new TextEncoder().encode(JSON.stringify(row))};
        }})} };
    } });
  const response = await handler(new Request('https://edge/realtime-event', {
    method:'POST',headers:{authorization:'Bearer synthetic'},body:JSON.stringify(input) }));
  assert.equal(response.status, 200); const value = await response.json();
  assert.deepEqual(value.timing, {dbValidationMs:47,dbHeadersMs:40,dbBodyMs:7,googleAuthMs:5,rtdbWriteMs:2,handlerMs:54});
  assert.deepEqual(value.dbServerTiming, {jwt:1,transaction:2}); assert.equal(calls,2);
  assert.ok(!JSON.stringify(value).includes('secret token'));
});

test('DB failure diagnostics distinguish timeout, caller abort, transport and invalid JSON without retries', async () => {
  for (const kind of ['timeout','aborted','transport','invalid_response','body_transport']) {
    let calls = 0, auth = 0; const controller = new AbortController();
    const handler = createDirectEventHandler({env:key=>values[key], accessToken:async()=>{auth++;}, fetcher:async()=>{
      calls++;
      if (kind === 'timeout') throw new DOMException('private timeout text','TimeoutError');
      if (kind === 'aborted') { controller.abort(new Error('private caller reason')); throw controller.signal.reason; }
      if (kind === 'transport') throw new TypeError('private network text');
      if (kind === 'invalid_response') return new Response('private invalid json');
      return new Response(new ReadableStream({pull(c){c.error(new TypeError('private stream text'));}}));
    }});
    const response = await handler(new Request('https://edge/realtime-event', {method:'POST',
      headers:{authorization:'Bearer synthetic'}, body:JSON.stringify(input),signal:controller.signal}));
    assert.equal(response.status,503); const value=await response.json();
    assert.equal(value.failureStage,'db_validation');
    assert.equal(value.failureCode,kind === 'body_transport' ? 'transport' : kind);
    assert.equal(calls,1); assert.equal(auth,0); assert.ok(!JSON.stringify(value).includes('private'));
    assert.ok(value.timing.dbHeadersMs >= 0 && value.timing.dbBodyMs >= 0);
    if (['timeout','aborted','transport'].includes(kind)) assert.equal(value.timing.dbBodyMs,0);
  }
});
test('rejects actor/item spoofing, arbitrary payload and unsafe sequences before any network',async()=>{
  for(const body of [{...input,payload:{user_id:user}},{...input,payload:{throwable_id:'paid'}},{...input,actor:user},
    {...input,sequence:1},{...input,sequence:'9223372036854775808'},{...input,sequence:'0'},
    {...input,kind:'character_throw',sequence:undefined,payload:{target_user_id:user,throwable_id:'paid'}}]) {
    const {send,calls}=setup();assert.equal((await send(body)).status,400);assert.equal(calls.length,0);
  }
  assert.equal(directEventInput({...input,kind:'character_throw',sequence:undefined,payload:{target_user_id:user}}).p_target_user_id,user);
});
test('rollout off, wrong staging binding, missing auth never authorize',async()=>{
  for(const [override,status]of[[{SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED:'false'},403],[{SUPABASE_URL:'https://production.supabase.co'},503]]) {
    const {send,calls}=setup({override});assert.equal((await send()).status,status);assert.equal(calls.length,0);
  }
  const {send,calls}=setup();assert.equal((await send(input,{})).status,401);assert.equal(calls.length,0);
});
test('DB denial never reaches Firebase and only safe error categories escape',async()=>{
  for(const [code,status,expected]of[['active_session_required',403,401],['membership_required',403,403],['stale_realtime_epoch',409,409],
    ['stale_typing_sequence',409,409],['duplicate_event',409,409],['realtime_event_rate_limited',400,429],['provider secret text',500,503]]) {
    const {send,calls}=setup({dbError:[code,status]});const response=await send();assert.equal(response.status,expected);assert.equal(calls.length,1);
    assert.ok(!(await response.text()).includes('provider secret'));
  }
});
test('OAuth delay cannot extend TTL or write an expired event',async()=>{
  const {send,calls}=setup({advanceAuth:5000});const response=await send();assert.equal(response.status,410);assert.equal(calls.length,1);
});
test('lost write response is discarded without retry, fallback, or completion RPC',async()=>{
  const {send,calls}=setup({failWrite:true});const response=await send();assert.equal(response.status,503);assert.equal(calls.length,2);
  assert.equal((await response.json()).error,'realtime_event_unavailable');
});
test('UUID collision cannot overwrite original and is not retried',async()=>{
  const {send,calls}=setup({writeStatus:412});const response=await send();assert.equal(response.status,409);assert.equal(calls.length,2);
});

test('native uppercase UUID encodings normalize before SQL and response binding',async()=>{
 const {send}=setup(); assert.equal((await send({...input,roomId:room.toUpperCase(),eventId:event.toUpperCase()})).status,200);
});

test('failure diagnostics identify only the failed boundary and numeric upstream status', async () => {
  for (const [options, stage, status, code] of [
    [{ dbError: ['private upstream body', 500] }, 'db_validation', 500, 'http'],
    [{ writeStatus: 503 }, 'rtdb_write', 503, 'http'],
    [{ failWrite: true }, 'rtdb_write', undefined, 'transport'],
  ]) {
    const response = await setup(options).send();
    assert.equal(response.status, 503);
    const value = await response.json();
    assert.equal(value.failureStage, stage); assert.equal(value.upstreamStatus, status);
    assert.equal(value.failureCode, code);
    assert.ok(!JSON.stringify(value).includes('private upstream'));
    assert.ok(!JSON.stringify(value).includes('provider credentials'));
  }
});
