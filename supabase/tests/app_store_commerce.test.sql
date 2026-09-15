begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(32);

select has_table('private', 'commerce_grants', 'commerce grant ledger exists');
select has_table('private', 'app_store_transactions', 'App Store transactions exist');
select has_table('private', 'app_store_notification_events', 'notification ledger exists');
select ok(
  has_function_privilege(
    'service_role',
    'public.admin_apply_app_store_transaction(uuid,text,text,text,uuid,text,text,timestamptz,timestamptz,timestamptz,text)',
    'execute'
  ),
  'service role can apply verified App Store transactions'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.admin_apply_app_store_transaction(uuid,text,text,text,uuid,text,text,timestamptz,timestamptz,timestamptz,text)',
    'execute'
  ),
  'authenticated clients cannot grant App Store entitlements'
);

insert into auth.users (
  id, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
) values
  ('61000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"apple","providers":["apple"]}', '{}', false, now(), now()),
  ('61000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"apple","providers":["apple"]}', '{}', false, now(), now()),
  ('61000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"apple","providers":["apple"]}', '{}', false, now(), now());

insert into public.profiles (id, nickname, character_id) values
  ('61000000-0000-0000-0000-000000000001', '애플친구', 'pixel_hamster'),
  ('61000000-0000-0000-0000-000000000002', '남은친구', 'pixel_hamster'),
  ('61000000-0000-0000-0000-000000000003', '새친구', 'pixel_hamster');

select results_eq(
  $$select entitlement_key, entitlement_status, binding_state
    from public.admin_apply_app_store_transaction(
      '61000000-0000-0000-0000-000000000001', '900000000000001',
      '900000000000001', 'character_guinea_pig',
      '61000000-0000-0000-0000-000000000001', 'Sandbox', 'active',
      now() - interval '1 minute', null, now(), repeat('a', 64)
    )$$,
  $$values ('character:pixel_guinea_pig'::text, 'active'::text, 'bound'::text)$$,
  'verified transaction grants the mapped entitlement'
);
select is(
  (select status from public.commerce_entitlements
   where user_id = '61000000-0000-0000-0000-000000000001'
     and entitlement_key = 'character:pixel_guinea_pig'),
  'active',
  'App Store grant updates the public projection'
);
select is(
  (select source_kind from private.commerce_grants
   where source_reference = 'transaction:900000000000001'),
  'app_store',
  'App Store provenance stays private'
);
select results_eq(
  $$select entitlement_key, entitlement_status, binding_state
    from public.admin_apply_app_store_transaction(
      '61000000-0000-0000-0000-000000000002', '900000000000010',
      '900000000000010', 'bubble_starry_cat',
      '61000000-0000-0000-0000-000000000002', 'Sandbox', 'active',
      now() - interval '1 minute', null, now(), repeat('1', 64)
    )$$,
  $$values ('bubble:bubble_starry_cat'::text, 'active'::text, 'bound'::text)$$,
  'verified App Store bubble transaction grants the mapped entitlement'
);
select is(
  (select status from public.commerce_entitlements
   where user_id = '61000000-0000-0000-0000-000000000002'
     and entitlement_key = 'bubble:bubble_starry_cat'),
  'active',
  'App Store bubble grant updates the public projection'
);
select results_eq(
  $$select entitlement_key, entitlement_status, binding_state
    from public.admin_apply_app_store_transaction(
      '61000000-0000-0000-0000-000000000002', '900000000000011',
      '900000000000011', 'throwable_toy_cannon',
      '61000000-0000-0000-0000-000000000002', 'Sandbox', 'active',
      now() - interval '1 minute', null, now(), repeat('2', 64)
    )$$,
  $$values ('throwable:throwable_toy_cannon'::text, 'active'::text, 'bound'::text)$$,
  'verified App Store throwable transaction grants the mapped entitlement'
);
select is(
  (select status from public.commerce_entitlements
   where user_id = '61000000-0000-0000-0000-000000000002'
     and entitlement_key = 'throwable:throwable_toy_cannon'),
  'active',
  'App Store throwable grant updates the public projection'
);
select is(
  (select equipped_bubble_style_id from public.profiles
   where id = '61000000-0000-0000-0000-000000000002'),
  null,
  'server reconciliation does not auto-equip restored App Store bubbles'
);
select is(
  (select equipped_throwable_id from public.profiles
   where id = '61000000-0000-0000-0000-000000000002'),
  null,
  'server reconciliation does not auto-equip restored App Store throwables'
);
select lives_ok(
  $$select * from public.admin_apply_app_store_transaction(
      '61000000-0000-0000-0000-000000000002', '900000000000010',
      '900000000000010', 'bubble_starry_cat',
      '61000000-0000-0000-0000-000000000002', 'Sandbox', 'refunded',
      now() - interval '1 minute', now(), now() + interval '2 seconds', repeat('3', 64)
    )$$,
  'an App Store bubble refund is accepted'
);
select is(
  (select status from public.commerce_entitlements
   where user_id = '61000000-0000-0000-0000-000000000002'
     and entitlement_key = 'bubble:bubble_starry_cat'),
  'refunded',
  'refunding the only App Store bubble grant revokes ownership'
);
select throws_ok(
  $$select * from public.admin_apply_app_store_transaction(
      '61000000-0000-0000-0000-000000000002', '900000000000002',
      '900000000000002', 'character_monkey',
      '61000000-0000-0000-0000-000000000001', 'Sandbox', 'active',
      now(), null, now(), repeat('b', 64)
    )$$,
  '42501', 'app_account_token_mismatch',
  'a new purchase must carry the authenticated user appAccountToken'
);
select throws_ok(
  $$select * from public.admin_apply_app_store_transaction(
      '61000000-0000-0000-0000-000000000002', '900000000000001',
      '900000000000001', 'character_guinea_pig',
      '61000000-0000-0000-0000-000000000001', 'Sandbox', 'active',
      now(), null, now() + interval '1 second', repeat('c', 64)
    )$$,
  '23505', 'app_store_transaction_already_bound',
  'an active account cannot steal an already bound transaction'
);

