"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  GLOBAL_GATE_PATH,
  RealtimeGlobalGateError,
  assertRealtimeGlobalEnabled,
} = require("../lib/global-gate");

function database(value, error = null) {
  return {
    ref(path) {
      assert.equal(path, GLOBAL_GATE_PATH);
      return {
        async get() {
          if (error) throw error;
          return {val: () => value};
        },
      };
    },
  };
}

test("global emergency gate accepts only literal true", async () => {
  await assert.doesNotReject(assertRealtimeGlobalEnabled(database(true)));
  for (const value of [false, null, 1, "true", {enabled: true}]) {
    await assert.rejects(
      assertRealtimeGlobalEnabled(database(value)),
      (error) => error instanceof RealtimeGlobalGateError &&
        error.code === "realtime_rollout_disabled",
    );
  }
});

test("global emergency gate fails closed on Firebase read failure", async () => {
  await assert.rejects(
    assertRealtimeGlobalEnabled(database(undefined, new Error("unavailable"))),
    (error) => error instanceof RealtimeGlobalGateError &&
      error.code === "realtime_rollout_disabled",
  );
});
