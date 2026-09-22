begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- Final contract objects from the historical compact chat migration. The
-- sequence column, bounded backfill, concurrent index and constraints were
-- installed by the preceding production-only online phases.
create table private.firebase_chat_publish_outbox (
  message_id uuid primary key,
  room_id uuid not null,
  sequence bigint not null check (sequence between 1 and 9007199254740991),
  recipient_ids uuid[] not null check (cardinality(recipient_ids) between 1 and 12),
  pending_since timestamptz not null default clock_timestamp(),
  claimed_by uuid,
  claim_until timestamptz,
  delivered_at timestamptz,
  invalidated_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  check ((claimed_by is null) = (claim_until is null)),
  unique (room_id, sequence)
);
create index firebase_chat_publish_pending
  on private.firebase_chat_publish_outbox(pending_since, room_id, sequence desc)
  where delivered_at is null and invalidated_at is null;
alter table private.firebase_chat_publish_outbox enable row level security;
revoke all on private.firebase_chat_publish_outbox
  from public, anon, authenticated, service_role;
create table private.firebase_chat_cleanup_outbox (
  message_id uuid primary key,
  room_id uuid not null,
  sequence bigint not null check (sequence between 1 and 9007199254740991),
  recipient_ids uuid[] not null check (cardinality(recipient_ids) <= 12),
  pending_since timestamptz not null default clock_timestamp(),
  claimed_by uuid,
  claim_until timestamptz,
  delivered_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  check ((claimed_by is null) = (claim_until is null))
);
create index firebase_chat_cleanup_pending
  on private.firebase_chat_cleanup_outbox(pending_since, room_id, sequence)
  where delivered_at is null;
alter table private.firebase_chat_cleanup_outbox enable row level security;
revoke all on private.firebase_chat_cleanup_outbox
  from public, anon, authenticated, service_role;
create function private.capture_firebase_chat_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  recipients uuid[];
begin
  update private.firebase_chat_publish_outbox as outbox
  set invalidated_at = coalesce(outbox.invalidated_at, clock_timestamp()),
      delivered_at = coalesce(outbox.delivered_at, clock_timestamp()),
      claimed_by = null,
      claim_until = null
  where outbox.message_id = old.id
    and outbox.delivered_at is null;

  select coalesce(outbox.recipient_ids, '{}'::uuid[])
  into recipients
  from private.firebase_chat_publish_outbox as outbox
  where outbox.message_id = old.id;

  insert into private.firebase_chat_cleanup_outbox(
    message_id, room_id, sequence, recipient_ids
  ) values (
    old.id, old.room_id, old.sequence, coalesce(recipients, '{}'::uuid[])
  )
  on conflict (message_id) do update
  set pending_since = least(
        private.firebase_chat_cleanup_outbox.pending_since,
        excluded.pending_since
      ),
      delivered_at = null;

  return old;
end;
$$;
revoke all on function private.capture_firebase_chat_cleanup()
  from public, anon, authenticated, service_role;
