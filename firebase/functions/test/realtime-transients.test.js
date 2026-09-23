"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  bridgeClientTransient,
  parseClientTransientWrite,
  stableEventUuid,
  synchronizeTransientPublications,
} = require("../lib/realtime-transients");
const {SupabaseBridgeError} = require("../lib/supabase");

const actor = "10000000-0000-4000-8000-000000000001";
const target = "10000000-0000-4000-8000-000000000002";
const room = "20000000-0000-4000-8000-000000000001";
const session = "30000000-0000-4000-8000-000000000001";
const worker = "40000000-0000-4000-8000-000000000001";
const occurredAt = 1789859000000;

const snapshot = (value) => ({
  exists: () => value !== null,
  val: () => structuredClone(value),
});

function firebaseEvent({before = null, after = occurredAt, family = "typing", authType = "app_user"} = {}) {
  return {
    id: "cloud-event-1",
    time: new Date(occurredAt).toISOString(),
    authType,
    authId: actor,
    params: {
      roomId: room,
      uid: actor,
      ...(family === "typing" ? {sessionId: session} : {}),
    },
    data: {before: snapshot(before), after: snapshot(after)},
  };
}

function fakeDatabase() {
  const values = new Map([["/v2/a/g/e", true]]);
  const removeTree = (path) => {
    for (const key of [...values.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) values.delete(key);
    }
  };
  return {values, ref: (path = "") => ({
    get: async () => ({val: () => values.has(path) ? structuredClone(values.get(path)) : null}),
    transaction: async (mutate) => {
      const next = mutate(values.has(path) ? structuredClone(values.get(path)) : null);
      if (next === null) removeTree(path);
      else if (next !== undefined) values.set(path, structuredClone(next));
      return {committed: next !== undefined, snapshot: {val: () => values.get(path)}};
    },
  })};
}

function job(kind, overrides = {}) {
  return {
    id: 1,
    event_id: "50000000-0000-4000-8000-000000000001",
    room_id: room,
    actor_id: actor,
    session_id: session,
    kind,
    target_user_id: kind === "character_throw" ? target : null,
    wire_code: kind === "character_throw" ? "7" : null,
    occurred_at_ms: occurredAt,
    ...overrides,
  };
}

test("client compact writes keep the frozen payload and derive a retry-stable UUID", () => {
  const first = parseClientTransientWrite(firebaseEvent(), "typing");
  const second = parseClientTransientWrite(firebaseEvent(), "typing");
  assert.equal(first.kind, "typing_start");
  assert.equal(first.occurredAtMs, occurredAt);
  assert.equal(first.eventId, second.eventId);
  assert.match(first.eventId, /^[0-9a-f-]{36}$/);
  assert.notEqual(first.eventId, stableEventUuid("cloud-event-1", "typing_stop"));

  const stopped = parseClientTransientWrite(firebaseEvent({before: occurredAt - 1000, after: null}), "typing");
  assert.equal(stopped.kind, "typing_stop");
  const thrown = parseClientTransientWrite(firebaseEvent({
    family: "throw", after: {u: target, k: "7", t: occurredAt},
  }), "throw");
  assert.deepEqual({kind: thrown.kind, target: thrown.targetUserId, wire: thrown.wireCode}, {
    kind: "character_throw", target, wire: "7",
  });
  assert.equal(parseClientTransientWrite(firebaseEvent({authType: "admin"}), "typing"), null);
  for (const authType of ["unauthenticated", "unknown"]) {
    assert.throws(
      () => parseClientTransientWrite(firebaseEvent({authType}), "typing"),
      /invalid_transient_auth/,
    );
  }
});

test("Firebase to Supabase bridge sends one normalized service RPC", async () => {
  let request;
  const result = await bridgeClientTransient(firebaseEvent({family: "pulse"}), "pulse", {},
    async (_, name, args) => {
      request = {name, args};
      return {bridged: true};
    });
  assert.deepEqual(result, {bridged: true});
  assert.equal(request.name, "bridge_firebase_transient_to_legacy");
  assert.equal(request.args.p_kind, "character_pulse");
  assert.equal(request.args.p_actor_id, actor);
  assert.equal(request.args.p_session_id, null);
});

test("Firebase to Supabase bridge settles permanent rejections and retries outages", async () => {
  const invalid = await bridgeClientTransient(
    firebaseEvent({family: "pulse", authType: "unknown"}), "pulse", {},
    async () => assert.fail("invalid writes must not call Supabase"),
  );
  assert.deepEqual(invalid, {skipped: true, reason: "invalid_event"});

  const rejected = await bridgeClientTransient(firebaseEvent({family: "pulse"}), "pulse", {},
    async () => {
      throw new SupabaseBridgeError("supabase_access_failed", {status: 403});
    });
  assert.deepEqual(rejected, {skipped: true, reason: "rejected"});

  await assert.rejects(
    bridgeClientTransient(firebaseEvent({family: "pulse"}), "pulse", {}, async () => {
      throw new SupabaseBridgeError("supabase_access_failed", {status: 503});
    }),
    /supabase_access_failed/,
  );
});

