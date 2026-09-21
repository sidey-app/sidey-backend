"use strict";

// Real embedded PostgreSQL execution with a minimal fixture. This complements,
// but does not replace, the full Supabase reset + pgTAP Database CI.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {PGlite} = require("@electric-sql/pglite");
const uid = "10000000-0000-4000-8000-000000000001";
const room = "20000000-0000-4000-8000-000000000001";
const sid = "30000000-0000-4000-8000-000000000001";
let db;
const scalar = async (sql, params = []) => (await db.query(sql, params)).rows[0].value;
const snapshot = () => scalar("select public.firebase_access_snapshot($1) as value", [uid]);
const ack = async () => {
  const state = await snapshot();
  await db.query("select public.firebase_access_ack($1, $2)", [uid, state.revision]);
  return state;
};

test.before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema private; create schema auth;
    create table auth.users(id uuid primary key, banned_until timestamptz);
    create table auth.sessions(id uuid primary key, user_id uuid, not_after timestamptz, updated_at timestamptz);
    create table public.profiles(id uuid primary key, equipped_throwable_id text);
    create table public.room_members(room_id uuid, user_id uuid);
    create table public.commerce_products(id text primary key, product_kind text,
      catalog_item_id text, active boolean, entitlement_key text);
    create table public.commerce_entitlements(user_id uuid, entitlement_key text, status text);
  `);
  const migrations = path.resolve(__dirname, "../../../supabase/migrations");
  const existing = fs.readFileSync(path.join(migrations, "20260919135013_firebase_chat_bridge.sql"), "utf8");
  await db.exec(existing.slice(existing.indexOf("create or replace function public.firebase_realtime_access"))
    .replace(/commit;\s*$/, ""));
  await db.exec(fs.readFileSync(path.join(migrations, "20260919165358_firebase_event_driven_access.sql"), "utf8"));
  await db.exec(fs.readFileSync(path.join(migrations,
    "20260919224714_firebase_access_failure_isolation.sql"), "utf8"));
  await db.exec(fs.readFileSync(path.join(migrations,
    "20260921070944_firebase_access_delivery_snapshot.sql"), "utf8"));
});

test.after(async () => { await db?.close(); });

test.beforeEach(async () => {
  await db.exec(`truncate private.firebase_access_outbox, auth.users, auth.sessions,
    public.profiles, public.room_members, public.commerce_products, public.commerce_entitlements;
    update private.firebase_access_dispatch set wake_url = null, last_reconcile_date = null;`);
  await db.query("insert into auth.users(id) values ($1)", [uid]);
  await db.query("insert into auth.sessions(id,user_id) values ($1,$2)", [sid, uid]);
  await db.query("insert into public.profiles values ($1,'throwable_ball_red')", [uid]);
  await db.query("insert into public.room_members values ($1,$2)", [room, uid]);
  await db.exec("insert into public.commerce_products values ('ball','throwable','throwable_ball_red',true,'ball')");
});

test("only bootstrapped users enter the outbox and clients cannot invoke privileged RPCs", async () => {
  assert.equal(await scalar("select count(*)::int as value from private.firebase_access_outbox"), 0);
  const state = await snapshot();
  assert.deepEqual(state.rooms, [room]);
  assert.equal(state.active, true);
  assert.ok(state.sessions[sid] > Date.now());
  for (const name of ["firebase_access_snapshot(uuid)", "firebase_access_delivery_snapshot(uuid)",
    "firebase_access_pending(integer)",
    "firebase_access_ack(uuid,text)", "firebase_access_status()", "firebase_access_reconcile()"]) {
    assert.equal(await scalar("select has_function_privilege('authenticated',$1,'execute') as value", [name]), false);
    assert.equal(await scalar("select has_function_privilege('anon',$1,'execute') as value", [name]), false);
    assert.equal(await scalar("select has_function_privilege('service_role',$1,'execute') as value", [name]), true);
  }
});

test("delivery snapshot never recreates a finalized access row", async () => {
  await snapshot();
  await db.query("delete from private.firebase_access_outbox where user_id=$1", [uid]);
  assert.equal(await scalar(
    "select public.firebase_access_delivery_snapshot($1) is null as value", [uid],
  ), true);
  assert.equal(await scalar(
    "select count(*)::int as value from private.firebase_access_outbox where user_id=$1", [uid],
  ), 0);
});

test("purchase grants and refund revokes ownership, stale ACK cannot erase the refund", async () => {
  await ack();
  await db.query("insert into public.commerce_entitlements values ($1,'ball','active')", [uid]);
  const purchase = await snapshot();
  assert.deepEqual(purchase.items, ["throwable_ball_red"]);
  await db.query("update public.commerce_entitlements set status = 'refunded' where user_id = $1", [uid]);
  const refund = await snapshot();
  assert.deepEqual(refund.items, []);
  assert.ok(refund.revision > purchase.revision);
  await db.query("select public.firebase_access_ack($1,$2)", [uid, purchase.revision]);
  const pending = (await db.query("select * from public.firebase_access_pending(100)")).rows;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].user_id, uid);
  assert.equal(pending[0].revision, refund.revision);
  await ack();
  assert.equal((await db.query("select * from public.firebase_access_pending(100)")).rows.length, 0);
});

test("membership changes and equipment changes are captured in the same transaction", async () => {
  const before = await ack();
  await db.exec("begin");
  await db.query("delete from public.room_members where user_id=$1", [uid]);
  assert.deepEqual((await snapshot()).rooms, []);
  await db.exec("rollback");
  assert.deepEqual((await snapshot()).rooms, [room]);
  assert.equal((await snapshot()).revision, before.revision);
  await db.query("delete from public.room_members where user_id=$1", [uid]);
  const kicked = await snapshot();
  assert.deepEqual(kicked.rooms, []);
  assert.ok(kicked.revision > before.revision);
  await db.query("update public.profiles set equipped_throwable_id=null where id=$1", [uid]);
  assert.ok((await snapshot()).revision > kicked.revision);
});

test("session deletion and ban revoke access; ordinary token refresh does not enqueue work", async () => {
  const first = await ack();
  await db.query("update auth.sessions set updated_at=now() where id=$1", [sid]);
  assert.equal((await snapshot()).revision, first.revision);
  await db.query("delete from auth.sessions where id=$1", [sid]);
  assert.deepEqual((await snapshot()).sessions, {});
  await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1", [uid]);
  const banned = await snapshot();
  assert.equal(banned.active, false);
  assert.deepEqual(banned.rooms, []);
  assert.deepEqual(banned.items, []);
  await db.query("delete from auth.users where id=$1", [uid]);
  assert.ok((await snapshot()).revision > banned.revision);
});

test("catalog disabling revokes an equipped item", async () => {
  await snapshot();
  await db.query("insert into public.commerce_entitlements values ($1,'ball','active')", [uid]);
  assert.deepEqual((await snapshot()).items, ["throwable_ball_red"]);
  const first = await ack();
  await db.exec("update public.commerce_products set active=false where id='ball'");
  const disabled = await snapshot();
  assert.ok(disabled.revision > first.revision);
  assert.deepEqual(disabled.items, []);
  await db.exec("delete from public.commerce_products where id='ball'");
  assert.ok((await snapshot()).revision > disabled.revision);
});

test("daily reconciliation is idempotent and does not hide security backlog age", async () => {
  await ack();
  await db.exec("select public.firebase_access_reconcile()");
  const first = await snapshot();
  assert.equal((await scalar("select public.firebase_access_status() as value")).oldest_pending_at, null);
  assert.equal((await db.query("select * from public.firebase_access_pending(100)")).rows.length, 1);
  await db.exec("select public.firebase_access_reconcile()");
  assert.equal((await snapshot()).revision, first.revision);
  await db.query("delete from public.room_members where user_id=$1", [uid]);
  const pendingSince = (await scalar("select public.firebase_access_status() as value")).oldest_pending_at;
  assert.ok(pendingSince > 0);
  await db.exec("update private.firebase_access_dispatch set last_reconcile_date=null; select public.firebase_access_reconcile()");
  assert.equal((await scalar("select public.firebase_access_status() as value")).oldest_pending_at, pendingSince);
});

test("misconfigured optional wake cannot discard an authoritative change", async () => {
  await ack();
  await db.exec("update private.firebase_access_dispatch set wake_url='https://example.invalid/wake'");
  await db.query("delete from public.room_members where user_id=$1", [uid]);
  assert.deepEqual((await snapshot()).rooms, []);
  assert.equal((await db.query("select * from public.firebase_access_pending(100)")).rows.length, 1);
});
