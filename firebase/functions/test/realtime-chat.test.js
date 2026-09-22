"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RealtimeChatError,
  parseRealtimeChatRequest,
  removeExactChatSlot,
  synchronizeRealtimeChat,
} = require("../lib/realtime-chat");

const sender = "10000000-0000-4000-8000-000000000001";
const peer = "10000000-0000-4000-8000-000000000002";
const room = "20000000-0000-4000-8000-000000000001";
const message = "30000000-0000-4000-8000-000000000001";
const session = "40000000-0000-4000-8000-000000000001";
const worker = "50000000-0000-4000-8000-000000000001";

function fakeDatabase() {
  const values = new Map();
  const normalize = (path) => path.replace(/\/+$/, "") || "/";
  const removeTree = (path) => {
    for (const key of [...values.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) values.delete(key);
    }
  };
  return {values, ref: (path = "") => ({
    get: async () => ({val: () => values.has(normalize(path)) ? values.get(normalize(path)) : null}),
    transaction: async (mutate) => {
      const key = normalize(path);
      const next = mutate(values.has(key) ? values.get(key) : null);
      if (next === null) removeTree(key);
      else if (next !== undefined) values.set(key, structuredClone(next));
      return {committed: next !== undefined, snapshot: {val: () => values.get(key)}};
    },
    update: async (updates) => {
      for (const [relativePath, value] of Object.entries(updates)) {
        const key = `/${relativePath}`;
        if (value === null) removeTree(key);
        else values.set(key, structuredClone(value));
      }
    },
  })};
}

const event = (sequence = 7, recipients = [sender, peer]) => ({payload: {
  i: message, r: room, s: sender, b: "안녕하세요", k: "3",
  t: 1789859000000, n: sequence, recipients,
}});

test("callable request uses grapheme count, canonical UUIDs and verified session claim", () => {
  const validAuth = {
    uid: sender.toUpperCase(),
    token: {
      sideySessionId: session.toUpperCase(),
      sideyRolloutUntil: Date.now() + 300_000,
    },
  };
  const parsed = parseRealtimeChatRequest(
    {r: room.toUpperCase(), i: message.toUpperCase(), b: "  👨‍👩‍👧‍👦\u00a0안녕  "},
    validAuth,
  );
  assert.equal(parsed.roomId, room);
  assert.equal(parsed.messageId, message);
  assert.equal(parsed.senderId, sender);
  assert.equal(parsed.sessionId, session);
  assert.equal(parsed.body, "👨‍👩‍👧‍👦\u00a0안녕");

  assert.throws(() => parseRealtimeChatRequest(
    {r: room, i: message, b: "가".repeat(201)},
    validAuth,
  ), (error) => error instanceof RealtimeChatError && error.code === "invalid_message_body");
  assert.throws(() => parseRealtimeChatRequest(
    {r: room, i: message, b: "ok", extra: true},
    validAuth,
  ), /invalid_argument/);

  for (const rolloutUntil of [undefined, Date.now() - 1]) {
    assert.throws(() => parseRealtimeChatRequest(
      {r: room, i: message, b: "ok"},
      {uid: sender, token: {sideySessionId: session, sideyRolloutUntil: rolloutUntil}},
    ), (error) => error instanceof RealtimeChatError &&
      error.code === "authentication_required");
  }
});

test("publisher writes one compact event and removes a recipient kicked during publish", async () => {
  const database = fakeDatabase();
  let filters = 0;
  const calls = [];
  const result = await synchronizeRealtimeChat({
    database, config: {}, workerId: worker,
    rpc: async (_, name, args) => {
      calls.push([name, args]);
      if (name === "claim_firebase_chat_publications") return [event()];
      if (name === "filter_firebase_chat_recipients") {
        filters++;
        return {valid: true, recipients: filters === 1 ? [sender, peer] : [sender]};
      }
      if (name === "ack_firebase_chat_publication") return true;
      if (name === "claim_firebase_chat_cleanups") return [];
      throw new Error("unexpected_rpc");
    },
  });

  assert.deepEqual(result, {claimed: 1, delivered: 1, cleanupClaimed: 0, cleaned: 0, failed: 0});
  assert.deepEqual(database.values.get(`/v2/l/${room}/e`), {
    i: message, s: sender, b: "안녕하세요", k: "3", t: 1789859000000, n: 7,
  });
  assert.equal(database.values.get(`/v2/n/${sender}/r/${room}/n`), 7);
  assert.equal(database.values.has(`/v2/n/${peer}/r/${room}/n`), false);
  assert.equal(calls.filter(([name]) => name === "ack_firebase_chat_publication").length, 1);
});

test("an invalidated claim cleans only its exact slot before ACK", async () => {
  const database = fakeDatabase();
  database.values.set(`/v2/l/${room}/e`, {
    i: message, s: sender, b: "안녕하세요", t: 1789859000000, n: 7,
  });
  database.values.set(`/v2/n/${sender}/r/${room}/n`, 7);
  const result = await synchronizeRealtimeChat({
    database, config: {}, workerId: worker,
    rpc: async (_, name) => {
      if (name === "claim_firebase_chat_publications") return [event(7, [sender])];
      if (name === "filter_firebase_chat_recipients") return {valid: false, recipients: []};
      if (name === "ack_firebase_chat_publication") return true;
      if (name === "claim_firebase_chat_cleanups") return [];
      throw new Error("unexpected_rpc");
    },
  });
  assert.equal(result.delivered, 1);
  assert.equal(database.values.has(`/v2/l/${room}/e`), false);
  assert.equal(database.values.has(`/v2/n/${sender}/r/${room}/n`), false);
});

test("a room tombstone prevents a late chat worker from recreating live or inbox slots", async () => {
  const database = fakeDatabase();
  database.values.set(`/v2/a/d/${room}`, "00000000000000000009");
  const result = await synchronizeRealtimeChat({
    database, config: {}, workerId: worker,
    rpc: async (_, name) => {
      if (name === "claim_firebase_chat_publications") return [event(7, [sender])];
      if (name === "filter_firebase_chat_recipients") {
        return {valid: true, recipients: [sender]};
      }
      if (name === "ack_firebase_chat_publication") return true;
      if (name === "claim_firebase_chat_cleanups") return [];
      throw new Error("unexpected_rpc");
    },
  });
  assert.equal(result.delivered, 1);
  assert.equal(database.values.has(`/v2/l/${room}/e`), false);
  assert.equal(database.values.has(`/v2/n/${sender}/r/${room}/n`), false);
});

test("retention cleanup cannot erase a newer event or inbox marker", async () => {
  const database = fakeDatabase();
  database.values.set(`/v2/l/${room}/e`, {
    i: "30000000-0000-4000-8000-000000000002", n: 8,
  });
  database.values.set(`/v2/n/${sender}/r/${room}/n`, 8);
  await removeExactChatSlot(database, {
    messageId: message, roomId: room, sequence: 7, recipients: [sender],
  });
  assert.equal(database.values.get(`/v2/l/${room}/e`).n, 8);
  assert.equal(database.values.get(`/v2/n/${sender}/r/${room}/n`), 8);
});
