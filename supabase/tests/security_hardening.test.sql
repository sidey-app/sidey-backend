begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(32);

select hasnt_column('public', 'rooms', 'invite_code_hash', 'public rooms never expose invite hashes');
select hasnt_column('public', 'rooms', 'invite_version', 'public rooms never expose invite versions');
select has_table('private', 'room_invites', 'invite verifiers live in the private schema');
select ok(
  not has_table_privilege('authenticated', 'private.room_invites', 'select'),
  'authenticated cannot read private invite verifiers'
);

insert into auth.users (
  id, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"anonymous","providers":["anonymous"]}', '{}', true, now(), now()),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"anonymous","providers":["anonymous"]}', '{}', true, now(), now()),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"anonymous","providers":["anonymous"]}', '{}', true,
   now() - interval '8 days', now()),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"anonymous","providers":["anonymous"]}', '{}', true,
   now() - interval '8 days', now());

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select public.upsert_profile('방장', 'pixel_hamster');
create temporary table hardening_room (room_id uuid, invite_code text, epoch_before_join bigint);
insert into hardening_room (room_id, invite_code)
select room_id, invite_code from public.create_room('보안 테스트');
update hardening_room
set epoch_before_join = (select realtime_epoch from public.rooms where id = hardening_room.room_id);

select is(length(invite_code), 35, 'v2 invite code contains 128 bits encoded as grouped hex')
from hardening_room;
select matches(replace(invite_code, '-', ''), '^[0-9A-F]{32}$', 'v2 invite code uses a stable human-safe format')
from hardening_room;
select ok((select invite_code_ready from public.rooms where id = (select room_id from hardening_room)), 'new invite is marked ready');
select ok(
  (select octet_length(code_hash) = 32 from private.room_invites where room_id = (select room_id from hardening_room)),
  'private verifier is a 256-bit HMAC'
);

select ok(
  private.can_access_room_topic(
    (select private.room_topic(id, realtime_epoch, 'db')
     from public.rooms where id = (select room_id from hardening_room)),
    '10000000-0000-0000-0000-000000000001'
  ),
  'member can read the current DB epoch topic'
);
select ok(
  private.can_access_room_topic(
    (select private.room_topic(id, realtime_epoch, 'ephemeral')
     from public.rooms where id = (select room_id from hardening_room)),
    '10000000-0000-0000-0000-000000000001'
  ),
  'member can read the current ephemeral epoch topic'
);
select ok(
  not private.can_access_room_topic(
    'room:' || (select room_id::text from hardening_room),
    '10000000-0000-0000-0000-000000000001'
  ),
  'legacy unversioned topic is rejected'
);
select ok(
  not private.can_access_room_topic(
    (select private.room_topic(id, realtime_epoch + 1, 'db')
     from public.rooms where id = (select room_id from hardening_room)),
    '10000000-0000-0000-0000-000000000001'
  ),
  'wrong epoch topic is rejected'
);
select ok(
  not private.can_access_room_topic(
    (select private.room_topic(id, realtime_epoch, 'db')
     from public.rooms where id = (select room_id from hardening_room)),
    '10000000-0000-0000-0000-000000000002'
  ),
  'outsider cannot read a current topic'
);
select ok(
  (select with_check ilike '%presence%' and with_check not ilike '%broadcast%'
   from pg_policies
   where schemaname = 'realtime' and policyname = 'sidey_room_channels_insert'),
  'socket INSERT policy permits Presence but no client Broadcast'
);

