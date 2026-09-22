begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select plan(10);
select has_table('private','firebase_hint_outbox','Firebase outbox remains private');
select has_table('private','firebase_shadow_leases','Firebase lease lifecycle is server owned');
select ok(not has_table_privilege('authenticated','private.firebase_hint_outbox','select'),
  'app cannot inspect or acknowledge the outbox');
select ok(not has_table_privilege('authenticated','private.firebase_shadow_users','insert'),
  'app cannot opt itself into shadow');
select ok(not has_function_privilege('anon','public.prepare_firebase_shadow_lease()','execute'),
  'anonymous bootstrap is denied');
select ok(has_function_privilege('authenticated','public.prepare_firebase_shadow_lease()','execute'),
  'authenticated bootstrap uses checked UID and session');
select ok(not has_function_privilege('authenticated','public.claim_firebase_hints(uuid,integer)','execute'),
  'app cannot act as publisher');
select ok(has_function_privilege('service_role','public.claim_firebase_hints(uuid,integer)','execute'),
  'service publisher can claim');
select is((select count(*)::integer from pg_trigger where tgname like 'zz_firebase_%' and tgenabled='D'),3,
  'all capture triggers ship disabled');
select is((select count(*)::integer from private.firebase_shadow_users),0,
  'migration does not enroll any production user');
select * from finish();
rollback;
