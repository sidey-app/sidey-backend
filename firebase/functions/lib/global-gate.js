"use strict";

const GLOBAL_GATE_PATH = "/v2/a/g/e";

class RealtimeGlobalGateError extends Error {
  constructor(code = "realtime_rollout_disabled") {
    super(code);
    this.name = "RealtimeGlobalGateError";
    this.code = code;
  }
}

async function assertRealtimeGlobalEnabled(database) {
  let snapshot;
  try {
    snapshot = await database.ref(GLOBAL_GATE_PATH).get();
  } catch {
    // An unreadable emergency gate is indistinguishable from OFF. This is the
    // server-side fail-closed boundary, not a cached cohort decision.
    throw new RealtimeGlobalGateError();
  }
  if (snapshot.val() !== true) throw new RealtimeGlobalGateError();
}

module.exports = {
  GLOBAL_GATE_PATH,
  RealtimeGlobalGateError,
  assertRealtimeGlobalEnabled,
};
