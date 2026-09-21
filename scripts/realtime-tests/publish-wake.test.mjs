import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublishWakeHandler, publishWakeInput } from '../../supabase/functions/_shared/realtime-publish-wake.mjs';
const room='72abcdef-0000-4000-8000-000000000001', message='73abcdef-0000-4000-8000-000000000001';
const dispatch='74000000-0000-4000-8000-000000000001';
const input={roomId:room,epoch:2,messageId:message};
const values={SIDEY_FIREBASE_MODE:'live',SIDEY_FIREBASE_LIVE_APPROVED:'true',SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED:'true',
 SUPABASE_URL:'https://fjglrvhvdthntkvrduyi.supabase.co',SUPABASE_ANON_KEY:'public-key',
 SIDEY_FIREBASE_LIVE_PUBLISH_SECRET:'synthetic-scheduler-secret-longer-than-32',
 SIDEY_FIREBASE_PROJECT_ID:'sidey-realtime-staging',SIDEY_FIREBASE_SUPABASE_PROJECT_REF:'fjglrvhvdthntkvrduyi',
 SIDEY_FIREBASE_DATABASE_URL:'https://sidey-realtime-staging-default-rtdb.asia-southeast1.firebasedatabase.app',SIDEY_FIREBASE_API_KEY:'public-key',
 SIDEY_FIREBASE_SERVICE_ACCOUNT:JSON.stringify({project_id:'sidey-realtime-staging',client_email:'test@sidey-realtime-staging.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY----- synthetic'})};
function setup({result={reason:'queued',dispatchId:dispatch},dbStatus=200,dbBody,override={},publish,defer,failFetch=false,observe,monotonic}={}) {
 const calls=[],work=[],publications=[];
 const handler=createPublishWakeHandler({observe,monotonic,env:key=>({...values,...override})[key],defer:defer??(task=>work.push(task)),
   fetcher:async(url,init)=>{calls.push({url,init});if(failFetch)throw new Error('secret-token-provider-body');
     return new Response(dbBody??JSON.stringify(result),{status:dbStatus});},
   publish:async (request,observation)=>{publications.push(request);return publish?publish(request,observation):Response.json({accepted:true,private:'never expose'});}});
 return {calls,work,publications,send:(body=input,options={})=>handler(new Request('https://edge/realtime-wake',{
   method:'POST',headers:{authorization:'Bearer user-token'},body:JSON.stringify(body),...options}))};
}
test('wake authenticates once then registers service-owned dispatch without a second Edge HTTP call',async()=>{
 const h=setup();const response=await h.send();assert.equal(response.status,202);assert.deepEqual(await response.json(),{accepted:true});
 await Promise.all(h.work);assert.equal(h.calls.length,1);assert.equal(h.work.length,1);assert.equal(h.publications.length,1);
 assert.ok(h.calls[0].url.endsWith('/rpc/authorize_firebase_publish_wake'));
 assert.equal(h.calls[0].init.headers.authorization,'Bearer user-token');
 assert.deepEqual(JSON.parse(h.calls[0].init.body),{p_room_id:room,p_epoch:2,p_message_id:message});
 assert.equal(h.publications[0].headers.get('authorization'),`Bearer ${values.SIDEY_FIREBASE_LIVE_PUBLISH_SECRET}`);
 assert.deepEqual(await h.publications[0].json(),{dispatchId:dispatch});
});
test('wake responds before publication completes and client cancellation does not cancel owned background work',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});const h=setup({publish:async()=>{await pending;return Response.json({});}});
 const controller=new AbortController();const response=await h.send(input,{signal:controller.signal});
 assert.equal(response.status,202);assert.equal(h.publications.length,1);controller.abort();
 assert.equal(h.publications[0].signal.aborted,false);release();await Promise.all(h.work);
});
test('background failure stays private and never retries or republishes a message',async()=>{
 const h=setup({publish:async()=>{throw new Error('private publisher token');}});
 assert.deepEqual(await (await h.send()).json(),{accepted:true});await Promise.all(h.work);
 assert.equal(h.publications.length,1);assert.equal(h.calls.length,1);
});
test('failed background registration cannot start an unowned publisher',async()=>{
 const h=setup({defer:()=>{throw new Error('runtime rejected');}});assert.equal((await h.send()).status,503);
 await Promise.resolve();assert.equal(h.publications.length,0);
});
test('running, duplicate, delivered and contended authorizations are no-ops',async()=>{
 for(const reason of ['running','duplicate','delivered','contended','disabled','unavailable']){
  const h=setup({result:{reason}});const response=await h.send();assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{accepted:false,reason});assert.equal(h.publications.length,0);assert.equal(h.work.length,0);
 }
});
test('missing auth, wrong approval/project and forged actor/dispatch fields cannot wake a worker',async()=>{
 for(const body of [{...input,userId:message},{...input,dispatchId:dispatch},{...input,payload:{}},{...input,epoch:0},
   {...input,messageId:'invalid'},null]){
  const h=setup();assert.equal((await h.send(body)).status,400);assert.equal(h.calls.length,0);
 }
 const missing=setup();assert.equal((await missing.send(input,{headers:{}})).status,401);assert.equal(missing.calls.length,0);
 for(const override of [{SIDEY_FIREBASE_DIRECT_EVENTS_APPROVED:'false'},{SIDEY_FIREBASE_MODE:'off'},
   {SUPABASE_URL:'https://production.supabase.co'}]){
  const h=setup({override});assert.ok([403,503].includes((await h.send()).status));assert.equal(h.calls.length,0);
 }
});
test('SQL membership/session/epoch/ownership/rate errors are preserved without exposing provider detail',async()=>{
 for(const [message,status] of [['authentication_required',401],['active_session_required',401],['session_refresh_required',401],
   ['membership_required',403],['message_ownership_required',403],['publisher_wake_disabled',403],
   ['stale_realtime_epoch',409],['publisher_wake_rate_limited',429]]){
  const h=setup({result:{message,details:'private'},dbStatus:status});const response=await h.send();assert.equal(response.status,status);
  assert.equal((await response.text()).includes('private'),false);assert.equal(h.publications.length,0);
 }
});
test('malformed SQL success and upstream errors cannot manufacture service authority',async()=>{
 for(const options of [{result:{reason:'queued',dispatchId:'invalid'}},{result:{reason:'queued',dispatchId:dispatch,payload:'private'}},
   {result:{reason:'running',dispatchId:dispatch}},{dbStatus:503,dbBody:'provider secret'}, {failFetch:true}]){
  const h=setup(options);const response=await h.send();assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:'realtime_wake_unavailable'});assert.equal(h.publications.length,0);
 }
 const h=setup({dbStatus:401,dbBody:'not json secret'});assert.equal((await h.send()).status,401);
});
test('request and response limits are bounded and UUID inputs are normalized',async()=>{
 assert.deepEqual(publishWakeInput({...input,roomId:room.toUpperCase(),messageId:message.toUpperCase()}),
  {p_room_id:room,p_epoch:2,p_message_id:message});
 const request=setup();assert.equal((await request.send({...input,extra:'x'.repeat(2000)})).status,400);assert.equal(request.calls.length,0);
 const response=setup({dbBody:JSON.stringify({reason:'queued',dispatchId:dispatch,payload:'x'.repeat(5000)})});
 assert.equal((await response.send()).status,503);assert.equal(response.publications.length,0);
});


