-- Local-only bounded fixture for migration lock/backfill safety, not a load test.
begin;

insert into auth.users(
  id, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
) values (
  'ee000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  '{"provider":"anonymous","providers":["anonymous"]}',
  '{}',
  true,
  now(),
  now()
);

insert into public.profiles(id, nickname, character_id)
values (
  'ee000000-0000-4000-8000-000000000001',
  '리허설사용자',
  'pixel_hamster'
);

insert into public.rooms(id, name, owner_id, invite_code_hint, invite_code_ready)
select extensions.gen_random_uuid(),
       '리허설' || room_number,
       'ee000000-0000-4000-8000-000000000001',
       '리허설-' || lpad(room_number::text, 3, '0'),
       false
from generate_series(1, 20) as room_number;

insert into public.room_members(room_id, user_id)
select rooms.id, 'ee000000-0000-4000-8000-000000000001'
from public.rooms as rooms
where rooms.owner_id = 'ee000000-0000-4000-8000-000000000001';

insert into public.messages(id, room_id, sender_id, body, created_at)
select extensions.gen_random_uuid(),
       rooms.id,
       'ee000000-0000-4000-8000-000000000001',
       'lock-safety fixture',
       clock_timestamp() - make_interval(secs => message_number)
from public.rooms as rooms
cross join generate_series(1, 1000) as message_number
where rooms.owner_id = 'ee000000-0000-4000-8000-000000000001';

commit;
