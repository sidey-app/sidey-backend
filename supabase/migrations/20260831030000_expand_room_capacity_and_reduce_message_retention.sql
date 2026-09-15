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
  if (select count(*) from public.room_members members where members.room_id = target_room.id) >= 12 then
    return query select null::uuid, 'member_limit_reached'::text;
    return;
  end if;
  insert into public.room_members (room_id, user_id)
  values (target_room.id, current_user_id);
  return query select target_room.id, null::text;
end;
$$;

create or replace function private.delete_expired_messages()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
begin
  delete from public.messages where created_at < now() - interval '7 days';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Enforce the shorter retention window immediately when this migration is applied;
-- the existing daily cron job keeps calling the replaced function afterward.
select private.delete_expired_messages();