test('wake observes authorization, registration-to-entry/admission and internal ownership without exposing service data',async()=>{
 const samples=[];let elapsed=0;
 const h=setup({observe:sample=>samples.push(sample),monotonic:()=>++elapsed,
  publish:async(_request,observe)=>{
   observe({stage:'handler_admission',accepted:false,admissionMs:4,dispatchId:dispatch,payload:'private'});
   observe({stage:'handler_complete',accepted:false,success:false});
   return Response.json({accepted:false,private:'ignored'});
  }});
 const response=await h.send();assert.equal(response.status,202);assert.deepEqual(await response.json(),{accepted:true});
 await Promise.all(h.work);
 assert.deepEqual(samples.map(sample=>sample.stage),['wake_authorize','wake_registered','wake_inner_entry','handler_admission','handler_complete']);
 assert.equal(samples[0].authorizeMs,1);assert.equal(samples[2].registrationToEntryMs,1);
 assert.equal(samples[3].registrationToAdmissionMs,2);assert.equal(samples[3].accepted,false);
 assert.equal(samples[4].success,false);assert.equal(h.publications.length,1);
 assert.equal(JSON.stringify(samples).includes(dispatch),false);assert.equal(JSON.stringify(samples).includes('private'),false);
});

test('wake no-op and failed background observations preserve outcomes without another attempt',async()=>{
 for(const reason of ['running','contended','duplicate','delivered','disabled','unavailable']){
  const samples=[],h=setup({result:{reason},observe:sample=>samples.push(sample)});
  assert.deepEqual(await (await h.send()).json(),{accepted:false,reason});
  assert.deepEqual(samples.map(sample=>sample.stage),['wake_authorize',`wake_noop_${reason}`]);
  assert.equal(h.publications.length,0);
 }
 const samples=[],h=setup({observe:sample=>samples.push(sample),publish:()=>{throw new Error('secret');}});
 assert.equal((await h.send()).status,202);await Promise.all(h.work);
 assert.deepEqual(samples.at(-1),{stage:'wake_inner_failed',success:false});assert.equal(h.publications.length,1);
 const unavailable=[];const failed=setup({failFetch:true,observe:sample=>unavailable.push(sample)});
 assert.equal((await failed.send()).status,503);assert.equal(unavailable[0].stage,'wake_authorize');
});

test('throwing observation callbacks cannot alter wake registration or service execution',async()=>{
 for(const observe of [()=>{throw new Error('private');},async()=>{throw new Error('private');}]){
  const h=setup({observe});assert.equal((await h.send()).status,202);await Promise.all(h.work);
  assert.equal(h.calls.length,1);assert.equal(h.publications.length,1);
 }
});
