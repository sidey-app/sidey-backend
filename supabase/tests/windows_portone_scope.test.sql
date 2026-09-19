begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(10);
select is((select count(*)::integer from public.commerce_products where portone_sale_enabled), 24, 'only existing Windows products permit PortOne sales');
select is((select count(*)::integer from public.commerce_products where active and not portone_sale_enabled), 9, 'future nine products remain excluded from PortOne');
select is((select count(*)::integer from public.commerce_products where active), 33, 'Apple catalog remains intact');
select ok(not has_function_privilege('anon', 'public.get_windows_store_state()', 'execute'), 'anonymous store RPC denied');
select ok(has_function_privilege('authenticated', 'public.get_windows_store_state()', 'execute'), 'authenticated Windows store allowed');
select throws_ok($$select * from public.get_windows_store_state()$$, '42501', 'authentication_required', 'store still requires a real auth identity');
select is((select sales_enabled from private.commerce_runtime_settings), false, 'migration does not enable sales');
insert into auth.users(id, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data, is_anonymous, created_at, updated_at)
values ('29000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
'authenticated','authenticated','{"provider":"google","providers":["google"]}','{}',false,now(),now());
select set_config('request.jwt.claim.sub','29000000-0000-0000-0000-000000000001',true);
select public.upsert_profile('결제검증', 'pixel_hamster');
update private.commerce_runtime_settings set sales_enabled=true;
select is((select count(*)::integer from public.get_windows_store_state()), 24, 'Windows RPC returns precisely current products');
select throws_ok($$select * from public.create_commerce_order('character_shiba',repeat('a',64))$$,
  'P0001','commerce_product_unavailable','future product cannot bypass Windows UI with a raw RPC');
select lives_ok($$select * from public.create_commerce_order('character_tree',repeat('b',64))$$,
  'existing product order is still permitted');
select * from finish();
rollback;
