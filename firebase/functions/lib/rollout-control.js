"use strict";

const {GLOBAL_GATE_PATH} = require("./global-gate");
const {
  ROLLOUT_CONTRACT_HASH,
  ROLLOUT_PROTOCOL_VERSION,
  accessRpc,
} = require("./supabase");

const MAX_COHORT_BASIS_POINTS = 10_000;
const ROLLOUT_CACHE_TTL_SECONDS = 300;
const PRODUCTION_SUPABASE_REF = "whtejsviizgejauasqqt";
const PRODUCTION_SUPABASE_URL = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;

function assertProductionSupabaseConfig(config) {
  if (!config || typeof config !== "object" ||
      config.url?.replace(/\/$/, "") !== PRODUCTION_SUPABASE_URL ||
      typeof config.serviceRoleKey !== "string" || config.serviceRoleKey.length < 20) {
    throw new Error("production_supabase_target_mismatch");
  }
  const segments = config.serviceRoleKey.split(".");
  if (segments.length === 3) {
    let claims;
    try {
      claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
    } catch {
      throw new Error("production_supabase_target_mismatch");
    }
    if (claims.role !== "service_role" ||
        (claims.ref !== undefined && claims.ref !== PRODUCTION_SUPABASE_REF)) {
      throw new Error("production_supabase_target_mismatch");
    }
  }
}

function expectedState(enabled, cohortBasisPoints) {
  return {
    enabled,
    killSwitch: !enabled,
    cohortBasisPoints: enabled ? cohortBasisPoints : 0,
    protocolVersion: ROLLOUT_PROTOCOL_VERSION,
    contractHash: ROLLOUT_CONTRACT_HASH,
    cacheTtlSeconds: ROLLOUT_CACHE_TTL_SECONDS,
  };
}

function assertExactState(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual) ||
      Object.keys(actual).sort().join(",") !== Object.keys(expected).sort().join(",") ||
      Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
    throw new Error("rollout_state_readback_mismatch");
  }
  return actual;
}

async function setGlobalGate(database, enabled) {
  const reference = database.ref(GLOBAL_GATE_PATH);
  await reference.set(enabled);
  const readback = (await reference.get()).val();
  if (readback !== enabled) throw new Error("firebase_global_gate_readback_mismatch");
}

async function configureRealtimeRollout({
  database,
  config,
  enabled,
  cohortBasisPoints = 0,
  rpc = accessRpc,
}) {
  if (typeof enabled !== "boolean" || !Number.isInteger(cohortBasisPoints) ||
      cohortBasisPoints < 0 || cohortBasisPoints > MAX_COHORT_BASIS_POINTS ||
      (enabled && cohortBasisPoints < 1) || (!enabled && cohortBasisPoints !== 0)) {
    throw new Error("invalid_rollout_configuration");
  }
  // Prove the Supabase half targets the same production environment as the
  // pinned Firebase project before the first Firebase or SQL mutation.
  assertProductionSupabaseConfig(config);
  const expected = expectedState(enabled, cohortBasisPoints);

  // Both directions begin by proving Firebase OFF. For disable this revokes
  // immediately; for enable it prevents a stale/unknown true gate from staying
  // open if the following Supabase mutation or read-back fails.
  await setGlobalGate(database, false);

  const mutation = await rpc(config, "configure_firebase_client_rollout_v2", {
    p_enabled: enabled,
    p_kill_switch: !enabled,
    p_cohort_basis_points: enabled ? cohortBasisPoints : 0,
  });
  assertExactState(mutation, expected);
  const readback = await rpc(config, "firebase_client_rollout_state_v2", {});
  assertExactState(readback, expected);

  // Enable publishes Firebase true only after Supabase exact read-back. A
  // failure before this write leaves the global Firebase gate OFF.
  if (enabled) await setGlobalGate(database, true);
  return expected;
}

module.exports = {
  MAX_COHORT_BASIS_POINTS,
  PRODUCTION_SUPABASE_REF,
  PRODUCTION_SUPABASE_URL,
  ROLLOUT_CACHE_TTL_SECONDS,
  assertExactState,
  assertProductionSupabaseConfig,
  configureRealtimeRollout,
  expectedState,
  setGlobalGate,
};