test("legacy publications converge into compact slots without stale retry overwrite", async () => {
  const database = fakeDatabase();
  const rpc = async (_, name) => {
    if (name === "claim_firebase_transient_publications") {
      return [job("typing_start"), job("character_pulse", {id: 2}),
        job("character_throw", {id: 3})];
    }
    if (name === "validate_firebase_transient_publication") return true;
    if (name === "ack_firebase_transient_publication") return true;
    throw new Error("unexpected_rpc");
  };
  const result = await synchronizeTransientPublications({
    database, config: {}, workerId: worker, now: () => occurredAt + 100, rpc,
  });
  assert.deepEqual(result, {claimed: 3, delivered: 3, expired: 0, failed: 0});
  assert.equal(database.values.get(`/v2/l/${room}/t/${actor}/${session}`), occurredAt);
  assert.equal(database.values.get(`/v2/l/${room}/c/${actor}`), occurredAt);
  assert.deepEqual(database.values.get(`/v2/l/${room}/x/${actor}`), {
    u: target, k: "7", t: occurredAt,
  });

  database.values.set(`/v2/l/${room}/c/${actor}`, occurredAt + 1000);
  await synchronizeTransientPublications({
    database, config: {}, workerId: worker, now: () => occurredAt + 100,
    rpc: async (_, name) => name === "claim_firebase_transient_publications" ?
      [job("character_pulse")] : true,
  });
  assert.equal(database.values.get(`/v2/l/${room}/c/${actor}`), occurredAt + 1000);
});

test("a slow claimed publication cannot serially age out the rest of a burst", async () => {
  const database = fakeDatabase();
  let validating = 0;
  let maxValidating = 0;
  const result = await synchronizeTransientPublications({
    database, config: {}, workerId: worker, now: () => occurredAt + 100,
    rpc: async (_, name) => {
      if (name === "claim_firebase_transient_publications") {
        return Array.from({length: 10}, (_, index) => job("character_throw", {
          id: index + 1, occurred_at_ms: occurredAt + index,
        }));
      }
      if (name === "validate_firebase_transient_publication") {
        validating++;
        maxValidating = Math.max(maxValidating, validating);
        await new Promise((resolve) => setImmediate(resolve));
        validating--;
        return true;
      }
      if (name === "ack_firebase_transient_publication") return true;
      throw new Error("unexpected_rpc");
    },
  });
  assert.deepEqual(result, {claimed: 10, delivered: 10, expired: 0, failed: 0});
  assert.equal(maxValidating, 10);
  assert.equal(database.values.get(`/v2/l/${room}/x/${actor}`).t, occurredAt + 9);
});

test("parallel publication preserves start-before-stop on one typing slot", async () => {
  const database = fakeDatabase();
  const path = `/v2/l/${room}/t/${actor}/${session}`;
  const result = await synchronizeTransientPublications({
    database, config: {}, workerId: worker, now: () => occurredAt + 100,
    rpc: async (_, name, args) => {
      if (name === "claim_firebase_transient_publications") return [
        job("typing_start"), job("typing_stop", {id: 2, occurred_at_ms: occurredAt + 1}),
      ];
      if (name === "validate_firebase_transient_publication") {
        if (args.p_id === 1) await new Promise((resolve) => setImmediate(resolve));
        return true;
      }
      if (name === "ack_firebase_transient_publication") return true;
      throw new Error("unexpected_rpc");
    },
  });
  assert.deepEqual(result, {claimed: 2, delivered: 2, expired: 0, failed: 0});
  assert.equal(database.values.has(path), false);
});

test("typing stop and post-publish revocation remove only the matching old slot", async () => {
  const database = fakeDatabase();
  const path = `/v2/l/${room}/t/${actor}/${session}`;
  database.values.set(path, occurredAt - 1000);
  let validations = 0;
  await synchronizeTransientPublications({
    database, config: {}, workerId: worker, now: () => occurredAt + 100,
    rpc: async (_, name) => {
      if (name === "claim_firebase_transient_publications") return [job("typing_stop")];
      if (name === "validate_firebase_transient_publication") return ++validations === 1;
      if (name === "ack_firebase_transient_publication") return true;
      throw new Error("unexpected_rpc");
    },
  });
  assert.equal(database.values.has(path), false);

  database.values.set(path, occurredAt + 1000);
  await synchronizeTransientPublications({
    database, config: {}, workerId: worker, now: () => occurredAt + 100,
    rpc: async (_, name) => name === "claim_firebase_transient_publications" ?
      [job("typing_stop")] : true,
  });
  assert.equal(database.values.get(path), occurredAt + 1000);
});

test("expired or gated jobs are ACKed without becoming delayed animations", async () => {
  for (const gate of [true, false]) {
    const database = fakeDatabase();
    database.values.set("/v2/a/g/e", gate);
    const result = await synchronizeTransientPublications({
      database, config: {}, workerId: worker, now: () => occurredAt + 5001,
      rpc: async (_, name) => name === "claim_firebase_transient_publications" ?
        [job("character_pulse")] : true,
    });
    assert.deepEqual(result, {claimed: 1, delivered: 1, expired: 1, failed: 0});
    assert.equal(database.values.has(`/v2/l/${room}/c/${actor}`), false);
  }
});
