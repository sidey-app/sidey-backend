import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('../../../../', import.meta.url);
const read = (name: string) => readFile(new URL(`supabase/migrations/${name}.sql`, root), 'utf8');
function table(sql: string, name: string) {
  const start = sql.indexOf(`create table ${name} (`);
  assert.ok(start >= 0, name);
  return sql.slice(start, sql.indexOf('\n);', start) + 3);
}
function fn(sql: string, name: string) {
  const start = sql.indexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, name);
  return sql.slice(start, sql.indexOf('$$;', start) + 3);
}
const user = '68000000-0000-0000-0000-000000000001';

test('App Store money migration runs against the actual entitlement RPC and service-only reports', async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create schema private; create schema extensions;
      create function extensions.gen_random_uuid() returns uuid language sql as $$select gen_random_uuid()$$;
      create function auth.role() returns text language sql as $$select current_setting('test.jwt_role', true)$$;
      select set_config('test.jwt_role', 'service_role', false);
      create table auth.users(id uuid primary key,email text,is_anonymous boolean,created_at timestamptz default now());
      create table profiles(id uuid primary key, nickname text, character_id text, updated_at timestamptz default now());
      create table rooms(id uuid); create table room_members(room_id uuid,user_id uuid);
      insert into auth.users(id,email,is_anonymous) values('${user}','owner@example.com',false);
      insert into profiles values('${user}','수달친구','pixel_hamster',now());`);
    const commerce = await read('20260901010000_starlight_upalupa_commerce');
    for (const name of ['public.commerce_products', 'public.commerce_prices', 'public.commerce_orders', 'public.commerce_entitlements']) {
      await db.exec(table(commerce, name));
    }
    await db.exec(`alter table commerce_entitlements alter column source_order_id drop not null,
      add column grant_kind text, add column grant_reference text;
      alter table commerce_entitlements drop constraint commerce_entitlements_user_id_fkey,
        add foreign key(user_id) references auth.users(id) on delete cascade;`);
    const foundation = await read('20260904000000_app_store_foundation');
    for (const name of ['private.commerce_grants', 'private.app_store_transactions']) await db.exec(table(foundation, name));
    await db.exec(fn(foundation, 'private.refresh_commerce_entitlement'));
    await db.exec(`create table private.app_store_product_offers(store_product_id text primary key,product_id text);
      alter table private.app_store_transactions add column store_product_id text not null;
      insert into commerce_products(id,display_name,product_description,character_id,entitlement_key)
      values('character_test','테스트 동물','테스트','pixel_test','character:pixel_test');
      insert into private.app_store_product_offers values('apple_test_v2','character_test');`);
    await db.exec(fn(await read('20260912000000_character_keepsakes'), 'public.admin_apply_app_store_transaction'));
    const admin = await read('20260903010000_admin_observability');
    await db.exec(table(admin, 'private.download_metric_snapshots'));
    await db.exec(fn(admin, 'private.require_admin_service_role'));
    await db.exec(await read('20260915000000_admin_app_store_revenue'));

    type Options = { status?: string; environment?: string; signed?: string; purchased?: string; uid?: string | null };
    const apply = async (tx: string, price: number | string | null, currency: string | null, options: Options = {}) => {
      const { status = 'active', environment = 'Production', signed = '2026-09-15T00:00:00Z',
        purchased = '2026-09-01T00:00:00Z', uid = user } = options;
      return db.query(`select * from admin_apply_app_store_transaction($1,$2,$2,'apple_test_v2',$1,$3,$4,$5,
        case when $4 = 'active' then null else '2026-09-14'::timestamptz end,$6,repeat('a',64),$7,$8)`,
      [uid, tx, environment, status, purchased, signed, price, currency]);
    };
    const list = async (search = '', status = 'all', env = 'Production', from: string | null = null,
      to: string | null = null, page = 1, pageSize = 25) => (await db.query<any>(
      'select admin_app_store_payments($1,$2,$3,$4,$5,$6,$7) as data',
      [search, status, env, from, to, page, pageSize])).rows[0].data;
    const stored = async (tx: string) => (await db.query<any>(
      'select * from private.app_store_transactions where transaction_id=$1', [tx])).rows[0];

    await t.test('milliunits, currencies, unknown and zero prices stay separate', async () => {
      await apply('krw-paid', 5500000, 'KRW');
      await apply('usd-refund', 1990, 'USD', { status: 'refunded' });
      await apply('usd-active', 999, 'USD');
      await apply('usd-revoked', 2000, 'USD', { status: 'revoked' });
      await apply('unknown-old', null, null);
      await apply('free', 0, 'KRW');
      await apply('sandbox-paid', 999000000, 'KRW', { environment: 'Sandbox' });
      const data = await list();
      assert.equal(data.total, 6);
      assert.deepEqual(data.summary, { transactionCount: 6, unpricedTransactionCount: 1, currencies: [
        { currency: 'KRW', purchaseAmount: 5500, revokedAmount: 0, activeAmount: 5500 },
        { currency: 'USD', purchaseAmount: 4.989, revokedAmount: 3.99, activeAmount: 0.999 },
      ] });
      assert.equal(data.items.filter((item: any) => item.amount === null).length, 1);
      assert.equal(data.items.filter((item: any) => item.amount === 0).length, 1);
      assert.ok(data.items.every((item: any) => /^[a-f0-9]{32}$/.test(item.id)));
      assert.ok(!JSON.stringify(data).includes('krw-paid'));
      const sandbox = await list('', 'all', 'Sandbox');
      assert.equal(sandbox.total, 1);
      assert.equal(sandbox.summary.currencies[0].purchaseAmount, 999000);
      assert.equal((await list('owner@example.com')).total, 6);
      assert.equal((await list('수달친구')).total, 6);
      assert.equal((await list('테스트 동물', 'refunded')).total, 1);
      assert.equal((await list(data.items[0].id)).total, 1);
    });

    await t.test('replay is idempotent, stale payloads cannot overwrite price, and missing price preserves known money', async () => {
      await apply('krw-paid', 5500000, 'KRW');
      assert.equal((await list()).total, 6);
      await apply('krw-paid', 1, 'USD', { signed: '2026-09-14', environment: 'Sandbox' });
      assert.equal((await stored('krw-paid')).price_milliunits, 5500000);
      assert.equal((await stored('krw-paid')).currency, 'KRW');
      assert.equal((await stored('krw-paid')).environment, 'Production');
      await apply('krw-paid', null, null, { signed: '2026-09-16', status: 'refunded' });
      assert.equal((await stored('krw-paid')).price_milliunits, 5500000);
      assert.equal((await stored('krw-paid')).status, 'refunded');
      await apply('krw-paid', 2, 'USD', { signed: '2026-09-15' });
      assert.equal((await stored('krw-paid')).status, 'refunded');
      assert.equal((await stored('krw-paid')).price_milliunits, 5500000);
      // The older 11-argument verifier still works and keeps enriched money.
      await db.query(`select * from admin_apply_app_store_transaction($1,'krw-paid','krw-paid','apple_test_v2',$1,
        'Production','refunded','2026-09-01','2026-09-14','2026-09-17',repeat('a',64))`, [user]);
      assert.equal((await stored('krw-paid')).price_milliunits, 5500000);
      const grants = await db.query<any>("select count(*)::int as count from private.commerce_grants where source_reference='transaction:krw-paid'");
      assert.equal(grants.rows[0].count, 1);
    });

    await t.test('invalid money rolls back the entire transaction', async () => {
      for (const [price, currency] of [[1, null], [null, 'KRW'], [-1, 'USD'], [1, 'usd'],
        [1, 'US'], [1, 'KRW '], ['9007199254740992', 'USD']] as const) {
        await assert.rejects(apply('invalid', price, currency), /invalid_app_store_transaction_price/);
      }
      assert.equal(await stored('invalid'), undefined);
      await apply('large-safe', '9007199254740991', 'USD', { environment: 'Sandbox' });
      assert.equal(String((await stored('large-safe')).price_milliunits), '9007199254740991');
      await assert.rejects(db.exec("update private.app_store_transactions set currency=null where transaction_id='free'"), /money_pair/);
    });

    await t.test('unbound and deleted users remain visible; date filters and out-of-range pages retain accurate totals', async () => {
      await apply('unbound', 500, 'USD', { uid: null, purchased: '2026-09-10' });
      const deleted = '68000000-0000-0000-0000-000000000002';
      await db.query('insert into auth.users(id,email) values($1,$2)', [deleted, 'deleted@example.com']);
      await apply('deleted', 1000, 'USD', { uid: deleted, purchased: '2026-09-11' });
      // Account removal unbinds retained transaction/grant records before deletion.
      await db.query("update private.app_store_transactions set user_id=null,binding_state='unbound' where user_id=$1", [deleted]);
      await db.query("update private.commerce_grants set user_id=null,status='revoked',revoked_at=now() where user_id=$1", [deleted]);
      await db.query('delete from auth.users where id=$1', [deleted]);
      const data = await list('', 'all', 'Production', '2026-09-10', '2026-09-12');
      assert.equal(data.total, 2);
      assert.ok(data.items.every((item: any) => item.userId === null && item.email === null && item.nickname === null));
      assert.equal(data.summary.currencies[0].purchaseAmount, 1.5);
      assert.equal((await list('', 'all', 'Production', '2026-09-10', '2026-09-11')).total, 1);
      const emptyPage = await list('', 'all', 'Production', null, null, 2147483647, 100);
      assert.equal(emptyPage.total, 8);
      assert.deepEqual(emptyPage.items, []);
      assert.equal(emptyPage.summary.transactionCount, 8);
      const pages = [await list('', 'all', 'Production', null, null, 1, 3), await list('', 'all', 'Production', null, null, 2, 3)];
      assert.equal(new Set(pages.flatMap(data => data.items.map((item: any) => item.id))).size, 6);
      const empty = await list('no-such-name');
      assert.deepEqual(empty.summary, { transactionCount: 0, unpricedTransactionCount: 0, currencies: [] });
    });

    await t.test('overview adds Production summary while keeping KST download baseline and legacy keys', async () => {
      await db.exec(`insert into private.download_metric_snapshots(asset_id,asset_name,release_tag,version,channel,download_count,collected_at)
        values(1,'first.dmg','v1','1','direct_dmg',100,now()-interval '2 days'),
              (1,'first.dmg','v1','1','direct_dmg',110,now()),
              (2,'new.dmg','v1','1','direct_dmg',200,now());`);
      const overview = (await db.query<any>('select admin_overview() as data')).rows[0].data;
      assert.equal(overview.downloadsToday, 10);
      assert.equal(overview.downloadsTotal, 310);
      assert.equal(overview.approvedRevenueKrw, 0);
      assert.equal(overview.refundedRevenueKrw, 0);
      assert.equal(overview.netRevenueKrw, 0);
      assert.equal(overview.authUsers, 1);
      assert.deepEqual(overview.appStore, (await list()).summary);
    });

    await t.test('backfill cursor passes unpriced newest rows and equal-time ties without skips', async () => {
      await apply('cursor-newest-a', null, null, { environment: 'Sandbox', purchased: '2026-09-20T00:00:00.123456Z' });
      await apply('cursor-newest-b', null, null, { environment: 'Sandbox', purchased: '2026-09-20T00:00:00.123456Z' });
      await apply('cursor-oldest', null, null, { environment: 'Sandbox', purchased: '2026-09-20T00:00:00.123455Z' });
      const visited: string[] = [];
      let beforeTime: unknown = null;
      let beforeKey: unknown = null;
      for (let page = 0; page < 4; page++) {
        const rows = (await db.query<any>(
          "select *, purchased_at::text as cursor_timestamp from admin_list_app_store_unpriced('Sandbox',1,$1,$2)", [beforeTime, beforeKey])).rows;
        if (page === 3) { assert.equal(rows.length, 0); break; }
        assert.equal(rows.length, 1);
        visited.push(rows[0].transaction_id);
        beforeTime = rows[0].cursor_timestamp;
        assert.match(rows[0].cursor_timestamp, page < 2 ? /\.123456/ : /\.123455/);
        beforeKey = rows[0].cursor_key;
        assert.match(rows[0].cursor_key, /^[0-9a-f]{64}$/);
      }
      assert.equal(new Set(visited).size, 3);
      assert.equal(visited[2], 'cursor-oldest');
      await assert.rejects(db.query("select * from admin_list_app_store_unpriced('Sandbox',1,now(),null)"), /invalid_app_store_price_backfill_query/);
      await db.exec("delete from private.app_store_transactions where transaction_id like 'cursor-%'");
    });

    await t.test('bounded backfill enriches only unknown prices without changing newer entitlement state', async () => {
      await apply('backfill-refund', null, null, { status: 'refunded', signed: '2026-09-17' });
      const before = await stored('backfill-refund');
      const candidates = (await db.query<any>("select * from admin_list_app_store_unpriced('Production',1)")).rows;
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].product_id, 'apple_test_v2');
      const backfill = async (env: string, price: number) => (await db.query<any>(
        "select admin_record_app_store_price('backfill-refund',$1,$2,'USD','2026-09-01') as changed", [env, price])).rows[0].changed;
      assert.equal(await backfill('Sandbox', 1990), false);
      assert.equal(await backfill('Production', 1990), true);
      assert.equal(await backfill('Production', 9990), false);
      const after = await stored('backfill-refund');
      assert.equal(after.price_milliunits, 1990);
      assert.equal(after.status, before.status);
      assert.deepEqual(after.signed_at, before.signed_at);
      assert.deepEqual(after.updated_at, before.updated_at);
      assert.equal((await db.query<any>("select * from admin_list_app_store_unpriced('Sandbox',100)")).rows.length, 0);
      await assert.rejects(db.query("select * from admin_list_app_store_unpriced('Production',101)"), /invalid_app_store_price_backfill_query/);
      await assert.rejects(db.query("select admin_record_app_store_price('unknown-old','Production',1,'usd',now())"), /invalid_app_store_transaction_price/);
    });

    await t.test('invalid filters reject and anon/authenticated cannot execute any revenue RPC', async () => {
      for (const query of [
        "select admin_app_store_payments(p_search=>null)", "select admin_app_store_payments(p_status=>null)",
        "select admin_app_store_payments(p_environment=>'all')", "select admin_app_store_payments(p_page=>0)",
        "select admin_app_store_payments(p_page_size=>101)", "select admin_app_store_payments(p_search=>repeat('a',101))",
        "select admin_app_store_payments(p_from=>'2026-09-02',p_to=>'2026-09-01')",
      ]) await assert.rejects(db.query(query), /invalid_admin_app_store_payments_query/);
      for (const role of ['anon', 'authenticated']) {
        await db.exec(`set role ${role}`);
        for (const query of [
          'select admin_app_store_payments()', 'select admin_overview()', 'select * from admin_list_app_store_unpriced()',
          "select admin_record_app_store_price('x','Production',1,'USD',now())",
          "select * from admin_apply_app_store_transaction(null,'x','x','apple_test_v2',null,'Production','active',now(),null,now(),repeat('a',64),1,'USD')",
        ]) await assert.rejects(db.query(query), /permission denied/);
        await db.exec('reset role');
      }
      await db.exec("select set_config('test.jwt_role','authenticated',false)");
      await assert.rejects(db.query('select admin_app_store_payments()'), /service_role_required/);
      await db.exec("select set_config('test.jwt_role','service_role',false); set role service_role;");
      assert.equal((await list()).total, 9);
      await db.exec('reset role');
    });
  } finally { await db.close(); }
});
