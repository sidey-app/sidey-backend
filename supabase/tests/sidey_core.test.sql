begin;

-- Linked tests connect as a temporary member of `postgres`; assume that role
-- explicitly so pgTAP in the extensions schema is visible, just like local runs.
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(55);

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  raw_app_meta_data,
  raw_user_meta_data,
  is_anonymous,
  created_at,
  updated_at
)
select
  ('00000000-0000-0000-0000-' || lpad(number::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  '{"provider":"anonymous","providers":["anonymous"]}'::jsonb,
  '{}'::jsonb,
  true,
  case when number = 24 then now() - interval '8 days' else now() end,
  now()
from generate_series(1, 24) number;

do $$
declare
  number integer;
begin
  for number in 1..23 loop
    perform set_config(
      'request.jwt.claim.sub',
      ('00000000-0000-0000-0000-' || lpad(number::text, 12, '0'))::uuid::text,
      true
    );
    perform public.upsert_profile(
      case when number = 1 then '민트' else '친구' || number::text end,
      'pixel_hamster'
    );
  end loop;
end;
$$;

select has_column('public', 'profiles', 'nickname', 'profile stores a display nickname');
select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), 'profiles RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.rooms'::regclass), 'rooms RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.room_members'::regclass), 'room members RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.messages'::regclass), 'messages RLS enabled');
select ok(has_function_privilege('authenticated', 'public.create_room(text)', 'execute'), 'authenticated can call room RPC');

create temporary table test_rooms (
  label text primary key,
  room_id uuid not null,
  invite_code text not null,
  rotated_code text
);
grant select on test_rooms to authenticated;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
insert into test_rooms (label, room_id, invite_code)
select 'main', room_id, invite_code from public.create_room('메인 그룹');
insert into test_rooms (label, room_id, invite_code)
select 'extra-1', room_id, invite_code from public.create_room('추가 1');
insert into test_rooms (label, room_id, invite_code)
select 'extra-2', room_id, invite_code from public.create_room('추가 2');
insert into test_rooms (label, room_id, invite_code)
select 'extra-3', room_id, invite_code from public.create_room('추가 3');
insert into test_rooms (label, room_id, invite_code)
select 'rotation', room_id, invite_code from public.create_room('코드 회전');

select is(
  (select count(*)::integer from public.room_members where user_id = '00000000-0000-0000-0000-000000000001'),
  5,
  'user can belong to five rooms'
);
select throws_ok(
  $$select * from public.create_room('여섯 번째')$$,
  'P0001',
  'room_limit_reached',
  'sixth room is rejected'
);

do $$
declare
  number integer;
  code text := (select invite_code from test_rooms where label = 'main');
begin
  for number in 2..12 loop
    perform set_config(
      'request.jwt.claim.sub',
      ('00000000-0000-0000-0000-' || lpad(number::text, 12, '0'))::uuid::text,
      true
    );
    perform public.join_room(code);
  end loop;
end;
$$;

select is(
  (select count(*)::integer from public.room_members where room_id = (select room_id from test_rooms where label = 'main')),
  12,
  'room accepts twelve members'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select results_eq(
  $$select error_code from public.join_room((select invite_code from test_rooms where label = 'main'))$$,
  $$values ('member_limit_reached'::text)$$,
  'thirteenth room member is rejected'
);
select is(
  (select count(distinct profiles.character_id)::integer
   from public.profiles
   join public.room_members on room_members.user_id = profiles.id
   where room_members.room_id = (select room_id from test_rooms where label = 'main')),
  1,
  'same character is allowed for every room member'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.upsert_profile('무료친구', 'pixel_guinea_pig')$$,
  '42501',
  'character_ownership_required',
  'new paid character is rejected without an entitlement'
);

set local role postgres;
insert into public.commerce_entitlements (
  user_id, entitlement_key, source_order_id, status, grant_kind, grant_reference
)
select '00000000-0000-0000-0000-000000000002'::uuid,
       entitlement_key,
       null,
       'active',
       'complimentary',
       'sidey-core-pgtap'
from unnest(array[
  'character:pixel_guinea_pig',
  'character:pixel_monkey',
  'character:pixel_chinchilla'
]) entitlement_key;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);

