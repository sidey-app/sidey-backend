"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {applyAccessSnapshot, authorizedWake, synchronizeAccess, SYNC_LEASE_MS} = require("../lib/access-sync");
const {parseAccessSnapshot} = require("../lib/supabase");
const uid = "10000000-0000-4000-8000-000000000001";
const room = "20000000-0000-4000-8000-000000000001";
const sid = "30000000-0000-4000-8000-000000000001";
const rev = (v) => String(v).padStart(20, "0");
const wire = (v = 1) => ({user_id: uid, revision: rev(v), active: true,
  rooms: [room], items: ["throwable_ball_red"], wire_items: ["7"],
  sessions: {[sid]: 8640000000000000}});

function fakeDatabase() {
  const values = new Map();
  const removeTree = (path) => {
    for (const key of [...values.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) values.delete(key);
    }
  };
  const database = {values, failNextUpdate: false, ref: (path = "") => ({
    get: async () => ({val: () => values.get(path)}),
    transaction: async (mutate) => {
      const next = mutate(values.get(path));
      if (next !== undefined) values.set(path, structuredClone(next));
      return {committed: next !== undefined, snapshot: {val: () => values.get(path)}};
    },
    update: async (updates) => {
      if (database.failNextUpdate) {
        database.failNextUpdate = false;
        throw new Error("simulated_cleanup_failure");
      }
      for (const [relativePath, value] of Object.entries(updates)) {
        const absolutePath = `/${relativePath}`;
        if (value === null) removeTree(absolutePath);
        else values.set(absolutePath, structuredClone(value));
      }
    },
  })};
  return database;
}

test("refund and kick replace permissions atomically; stale grants cannot resurrect them", async () => {
  const db = fakeDatabase();
  await applyAccessSnapshot(db, parseAccessSnapshot(wire(), uid));
  const revoked = {...wire(3), rooms: [], items: [], wire_items: [], active: false, sessions: {}};
  await applyAccessSnapshot(db, parseAccessSnapshot(revoked, uid));
  await applyAccessSnapshot(db, parseAccessSnapshot(wire(2), uid));
  const current = db.values.get(`/v2/a/u/${uid}`);
  assert.equal(current.revision, rev(3));
  assert.equal(current.active, false);
  assert.deepEqual(current.rooms, {});
  assert.deepEqual(current.items, {});
  assert.deepEqual(current.wire_items, {});
  assert.deepEqual(current.sessions, {});
  assert.equal(db.values.get(`/v2/n/${uid}/a`), rev(3));
});

test("redelivery and daily reconciliation repair equal-version corruption", async () => {
  const db = fakeDatabase();
  db.values.set(`/v2/a/u/${uid}`, {revision: rev(1), items: {unowned: true}});
  await applyAccessSnapshot(db, parseAccessSnapshot(wire(), uid));
  await applyAccessSnapshot(db, parseAccessSnapshot(wire(), uid));
  assert.deepEqual(db.values.get(`/v2/a/u/${uid}`).items, {throwable_ball_red: true});
  assert.deepEqual(db.values.get(`/v2/a/u/${uid}`).wire_items, {"7": true});
});

test("bigint revisions compare without JavaScript precision loss", async () => {
  const db = fakeDatabase();
  const newer = {...wire(), revision: "00009007199254740993", rooms: []};
  const older = {...wire(), revision: "00009007199254740992"};
  await applyAccessSnapshot(db, parseAccessSnapshot(newer, uid));
  await applyAccessSnapshot(db, parseAccessSnapshot(older, uid));
  assert.deepEqual(db.values.get(`/v2/a/u/${uid}`).rooms, {});
});

test("room revocation removes compact transient state in the same worker delivery", async () => {
  const db = fakeDatabase();
  await applyAccessSnapshot(db, parseAccessSnapshot(wire(), uid));
  for (const path of [
    `/v2/l/${room}/t/${uid}/${sid}`,
    `/v2/l/${room}/c/${uid}`,
    `/v2/l/${room}/x/${uid}`,
    `/v2/n/${uid}/r/${room}/v`,
  ]) db.values.set(path, {stale: true});

  await applyAccessSnapshot(db, parseAccessSnapshot({...wire(2), rooms: []}, uid));

  for (const path of [
    `/v2/l/${room}/t/${uid}/${sid}`,
    `/v2/l/${room}/c/${uid}`,
    `/v2/l/${room}/x/${uid}`,
    `/v2/n/${uid}/r/${room}/v`,
  ]) assert.equal(db.values.has(path), false, path);
  assert.equal(db.values.get(`/v2/a/u/${uid}`).cleanup_rooms, undefined);
});

