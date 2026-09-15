begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

insert into auth.users (
  id, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
)
values
  ('61000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"anonymous","providers":["anonymous"]}', '{}', true, now(), now()),
  ('61000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"anonymous","providers":["anonymous"]}', '{}', true, now(), now()),
  ('61000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"anonymous","providers":["anonymous"]}', '{}', true, now(), now());

select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000001', true);
select public.upsert_profile('던지는친구', 'pixel_penguin');
create temporary table throw_room (room_id uuid, invite_code text);
grant select on throw_room to authenticated;
insert into throw_room select room_id, invite_code from public.create_room('던지기 테스트');

select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000002', true);
select public.upsert_profile('맞는친구', 'pixel_cat');
select * from public.join_room((select invite_code from throw_room));

select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000003', true);
select public.upsert_profile('바깥친구', 'pixel_rabbit');

select ok(
  has_function_privilege(
    'authenticated',
    'public.broadcast_character_throw(uuid,bigint,uuid,uuid)',
    'execute'
  ),
  'authenticated clients can call the dedicated character throw RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.broadcast_character_throw(uuid,bigint,uuid,uuid)',
    'execute'
  ),
  'anon cannot call the character throw RPC'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select throws_ok(
  $$select public.broadcast_character_throw(
      (select room_id from throw_room), 1,
      '62000000-0000-0000-0000-000000000001',
      '61000000-0000-0000-0000-000000000002'
    )$$,
  '42501', 'authentication_required', 'authentication is required'
);

select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.broadcast_character_throw(
      (select room_id from throw_room),
      (select realtime_epoch from public.rooms where id = (select room_id from throw_room)),
      null, '61000000-0000-0000-0000-000000000002'
    )$$,
  '22023', 'event_id_required', 'event UUID is required'
);
select throws_ok(
  $$select public.broadcast_character_throw(
      (select room_id from throw_room),
      (select realtime_epoch from public.rooms where id = (select room_id from throw_room)),
      '62000000-0000-0000-0000-000000000002', null
    )$$,
  '22023', 'target_user_id_required', 'target UUID is required'
);
select throws_ok(
  $$select public.broadcast_character_throw(
      (select room_id from throw_room),
      (select realtime_epoch from public.rooms where id = (select room_id from throw_room)),
      '62000000-0000-0000-0000-000000000003',
      '61000000-0000-0000-0000-000000000001'
    )$$,
  '22023', 'self_target_forbidden', 'self targeting is rejected'
);
select throws_ok(
  $$select public.broadcast_character_throw(
      (select room_id from throw_room), 1,
      '62000000-0000-0000-0000-000000000004',
      '61000000-0000-0000-0000-000000000002'
    )$$,
  'PT409', 'stale_realtime_epoch', 'stale room epoch is rejected without a retryable SQLSTATE'
);
select throws_ok(
  $$select public.broadcast_character_throw(
      (select room_id from throw_room),
      (select realtime_epoch from public.rooms where id = (select room_id from throw_room)),
      '62000000-0000-0000-0000-000000000005',
      '61000000-0000-0000-0000-000000000003'
    )$$,
  '42501', 'target_membership_required', 'target must be a current room member'
);

select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000003', true);
select throws_ok(
  $$select public.broadcast_character_throw(
      (select room_id from throw_room),
      (select realtime_epoch from public.rooms where id = (select room_id from throw_room)),
      '62000000-0000-0000-0000-000000000006',
      '61000000-0000-0000-0000-000000000002'
    )$$,
  '42501', 'membership_required', 'actor must be a current room member'
);

select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.broadcast_character_throw(
      (select room_id from throw_room),
      (select realtime_epoch from public.rooms where id = (select room_id from throw_room)),
      '62000000-0000-0000-0000-000000000007',
      '61000000-0000-0000-0000-000000000002'
    )$$,
  'valid throw is accepted'
);
set local role postgres;
select is(
  (select payload - 'id' from realtime.messages where event = 'character_throw'
   order by inserted_at desc limit 1),
  jsonb_build_object(
    'schema_version', 1,
    'room_id', (select room_id from throw_room),
    'event_id', '62000000-0000-0000-0000-000000000007'::uuid,
    'actor_user_id', '61000000-0000-0000-0000-000000000001'::uuid,
    'target_user_id', '61000000-0000-0000-0000-000000000002'::uuid,
    'source_character_id', 'pixel_penguin',
    'throwable_id', 'patch_soft_ball'
  ),
  'Broadcast contains validated v1 identifiers, server character and the shared default ball'
);
select ok(
  (select not (payload ?| array['x', 'y', 'source_x', 'source_y', 'target_x', 'target_y'])
   from realtime.messages where event = 'character_throw'
   order by inserted_at desc limit 1),
  'Broadcast never contains screen coordinates'
);
select is(
  (select topic from realtime.messages where event = 'character_throw'
   order by inserted_at desc limit 1),
  (select private.room_topic(id, realtime_epoch, 'ephemeral')
   from public.rooms where id = (select room_id from throw_room)),
  'throw uses the current private ephemeral topic'
);

set local role postgres;
delete from private.realtime_event_attempts
where user_id = '61000000-0000-0000-0000-000000000001'
  and event_name = 'character_throw';
insert into private.realtime_event_attempts (user_id, room_id, event_name)
select '61000000-0000-0000-0000-000000000001',
       (select room_id from throw_room), 'character_throw'
from generate_series(1, 20);
set local role authenticated;
select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.broadcast_character_throw(
      (select room_id from throw_room),
      (select realtime_epoch from public.rooms where id = (select room_id from throw_room)),
      '62000000-0000-0000-0000-000000000008',
      '61000000-0000-0000-0000-000000000002'
    )$$,
  'P0001', 'realtime_event_rate_limited', 'sender is limited to 20 throws per 10 seconds'
);

select * from finish();
rollback;
