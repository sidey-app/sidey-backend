begin;
-- Durable room snapshot invalidation queue. There is deliberately no foreign
-- key to public.rooms: the row becomes the deletion tombstone after a room is
-- removed and must survive until Firebase has deleted /v2/r/{room_id}.
create table private.firebase_room_revision_outbox (
  room_id uuid primary key,
  revision bigint not null default 1 check (revision > 0),
  pending_since timestamptz,
  delivered_revision bigint not null default 0 check (delivered_revision >= 0),
  delivered_at timestamptz,
  deleted_at timestamptz,
  claimed_by uuid,
  claim_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  check (delivered_revision <= revision),
  check ((claimed_by is null) = (claim_until is null))
);
alter table private.firebase_room_revision_outbox enable row level security;
revoke all on private.firebase_room_revision_outbox
  from public, anon, authenticated, service_role;
create index firebase_room_revision_outbox_pending
  on private.firebase_room_revision_outbox(pending_since, room_id)
  where pending_since is not null;
-- Coalesce any number of changes for one room into one pending row. A claim is
-- retained while a newer revision is appended: an ACK for the old revision
-- then fails exactly and the newest revision is claimable after lease expiry.
create function private.enqueue_firebase_room_revision(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_room_id is null then
    raise exception 'invalid_room_id';
  end if;

  insert into private.firebase_room_revision_outbox as outbox (
    room_id,
    pending_since
  ) values (
    p_room_id,
    clock_timestamp()
  )
  on conflict (room_id) do update
  set revision = outbox.revision + 1,
      pending_since = coalesce(outbox.pending_since, clock_timestamp())
  -- A late publisher or trigger must never resurrect a deleted room.
  where outbox.deleted_at is null;
end;
$$;
revoke all on function private.enqueue_firebase_room_revision(uuid)
  from public, anon, authenticated, service_role;
create function private.tombstone_firebase_room_revision(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_room_id is null then
    raise exception 'invalid_room_id';
  end if;

  insert into private.firebase_room_revision_outbox as outbox (
    room_id,
    pending_since,
    deleted_at
  ) values (
    p_room_id,
    clock_timestamp(),
    clock_timestamp()
  )
  on conflict (room_id) do update
  set revision = outbox.revision + 1,
      pending_since = coalesce(outbox.pending_since, clock_timestamp()),
      deleted_at = coalesce(outbox.deleted_at, clock_timestamp());
end;
$$;
revoke all on function private.tombstone_firebase_room_revision(uuid)
  from public, anon, authenticated, service_role;
-- Lock room outbox rows in UUID order whenever a membership row moves between
-- rooms. This keeps concurrent multi-room changes on one deterministic order.
create function private.capture_firebase_room_membership_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_room_id uuid;
  new_room_id uuid;
  affected_room_id uuid;
begin
  if tg_op <> 'INSERT' then
    old_room_id := old.room_id;
  end if;
  if tg_op <> 'DELETE' then
    new_room_id := new.room_id;
  end if;

  for affected_room_id in
    select distinct room_id
    from unnest(array[old_room_id, new_room_id]) as changed(room_id)
    where room_id is not null
    order by room_id
  loop
    perform private.enqueue_firebase_room_revision(affected_room_id);
  end loop;

  return null;
end;
$$;
revoke all on function private.capture_firebase_room_membership_revision()
  from public, anon, authenticated, service_role;
create trigger firebase_room_revision_membership_insert_delete
after insert or delete on public.room_members
for each row execute function private.capture_firebase_room_membership_revision();
create trigger firebase_room_revision_membership_move
after update of room_id, user_id on public.room_members
for each row
when (
  old.room_id is distinct from new.room_id
  or old.user_id is distinct from new.user_id
)
execute function private.capture_firebase_room_membership_revision();
create function private.capture_firebase_room_metadata_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enqueue_firebase_room_revision(new.id);
  return null;
end;
$$;
revoke all on function private.capture_firebase_room_metadata_revision()
  from public, anon, authenticated, service_role;
create trigger firebase_room_revision_metadata
after update of name, owner_id on public.rooms
for each row
when (
  old.name is distinct from new.name
  or old.owner_id is distinct from new.owner_id
)
execute function private.capture_firebase_room_metadata_revision();
create function private.capture_firebase_room_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.tombstone_firebase_room_revision(old.id);
  return null;
end;
$$;
revoke all on function private.capture_firebase_room_deletion()
  from public, anon, authenticated, service_role;
create trigger firebase_room_revision_deleted
after delete on public.rooms
for each row execute function private.capture_firebase_room_deletion();
create function private.capture_firebase_profile_room_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_room_id uuid;
begin
  -- The trigger WHEN clause is the authoritative peer-visible allowlist. The
  -- ordered query below only fans an already-approved change out to each room.
  for affected_room_id in
    select membership.room_id
    from public.room_members as membership
    where membership.user_id = new.id
    order by membership.room_id
  loop
    perform private.enqueue_firebase_room_revision(affected_room_id);
  end loop;

  return null;
end;
$$;
revoke all on function private.capture_firebase_profile_room_revision()
  from public, anon, authenticated, service_role;
-- Do not broaden this trigger to all profile updates. These five columns are
-- exactly the peer-visible RoomMember projection. equipped_throwable_id belongs
-- to the access/throw path and updated_at is not visible to peers.
create trigger firebase_room_revision_peer_visible_profile
after update of
  nickname,
  character_id,
  equipped_bubble_style_id,
  tree_movement_paused,
  tree_movement_revision
on public.profiles
for each row
when (
  old.nickname is distinct from new.nickname
  or old.character_id is distinct from new.character_id
  or old.equipped_bubble_style_id is distinct from new.equipped_bubble_style_id
  or old.tree_movement_paused is distinct from new.tree_movement_paused
  or old.tree_movement_revision is distinct from new.tree_movement_revision
)
execute function private.capture_firebase_profile_room_revision();
-- Existing rooms need an initial snapshot. New rooms enter the outbox when the
-- owner membership is inserted by the create-room transaction.
insert into private.firebase_room_revision_outbox(room_id, pending_since)
select room.id, clock_timestamp()
from public.rooms as room
on conflict (room_id) do nothing;
-- Workers claim independent rows without blocking one another. The returned
-- revision is a fixed-width decimal string so JavaScript never loses bigint
-- precision. This only leases database work; the worker still owns Firebase IO.
create function public.claim_firebase_room_revisions(
  p_worker uuid,
  p_limit integer default 100
)
returns table (
  room_id uuid,
  revision text,
  deleted boolean
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
        -- The paired Cloud Function has a 60 second hard timeout. Keeping the
        -- lease longer prevents a deletion worker from overtaking a previous
        -- revision write whose invocation has not been terminated yet.
        claim_until = clock_timestamp() + interval '90 seconds',
        attempts = outbox.attempts + 1
    from candidates
    where outbox.room_id = candidates.room_id
    returning outbox.room_id, outbox.revision, outbox.deleted_at
  )
  select
    claimed.room_id,
    lpad(claimed.revision::text, 20, '0'),
    claimed.deleted_at is not null
  from claimed
  order by claimed.room_id;
end;
$$;
create function public.ack_firebase_room_revision(
  p_worker uuid,
  p_room_id uuid,
  p_revision text,
  p_deleted boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker is null or p_room_id is null or p_deleted is null
      or p_revision is null or p_revision !~ '^[0-9]{20}$' then
    raise exception 'invalid_ack';
  end if;

  update private.firebase_room_revision_outbox as outbox
  set delivered_revision = outbox.revision,
      delivered_at = clock_timestamp(),
      pending_since = null,
      claimed_by = null,
      claim_until = null
  where outbox.room_id = p_room_id
    and outbox.claimed_by = p_worker
    and outbox.claim_until > clock_timestamp()
    and outbox.pending_since is not null
    and lpad(outbox.revision::text, 20, '0') = p_revision
    and (outbox.deleted_at is not null) = p_deleted;

  return found;
end;
$$;
revoke all on function public.claim_firebase_room_revisions(uuid, integer),
  public.ack_firebase_room_revision(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_firebase_room_revisions(uuid, integer),
  public.ack_firebase_room_revision(uuid, uuid, text, boolean)
  to service_role;
commit;
