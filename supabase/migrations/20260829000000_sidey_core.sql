create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.hash_invite_code(value text)
returns bytea
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select extensions.digest(upper(replace(btrim(value), '-', '')), 'sha256');
$$;

create or replace function private.generate_invite_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select overlay(code placing '-' from 5 for 0)
  from (
    select upper(substr(translate(encode(extensions.gen_random_bytes(9), 'base64'), '/+=', 'XYZ'), 1, 8)) as code
  ) generated;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nickname text not null,
  character_id text not null default 'minty_pup',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_nickname_length check (char_length(btrim(nickname)) between 2 and 12),
  constraint profiles_nickname_single_line check (nickname !~ E'[\n\r\t]'),
  constraint profiles_character_id_format check (character_id ~ '^[a-z0-9_]{1,40}$')
);

create table public.rooms (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete restrict,
  invite_code_hash bytea not null unique,
  invite_code_hint text not null,
  invite_version integer not null default 1,
  created_at timestamptz not null default now(),
  constraint rooms_name_length check (char_length(btrim(name)) between 1 and 20),
  constraint rooms_name_single_line check (name !~ E'[\n\r\t]'),
  constraint rooms_invite_hint_length check (char_length(invite_code_hint) between 2 and 12),
  constraint rooms_invite_version_positive check (invite_version > 0)
);

create table public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index room_members_user_joined_idx on public.room_members (user_id, joined_at);

create table public.messages (
  id uuid primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  constraint messages_body_length check (char_length(btrim(body)) between 1 and 200),
  constraint messages_body_lines check (array_length(regexp_split_to_array(body, E'\n'), 1) <= 3),
  constraint messages_body_no_carriage_return check (body !~ E'\r')
);

create index messages_room_created_idx on public.messages (room_id, created_at desc);
create index messages_created_idx on public.messages (created_at);

create table private.invite_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now()
);

create index invite_attempts_user_time_idx on private.invite_attempts (user_id, attempted_at desc);

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.messages enable row level security;

create or replace function private.is_room_member(check_room_id uuid, check_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members
    where room_id = check_room_id and user_id = check_user_id
  );
$$;

create or replace function private.shares_room(first_user_id uuid, second_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members first_member
    join public.room_members second_member using (room_id)
    where first_member.user_id = first_user_id
      and second_member.user_id = second_user_id
  );
$$;

