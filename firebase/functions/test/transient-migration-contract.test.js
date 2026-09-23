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
const wakeMigrationName = "20260922203000_firebase_transient_wake_secret.sql";
const wakeMigration = fs.readFileSync(
  path.join(root, "supabase/migrations", wakeMigrationName), "utf8",
);
const productionWakeMigration = fs.readFileSync(
  path.join(root, "supabase/production-migrations", wakeMigrationName), "utf8",
);
const targetMigrationName = "20260923111453_firebase_throw_room_targets.sql";
const targetMigration = fs.readFileSync(
  path.join(root, "supabase/migrations", targetMigrationName), "utf8",
);
const productionTargetMigration = fs.readFileSync(
  path.join(root, "supabase/production-migrations", targetMigrationName), "utf8",
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

test("transient wake uses a dedicated secret without rotating existing workers", () => {
  assert.equal(wakeMigration, productionWakeMigration);
  assert.match(wakeMigration, /name = 'sidey_transient_wake_token'/);
  assert.doesNotMatch(wakeMigration, /name = 'sidey_access_wake_token'/);
  assert.match(wakeMigration, /create or replace function private\.wake_firebase_transient_publication/);
});

test("hybrid senders mirror legacy room targets and wake before transient expiry", () => {
  assert.equal(targetMigration, productionTargetMigration);
  assert.match(targetMigration, /'room_targets', room_targets/);
  assert.match(targetMigration, /create trigger firebase_access_membership[\s\S]*capture_firebase_room_target_access/);
  assert.match(targetMigration, /update private\.firebase_access_outbox[\s\S]*revision = revision \+ 1/);
  assert.match(targetMigration, /name = 'sidey_transient_wake_token'/);
  assert.match(targetMigration, /timeout_milliseconds := 5000/);
});
