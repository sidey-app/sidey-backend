begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

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
) values
  (
    'b1000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    '{"provider":"anonymous","providers":["anonymous"]}',
    '{}',
    true,
    now(),
    now()
  ),
  (
    'b1000000-0000-4000-8000-000000000002',
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
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  now(),
  now()
);

select set_config(
  'request.jwt.claim.sub',
  'b1000000-0000-4000-8000-000000000001',
  true
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b1000000-0000-4000-8000-000000000001',
    'session_id', 'b2000000-0000-4000-8000-000000000001',
    'exp', extract(epoch from now() + interval '1 hour')
  )::text,
  true
);
select public.upsert_profile('브리지 발신자', 'pixel_penguin');
create temporary table bridge_room as
select * from public.create_room('mixed version bridge');

select set_config(
  'request.jwt.claim.sub',
  'b1000000-0000-4000-8000-000000000002',
  true
);
select set_config('request.jwt.claims', '{}', true);
select public.upsert_profile('브리지 수신자', 'pixel_hamster');
select * from public.join_room((select invite_code from bridge_room));

insert into private.firebase_live_users(user_id, enabled) values
  ('b1000000-0000-4000-8000-000000000001', true),
  ('b1000000-0000-4000-8000-000000000002', true);
insert into private.firebase_live_rooms(room_id, enabled)
select room_id, true from bridge_room;
update private.firebase_live_config
set enabled = true,
    direct_events_enabled = true;

select set_config(
  'request.jwt.claim.sub',
  'b1000000-0000-4000-8000-000000000001',
  true
);
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', 'b1000000-0000-4000-8000-000000000001',
    'session_id', 'b2000000-0000-4000-8000-000000000001',
    'exp', extract(epoch from now() + interval '1 hour')
  )::text,
  true
);
select is(
  public.prepare_firebase_live_lease()->>'enabled',
  'true',
  'sender receives a live Firebase lease'
);

truncate private.firebase_live_outbox;
delete from realtime.messages
where topic = (
  select private.room_topic(id, realtime_epoch, 'ephemeral')
  from public.rooms
  where id = (select room_id from bridge_room)
);
delete from realtime.messages
where topic = (
  select private.room_topic(id, realtime_epoch, 'db')
  from public.rooms
  where id = (select room_id from bridge_room)
);

-- Durable and structural source events also have to reach both generations.
-- Postgres remains authoritative; Broadcast is the legacy invalidation signal.
select public.send_message(
  'b4000000-0000-4000-8000-000000000001',
  (select room_id from bridge_room),
  '호환 브리지 메시지'
);
select private.route_realtime(
  jsonb_build_object('room_id', (select room_id from bridge_room)),
  'messages_pruned',
  (
    select private.room_topic(id, realtime_epoch, 'db')
    from public.rooms
    where id = (select room_id from bridge_room)
  ),
  true
);
select private.route_realtime(
  jsonb_build_object(
    'room_id', (select room_id from bridge_room),
    'entity', 'profiles',
    'operation', 'UPDATE'
  ),
  'structure_changed',
  (
    select private.room_topic(id, realtime_epoch, 'db')
    from public.rooms
    where id = (select room_id from bridge_room)
  ),
  true
);
select is(
  (
    select count(*)::integer
    from realtime.messages
    where event in ('message_changed', 'messages_pruned', 'structure_changed')
      and topic = (
        select private.room_topic(id, realtime_epoch, 'db')
        from public.rooms
        where id = (select room_id from bridge_room)
      )
  ),
  3,
  'durable and structural invalidations reach legacy clients once each'
);
select is(
  (
    select count(*)::integer
    from private.firebase_live_outbox
    where kind in ('message_changed', 'messages_pruned', 'structure_changed')
  ),
  3,
  'durable and structural invalidations retain the staging live outbox route once each'
);

truncate private.firebase_live_outbox;
delete from realtime.messages
where topic = (
  select private.room_topic(id, realtime_epoch, 'db')
  from public.rooms
  where id = (select room_id from bridge_room)
);

-- Old -> new: each public legacy RPC emits one private Broadcast consumed by
-- both released and Firebase-aware clients. The staging live outbox remains
-- non-authoritative and retains the caller UUID for its isolated experiment.
select public.broadcast_room_event(
  (select room_id from bridge_room),
  (select realtime_epoch from public.rooms where id = (select room_id from bridge_room)),
  'typing_start',
  'b3000000-0000-4000-8000-000000000001'
);
select public.broadcast_room_event(
  (select room_id from bridge_room),
  (select realtime_epoch from public.rooms where id = (select room_id from bridge_room)),
  'typing_stop',
  'b3000000-0000-4000-8000-000000000002'
);
select public.broadcast_room_event(
  (select room_id from bridge_room),
  (select realtime_epoch from public.rooms where id = (select room_id from bridge_room)),
  'character_pulse',
  'b3000000-0000-4000-8000-000000000003'
);
select public.broadcast_character_throw(
  (select room_id from bridge_room),
  (select realtime_epoch from public.rooms where id = (select room_id from bridge_room)),
  'b3000000-0000-4000-8000-000000000004',
  'b1000000-0000-4000-8000-000000000002'
);