create or replace function private.can_access_room_topic(topic text, check_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  room_id_text text;
begin
  if topic !~ '^room:[0-9a-fA-F-]{36}$' then
    return false;
  end if;
  room_id_text := substr(topic, 6);
  return private.is_room_member(room_id_text::uuid, check_user_id);
exception when invalid_text_representation then
  return false;
end;
$$;

grant usage on schema public to authenticated;
revoke all on public.profiles, public.rooms, public.room_members, public.messages from anon, authenticated;
grant select on public.profiles, public.rooms, public.room_members, public.messages to authenticated;
grant execute on function private.is_room_member(uuid, uuid) to authenticated;
grant execute on function private.shares_room(uuid, uuid) to authenticated;
grant execute on function private.can_access_room_topic(text, uuid) to authenticated;

create policy profiles_select_room_peers
on public.profiles for select to authenticated
using (
  id = (select auth.uid())
  or private.shares_room((select auth.uid()), id)
);

create policy rooms_select_members
on public.rooms for select to authenticated
using (private.is_room_member(id, (select auth.uid())));

create policy room_members_select_members
on public.room_members for select to authenticated
using (private.is_room_member(room_id, (select auth.uid())));

create policy messages_select_members
on public.messages for select to authenticated
using (private.is_room_member(room_id, (select auth.uid())));

create or replace function public.upsert_profile(p_nickname text, p_character_id text default 'minty_pup')
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  saved_profile public.profiles;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if char_length(btrim(p_nickname)) not between 2 and 12 or p_nickname ~ E'[\n\r\t]' then
    raise exception using errcode = '22023', message = 'invalid_nickname';
  end if;
  if p_character_id !~ '^[a-z0-9_]{1,40}$' then
    raise exception using errcode = '22023', message = 'invalid_character_id';
  end if;
  insert into public.profiles (id, nickname, character_id)
  values (current_user_id, btrim(p_nickname), p_character_id)
  on conflict (id) do update
  set nickname = excluded.nickname,
      character_id = excluded.character_id,
      updated_at = now()
  returning * into saved_profile;

  return saved_profile;
end;
$$;

create or replace function public.create_room(p_name text)
returns table (room_id uuid, invite_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_profile public.profiles;
  generated_code text;
  created_room_id uuid;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if char_length(btrim(p_name)) not between 1 and 20 or p_name ~ E'[\n\r\t]' then
    raise exception using errcode = '22023', message = 'invalid_room_name';
  end if;
  select * into current_profile
  from public.profiles where id = current_user_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'profile_required';
  end if;
  if (select count(*) from public.room_members where user_id = current_user_id) >= 5 then
    raise exception using errcode = 'P0001', message = 'room_limit_reached';
  end if;

  generated_code := private.generate_invite_code();
  insert into public.rooms (name, owner_id, invite_code_hash, invite_code_hint)
  values (
    btrim(p_name),
    current_user_id,
    private.hash_invite_code(generated_code),
    '••••-••' || right(generated_code, 2)
  ) returning id into created_room_id;
  insert into public.room_members (room_id, user_id)
  values (created_room_id, current_user_id);
  return query select created_room_id, generated_code;
end;
$$;

create or replace function public.join_room(p_invite_code text)
returns table (room_id uuid, error_code text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_profile public.profiles;
  target_room public.rooms;
  recent_attempts integer;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  delete from private.invite_attempts where attempted_at < now() - interval '1 day';
  select count(*) into recent_attempts
  from private.invite_attempts
  where user_id = current_user_id and attempted_at >= now() - interval '10 minutes';
  if recent_attempts >= 10 then
    return query select null::uuid, 'invite_rate_limited'::text;
    return;
  end if;
  insert into private.invite_attempts (user_id) values (current_user_id);

  select * into target_room
  from public.rooms
  where invite_code_hash = private.hash_invite_code(p_invite_code)
  for update;
  if not found then
    return query select null::uuid, 'invalid_invite_code'::text;
    return;
  end if;
  if exists (
    select 1 from public.room_members members
    where members.room_id = target_room.id and members.user_id = current_user_id
  ) then
    return query select null::uuid, 'already_a_member'::text;
    return;
  end if;
  select * into current_profile
  from public.profiles where id = current_user_id for update;
  if not found then
    return query select null::uuid, 'profile_required'::text;
    return;
  end if;
  if (select count(*) from public.room_members members where members.user_id = current_user_id) >= 5 then
    return query select null::uuid, 'room_limit_reached'::text;
    return;
  end if;
  if (select count(*) from public.room_members members where members.room_id = target_room.id) >= 5 then
    return query select null::uuid, 'member_limit_reached'::text;
    return;
  end if;
  insert into public.room_members (room_id, user_id)
  values (target_room.id, current_user_id);
  return query select target_room.id, null::text;
end;
$$;

create or replace function public.rename_room(p_room_id uuid, p_name text)
returns public.rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_room public.rooms;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if char_length(btrim(p_name)) not between 1 and 20 or p_name ~ E'[\n\r\t]' then
    raise exception using errcode = '22023', message = 'invalid_room_name';
  end if;
  update public.rooms
  set name = btrim(p_name)
  where id = p_room_id and owner_id = auth.uid()
  returning * into saved_room;
  if not found then
    raise exception using errcode = '42501', message = 'owner_required';
  end if;
  return saved_room;
end;
$$;

create or replace function public.rotate_invite_code(p_room_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  generated_code text;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  generated_code := private.generate_invite_code();
  update public.rooms
  set invite_code_hash = private.hash_invite_code(generated_code),
      invite_code_hint = '••••-••' || right(generated_code, 2),
      invite_version = invite_version + 1
  where id = p_room_id and owner_id = auth.uid();
  if not found then
    raise exception using errcode = '42501', message = 'owner_required';
  end if;
  return generated_code;
end;
$$;

create or replace function public.leave_room(p_room_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_owner_id uuid;
  next_owner_id uuid;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select owner_id into current_owner_id
  from public.rooms where id = p_room_id for update;
  if not found or not private.is_room_member(p_room_id, current_user_id) then
    raise exception using errcode = '42501', message = 'membership_required';
  end if;
  delete from public.room_members where room_id = p_room_id and user_id = current_user_id;
  select user_id into next_owner_id
  from public.room_members
  where room_id = p_room_id
  order by joined_at, user_id
  limit 1;
  if next_owner_id is null then
    delete from public.rooms where id = p_room_id;
    return null;
  end if;
  if current_owner_id = current_user_id then
    update public.rooms set owner_id = next_owner_id where id = p_room_id;
  end if;
  return next_owner_id;
end;
$$;

create or replace function public.remove_room_member(p_room_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_user_id = auth.uid() then
    raise exception using errcode = '22023', message = 'owner_must_leave';
  end if;
  if not exists (
    select 1 from public.rooms where id = p_room_id and owner_id = auth.uid()
  ) then
    raise exception using errcode = '42501', message = 'owner_required';
  end if;
  delete from public.room_members where room_id = p_room_id and user_id = p_user_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'member_not_found';
  end if;
end;
$$;

create or replace function public.send_message(p_id uuid, p_room_id uuid, p_body text)
returns public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_message public.messages;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if not private.is_room_member(p_room_id, auth.uid()) then
    raise exception using errcode = '42501', message = 'membership_required';
  end if;
  if char_length(btrim(p_body)) not between 1 and 200
     or array_length(regexp_split_to_array(p_body, E'\n'), 1) > 3
     or p_body ~ E'\r' then
    raise exception using errcode = '22023', message = 'invalid_message_body';
  end if;
  insert into public.messages (id, room_id, sender_id, body)
  values (p_id, p_room_id, auth.uid(), btrim(p_body))
  returning * into saved_message;
  return saved_message;
end;
$$;

revoke all on function public.upsert_profile(text, text) from public, anon;
revoke all on function public.create_room(text) from public, anon;
revoke all on function public.join_room(text) from public, anon;
revoke all on function public.rename_room(uuid, text) from public, anon;
revoke all on function public.rotate_invite_code(uuid) from public, anon;
revoke all on function public.leave_room(uuid) from public, anon;
revoke all on function public.remove_room_member(uuid, uuid) from public, anon;
revoke all on function public.send_message(uuid, uuid, text) from public, anon;
grant execute on function public.upsert_profile(text, text) to authenticated;
grant execute on function public.create_room(text) to authenticated;
grant execute on function public.join_room(text) to authenticated;
grant execute on function public.rename_room(uuid, text) to authenticated;
grant execute on function public.rotate_invite_code(uuid) to authenticated;
grant execute on function public.leave_room(uuid) to authenticated;
grant execute on function public.remove_room_member(uuid, uuid) to authenticated;
grant execute on function public.send_message(uuid, uuid, text) to authenticated;

create or replace function private.delete_expired_messages()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
begin
  delete from public.messages where created_at < now() - interval '30 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function private.delete_stale_anonymous_users()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
begin
  delete from auth.users users
  where users.is_anonymous is true
    and users.created_at < now() - interval '7 days'
    and not exists (
      select 1 from public.room_members where user_id = users.id
    );
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

select cron.schedule(
  'sidey-delete-expired-messages',
  '15 3 * * *',
  $$select private.delete_expired_messages();$$
);

select cron.schedule(
  'sidey-delete-stale-anonymous-users',
  '45 3 * * *',
  $$select private.delete_stale_anonymous_users();$$
);