select set_config(
  'sidey.test_ephemeral_topic',
  (select private.room_topic(id, realtime_epoch, 'ephemeral')
   from public.rooms where id = (select room_id from hardening_room)),
  true
);
select set_config(
  'sidey.test_db_topic',
  (select private.room_topic(id, realtime_epoch, 'db')
   from public.rooms where id = (select room_id from hardening_room)),
  true
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select set_config('realtime.topic', current_setting('sidey.test_ephemeral_topic'), true);
select lives_ok(
  $$insert into realtime.messages (topic, extension, event, private, payload)
    values (current_setting('sidey.test_ephemeral_topic'), 'presence', 'track', true, '{}'::jsonb)$$,
  'member can write Presence to the current ephemeral topic'
);
select throws_like(
  $$insert into realtime.messages (topic, extension, event, private, payload)
    values (current_setting('sidey.test_ephemeral_topic'), 'broadcast', 'INSERT', true, '{}'::jsonb)$$,
  '%row-level security%',
  'member cannot write any client Broadcast'
);
select set_config('realtime.topic', current_setting('sidey.test_db_topic'), true);
select throws_like(
  $$insert into realtime.messages (topic, extension, event, private, payload)
    values (current_setting('sidey.test_db_topic'), 'presence', 'track', true, '{}'::jsonb)$$,
  '%row-level security%',
  'member cannot write Presence to the DB topic'
);
select set_config('realtime.topic', current_setting('sidey.test_ephemeral_topic'), true);
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select throws_like(
  $$insert into realtime.messages (topic, extension, event, private, payload)
    values (current_setting('sidey.test_ephemeral_topic'), 'presence', 'track', true, '{}'::jsonb)$$,
  '%row-level security%',
  'authenticated outsider cannot write to another room topic'
);
set local role anon;
select throws_like(
  $$insert into realtime.messages (topic, extension, event, private, payload)
    values (current_setting('sidey.test_ephemeral_topic'), 'presence', 'track', true, '{}'::jsonb)$$,
  '%row-level security%',
  'anon cannot write Realtime Presence'
);
set local role postgres;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);

select ok(
  has_function_privilege(
    'authenticated',
    'public.broadcast_room_event(uuid,bigint,text,uuid)',
    'execute'
  ),
  'authenticated clients can call the validated transient-event RPC'
);
select throws_ok(
  $$select public.broadcast_room_event(
      (select room_id from hardening_room),
      (select realtime_epoch from public.rooms where id = (select room_id from hardening_room)),
      'INSERT',
      null
    )$$,
  '22023',
  'invalid_realtime_event',
  'DB-shaped Realtime event names are rejected'
);
select throws_ok(
  $$select public.broadcast_room_event(
      (select room_id from hardening_room), 999999, 'typing_start', null
    )$$,
  'PT409',
  'stale_realtime_epoch',
  'stale epoch cannot publish transient events'
);
select lives_ok(
  $$select public.broadcast_room_event(
      (select room_id from hardening_room),
      (select realtime_epoch from public.rooms where id = (select room_id from hardening_room)),
      'typing_start',
      null
    )$$,
  'validated member typing event is accepted'
);
select lives_ok(
  $$select public.send_message(
      '20000000-0000-0000-0000-000000000001',
      (select room_id from hardening_room),
      '멱등 메시지'
    )$$,
  'first message send succeeds'
);
select ok(
  (select not (payload ?| array['body', 'sender_id', 'created_at'])
   from realtime.messages
   where event = 'message_changed'
   order by inserted_at desc
   limit 1),
  'message Broadcast contains identifiers only'
);
select ok(
  not exists (
    select 1 from realtime.messages
    where payload ? 'invite_code_hash' or payload ? 'code_hash'
  ),
  'Realtime payloads never expose invite verifiers'
);
select lives_ok(
  $$select public.send_message(
      '20000000-0000-0000-0000-000000000001',
      (select room_id from hardening_room),
      '멱등 메시지'
    )$$,
  'same UUID and body retry succeeds idempotently'
);
select throws_ok(
  $$select public.send_message(
      '20000000-0000-0000-0000-000000000001',
      (select room_id from hardening_room),
      '다른 본문'
    )$$,
  '23505',
  'message_id_conflict',
  'same UUID cannot be reused for different content'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select public.upsert_profile('친구', 'pixel_cat');
select * from public.join_room((select invite_code from hardening_room));
select ok(
  (select realtime_epoch > epoch_before_join
   from public.rooms join hardening_room on hardening_room.room_id = rooms.id),
  'membership change advances the room epoch'
);
select ok(
  not private.can_access_room_topic(
    (select private.room_topic(room_id, epoch_before_join, 'db') from hardening_room),
    '10000000-0000-0000-0000-000000000001'
  ),
  'previous epoch becomes inaccessible after membership change'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000004', true);
select public.upsert_profile('기존 사용자', 'pixel_rabbit');
select is(private.delete_stale_anonymous_users(), 1::bigint, 'cleanup deletes only stale incomplete signup');
select ok(
  exists (select 1 from auth.users where id = '10000000-0000-0000-0000-000000000004'),
  'stale groupless user with a profile is preserved'
);

select * from finish();
rollback;
