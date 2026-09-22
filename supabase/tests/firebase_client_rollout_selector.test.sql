begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

select ok(
  not has_table_privilege(
    'authenticated',
    'private.firebase_client_rollout_config',
    'select'
  )
  and not has_table_privilege(
    'authenticated',
    'private.firebase_client_session_capabilities',
    'select'
  ),
  'client cannot inspect or mutate private rollout state directly'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.register_realtime_capability_v2(text,text,integer,text)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.register_realtime_capability_v2(text,text,integer,text)',
    'execute'
  ),
  'rollout selector is authenticated only'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.firebase_client_capability_summary(timestamptz)',
    'execute'
  )
  and has_function_privilege(
    'service_role',
    'public.firebase_client_capability_summary(timestamptz)',
    'execute'
  ),
  'capability aggregates are service-role only'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.firebase_realtime_bootstrap_authorization(uuid,uuid)',
    'execute'
  )
  and has_function_privilege(
    'service_role',
    'public.firebase_realtime_bootstrap_authorization(uuid,uuid)',
    'execute'
  ),
  'bootstrap rollout authorization is service-role only'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.configure_firebase_client_rollout_v2(boolean,boolean,integer)',
    'execute'
  )
  and has_function_privilege(
    'service_role',
    'public.configure_firebase_client_rollout_v2(boolean,boolean,integer)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.firebase_client_rollout_state_v2()',
    'execute'
  )
  and has_function_privilege(
    'service_role',
    'public.firebase_client_rollout_state_v2()',
    'execute'
  ),
  'rollout mutation and exact read-back are service-role only'
);

insert into auth.users(
  id,
  instance_id,
  aud,
  role,
  raw_app_meta_data,
  raw_user_meta_data,
  is_anonymous,
  created_at,
  updated_at
) values (
  'c1000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  '{"provider":"anonymous","providers":["anonymous"]}',
  '{}',
  true,
  now(),
  now()
);
insert into auth.sessions(id, user_id, created_at, updated_at)
values (
  'c2000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  now(),
  now()
);

select set_config(
  'request.jwt.claim.sub',
  'c1000000-0000-4000-8000-000000000001',
  true
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c1000000-0000-4000-8000-000000000001',
    'session_id', 'c2000000-0000-4000-8000-000000000001',
    'exp', extract(epoch from now() + interval '1 hour')
  )::text,
  true
);

create temporary table disabled_selection as
select public.register_realtime_capability_v2(
  'macos',
  '2.0.0-100',
  2,
  '3c836b40cfc44437e9d069b84787cd3d8793026ce40de46d82b9ece79127b7e5'
) as result;
select is(
  (select result->>'transport' from disabled_selection),
  'legacy_supabase',
  'default kill switch explicitly selects the legacy transport'
);
select is(
  (select result->>'failureMode' from disabled_selection),
  'fail_closed_if_last_enabled',
  'selector publishes the cache failure contract'
);
select is(
  (select count(*)::integer
   from private.firebase_client_session_capabilities
   where session_id = 'c2000000-0000-4000-8000-000000000001'
     and platform = 'macos'
     and app_version = '2.0.0-100'
     and not last_selected_enabled),
  1,
  'selector records only the caller current session capability'
);
select is(
  public.firebase_realtime_bootstrap_authorization(
    'c1000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001'
  )->>'allowed',
  'false',
  'bootstrap remains denied while the rollout singleton is disabled'
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c1000000-0000-4000-8000-000000000001',
    'session_id', 'c2000000-0000-4000-8000-000000000001',
    'role', 'service_role',
    'exp', extract(epoch from now() + interval '1 hour')
  )::text,
  true
);
create temporary table operator_mutation as
select public.configure_firebase_client_rollout_v2(true, false, 10000) as result;
select is(
  (select result from operator_mutation),
  public.firebase_client_rollout_state_v2(),
  'operator mutation response equals an independent exact singleton read-back'
);
select throws_ok(
  $$select public.configure_firebase_client_rollout_v2(false, false, 0)$$,
  '22023',
  'invalid_rollout_state',
  'operator cannot publish an ambiguous disabled state'
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'c1000000-0000-4000-8000-000000000001',
    'session_id', 'c2000000-0000-4000-8000-000000000001',
    'exp', extract(epoch from now() + interval '1 hour')
  )::text,
  true
);

update private.firebase_client_rollout_config
set enabled = true, kill_switch = false, cohort_basis_points = 10000,
    updated_at = clock_timestamp() where id;

create temporary table enabled_selection as
select public.register_realtime_capability_v2(
  'macos',
  '2.0.0-100',
  2,
  '3c836b40cfc44437e9d069b84787cd3d8793026ce40de46d82b9ece79127b7e5'
) as result;
select is(
  (select result->>'enabled' from enabled_selection),
  'true',
  'matching v2 capability in the enabled cohort selects Firebase v2'
);
select is(
  (select result->>'transport' from enabled_selection),
  'firebase_v2',
  'enabled response uses the exact Firebase transport identifier'
);
select is(
  (select result->>'cacheTtlSeconds' from enabled_selection),
  '300',
  'selector publishes a bounded five minute cache TTL'
);
select ok(
  (public.firebase_realtime_bootstrap_authorization(
    'c1000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001'
  )->>'allowed')::boolean,
  'bootstrap authorization accepts only the selected current session'
);
select ok(
  (public.firebase_realtime_bootstrap_authorization(
    'c1000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001'
  )->>'leaseExpiresAt')::bigint
    between floor(extract(epoch from clock_timestamp()) * 1000)::bigint
      and floor(extract(epoch from clock_timestamp() + interval '5 minutes') * 1000)::bigint,
  'bootstrap authorization issues at most a five minute server lease'
);

update private.firebase_client_rollout_config
set kill_switch = true,
    updated_at = clock_timestamp()
where id;
select is(
  public.firebase_realtime_bootstrap_authorization(
    'c1000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001'
  )->>'allowed',
  'false',
  'kill switch immediately blocks every new bootstrap lease'
);
update private.firebase_client_rollout_config
set kill_switch = false,
    updated_at = clock_timestamp()
where id;

update private.firebase_client_session_capabilities
set last_seen_at = clock_timestamp() - interval '301 seconds'
where session_id = 'c2000000-0000-4000-8000-000000000001';
select is(
  public.firebase_realtime_bootstrap_authorization(
    'c1000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001'
  )->>'allowed',
  'false',
  'stale selector capability cannot mint a new Firebase lease'
);

select is(
  public.register_realtime_capability_v2(
    'macos',
    '2.0.0-100',
    2,
    repeat('0', 64)
  )->>'transport',
  'legacy_supabase',
  'contract mismatch cannot enter the Firebase cohort'
);
select throws_ok(
  $$select public.register_realtime_capability_v2(
      'ios',
      '2.0.0',
      2,
      '3c836b40cfc44437e9d069b84787cd3d8793026ce40de46d82b9ece79127b7e5'
    )$$,
  '22023',
  'invalid_client_capability',
  'unsupported platform is rejected before capability mutation'
);

delete from auth.sessions
where id = 'c2000000-0000-4000-8000-000000000001';
select is(
  (select count(*)::integer
   from private.firebase_client_session_capabilities
   where session_id = 'c2000000-0000-4000-8000-000000000001'),
  0,
  'session deletion cascades capability cleanup'
);

select * from finish();
rollback;
