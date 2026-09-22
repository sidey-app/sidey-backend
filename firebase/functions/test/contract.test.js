"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const contract = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../../contract-v2.fixture.json"),
  "utf8",
));
const firebaseConfig = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../../firebase.json"),
  "utf8",
));
const projectConfig = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, "../../.firebaserc"),
  "utf8",
));
const functions = require("../index");

test("machine-readable contract matches the targeted Firebase deployment config", () => {
  assert.equal(contract.protocolVersion, 2);
  assert.equal(contract.projectId, projectConfig.projects.default);
  assert.deepEqual(projectConfig.targets[contract.projectId].database.sidey, [
    contract.databaseInstance,
  ]);
  assert.equal(firebaseConfig.database[0].target, "sidey");
  assert.equal(firebaseConfig.functions[0].codebase, contract.functionsCodebase);
});

test("machine-readable endpoints exist and legacy chat trigger stays absent", () => {
  assert.ok(functions[contract.bootstrap.function].__endpoint);
  assert.ok(functions[contract.chat.function].__endpoint.callableTrigger);
  assert.equal(functions.persistChatCommand, undefined);
  assert.equal(contract.paths.accessRoot, "/v2/a");
  assert.equal(contract.paths.typing.endsWith("/{sideySessionId}"), true);
  assert.equal(contract.limits.activeSessionsMirroredPerUser, 16);
  assert.equal(contract.limits.sourceSessionsValidatedPerUser, 128);
  assert.deepEqual(contract.activeSessionSelection, {
    order: "expiry-desc-then-uuid-asc",
    excludedSessionBehavior: "fail-closed",
  });
  assert.equal(contract.presence, "supabase-private-realtime-only");
  assert.equal(contract.appCheckEnforcement, false);
});

test("production candidate freezes bootstrap, grant, hint and receiver semantics", () => {
  assert.deepEqual(contract.status, {
    firebaseGate1: "deployed-and-verified",
    supabaseStaging: "validated-through-20260921070944",
    supabaseProduction: "not-migrated",
    compatibilityMigration: "local-candidate-20260921102516",
    wireCodeMigration: "local-candidate-20260921110000",
    compatibilityBridgeMigration: "local-candidate-20260921132018",
    clientRelease: "not-ready",
  });
  assert.equal(contract.bootstrap.request.minimumAccessRevision, "20-digit-decimal-string");
  assert.deepEqual(contract.bootstrap.errors[409], [
    "realtime_grant_not_converged",
    "realtime_rollout_disabled",
  ]);
  assert.equal(contract.bootstrap.errors[429], "realtime_bootstrap_rate_limited");
  assert.equal(contract.tokenLifecycle.idTokenRefreshOwner, "Firebase Auth SDK");
  assert.equal(contract.tokenLifecycle.bootstrapPolling, true);
  assert.equal(contract.tokenLifecycle.rolloutLeaseClaim, "sideyRolloutUntil");
  assert.equal(contract.tokenLifecycle.rolloutLeaseMaximumSeconds, 300);
  assert.deepEqual(contract.emergencyKill, {
    path: "/v2/a/g/e",
    enabledValue: true,
    missingOrFalse: "deny-rules-bootstrap-and-chat-callable",
    cohortRemovalMaximumSeconds: 300,
    globalKillPropagation: "immediate-rules-listener-revocation-and-per-request-server-check",
    disableOrder: "firebase-false-readback-then-supabase-off-readback",
    enableOrder: "firebase-false-readback-then-supabase-on-readback-then-firebase-true-readback",
  });
  assert.ok(contract.bootstrap.responseKeys.includes("rolloutLeaseExpiresAt"));
  assert.equal(contract.grantBarrier.convergeOperation, "bootstrapRealtime");
  assert.equal(contract.grantBarrier.supabaseRpcs.createRoom.name, "create_room_v2");
  assert.equal(contract.grantBarrier.supabaseRpcs.joinRoom.name, "join_room_v2");
  assert.equal(
    contract.grantBarrier.supabaseRpcs.equipCosmetic.name,
    "set_equipped_cosmetic_v2",
  );
  assert.equal(contract.grantBarrier.supabaseRpcs.storeState, "get_store_state_v2");
  assert.ok(contract.chat.commitAmbiguousCodes.includes("unavailable"));
  assert.equal(contract.chat.ambiguousRetry.startsWith("never-auto-resend"), true);
  assert.equal(contract.chat.errorMap.realtime_rollout_disabled, "failed-precondition");
  assert.equal(contract.paths.globalEmergencyGate, "/v2/a/g/e");
  assert.equal(
    contract.transientReceiver.compatibilityTransport,
    "supabase-private-broadcast-only",
  );
  assert.equal(contract.transientReceiver.compactFirebasePaths, "reserved-receive-ignored");
  assert.equal(contract.transientReceiver.compactFirebaseClientWrites, false);
  assert.equal(contract.transientReceiver.futureTransitionContract.status, "reserved-not-active");
  assert.equal(
    contract.transientReceiver.futureTransitionContract.initialSnapshot,
    "baseline-only-no-animation",
  );
  assert.equal(contract.transientReceiver.futureTransitionContract.receiverFreshnessMs, 5000);
  assert.equal(contract.payloads.throw.k, "decimal-wire-code-string");
  assert.equal(contract.hints.revisionComparison, "fixed-width-20-digit-lexical");
  assert.equal(
    contract.presenceContract.topic,
    "presence:{roomId}:{realtimeEpoch}:{targetUserId}",
  );
  assert.deepEqual(contract.wireCodes.defaultThrowable, {
    wireCode: 0,
    catalogItemId: "patch_soft_ball",
  });
  assert.equal(
    contract.wireCodes.mappingMigration,
    "20260921110000_firebase_wire_code_contract",
  );
  assert.match(contract.wireCodes.catalogSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    contract.wireCodes.productionMapping,
    "candidate-pinned-pending-M0-read-back",
  );
});
