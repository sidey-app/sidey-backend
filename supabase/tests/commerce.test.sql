begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(52);

select has_table('public', 'commerce_products', 'commerce products exist');
select has_table('public', 'commerce_prices', 'commerce prices exist');
select has_table('public', 'commerce_orders', 'commerce orders exist');
select has_table('public', 'commerce_entitlements', 'commerce entitlements exist');
select has_column('public', 'commerce_entitlements', 'grant_kind', 'grant kind records provenance');
select has_column('public', 'commerce_entitlements', 'grant_reference', 'grant reference records provenance');
select is((select count(*)::integer from public.commerce_products where active), 33, 'thirty-three catalog products are active');
select results_eq(
  $$select product_id, amount_krw from public.commerce_prices where active order by product_id$$,
  $$values
      ('bubble_bunny_pink'::text, 2200),
      ('bubble_butter_chick'::text, 2200),
      ('bubble_starry_cat'::text, 2200),
      ('character_chinchilla'::text, 1100),
      ('character_duck'::text, 1100),
      ('character_guinea_pig'::text, 1100),
      ('character_monkey'::text, 1100),
      ('character_otter'::text, 1100),
      ('character_pig'::text, 1100),
      ('character_poop'::text, 1100),
      ('character_quokka'::text, 1100),
      ('character_shiba'::text, 1100),
      ('character_starlight_upalupa'::text, 2200),
      ('character_tree'::text, 1100),
      ('character_tteokbokki'::text, 1100),
      ('throwable_banana'::text, 1100),
      ('throwable_baseball'::text, 1100),
      ('throwable_bouncy_heart'::text, 1100),
      ('throwable_clam'::text, 1100),
      ('throwable_dujjonku'::text, 2200),
      ('throwable_dust_bath_pouch'::text, 1100),
      ('throwable_fish_cake_skewer'::text, 1100),
      ('throwable_leaf'::text, 1100),
      ('throwable_mini_paprika'::text, 1100),
      ('throwable_pork'::text, 1100),
      ('throwable_snowflake'::text, 1100),
      ('throwable_squeaky_duck'::text, 1100),
      ('throwable_starlight_orb'::text, 1100),
      ('throwable_tennis_ball'::text, 1100),
      ('throwable_timber'::text, 1100),
      ('throwable_tissue_ball'::text, 1100),
      ('throwable_toy_cannon'::text, 3300),
      ('throwable_wakkuball'::text, 2200)$$,
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
select is((select amount_krw from commerce_test_order), 2200, 'order copies active starlight price');
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
    'bad-version','Transaction.Paid',repeat('b',64),%L,'store-1','channel-1','V1','TEST',2200,2200,'KRW','PAID','tx-1','EASY_PAY',now())$sql$,
    (select provider_order_id from commerce_test_order)),
  '22023', 'portone_payment_environment_mismatch', 'non-V2 payment is rejected'
);
select throws_ok(
  format($sql$select public.commerce_record_portone_state(
    'bad-env','Transaction.Paid',repeat('b',64),%L,'store-1','channel-1','V2','LIVE',2200,2200,'KRW','PAID','tx-1','EASY_PAY',now())$sql$,
    (select provider_order_id from commerce_test_order)),
  '22023', 'portone_payment_environment_mismatch', 'live channel is rejected in test environment'
);
select throws_ok(
  format($sql$select public.commerce_record_portone_state(
    'bad-amount','Transaction.Paid',repeat('b',64),%L,'store-1','channel-1','V2','TEST',2201,2201,'KRW','PAID','tx-1','EASY_PAY',now())$sql$,
    (select provider_order_id from commerce_test_order)),
  '22023', 'commerce_amount_mismatch', 'amount mismatch is rejected'
);
select throws_ok(
  $$select public.commerce_record_portone_state(
    'card-method','Transaction.Paid',repeat('b',64),'missing-card-payment',
    'store-1','channel-1','V2','TEST',2200,2200,'KRW','PAID','tx-card','CARD',now())$$,
  'P0001', 'commerce_order_not_found', 'card method passes the payment-method boundary'
);
select throws_ok(
  format($sql$select public.commerce_record_portone_state(
    'bad-method','Transaction.Paid',repeat('b',64),%L,
    'store-1','channel-1','V2','TEST',2200,2200,'KRW','PAID','tx-transfer','TRANSFER',now())$sql$,
    (select provider_order_id from commerce_test_order)),
  '22023', 'portone_payment_environment_mismatch', 'unsupported payment method is rejected'
);
select throws_ok(
  format($sql$select public.commerce_record_portone_state(
    'missing-method','Transaction.Paid',repeat('b',64),%L,
    'store-1','channel-1','V2','TEST',2200,2200,'KRW','PAID','tx-null',null,now())$sql$,
    (select provider_order_id from commerce_test_order)),
  '22023', 'portone_payment_environment_mismatch', 'missing payment method is rejected'
);

