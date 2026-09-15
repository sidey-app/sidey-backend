import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { entitlementByProduct } from '../src/catalog.js';
const root = new URL('../../../../', import.meta.url);
const read = (file: string) => readFile(new URL(file, root), 'utf8');
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
test('current catalog has 24 products, 34 Apple offers and seven independent keepsakes', async () => {
  const products = JSON.parse(await read('assets/v1/commerce-catalog.json'));
  assert.equal(products.length, 24);
  assert.equal(products.filter((p: any) => p.related_character_product_id).length, 7);
  const offers = Object.fromEntries(products.flatMap((p: any) =>
    [p.app_store_product_id, ...p.legacy_app_store_product_ids].map(id => [id, p.entitlement])));
  assert.deepEqual(entitlementByProduct, offers);
  const edge = await read('supabase/functions/_shared/commerce-products.ts');
  const allowlist = edge.slice(edge.indexOf('new Set(['),edge.indexOf(']);'));
  const directIDs = [...allowlist.matchAll(/"([a-z0-9_]+)"/g)].map(match => match[1]);
  assert.deepEqual(new Set(directIDs),new Set(products.map((p: any) => p.id)));
});
test('actual commerce SQL preserves legacy sources, restores old offers and isolates item ownership', async () => {
  const db = new PGlite();
  const user = '62000000-0000-0000-0000-000000000001';
  const other = '62000000-0000-0000-0000-000000000002';
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema auth; create schema private; create schema extensions;
      create function extensions.gen_random_uuid() returns uuid language sql as $$select gen_random_uuid()$$;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.user',true),'')::uuid$$;
      create function private.has_google_identity(uuid) returns boolean language sql as $$select true$$;
      create table profiles(id uuid primary key, nickname text, character_id text, equipped_bubble_style_id text,
        equipped_throwable_id text check(equipped_throwable_id ~ '^throwable_[a-z0-9_]{1,60}$'), updated_at timestamptz default now());
      insert into auth.users values('${user}'),('${other}');
      insert into profiles values('${user}','테스트','pixel_monkey',null,null,now()),('${other}','친구','pixel_hamster',null,null,now());
      select set_config('test.user','${user}',false);`);
    const commerce = await read('supabase/migrations/20260901010000_starlight_upalupa_commerce.sql');
    for (const name of ['public.commerce_products', 'public.commerce_prices', 'public.commerce_orders'])
      await db.exec(table(commerce, name));
    await db.exec(table(commerce, 'public.commerce_entitlements'));
    await db.exec(`alter table commerce_entitlements alter column source_order_id drop not null,
      add column grant_kind text, add column grant_reference text;`);
    const cosmetics = await read('supabase/migrations/20260905000000_cosmetics_catalog_and_equipment.sql');
    await db.exec(cosmetics.slice(cosmetics.indexOf('alter table public.commerce_products'), cosmetics.indexOf('insert into public.commerce_products')));
    const foundation = await read('supabase/migrations/20260904000000_app_store_foundation.sql');
    for (const name of ['private.commerce_grants', 'private.app_store_transactions']) await db.exec(table(foundation, name));
    await db.exec(fn(foundation,'private.refresh_commerce_entitlement'));
    await db.exec(fn(cosmetics,'public.set_equipped_cosmetic'));
    await db.exec(fn(cosmetics,'private.owned_equipped_catalog_item'));
    // Capture outbound events locally; run the real broadcast RPC and ownership resolver.
    await db.exec(`create table rooms(id uuid primary key,realtime_epoch bigint);
      create table room_members(room_id uuid,user_id uuid);
      create function private.is_room_member(room uuid,usr uuid) returns boolean language sql as
        $$select exists(select 1 from public.room_members where room_id=room and user_id=usr)$$;
      create function private.room_topic(room uuid,epoch bigint,kind text) returns text language sql as
        $$select room::text || ':' || epoch::text || ':' || kind$$;
      create table private.realtime_event_attempts(user_id uuid,room_id uuid,event_name text,attempted_at timestamptz default now());
      create schema realtime; create table realtime.captured(id serial,payload jsonb,event text,topic text,is_private boolean);
      create function realtime.send(payload jsonb,event text,topic text,is_private boolean) returns void language sql as
        $$insert into realtime.captured(payload,event,topic,is_private) values($1,$2,$3,$4)$$;`);
    await db.exec(fn(cosmetics,'private.reconcile_cosmetic_entitlement'));
    await db.exec(`create trigger reconcile after insert or update or delete on commerce_entitlements
      for each row execute function private.reconcile_cosmetic_entitlement();`);
    // The existing RPC must exist so the new migration exercises its replacement.
    await db.exec('create function get_store_state() returns int language sql as $$select 1$$');
    await db.exec(`insert into commerce_products(id,display_name,product_description,character_id,entitlement_key,product_kind,catalog_item_id,sort_order)
      values('character_monkey','아기 원숭이','기존 상품','pixel_monkey','character:pixel_monkey','character','pixel_monkey',1);
      insert into private.commerce_grants(user_id,entitlement_key,source_kind,source_reference,status)
      values('${user}','character:pixel_monkey','complimentary','existing-gift','active');`);
    await db.exec(await read('supabase/migrations/20260912000000_character_keepsakes.sql'));
    await db.exec(await read('supabase/migrations/20260912010000_keepsake_descriptions.sql'));
    await db.exec(await read('supabase/migrations/20260912020000_tree_app_store_offer.sql'));
    await db.exec(await read('supabase/migrations/20260912020000_tree_app_store_offer.sql')); // safe replay
    await db.exec(await read('supabase/migrations/20260912030000_remaining_app_store_offers.sql'));
    await db.exec(await read('supabase/migrations/20260912030000_remaining_app_store_offers.sql')); // safe replay
    await db.exec(await read('supabase/migrations/20260912040000_character_store_stories.sql'));
    await db.exec(await read('supabase/migrations/20260912040000_character_store_stories.sql')); // safe replay
    await db.exec(await read('supabase/migrations/20260912050000_monkey_app_store_offer_retry.sql'));
    await db.exec(await read('supabase/migrations/20260912050000_monkey_app_store_offer_retry.sql')); // safe replay
    await db.exec(await read('supabase/migrations/20260912123000_restore_monkey_second_app_store_offer.sql'));
    await db.exec(await read('supabase/migrations/20260912123000_restore_monkey_second_app_store_offer.sql')); // safe replay
    await db.exec(await read('supabase/migrations/20260912130000_monkey_fourth_app_store_offer.sql'));
    await db.exec(await read('supabase/migrations/20260912130000_monkey_fourth_app_store_offer.sql')); // safe replay
    const owned = async (key: string, uid = user) => (await db.query<any>(
      'select status from commerce_entitlements where user_id=$1 and entitlement_key=$2',[uid,key])).rows[0]?.status;
    assert.equal(await owned('throwable:throwable_banana'),'active');
    assert.equal((await db.query<any>('select equipped_throwable_id from profiles where id=$1',[user])).rows[0].equipped_throwable_id,'throwable_banana');
    assert.equal((await db.query('select * from get_store_state()')).rows.length,24);
    assert.equal((await db.query('select * from private.app_store_product_offers')).rows.length,34);
    const catalog = JSON.parse(await read('assets/v1/commerce-catalog.json'));
    for (const product of catalog) {
      const row = (await db.query<any>('select * from get_store_state() where product_id=$1',[product.id])).rows[0];
      assert.equal(row.product_description,product.description);
      assert.equal(row.amount_krw,product.direct_price);
      assert.equal(row.app_store_product_id,product.app_store_product_id);
      assert.equal(row.render_asset_id,product.render_asset_id);
      assert.equal(row.sort_order,product.sort_order);
    }
    await assert.rejects(db.query("select set_equipped_cosmetic('throwable','throwable_clam')"), /cosmetic_ownership_required/);
    // Reprocessing a parent does not duplicate the derived grant.
    await db.exec("update private.commerce_grants set updated_at=now() where source_reference='existing-gift'");
    assert.equal((await db.query('select * from private.commerce_grants where parent_grant_id is not null')).rows.length,1);
    await db.exec(`insert into private.commerce_grants(user_id,entitlement_key,source_kind,source_reference,status)
      values('${user}','throwable:throwable_banana','complimentary','independent-item','active');
      update private.commerce_grants set status='refunded',revoked_at=now() where source_reference='existing-gift';`);
    assert.equal(await owned('throwable:throwable_banana'),'active');
    await db.exec("update private.commerce_grants set status='revoked',revoked_at=now() where source_reference='independent-item'");
    assert.notEqual(await owned('throwable:throwable_banana'),'active');
    assert.equal((await db.query<any>('select equipped_throwable_id from profiles where id=$1',[user])).rows[0].equipped_throwable_id,null);
    const apply = async (tx: string, offer: string, status='active', uid=other, signed='2026-09-13') => db.query(
      `select * from admin_apply_app_store_transaction($1,$2,$2,$3,$1,'Sandbox',$4,'2026-09-01',
        case when $4='active' then null else '2026-09-13'::timestamptz end,$5,repeat('a',64))`,[uid,tx,offer,status,signed]);
    // Old and new tree offers grant the same character, never its separate keepsake.
    await apply('tree-old','character_tree');
    await apply('tree-new','character_tree_2');
    assert.equal(await owned('character:pixel_tree',other),'active');
    assert.equal(await owned('throwable:throwable_timber',other),undefined);
    await apply('tree-old','character_tree','refunded');
    assert.equal(await owned('character:pixel_tree',other),'active');
    await apply('tree-new','character_tree_2','refunded');
    assert.notEqual(await owned('character:pixel_tree',other),'active');
    await apply('tree-old','character_tree','active',other,'2026-09-14');
    assert.equal(await owned('character:pixel_tree',other),'active');
    // Reissued offers retain the same entitlement; refunding one purchase
    // must not revoke another active purchase of that item.
    for (const [oldOffer, newOffer, entitlement] of [
      ['character_monkey_solo', 'character_monkey_solo_2', 'character:pixel_monkey'],
      ['character_monkey_solo_2', 'character_monkey_solo_3', 'character:pixel_monkey'],
      ['character_monkey_solo_3', 'character_monkey_solo_4', 'character:pixel_monkey'],
      ['throwable_clam', 'throwable_clam_2', 'throwable:throwable_clam'],
      ['throwable_pork', 'throwable_pork_2', 'throwable:throwable_pork'],
    ] as const) {
      await apply(`replacement-old-${oldOffer}`, oldOffer);
      await apply(`replacement-new-${oldOffer}`, newOffer);
      assert.equal(await owned(entitlement,other),'active');
      await apply(`replacement-old-${oldOffer}`, oldOffer, 'refunded');
      assert.equal(await owned(entitlement,other),'active');
      await apply(`replacement-new-${oldOffer}`, newOffer, 'refunded');
      assert.notEqual(await owned(entitlement,other),'active');
    }
    assert.equal(await owned('throwable:throwable_banana',other),undefined);
    assert.equal(await owned('character:pixel_otter',other),undefined);
    assert.equal(await owned('character:pixel_pig',other),undefined);
    await apply('solo-purchase','character_monkey_solo');
    assert.equal(await owned('character:pixel_monkey',other),'active');
    assert.equal(await owned('throwable:throwable_banana',other),undefined);
    await apply('late-restore','character_monkey');
    assert.equal(await owned('throwable:throwable_banana',other),'active');
    await apply('late-restore','character_monkey','refunded');
    assert.notEqual(await owned('throwable:throwable_banana',other),'active');
    assert.equal(await owned('character:pixel_monkey',other),'active');
    await apply('late-restore','character_monkey','active',other,'2026-09-12'); // stale callback cannot resurrect
    assert.notEqual(await owned('throwable:throwable_banana',other),'active');
    await assert.rejects(apply('late-restore','character_monkey_solo'),/product_mismatch/);
    await assert.rejects(apply('unknown','haracter_pig'),/unknown_app_store_product/);
    // New gifts and post-cutover direct orders are character-only. Old pending orders retain inclusion.
    await db.exec(`insert into private.commerce_grants(user_id,entitlement_key,source_kind,source_reference,status)
      values('${other}','character:pixel_chinchilla','complimentary','new-gift','active');`);
    assert.equal(await owned('throwable:throwable_dust_bath_pouch',other),undefined);
    const directOrder = async (suffix: string, before: boolean) => {
      const order = '63000000-0000-0000-0000-00000000000'+suffix;
      await db.query(`insert into commerce_orders(id,provider_order_id,user_id,product_id,price_id,amount_krw,currency,
        checkout_token_hash,checkout_token_expires_at,created_at)
        select $1::uuid,$1::text,$2::uuid,'character_chinchilla',id,amount_krw,'KRW',decode(repeat($3,64),'hex'),now()+interval '1 day',
          (select cutover_at from private.character_item_transition) + ($4 * interval '1 second')
        from commerce_prices where product_id='character_chinchilla' and active`,[order,other,suffix,before ? -1 : 1]);
      await db.query(`insert into private.commerce_grants(user_id,entitlement_key,source_kind,source_reference,status)
        values($1,'character:pixel_chinchilla','portone','order:' || $2,'active')`,[other,order]);
      return order;
    };
    await directOrder('1',false);
    assert.equal(await owned('throwable:throwable_dust_bath_pouch',other),undefined);
    const oldOrder = await directOrder('2',true);
    assert.equal(await owned('throwable:throwable_dust_bath_pouch',other),'active');
    // Account unlink and final source deletion must not leave the included item behind.
    await db.query("update private.commerce_grants set user_id=null,status='revoked',revoked_at=now() where source_reference='order:' || $1",[oldOrder]);
    assert.equal(await owned('throwable:throwable_dust_bath_pouch',other),undefined);
    await db.query("update private.commerce_grants set user_id=$1,status='active',revoked_at=null where source_reference='order:' || $2",[other,oldOrder]);
    assert.equal(await owned('throwable:throwable_dust_bath_pouch',other),'active');
    await db.query("delete from private.commerce_grants where source_reference='order:' || $1",[oldOrder]);
    assert.equal(await owned('throwable:throwable_dust_bath_pouch',other),undefined);
    assert.equal(await owned('character:pixel_chinchilla',other),'active');
    await apply('item-only','throwable_clam');
    await db.exec(`select set_config('test.user','${other}',false)`);
    await db.query("select set_equipped_cosmetic('throwable','throwable_clam')");
    assert.equal(await owned('character:pixel_otter',other),undefined);
    const room = '64000000-0000-0000-0000-000000000001';
    await db.exec(`insert into rooms values('${room}',1);
      insert into room_members values('${room}','${user}'),('${room}','${other}');`);
    const broadcast = async (epoch=1, target=user) => db.query(
      'select broadcast_character_throw($1,$2,gen_random_uuid(),$3)',[room,epoch,target]);
    const lastEvent = async () => (await db.query<any>('select * from realtime.captured order by id desc limit 1')).rows[0];
    await broadcast();
    assert.equal((await lastEvent()).payload.throwable_id,'clam');
    assert.equal((await lastEvent()).payload.source_character_id,'pixel_hamster');
    assert.equal((await lastEvent()).is_private,true);
    await db.query("select set_equipped_cosmetic('throwable',null)");
    await broadcast();
    assert.equal((await lastEvent()).payload.throwable_id,'patch_soft_ball');
    // A stale or tampered equipment column never authorizes an unowned item.
    await db.query("update profiles set equipped_throwable_id='throwable_pork' where id=$1",[other]);
    await broadcast();
    assert.equal((await lastEvent()).payload.throwable_id,'patch_soft_ball');
    await assert.rejects(broadcast(0),/stale_realtime_epoch/);
    await assert.rejects(broadcast(1,other),/self_target_forbidden/);
    await db.query('delete from room_members where user_id=$1',[other]);
    await assert.rejects(broadcast(),/membership_required/);
    await db.exec("select set_config('test.user','',false)");
    await assert.rejects(db.query('select * from get_store_state()'),/authentication_required/);
    assert.equal((await db.query<any>("select has_table_privilege('authenticated','private.app_store_product_offers','INSERT') as allowed")).rows[0].allowed,false);
  } finally { await db.close(); }
});