select lives_ok(
  $$select public.upsert_profile(' 민 트 ', 'pixel_hamster')$$,
  'duplicate nickname is allowed in the same room'
);
select lives_ok(
  $$select public.upsert_profile('가나다라마바사아', 'pixel_hamster')$$,
  'eight-character nickname is accepted'
);
select lives_ok(
  $$
    do $body$
    declare
      character_id text;
    begin
      foreach character_id in array array['pixel_guinea_pig', 'pixel_monkey', 'pixel_chinchilla'] loop
        perform public.upsert_profile('무료친구', character_id);
      end loop;
    end;
    $body$
  $$,
  'all three new paid character ids are selectable with complimentary entitlements'
);
select is(
  (select character_id from public.upsert_profile('무료친구', 'pixel_koala')),
  'pixel_chinchilla',
  'legacy koala id is normalized to the corrected chinchilla id'
);
select throws_ok(
  $$select public.upsert_profile('가나다라마바사아자', 'pixel_hamster')$$,
  '22023',
  'invalid_nickname',
  'nine-character nickname is rejected'
);
select lives_ok(
  $$
    do $body$
    begin
      perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
      perform public.upsert_profile('민트', 'pixel_hamster');
      perform public.create_room('다른 민트 그룹');
    end;
    $body$
  $$,
  'same nickname is allowed in a different room'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$select public.send_message(
    '10000000-0000-0000-0000-000000000001',
    (select room_id from test_rooms where label = 'main'),
    '안녕'
  )$$,
  'room member can send a valid message'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select is(
  (select count(*)::integer from public.messages where room_id = (select room_id from test_rooms where label = 'main')),
  1,
  'room member reads room messages through RLS'
);
select is(
  (select count(*)::integer from public.profiles),
  12,
  'room member sees only profiles sharing a room'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000021', true);
select is(
  (select count(*)::integer from public.messages where room_id = (select room_id from test_rooms where label = 'main')),
  0,
  'outsider cannot read room messages'
);
select is(
  (select count(*)::integer from public.rooms where id = (select room_id from test_rooms where label = 'main')),
  0,
  'outsider cannot read room metadata'
);
select is((select count(*)::integer from public.profiles), 1, 'outsider sees only their own profile');
select throws_like(
  $$insert into public.messages (id, room_id, sender_id, body)
    values (
      '10000000-0000-0000-0000-000000000099',
      (select room_id from test_rooms where label = 'main'),
      '00000000-0000-0000-0000-000000000021',
      '권한 없음'
    )$$,
  '%permission denied for table messages%',
  'direct message insert is denied'
);
set local role postgres;

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.send_message(
    '10000000-0000-0000-0000-000000000002',
    (select room_id from test_rooms where label = 'main'),
    E'1\n2\n3\n4'
  )$$,
  '22023',
  'invalid_message_body',
  'four-line message is rejected'
);
select throws_ok(
  $$select public.send_message(
    '10000000-0000-0000-0000-000000000003',
    (select room_id from test_rooms where label = 'main'),
    repeat('a', 201)
  )$$,
  '22023',
  'invalid_message_body',
  '201-character message is rejected'
);
select lives_ok(
  $$select public.send_message(
    '10000000-0000-0000-0000-000000000001',
    (select room_id from test_rooms where label = 'main'),
    '안녕'
  )$$,
  'same client message UUID makes retransmission idempotent'
);

update test_rooms
set rotated_code = public.rotate_invite_code(room_id)
where label = 'rotation';
select is(
  (select code_version from private.room_invites where room_id = (select room_id from test_rooms where label = 'rotation')),
  2,
  'invite rotation increments version'
);
select isnt(
  (select private.hash_invite_code(invite_code) from test_rooms where label = 'rotation'),
  (select code_hash from private.room_invites where room_id = (select room_id from test_rooms where label = 'rotation')),
  'invite rotation changes stored hash'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000007', true);
select results_eq(
  $$select error_code from public.join_room((select invite_code from test_rooms where label = 'rotation'))$$,
  $$values ('invalid_invite_code'::text)$$,
  'old invite code is invalid immediately after rotation'
);
select results_eq(
  $$select room_id, error_code from public.join_room((select rotated_code from test_rooms where label = 'rotation'))$$,
  $$select room_id, null::text from test_rooms where label = 'rotation'$$,
  'new invite code joins the room'
);
select ok(
  (select encode(code_hash, 'hex') not like '%' || lower(invite_code) || '%'
   from private.room_invites
   join test_rooms on test_rooms.room_id = room_invites.room_id
   where test_rooms.label = 'rotation'),
  'invite plaintext is not stored'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
select is(
  public.leave_room((select room_id from test_rooms where label = 'main')),
  '00000000-0000-0000-0000-000000000002'::uuid,
  'owner leave returns earliest remaining member'
);
select is(
  (select owner_id from public.rooms where id = (select room_id from test_rooms where label = 'main')),
  '00000000-0000-0000-0000-000000000002'::uuid,
  'owner transfers to earliest remaining member'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
select throws_ok(
  $$select public.remove_room_member(
    (select room_id from test_rooms where label = 'main'),
    '00000000-0000-0000-0000-000000000005'
  )$$,
  '42501',
  'owner_required',
  'non-owner cannot remove a member'
);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
select lives_ok(
  $$select public.remove_room_member(
    (select room_id from test_rooms where label = 'main'),
    '00000000-0000-0000-0000-000000000005'
  )$$,
  'owner removes a member'
);
select is(
  (select count(*)::integer from public.room_members where room_id = (select room_id from test_rooms where label = 'main')),
  10,
  'removed member no longer belongs to room'
);

insert into public.messages (id, room_id, sender_id, body, created_at)
values
  (
    '10000000-0000-0000-0000-000000000010',
    (select room_id from test_rooms where label = 'main'),
    '00000000-0000-0000-0000-000000000002',
    '4일 전 메시지 하나',
    now() - interval '4 days'
  ),
  (
    '10000000-0000-0000-0000-000000000011',
    (select room_id from test_rooms where label = 'main'),
    '00000000-0000-0000-0000-000000000002',
    '4일 전 메시지 둘',
    now() - interval '4 days'
  ),
  (
    '10000000-0000-0000-0000-000000000012',
    (select room_id from test_rooms where label = 'extra-1'),
    '00000000-0000-0000-0000-000000000001',
    '다른 방의 4일 전 메시지',
    now() - interval '4 days'
  ),
  (
    '10000000-0000-0000-0000-000000000013',
    (select room_id from test_rooms where label = 'main'),
    '00000000-0000-0000-0000-000000000002',
    '2일 전 메시지',
    now() - interval '2 days'
  );
select is(private.delete_expired_messages(), 3::bigint, 'retention deletes messages older than 3 days');
select is(
  (select count(*)::integer from public.messages
   where id in (
     '10000000-0000-0000-0000-000000000010',
     '10000000-0000-0000-0000-000000000011',
     '10000000-0000-0000-0000-000000000012'
   )),
  0,
  'retention removes every message beyond the 3-day boundary'
);
select is(
  (select count(*)::integer from public.messages where id = '10000000-0000-0000-0000-000000000013'),
  1,
  'retention preserves a 2-day-old message'
);
select is(
  (select count(*)::integer from public.messages where id = '10000000-0000-0000-0000-000000000001'),
  1,
  'retention preserves current messages'
);
select is(
  (select count(*)::integer from realtime.messages
   where event = 'messages_pruned'
     and payload ->> 'room_id' = (select room_id::text from test_rooms where label = 'main')),
  1,
  'retention emits one invalidation for a changed room even when it deletes multiple messages'
);
select is(
  (select count(*)::integer from realtime.messages
   where event = 'messages_pruned'
     and payload ->> 'room_id' = (select room_id::text from test_rooms where label = 'extra-1')),
  1,
  'retention emits one invalidation for each other changed room'
);

select ok(
  private.can_access_room_topic(
    'room:' || (select id::text || ':' || realtime_epoch::text || ':db'
                from public.rooms where id = (select room_id from test_rooms where label = 'main')),
    '00000000-0000-0000-0000-000000000002'
  ),
  'room member can access private Realtime topic'
);
select ok(
  not private.can_access_room_topic(
    'room:' || (select id::text || ':' || realtime_epoch::text || ':db'
                from public.rooms where id = (select room_id from test_rooms where label = 'main')),
    '00000000-0000-0000-0000-000000000021'
  ),
  'outsider cannot access private Realtime topic'
);
select ok(
  exists (select 1 from pg_policies where schemaname = 'realtime' and policyname = 'sidey_room_channels_select'),
  'Realtime private channel select policy exists'
);
select ok(
  exists (select 1 from pg_policies where schemaname = 'realtime' and policyname = 'sidey_room_channels_insert'),
  'Realtime private channel insert policy exists'
);

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000023', true);
do $$
begin
  for attempt in 1..10 loop
    perform public.join_room('BAD-CODE');
  end loop;
end;
$$;
select results_eq(
  $$select error_code from public.join_room('BAD-CODE')$$,
  $$values ('invite_rate_limited'::text)$$,
  'invite attempts are rate limited'
);
select is(
  (select count(*)::integer from private.invite_attempts where user_id = '00000000-0000-0000-0000-000000000023'),
  10,
  'failed invite attempts persist for rate limiting'
);
select is(private.delete_stale_anonymous_users(), 1::bigint, 'stale groupless anonymous user is cleaned up');
select is(
  (select count(*)::integer from auth.users where id = '00000000-0000-0000-0000-000000000024'),
  0,
  'stale anonymous user row is removed'
);
select hasnt_column('public', 'rooms', 'invite_code_hash', 'invite hash is absent from the Data API table');
select ok(not has_table_privilege('authenticated', 'public.messages', 'insert'), 'authenticated has no direct message insert grant');
select ok(not has_table_privilege('anon', 'public.profiles', 'select'), 'unauthenticated role cannot read profiles');

select * from finish();
rollback;
