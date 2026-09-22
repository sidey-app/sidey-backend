begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

select is(
  (select publisher_url from private.firebase_live_dispatch_config where id),
  null,
  'production-safe publisher endpoint ships unconfigured'
);
select throws_ok(
  $$select private.enqueue_firebase_live_dispatch(
      'f1000000-0000-4000-8000-000000000001',
      'synthetic-only-private-scheduler-secret-32'
    )$$,
  'P0001',
  'firebase_dispatch_endpoint_unconfigured',
  'an unconfigured environment cannot enqueue to the recovered staging endpoint'
);
select throws_ok(
  $$update private.firebase_live_dispatch_config
    set publisher_url = 'https://example.invalid/realtime-publish-live'
    where id$$,
  '23514',
  null,
  'publisher endpoint is restricted to a Supabase project function URL'
);
select ok(
  not has_schema_privilege('anon', 'private', 'usage')
  and not has_schema_privilege('authenticated', 'private', 'usage'),
  'Data API roles cannot access the private Firebase schema'
);
select ok(
  not has_function_privilege('anon', 'public.create_room_v2(text)', 'execute')
  and has_function_privilege('authenticated', 'public.create_room_v2(text)', 'execute')
  and not has_function_privilege('anon', 'public.current_firebase_access_revision()', 'execute')
  and has_function_privilege('authenticated', 'public.get_store_state_v2()', 'execute'),
  'only authenticated clients can use additive grant-barrier RPCs'
);

insert into auth.users(
  id, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
) values
  ('f2000000-0000-4000-8000-000000000001',
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   '{"provider":"anonymous","providers":["anonymous"]}', '{}', true, now(), now()),
  ('f2000000-0000-4000-8000-000000000002',
   '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated',
   '{"provider":"anonymous","providers":["anonymous"]}', '{}', true, now(), now());

select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-000000000001', true);
select public.upsert_profile('혼합방파베', 'pixel_hamster');
create temporary table compatibility_room as
  select room_id, invite_code, "accessRevision"
  from public.create_room_v2('mixed compatibility');
select ok(
  (select "accessRevision" ~ '^[0-9]{20}$' from compatibility_room),
  'create v2 returns the exact fixed-width access revision'
);

select is(
  pg_get_function_result('public.send_message(uuid,uuid,text)'::regprocedure),
  'legacy_message_response',
  'legacy send_message remains a scalar composite instead of a set-returning envelope'
);
select is(
  (
    select string_agg(attributes.attname, ',' order by attributes.attnum)
    from pg_type as types
    join pg_class as classes on classes.oid = types.typrelid
    join pg_attribute as attributes on attributes.attrelid = classes.oid
    where types.typnamespace = 'public'::regnamespace
      and types.typname = 'legacy_message_response'
      and attributes.attnum > 0
      and not attributes.attisdropped
  ),
  'id,room_id,sender_id,body,created_at,bubble_style_id',
  'legacy send_message scalar composite keeps the exact six released keys'
);

create temporary table legacy_send_response as
  select to_jsonb(sent) as result
  from public.send_message(
    'f3000000-0000-4000-8000-000000000001',
    (select room_id from compatibility_room),
    'legacy response contract'
  ) as sent;
select is(
  (
    select array_agg(keys.key order by keys.key)
    from legacy_send_response,
         lateral jsonb_object_keys(result) as keys(key)
  ),
  array['body', 'bubble_style_id', 'created_at', 'id', 'room_id', 'sender_id']::text[],
  'legacy send_message response keeps its exact six released fields'
);
select ok(
  not (select result ? 'sequence' from legacy_send_response),
  'legacy send_message does not expose the additive Firebase sequence'
);

select set_config('request.jwt.claim.sub', 'f2000000-0000-4000-8000-000000000002', true);
select public.upsert_profile('혼합방레거시', 'pixel_hamster');
create temporary table compatibility_join as
  select * from public.join_room_v2((select invite_code from compatibility_room));
select ok(
  (select room_id is not null and error_code is null
    and "accessRevision" ~ '^[0-9]{20}$' from compatibility_join),
  'join v2 returns its committed access revision without changing legacy RPC shape'
);

select ok(
  public.current_firebase_access_revision() >=
    (select "accessRevision" from compatibility_join),
  'post-purchase fallback can obtain a monotonic grant barrier revision'
);
select ok(
  (select bool_and(
     (product_kind = 'character' and "wireCode" is null)
     or (product_kind in ('bubble', 'throwable') and "wireCode" is not null)
   ) from public.get_store_state_v2()),
  'v2 store state exposes the exact server wire-code mapping'
);

insert into private.firebase_access_outbox(user_id)
values ('f2000000-0000-4000-8000-000000000001')
on conflict (user_id) do nothing;

delete from realtime.messages
where event = 'structure_changed';

select private.rotate_user_presence_epochs(
  'f2000000-0000-4000-8000-000000000001'
);

select is(
  (select count(*)::integer
   from realtime.messages
   where event = 'structure_changed'
     and payload->>'room_id' = (select room_id::text from compatibility_room)),
  1,
  'mixed room receives a legacy epoch-change notification on Firebase session revocation'
);
select is(
  (select count(*)::integer
   from private.firebase_room_revision_outbox
   where room_id = (select room_id from compatibility_room)
     and pending_since is not null),
  1,
  'the same rotation still enqueues the Firebase room revision'
);

select * from finish();
rollback;
