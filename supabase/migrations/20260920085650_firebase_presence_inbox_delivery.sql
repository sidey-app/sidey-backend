begin;

-- Reuse the existing room realtime_epoch as the Presence revocation fence.
-- Membership changes already advance it in the same source transaction, so a
-- second presence-only epoch would create two competing notions of freshness.
create function private.can_read_user_presence_topic(
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
  session_id uuid;
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
  session_id := nullif(auth.jwt()->>'session_id', '')::uuid;
  if session_id is null or not exists (
    select 1
    from auth.sessions as sessions
    where sessions.id = session_id
      and sessions.user_id = check_user_id
      and (sessions.not_after is null or sessions.not_after > clock_timestamp())
  ) then
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

create function private.can_write_user_presence_topic(
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
  session_id uuid;
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
  if parsed_target_user_id is distinct from check_user_id then
    return false;
  end if;

  session_id := nullif(auth.jwt()->>'session_id', '')::uuid;
  if session_id is null or not exists (
    select 1
    from auth.sessions as sessions
    where sessions.id = session_id
      and sessions.user_id = check_user_id
      and (sessions.not_after is null or sessions.not_after > clock_timestamp())
  ) then
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

-- Keep the existing room Broadcast/Presence authorization during the staging
-- transition. The new per-user Presence topic is additive and binds the only
-- writable target UID to auth.uid().
drop policy if exists sidey_room_channels_select on realtime.messages;
create policy sidey_room_channels_select
on realtime.messages for select to authenticated
using (
  (
    private.can_access_room_topic((select realtime.topic()), (select auth.uid()))
    and (
      realtime.messages.extension = 'broadcast'
      or (
        realtime.messages.extension = 'presence'
        and private.topic_has_kind((select realtime.topic()), 'ephemeral')
      )
    )
  )
  or (
    realtime.messages.extension = 'presence'
    and private.can_read_user_presence_topic(
      (select realtime.topic()),
      (select auth.uid())
    )
  )
);

drop policy if exists sidey_room_channels_insert on realtime.messages;
create policy sidey_room_channels_insert
on realtime.messages for insert to authenticated
with check (
  realtime.messages.extension = 'presence'
  and (
    (
      private.topic_has_kind((select realtime.topic()), 'ephemeral')
      and private.can_access_room_topic((select realtime.topic()), (select auth.uid()))
    )
    or private.can_write_user_presence_topic(
      (select realtime.topic()),
      (select auth.uid())
    )
  )
);

-- A room deletion must retain the users whose personal inbox entries have to
-- be removed after room_members cascade away. Normal revision delivery reads
-- current membership at claim time instead.
alter table private.firebase_room_revision_outbox
  add column deletion_recipient_ids uuid[] not null default '{}'::uuid[]
  check (cardinality(deletion_recipient_ids) <= 12);

create or replace function private.tombstone_firebase_room_revision(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipients uuid[];
begin
  if p_room_id is null then
    raise exception 'invalid_room_id';
  end if;

  select coalesce(array_agg(members.user_id order by members.user_id), '{}'::uuid[])
  into recipients
  from public.room_members as members
  where members.room_id = p_room_id;

  if cardinality(recipients) > 12 then
    raise exception 'room_member_limit_exceeded';
  end if;

  insert into private.firebase_room_revision_outbox as outbox (
    room_id,
    pending_since,
    deleted_at,
    deletion_recipient_ids
  ) values (
    p_room_id,
    clock_timestamp(),
    clock_timestamp(),
    recipients
  )
  on conflict (room_id) do update
  set revision = outbox.revision + 1,
      pending_since = coalesce(outbox.pending_since, clock_timestamp()),
      deleted_at = coalesce(outbox.deleted_at, clock_timestamp()),
      deletion_recipient_ids = case
        when cardinality(outbox.deletion_recipient_ids) > 0
          then outbox.deletion_recipient_ids
        else excluded.deletion_recipient_ids
      end;
end;
$$;

revoke all on function private.tombstone_firebase_room_revision(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.capture_firebase_room_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.tombstone_firebase_room_revision(old.id);
  return old;
end;
$$;

revoke all on function private.capture_firebase_room_deletion()
  from public, anon, authenticated, service_role;

drop trigger if exists firebase_room_revision_deleted on public.rooms;
create trigger firebase_room_revision_deleted
before delete on public.rooms
for each row execute function private.capture_firebase_room_deletion();

drop function public.claim_firebase_room_revisions(uuid, integer);
create function public.claim_firebase_room_revisions(
  p_worker uuid,
  p_limit integer default 100
)
returns table (
  room_id uuid,
  revision text,
  deleted boolean,
  recipients jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker is null then
    raise exception 'invalid_worker_id';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_limit';
  end if;

  return query
  with candidates as (
    select outbox.room_id
    from private.firebase_room_revision_outbox as outbox
    where outbox.pending_since is not null
      and (outbox.claim_until is null or outbox.claim_until <= clock_timestamp())
    order by outbox.pending_since, outbox.room_id
    for update skip locked
    limit p_limit
  ), claimed as (
    update private.firebase_room_revision_outbox as outbox
    set claimed_by = p_worker,
        claim_until = clock_timestamp() + interval '90 seconds',
        attempts = outbox.attempts + 1
    from candidates
    where outbox.room_id = candidates.room_id
    returning outbox.room_id, outbox.revision, outbox.deleted_at,
      outbox.deletion_recipient_ids
  )
  select
    claimed.room_id,
    lpad(claimed.revision::text, 20, '0'),
    claimed.deleted_at is not null,
    case
      when claimed.deleted_at is not null
        then to_jsonb(claimed.deletion_recipient_ids)
      else coalesce((
        select jsonb_agg(members.user_id order by members.user_id)
        from public.room_members as members
        where members.room_id = claimed.room_id
      ), '[]'::jsonb)
    end
  from claimed
  order by claimed.room_id;
end;
$$;

revoke all on function public.claim_firebase_room_revisions(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_firebase_room_revisions(uuid, integer)
  to service_role;

commit;
;
