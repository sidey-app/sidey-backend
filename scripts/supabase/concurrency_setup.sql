\set ON_ERROR_STOP on

begin;

insert into auth.users (
  id, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
)
select
  ('30000000-0000-0000-0000-' || lpad(number::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  '{"provider":"anonymous","providers":["anonymous"]}'::jsonb,
  '{}'::jsonb,
  true,
  now(),
  now()
from generate_series(1, 40) number
where number between 1 and 7
   or number between 11 and 22
   or number in (30, 40);

insert into public.profiles (id, nickname, character_id)
select
  id,
  '경합' || right(id::text, 2),
  'pixel_hamster'
from auth.users
where id::text like '30000000-0000-0000-0000-%';

insert into public.rooms (id, name, owner_id, invite_code_hint, invite_code_ready)
select
  ('40000000-0000-0000-0000-' || lpad(number::text, 12, '0'))::uuid,
  '경합 방 ' || number,
  ('30000000-0000-0000-0000-' || lpad(number::text, 12, '0'))::uuid,
  '••••••••-' || lpad(number::text, 4, '0'),
  true
from generate_series(1, 7) number;

insert into private.room_invites (room_id, code_hash)
select
  id,
  private.hash_invite_code(
    '00000000-00000000-00000000-' || right(id::text, 8)
  )
from public.rooms
where id::text like '40000000-0000-0000-0000-%';

insert into public.room_members (room_id, user_id)
select
  ('40000000-0000-0000-0000-' || lpad(number::text, 12, '0'))::uuid,
  ('30000000-0000-0000-0000-' || lpad(number::text, 12, '0'))::uuid
from generate_series(1, 7) number;

-- User 40 starts in four rooms. Two simultaneous joins must leave exactly
-- one additional membership.
insert into public.room_members (room_id, user_id)
select
  ('40000000-0000-0000-0000-' || lpad(number::text, 12, '0'))::uuid,
  '30000000-0000-0000-0000-000000000040'::uuid
from generate_series(1, 4) number;

-- Room 7 starts with eleven members: owner 7 plus users 11...20. Users 21
-- and 22 race for the last slot.
insert into public.room_members (room_id, user_id)
select
  '40000000-0000-0000-0000-000000000007'::uuid,
  ('30000000-0000-0000-0000-' || lpad(number::text, 12, '0'))::uuid
from generate_series(11, 20) number;

-- User 30 starts at nine attempts. Two simultaneous invalid joins must add
-- only one row and rate-limit the other transaction.
insert into private.invite_attempts (user_id)
select '30000000-0000-0000-0000-000000000030'::uuid
from generate_series(1, 9);

commit;

-- Widen the count-to-insert race only for transactions that explicitly opt in.
-- Correct server-side locks serialize the second transaction before it reaches
-- this trigger. Without those locks, both transactions sleep after observing
-- the same stale count and the assertions in test_concurrency.sh fail.
create or replace function private.sidey_concurrency_pause_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('sidey.concurrency_test', true) = 'on' then
    perform pg_sleep(0.5);
  end if;
  return new;
end;
$$;

create trigger sidey_concurrency_pause_room_members
before insert on public.room_members
for each row execute function private.sidey_concurrency_pause_before_insert();

create trigger sidey_concurrency_pause_invite_attempts
before insert on private.invite_attempts
for each row execute function private.sidey_concurrency_pause_before_insert();
