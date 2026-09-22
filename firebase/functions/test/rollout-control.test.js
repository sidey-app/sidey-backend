"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {configureRealtimeRollout, expectedState} = require("../lib/rollout-control");
const productionConfig = {
  url: "https://whtejsviizgejauasqqt.supabase.co",
  serviceRoleKey: "sb_secret_test_only_not_a_real_key",
};

function fakeDatabase(events, initial = false) {
  let value = initial;
  return {
    ref() {
      return {
        async set(next) {
          events.push(`firebase:${next}`);
          value = next;
        },
        async get() {
          events.push("firebase:read");
          return {val: () => value};
        },
      };
    },
  };
}

function fakeRpc(events, expected) {
  return async (_config, name) => {
    events.push(`supabase:${name}`);
    return {...expected};
  };
}

test("disable writes and reads Firebase kill before Supabase OFF", async () => {
  const events = [];
  const expected = expectedState(false, 0);
  await configureRealtimeRollout({
    database: fakeDatabase(events, true),
    config: productionConfig,
    enabled: false,
    rpc: fakeRpc(events, expected),
  });
  assert.deepEqual(events, [
    "firebase:false",
    "firebase:read",
    "supabase:configure_firebase_client_rollout_v2",
    "supabase:firebase_client_rollout_state_v2",
  ]);
});

test("enable verifies Supabase before setting and reading Firebase true", async () => {
  const events = [];
  const expected = expectedState(true, 250);
  await configureRealtimeRollout({
    database: fakeDatabase(events, false),
    config: productionConfig,
    enabled: true,
    cohortBasisPoints: 250,
    rpc: fakeRpc(events, expected),
  });
  assert.deepEqual(events, [
    "firebase:false",
    "firebase:read",
    "supabase:configure_firebase_client_rollout_v2",
    "supabase:firebase_client_rollout_state_v2",
    "firebase:true",
    "firebase:read",
  ]);
});

test("enable failure forces a stale true Firebase gate OFF first", async () => {
  const events = [];
  await assert.rejects(configureRealtimeRollout({
    database: fakeDatabase(events, true),
    config: productionConfig,
    enabled: true,
    cohortBasisPoints: 100,
    rpc: async () => {
      events.push("supabase:failed");
      throw new Error("unavailable");
    },
  }));
  assert.deepEqual(events, ["firebase:false", "firebase:read", "supabase:failed"]);
});

test("wrong Supabase target aborts before any Firebase or RPC mutation", async () => {
  const events = [];
  await assert.rejects(configureRealtimeRollout({
    database: fakeDatabase(events, true),
    config: {...productionConfig, url: "https://staging-example.supabase.co"},
    enabled: true,
    cohortBasisPoints: 100,
    rpc: async () => {
      events.push("supabase:unexpected");
    },
  }), /production_supabase_target_mismatch/);
  assert.deepEqual(events, []);
});
