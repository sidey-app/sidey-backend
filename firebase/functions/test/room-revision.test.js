"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyRoomRevision,
  parseRoomRevisionJob,
  synchronizeRoomRevisions,
} = require("../lib/room-revision");

const room = "20000000-0000-4000-8000-000000000001";
const room2 = "20000000-0000-4000-8000-000000000002";
const worker = "30000000-0000-4000-8000-000000000001";
const rev = (value) => String(value).padStart(20, "0");
const user = "10000000-0000-4000-8000-000000000001";
const user2 = "10000000-0000-4000-8000-000000000002";
const user3 = "10000000-0000-4000-8000-000000000003";
const user4 = "10000000-0000-4000-8000-000000000004";
const job = (value, deleted = false, roomId = room, recipients = [user]) => ({
  room_id: roomId, revision: rev(value), deleted, recipients,
});

function fakeDatabase() {
  const values = new Map();
  const normalize = (path) => path.replace(/\/+$/, "") || "/";
  const removeTree = (path) => {
    const root = normalize(path);
    for (const key of [...values.keys()]) {
      if (key === root || key.startsWith(`${root}/`)) values.delete(key);
    }
  };
  const reference = (path) => ({
    child: (name) => reference(`${normalize(path)}/${name}`),
    get: async () => ({val: () => values.has(normalize(path)) ? values.get(normalize(path)) : null}),
    remove: async () => removeTree(path),
    transaction: async (mutate) => {
      const key = normalize(path);
      const next = mutate(values.has(key) ? values.get(key) : null);
      if (next === null) removeTree(key);
      else if (next !== undefined) values.set(key, structuredClone(next));
      return {committed: next !== undefined, snapshot: {val: () => values.get(key)}};
    },
    update: async (updates) => {
      for (const [relativePath, value] of Object.entries(updates)) {
        const absolutePath = `/${relativePath}`;
        if (value === null) removeTree(absolutePath);
        else values.set(absolutePath, structuredClone(value));
      }
    },
  });
  return {values, ref: reference};
}

test("room revision jobs require fixed-width versions and typed tombstones", () => {
  assert.deepEqual(parseRoomRevisionJob(job(7)), {
    roomId: room,
    revision: rev(7),
    deleted: false,
    recipientIds: [user],
  });
  for (const invalid of [
    {...job(1), room_id: "not-a-room"},
    {...job(1), revision: "1"},
    {...job(1), deleted: "false"},
    {...job(1), recipients: [user, user]},
    {...job(1), recipients: ["not-a-user"]},
  ]) assert.throws(() => parseRoomRevisionJob(invalid), /invalid_room_revision_job/);
});

test("normal delivery is monotonic and never replaces a newer remote revision", async () => {
  const database = fakeDatabase();
  await applyRoomRevision(database, job(2));
  assert.equal(database.values.get(`/v2/n/${user}/r/${room}/v`), rev(2));
  await applyRoomRevision(database, job(1));
  assert.equal(database.values.get(`/v2/n/${user}/r/${room}/v`), rev(2));
  await applyRoomRevision(database, job(3, false, room, [user, user2]));
  assert.equal(database.values.get(`/v2/n/${user}/r/${room}/v`), rev(3));
  assert.equal(database.values.get(`/v2/n/${user2}/r/${room}/v`), rev(3));
});

test("malformed remote revision fails closed and remains available for retry", async () => {
  const database = fakeDatabase();
  database.values.set(`/v2/n/${user}/r/${room}/v`, 2);
  await assert.rejects(applyRoomRevision(database, job(3)), /invalid_room_revision_remote/);
  assert.equal(database.values.get(`/v2/n/${user}/r/${room}/v`), 2);
});

test("tombstone delivery deletes the whole room root idempotently", async () => {
  const database = fakeDatabase();
  database.values.set(`/v2/l/${room}/e`, {i: "message"});
  database.values.set(`/v2/n/${user}/r/${room}/v`, rev(4));
  const first = await applyRoomRevision(database, job(5, true, room, [user]));
  assert.equal(first.deletionConfirmed, false);
  assert.equal(database.values.get(`/v2/a/d/${room}`), rev(5));
  assert.equal([...database.values.keys()].some((key) => key.startsWith(`/v2/l/${room}`)), false);
  assert.equal([...database.values.keys()].some((key) => key.startsWith(`/v2/n/${user}/r/${room}`)), false);
  const second = await applyRoomRevision(database, job(5, true, room, [user]));
  assert.equal(second.deletionConfirmed, true);
});

test("a room tombstone permanently suppresses delayed non-delete revisions", async () => {
  const database = fakeDatabase();
  await applyRoomRevision(database, job(7, true, room, [user]));
  await applyRoomRevision(database, job(6, false, room, [user]));
  await applyRoomRevision(database, job(8, false, room, [user]));
  assert.equal(database.values.get(`/v2/a/d/${room}`), rev(7));
  assert.equal(database.values.has(`/v2/n/${user}/r/${room}/v`), false);
  assert.equal([...database.values.keys()].some((key) => key.startsWith(`/v2/l/${room}`)), false);
});

