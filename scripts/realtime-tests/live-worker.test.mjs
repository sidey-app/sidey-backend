import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { LiveWorker } from "./live-worker.mjs";
import { liveFirebaseConfig, liveEvent, liveHint, liveCustomToken } from "../../supabase/functions/_shared/realtime-live.mjs";
const room = "11111111-1111-4111-8111-111111111111";
const uid = "22222222-2222-4222-8222-222222222222";
const sid = "33333333-3333-4333-8333-333333333333";
const eventID = "44444444-4444-4444-8444-444444444444";
const now = 1800000000000;
const row = { id: "1", room_id: room, event_id: eventID, epoch: 1, revision: "9007199254740993",
  kind: "message_changed", payload: {}, occurred_at: new Date(now - 100).toISOString(),
  access: { enabled: true, epoch: 1, members: { [uid]: true }, revision: "9007199254740993" } };
const base = `v2/rooms/${room}/epochs/1`;
function harness({ rpc: handleRPC, intercept, clock = () => now, combineClaims = false } = {}) {
  const data = new Map(), versions = new Map(), calls = [], rpcs = [], logs = [];
  const put = (path, value) => { data.set(path, value); versions.set(path, (versions.get(path) ?? 0) + 1); };
  const fetcher = async (url, init) => {
    assert.equal(new URL(url).search, "");
    const path = new URL(url).pathname.slice(1, -5);
    calls.push({ path, init });
    const intercepted = await intercept?.({ path, init, data, put });
    if (intercepted) return intercepted;
    if (!init.method || init.method === "GET") return new Response(JSON.stringify(data.get(path) ?? null), { headers: { etag: String(versions.get(path) ?? 0) } });
    if (init.method === "DELETE") { put(path, null); return new Response("null"); }
    const current = data.get(path) ?? null;
    const matches = init.headers["if-match"] === "null_etag" ? current === null
      : init.headers["if-match"] === String(versions.get(path) ?? 0);
    if (!matches) return new Response(JSON.stringify(current), { status: 412,
      headers: { etag: String(versions.get(path) ?? 0) } });
    put(path, JSON.parse(init.body)); return new Response(init.body);
  };
  const rpc = async (name, args) => { rpcs.push({ name, args }); return name === "finish_firebase_live_batch" ? (handleRPC?.(name, args) ?? args.p_ids) : handleRPC?.(name, args); };
  const worker = new LiveWorker({ config: { databaseURL: "https://fixture.example" }, rpc, accessToken: async () => "secret",
    fetcher, now: clock, combineClaims, log: stage => logs.push(stage) });
  return { worker, data, versions, calls, rpcs, logs, put };
}
test("live environment requires explicit approval and exact Firebase/Supabase project binding", () => {
  const vars = { SIDEY_FIREBASE_MODE: "live", SIDEY_FIREBASE_LIVE_APPROVED: "true",
    SIDEY_FIREBASE_PROJECT_ID: "sidey-staging", SIDEY_FIREBASE_SUPABASE_PROJECT_REF: "stagingref",
    SIDEY_FIREBASE_DATABASE_URL: "https://sidey-staging-default-rtdb.asia-southeast1.firebasedatabase.app",
    SUPABASE_URL: "https://stagingref.supabase.co", SIDEY_FIREBASE_API_KEY: "public",
    SIDEY_FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: "sidey-staging", client_email: "publisher@sidey-staging.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----fixture" }) };
  assert.ok(liveFirebaseConfig(key => vars[key]));
  assert.equal(liveFirebaseConfig(key => key === "SIDEY_FIREBASE_LIVE_APPROVED" ? "false" : vars[key]), null);
  for (const key of ["SIDEY_FIREBASE_PROJECT_ID", "SIDEY_FIREBASE_SUPABASE_PROJECT_REF", "SUPABASE_URL"]) {
    assert.throws(() => liveFirebaseConfig(k => k === key ? "wrong" : vars[k]));
  }
});
test("hint excludes row-only data and preserves decimal revision", () => {
  assert.equal(liveHint({ ...row, secret: "private" }).revision, row.revision);
  assert.equal(Object.hasOwn(liveHint({ ...row, secret: "private" }), "secret"), false);
  assert.throws(() => liveHint({ ...row, revision: 4 }));
  assert.throws(() => liveEvent({ ...row, kind: "typing_start", payload: { large: "x".repeat(4097) } }));
});
test("duplicate and reversed publication never replace a newer hint", async () => {
  const h = harness(); await h.worker.publish(row); await h.worker.publish(row);
  await h.worker.publish({ ...row, revision: "9007199254740992" });
  assert.equal(h.data.get(`${base}/hint`).revision, row.revision);
  assert.equal(h.calls.filter(c => c.path === `${base}/hint` && c.init.method === "PUT").length, 1);
  assert.equal(h.rpcs.filter(c => c.name === "finish_firebase_live").length, 3);
});
test("revoked/new-epoch access wins structure CAS race and suppresses stale delivery", async () => {
  let collided = false;
  const h = harness({ intercept: ({ path, init, put }) => {
    if (path.startsWith("v2/access/") && init.method === "PUT" && !collided) {
      collided = true; put(path, { ...row.access, enabled: false, revision: "9007199254740994" });
      return new Response("null", { status: 412 });
    }
  } });
  await h.worker.publish({ ...row, kind: "structure_changed" });
  assert.equal(h.data.has(`${base}/hint`), false);
  assert.equal(h.data.get(`v2/access/${room}`).enabled, false);
  assert.equal(h.rpcs.at(-1).name, "finish_firebase_live");
});
test("hint write failure is retried without acknowledging durable work", async () => {
  const h = harness({ intercept: ({ path, init }) => path.endsWith("/hint") && init.method === "PUT"
    ? new Response("private upstream body", { status: 503 }) : undefined });
  await assert.rejects(h.worker.publish(row), /write_failed/);
  assert.equal(h.rpcs.length, 0);
});
test("ephemeral retries keep original TTL and expired events are acknowledged without publishing", async () => {
  const h = harness();
  const event = { ...row, kind: "typing_start", payload: { user_id: uid } };
  await h.worker.publish(event); await h.worker.publish(event);
  assert.equal(h.data.get(`${base}/events/${eventID}`).expiresAt, now + 4900);
  assert.equal(h.calls.filter(c => c.path.includes("/events/") && c.init.method === "PUT").length, 2);
  assert.equal(h.calls.filter(c => c.path.includes("/events/") && (!c.init.method || c.init.method === "GET")).length, 0);
  assert.equal(h.versions.get(`${base}/events/${eventID}`), 1);
  assert.equal(h.logs.filter(stage => stage === "publish_written").length, 1);
  const old = harness(); await old.worker.publish({ ...event, occurred_at: new Date(now - 5001).toISOString() });
  assert.equal([...old.data.keys()].some(k => k.includes("/events/")), false);
  assert.equal(old.rpcs.at(-1).name, "finish_firebase_live");
});
test("create-only events preserve a conflicting revision and never acknowledge it", async () => {
  const h = harness();
  const path = `${base}/events/${eventID}`;
  const existing = { ...liveEvent({ ...row, kind: "typing_start" }), revision: "9007199254740994" };
  h.put(path, existing);
  await assert.rejects(h.worker.publish({ ...row, kind: "typing_start" }), /live_event_collision/);
  assert.deepEqual(h.data.get(path), existing);
  assert.equal(h.versions.get(path), 1);
  assert.equal(h.rpcs.length, 0);
});
test("ambiguous create-only responses retain durable work without blind retries", async () => {
  for (const status of [412, 503]) {
    const h = harness({ intercept: ({ path }) => path.includes("/events/")
      ? new Response("null", { status }) : undefined });
    await assert.rejects(h.worker.publish({ ...row, kind: "typing_start" }),
      status === 412 ? /live_contention/ : /live_write_failed/);
    assert.equal(h.rpcs.length, 0);
    assert.equal(h.calls.filter(call => call.path.includes("/events/")).length, 1);
    assert.equal(h.logs.includes("publish_written"), false);
  }
});
test("a lost event response retries the same UUID without rewriting or extending TTL", async () => {
  let lost = false;
  const h = harness({ intercept: ({ path, init, put }) => {
    if (path.includes("/events/") && !lost) {
      lost = true; put(path, JSON.parse(init.body)); throw new Error("fixture_response_lost");
    }
  } });
  const event = { ...row, kind: "character_throw", payload: { event_id: eventID } };
  await assert.rejects(h.worker.publish(event), /fixture_response_lost/);
  assert.equal(h.rpcs.length, 0);
  await h.worker.publish(event);
  assert.equal(h.versions.get(`${base}/events/${eventID}`), 1);
  assert.equal(h.data.get(`${base}/events/${eventID}`).expiresAt, now + 4900);
  assert.equal(h.rpcs.filter(call => call.name === "finish_firebase_live").length, 1);
});
test("room batch synchronizes the greatest access revision once and creates each event once", async () => {
  const events = [3, 1, 2].map(n => ({ ...row, id: String(n), kind: "typing_start",
    event_id: `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`,
    access: { ...row.access, revision: String(BigInt(row.access.revision) + BigInt(n)) } }));
  const h = harness({ rpc: (name, args) => name === "claim_firebase_live" ? events : name === "finish_firebase_live_batch" ? args.p_ids : true });
  assert.deepEqual(await h.worker.batch(), { claimed: 3, completed: 3, retries: 0 });
  const accessCalls = h.calls.filter(call => call.path === `v2/access/${room}`);
  assert.equal(accessCalls.length, 2);
  assert.equal(h.versions.get(`v2/access/${room}`), 1);
  assert.equal(h.data.get(`v2/access/${room}`).revision, events[0].access.revision);
  assert.equal(h.calls.filter(call => call.path.includes("/events/")).length, 3);
  assert.ok(h.calls.filter(call => call.path.includes("/events/")).every(call => call.init.headers["if-match"] === "null_etag"));
  assert.deepEqual(h.rpcs.filter(call => call.name === "finish_firebase_live_batch").map(call => call.args.p_ids), [["3", "1", "2"]]);
});
test("a newer revocation or epoch winning batch access suppresses every old-epoch event", async () => {
  for (const newer of [{ enabled: false, epoch: 1 }, { enabled: true, epoch: 2 }]) {
    let collided = false;
    const events = [row, { ...row, id: "2" }].map(value => ({ ...value, kind: "typing_start" }));
    const h = harness({ rpc: (name, args) => name === "claim_firebase_live" ? events : name === "finish_firebase_live_batch" ? args.p_ids : true,
      intercept: ({ path, init, put }) => {
        if (path.startsWith("v2/access/") && init.method === "PUT" && !collided) {
          collided = true; put(path, { ...row.access, ...newer, revision: "9007199254740994" });
        }
      } });
    assert.deepEqual(await h.worker.batch(), { claimed: 2, completed: 2, retries: 0 });
    assert.equal(h.calls.some(call => call.path.startsWith("v2/rooms/")), false);
    assert.equal(h.data.get(`v2/access/${room}`).revision, "9007199254740994");
    assert.equal(h.rpcs.filter(call => call.name === "finish_firebase_live_batch").length, 1);
  }
});
test("failed batch access synchronization retries the whole room without acknowledging rows", async () => {
  const h = harness({ rpc: name => name === "claim_firebase_live" ? [{ ...row, kind: "structure_changed" }, { ...row, id: "2" }] : true,
    intercept: ({ path }) => path.startsWith("v2/access/") ? new Response("secret", { status: 503 }) : undefined });
  assert.deepEqual(await h.worker.batch(), { claimed: 2, completed: 0, retries: 2 });
  assert.equal(h.rpcs.filter(call => call.name === "finish_firebase_live").length, 0);
  assert.equal(h.calls.some(call => call.path.startsWith("v2/rooms/")), false);
  assert.deepEqual(h.logs, ["publish_retry", "publish_retry"]);
});
test("event publication cancellation reaches create-only HTTP and never acknowledges", async () => {
  const controller = new AbortController();
  const h = harness({ intercept: ({ path, init }) => {
    if (!path.includes("/events/")) return;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      controller.abort();
    });
  } });
  await assert.rejects(h.worker.publish({ ...row, kind: "typing_start" }, controller.signal));
  assert.equal(h.rpcs.length, 0);
  assert.equal(h.data.has(`${base}/events/${eventID}`), false);
});
test("an event expiring during token acquisition is acknowledged without issuing its PUT", async () => {
  let clock = now;
  const h = harness({ clock: () => clock });
  h.worker.accessToken = async () => { await Promise.resolve(); clock = now + 4900; return "fixture"; };
  await h.worker.publish({ ...row, kind: "typing_start" }, undefined, row.access);
  assert.equal(h.calls.length, 0);
  assert.equal(h.logs.includes("publish_written"), false);
  assert.ok(h.logs.includes("publish_expired"));
  assert.equal(h.rpcs.at(-1).name, "finish_firebase_live");
});
test("an event expiring behind eight in-flight requests is not resurrected by a queued PUT", async () => {
  let clock = now;
  const release = [];
  const h = harness({ clock: () => clock, intercept: ({ path }) => {
    if (!path.startsWith("v2/leases/")) return;
    return new Promise(resolve => release.push(() => resolve(new Response("null"))));
  } });
  const blockers = Array.from({ length: 8 }, () => h.worker.request(`v2/leases/${uid}/${sid}`));
  // Allow the eight requests to reach the fixture transport before queueing the event.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(release.length, 8);
  const publishing = h.worker.publish({ ...row, kind: "typing_start" }, undefined, row.access);
  clock = now + 4900;
  for (const resolve of release) resolve();
  await Promise.all([...blockers, publishing]);
  assert.equal(h.calls.some(call => call.path.includes("/events/")), false);
  assert.ok(h.logs.includes("publish_expired"));
  assert.equal(h.rpcs.at(-1).name, "finish_firebase_live");
});
test("Edge counters distinguish expired SQL controls and committed RTDB writes from DB acknowledgements", async () => {
  const old = harness();
  await old.worker.publish({ ...row, kind: "control", original_kind: "typing_start", occurred_at: new Date(now - 6000).toISOString() });
  assert.ok(old.logs.includes("publish_expired"));
  assert.equal(old.logs.includes("publish_written"), false);
  const lost = harness({ rpc: () => false });
  await assert.rejects(lost.worker.publish(row), /live_claim_lost/);
  assert.equal(lost.logs.filter(stage => stage === "publish_written").length, 1);
  await assert.rejects(lost.worker.publish(row), /live_claim_lost/);
  assert.equal(lost.logs.filter(stage => stage === "publish_written").length, 1);
  assert.ok(lost.logs.includes("publish_suppressed"));
});
test("maintenance protects renewed leases and only deletes matching expired event generation", async () => {
  const lease = { user_id: uid, session_id: sid, revision: "7", expires_at: now - 100, rooms: { [room]: 1 } };
  const event = { id: "1", room_id: room, epoch: 1, event_id: eventID, expires_at: now - 1 };
  const h = harness({ rpc: name => name === "firebase_live_maintenance" ? { leases: [lease], events: [event], epochs: [] } : null });
  h.put(`v2/leases/${uid}/${sid}`, { revision: "8", expiresAt: now + 600000 });
  h.put(`${base}/presence/${uid}/${sid}`, { updatedAt: now });
  h.put(`${base}/events/${eventID}`, { expiresAt: now - 1 });
  await h.worker.cleanup();
  assert.equal(h.data.get(`v2/leases/${uid}/${sid}`).expiresAt, now + 600000);
  assert.equal(h.data.get(`${base}/presence/${uid}/${sid}`).updatedAt, now);
  assert.equal(h.data.get(`${base}/events/${eventID}`), null);
  assert.deepEqual(h.rpcs.filter(x => x.name === "finish_firebase_live_cleanup").map(x => x.args.p_kind), ["event"]);
});
test("cleanup failures retain work and do not skip other cleanup categories", async () => {
  const h = harness({ rpc: name => name === "firebase_live_maintenance" ? {
    leases: [{ user_id: uid, session_id: sid, revision: "7", expires_at: now - 1, rooms: { [room]: 1 } }],
    events: [{ id: "1", room_id: room, epoch: 1, event_id: eventID, expires_at: now - 1 }], epochs: [] } : null,
    intercept: ({ path }) => path.startsWith("v2/leases/") ? new Response("secret", { status: 500 }) : undefined });
  await h.worker.cleanup();
  assert.deepEqual(h.logs, ["cleanup_lease_retry", "cleanup_event_ok"]);
  assert.equal(h.rpcs.filter(x => x.name === "finish_firebase_live_cleanup").length, 1);
});
test("batch limits concurrency to eight and reports sanitized retry stages", async () => {
  let active = 0, peak = 0;
  const h = harness({ rpc: name => name === "claim_firebase_live" ? Array.from({ length: 30 }, (_, i) => ({ ...row, id: String(i + 1), room_id: `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}` })) : null });
  h.worker.publish = async value => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    if (value.id === "2") throw new Error("secret response");
  };
  await h.worker.batch();
  assert.equal(peak, 8);
  assert.equal(h.logs.filter(x => x === "publish_retry").length, 1);
  assert.equal(h.logs.length, 30);
});

