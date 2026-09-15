begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(41);

select has_table('public', 'commerce_products', 'commerce products exist');
select has_table('public', 'commerce_prices', 'commerce prices exist');
select has_table('public', 'commerce_orders', 'commerce orders exist');
select has_table('public', 'commerce_entitlements', 'commerce entitlements exist');
select has_column('public', 'commerce_entitlements', 'grant_kind', 'grant kind records provenance');
select has_column('public', 'commerce_entitlements', 'grant_reference', 'grant reference records provenance');
select is((select count(*)::integer from public.commerce_products where active), 24, 'twenty-four catalog products are active');
select results_eq(
  $$select product_id, amount_krw from public.commerce_prices where active order by product_id$$,
  $$values
      ('bubble_bunny_pink'::text, 1900),
      ('bubble_butter_chick'::text, 1900),
      ('bubble_starry_cat'::text, 1900),
      ('character_chinchilla'::text, 990),
      ('character_guinea_pig'::text, 990),
      ('character_monkey'::text, 990),
      ('character_otter'::text, 990),
      ('character_pig'::text, 990),
      ('character_starlight_upalupa'::text, 1900),
      ('character_tree'::text, 1900),
      ('throwable_banana'::text, 990),
      ('throwable_baseball'::text, 990),
      ('throwable_bouncy_heart'::text, 990),
      ('throwable_clam'::text, 990),
      ('throwable_dujjonku'::text, 1900),
      ('throwable_dust_bath_pouch'::text, 990),
      ('throwable_mini_paprika'::text, 990),
      ('throwable_pork'::text, 990),
      ('throwable_snowflake'::text, 990),
      ('throwable_squeaky_duck'::text, 990),
      ('throwable_starlight_orb'::text, 990),
      ('throwable_timber'::text, 990),
      ('throwable_toy_cannon'::text, 2900),
      ('throwable_wakkuball'::text, 1900)$$,
  'active prices are server-owned'
);
select is(
  (select count(*)::integer from public.commerce_prices
   where product_id = 'character_starlight_upalupa' and not active and amount_krw = 990),
  1,
  'historical 990 KRW starlight price is retained and retired'
);
select is(
  (select count(*)::integer from public.commerce_prices
   where product_id = 'throwable_toy_cannon' and not active and amount_krw = 3900),
  1,
  'historical 3,900 KRW cannon price is retained and retired'
);
select is((select sales_enabled from private.commerce_runtime_settings), false, 'migration fails closed');
select ok((select relrowsecurity from pg_class where oid = 'public.commerce_orders'::regclass), 'orders use RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.commerce_entitlements'::regclass), 'entitlements use RLS');
select ok(
  not has_function_privilege('service_role', 'public.commerce_record_approval(text,text,integer,text,text,timestamptz)', 'execute'),
  'legacy Toss approval RPC is no longer executable'
);
select ok(
  has_function_privilege('service_role', 'public.commerce_record_portone_state(text,text,text,text,text,text,text,text,integer,integer,text,text,text,text,timestamptz)', 'execute'),
  'service role can apply verified PortOne state'
);

update private.commerce_runtime_settings set sales_enabled = true, payment_environment = 'test';
insert into auth.users (
  id, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"anonymous","providers":["anonymous"]}', '{}', true, now(), now()),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"google","providers":["anonymous","google"]}', '{}', false, now(), now());

select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
select public.upsert_profile('별빛친구', 'pixel_hamster');
select is((select google_connected from public.get_commerce_state()), false, 'anonymous account needs Google');
select throws_ok(
  $$select public.upsert_profile('별빛친구', 'pixel_starlight_upalupa')$$,
  '42501', 'character_ownership_required', 'paid selection needs entitlement'
);
select throws_ok(
  $$select * from public.create_commerce_order('character_starlight_upalupa', repeat('a', 64))$$,
  'P0001', 'google_identity_required', 'order creation needs Google'
);

update auth.users
set raw_app_meta_data = '{"provider":"google","providers":["anonymous","google"]}', is_anonymous = false
where id = '20000000-0000-0000-0000-000000000001';
select is((select google_connected from public.get_commerce_state()), true, 'Google connection is reflected');

create temporary table commerce_test_order as
select * from public.create_commerce_order('character_starlight_upalupa', repeat('a', 64));
select is((select amount_krw from commerce_test_order), 1900, 'order copies active starlight price');
select is(
  (select octet_length(checkout_token_hash) from public.commerce_orders
   where id = (select order_id from commerce_test_order)),
  32,
  'only checkout token hash is stored'
);
select is(
  (select count(*)::integer from public.commerce_portone_checkout_prepare(repeat('a', 64))),
  1,
  'valid staging checkout token can be prepared'
);
select lives_ok(
  $$select * from public.commerce_record_policy_consent(
      repeat('a', 64),
      (select policy_version from private.commerce_runtime_settings)
    )$$,
  'canonical purchase policy consent is recorded'
);
select ok(
  (select policy_consented_at is not null from public.commerce_orders
   where id = (select order_id from commerce_test_order)),
  'order stores consent timestamp'
);

