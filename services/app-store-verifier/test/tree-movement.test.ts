import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

test("tree RPC executes migration, serializes revisions and preserves profile write boundary", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      grant usage on schema auth to authenticated;
      create function auth.uid() returns uuid language sql as
        $$select nullif(current_setting('test.user_id', true), '')::uuid$$;
      create table public.profiles (
        id uuid primary key, nickname text, character_id text,
        updated_at timestamptz default now()
      );
      grant select on public.profiles to authenticated;
      insert into public.profiles (id,nickname,character_id) values
        ('81000000-0000-0000-0000-000000000001','나무','pixel_tree');
    `);
    await db.exec(await readFile(new URL(
      "../../../../supabase/migrations/20260915100000_tree_movement_profile_state.sql",
      import.meta.url), "utf8"));
    await assert.rejects(db.query("select * from set_tree_movement_paused(true,0)"), /authentication_required/);
    await db.exec(`set role authenticated;
      select set_config('test.user_id','81000000-0000-0000-0000-000000000001',false);`);
    const setState = async (paused: boolean, expected: number) => {
      const result = await db.query(
        "select tree_movement_paused as paused, tree_movement_revision::int as revision from set_tree_movement_paused($1,$2)",
        [paused,expected]);
      assert.equal(result.rows.length, 1, "RPC returns exactly one profile for array decoding");
      return result.rows[0];
    };
    assert.deepEqual(await setState(false,0), {paused:false,revision:1});
    assert.deepEqual(await setState(false,1), {paused:false,revision:1});
    assert.deepEqual(await setState(true,0), {paused:false,revision:1});
    assert.deepEqual(await setState(true,1), {paused:true,revision:2});
    assert.deepEqual(await setState(true,1), {paused:true,revision:2});
    assert.deepEqual(await setState(false,1), {paused:true,revision:2});
    assert.deepEqual(await setState(false,99), {paused:true,revision:2});
    assert.deepEqual(await setState(false,2), {paused:false,revision:3});
    for (const sql of ["select * from set_tree_movement_paused(null,0)",
      "select * from set_tree_movement_paused(true,null)", "select * from set_tree_movement_paused(true,-1)"]) {
      await assert.rejects(db.query(sql), /invalid_tree_movement_state/);
    }
    await assert.rejects(db.query("update profiles set tree_movement_revision=100"), /permission denied/);
    await assert.rejects(db.query("update profiles set tree_movement_paused=true"), /permission denied/);
    await db.exec("select set_config('test.user_id','81000000-0000-0000-0000-000000000002',false)");
    await assert.rejects(db.query("select * from set_tree_movement_paused(true,0)"), /profile_required/);
    await db.exec("reset role; set role anon");
    await assert.rejects(db.query("select * from set_tree_movement_paused(true,0)"), /permission denied/);
  } finally { await db.close(); }
});
