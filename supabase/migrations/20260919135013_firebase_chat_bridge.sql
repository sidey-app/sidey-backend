begin;

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
  recent_attempts integer;
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

  select count(*) into recent_attempts
  from private.message_attempts
  where user_id = p_sender_id and attempted_at >= now() - interval '10 seconds';
  if recent_attempts >= 30 then
    raise exception using errcode = 'P0001', message = 'message_rate_limited';
  end if;
  insert into private.message_attempts (user_id) values (p_sender_id);
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

revoke all on function private.persist_message_for_user(uuid, uuid, uuid, text)
from public, anon, authenticated, service_role;

create or replace function public.send_message(p_id uuid, p_room_id uuid, p_body text)
returns public.messages
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
  return private.persist_message_for_user(current_user_id, p_id, p_room_id, p_body);
end;
$$;

revoke all on function public.send_message(uuid, uuid, text) from public, anon;
grant execute on function public.send_message(uuid, uuid, text) to authenticated;

create or replace function public.firebase_persist_message(
  p_id uuid,
  p_room_id uuid,
  p_sender_id uuid,
  p_body text
)
returns public.messages
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.persist_message_for_user(p_sender_id, p_id, p_room_id, p_body);
end;
$$;

revoke all on function public.firebase_persist_message(uuid, uuid, uuid, text)
from public, anon, authenticated;
grant execute on function public.firebase_persist_message(uuid, uuid, uuid, text)
to service_role;

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
begin
  if p_user_id is null or not exists (
    select 1 from auth.users users where users.id = p_user_id
  ) then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select coalesce(jsonb_agg(members.room_id order by members.room_id), '[]'::jsonb)
  into room_ids
  from public.room_members members
  where members.user_id = p_user_id;

  select coalesce(jsonb_agg(products.catalog_item_id order by products.catalog_item_id), '[]'::jsonb)
  into throwable_ids
  from public.profiles profiles
  join public.commerce_products products
    on products.product_kind = 'throwable'
   and products.catalog_item_id = profiles.equipped_throwable_id
   and products.active is true
  join public.commerce_entitlements entitlements
    on entitlements.user_id = profiles.id
   and entitlements.entitlement_key = products.entitlement_key
   and entitlements.status = 'active'
  where profiles.id = p_user_id;

  return jsonb_build_object(
    'user_id', p_user_id,
    'rooms', room_ids,
    'items', throwable_ids
  );
end;
$$;

revoke all on function public.firebase_realtime_access(uuid)
from public, anon, authenticated;
grant execute on function public.firebase_realtime_access(uuid)
to service_role;

commit;
;
