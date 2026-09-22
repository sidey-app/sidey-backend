"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {PGlite} = require("@electric-sql/pglite");

const uid = "10000000-0000-4000-8000-000000000001";
const room = "20000000-0000-4000-8000-000000000001";
let db;

const status = async () => (await db.query(
  "select public.firebase_delivery_status(array[$1::uuid], $2::uuid) as value",
  [uid, room],
)).rows[0].value;

test.before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema private; create schema auth;
    create table auth.users(id uuid primary key);
    create table public.profiles(id uuid primary key);
    create table public.rooms(id uuid primary key);
    create table public.room_members(room_id uuid, user_id uuid);
    create table public.commerce_entitlements(user_id uuid);
    create table public.messages(id uuid primary key, room_id uuid);
    create table private.firebase_access_outbox (
      user_id uuid primary key, revision bigint not null, pending_since timestamptz,
      reconcile_requested boolean not null default false,
      delivered_revision bigint not null, delivered_at timestamptz
    );
    create table private.firebase_room_revision_outbox (
      room_id uuid primary key, revision bigint not null, pending_since timestamptz,
      delivered_revision bigint not null, delivered_at timestamptz, deleted_at timestamptz,
      claimed_by uuid, claim_until timestamptz
    );
    create table private.firebase_chat_publish_outbox (
      message_id uuid primary key, room_id uuid not null, delivered_at timestamptz
    );
    create table private.firebase_chat_cleanup_outbox (
      message_id uuid primary key, room_id uuid not null, delivered_at timestamptz
    );
    create table private.firebase_chat_sequences (
      room_id uuid primary key, high_water bigint not null
    );
  `);
  const migration = path.resolve(__dirname,
    "../../../supabase/migrations/20260921070000_firebase_delivery_status.sql");
  await db.exec(fs.readFileSync(migration, "utf8"));
});

test.after(async () => { await db?.close(); });

test.beforeEach(async () => {
  await db.exec(`truncate private.firebase_access_outbox,
    private.firebase_room_revision_outbox,
    private.firebase_chat_publish_outbox,
    private.firebase_chat_cleanup_outbox,
    private.firebase_chat_sequences;`);
  await db.query(`insert into private.firebase_access_outbox
    (user_id,revision,delivered_revision) values ($1,2,1)`, [uid]);
  await db.query(`insert into private.firebase_room_revision_outbox
    (room_id,revision,delivered_revision,deleted_at) values ($1,3,2,now())`, [room]);
  await db.query("insert into private.firebase_chat_sequences values ($1,0)", [room]);
});

test("delivery status is service-role only and rejects an unsafe scope", async () => {
  for (const role of ["anon", "authenticated"]) {
    const allowed = (await db.query(
      "select has_function_privilege($1,'public.firebase_delivery_status(uuid[],uuid)','execute') as value",
      [role],
    )).rows[0].value;
    assert.equal(allowed, false);
  }
  assert.equal((await db.query(
    "select has_function_privilege('service_role','public.firebase_delivery_status(uuid[],uuid)','execute') as value",
  )).rows[0].value, true);
  await assert.rejects(db.query(
    "select public.firebase_delivery_status('{}'::uuid[], $1)", [room],
  ), /invalid_delivery_status_scope/);
  await assert.rejects(db.query(
    "select public.firebase_delivery_status(array[$1::uuid,$1::uuid], $2)", [uid, room],
  ), /invalid_delivery_status_scope/);
});

test("delivery status remains false until exact access and room revisions are ACKed", async () => {
  const pending = await status();
  assert.deepEqual(pending, {
    ready: false, expected_users: 1, settled_users: 0, access_pending: 1,
    room_pending: 1,
    chat_publish_pending: 0, chat_cleanup_pending: 0,
  });
  await db.query(`update private.firebase_access_outbox
    set delivered_revision=revision, delivered_at=now() where user_id=$1`, [uid]);
  await db.query(`update private.firebase_room_revision_outbox
    set delivered_revision=revision, delivered_at=now(), pending_since=null,
      claimed_by=null, claim_until=null where room_id=$1`, [room]);
  assert.equal((await status()).ready, true);
});

test("pending chat publication or cleanup keeps delivery status false", async () => {
  await db.query(`update private.firebase_access_outbox
    set delivered_revision=revision, delivered_at=now() where user_id=$1`, [uid]);
  await db.query(`update private.firebase_room_revision_outbox
    set delivered_revision=revision, delivered_at=now() where room_id=$1`, [room]);
  await db.query(`insert into private.firebase_chat_publish_outbox
    values ('30000000-0000-4000-8000-000000000001',$1,null)`, [room]);
  assert.equal((await status()).ready, false);
  await db.exec("update private.firebase_chat_publish_outbox set delivered_at=now()");
  await db.query(`insert into private.firebase_chat_cleanup_outbox
    values ('30000000-0000-4000-8000-000000000001',$1,null)`, [room]);
  assert.equal((await status()).ready, false);
});

test("finalizer requires absent source rows and exact ACKs, then removes durable queue state", async () => {
  await assert.rejects(db.query(
    "select public.firebase_finalize_deleted_delivery(array[$1::uuid],$2)", [uid, room],
  ), /delivery_cleanup_pending/);
  await db.query(`update private.firebase_access_outbox
    set delivered_revision=revision, delivered_at=now() where user_id=$1`, [uid]);
  await db.query(`update private.firebase_room_revision_outbox
    set delivered_revision=revision, delivered_at=now() where room_id=$1`, [room]);
  await db.query("insert into auth.users values ($1)", [uid]);
  await assert.rejects(db.query(
    "select public.firebase_finalize_deleted_delivery(array[$1::uuid],$2)", [uid, room],
  ), /delivery_cleanup_source_exists/);
  await db.query("delete from auth.users where id=$1", [uid]);
  assert.equal((await db.query(
    "select public.firebase_finalize_deleted_delivery(array[$1::uuid],$2) as value",
    [uid, room],
  )).rows[0].value, true);
  assert.equal((await status()).ready, true);
  for (const table of [
    "firebase_access_outbox", "firebase_room_revision_outbox", "firebase_chat_sequences",
  ]) {
    const count = (await db.query(`select count(*)::int as value from private.${table}`)).rows[0].value;
    assert.equal(count, 0);
  }
});