test("same-room publications remain sequential and shutdown stops queued claims", async () => {
  const controller = new AbortController();
  const h = harness({ rpc: name => name === "claim_firebase_live" ? [row, { ...row, id: "2" }, { ...row, id: "3" }] : null });
  const started = [];
  h.worker.publish = async value => { started.push(value.id); controller.abort(); };
  await h.worker.batch(controller.signal);
  assert.deepEqual(started, ["1"]);
});
test("revocation removes matching future-expiry lease and old presence immediately", async () => {
  const lease = { user_id: uid, session_id: sid, revision: "7", expires_at: now + 600000, rooms: { [room]: 1 } };
  const h = harness({ rpc: name => name === "firebase_live_maintenance" ? { leases: [lease], events: [], epochs: [] } : null });
  h.put(`v2/leases/${uid}/${sid}`, { revision: lease.revision, expiresAt: lease.expires_at });
  h.put(`${base}/presence/${uid}/${sid}`, { updatedAt: now - 1000 });
  await h.worker.cleanup();
  assert.deepEqual(h.data.get(`v2/leases/${uid}/${sid}`), { revision: "7", revoked: true, expiresAt: 0 });
  assert.equal(h.data.get(`${base}/presence/${uid}/${sid}`), null);
  assert.equal(h.rpcs.at(-1).args.p_kind, "lease");
});
test("presence renewed after lease deletion survives cleanup", async () => {
  const lease = { user_id: uid, session_id: sid, revision: "7", expires_at: now + 600000, rooms: { [room]: 1 } };
  const h = harness({ rpc: name => name === "firebase_live_maintenance" ? { leases: [lease], events: [], epochs: [] } : null });
  h.put(`v2/leases/${uid}/${sid}`, { revision: lease.revision, expiresAt: lease.expires_at });
  h.put(`${base}/presence/${uid}/${sid}`, { updatedAt: now + 1 });
  await h.worker.cleanup();
  assert.equal(h.data.get(`${base}/presence/${uid}/${sid}`).updatedAt, now + 1);
});
test("lost claim is not reported as acknowledged", async () => {
  const h = harness({ rpc: name => name === "finish_firebase_live" ? false : undefined });
  await assert.rejects(h.worker.publish(row), /claim_lost/);
});

