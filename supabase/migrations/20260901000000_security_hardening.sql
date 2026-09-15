-- SIDEY Realtime/invite hardening. This is intentionally forward-only: the
-- already deployed migrations remain immutable and this migration replaces
-- their public contracts.

create extension if not exists supabase_vault with schema vault;

do $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets where name = 'sidey_invite_pepper_v2'
  ) then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'sidey_invite_pepper_v2',
      'HMAC pepper for SIDEY v2 invite codes; never expose through the Data API'
    );
  end if;
end;
$$;

revoke all on vault.decrypted_secrets from public, anon, authenticated;

create table private.room_invites (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  code_hash bytea not null unique,
  code_version integer not null default 1,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now(),
  constraint room_invites_code_version_positive check (code_version > 0)
);

revoke all on private.room_invites from public, anon, authenticated;

alter table public.rooms
  add column realtime_epoch bigint not null default 1,
  add column invite_code_ready boolean not null default false;

-- The eight-character v1 codes are deliberately invalidated. Their SHA-256
-- hashes must not be copied into the new HMAC table.
update public.rooms
set invite_code_hint = '재발급 필요',
    invite_code_ready = false;

alter table public.rooms
  drop constraint if exists rooms_invite_hint_length;
alter table public.rooms
  add constraint rooms_invite_hint_length
  check (char_length(invite_code_hint) between 2 and 20);
alter table public.rooms
  drop column invite_code_hash,
  drop column invite_version;

create or replace function private.generate_invite_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select substr(raw, 1, 8) || '-' || substr(raw, 9, 8) || '-'
      || substr(raw, 17, 8) || '-' || substr(raw, 25, 8)
  from (
    select upper(encode(extensions.gen_random_bytes(16), 'hex')) as raw
  ) generated;
$$;

create or replace function private.hash_invite_code(value text)
returns bytea
language plpgsql
stable
strict
security definer
set search_path = ''
as $$
declare
  pepper bytea;
  normalized text := upper(regexp_replace(btrim(value), '-', '', 'g'));
begin
  select decode(decrypted_secret, 'hex')
  into pepper
  from vault.decrypted_secrets
  where name = 'sidey_invite_pepper_v2';

  if pepper is null then
    raise exception using errcode = '55000', message = 'invite_pepper_unavailable';
  end if;
  return extensions.hmac(convert_to(normalized, 'UTF8'), pepper, 'sha256');
end;
$$;

create table private.realtime_event_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete cascade,
  event_name text not null,
  attempted_at timestamptz not null default now()
);

create index realtime_event_attempts_user_time_idx
on private.realtime_event_attempts (user_id, event_name, attempted_at desc);
revoke all on private.realtime_event_attempts from public, anon, authenticated;

create table private.message_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now()
);

create index message_attempts_user_time_idx
on private.message_attempts (user_id, attempted_at desc);
revoke all on private.message_attempts from public, anon, authenticated;

create or replace function private.room_topic(
  room_id uuid,
  epoch bigint,
  topic_kind text
)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select 'room:' || room_id::text || ':' || epoch::text || ':' || topic_kind;
$$;

