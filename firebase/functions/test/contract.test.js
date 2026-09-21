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