select is(
  (
    select count(*)::integer
    from realtime.messages
    where event in ('typing_start', 'typing_stop', 'character_pulse', 'character_throw')
      and payload->>'event_id' like 'b3000000-0000-4000-8000-00000000000%'
  ),
  4,
  'legacy RPCs reach old clients through private Broadcast'
);
select ok(
  not exists (
    select 1
    from realtime.messages
    where event in ('typing_start', 'typing_stop', 'character_pulse', 'character_throw')
      and payload->>'event_id' like 'b3000000-0000-4000-8000-00000000000%'
      and not private
  ),
  'legacy fan-out stays on private topics'
);
select is(
  (
    select count(*)::integer
    from private.firebase_live_outbox
    where event_id between
      'b3000000-0000-4000-8000-000000000001'::uuid
      and 'b3000000-0000-4000-8000-000000000004'::uuid
  ),
  4,
  'legacy RPCs retain exactly one staging outbox row per authorized UUID'
);
select is(
  (
    select count(distinct event_id)::integer
    from private.firebase_live_outbox
    where event_id between
      'b3000000-0000-4000-8000-000000000001'::uuid
      and 'b3000000-0000-4000-8000-000000000004'::uuid
  ),
  4,
  'staging outbox preserves each source event UUID without duplicates'
);

truncate private.firebase_live_outbox;
delete from realtime.messages
where topic = (
  select private.room_topic(id, realtime_epoch, 'ephemeral')
  from public.rooms
  where id = (select room_id from bridge_room)
);

create function pg_temp.direct_bridge_event(
  p_kind text,
  p_event_id uuid,
  p_sequence text default null,
  p_target_user_id uuid default null
)
returns jsonb
language sql
as $$
  select public.authorize_firebase_direct_event(
    (select room_id from bridge_room),
    (select realtime_epoch from public.rooms where id = (select room_id from bridge_room)),
    p_event_id,
    p_kind,
    p_target_user_id,
    p_sequence
  )
$$;

-- If the staging direct experiment is explicitly enabled, its authorization
-- mirrors once to Supabase while its Edge Function remains the sole writer for
-- that obsolete namespace and therefore gets no outbox copy.
create temporary table direct_results as
select pg_temp.direct_bridge_event(
  'typing_start',
  'b3000000-0000-4000-8000-000000000005',
  '10'
) as result
union all
select pg_temp.direct_bridge_event(
  'typing_stop',
  'b3000000-0000-4000-8000-000000000006',
  '11'
)
union all
select pg_temp.direct_bridge_event(
  'character_pulse',
  'b3000000-0000-4000-8000-000000000007'
)
union all
select pg_temp.direct_bridge_event(
  'character_throw',
  'b3000000-0000-4000-8000-000000000008',
  null,
  'b1000000-0000-4000-8000-000000000002'
);

select is(
  (
    select count(*)::integer
    from direct_results
    where result->>'event_id' between
      'b3000000-0000-4000-8000-000000000005'
      and 'b3000000-0000-4000-8000-000000000008'
  ),
  4,
  'staging direct authorization returns every source UUID once'
);
select is(
  (
    select count(*)::integer
    from realtime.messages
    where event in ('typing_start', 'typing_stop', 'character_pulse', 'character_throw')
      and payload->>'event_id' between
        'b3000000-0000-4000-8000-000000000005'
        and 'b3000000-0000-4000-8000-000000000008'
  ),
  4,
  'direct Firebase events reach old clients through private Broadcast'
);
select is(
  (select count(*)::integer from private.firebase_live_outbox),
  0,
  'staging direct path never creates a duplicate live-outbox enqueue'
);
select throws_ok(
  $$select pg_temp.direct_bridge_event(
      'typing_start',
      'b3000000-0000-4000-8000-000000000005',
      '12'
    )$$,
  'PT409',
  'duplicate_event',
  'direct retry is rejected before a second legacy Broadcast'
);
select is(
  (
    select count(*)::integer
    from realtime.messages
    where payload->>'event_id' = 'b3000000-0000-4000-8000-000000000005'
  ),
  1,
  'direct retry does not duplicate legacy delivery'
);

select * from finish();
rollback;
