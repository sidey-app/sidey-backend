import assert from 'node:assert/strict';
import {test} from 'node:test';
import {armLiveLease} from '../../supabase/functions/_shared/realtime-lease.mjs';
const uid='71000000-0000-4000-8000-000000000001',sid='73000000-0000-4000-8000-000000000001';
const config={databaseURL:'https://demo-sidey-default-rtdb.asia-southeast1.firebasedatabase.app'};
const lease={sessionId:sid,leaseRevision:'5',leaseExpiresAt:700000};
function storage(initial){let current=initial,etag=0;return {get value(){return current},fetch:async(_url,init)=>{
 if(init.method==='PUT'){if(init.headers['if-match']!==String(etag))return new Response('',{status:412});current=JSON.parse(init.body);etag++;}
 return new Response(JSON.stringify(current),{headers:{etag:String(etag),'content-type':'application/json'}});
}};}
test('late bootstrap cannot overwrite newer renewal or equal-generation revoke tombstone',async()=>{
 for(const current of [{revision:'6',expiresAt:900000},{revision:'5',revoked:true,expiresAt:0}]){
 const store=storage(current);await assert.rejects(armLiveLease(config,'opaque',uid,lease,{},store.fetch,()=>100000),/superseded/);assert.deepEqual(store.value,current);}
});
test('expired in-flight bootstrap cannot resurrect a lease after tombstone garbage collection',async()=>{
 const store=storage(null);await assert.rejects(armLiveLease(config,'opaque',uid,lease,{},store.fetch,()=>800000),/expired/);assert.equal(store.value,null);
});
test('new generation arms bounded lease and replaces only older generation',async()=>{
 const store=storage({revision:'4',expiresAt:650000});await armLiveLease(config,'opaque',uid,lease,{},store.fetch,()=>100000);
 assert.deepEqual(store.value,{expiresAt:700000,rooms:{},revision:'5'});
});
test('ETag race rereads revocation and refuses stale overwrite',async()=>{
 let reads=0,puts=0;const fetcher=async(_url,init)=>{
 if(init.method==='PUT'){puts++;return new Response('',{status:412});}
 reads++;return new Response(JSON.stringify(reads===1?null:{revision:'5',revoked:true,expiresAt:0}),{headers:{etag:String(reads)}});
 };
 await assert.rejects(armLiveLease(config,'opaque',uid,lease,{},fetcher,()=>100000),/superseded/);assert.equal(puts,1);
});
