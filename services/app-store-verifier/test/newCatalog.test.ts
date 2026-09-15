import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

// Execute the actual migration against a minimal PostgreSQL fixture. These
// checks complement, rather than replace, the Supabase RLS/ledger pgTAP suite.
test("new catalog preserves sales lock and enforces paid character ownership", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql as
        $$ select nullif(current_setting('test.user_id', true), '')::uuid $$;
      create table public.profiles (
        id uuid primary key, nickname text, character_id text,
        updated_at timestamptz default now()
      );
      create table public.commerce_products (
        id text primary key, display_name text, product_description text,
        character_id text, entitlement_key text, product_kind text,
        catalog_item_id text, sort_order integer, active boolean,
        updated_at timestamptz default now()
      );
      create table public.commerce_prices (
        product_id text references public.commerce_products(id),
        amount_krw integer, currency text, tax_inclusive boolean, active boolean
      );
      create table public.commerce_entitlements (
        user_id uuid, entitlement_key text, status text
      );
      create table public.commerce_settings (sales_enabled boolean);
      insert into public.commerce_settings values (false);
      select set_config('test.user_id', '61000000-0000-0000-0000-000000000001', false);
    `);
    const migration = await readFile(
      new URL("../../../../supabase/migrations/20260911000000_otter_pig_tree_catalog.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);
    await db.exec(migration);
    assert.equal((await db.query("select * from commerce_products")).rows.length, 7);
    assert.equal((await db.query("select * from commerce_prices")).rows.length, 7);
    assert.deepEqual((await db.query("select sales_enabled from commerce_settings")).rows,
      [{ sales_enabled: false }]);
    assert.deepEqual((await db.query(`select amount_krw, count(*)::int as count
      from commerce_prices group by amount_krw order by amount_krw`)).rows,
      [{ amount_krw: 990, count: 4 }, { amount_krw: 1900, count: 3 }]);
    assert.equal((await db.query("select * from commerce_entitlements")).rows.length, 0);

    for (const id of ["pixel_otter", "pixel_pig", "pixel_tree"]) {
      await assert.rejects(db.query("select upsert_profile('친구', $1)", [id]),
        /character_ownership_required/);
      await db.query(`insert into commerce_entitlements values
        ('61000000-0000-0000-0000-000000000001', $1, 'active')`, [`character:${id}`]);
      await db.query("select upsert_profile('친구', $1)", [id]);
      await db.query("update commerce_entitlements set status='refunded' where entitlement_key=$1",
        [`character:${id}`]);
      await assert.rejects(db.query("select upsert_profile('친구', $1)", [id]),
        /character_ownership_required/);
      await db.query("update commerce_products set active=false where character_id=$1", [id]);
      await assert.rejects(db.query("select upsert_profile('친구', $1)", [id]),
        /character_ownership_required/);
    }
    await db.query("select upsert_profile('친구', 'pixel_hamster')");
    await assert.rejects(db.query("select upsert_profile('친구', 'pixel_unknown')"), /invalid_character_id/);
    await assert.rejects(db.query("select upsert_profile('친구', null)"), /invalid_character_id/);
    await db.exec("select set_config('test.user_id', '', false)");
    await assert.rejects(db.query("select upsert_profile('친구', 'pixel_hamster')"), /authentication_required/);
  } finally {
    await db.close();
  }
});
