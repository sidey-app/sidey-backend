begin;
-- Realtime Authorization is evaluated when a private Presence channel is
-- joined. A session or account revocation therefore has to invalidate the
-- room epoch as well as the Firebase access mirror; deleting the session row
-- alone cannot evict an already-authorized channel.
create function private.has_active_presence_identity(check_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.sessions as sessions
    join auth.users as users on users.id = sessions.user_id
    where sessions.id = nullif(auth.jwt()->>'session_id', '')::uuid
      and sessions.user_id = check_user_id
      and (sessions.not_after is null or sessions.not_after > clock_timestamp())
      and (users.banned_until is null or users.banned_until <= clock_timestamp())
  );
$$;
revoke all on function private.has_active_presence_identity(uuid)
  from public, anon, authenticated, service_role;
create or replace function private.can_read_user_presence_topic(
  topic text,
  check_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  parts text[];
  parsed_room_id uuid;
  parsed_epoch bigint;
  parsed_target_user_id uuid;
begin
  parts := regexp_match(
    topic,
    '^presence:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):([1-9][0-9]*):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'
  );
  if parts is null or check_user_id is null then
    return false;
  end if;

  parsed_room_id := parts[1]::uuid;
  parsed_epoch := parts[2]::bigint;
  parsed_target_user_id := parts[3]::uuid;
  if not private.has_active_presence_identity(check_user_id) then
    return false;
  end if;

  return exists (
    select 1
    from public.rooms as rooms
    join public.room_members as viewer
      on viewer.room_id = rooms.id
     and viewer.user_id = check_user_id
    join public.room_members as target
      on target.room_id = rooms.id
     and target.user_id = parsed_target_user_id
    where rooms.id = parsed_room_id
      and rooms.realtime_epoch = parsed_epoch
  );
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$$;
create or replace function private.can_write_user_presence_topic(
  topic text,
  check_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  parts text[];
  parsed_room_id uuid;
  parsed_epoch bigint;
  parsed_target_user_id uuid;
begin
  parts := regexp_match(
    topic,
    '^presence:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):([1-9][0-9]*):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$'
  );
  if parts is null or check_user_id is null then
    return false;
  end if;

  parsed_room_id := parts[1]::uuid;
  parsed_epoch := parts[2]::bigint;
  parsed_target_user_id := parts[3]::uuid;
  if parsed_target_user_id is distinct from check_user_id
     or not private.has_active_presence_identity(check_user_id) then
    return false;
  end if;

  return exists (
    select 1
    from public.rooms as rooms
    join public.room_members as members
      on members.room_id = rooms.id
     and members.user_id = check_user_id
    where rooms.id = parsed_room_id
      and rooms.realtime_epoch = parsed_epoch
  );
exception
  when invalid_text_representation or numeric_value_out_of_range then
    return false;
end;
$$;
revoke all on function private.can_read_user_presence_topic(text, uuid),
  private.can_write_user_presence_topic(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function private.can_read_user_presence_topic(text, uuid),
  private.can_write_user_presence_topic(text, uuid)
  to authenticated;
-- Only users enrolled in the Firebase access mirror can be using the v2
-- Presence path. Restricting rotation to that cohort avoids waking every room
-- for legacy-only session churn during staging.
create function private.rotate_user_presence_epochs(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_room_id uuid;
begin
  if p_user_id is null or not exists (
    select 1
    from private.firebase_access_outbox as access_outbox
    where access_outbox.user_id = p_user_id
  ) then
    return;
  end if;

  for affected_room_id in
    select members.room_id
    from public.room_members as members
    where members.user_id = p_user_id
    order by members.room_id
  loop
    -- The Firebase personal inbox is the migration notification path. Do not
    -- also emit the legacy room-record broadcast for this internal epoch bump.
    perform set_config('sidey.suppress_room_broadcast', 'on', true);
    update public.rooms as rooms
    set realtime_epoch = rooms.realtime_epoch + 1
    where rooms.id = affected_room_id;
    perform set_config('sidey.suppress_room_broadcast', 'off', true);

    perform private.enqueue_firebase_room_revision(affected_room_id);
  end loop;
end;
$$;
revoke all on function private.rotate_user_presence_epochs(uuid)
  from public, anon, authenticated, service_role;
create function private.capture_presence_authority_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_user_id uuid;
  new_user_id uuid;
  affected_user_id uuid;
begin
  if tg_table_name = 'sessions' then
    if tg_op <> 'INSERT' then old_user_id := old.user_id; end if;
    if tg_op <> 'DELETE' then new_user_id := new.user_id; end if;
  else
    if tg_op <> 'INSERT' then old_user_id := old.id; end if;
    if tg_op <> 'DELETE' then new_user_id := new.id; end if;
  end if;

  for affected_user_id in
    select distinct candidate.user_id
    from unnest(array[old_user_id, new_user_id]) as candidate(user_id)
    where candidate.user_id is not null
    order by candidate.user_id
  loop
    perform private.rotate_user_presence_epochs(affected_user_id);
  end loop;
  return null;
end;
$$;
revoke all on function private.capture_presence_authority_change()
  from public, anon, authenticated, service_role;
create trigger firebase_presence_session_deleted
after delete on auth.sessions
for each row execute function private.capture_presence_authority_change();
create trigger firebase_presence_session_authority_changed
after update of user_id, not_after on auth.sessions
for each row
when (
  old.user_id is distinct from new.user_id
  or old.not_after is distinct from new.not_after
)
execute function private.capture_presence_authority_change();
create trigger firebase_presence_account_ban_changed
after update of banned_until on auth.users
for each row
when (old.banned_until is distinct from new.banned_until)
execute function private.capture_presence_authority_change();
-- A claimed recipient list is only an upper bound. The worker calls this
-- immediately before and after its RTDB write so a delayed room revision does
-- not recreate a kicked member's personal inbox marker.
create function public.filter_firebase_room_revision_recipients(
  p_room_id uuid,
  p_recipients uuid[]
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  filtered_recipients uuid[];
begin
  if p_room_id is null
     or p_recipients is null
     or cardinality(p_recipients) > 12
     or exists (select 1 from unnest(p_recipients) as recipient(user_id)
                where recipient.user_id is null)
     or (select count(*) from unnest(p_recipients) as recipient(user_id))
        <> (select count(distinct recipient.user_id)
            from unnest(p_recipients) as recipient(user_id)) then
    raise exception 'invalid_room_revision_recipients';
  end if;

  select coalesce(
    array_agg(candidate.user_id order by candidate.ordinality),
    '{}'::uuid[]
  )
  into filtered_recipients
  from unnest(p_recipients) with ordinality as candidate(user_id, ordinality)
  join public.room_members as members
    on members.room_id = p_room_id
   and members.user_id = candidate.user_id;

  return filtered_recipients;
end;
$$;
revoke all on function public.filter_firebase_room_revision_recipients(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.filter_firebase_room_revision_recipients(uuid, uuid[])
  to service_role;
commit;
