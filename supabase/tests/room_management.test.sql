begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(19);

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
  ('10000000-0000-0000-0000-' || lpad(number::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  '{"provider":"anonymous","providers":["anonymous"]}'::jsonb,
  '{}'::jsonb,
  true,
  now(),
  now()
from generate_series(1, 4) number;

do $$
declare
  number integer;
begin
  for number in 1..4 loop
    perform set_config(
      'request.jwt.claim.sub',
      ('10000000-0000-0000-0000-' || lpad(number::text, 12, '0'))::uuid::text,
      true
    );
    perform public.upsert_profile('관리' || number::text, 'pixel_hamster');
  end loop;
end;
$$;

create temporary table room_management_fixture (
  room_id uuid not null,
  invite_code text not null
);
grant select on room_management_fixture to authenticated;

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
insert into room_management_fixture (room_id, invite_code)
select room_id, invite_code from public.create_room('관리 테스트');

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
do $$ begin
  perform public.join_room((select invite_code from room_management_fixture));
end $$;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
do $$ begin
  perform public.join_room((select invite_code from room_management_fixture));
end $$;

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
do $$ begin
  perform public.send_message(
    '20000000-0000-0000-0000-000000000001',
    (select room_id from room_management_fixture),
    '삭제될 메시지'
  );
end $$;

select ok(
  has_function_privilege('authenticated', 'public.delete_room(uuid)', 'execute'),
  'authenticated can call delete_room'
);
select ok(
  not has_function_privilege('anon', 'public.delete_room(uuid)', 'execute'),
  'anonymous users cannot call delete_room'
);
select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), 'profiles RLS remains enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.rooms'::regclass), 'rooms RLS remains enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.room_members'::regclass), 'room members RLS remains enabled');

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000002', true);
select throws_ok(
  $$select public.rename_room((select room_id from room_management_fixture), '권한 없음')$$,
  '42501',
  'owner_required',
  'non-owner cannot rename room'
);
select throws_ok(
  $$select public.delete_room((select room_id from room_management_fixture))$$,
  '42501',
  'owner_required',
  'non-owner cannot delete room'
);
select throws_ok(
  $$select public.remove_room_member(
    (select room_id from room_management_fixture),
    '10000000-0000-0000-0000-000000000003'
  )$$,
  '42501',
  'owner_required',
  'non-owner cannot remove a member'
);

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select throws_ok(
  $$select public.rename_room((select room_id from room_management_fixture), E'잘못된\n이름')$$,
  '22023',
  'invalid_room_name',
  'owner cannot save an invalid room name'
);
select lives_ok(
  $$select public.rename_room((select room_id from room_management_fixture), '  바뀐 이름  ')$$,
  'owner renames room'
);
select is(
  (select name from public.rooms where id = (select room_id from room_management_fixture)),
  '바뀐 이름',
  'renamed room is trimmed and persisted'
);
select throws_ok(
  $$select public.remove_room_member(
    (select room_id from room_management_fixture),
    '10000000-0000-0000-0000-000000000001'
  )$$,
  '22023',
  'owner_must_leave',
  'owner cannot remove self'
);
select throws_ok(
  $$select public.remove_room_member(
    (select room_id from room_management_fixture),
    '10000000-0000-0000-0000-000000000004'
  )$$,
  'P0001',
  'member_not_found',
  'missing member cannot be removed'
);
select lives_ok(
  $$select public.remove_room_member(
    (select room_id from room_management_fixture),
    '10000000-0000-0000-0000-000000000003'
  )$$,
  'owner removes another member'
);
select is(
  (select count(*)::integer
   from public.room_members
   where room_id = (select room_id from room_management_fixture)
     and user_id = '10000000-0000-0000-0000-000000000003'),
  0,
  'removed member no longer has membership'
);

select lives_ok(
  $$select public.delete_room((select room_id from room_management_fixture))$$,
  'owner deletes room'
);
select is(
  (select count(*)::integer from public.rooms
   where id = (select room_id from room_management_fixture)),
  0,
  'deleted room row is gone'
);
select is(
  (select count(*)::integer from public.room_members
   where room_id = (select room_id from room_management_fixture)),
  0,
  'room deletion cascades to memberships'
);
select is(
  (select count(*)::integer from public.messages
   where room_id = (select room_id from room_management_fixture)),
  0,
  'room deletion cascades to messages'
);

select * from finish();
rollback;