select throws_ok(
  format($sql$select public.commerce_record_portone_state(
    'bad-version','Transaction.Paid',repeat('b',64),%L,'store-1','channel-1','V1','TEST',1900,1900,'KRW','PAID','tx-1','EASY_PAY',now())$sql$,
    (select provider_order_id from commerce_test_order)),
  '22023', 'portone_payment_environment_mismatch', 'non-V2 payment is rejected'
);
select throws_ok(
  format($sql$select public.commerce_record_portone_state(
    'bad-env','Transaction.Paid',repeat('b',64),%L,'store-1','channel-1','V2','LIVE',1900,1900,'KRW','PAID','tx-1','EASY_PAY',now())$sql$,
    (select provider_order_id from commerce_test_order)),
  '22023', 'portone_payment_environment_mismatch', 'live channel is rejected in test environment'
);
select throws_ok(
  format($sql$select public.commerce_record_portone_state(
    'bad-amount','Transaction.Paid',repeat('b',64),%L,'store-1','channel-1','V2','TEST',1901,1901,'KRW','PAID','tx-1','EASY_PAY',now())$sql$,
    (select provider_order_id from commerce_test_order)),
  '22023', 'commerce_amount_mismatch', 'amount mismatch is rejected'
);

select is(
  public.commerce_record_portone_state(
    'paid-1','Transaction.Paid',repeat('c',64),
    (select provider_order_id from commerce_test_order),
    'store-1','channel-1','V2','TEST',1900,1900,'KRW','PAID','tx-1','EASY_PAY',now()
  ),
  'approved', 'verified paid state approves order'
);
select is(
  (select status from public.commerce_entitlements
   where user_id = '20000000-0000-0000-0000-000000000001'
     and entitlement_key = 'character:pixel_starlight_upalupa'),
  'active', 'paid state grants entitlement'
);
select is((select provider from private.commerce_payments where order_id = (select order_id from commerce_test_order)), 'portone', 'payment records PortOne provider');
select is(
  public.commerce_record_portone_state(
    'paid-1','Transaction.Paid',repeat('c',64),
    (select provider_order_id from commerce_test_order),
    'store-1','channel-1','V2','TEST',1900,1900,'KRW','PAID','tx-1','EASY_PAY',now()
  ),
  'approved', 'duplicate event is idempotent'
);
select lives_ok($$select public.upsert_profile('별빛친구', 'pixel_starlight_upalupa')$$, 'owned character can be selected');
select is(
  (select count(*)::integer from public.commerce_refund_target(
    (select order_id from commerce_test_order), 'not_provided',
    '40000000-0000-0000-0000-000000000001', 'pgtap-operator', null)),
  1, 'approved PortOne order is refundable'
);
select is(
  public.commerce_record_portone_state(
    'refund-1','Transaction.Cancelled',repeat('d',64),
    (select provider_order_id from commerce_test_order),
    'store-1','channel-1','V2','TEST',1900,0,'KRW','CANCELLED','tx-1','EASY_PAY',now()
  ),
  'refunded', 'verified full cancellation refunds order'
);
select is(
  (select status from public.commerce_entitlements
   where user_id = '20000000-0000-0000-0000-000000000001'
     and entitlement_key = 'character:pixel_starlight_upalupa'),
  'refunded', 'refund revokes purchase entitlement'
);
select is((select character_id from public.profiles where id = '20000000-0000-0000-0000-000000000001'), 'pixel_hamster', 'refund resets active paid profile');
select is(
  public.commerce_record_portone_state(
    'refund-1','Transaction.Cancelled',repeat('d',64),
    (select provider_order_id from commerce_test_order),
    'store-1','channel-1','V2','TEST',1900,0,'KRW','CANCELLED','tx-1','EASY_PAY',now()
  ),
  'refunded', 'duplicate refund is idempotent'
);

select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', true);
select public.upsert_profile('무료친구', 'pixel_hamster');
insert into public.commerce_entitlements (
  user_id, entitlement_key, source_order_id, status, grant_kind, grant_reference
) values (
  '20000000-0000-0000-0000-000000000002', 'character:pixel_guinea_pig', null,
  'active', 'complimentary', 'pgtap-complimentary-grant'
);
select lives_ok($$select public.upsert_profile('무료친구', 'pixel_guinea_pig')$$, 'complimentary grant permits selection');
select results_eq(
  $$select status, grant_kind is null from public.commerce_entitlements
    where user_id = '20000000-0000-0000-0000-000000000002'
      and entitlement_key = 'character:pixel_guinea_pig'$$,
  $$values ('active'::text, true)$$,
  'public entitlement is a source-agnostic active projection'
);
select throws_ok(
  $$select * from public.create_commerce_order('character_guinea_pig', repeat('e', 64))$$,
  'P0001', 'already_owned', 'complimentary owner cannot buy the same entitlement'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', true);
select is(
  (select count(*)::integer from public.commerce_entitlements
   where user_id = '20000000-0000-0000-0000-000000000001'),
  0,
  'RLS hides another user entitlements'
);

select * from finish();
rollback;
