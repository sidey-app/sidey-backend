"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const migrationName = "20260922192118_firebase_transient_bridge.sql";
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations", migrationName), "utf8",
);
const productionMigration = fs.readFileSync(
  path.join(root, "supabase/production-migrations", migrationName), "utf8",
);
const fixtureBytes = fs.readFileSync(path.join(root, "firebase/contract-v2.fixture.json"));
const fixtureHash = crypto.createHash("sha256").update(fixtureBytes).digest("hex");

test("forward migration is byte-identical and refuses an enabled old rollout", () => {
  assert.equal(migration, productionMigration);
  const precondition = migration.indexOf("disable_old_firebase_rollout_before_transient_bridge_migration");
  const hashUpdate = migration.indexOf("set contract_hash =");
  assert.ok(precondition > 0 && precondition < hashUpdate);
  assert.match(migration, /not rollout\.enabled[\s\S]*rollout\.kill_switch[\s\S]*cohort_basis_points = 0/);
  assert.match(migration, new RegExp(`set contract_hash = '${fixtureHash}'`));
});

test("bridge migration keeps auth fences, loop isolation and bounded retention", () => {
  assert.doesNotMatch(migration, /create\s+(?:table|function|trigger)\s+realtime\./i);
  assert.match(migration, /create or replace function public\.broadcast_character_throw[\s\S]*auth\.sessions[\s\S]*sessions\.not_after/);
  assert.match(migration, /create function public\.bridge_firebase_transient_to_legacy[\s\S]*auth\.sessions[\s\S]*private\.is_room_member[\s\S]*throwable_entitlement_required/);
  assert.match(migration, /Firebase-origin calls use their service-only RPC below and therefore[\s\S]*never re-enter this router/);
  assert.match(migration, /create function private\.delete_expired_firebase_transient_publications\(\)/);
  assert.match(migration, /sidey-delete-firebase-transient-publications/);
  assert.match(migration, /create function private\.delete_expired_firebase_transient_bridge_events\(\)/);
  assert.match(migration, /sidey-delete-firebase-transient-bridge-events/);
});