test("v2 token preserves Supabase UID and cryptographically binds protocol/session", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const account = { client_email: "publisher@fixture.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const token = await liveCustomToken(account, uid, sid, now);
  const [header, body, signature] = token.split(".");
  assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${body}`), createPublicKey(privateKey), Buffer.from(signature, "base64url")), true);
  const claims = JSON.parse(Buffer.from(body, "base64url"));
  assert.equal(claims.uid, uid);
  assert.deepEqual(claims.claims, { sideySessionId: sid, sideyProtocol: 2 });
  assert.equal(claims.exp - claims.iat, 300);
});
test("publication cancellation reaches pending HTTP and never acknowledges", async () => {
  const controller = new AbortController();
  const h = harness({ intercept: ({ path, init }) => {
    if (!path.endsWith("/hint") || init.method !== "PUT") return;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      controller.abort();
    });
  } });
  await assert.rejects(h.worker.publish(row, controller.signal));
  assert.equal(h.rpcs.length, 0);
});

test("cleanup leaves a generation tombstone even when remote lease is absent", async () => {
  const lease = { user_id: uid, session_id: sid, revision: "7", expires_at: now + 600000, rooms: {} };
  const h = harness({ rpc: name => name === "firebase_live_maintenance" ? { leases: [lease], events: [], epochs: [] } : null });
  await h.worker.cleanup();
  assert.deepEqual(h.data.get(`v2/leases/${uid}/${sid}`), { revision: "7", revoked: true, expiresAt: 0 });
  await h.worker.cleanup();
  assert.equal(h.calls.filter(c => c.path.startsWith("v2/leases/") && c.init.method === "PUT").length, 1);
  assert.equal(h.rpcs.filter(c => c.name === "finish_firebase_live_cleanup").length, 2);
});
test("cleanup CAS race cannot revoke a newer lease generation", async () => {
  const lease = { user_id: uid, session_id: sid, revision: "7", expires_at: now + 600000, rooms: {} };
  let collided = false;
  const h = harness({ rpc: name => name === "firebase_live_maintenance" ? { leases: [lease], events: [], epochs: [] } : null,
    intercept: ({ path, init, put }) => {
      if (path.startsWith("v2/leases/") && init.method === "PUT" && !collided) {
        collided = true; put(path, { revision: "8", expiresAt: now + 600000 });
        return new Response("null", { status: 412 });
      }
    } });
  await h.worker.cleanup();
  assert.equal(h.data.get(`v2/leases/${uid}/${sid}`).revision, "8");
  assert.equal(h.rpcs.filter(c => c.name === "finish_firebase_live_cleanup").length, 0);
});

test("final lease GC revokes an active old generation before deleting its tombstone", async () => {
  const lease = { user_id: uid, session_id: sid, revision: "7", expires_at: now - 60001, rooms: {}, purge: true };
  const h = harness({ rpc: name => name === "firebase_live_maintenance" ? { leases: [lease], events: [], epochs: [] } : null });
  h.put(`v2/leases/${uid}/${sid}`, { revision: "7", expiresAt: lease.expires_at });
  await h.worker.cleanup();
  assert.equal(h.data.get(`v2/leases/${uid}/${sid}`).revoked, true);
  assert.equal(h.rpcs.filter(c => c.name === "finish_firebase_live_cleanup").length, 0);
  await h.worker.cleanup();
  assert.equal(h.data.get(`v2/leases/${uid}/${sid}`), null);
  assert.equal(h.rpcs.filter(c => c.name === "finish_firebase_live_cleanup").length, 1);
});
test("final lease GC preserves a newer generation and rejects premature purge", async () => {
  let lease = { user_id: uid, session_id: sid, revision: "7", expires_at: now - 60001, rooms: {}, purge: true };
  const h = harness({ rpc: name => name === "firebase_live_maintenance" ? { leases: [lease], events: [], epochs: [] } : null });
  h.put(`v2/leases/${uid}/${sid}`, { revision: "8", expiresAt: now + 10000 });
  await h.worker.cleanup();
  assert.equal(h.rpcs.filter(c => c.name === "finish_firebase_live_cleanup").length, 0);
  assert.equal(h.data.get(`v2/leases/${uid}/${sid}`).revision, "8");
  lease = { ...lease, expires_at: now };
  await h.worker.cleanup();
  assert.equal(h.logs.at(-1), "cleanup_lease_retry");
});

test("a failed renewal cannot hide an older remote generation from revocation", async () => {
  const lease = { user_id: uid, session_id: sid, revision: "7", expires_at: now + 600000, rooms: {} };
  const h = harness({ rpc: name => name === "firebase_live_maintenance" ? { leases: [lease], events: [], epochs: [] } : null });
  h.put(`v2/leases/${uid}/${sid}`, { revision: "6", expiresAt: now + 500000 });
  await h.worker.cleanup();
  assert.deepEqual(h.data.get(`v2/leases/${uid}/${sid}`), { revision: "7", revoked: true, expiresAt: 0 });
  assert.equal(h.rpcs.at(-1).name, "finish_firebase_live_cleanup");
});

test("all same-room hints reach RTDB before one batched completion RPC", async () => {
  const rows = [1, 2, 3].map(id => ({ ...row, id: String(id), revision: String(BigInt(row.revision) + BigInt(id)) }));
  let finishes = 0;
  const h = harness({ rpc: (name, args) => {
    if (name === "claim_firebase_live") assert.fail("prefetched first claim must not query again");
    if (name === "finish_firebase_live") assert.fail("per-row completion delays the next hint");
    if (name === "finish_firebase_live_batch") {
      finishes++;
      assert.equal(h.data.get(`${base}/hint`).revision, rows[2].revision);
      assert.deepEqual(args.p_ids, ["1", "2", "3"]);
      return args.p_ids;
    }
  } });
  assert.deepEqual(await h.worker.batch(undefined, 25, rows), { claimed: 3, completed: 3, retries: 0 });
  assert.equal(finishes, 1);
});

test("batched completion never counts lost, partial, or malformed acknowledgements as success", async () => {
  for (const ack of [[], ["1"], ["9"], ["1", "1"], "response lost"]) {
    const h = harness({ rpc: name => {
      if (name === "finish_firebase_live_batch") {
        if (ack === "response lost") throw new Error("private upstream detail");
        return ack;
      }
    } });
    const result = await h.worker.batch(undefined, 25, [row, { ...row, id: "2" }]);
    const completed = Array.isArray(ack) && ack.length === 1 && ack[0] === "1" ? 1 : 0;
    assert.deepEqual(result, { claimed: 2, completed, retries: 2 - completed });
    assert.equal(h.data.get(`${base}/hint`).revision, row.revision);
  }
});

test("direct-event cleanup uses UUID metadata and preserves a different expiry generation", async () => {
  for (const changed of [false, true]) {
    const event = { id: eventID, event_id: eventID, room_id: room, epoch: 1, expires_at: now - 31000 };
    const h = harness({ rpc: name => name === "firebase_live_maintenance"
      ? { leases: [], events: [], epochs: [], directEvents: [event] } : null });
    h.put(`${base}/events/${eventID}`, { expiresAt: event.expires_at + (changed ? 1 : 0) });
    const result = await h.worker.cleanup();
    assert.equal(result.completed, changed ? 0 : 1);
    assert.deepEqual(h.rpcs.filter(call => call.name === "finish_firebase_live_cleanup").map(call => call.args),
      changed ? [] : [{ p_kind: "direct_event", p_id: eventID }]);
  }
});

test("ordinary message and prune notifications use only hint GET/conditional PUT without access requests", async () => {
  for (const kind of ["message_changed", "messages_pruned"]) {
    const h = harness(); h.put(`v2/access/${room}`, row.access);
    await h.worker.publish({ ...row, kind });
    assert.deepEqual(h.calls.map(call => [call.path, call.init.method ?? "GET"]),
      [[`${base}/hint`, "GET"], [`${base}/hint`, "PUT"]]);
    assert.equal(h.calls[1].init.headers["if-match"], "0");
    assert.deepEqual(h.data.get(`v2/access/${room}`), row.access);
    assert.equal(h.data.get(`${base}/hint`).kind, kind);
    assert.equal(h.rpcs.at(-1).name, "finish_firebase_live");
  }
});

test("notification-only batches preserve hint CAS and batch ACK without synchronizing room access", async () => {
  const rows = [1, 2, 3].map(n => ({ ...row, id: String(n), revision: String(BigInt(row.revision) + BigInt(n)) }));
  const h = harness();
  assert.deepEqual(await h.worker.batch(undefined, 25, rows), { claimed: 3, completed: 3, retries: 0 });
  assert.equal(h.calls.length, 6); assert.ok(h.calls.every(call => call.path === `${base}/hint`));
  assert.equal(h.data.get(`${base}/hint`).revision, rows[2].revision);
  assert.deepEqual(h.rpcs.map(call => call.name), ["finish_firebase_live_batch"]);
});

test("a late approved-epoch notification cannot restore revoked access or alter a replacement epoch", async () => {
  for (const newer of [{ enabled: false, epoch: 1 }, { enabled: true, epoch: 2 }]) {
    const h = harness(), accessPath = `v2/access/${room}`, replacementPath = `v2/rooms/${room}/epochs/2/hint`;
    const revoked = { ...row.access, ...newer, members: {}, revision: "9007199254740999" };
    const replacement = { ...liveHint(row), epoch: 2, revision: "9007199254740998" };
    h.put(accessPath, revoked); h.put(replacementPath, replacement);
    await h.worker.publish(row);
    assert.deepEqual(h.data.get(accessPath), revoked); assert.equal(h.versions.get(accessPath), 1);
    assert.deepEqual(h.data.get(replacementPath), replacement); assert.equal(h.versions.get(replacementPath), 1);
    assert.ok(h.calls.every(call => call.path === `${base}/hint`));
    // The old path may contain metadata, as for a late direct event. Existing
    // Rules gate readers on current access/epoch; no permission is reinstated.
    assert.equal(h.data.get(`${base}/hint`).epoch, 1);
  }
});

test("notifications never establish missing access; an enrollment control still arms the authoritative snapshot", async () => {
  const h = harness(); await h.worker.publish(row);
  assert.equal(h.data.has(`v2/access/${room}`), false);
  h.calls.length = 0;
  await h.worker.publish({ ...row, kind: "control" });
  assert.deepEqual(h.data.get(`v2/access/${room}`), row.access);
  assert.deepEqual(h.calls.map(call => call.path), [`v2/access/${room}`, `v2/access/${room}`]);
});

test("mixed batches synchronize revocation before hints and never restore access from a stale control", async () => {
  const h = harness(), path = `v2/access/${room}`;
  const control = { ...row, id: "2", kind: "control", access: { ...row.access, enabled: false, revision: "9007199254740994" } };
  assert.deepEqual(await h.worker.batch(undefined, 25, [row, control]), { claimed: 2, completed: 2, retries: 0 });
  assert.equal(h.data.get(path).enabled, false); assert.equal(h.data.has(`${base}/hint`), false);
  await h.worker.publish({ ...row, kind: "control" });
  assert.deepEqual(h.data.get(path), control.access); assert.equal(h.versions.get(path), 1);
});

test("SQL-disabled or mismatched-epoch notifications are suppressed without touching RTDB", async () => {
  for (const access of [{ ...row.access, enabled: false }, { ...row.access, epoch: 2 }]) {
    const h = harness(); await h.worker.publish({ ...row, access });
    assert.equal(h.calls.length, 0); assert.equal(h.rpcs.at(-1).name, "finish_firebase_live");
    assert.ok(h.logs.includes("publish_suppressed"));
  }
});

test("newer hint winning a conditional write race remains intact on the notification-only path", async () => {
  let raced = false;
  const newer = { ...liveHint(row), revision: "9007199254740994" };
  const h = harness({ intercept: ({ path, init, put }) => {
    if (path === `${base}/hint` && init.method === "PUT" && !raced) { raced = true; put(path, newer); }
  } });
  await h.worker.publish(row);
  assert.deepEqual(h.data.get(`${base}/hint`), newer); assert.equal(h.versions.get(`${base}/hint`), 1);
  assert.ok(h.calls.every(call => call.path === `${base}/hint`));
  assert.equal(h.rpcs.at(-1).name, "finish_firebase_live");
});

const continuation = { remainingRows: 100, nextClaimLimit: 25, claimBefore: now + 19000 };
test('Edge batch combines ACK and next claim, and reuses returned rows without another claim', async () => {
  const next = { ...row, id: '2', revision: '9007199254740994' };
  const h = harness({ combineClaims: true, rpc: (name, args) => {
    if (name === 'finish_claim_firebase_live_dispatch') {
      assert.deepEqual(args.p_ids, ['1']); assert.equal(args.p_limit, 25);
      assert.equal(args.p_claim_before, new Date(now + 19000).toISOString());
      assert.equal(h.data.get(`${base}/hint`).revision, row.revision);
      return { completed: ['1'], rows: [next] };
    }
  } });
  const first = await h.worker.batch(undefined, 25, [row], continuation);
  assert.deepEqual(first, { claimed: 1, completed: 1, retries: 0, nextRows: [next] });
  assert.deepEqual(await h.worker.batch(undefined, 25, first.nextRows, { ...continuation, nextClaimLimit: 0 }),
    { claimed: 1, completed: 1, retries: 0 });
  assert.deepEqual(h.rpcs.map(x => x.name), ['finish_claim_firebase_live_dispatch', 'finish_firebase_live_batch']);
  assert.equal(h.data.get(`${base}/hint`).revision, next.revision);
});

test('partial publication acknowledges only successful rows without preclaiming', async () => {
  const second = { ...row, id: '2', room_id: '11111111-1111-4111-8111-111111111112' };
  const h = harness({ combineClaims: true, intercept: ({path}) => path.includes(second.room_id) ? new Response('null', {status:503}) : undefined });
  assert.deepEqual(await h.worker.batch(undefined, 25, [row, second], continuation), { claimed:2,completed:1,retries:1 });
  assert.deepEqual(h.rpcs.map(x => x.name), ['finish_firebase_live_batch']);
  assert.deepEqual(h.rpcs[0].args.p_ids, ['1']);
});

test('lost, partial or malformed combined responses never trigger speculative followup work', async () => {
  const next = { ...row, id:'2' };
  for (const reply of [undefined, {completed:['1'],rows:[row]}, {completed:['1'],rows:[next,next]},
    {completed:['other'],rows:[]}, {completed:[],rows:[next]}, {completed:['1']},
    {completed:['1'],rows:Array.from({length:26},(_,i)=>({...row,id:String(i+2)}))}]) {
    const h = harness({ combineClaims:true, rpc:()=>{ if (reply === undefined) throw new Error('response lost'); return reply; } });
    const result=await h.worker.batch(undefined,25,[row],continuation);
    assert.deepEqual(result,{claimed:1,completed:0,retries:1}); assert.equal(h.rpcs.length,1);
  }
  const h=harness({combineClaims:true,rpc:()=>({completed:[],rows:[]})});
  assert.deepEqual(await h.worker.batch(undefined,25,[row],continuation),{claimed:1,completed:0,retries:1,nextRows:[]});
});

test('last batch, exhausted row budget, deadline and legacy workers retain ordinary ACK', async () => {
  for (const [combineClaims, options] of [[true,{...continuation,nextClaimLimit:0}],
    [true,{...continuation,remainingRows:1}], [true,{...continuation,claimBefore:now}], [false,continuation]]) {
    const h=harness({combineClaims});
    assert.deepEqual(await h.worker.batch(undefined,25,[row],options),{claimed:1,completed:1,retries:0});
    assert.deepEqual(h.rpcs.map(x=>x.name),['finish_firebase_live_batch']);
  }
  const h=harness({combineClaims:true,rpc:(name,args)=>{
    assert.equal(args.p_limit,2);return {completed:['1'],rows:[]};
  }});
  await h.worker.batch(undefined,25,[row],{...continuation,remainingRows:3});
});
