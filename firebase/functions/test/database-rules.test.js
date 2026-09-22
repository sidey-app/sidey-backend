"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const {get, onValue, ref, remove, set, update} = require("firebase/database");

const memberId = "10000000-0000-4000-8000-000000000001";
const outsiderId = "10000000-0000-4000-8000-000000000002";
const targetId = "10000000-0000-4000-8000-000000000003";
const roomId = "20000000-0000-4000-8000-000000000001";
const messageId = "30000000-0000-4000-8000-000000000001";
const sessionA = "50000000-0000-4000-8000-000000000001";
const sessionB = "50000000-0000-4000-8000-000000000002";
let testEnv;

function client(userId, sessionId = sessionA, rolloutUntil = Date.now() + 300_000) {
  return testEnv.authenticatedContext(userId, {
    sideySessionId: sessionId,
    sideyRolloutUntil: rolloutUntil,
  }).database();
}

async function adminSet(targetPath, value) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await set(ref(context.database(), targetPath), value);
  });
}

test.before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "demo-sidey",
    database: {
      host: "127.0.0.1",
      port: 9000,
      rules: fs.readFileSync(path.resolve(__dirname, "../../database.rules.json"), "utf8"),
    },
  });
});

test.after(async () => {
  await testEnv.cleanup();
});

test.beforeEach(async () => {
  await testEnv.clearDatabase();
  const expiresAt = Date.now() + 3_600_000;
  await adminSet("v2/a", {
    g: {e: true},
    s: {v: Date.now() + 120_000},
    u: {
      [memberId]: {
        active: true,
        rooms: {[roomId]: true},
        sessions: {[sessionA]: expiresAt, [sessionB]: expiresAt},
        wire_items: {"7": true},
      },
      [targetId]: {active: true, rooms: {[roomId]: true}},
    },
  });
});

test("Firebase-selected sessions own only their exact typing slot", async () => {
  const dbA = client(memberId, sessionA);
  const dbB = client(memberId, sessionB);
  const aPath = `v2/l/${roomId}/t/${memberId}/${sessionA}`;
  const bPath = `v2/l/${roomId}/t/${memberId}/${sessionB}`;

  await assertSucceeds(set(ref(dbA, aPath), Date.now()));
  await assertSucceeds(set(ref(dbB, bPath), Date.now()));
  await assertFails(set(ref(dbA, bPath), Date.now()));
  await assertFails(set(ref(dbA, `v2/l/${roomId}/t/${memberId}/arbitrary-slot`), Date.now()));
  await assertSucceeds(remove(ref(dbA, aPath)));
  await assertSucceeds(remove(ref(dbB, bPath)));
});

test("members write bounded pulse and entitled compact throw slots", async () => {
  const db = client(memberId);
  await assertSucceeds(set(ref(db, `v2/l/${roomId}/c/${memberId}`), Date.now()));
  const throwPath = `v2/l/${roomId}/x/${memberId}`;
  const first = Date.now() - 600;
  await assertSucceeds(set(ref(db, throwPath), {u: targetId, k: "7", t: first}));
  await assertFails(set(ref(db, throwPath), {u: targetId, k: "7", t: first + 499}));
  await assertSucceeds(set(ref(db, throwPath), {u: targetId, k: "7", t: first + 500}));
  await assertFails(set(ref(db, throwPath), {u: memberId, k: "7", t: Date.now()}));
  await assertFails(set(ref(db, throwPath), {u: outsiderId, k: "7", t: Date.now()}));
  await assertFails(set(ref(db, throwPath), {u: targetId, k: "8", t: Date.now()}));
  await assertFails(set(ref(db, throwPath), {u: targetId, k: "7", t: Date.now(), admin: true}));
  await assertFails(set(ref(db, `v2/l/${roomId}/x/${targetId}`), {
    u: memberId, k: "7", t: Date.now(),
  }));
});