test("failed transient cleanup remains durable and succeeds on equal-revision redelivery", async () => {
  const db = fakeDatabase();
  await applyAccessSnapshot(db, parseAccessSnapshot(wire(), uid));
  const typingPath = `/v2/l/${room}/t/${uid}/${sid}`;
  db.values.set(typingPath, Date.now());
  db.failNextUpdate = true;

  await assert.rejects(
    applyAccessSnapshot(db, parseAccessSnapshot({...wire(2), rooms: []}, uid)),
    /simulated_cleanup_failure/,
  );
  assert.deepEqual(db.values.get(`/v2/a/u/${uid}`).cleanup_rooms, {[room]: true});
  await applyAccessSnapshot(db, parseAccessSnapshot({...wire(2), rooms: []}, uid));
  assert.equal(db.values.has(typingPath), false);
  assert.equal(db.values.get(`/v2/a/u/${uid}`).cleanup_rooms, undefined);
});

test("revoked session typing slots remain durably marked until exact cleanup", async () => {
  const db = fakeDatabase();
  const sid2 = "30000000-0000-4000-8000-000000000002";
  await applyAccessSnapshot(db, parseAccessSnapshot({
    ...wire(), sessions: {[sid]: 8640000000000000, [sid2]: 8640000000000000},
  }, uid));
  const revokedSlot = `/v2/l/${room}/t/${uid}/${sid}`;
  const activeSlot = `/v2/l/${room}/t/${uid}/${sid2}`;
  db.values.set(revokedSlot, Date.now());
  db.values.set(activeSlot, Date.now());
  db.failNextUpdate = true;

  await assert.rejects(
    applyAccessSnapshot(db, parseAccessSnapshot({...wire(2), sessions: {
      [sid2]: 8640000000000000,
    }}, uid)),
    /simulated_cleanup_failure/,
  );
  assert.deepEqual(db.values.get(`/v2/a/u/${uid}`).cleanup_sessions, {
    [sid]: {[room]: true},
  });

  await applyAccessSnapshot(db, parseAccessSnapshot({...wire(2), sessions: {
    [sid2]: 8640000000000000,
  }}, uid));
  assert.equal(db.values.has(revokedSlot), false);
  assert.equal(db.values.has(activeSlot), true);
  assert.equal(db.values.get(`/v2/a/u/${uid}`).cleanup_sessions, undefined);
});

test("a cleanup marker observed at final read-back prevents an unsafe ACK", async () => {
  const db = fakeDatabase();
  await applyAccessSnapshot(db, parseAccessSnapshot(wire(), uid));
  const originalRef = db.ref;
  let accessReads = 0;
  db.ref = (path = "") => {
    const reference = originalRef(path);
    if (path === `/v2/a/u/${uid}`) {
      reference.get = async () => {
        accessReads++;
        return {val: () => ({
          ...db.values.get(path), cleanup_rooms: {[room]: true},
        })};
      };
    }
    return reference;
  };
  await assert.rejects(
    applyAccessSnapshot(db, parseAccessSnapshot({...wire(2), rooms: []}, uid)),
    /access_cleanup_not_converged/,
  );
  assert.equal(accessReads, 1);
});

test("access inbox revision is monotonic and malformed remote state fails closed", async () => {
  const db = fakeDatabase();
  await applyAccessSnapshot(db, parseAccessSnapshot(wire(2), uid));
  await applyAccessSnapshot(db, parseAccessSnapshot(wire(1), uid));
  assert.equal(db.values.get(`/v2/n/${uid}/a`), rev(2));
  db.values.set(`/v2/n/${uid}/a`, 2);
  await assert.rejects(
    applyAccessSnapshot(db, parseAccessSnapshot(wire(3), uid)),
    /invalid_access_inbox_revision/,
  );
});

test("wake endpoint requires the dedicated secret, not a client token", () => {
  const secret = "test-only-secret-".repeat(4);
  assert.equal(authorizedWake(`Bearer ${secret}`, secret), true);
  assert.equal(authorizedWake(`Bearer ${secret}`, `${secret}\n`), true);
  assert.equal(authorizedWake("Bearer other", secret), false);
  assert.equal(authorizedWake(undefined, secret), false);
  assert.equal(authorizedWake("Bearer short", "short"), false);
});

