begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(25);

insert into auth.users (
  id, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
)
select ('81000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated', 'authenticated', '{"provider":"google","providers":["google"]}'::jsonb,
  '{}'::jsonb, false, now(), now()
from generate_series(1, 4) n;
insert into public.profiles (id, nickname, character_id)
select id, '나무친구', 'pixel_hamster' from auth.users
where id::text like '81000000-0000-0000-0000-%' and right(id::text, 1) <> '4';
select set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-000000000001', true);
create temporary table tree_room as select * from public.create_room('나무 정지');
grant select on tree_room to authenticated;
select set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-000000000002', true);
select * from public.join_room((select invite_code from tree_room));

select ok(not has_function_privilege('anon', 'public.set_tree_movement_paused(boolean,bigint)', 'execute'),
  'anonymous clients cannot call movement RPC');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'tree_movement_paused', 'update'),
  'direct paused updates cannot bypass RPC');
select ok(not has_column_privilege('authenticated', 'public.profiles', 'tree_movement_revision', 'update'),
  'direct revision updates cannot bypass RPC');
select set_config('request.jwt.claim.sub', '', true);
select throws_ok($$select public.set_tree_movement_paused(true, 0)$$,
  '42501', 'authentication_required', 'RPC requires authenticated identity');

set local role authenticated;
select set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-000000000004', true);
select throws_ok($$select public.set_tree_movement_paused(false, 0)$$,
  'P0002', 'profile_required', 'RPC requires an existing profile');
select set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.set_tree_movement_paused(null, 0)$$,
  '22023', 'invalid_tree_movement_state', 'null desired state is rejected');
select throws_ok($$select public.set_tree_movement_paused(true, null)$$,
  '22023', 'invalid_tree_movement_state', 'null revision is rejected');
select throws_ok($$select public.set_tree_movement_paused(true, -1)$$,
  '22023', 'invalid_tree_movement_state', 'negative revision is rejected');
select is((select tree_movement_revision from public.profiles where id = auth.uid()), 0::bigint,
  'legacy profiles start uninitialized');
select is((select tree_movement_paused from public.profiles where id = auth.uid()), false,
  'legacy default remains moving');
select is((select tree_movement_revision from public.set_tree_movement_paused(false, 0)), 1::bigint,
  'initial false preference still claims initialization');
select is((select tree_movement_revision from public.set_tree_movement_paused(false, 1)), 1::bigint,
  'same desired state is idempotent');
select is((select tree_movement_paused from public.set_tree_movement_paused(true, 0)), false,
  'late legacy migration cannot overwrite initialized state');
select is((select tree_movement_revision from public.set_tree_movement_paused(true, 1)), 2::bigint,
  'state change advances exactly one revision');
select is((select tree_movement_revision from public.set_tree_movement_paused(true, 1)), 2::bigint,
  'retry with old revision returns winner unchanged');
select is((select tree_movement_paused from public.set_tree_movement_paused(false, 1)), true,
  'stale conflicting response cannot change winner');
select is((select tree_movement_revision from public.set_tree_movement_paused(false, 99)), 2::bigint,
  'future revision cannot skip server history');
select throws_ok($$update public.profiles set tree_movement_paused=false where id=auth.uid()$$,
  '42501', 'permission denied for table profiles', 'direct profile PATCH is denied');
select is((select tree_movement_paused from public.upsert_profile('새이름', 'pixel_cat')), true,
  'nickname and character changes preserve movement preference');
select is((select tree_movement_revision from public.profiles where id=auth.uid()), 2::bigint,
  'nickname and character changes preserve movement revision');

select set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-000000000002', true);
select is((select to_jsonb(profiles)->'tree_movement_paused' from public.profiles
  where id='81000000-0000-0000-0000-000000000001'), 'true'::jsonb,
  'room peer snapshot exposes server preference');
select is((select to_jsonb(profiles)->'tree_movement_revision' from public.profiles
  where id='81000000-0000-0000-0000-000000000001'), '2'::jsonb,
  'room peer snapshot exposes revision');
select is((select id from public.set_tree_movement_paused(true, 0)), auth.uid(),
  'RPC only writes current identity');
select is((select tree_movement_revision from public.profiles
  where id='81000000-0000-0000-0000-000000000001'), 2::bigint,
  'other device account cannot mutate peer state');
select set_config('request.jwt.claim.sub', '81000000-0000-0000-0000-000000000003', true);
select is((select count(*)::integer from public.profiles
  where id='81000000-0000-0000-0000-000000000001'), 0,
  'nonmember cannot read private peer movement');
select * from finish();
rollback;
