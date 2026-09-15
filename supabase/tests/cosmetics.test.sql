begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(32);

select has_column('public', 'commerce_products', 'product_kind', 'catalog has product kind');
select has_column('public', 'commerce_products', 'catalog_item_id', 'catalog has item ID');
select has_column('public', 'commerce_products', 'sort_order', 'catalog has stable sort order');
select has_column('public', 'profiles', 'equipped_bubble_style_id', 'profile stores bubble equipment');
select has_column('public', 'profiles', 'equipped_throwable_id', 'profile stores throwable equipment');
select has_column('public', 'messages', 'bubble_style_id', 'message snapshots bubble style');
select is(
  (select amount_krw from public.commerce_prices
   where product_id = 'throwable_toy_cannon' and active),
  2900,
  'premium cannon costs 2,900 KRW including VAT'
);
select is(
  (select count(*)::integer from public.commerce_prices
   where product_id = 'throwable_toy_cannon' and not active and amount_krw = 3900),
  1,
  'the original cannon price remains as retired history'
);
select ok(
  (select tax_inclusive from public.commerce_prices
   where product_id = 'throwable_toy_cannon' and active),
  'cannon price includes VAT'
);
select is((select sales_enabled from private.commerce_runtime_settings), false, 'production sales stay disabled');

insert into auth.users (
  id, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
) values
  ('71000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{}', false, now(), now()),
  ('71000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}', '{}', false, now(), now());

select set_config('request.jwt.claim.sub', '71000000-0000-0000-0000-000000000001', true);
select public.upsert_profile('꾸미는친구', 'pixel_hamster');
create temporary table cosmetics_room (room_id uuid, invite_code text);
grant select on cosmetics_room to authenticated;
insert into cosmetics_room select room_id, invite_code from public.create_room('꾸미기 테스트');

select set_config('request.jwt.claim.sub', '71000000-0000-0000-0000-000000000002', true);
select public.upsert_profile('받는친구', 'pixel_cat');
select * from public.join_room((select invite_code from cosmetics_room));

set local role authenticated;
select set_config('request.jwt.claim.sub', '71000000-0000-0000-0000-000000000001', true);
select is((select count(*)::integer from public.get_store_state()), 24, 'store state returns the whole catalog');
select is(
  (select count(*)::integer from public.get_store_state() where is_equipped is null),
  0,
  'store state returns false rather than null for default equipment'
);
select throws_ok(
  $$select public.set_equipped_cosmetic('bubble', 'bubble_bunny_pink')$$,
  '42501', 'cosmetic_ownership_required', 'unowned bubble cannot be equipped'
);
select throws_ok(
  $$select public.set_equipped_cosmetic('character', 'pixel_hamster')$$,
  '22023', 'invalid_cosmetic_kind', 'character selection remains outside cosmetic equipment RPC'
);

set local role postgres;
insert into public.commerce_entitlements (
  user_id, entitlement_key, source_order_id, status, grant_kind, grant_reference
) values
  ('71000000-0000-0000-0000-000000000001', 'bubble:bubble_bunny_pink', null,
   'active', 'complimentary', 'cosmetics-pink'),
  ('71000000-0000-0000-0000-000000000001', 'bubble:bubble_butter_chick', null,
   'active', 'complimentary', 'cosmetics-butter'),
  ('71000000-0000-0000-0000-000000000001', 'throwable:throwable_bouncy_heart', null,
   'active', 'complimentary', 'cosmetics-heart');