create or replace function private.can_access_room_topic(topic text, check_user_id uuid)
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
begin
  parts := regexp_match(
    topic,
    '^room:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):([1-9][0-9]*):(db|ephemeral)$'
  );
  if parts is null or check_user_id is null then
    return false;
  end if;
  parsed_room_id := parts[1]::uuid;
  parsed_epoch := parts[2]::bigint;
  return exists (
    select 1
    from public.rooms
    join public.room_members on room_members.room_id = rooms.id
    where rooms.id = parsed_room_id
      and rooms.realtime_epoch = parsed_epoch
      and room_members.user_id = check_user_id
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  return false;
end;
$$;

create or replace function private.topic_has_kind(topic text, topic_kind text)
returns boolean
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select topic_kind in ('db', 'ephemeral')
    and right(topic, char_length(topic_kind) + 1) = ':' || topic_kind;
$$;

grant execute on function private.can_access_room_topic(text, uuid) to authenticated;
grant execute on function private.topic_has_kind(text, text) to authenticated;

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
  insert into public.rooms (name, owner_id, invite_code_hint, invite_code_ready)
  values (btrim(p_name), current_user_id, '••••••••-' || right(generated_code, 4), true)
  returning id into created_room_id;
  insert into private.room_invites (room_id, code_hash)
  values (created_room_id, private.hash_invite_code(generated_code));
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
  normalized_invite_code text := upper(regexp_replace(btrim(coalesce(p_invite_code, '')), '-', '', 'g'));
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  -- Serialize count + insert for this user. Without this lock parallel RPCs can
  -- all observe nine attempts and bypass the limit.
  perform pg_advisory_xact_lock(hashtextextended('invite:' || current_user_id::text, 0));
  select count(*) into recent_attempts
  from private.invite_attempts
  where user_id = current_user_id and attempted_at >= now() - interval '10 minutes';
  if recent_attempts >= 10 then
    return query select null::uuid, 'invite_rate_limited'::text;
    return;
  end if;
  insert into private.invite_attempts (user_id) values (current_user_id);

  if normalized_invite_code !~ '^[0-9A-F]{32}$' then
    return query select null::uuid, 'invalid_invite_code'::text;
    return;
  end if;

  select rooms.* into target_room
  from private.room_invites invites
  join public.rooms on rooms.id = invites.room_id
  where invites.code_hash = private.hash_invite_code(p_invite_code)
    and rooms.invite_code_ready is true
  for update of rooms;
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
  if not exists (
    select 1 from public.rooms where id = p_room_id and owner_id = auth.uid()
    for update
  ) then
    raise exception using errcode = '42501', message = 'owner_required';
  end if;

  generated_code := private.generate_invite_code();
  insert into private.room_invites (room_id, code_hash, code_version)
  values (p_room_id, private.hash_invite_code(generated_code), 1)
  on conflict (room_id) do update
  set code_hash = excluded.code_hash,
      code_version = private.room_invites.code_version + 1,
      rotated_at = now();

  update public.rooms
  set invite_code_hint = '••••••••-' || right(generated_code, 4),
      invite_code_ready = true
  where id = p_room_id;
  return generated_code;
end;
$$;

create or replace function public.send_message(p_id uuid, p_room_id uuid, p_body text)
returns public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_body text := btrim(p_body);
  saved_message public.messages;
  recent_attempts integer;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if not private.is_room_member(p_room_id, current_user_id) then
    raise exception using errcode = '42501', message = 'membership_required';
  end if;
  if char_length(normalized_body) not between 1 and 200
     or array_length(regexp_split_to_array(p_body, E'\n'), 1) > 3
     or p_body ~ E'\r' then
    raise exception using errcode = '22023', message = 'invalid_message_body';
  end if;

  select * into saved_message from public.messages where id = p_id;
  if found then
    if saved_message.room_id != p_room_id
       or saved_message.sender_id != current_user_id
       or saved_message.body != normalized_body then
      raise exception using errcode = '23505', message = 'message_id_conflict';
    end if;
    return saved_message;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('message:' || current_user_id::text, 0));

  -- A concurrent retry can commit while this transaction is waiting for the
  -- user lock. Re-check before charging the retry against the rate window.
  select * into saved_message from public.messages where id = p_id;
  if found then
    if saved_message.room_id != p_room_id
       or saved_message.sender_id != current_user_id
       or saved_message.body != normalized_body then
      raise exception using errcode = '23505', message = 'message_id_conflict';
    end if;
    return saved_message;
  end if;

  select count(*) into recent_attempts
  from private.message_attempts
  where user_id = current_user_id and attempted_at >= now() - interval '10 seconds';
  if recent_attempts >= 30 then
    raise exception using errcode = 'P0001', message = 'message_rate_limited';
  end if;
  insert into private.message_attempts (user_id) values (current_user_id);

  insert into public.messages (id, room_id, sender_id, body)
  values (p_id, p_room_id, current_user_id, normalized_body)
  on conflict (id) do nothing;
  select * into saved_message from public.messages where id = p_id;
  if saved_message.room_id != p_room_id
     or saved_message.sender_id != current_user_id
     or saved_message.body != normalized_body then
    raise exception using errcode = '23505', message = 'message_id_conflict';
  end if;
  return saved_message;
end;
$$;