test("invalid identity, membership, timestamps and unknown live keys fail closed", async () => {
  const db = client(memberId);
  const outsiderDb = client(outsiderId);
  await assertFails(get(ref(outsiderDb, `v2/l/${roomId}`)));
  await assertFails(set(ref(outsiderDb, `v2/l/${roomId}/c/${outsiderId}`), Date.now()));
  await assertFails(set(ref(db, `v2/l/${roomId}/c/${memberId}`), Date.now() - 2_000));
  await assertFails(set(ref(db, `v2/l/${roomId}/t/${memberId}/${sessionA}`), "now"));
  await assertFails(set(ref(db, `v2/l/${roomId}/unknown/${memberId}`), true));
  await assertFails(update(ref(db, `v2/l/${roomId}/c`), {
    [memberId]: Date.now(),
    [targetId]: Date.now(),
  }));
});

test("personal inbox is owner-readable and entirely server-written", async () => {
  await adminSet(`v2/n/${memberId}`, {
    a: "00000000000000000001",
    r: {[roomId]: {v: "00000000000000000002", n: 3}},
  });
  await assertSucceeds(get(ref(client(memberId), `v2/n/${memberId}`)));
  await assertFails(get(ref(client(outsiderId), `v2/n/${memberId}`)));
  await assertFails(set(ref(client(memberId), `v2/n/${memberId}/a`), "00000000000000000003"));
});

test("kick revokes an existing listener and all new live access", async () => {
  const db = client(memberId);
  const livePath = `v2/l/${roomId}`;
  await adminSet(`${livePath}/e`, {i: messageId, n: 1});
  let ready;
  const initial = new Promise((resolve) => { ready = resolve; });
  let cancelled;
  const cancellation = new Promise((resolve) => { cancelled = resolve; });
  let observedAfterKick = false;
  const unsubscribe = onValue(ref(db, livePath), (snapshot) => {
    if (snapshot.val()?.e?.n === 2) observedAfterKick = true;
    ready();
  }, cancelled);
  let timeout;
  try {
    await initial;
    await adminSet(`v2/a/u/${memberId}/rooms/${roomId}`, null);
    await adminSet(`${livePath}/e`, {i: messageId, n: 2});
    const error = await Promise.race([
      cancellation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("listener_not_revoked")), 5_000);
      }),
    ]);
    assert.equal(error.code, "PERMISSION_DENIED");
    assert.equal(observedAfterKick, false);
    await assertFails(get(ref(db, livePath)));
    await assertFails(set(ref(db, `${livePath}/c/${memberId}`), Date.now()));
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }
});

test("emergency global kill immediately revokes existing listeners", async () => {
  const db = client(memberId);
  const livePath = `v2/l/${roomId}`;
  await adminSet(`${livePath}/e`, {i: messageId, n: 1});
  let ready;
  const initial = new Promise((resolve) => { ready = resolve; });
  let cancelled;
  const cancellation = new Promise((resolve) => { cancelled = resolve; });
  let observedAfterKill = false;
  const unsubscribe = onValue(ref(db, livePath), (snapshot) => {
    if (snapshot.val()?.e?.n === 2) observedAfterKill = true;
    ready();
  }, cancelled);
  let timeout;
  try {
    await initial;
    await adminSet("v2/a/g/e", false);
    await adminSet(`${livePath}/e`, {i: messageId, n: 2});
    const error = await Promise.race([
      cancellation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("global_kill_not_immediate")), 5_000);
      }),
    ]);
    assert.equal(error.code, "PERMISSION_DENIED");
    assert.equal(observedAfterKill, false);
    await assertFails(get(ref(db, livePath)));
    await assertFails(get(ref(db, `v2/n/${memberId}`)));
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }
});

test("a client can clean only its exact typing slot after session revocation", async () => {
  const dbA = client(memberId, sessionA);
  const typingPath = `v2/l/${roomId}/t/${memberId}/${sessionA}`;
  await adminSet(typingPath, Date.now());
  await assertSucceeds(remove(ref(dbA, typingPath)));
  await adminSet(typingPath, Date.now());
  await adminSet(`v2/a/u/${memberId}/sessions/${sessionA}`, null);
  await assertFails(set(ref(dbA, typingPath), Date.now() + 1_500));
  await assertSucceeds(remove(ref(dbA, typingPath)));
  await adminSet(typingPath, Date.now());
  await assertFails(remove(ref(client(memberId, sessionB), typingPath)));
});