insert into private.commerce_grants (
  user_id, entitlement_key, source_kind, source_reference, status
) values (
  '61000000-0000-0000-0000-000000000001',
  'character:pixel_guinea_pig', 'complimentary',
  'app-store-test-grant', 'active'
);
select private.refresh_commerce_entitlement(
  '61000000-0000-0000-0000-000000000001',
  'character:pixel_guinea_pig'
);
select is(
  (select count(*)::integer from private.commerce_grants
   where user_id = '61000000-0000-0000-0000-000000000001'
     and entitlement_key = 'character:pixel_guinea_pig'),
  2,
  'multiple entitlement sources are retained'
);

select lives_ok(
  $$select * from public.admin_apply_app_store_transaction(
      '61000000-0000-0000-0000-000000000001', '900000000000001',
      '900000000000001', 'character_guinea_pig',
      '61000000-0000-0000-0000-000000000001', 'Sandbox', 'refunded',
      now() - interval '1 minute', now(), now() + interval '2 seconds', repeat('d', 64)
    )$$,
  'a refund update is accepted'
);
select is(
  (select status from public.commerce_entitlements
   where user_id = '61000000-0000-0000-0000-000000000001'
     and entitlement_key = 'character:pixel_guinea_pig'),
  'active',
  'refunding one source preserves another active grant'
);

insert into public.rooms (id, name, owner_id, invite_code_hint, invite_code_ready)
values (
  '62000000-0000-0000-0000-000000000001', '삭제테스트',
  '61000000-0000-0000-0000-000000000001',
  '••••-••01', false
);
insert into public.room_members (room_id, user_id, joined_at) values
  ('62000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', now() - interval '1 hour'),
  ('62000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000002', now());

delete from auth.users where id = '61000000-0000-0000-0000-000000000001';
select is(
  (select owner_id from public.rooms where id = '62000000-0000-0000-0000-000000000001'),
  '61000000-0000-0000-0000-000000000002'::uuid,
  'account deletion transfers owned rooms to the earliest remaining member'
);
select is(
  (select count(*)::integer from public.room_members
   where user_id = '61000000-0000-0000-0000-000000000001'),
  0,
  'deleted account leaves every room'
);
select results_eq(
  $$select user_id is null, binding_state
    from private.app_store_transactions where transaction_id = '900000000000001'$$,
  $$values (true, 'unbound'::text)$$,
  'deleted account unbinds retained transaction audit data'
);
select is(
  (select count(*)::integer from public.commerce_entitlements
   where user_id = '61000000-0000-0000-0000-000000000001'),
  0,
  'deleted account has no public entitlements'
);

select lives_ok(
  $$select * from public.admin_apply_app_store_transaction(
      '61000000-0000-0000-0000-000000000003', '900000000000001',
      '900000000000001', 'character_guinea_pig',
      '61000000-0000-0000-0000-000000000001', 'Sandbox', 'active',
      now() - interval '1 minute', null, now() + interval '3 seconds', repeat('e', 64)
    )$$,
  'a transaction unbound by deletion can be restored to a new SIDEY account'
);
select is(
  (select user_id from private.app_store_transactions where transaction_id = '900000000000001'),
  '61000000-0000-0000-0000-000000000003'::uuid,
  'restored transaction is rebound to the new account'
);
select is(
  (select status from public.commerce_entitlements
   where user_id = '61000000-0000-0000-0000-000000000003'
     and entitlement_key = 'character:pixel_guinea_pig'),
  'active',
  'restored account receives active ownership'
);

select is(
  public.admin_record_app_store_notification(
    '63000000-0000-0000-0000-000000000001', 'REFUND', 'Sandbox',
    '900000000000001', now(), repeat('f', 64), 'processed'
  ),
  true,
  'first notification is recorded'
);
select is(
  public.admin_record_app_store_notification(
    '63000000-0000-0000-0000-000000000001', 'REFUND', 'Sandbox',
    '900000000000001', now(), repeat('f', 64), 'processed'
  ),
  false,
  'duplicate notification is idempotent'
);
select is(
  (select count(*)::integer from private.app_store_notification_events),
  1,
  'notification UUID remains unique'
);
select ok(
  not has_table_privilege('authenticated', 'private.app_store_transactions', 'select'),
  'authenticated clients cannot read private transaction identifiers'
);

select * from finish();
rollback;
