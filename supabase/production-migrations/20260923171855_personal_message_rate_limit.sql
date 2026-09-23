begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- The tenth successful send carries a fixed cooldown deadline. Failed calls
-- roll back their ledger writes and cannot move that deadline.
alter table private.message_attempts
  add column blocked_until timestamptz;

create function private.record_message_attempt(p_sender_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  send_time timestamptz;
  recent_count integer;
  is_blocked boolean;
begin
  -- The caller's UUID check happens while holding this same account lock.
  -- Reacquiring a transaction advisory lock here also protects future callers.
  perform pg_advisory_xact_lock(hashtextextended('message:' || p_sender_id::text, 0));
  send_time := clock_timestamp();

  select count(*) filter (
           where attempts.attempted_at >= send_time - interval '5 seconds'
         ),
         coalesce(bool_or(attempts.blocked_until > send_time), false)
  into recent_count, is_blocked
  from private.message_attempts as attempts
  where attempts.user_id = p_sender_id
    and attempts.attempted_at >= send_time - interval '10 seconds';

  if is_blocked or recent_count >= 10 then
    raise exception using errcode = 'P0001', message = 'message_rate_limited';
  end if;

  insert into private.message_attempts(user_id, attempted_at, blocked_until)
  values (
    p_sender_id,
    send_time,
    case when recent_count = 9 then send_time + interval '10 seconds' end
  );
end;
$$;
revoke all on function private.record_message_attempt(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.persist_message_for_user(
  p_sender_id uuid,
  p_id uuid,
  p_room_id uuid,
  p_body text
)
returns public.messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_body text := btrim(p_body);
  saved_message public.messages;
  selected_bubble_style_id text;
begin
  if p_sender_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_id is null then
    raise exception using errcode = '22023', message = 'message_id_required';
  end if;
  if not private.is_room_member(p_room_id, p_sender_id) then
    raise exception using errcode = '42501', message = 'membership_required';
  end if;
  if p_body is null
     or char_length(normalized_body) not between 1 and 200
     or array_length(regexp_split_to_array(p_body, E'\n'), 1) > 3
     or p_body ~ E'\r' then
    raise exception using errcode = '22023', message = 'invalid_message_body';
  end if;

  select * into saved_message from public.messages where id = p_id;
  if found then
    if saved_message.room_id != p_room_id
       or saved_message.sender_id != p_sender_id
       or saved_message.body != normalized_body then
      raise exception using errcode = '23505', message = 'message_id_conflict';
    end if;
    return saved_message;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('message:' || p_sender_id::text, 0));
  select * into saved_message from public.messages where id = p_id;
  if found then
    if saved_message.room_id != p_room_id
       or saved_message.sender_id != p_sender_id
       or saved_message.body != normalized_body then
      raise exception using errcode = '23505', message = 'message_id_conflict';
    end if;
    return saved_message;
  end if;

  perform private.record_message_attempt(p_sender_id);
  selected_bubble_style_id := private.owned_equipped_catalog_item(p_sender_id, 'bubble');

  insert into public.messages (id, room_id, sender_id, body, bubble_style_id)
  values (p_id, p_room_id, p_sender_id, normalized_body, selected_bubble_style_id)
  on conflict (id) do nothing;
  select * into saved_message from public.messages where id = p_id;
  if saved_message.room_id != p_room_id
     or saved_message.sender_id != p_sender_id
     or saved_message.body != normalized_body then
    raise exception using errcode = '23505', message = 'message_id_conflict';
  end if;
  return saved_message;
end;
$$;

create or replace function public.firebase_persist_realtime_message(
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

  -- Serialize all message transports for this account before the UUID lookup.
  perform pg_advisory_xact_lock(hashtextextended('message:' || p_sender_id::text, 0));
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

  perform private.record_message_attempt(p_sender_id);

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

commit;