set local role authenticated;
select set_config('request.jwt.claim.sub', '71000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.set_equipped_cosmetic('bubble', 'bubble_bunny_pink')$$,
  'owned bubble can be equipped'
);
select is(
  (select equipped_bubble_style_id from public.profiles where id = auth.uid()),
  'bubble_bunny_pink', 'bubble equipment is account-wide profile state'
);
select lives_ok(
  $$select public.send_message(
      '72000000-0000-0000-0000-000000000001',
      (select room_id from cosmetics_room), '처음 색을 기억해'
    )$$,
  'message with equipped bubble is accepted'
);
select public.set_equipped_cosmetic('bubble', 'bubble_butter_chick');
select lives_ok(
  $$select public.send_message(
      '72000000-0000-0000-0000-000000000001',
      (select room_id from cosmetics_room), '처음 색을 기억해'
    )$$,
  'message retry keeps the same RPC signature'
);
select is(
  (select bubble_style_id from public.messages
   where id = '72000000-0000-0000-0000-000000000001'),
  'bubble_bunny_pink', 'retry preserves the first saved bubble snapshot'
);
select public.set_equipped_cosmetic('throwable', 'throwable_bouncy_heart');
select lives_ok(
  $$select public.set_equipped_cosmetic('bubble')$$,
  'omitting the catalog item returns a bubble to its default'
);
select is(
  (select equipped_bubble_style_id from public.profiles where id = auth.uid()),
  null, 'one-argument unequip clears only the requested bubble kind'
);
select is(
  (select equipped_throwable_id from public.profiles where id = auth.uid()),
  'throwable_bouncy_heart', 'one-argument bubble reset preserves throwable equipment'
);

select public.set_equipped_cosmetic('bubble', 'bubble_bunny_pink');
select lives_ok(
  $$select public.set_equipped_cosmetic('bubble', null)$$,
  'an explicit null also returns a bubble to its default'
);
select is(
  (select equipped_bubble_style_id from public.profiles where id = auth.uid()),
  null, 'explicit-null unequip returns to the default white bubble'
);
select is(
  (select equipped_throwable_id from public.profiles where id = auth.uid()),
  'throwable_bouncy_heart', 'explicit-null bubble reset preserves throwable equipment'
);

select public.set_equipped_cosmetic('throwable', 'throwable_bouncy_heart');
select lives_ok(
  format($sql$select public.broadcast_character_throw(
      %L, %s, '72000000-0000-0000-0000-000000000002',
      '71000000-0000-0000-0000-000000000002'
    )$sql$,
    (select room_id from cosmetics_room),
    (select realtime_epoch from public.rooms where id = (select room_id from cosmetics_room))),
  'equipped throwable uses the unchanged throw RPC signature'
);

set local role postgres;
select is(
  (select payload ->> 'throwable_id' from realtime.messages
   where event = 'character_throw' order by inserted_at desc limit 1),
  'throwable_bouncy_heart', 'server adds only its owned equipped throwable to the payload'
);
update private.commerce_grants
set status = 'revoked', revoked_at = now(), updated_at = now()
where user_id = '71000000-0000-0000-0000-000000000001'
  and entitlement_key = 'throwable:throwable_bouncy_heart';
select private.refresh_commerce_entitlement(
  '71000000-0000-0000-0000-000000000001',
  'throwable:throwable_bouncy_heart'
);
select is(
  (select equipped_throwable_id from public.profiles
   where id = '71000000-0000-0000-0000-000000000001'),
  null, 'revoked throwable immediately falls back to the shared soft ball'
);

update private.commerce_runtime_settings set sales_enabled = true, payment_environment = 'test';
select set_config('request.jwt.claim.sub', '71000000-0000-0000-0000-000000000001', true);
create temporary table duck_order as
select * from public.create_commerce_order('throwable_squeaky_duck', repeat('f', 64));
update public.commerce_orders
set policy_version = (select policy_version from private.commerce_runtime_settings),
    policy_notice = (select policy_notice from private.commerce_runtime_settings),
    policy_consented_at = now(),
    status = 'approved',
    approved_at = now()
where id = (select order_id from duck_order);
select is(
  (select equipped_throwable_id from public.profiles
   where id = '71000000-0000-0000-0000-000000000001'),
  'throwable_squeaky_duck', 'approved purchase is auto-equipped'
);
update public.commerce_orders
set status = 'refunded', refunded_at = now()
where id = (select order_id from duck_order);
select is(
  (select equipped_throwable_id from public.profiles
   where id = '71000000-0000-0000-0000-000000000001'),
  null, 'refund clears the equipped purchase'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '71000000-0000-0000-0000-000000000002', true);
select is(
  (select count(*)::integer from public.commerce_entitlements
   where user_id = '71000000-0000-0000-0000-000000000001'),
  0, 'RLS hides another account cosmetic entitlements'
);
select is(
  (select count(*)::integer from public.messages
   where sender_id = '71000000-0000-0000-0000-000000000001'),
  1, 'room member still sees the snapshotted message under message RLS'
);

select * from finish();
rollback;