test("revoking session A leaves session B usable; account suspension revokes both", async () => {
  await adminSet(`v2/a/u/${memberId}/sessions/${sessionA}`, null);
  await assertFails(get(ref(client(memberId, sessionA), `v2/n/${memberId}`)));
  await assertSucceeds(get(ref(client(memberId, sessionB), `v2/n/${memberId}`)));
  await assertSucceeds(set(ref(client(memberId, sessionB), `v2/l/${roomId}/c/${memberId}`), Date.now()));
  await adminSet(`v2/a/u/${memberId}/active`, false);
  await assertFails(get(ref(client(memberId, sessionB), `v2/n/${memberId}`)));
  await assertFails(set(ref(client(memberId, sessionB), `v2/l/${roomId}/c/${memberId}`), Date.now()));
});

test("refund revokes throw entitlement without revoking room reads", async () => {
  const db = client(memberId);
  await adminSet(`v2/a/u/${memberId}/wire_items/7`, null);
  await assertSucceeds(get(ref(db, `v2/l/${roomId}`)));
  await assertFails(set(ref(db, `v2/l/${roomId}/x/${memberId}`), {
    u: targetId, k: "7", t: Date.now(),
  }));
});

test("expired global health and unbound or expired sessions fail closed", async () => {
  const db = client(memberId);
  await adminSet("v2/a/s/v", Date.now() - 1);
  await assertFails(get(ref(db, `v2/l/${roomId}`)));
  await assertFails(get(ref(db, `v2/n/${memberId}`)));
  await assertFails(set(ref(db, `v2/l/${roomId}/c/${memberId}`), Date.now()));

  await adminSet("v2/a/s/v", Date.now() + 120_000);
  await assertFails(get(ref(testEnv.authenticatedContext(memberId).database(), `v2/l/${roomId}`)));
  await assertFails(get(ref(client(memberId, sessionA, Date.now() - 1), `v2/l/${roomId}`)));
  await assertFails(get(ref(client(memberId, sessionA, Date.now() - 1), `v2/n/${memberId}`)));
  await adminSet(`v2/a/u/${memberId}/sessions/${sessionA}`, Date.now() - 1);
  await assertFails(get(ref(client(memberId), `v2/l/${roomId}`)));
});

test("room tombstone blocks stale membership reads and writes", async () => {
  await adminSet(`v2/a/d/${roomId}`, "00000000000000000009");
  const db = client(memberId);
  await assertFails(get(ref(db, `v2/l/${roomId}`)));
  await assertFails(set(ref(db, `v2/l/${roomId}/t/${memberId}/${sessionA}`), Date.now()));
  await assertFails(set(ref(db, `v2/l/${roomId}/c/${memberId}`), Date.now()));
  await assertFails(set(ref(db, `v2/l/${roomId}/x/${memberId}`), {
    u: targetId, k: "7", t: Date.now(),
  }));
});

test("server mirror, server event and every legacy namespace are client-denied", async () => {
  const db = client(memberId);
  await assertFails(get(ref(db, `v2/a/u/${memberId}`)));
  await assertFails(set(ref(db, `v2/a/u/${memberId}`), {active: true}));
  await assertFails(set(ref(db, `v2/l/${roomId}/e`), {i: messageId, n: 1}));
  for (const legacyPath of [
    `v2/access/users/${memberId}`,
    `v2/internal/bootstrap_limits/${memberId}`,
    `v2/rooms/${roomId}/presence/${memberId}`,
    `v2/chat/commands/${roomId}/${memberId}`,
    `v2/r/${roomId}`,
  ]) {
    await assertFails(get(ref(db, legacyPath)));
    await assertFails(set(ref(db, legacyPath), {legacy: true}));
  }
});
