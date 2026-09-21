begin;
-- Permanent compact codes. Code 0 is reserved for the built-in/default
-- throwable and therefore never belongs to a paid catalog row. Codes are
-- unique only inside a product kind; the wire event determines the kind.
alter table public.commerce_products
  add column wire_code integer;
with ranked as (
  select id,
         row_number() over (
           partition by product_kind order by sort_order, id
         )::integer as wire_code
  from public.commerce_products
  where product_kind in ('bubble', 'throwable')
)
update public.commerce_products as products
set wire_code = ranked.wire_code
from ranked
where products.id = ranked.id;
alter table public.commerce_products
  add constraint commerce_products_wire_code_shape check (
    (product_kind in ('bubble', 'throwable') and wire_code is not null
      and wire_code between 1 and 999999)
    or (product_kind = 'character' and wire_code is null)
  );
create unique index commerce_products_kind_wire_code_unique
  on public.commerce_products(product_kind, wire_code)
  where wire_code is not null;
-- Keep the legacy catalog item mirror until both released clients have moved
-- to compact codes. New /v2/l throw writes use wire_items exclusively.
create or replace function public.firebase_realtime_access(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  room_ids jsonb;
  throwable_ids jsonb;
  throwable_wire_codes jsonb;
begin
  if p_user_id is null or not exists (
    select 1 from auth.users as users where users.id = p_user_id
  ) then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select coalesce(jsonb_agg(members.room_id order by members.room_id), '[]'::jsonb)
  into room_ids
  from public.room_members as members
  where members.user_id = p_user_id;

  select
    coalesce(jsonb_agg(products.catalog_item_id order by products.catalog_item_id), '[]'::jsonb),
    coalesce(jsonb_agg(products.wire_code::text order by products.wire_code), '["0"]'::jsonb)
  into throwable_ids, throwable_wire_codes
  from public.profiles as profiles
  join public.commerce_products as products
    on products.product_kind = 'throwable'
   and products.catalog_item_id = profiles.equipped_throwable_id
   and products.active is true
  join public.commerce_entitlements as entitlements
    on entitlements.user_id = profiles.id
   and entitlements.entitlement_key = products.entitlement_key
   and entitlements.status = 'active'
  where profiles.id = p_user_id;

  if jsonb_array_length(throwable_wire_codes) = 0 then
    throwable_wire_codes := '["0"]'::jsonb;
  end if;

  return jsonb_build_object(
    'user_id', p_user_id,
    'rooms', room_ids,
    'items', throwable_ids,
    'wire_items', throwable_wire_codes
  );
end;
$$;
revoke all on function public.firebase_realtime_access(uuid)
  from public, anon, authenticated;
grant execute on function public.firebase_realtime_access(uuid)
  to service_role;
-- Preserve a typed deny-all shape for revoked/deleted users. This avoids
-- treating an expected revocation as a malformed snapshot in the worker.
create or replace function public.firebase_access_snapshot(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  rev bigint;
  enabled boolean;
  snapshot jsonb;
  session_map jsonb;
begin
  if p_user_id is null then raise exception 'invalid_user_id'; end if;
  insert into private.firebase_access_outbox(user_id, pending_since)
  values (p_user_id, clock_timestamp()) on conflict (user_id) do nothing;
  select revision into rev
  from private.firebase_access_outbox
  where user_id = p_user_id
  for update;
  select exists(
    select 1 from auth.users as users
    where users.id = p_user_id
      and (users.banned_until is null or users.banned_until <= clock_timestamp())
  ) into enabled;
  snapshot := jsonb_build_object(
    'user_id', p_user_id,
    'rooms', '[]'::jsonb,
    'items', '[]'::jsonb,
    'wire_items', '[]'::jsonb
  );
  session_map := '{}'::jsonb;
  if enabled then
    snapshot := public.firebase_realtime_access(p_user_id);
    select coalesce(jsonb_object_agg(
      sessions.id::text,
      case
        when sessions.not_after is null then 8640000000000000::bigint
        else floor(extract(epoch from sessions.not_after) * 1000)::bigint
      end
    ), '{}'::jsonb)
    into session_map
    from auth.sessions as sessions
    where sessions.user_id = p_user_id
      and (sessions.not_after is null or sessions.not_after > clock_timestamp());
  end if;
  return snapshot || jsonb_build_object(
    'revision', lpad(rev::text, 20, '0'),
    'active', enabled,
    'sessions', session_map
  );
end;
$$;
revoke all on function public.firebase_access_snapshot(uuid)
  from public, anon, authenticated;
grant execute on function public.firebase_access_snapshot(uuid)
  to service_role;
drop trigger if exists firebase_access_product on public.commerce_products;
create trigger firebase_access_product
after update on public.commerce_products
for each row
when (
  old.active is distinct from new.active
  or old.entitlement_key is distinct from new.entitlement_key
  or old.catalog_item_id is distinct from new.catalog_item_id
  or old.product_kind is distinct from new.product_kind
  or old.wire_code is distinct from new.wire_code
)
execute function private.capture_firebase_product_access();
-- Room-local message sequences are numeric on the wire but are permanently
-- bounded to JavaScript's exact integer range.
lock table public.messages in share row exclusive mode;
alter table public.messages add column sequence bigint;
with ranked as (
  select id,
         row_number() over (
           partition by room_id order by created_at, id
         )::bigint as sequence
  from public.messages
)
update public.messages as messages
set sequence = ranked.sequence
from ranked
where messages.id = ranked.id;
alter table public.messages
  alter column sequence set not null,
  add constraint messages_sequence_safe_integer
    check (sequence between 1 and 9007199254740991),
  drop constraint messages_body_length,
  add constraint messages_body_payload check (
    char_length(body) >= 1 and octet_length(body) <= 16384
  );
create unique index messages_room_sequence_unique
  on public.messages(room_id, sequence);
create table private.firebase_chat_sequences (
  room_id uuid primary key,
  high_water bigint not null
    check (high_water between 0 and 9007199254740991)
);
insert into private.firebase_chat_sequences(room_id, high_water)
select rooms.id, coalesce(max(messages.sequence), 0)
from public.rooms as rooms
left join public.messages as messages on messages.room_id = rooms.id
group by rooms.id;
alter table private.firebase_chat_sequences enable row level security;
revoke all on private.firebase_chat_sequences
  from public, anon, authenticated, service_role;
-- Existing clients, administrative imports and tests still insert through the
-- established send_message path. Assign their room sequence in a BEFORE
-- trigger so adding the non-null column is backward compatible. The v2
-- callable may reserve a value explicitly; the trigger then only advances the
-- high-water defensively.
create function private.assign_message_sequence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sequence is null then
    insert into private.firebase_chat_sequences(room_id, high_water)
    values (new.room_id, 1)
    on conflict (room_id) do update
    set high_water = private.firebase_chat_sequences.high_water + 1
    returning high_water into new.sequence;
  else
    insert into private.firebase_chat_sequences(room_id, high_water)
    values (new.room_id, new.sequence)
    on conflict (room_id) do update
    set high_water = greatest(
      private.firebase_chat_sequences.high_water,
      excluded.high_water
    );
  end if;
  if new.sequence > 9007199254740991 then
    raise exception using errcode = '22003', message = 'message_sequence_exhausted';
  end if;
  return new;
end;
$$;
revoke all on function private.assign_message_sequence()
  from public, anon, authenticated, service_role;
create trigger assign_message_sequence
before insert on public.messages
for each row execute function private.assign_message_sequence();
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