select is(
  public.commerce_record_portone_state(
    'paid-1','Transaction.Paid',repeat('c',64),
    (select provider_order_id from commerce_test_order),
    'store-1','channel-1','V2','TEST',2200,2200,'KRW','PAID','tx-1','EASY_PAY',now()
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
    'store-1','channel-1','V2','TEST',2200,2200,'KRW','PAID','tx-1','EASY_PAY',now()
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
    'store-1','channel-1','V2','TEST',2200,0,'KRW','CANCELLED','tx-1','EASY_PAY',now()
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
    'store-1','channel-1','V2','TEST',2200,0,'KRW','CANCELLED','tx-1','EASY_PAY',now()
  ),
  'refunded', 'duplicate refund is idempotent'
);

create temporary table commerce_card_order as
select * from public.create_commerce_order('character_starlight_upalupa', repeat('f', 64));
select lives_ok(
  $$select * from public.commerce_record_policy_consent(
      repeat('f', 64),
      (select policy_version from private.commerce_runtime_settings)
    )$$,
  'card order records canonical purchase policy consent'
);
select is(
  public.commerce_record_portone_state(
    'card-paid-1','Transaction.Paid',repeat('e',64),
    (select provider_order_id from commerce_card_order),
    'store-1','channel-1','V2','TEST',2200,2200,'KRW','PAID','tx-card-1','CARD',now()
  ),
  'approved', 'verified card state approves order'
);
select is(
  (select payment_method_type from private.commerce_payments
   where order_id = (select order_id from commerce_card_order)),
  'CARD', 'card method is preserved in the payment ledger'
);
select is(
  (select status from public.commerce_entitlements
   where user_id = '20000000-0000-0000-0000-000000000001'
     and entitlement_key = 'character:pixel_starlight_upalupa'),
  'active', 'card payment grants entitlement'
);
select is(
  public.commerce_record_portone_state(
    'card-paid-1','Transaction.Paid',repeat('e',64),
    (select provider_order_id from commerce_card_order),
    'store-1','channel-1','V2','TEST',2200,2200,'KRW','PAID','tx-card-1','CARD',now()
  ),
  'approved', 'duplicate card event is idempotent'
);
select is(
  (select count(*)::integer from public.commerce_refund_target(
    (select order_id from commerce_card_order), 'not_provided',
    '40000000-0000-0000-0000-000000000002', 'pgtap-card-operator', null)),
  1, 'approved card order is refundable'
);
select is(
  public.commerce_record_portone_state(
    'card-refund-1','Transaction.Cancelled',repeat('f',64),
    (select provider_order_id from commerce_card_order),
    'store-1','channel-1','V2','TEST',2200,0,'KRW','CANCELLED','tx-card-1','CARD',now()
  ),
  'refunded', 'verified card cancellation refunds order'
);
select is(
  (select status from public.commerce_entitlements
   where user_id = '20000000-0000-0000-0000-000000000001'
     and entitlement_key = 'character:pixel_starlight_upalupa'),
  'refunded', 'card refund revokes purchase entitlement'
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
