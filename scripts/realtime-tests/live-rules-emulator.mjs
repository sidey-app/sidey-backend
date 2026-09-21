// Explicit local emulator contract verification; never contacts a real Firebase project.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const host = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (!/^127\.0\.0\.1:[0-9]+$/.test(host ?? "")) throw new Error("local_emulator_required");
const project = "demo-sidey-realtime";
const uid = "71000000-0000-4000-8000-000000000001", outsider = "71000000-0000-4000-8000-000000000002";
const sid = "73000000-0000-4000-8000-000000000001", otherSession = "73000000-0000-4000-8000-000000000002";
const room = "72000000-0000-4000-8000-000000000001";
const path = `v2/rooms/${room}/epochs/1`, leasePath = `v2/leases/${uid}/${sid}`, accessPath = `v2/access/${room}`;
const own = `${path}/presence/${uid}/${sid}`;
function token(user = uid, claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ iss: `https://securetoken.google.com/${project}`, aud: project,
    iat: now, exp: now + 3600, auth_time: now, sub: user, user_id: user,
    firebase: { identities: {}, sign_in_provider: "custom" }, sideyProtocol: 2, sideySessionId: sid, ...claims })}.`;
}
function url(target, auth) {
  const value = new URL(`http://${host}/${target}.json`);
  value.searchParams.set("ns", `${project}-default-rtdb`);
  if (auth) value.searchParams.set("auth", auth);
  return value;
}
async function request(target, { admin = false, auth, method = "GET", body, headers = {} } = {}) {
  return fetch(url(target, auth), { method, headers: { "content-type": "application/json", ...(admin ? { authorization: "Bearer owner" } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
}
const rules = JSON.parse(await readFile(new URL("../../supabase/firebase/database.live.rules.json", import.meta.url), "utf8"));
assert.deepEqual(await (await request(".settings/rules", { admin: true })).json(), rules, "exact live Rules must be loaded");
const access = { enabled: true, epoch: 1, revision: "1", members: { [uid]: true } };
const lease = { expiresAt: Date.now() + 600000, rooms: { [room]: 1 } };
assert.equal((await request("v2", { admin: true, method: "PUT", body: {
  access: { [room]: access }, leases: { [uid]: { [sid]: lease } },
  rooms: { [room]: { epochs: { 1: { hint: { revision: "1" } } } } },
} })).status, 200);
const auth = token();
const eventPath = `${path}/events/${sid}`;
const event = { kind: "typing_start", payload: { user_id: uid }, revision: "1", occurredAt: Date.now(), expiresAt: Date.now() + 5000 };
assert.equal((await request(eventPath, { admin: true, method: "PUT", headers: { "if-match": "null_etag" }, body: event })).status, 200);
const duplicate = await request(eventPath, { admin: true, method: "PUT", headers: { "if-match": "null_etag" }, body: { ...event, revision: "2" } });
assert.equal(duplicate.status, 412);
assert.deepEqual(await duplicate.json(), event, "412 returns the original event without a separate GET");
assert.deepEqual(await (await request(eventPath, { auth })).json(), event, "conditional create cannot overwrite an existing event");
console.log("PASS live publisher conditional event create and collision response");
const presence = { state: "online", active: true, updatedAt: { ".sv": "timestamp" } };
assert.equal((await request(path, { auth })).status, 200, "lease/member may read whole epoch");
assert.equal((await request(own, { auth, method: "PUT", body: presence })).status, 200, "own presence write");
const written = await (await request(own, { auth })).json();
assert.equal(typeof written.updatedAt, "number");
assert.equal((await request(own, { auth, method: "PUT", body: { ...presence, state: "away", active: false } })).status, 200);
assert.equal((await request(own, { auth, method: "DELETE" })).status, 200, "own presence delete");
console.log("PASS live Rules own presence and epoch read");
for (const [label, target, options] of [
  ["anonymous", path, {}], ["outsider", path, { auth: token(outsider) }],
  ["wrong protocol", path, { auth: token(uid, { sideyProtocol: 1 }) }],
  ["wrong session", path, { auth: token(uid, { sideySessionId: otherSession }) }],
  ["other epoch", `v2/rooms/${room}/epochs/2`, { auth }],
  ["room enumeration", "v2/rooms", { auth }], ["access inspection", accessPath, { auth }], ["lease inspection", leasePath, { auth }],
  ["other user presence", `${path}/presence/${outsider}/${sid}`, { auth, method: "PUT", body: presence }],
  ["other session presence", `${path}/presence/${uid}/${otherSession}`, { auth, method: "PUT", body: presence }],
  ["parent presence overwrite", `${path}/presence/${uid}`, { auth, method: "PUT", body: { [sid]: presence } }],
  ["hint write", `${path}/hint`, { auth, method: "PUT", body: { revision: "2" } }],
  ["event write", `${path}/events/${sid}`, { auth, method: "PUT", body: { kind: "typing_start" } }],
  ["access write", accessPath, { auth, method: "PUT", body: access }],
  ["lease extension", leasePath, { auth, method: "PUT", body: lease }],
  ["invalid state", own, { auth, method: "PUT", body: { ...presence, state: "offline" } }],
  ["invalid active", own, { auth, method: "PUT", body: { ...presence, active: "true" } }],
  ["extra data", own, { auth, method: "PUT", body: { ...presence, text: "not presence" } }],
  ["missing field", own, { auth, method: "PUT", body: { state: "online", updatedAt: { ".sv": "timestamp" } } }],
  ["stale timestamp", own, { auth, method: "PUT", body: { ...presence, updatedAt: Date.now() - 90000 } }],
  ["future timestamp", own, { auth, method: "PUT", body: { ...presence, updatedAt: Date.now() + 90000 } }],
]) {
  assert.equal((await request(target, options)).status, 401, label);
  console.log(`PASS live Rules deny ${label}`);
}
for (const [label, value] of [["disabled cohort", { ...access, enabled: false }], ["revoked member", { ...access, members: {} }], ["changed epoch", { ...access, epoch: 2 }]]) {
  assert.equal((await request(accessPath, { admin: true, method: "PUT", body: value })).status, 200);
  assert.equal((await request(path, { auth })).status, 401, label);
  assert.equal((await request(own, { auth, method: "PUT", body: presence })).status, 401, `${label} rejects write`);
}
// A gateway authorized before revocation may finish a bounded old-epoch PUT.
// It never restores access, and neither the revoked reader nor a new epoch sees it.
const latePath = `${path}/events/${otherSession}`;
assert.equal((await request(latePath, {admin:true,method:"PUT",headers:{"if-match":"null_etag"},body:event})).status,200);
assert.equal((await request(latePath, {auth})).status,401,"late direct write cannot restore revoked epoch access");
// Notification-only publication is equally unable to restore a revoked epoch.
const lateHint = `${path}/hint`;
const hintBefore = await request(lateHint, { admin: true, headers: { 'X-Firebase-ETag': 'true' } });
assert.equal((await request(lateHint, { admin: true, method: 'PUT',
  headers: { 'if-match': hintBefore.headers.get('etag') }, body: { revision: '20' } })).status, 200);
assert.equal((await request(lateHint, { auth })).status, 401, 'late ordinary hint cannot restore revoked epoch access');
assert.equal((await (await request(accessPath, { admin: true })).json()).epoch, 2, 'late hint leaves current access epoch untouched');
assert.equal((await request(lateHint, { admin: true, method: 'PUT',
  headers: { 'if-match': hintBefore.headers.get('etag') }, body: { revision: '2' } })).status, 412,
  'stale notification CAS cannot replace the newest hint');
console.log('PASS late ordinary hint preserves access and latest revision');
const beforeCleanup=await request(latePath,{admin:true,headers:{"X-Firebase-ETag":"true"}});
await request(latePath,{admin:true,method:"PUT",body:{...event,revision:"3"}});
assert.equal((await request(latePath,{admin:true,method:"PUT",headers:{"if-match":beforeCleanup.headers.get("etag")},body:null})).status,412,
 "stale cleanup cannot erase a changed event");
console.log("PASS late direct epoch write denied to clients and cleanup CAS collision");
await request(accessPath, { admin: true, method: "PUT", body: access });
await request(leasePath, { admin: true, method: "PUT", body: { ...lease, expiresAt: Date.now() - 1 } });
assert.equal((await request(path, { auth })).status, 401, "expired lease read");
assert.equal((await request(own, { auth, method: "PUT", body: presence })).status, 401, "expired lease write");
await request(leasePath, { admin: true, method: "PUT", body: lease });
console.log("PASS live Rules revoke/epoch/expiry read and write denial");
// Membership revocation must cancel an already-open whole-epoch SSE stream.
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), 8000);
try {
  const response = await fetch(url(path, auth), { headers: { accept: "text/event-stream" }, signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let received = "";
  async function until(event) {
    while (!received.includes(`event: ${event}`)) {
      const part = await reader.read(); if (part.done) break;
      received += decoder.decode(part.value);
    }
    assert.ok(received.includes(`event: ${event}`));
  }
  await until("put");
  await request(accessPath, { admin: true, method: "PUT", body: { ...access, enabled: false, revision: "2" } });
  await until("cancel"); await reader.cancel();
  console.log("PASS live Rules active SSE cancelled after cohort revocation");
} finally { clearTimeout(timeout); abort.abort(); }