test("worker ACKs an ordinary exact applied revision", async () => {
  const database = fakeDatabase();
  const calls = [];
  const result = await synchronizeRoomRevisions({
    database,
    config: {},
    workerId: worker,
    rpc: async (_, name, args) => {
      calls.push([name, args]);
      if (name === "claim_firebase_room_revisions") return [job(8)];
      if (name === "filter_firebase_room_revision_recipients") return args.p_recipients;
      if (name === "ack_firebase_room_revision") return true;
      throw new Error("unexpected_rpc");
    },
  });
  assert.deepEqual(result, {claimed: 1, delivered: 1, deleted: 0, deferred: 0, failed: 0});
  assert.deepEqual(calls.filter(([name]) => name === "ack_firebase_room_revision")
    .map(([, args]) => args).sort((left, right) => left.p_revision.localeCompare(right.p_revision)), [
    {p_worker: worker, p_room_id: room, p_revision: rev(8), p_deleted: false},
  ]);
});

test("deletion waits for a later claim, repeats cleanup, then ACKs", async () => {
  const database = fakeDatabase();
  const calls = [];
  const rpc = async (_, name, args) => {
    calls.push([name, args]);
    if (name === "claim_firebase_room_revisions") return [job(9, true, room2)];
    if (name === "ack_firebase_room_revision") return true;
    throw new Error("unexpected_rpc");
  };

  const first = await synchronizeRoomRevisions({database, config: {}, workerId: worker, rpc});
  assert.deepEqual(first, {claimed: 1, delivered: 0, deleted: 0, deferred: 1, failed: 0});
  assert.equal(calls.some(([name]) => name === "ack_firebase_room_revision"), false);

  // Simulate a chat write landing after the first deletion cleanup, including
  // the ambiguous case where its worker exits before its own final fence.
  database.values.set(`/v2/l/${room2}/e`, {i: "late", n: 7});
  database.values.set(`/v2/n/${user}/r/${room2}/n`, 7);
  const second = await synchronizeRoomRevisions({database, config: {}, workerId: worker, rpc});
  assert.deepEqual(second, {claimed: 1, delivered: 1, deleted: 1, deferred: 0, failed: 0});
  assert.equal(database.values.has(`/v2/l/${room2}/e`), false);
  assert.equal(database.values.has(`/v2/n/${user}/r/${room2}/n`), false);
  assert.equal(calls.filter(([name]) => name === "ack_firebase_room_revision").length, 1);
});

test("lost exact ACK and remote failures remain pending", async () => {
  const database = fakeDatabase();
  database.values.set(`/v2/n/${user}/r/${room}/v`, 1);
  database.values.set(`/v2/a/d/${room2}`, rev(11));
  const result = await synchronizeRoomRevisions({
    database,
    config: {},
    workerId: worker,
    rpc: async (_, name) => {
      if (name === "claim_firebase_room_revisions") return [job(10), job(11, true, room2)];
      if (name === "filter_firebase_room_revision_recipients") return [user];
      if (name === "ack_firebase_room_revision") return false;
      throw new Error("unexpected_rpc");
    },
  });
  assert.deepEqual(result, {claimed: 2, delivered: 0, deleted: 0, deferred: 0, failed: 2});
});

test("publish-time membership fence removes a recipient kicked after claim", async () => {
  const database = fakeDatabase();
  const claimed = job(12, false, room, [user, user2, user3]);
  let filterCalls = 0;
  const result = await synchronizeRoomRevisions({
    database,
    config: {},
    workerId: worker,
    rpc: async (_, name, args) => {
      if (name === "claim_firebase_room_revisions") return [claimed];
      if (name === "filter_firebase_room_revision_recipients") {
        filterCalls++;
        assert.deepEqual(args.p_recipients, [user, user2, user3]);
        // C is kicked while the Firebase write is in flight. D joined after
        // claim, but cannot be added because the claimed set is the upper bound.
        return filterCalls === 1 ? [user, user2, user3] : [user, user2];
      }
      if (name === "ack_firebase_room_revision") return true;
      throw new Error("unexpected_rpc");
    },
  });

  assert.deepEqual(result, {claimed: 1, delivered: 1, deleted: 0, deferred: 0, failed: 0});
  assert.equal(database.values.get(`/v2/n/${user}/r/${room}/v`), rev(12));
  assert.equal(database.values.get(`/v2/n/${user2}/r/${room}/v`), rev(12));
  assert.equal(database.values.has(`/v2/n/${user3}/r/${room}/v`), false);
  assert.equal(database.values.has(`/v2/n/${user4}/r/${room}/v`), false);
});

test("membership filter cannot add a user outside the claim-time upper bound", async () => {
  const database = fakeDatabase();
  const result = await synchronizeRoomRevisions({
    database,
    config: {},
    workerId: worker,
    rpc: async (_, name) => {
      if (name === "claim_firebase_room_revisions") return [job(13, false, room, [user])];
      if (name === "filter_firebase_room_revision_recipients") return [user, user4];
      throw new Error("unexpected_rpc");
    },
  });
  assert.deepEqual(result, {claimed: 1, delivered: 0, deleted: 0, deferred: 0, failed: 1});
  assert.equal(database.values.has(`/v2/n/${user4}/r/${room}/v`), false);
});
