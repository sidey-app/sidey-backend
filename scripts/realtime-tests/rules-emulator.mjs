// Local RTDB emulator only; no production credentials or external network URLs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const host=process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:[0-9]+$/.test(host || "")) throw new Error("local_database_emulator_required");
const project="demo-sidey-realtime";
const uid="71000000-0000-4000-8000-000000000001", other="71000000-0000-4000-8000-000000000002";
const sid="73000000-0000-4000-8000-000000000001", room="72000000-0000-4000-8000-000000000001";
const path=`v1/rooms/${room}/epochs/1/hint`, leasePath=`v1/leases/${uid}/${sid}`;
function token(user=uid, claims={}) {
  const now=Math.floor(Date.now()/1000);
  const encode=(value)=>Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({alg:"none",typ:"JWT"})}.${encode({iss:`https://securetoken.google.com/${project}`,aud:project,
    iat:now,exp:now+3600,auth_time:now,sub:user,user_id:user,
    firebase:{identities:{},sign_in_provider:"custom"},sideyProtocol:1,sideySessionId:sid,...claims})}.`;
}
async function request(target,{admin=false,userToken,method="GET",body}={}) {
  const url=new URL(`http://${host}/${target}.json`);
  url.searchParams.set("ns",`${project}-default-rtdb`);
  if(userToken)url.searchParams.set("auth",userToken);
  return fetch(url,{method,headers:{"content-type":"application/json",...(admin?{authorization:"Bearer owner"}:{})},
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});
}
const loadedRules=await request(".settings/rules",{admin:true});
assert.equal(loadedRules.status,200);
assert.deepEqual(await loadedRules.json(),JSON.parse(await readFile(new URL("../../supabase/firebase/database.shadow.rules.json",import.meta.url),"utf8")),"test must target namespace with exact shadow Rules loaded");
const activeLease={expiresAt:Date.now()+60000,rooms:{[room]:1}};
assert.equal((await request("v1",{admin:true,method:"PUT",body:{leases:{[uid]:{[sid]:activeLease}},
  rooms:{[room]:{epochs:{1:{hint:{revision:"1"}}}}}}})).status,200);
assert.equal((await request(path,{userToken:token()})).status,200,"member with active matching epoch lease may read");
for (const [label,target,options] of [
  ["anonymous",path,{}],
  ["outsider",path,{userToken:token(other)}],
  ["wrong session",path,{userToken:token(uid,{sideySessionId:other})}],
  ["wrong protocol",path,{userToken:token(uid,{sideyProtocol:2})}],
  ["other epoch",`v1/rooms/${room}/epochs/2/hint`,{userToken:token()}],
  ["parent enumeration","v1/rooms",{userToken:token()}],
  ["lease inspection",leasePath,{userToken:token()}],
  ["client hint write",path,{userToken:token(),method:"PUT",body:{revision:"2"}}],
  ["client lease extension",leasePath,{userToken:token(),method:"PUT",body:activeLease}],
]) {
  const response=await request(target,options);
  assert.equal(response.status,401,label);
  console.log(`PASS Rules deny ${label}`);
}
await request(leasePath,{admin:true,method:"PUT",body:{...activeLease,expiresAt:Date.now()-1}});
assert.equal((await request(path,{userToken:token()})).status,401,"expired lease denied");
console.log("PASS Rules deny expired lease");
await request(leasePath,{admin:true,method:"DELETE"});
assert.equal((await request(path,{userToken:token()})).status,401,"removed lease denied");
console.log("PASS Rules deny removed lease");

// Rules must also terminate a connected read after the server revokes its lease.
await request(leasePath,{admin:true,method:"PUT",body:{...activeLease,expiresAt:Date.now()+60000}});
const streamURL=new URL(`http://${host}/${path}.json`);
streamURL.searchParams.set("ns",`${project}-default-rtdb`);streamURL.searchParams.set("auth",token());
const abort=new AbortController();
const timeout=setTimeout(()=>abort.abort(),5000);
try {
  const stream=await fetch(streamURL,{headers:{accept:"text/event-stream"},signal:abort.signal});
  assert.equal(stream.status,200);
  const reader=stream.body.getReader();
  const decode=new TextDecoder();let received="";
  while(!received.includes("event: put")){ const chunk=await reader.read();if(chunk.done)break;received+=decode.decode(chunk.value); }
  assert.ok(received.includes("event: put"));
  await request(leasePath,{admin:true,method:"DELETE"});
  while(!received.includes("event: cancel")){const chunk=await reader.read();if(chunk.done)break;received+=decode.decode(chunk.value);}
  assert.ok(received.includes("event: cancel"),"revoked lease cancels already-open SSE reader");
  await reader.cancel();
  console.log("PASS active SSE cancelled after lease removal");
} finally {clearTimeout(timeout);abort.abort();}

const lockedRules=JSON.parse(await readFile(new URL("../../supabase/firebase/database.rules.json",import.meta.url),"utf8"));
assert.equal((await request(".settings/rules",{admin:true,method:"PUT",body:lockedRules})).status,200);
await request(leasePath,{admin:true,method:"PUT",body:{...activeLease,expiresAt:Date.now()+60000}});
assert.equal((await request(path,{userToken:token()})).status,401,"default locked Rules reject an otherwise valid member");
console.log("PASS default locked Rules deny valid member");