create trigger firebase_chat_cleanup_deleted_message
before delete on public.messages
for each row execute function private.capture_firebase_chat_cleanup();
create function public.firebase_persist_realtime_message(
  p_id uuid,
  p_room_id uuid,
  p_sender_id uuid,
  p_session_id uuid,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_message public.messages;
  recent_attempts integer;
  selected_bubble_style_id text;
  selected_bubble_wire_code integer;
  next_sequence bigint;
  recipients uuid[];
begin
  if p_sender_id is null or p_session_id is null or not exists (
    select 1
    from auth.users as users
    join auth.sessions as sessions
      on sessions.user_id = users.id
     and sessions.id = p_session_id
     and (sessions.not_after is null or sessions.not_after > clock_timestamp())
    where users.id = p_sender_id
      and (users.banned_until is null or users.banned_until <= clock_timestamp())
  ) then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_id is null then
    raise exception using errcode = '22023', message = 'message_id_required';
  end if;
  if p_body is null
     or char_length(p_body) < 1
     or octet_length(p_body) > 16384
     or array_length(regexp_split_to_array(p_body, E'\n'), 1) > 3
     or p_body ~ E'\r' then
    raise exception using errcode = '22023', message = 'invalid_message_body';
  end if;

  select * into saved_message from public.messages where id = p_id;
  if found then
    if saved_message.room_id is distinct from p_room_id
       or saved_message.sender_id is distinct from p_sender_id
       or saved_message.body is distinct from p_body then
      raise exception using errcode = '23505', message = 'message_id_conflict';
    end if;
    select products.wire_code into selected_bubble_wire_code
    from public.commerce_products as products
    where products.product_kind = 'bubble'
      and products.catalog_item_id = saved_message.bubble_style_id;
    return jsonb_strip_nulls(jsonb_build_object(
      'i', saved_message.id,
      'r', saved_message.room_id,
      's', saved_message.sender_id,
      'b', saved_message.body,
      'k', selected_bubble_wire_code::text,
      't', floor(extract(epoch from saved_message.created_at) * 1000)::bigint,
      'n', saved_message.sequence
    ));
  end if;

  perform 1
  from public.rooms as rooms
  where rooms.id = p_room_id
  for update;
  if not found or not exists (
    select 1 from public.room_members as members
    where members.room_id = p_room_id and members.user_id = p_sender_id
  ) then
    raise exception using errcode = '42501', message = 'membership_required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('message:' || p_sender_id::text, 0));
  select count(*) into recent_attempts
  from private.message_attempts as attempts
  where attempts.user_id = p_sender_id
    and attempts.attempted_at >= clock_timestamp() - interval '10 seconds';
  if recent_attempts >= 30 then
    raise exception using errcode = 'P0001', message = 'message_rate_limited';
  end if;
  insert into private.message_attempts(user_id) values (p_sender_id);

  insert into private.firebase_chat_sequences(room_id, high_water)
  values (p_room_id, 1)
  on conflict (room_id) do update
  set high_water = private.firebase_chat_sequences.high_water + 1
  returning high_water into next_sequence;
  if next_sequence > 9007199254740991 then
    raise exception using errcode = '22003', message = 'message_sequence_exhausted';
  end if;

  selected_bubble_style_id := private.owned_equipped_catalog_item(p_sender_id, 'bubble');
  select products.wire_code into selected_bubble_wire_code
  from public.commerce_products as products
  where products.product_kind = 'bubble'
    and products.catalog_item_id = selected_bubble_style_id
    and products.active is true;

  select coalesce(array_agg(members.user_id order by members.user_id), '{}'::uuid[])
  into recipients
  from public.room_members as members
  where members.room_id = p_room_id;
  if cardinality(recipients) not between 1 and 12 then
    raise exception 'room_member_limit_exceeded';
  end if;

  insert into public.messages(
    id, room_id, sender_id, body, bubble_style_id, sequence
  ) values (
    p_id, p_room_id, p_sender_id, p_body, selected_bubble_style_id, next_sequence
  )
  returning * into saved_message;

  insert into private.firebase_chat_publish_outbox(
    message_id, room_id, sequence, recipient_ids
  ) values (
    saved_message.id, saved_message.room_id, saved_message.sequence, recipients
  );

  return jsonb_strip_nulls(jsonb_build_object(
    'i', saved_message.id,
    'r', saved_message.room_id,
    's', saved_message.sender_id,
    'b', saved_message.body,
    'k', selected_bubble_wire_code::text,
    't', floor(extract(epoch from saved_message.created_at) * 1000)::bigint,
    'n', saved_message.sequence
  ));
end;
$$;
revoke all on function public.firebase_persist_realtime_message(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.firebase_persist_realtime_message(
  uuid, uuid, uuid, uuid, text
) to service_role;
create function public.claim_firebase_chat_publications(
  p_worker uuid,
  p_limit integer default 100
)
returns table(payload jsonb)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker is null then raise exception 'invalid_worker_id'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_limit';
  end if;

  return query
  with candidates as (
    select distinct on (outbox.room_id)
      outbox.message_id, outbox.room_id, outbox.sequence
    from private.firebase_chat_publish_outbox as outbox
    where outbox.delivered_at is null
      and outbox.invalidated_at is null
      and not exists (
        select 1
        from private.firebase_chat_publish_outbox as active_claim
        where active_claim.room_id = outbox.room_id
          and active_claim.delivered_at is null
          and active_claim.claim_until > clock_timestamp()
      )
    order by outbox.room_id, outbox.sequence desc
  ), locked as (
    select outbox.message_id
    from private.firebase_chat_publish_outbox as outbox
    join candidates on candidates.message_id = outbox.message_id
    order by outbox.pending_since, outbox.room_id
    for update of outbox skip locked
    limit p_limit
  ), claimed as (
    update private.firebase_chat_publish_outbox as outbox
    set claimed_by = p_worker,
        claim_until = clock_timestamp() + interval '90 seconds',
        attempts = outbox.attempts + 1
    from locked
    where outbox.message_id = locked.message_id
    returning outbox.*
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'i', messages.id,
    'r', messages.room_id,
    's', messages.sender_id,
    'b', messages.body,
    'k', products.wire_code::text,
    't', floor(extract(epoch from messages.created_at) * 1000)::bigint,
    'n', messages.sequence,
    'recipients', to_jsonb(claimed.recipient_ids)
  ))
  from claimed
  join public.messages as messages on messages.id = claimed.message_id
  left join public.commerce_products as products
    on products.product_kind = 'bubble'
   and products.catalog_item_id = messages.bubble_style_id
  order by messages.room_id;
end;
$$;
create function public.filter_firebase_chat_recipients(
  p_worker uuid,
  p_room_id uuid,
  p_message_id uuid,
  p_sequence bigint,
  p_recipients uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'valid', exists (
      select 1
      from private.firebase_chat_publish_outbox as outbox
      join public.messages as messages on messages.id = outbox.message_id
      join public.rooms as rooms on rooms.id = outbox.room_id
      where outbox.message_id = p_message_id
        and outbox.room_id = p_room_id
        and outbox.sequence = p_sequence
        and outbox.claimed_by = p_worker
        and outbox.claim_until > clock_timestamp()
        and outbox.delivered_at is null
        and outbox.invalidated_at is null
        and messages.sequence = p_sequence
    ),
    'recipients', coalesce((
      select jsonb_agg(members.user_id order by members.user_id)
      from public.room_members as members
      where members.room_id = p_room_id
        and members.user_id = any(coalesce(p_recipients, '{}'::uuid[]))
    ), '[]'::jsonb)
  );
$$;
create function public.ack_firebase_chat_publication(
  p_worker uuid,
  p_room_id uuid,
  p_message_id uuid,
  p_sequence bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from private.firebase_chat_publish_outbox as claimed
    where claimed.message_id = p_message_id
      and claimed.room_id = p_room_id
      and claimed.sequence = p_sequence
      and claimed.claimed_by = p_worker
      and claimed.claim_until > clock_timestamp()
  ) then
    return false;
  end if;

  update private.firebase_chat_publish_outbox as outbox
  set delivered_at = clock_timestamp(),
      claimed_by = null,
      claim_until = null
  where outbox.room_id = p_room_id
    and outbox.sequence <= p_sequence
    and outbox.delivered_at is null;
  return true;
end;
$$;
create function public.claim_firebase_chat_cleanups(
  p_worker uuid,
  p_limit integer default 100
)
returns table(
  message_id uuid,
  room_id uuid,
  sequence bigint,
  recipients jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker is null then raise exception 'invalid_worker_id'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_limit';
  end if;

  return query
  with candidates as (
    select outbox.message_id
    from private.firebase_chat_cleanup_outbox as outbox
    where outbox.delivered_at is null
      and (outbox.claim_until is null or outbox.claim_until <= clock_timestamp())
    order by outbox.pending_since, outbox.room_id, outbox.sequence
    for update skip locked
    limit p_limit
  ), claimed as (
    update private.firebase_chat_cleanup_outbox as outbox
    set claimed_by = p_worker,
        claim_until = clock_timestamp() + interval '90 seconds',
        attempts = outbox.attempts + 1
    from candidates
    where outbox.message_id = candidates.message_id
    returning outbox.*
  )
  select claimed.message_id, claimed.room_id, claimed.sequence,
         to_jsonb(claimed.recipient_ids)
  from claimed;
end;
$$;
create function public.ack_firebase_chat_cleanup(
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
  update private.firebase_chat_cleanup_outbox as outbox
  set delivered_at = clock_timestamp(),
      claimed_by = null,
      claim_until = null
  where outbox.message_id = p_message_id
    and outbox.sequence = p_sequence
    and outbox.claimed_by = p_worker
    and outbox.claim_until > clock_timestamp()
    and outbox.delivered_at is null;
  return found;
end;
$$;
revoke all on function public.claim_firebase_chat_publications(uuid, integer),
  public.filter_firebase_chat_recipients(uuid, uuid, uuid, bigint, uuid[]),
  public.ack_firebase_chat_publication(uuid, uuid, uuid, bigint),
  public.claim_firebase_chat_cleanups(uuid, integer),
  public.ack_firebase_chat_cleanup(uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.claim_firebase_chat_publications(uuid, integer),
  public.filter_firebase_chat_recipients(uuid, uuid, uuid, bigint, uuid[]),
  public.ack_firebase_chat_publication(uuid, uuid, uuid, bigint),
  public.claim_firebase_chat_cleanups(uuid, integer),
  public.ack_firebase_chat_cleanup(uuid, uuid, bigint)
  to service_role;
-- Room deletion and retention invalidate publish work before Firebase cleanup.
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
  perform private.tombstone_firebase_room_revision(old.id);
  return old;
end;
$$;
revoke all on function private.capture_firebase_room_deletion()
  from public, anon, authenticated, service_role;
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
    where created_at < clock_timestamp() - interval '3 days'
    returning room_id
  )
  select count(*), array_agg(distinct room_id)
  into deleted_count, changed_room_ids
  from deleted;
  perform set_config('sidey.suppress_message_broadcast', 'off', true);

  foreach changed_room_id in array coalesce(changed_room_ids, array[]::uuid[])
  loop
    perform private.enqueue_firebase_room_revision(changed_room_id);
    select rooms.realtime_epoch into epoch
    from public.rooms as rooms where rooms.id = changed_room_id;
    if epoch is not null then
      perform private.route_realtime(
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
-- pg_cron is configured in GMT on Supabase. Preserve the existing job identity
-- while moving cleanup to 03:00 Asia/Seoul (18:00 UTC on the previous date).
do $$
declare
  job_id bigint;
begin
  select jobid into job_id
  from cron.job
  where jobname = 'sidey-delete-expired-messages';
  if job_id is not null then
    perform cron.alter_job(job_id, schedule := '0 18 * * *');
  end if;
end;
$$;
commit;
