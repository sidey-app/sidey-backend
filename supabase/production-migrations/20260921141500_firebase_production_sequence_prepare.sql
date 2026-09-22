begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- Production-only online preparation for the compact v2 message contract.
-- The historical staging migration performed a whole-table update and index
-- build while holding one transaction. Production instead installs a nullable
-- column and a legacy-compatible insert trigger behind one short metadata/count
-- lock, then backfills existing rooms in separately committed batches.

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

lock table public.messages in share row exclusive mode;
alter table public.messages add column sequence bigint;

create table private.firebase_chat_sequences (
  room_id uuid primary key,
  high_water bigint not null
    check (high_water between 0 and 9007199254740991)
);

insert into private.firebase_chat_sequences(room_id, high_water)
select rooms.id, count(messages.id)
from public.rooms as rooms
left join public.messages as messages on messages.room_id = rooms.id
group by rooms.id;

alter table private.firebase_chat_sequences enable row level security;
revoke all on private.firebase_chat_sequences
  from public, anon, authenticated, service_role;

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

-- Adding a column to a PostgreSQL table composite would otherwise silently add
-- `sequence` to the released send_message RPC JSON. A named scalar composite
-- preserves both the six released fields and PostgREST's single-object RPC
-- envelope; RETURNS TABLE would change that envelope to an array.
create type public.legacy_message_response as (
  id uuid,
  room_id uuid,
  sender_id uuid,
  body text,
  created_at timestamptz,
  bubble_style_id text
);
drop function public.send_message(uuid, uuid, text);
create function public.send_message(
  p_id uuid,
  p_room_id uuid,
  p_body text
)
returns public.legacy_message_response
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  saved_message public.messages;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  saved_message := private.persist_message_for_user(
    current_user_id,
    p_id,
    p_room_id,
    p_body
  );
  return row(
    saved_message.id,
    saved_message.room_id,
    saved_message.sender_id,
    saved_message.body,
    saved_message.created_at,
    saved_message.bubble_style_id
  )::public.legacy_message_response;
end;
$$;
revoke all on function public.send_message(uuid, uuid, text) from public, anon;
grant execute on function public.send_message(uuid, uuid, text) to authenticated;

create table private.firebase_message_backfill_rooms (
  room_id uuid primary key references public.rooms(id) on delete cascade,
  completed_at timestamptz
);

insert into private.firebase_message_backfill_rooms(room_id)
select distinct messages.room_id
from public.messages as messages
where messages.sequence is null;

alter table private.firebase_message_backfill_rooms enable row level security;
revoke all on private.firebase_message_backfill_rooms
  from public, anon, authenticated, service_role;

create function private.backfill_firebase_message_sequences(p_room_limit integer)
returns table(room_count integer, message_count bigint, remaining_rooms bigint)
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '60s'
as $$
declare
  selected_rooms uuid[];
  changed bigint;
begin
  if p_room_limit is null or p_room_limit < 1 or p_room_limit > 100 then
    raise exception using errcode = '22023', message = 'invalid_room_limit';
  end if;

  select coalesce(array_agg(pending.room_id order by pending.room_id), '{}'::uuid[])
  into selected_rooms
  from (
    select progress.room_id
    from private.firebase_message_backfill_rooms as progress
    where progress.completed_at is null
    order by progress.room_id
    for update skip locked
    limit p_room_limit
  ) as pending;

  -- Historical sequence assignment is internal migration bookkeeping, not a
  -- user-visible message change. Suppress only this transaction's legacy
  -- Broadcast trigger; concurrent new-message transactions remain unaffected.
  perform set_config('sidey.suppress_message_broadcast', 'on', true);
  with ranked as (
    select messages.id,
           row_number() over (
             partition by messages.room_id order by messages.created_at, messages.id
           )::bigint as sequence
    from public.messages as messages
    where messages.room_id = any(selected_rooms)
      and messages.sequence is null
  )
  update public.messages as messages
  set sequence = ranked.sequence
  from ranked
  where messages.id = ranked.id;
  get diagnostics changed = row_count;
  perform set_config('sidey.suppress_message_broadcast', 'off', true);

  update private.firebase_message_backfill_rooms as progress
  set completed_at = clock_timestamp()
  where progress.room_id = any(selected_rooms)
    and not exists (
      select 1
      from public.messages as messages
      where messages.room_id = progress.room_id
        and messages.sequence is null
    );

  return query
  select cardinality(selected_rooms),
         changed,
         count(*)
  from private.firebase_message_backfill_rooms as progress
  where progress.completed_at is null;
end;
$$;

revoke all on function private.backfill_firebase_message_sequences(integer)
  from public, anon, authenticated, service_role;

commit;
