// Explicit opt-in local, disposable PostgreSQL only. Not run by the portable unit glob.
// SIDEY_FIREBASE_TEST_PORT=55439 SIDEY_PG_MODULE=/path/to/pg node this-file
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
const port = Number(process.env.SIDEY_FIREBASE_TEST_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 5432) throw new Error("explicit_disposable_test_port_required");
const { Client } = createRequire(import.meta.url)(process.env.SIDEY_PG_MODULE || "pg");
const connect = async () => {
  const client = new Client({host:"127.0.0.1",port,user:"sidey_test",database:"postgres"});
  await client.connect();
  await client.query("set statement_timeout='5s'; set deadlock_timeout='100ms'");
  return client;
};
const a="72000000-0000-4000-8000-000000000001", b="72000000-0000-4000-8000-000000000002";
const uid="71000000-0000-4000-8000-000000000001", worker="74000000-0000-4000-8000-000000000001";
const admin=await connect(), left=await connect(), right=await connect();
try {
  await admin.query(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema private;
    create function auth.uid() returns uuid language sql as $$select null::uuid$$;
    create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
    create table auth.users(id uuid primary key);
    create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
    create table rooms(id uuid primary key,realtime_epoch bigint not null);
    create table room_members(room_id uuid,user_id uuid);
    create table profiles(id uuid primary key,nickname text);
    create table messages(id uuid primary key,room_id uuid references rooms(id),body text);
    insert into auth.users values('${uid}');
    insert into rooms values('${a}',1),('${b}',1);
    insert into room_members values('${a}','${uid}'),('${b}','${uid}');
    insert into profiles values('${uid}','before');
  `);
  await admin.query(await readFile(new URL("../../supabase/migrations/20260918000000_firebase_shadow_foundation.sql",import.meta.url),"utf8"));
  await admin.query(`insert into private.firebase_shadow_users values('${uid}',true);
    alter table messages enable trigger zz_firebase_messages_shadow;
    alter table profiles enable trigger zz_firebase_profiles_shadow;`);
  const original=(await admin.query("select pg_get_functiondef('private.enqueue_firebase_hint(uuid,text)'::regprocedure) definition")).rows[0].definition;
  // Negative control uses the reviewed bug verbatim, solely in this disposable DB.
  const buggy=original.replace("from public.rooms where id = p_room_id;","from public.rooms where id = p_room_id for update;");
  assert.notEqual(buggy,original);
  const finish=async(client,query)=>{
    try { await client.query(query); await client.query("commit"); return "ok"; }
    catch(error) { await client.query("rollback"); return error.code; }
  };
  const fkRace=async()=>{
    await Promise.all([left.query("begin"),right.query("begin")]);
    // These are the exact compatible parent locks acquired by two child FKs.
    await Promise.all([left.query(`select id from rooms where id='${a}' for key share`),right.query(`select id from rooms where id='${a}' for key share`)]);
    return await Promise.all([finish(left,`insert into messages values(gen_random_uuid(),'${a}','left')`),finish(right,`insert into messages values(gen_random_uuid(),'${a}','right')`)]);
  };
  await admin.query(buggy);
  assert.ok((await fkRace()).includes("40P01"),"negative control must reproduce FK upgrade deadlock");
  await admin.query(original);
  assert.deepEqual(await fkRace(),["ok","ok"]);
  console.log("PASS concurrent same-room FK inserts; old code reproduced 40P01");

  const oppositeRooms=async()=>{
    await admin.query(`insert into messages values(gen_random_uuid(),'${a}','prune'),(gen_random_uuid(),'${b}','prune')`);
    await Promise.all([left.query("begin"),right.query("begin")]);
    // Hold the first lock from each old trigger traversal to make the reversed
    // profile A->B / cleanup B->A ordering deterministic rather than probabilistic.
    await Promise.all([left.query(`select id from rooms where id='${a}' for update`),right.query(`select id from rooms where id='${b}' for update`)]);
    return await Promise.all([finish(left,`update profiles set nickname='after' where id='${uid}'`),
      finish(right,`delete from messages where room_id='${b}'; delete from messages where room_id='${a}'`)]);
  };
  await admin.query(buggy);
  assert.ok((await oppositeRooms()).includes("40P01"),"negative control must reproduce opposite-room deadlock");
  await admin.query(original);
  assert.deepEqual(await oppositeRooms(),["ok","ok"]);
  console.log("PASS profile/prune opposite-room traversal; old code reproduced 40P01");

  await admin.query("truncate private.firebase_hint_outbox restart identity");
  await left.query("begin");
  await left.query(`insert into messages values(gen_random_uuid(),'${a}','late commit')`);
  await right.query(`insert into messages values(gen_random_uuid(),'${a}','early commit')`);
  const newer=(await admin.query("select * from claim_firebase_hints($1,20)",[worker])).rows;
  assert.equal(newer.length,1);
  await left.query("commit");
  const late=(await admin.query("select * from claim_firebase_hints($1,20)",[worker])).rows;
  assert.equal(late.length,1);
  assert.ok(BigInt(late[0].revision)<BigInt(newer[0].revision));
  assert.ok(BigInt(late[0].publication_revision)>BigInt(newer[0].publication_revision));
  console.log("PASS late source commit receives newer wire revision despite smaller outbox ID");
  console.log((await admin.query("select version() as version")).rows[0].version);
} finally {
  await Promise.all([left.end(),right.end(),admin.end()]);
}