create or replace function public.broadcast_room_event(
  p_room_id uuid,
  p_realtime_epoch bigint,
  p_event text,
  p_event_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_epoch bigint;
  recent_attempts integer;
  rate_window interval;
  rate_limit integer;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_event not in ('typing_start', 'typing_stop', 'character_pulse') then
    raise exception using errcode = '22023', message = 'invalid_realtime_event';
  end if;
  if p_event = 'character_pulse' and p_event_id is null then
    raise exception using errcode = '22023', message = 'event_id_required';
  end if;

  select realtime_epoch into current_epoch
  from public.rooms
  where id = p_room_id and private.is_room_member(id, current_user_id);
  if not found then
    raise exception using errcode = '42501', message = 'membership_required';
  end if;
  if current_epoch != p_realtime_epoch then
    raise exception using errcode = '40001', message = 'stale_realtime_epoch';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'event:' || current_user_id::text || ':' || p_room_id::text || ':' || p_event,
    0
  ));
  if p_event = 'character_pulse' then
    rate_window := interval '10 seconds';
    rate_limit := 5;
  else
    rate_window := interval '1 minute';
    rate_limit := 40;
  end if;
  select count(*) into recent_attempts
  from private.realtime_event_attempts
  where user_id = current_user_id
    and room_id = p_room_id
    and event_name = p_event
    and attempted_at >= now() - rate_window;
  if recent_attempts >= rate_limit then
    raise exception using errcode = 'P0001', message = 'realtime_event_rate_limited';
  end if;
  insert into private.realtime_event_attempts (user_id, room_id, event_name)
  values (current_user_id, p_room_id, p_event);

  perform realtime.send(
    jsonb_strip_nulls(jsonb_build_object(
      'room_id', p_room_id,
      'user_id', current_user_id,
      'event_id', p_event_id
    )),
    p_event,
    private.room_topic(p_room_id, current_epoch, 'ephemeral'),
    true
  );
end;
$$;

revoke all on function public.broadcast_room_event(uuid, bigint, text, uuid) from public, anon;
grant execute on function public.broadcast_room_event(uuid, bigint, text, uuid) to authenticated;

-- Database broadcasts contain identifiers only. Every message body is fetched
-- again through PostgREST, where messages RLS remains authoritative.
create or replace function private.broadcast_room_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_room_id uuid := coalesce(new.room_id, old.room_id);
  changed_id uuid := coalesce(new.id, old.id);
  epoch bigint;
begin
  if current_setting('sidey.suppress_message_broadcast', true) = 'on' then
    return null;
  end if;
  select realtime_epoch into epoch from public.rooms where id = changed_room_id;
  if epoch is null then return null; end if;
  perform realtime.send(
    jsonb_build_object(
      'room_id', changed_room_id,
      'message_id', changed_id,
      'operation', tg_op
    ),
    'message_changed',
    private.room_topic(changed_room_id, epoch, 'db'),
    true
  );
  return null;
end;
$$;

create or replace function private.broadcast_room_record_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_room_id uuid := coalesce(new.id, old.id);
  epoch bigint := coalesce(new.realtime_epoch, old.realtime_epoch);
begin
  if current_setting('sidey.suppress_room_broadcast', true) = 'on' then
    return null;
  end if;
  perform realtime.send(
    jsonb_build_object(
      'room_id', changed_room_id,
      'entity', 'rooms',
      'operation', tg_op,
      'realtime_epoch', epoch
    ),
    'structure_changed',
    private.room_topic(changed_room_id, epoch, 'db'),
    true
  );
  return null;
end;
$$;

create or replace function private.broadcast_membership_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_room_id uuid := coalesce(new.room_id, old.room_id);
  previous_epoch bigint;
  next_epoch bigint;
begin
  select realtime_epoch into previous_epoch
  from public.rooms where id = changed_room_id for update;
  if previous_epoch is null then return null; end if;

  perform realtime.send(
    jsonb_build_object(
      'room_id', changed_room_id,
      'entity', 'room_members',
      'operation', tg_op,
      'realtime_epoch', previous_epoch + 1
    ),
    'structure_changed',
    private.room_topic(changed_room_id, previous_epoch, 'db'),
    true
  );

  perform set_config('sidey.suppress_room_broadcast', 'on', true);
  update public.rooms
  set realtime_epoch = realtime_epoch + 1
  where id = changed_room_id
  returning realtime_epoch into next_epoch;
  perform set_config('sidey.suppress_room_broadcast', 'off', true);
  return null;
end;
$$;