test("successful jobs ACK exact revisions and health uses database observation time", async () => {
  const db = fakeDatabase();
  const calls = [];
  const result = await synchronizeAccess({database: db, config: {}, rpc: async (_, name, args) => {
    calls.push([name, args]);
    if (name === "firebase_access_pending") return [{user_id: uid, revision: rev(1)}];
    if (name === "firebase_access_snapshot") return wire();
    if (name === "firebase_access_status") return {checked_at: 1000, oldest_pending_at: null};
    return null;
  }});
  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.quarantined, 0);
  assert.equal(result.validUntil, 1000 + SYNC_LEASE_MS);
  assert.deepEqual(calls.find(([name]) => name === "firebase_access_ack")[1],
    {p_user_id: uid, p_revision: rev(1)});
});

test("delivery failures remain pending and cannot renew past the oldest missed change", async () => {
  const db = fakeDatabase();
  let acked = false;
  const result = await synchronizeAccess({database: db, config: {}, rpc: async (_, name) => {
    if (name === "firebase_access_pending") return [{user_id: uid, revision: rev(1)}];
    if (name === "firebase_access_snapshot") throw new Error("database unavailable");
    if (name === "firebase_access_ack") acked = true;
    if (name === "firebase_access_status") return {checked_at: 500_000, oldest_pending_at: 1000};
  }});
  assert.equal(acked, false);
  assert.equal(result.failed, 1);
  assert.equal(result.validUntil, 1000 + SYNC_LEASE_MS);
});

test("malformed successful snapshots quarantine only that user and ACK the exact queued revision", async () => {
  const db = fakeDatabase();
  await applyAccessSnapshot(db, parseAccessSnapshot(wire(), uid));
  const calls = [];
  const result = await synchronizeAccess({database: db, config: {}, rpc: async (_, name, args) => {
    calls.push([name, args]);
    if (name === "firebase_access_pending") return [{user_id: uid, revision: rev(2)}];
    if (name === "firebase_access_snapshot") return {...wire(2), rooms: ["unsafe"]};
    if (name === "firebase_access_status") return {checked_at: 1000, oldest_pending_at: null};
    return null;
  }});

  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.quarantined, 1);
  assert.deepEqual(db.values.get(`/v2/a/u/${uid}`), {
    revision: rev(2), active: false, rooms: {}, items: {}, wire_items: {}, sessions: {},
  });
  assert.deepEqual(calls.find(([name]) => name === "firebase_access_ack")[1],
    {p_user_id: uid, p_revision: rev(2)});
});

test("source database outage or malformed health response cannot grant a fresh lease", async () => {
  for (const status of [null, {checked_at: Date.now(), oldest_pending_at: "wrong"}]) {
    const db = fakeDatabase();
    await assert.rejects(synchronizeAccess({database: db, config: {}, rpc: async (_, name) =>
      name === "firebase_access_pending" ? [] : status}));
    assert.equal(db.values.has("/v2/a/s/v"), false);
  }
});

test("snapshot validation bounds source maps and projects 16 sessions by expiry then UUID", () => {
  const sessions = Object.fromEntries(Array.from({length: 17}, (_, index) => [
    `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    1000 + index,
  ]));
  const selected = parseAccessSnapshot({...wire(), sessions}, uid).sessions;
  assert.equal(Object.keys(selected).length, 16);
  assert.equal(Object.hasOwn(selected, "30000000-0000-4000-8000-000000000001"), false);
  assert.equal(selected["30000000-0000-4000-8000-000000000017"], 1016);

  const tooManySessions = Object.fromEntries(Array.from({length: 129}, (_, index) => [
    `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    8640000000000000,
  ]));
  for (const payload of [{...wire(), revision: 1}, {...wire(), sessions: {[sid]: "forever"}},
    {...wire(), active: "true"}, {...wire(), rooms: ["invalid"]},
    {...wire(), sessions: tooManySessions}]) {
    assert.throws(() => parseAccessSnapshot(payload, uid), /supabase_access_mismatch/);
  }
});

test("account suspension also removes the stale bootstrap limiter", async () => {
  const db = fakeDatabase();
  db.values.set(`/v2/a/b/${uid}`, {window_started: 1, attempts: 1});
  await applyAccessSnapshot(db, parseAccessSnapshot(wire(), uid));
  await applyAccessSnapshot(db, parseAccessSnapshot({
    ...wire(2), active: false, rooms: [], items: [], wire_items: [], sessions: {},
  }, uid));
  assert.equal(db.values.has(`/v2/a/b/${uid}`), false);
});
