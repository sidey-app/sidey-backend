begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';
-- A room has one live event slot, so only its newest deleted sequence can ever
-- need a remote exact-slot cleanup. Bound durable cleanup storage and worker IO
-- to one row per room.
delete from private.firebase_chat_cleanup_outbox
where delivered_at is not null;
delete from private.firebase_chat_cleanup_outbox as older
using private.firebase_chat_cleanup_outbox as newer
where older.room_id = newer.room_id
  and (
    older.sequence < newer.sequence
    or (older.sequence = newer.sequence and older.message_id < newer.message_id)
  );
alter table private.firebase_chat_cleanup_outbox
  add constraint firebase_chat_cleanup_one_per_room unique (room_id);
-- Rows whose source message disappeared before this compaction are no longer
-- useful once their cleanup has been captured by the delete trigger.
delete from private.firebase_chat_publish_outbox as outbox
where not exists (
  select 1 from public.messages as messages where messages.id = outbox.message_id
);
create or replace function private.capture_firebase_chat_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipients uuid[];
begin
  select outbox.recipient_ids
  into recipients
  from private.firebase_chat_publish_outbox as outbox
  where outbox.message_id = old.id;

  -- Legacy messages were never published into /v2/l and require no RTDB job.
  if found then
    insert into private.firebase_chat_cleanup_outbox(
      message_id, room_id, sequence, recipient_ids
    ) values (
      old.id, old.room_id, old.sequence, recipients
    )
    on conflict (room_id) do update
    set message_id = excluded.message_id,
        sequence = excluded.sequence,
        recipient_ids = excluded.recipient_ids,
        pending_since = clock_timestamp(),
        claimed_by = null,
        claim_until = null,
        delivered_at = null
    where excluded.sequence >= private.firebase_chat_cleanup_outbox.sequence;

    -- Cleanup is now independently durable, so the per-message publish row no
    -- longer needs to survive beyond the authoritative message retention.
    delete from private.firebase_chat_publish_outbox as outbox
    where outbox.message_id = old.id;
  end if;
  return old;
end;
$$;
revoke all on function private.capture_firebase_chat_cleanup()
  from public, anon, authenticated, service_role;
create or replace function public.ack_firebase_chat_cleanup(
  p_worker uuid,
  p_message_id uuid,
  p_sequence bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.firebase_chat_cleanup_outbox as outbox
  where outbox.message_id = p_message_id
    and outbox.sequence = p_sequence
    and outbox.claimed_by = p_worker
    and outbox.claim_until > clock_timestamp()
    and outbox.delivered_at is null;
  return found;
end;
$$;
revoke all on function public.ack_firebase_chat_cleanup(uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.ack_firebase_chat_cleanup(uuid, uuid, bigint)
  to service_role;
create or replace function private.capture_firebase_room_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.firebase_chat_publish_outbox as outbox
  set invalidated_at = coalesce(outbox.invalidated_at, clock_timestamp()),
      delivered_at = coalesce(outbox.delivered_at, clock_timestamp()),
      claimed_by = null,
      claim_until = null
  where outbox.room_id = old.id
    and outbox.delivered_at is null;
  delete from private.firebase_chat_sequences as sequences
  where sequences.room_id = old.id;
  perform private.tombstone_firebase_room_revision(old.id);
  return old;
end;
$$;
revoke all on function private.capture_firebase_room_deletion()
  from public, anon, authenticated, service_role;
commit;