create or replace function private.broadcast_profile_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  membership record;
begin
  for membership in
    select rooms.id as room_id, rooms.realtime_epoch
    from public.room_members
    join public.rooms on rooms.id = room_members.room_id
    where room_members.user_id = coalesce(new.id, old.id)
  loop
    perform realtime.send(
      jsonb_build_object(
        'room_id', membership.room_id,
        'entity', 'profiles',
        'operation', tg_op,
        'realtime_epoch', membership.realtime_epoch
      ),
      'structure_changed',
      private.room_topic(membership.room_id, membership.realtime_epoch, 'db'),
      true
    );
  end loop;
  return null;
end;
$$;

drop trigger if exists messages_broadcast_change on public.messages;
create trigger messages_broadcast_change
after insert or update or delete on public.messages
for each row execute function private.broadcast_room_change();

drop trigger if exists room_members_broadcast_change on public.room_members;
create trigger room_members_broadcast_change
after insert or update or delete on public.room_members
for each row execute function private.broadcast_membership_change();

drop trigger if exists rooms_broadcast_change on public.rooms;
create trigger rooms_broadcast_change
after update or delete on public.rooms
for each row execute function private.broadcast_room_record_change();

drop trigger if exists profiles_broadcast_change on public.profiles;
create trigger profiles_broadcast_change
after update or delete on public.profiles
for each row execute function private.broadcast_profile_change();

drop policy if exists sidey_room_channels_select on realtime.messages;
create policy sidey_room_channels_select
on realtime.messages for select to authenticated
using (
  private.can_access_room_topic((select realtime.topic()), (select auth.uid()))
  and (
    (realtime.messages.extension = 'broadcast')
    or (
      realtime.messages.extension = 'presence'
      and private.topic_has_kind((select realtime.topic()), 'ephemeral')
    )
  )
);

-- No client-originated Broadcast is accepted. Ephemeral events go through the
-- validating RPC above; only Presence tracking is written by the socket.
drop policy if exists sidey_room_channels_insert on realtime.messages;
create policy sidey_room_channels_insert
on realtime.messages for insert to authenticated
with check (
  realtime.messages.extension = 'presence'
  and private.topic_has_kind((select realtime.topic()), 'ephemeral')
  and private.can_access_room_topic((select realtime.topic()), (select auth.uid()))
);

create or replace function private.delete_expired_messages()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
  changed_room_id uuid;
  changed_room_ids uuid[];
  epoch bigint;
begin
  perform set_config('sidey.suppress_message_broadcast', 'on', true);
  with deleted as (
    delete from public.messages
    where created_at < now() - interval '7 days'
    returning room_id
  )
  select count(*), array_agg(distinct room_id)
  into deleted_count, changed_room_ids
  from deleted;
  perform set_config('sidey.suppress_message_broadcast', 'off', true);

  foreach changed_room_id in array coalesce(changed_room_ids, array[]::uuid[])
  loop
    select realtime_epoch into epoch from public.rooms where id = changed_room_id;
    if epoch is not null then
      perform realtime.send(
        jsonb_build_object('room_id', changed_room_id),
        'messages_pruned',
        private.room_topic(changed_room_id, epoch, 'db'),
        true
      );
    end if;
  end loop;
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
    and not exists (select 1 from public.profiles where id = users.id)
    and not exists (select 1 from public.room_members where user_id = users.id);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function private.delete_expired_attempts()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint := 0;
  affected bigint;
begin
  delete from private.invite_attempts where attempted_at < now() - interval '1 day';
  get diagnostics affected = row_count;
  deleted_count := deleted_count + affected;
  delete from private.realtime_event_attempts where attempted_at < now() - interval '1 day';
  get diagnostics affected = row_count;
  deleted_count := deleted_count + affected;
  delete from private.message_attempts where attempted_at < now() - interval '1 day';
  get diagnostics affected = row_count;
  return deleted_count + affected;
end;
$$;

select cron.schedule(
  'sidey-delete-expired-attempts',
  '5 4 * * *',
  $$select private.delete_expired_attempts();$$
)
where not exists (
  select 1 from cron.job where jobname = 'sidey-delete-expired-attempts'
);

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if exists (select 1 from public.rooms where owner_id = current_user_id) then
    raise exception using errcode = 'P0001', message = 'owned_rooms_must_be_deleted_or_left';
  end if;
  delete from auth.users where id = current_user_id;
end;
$$;

revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
