begin;

-- Expand the character-only catalog without changing existing product IDs or
-- PortOne/App Store transaction history.
alter table public.commerce_products
  drop constraint commerce_products_character_id_key,
  drop constraint commerce_products_character_id_format,
  drop constraint commerce_products_entitlement_key_format,
  alter column character_id drop not null,
  add column product_kind text,
  add column catalog_item_id text,
  add column sort_order integer;

update public.commerce_products
set product_kind = 'character',
    catalog_item_id = character_id,
    sort_order = case id
      when 'character_starlight_upalupa' then 10
      when 'character_guinea_pig' then 20
      when 'character_monkey' then 30
      when 'character_chinchilla' then 40
      else 90
    end;

alter table public.commerce_products
  alter column product_kind set not null,
  alter column catalog_item_id set not null,
  alter column sort_order set not null,
  add constraint commerce_products_kind check (
    product_kind in ('character', 'bubble', 'throwable')
  ),
  add constraint commerce_products_catalog_item_id_format check (
    catalog_item_id ~ '^(pixel|bubble|throwable)_[a-z0-9_]{1,60}$'
  ),
  add constraint commerce_products_entitlement_key_format check (
    entitlement_key ~ '^(character:pixel|bubble:bubble|throwable:throwable)_[a-z0-9_]{1,60}$'
  ),
  add constraint commerce_products_character_binding check (
    (product_kind = 'character' and character_id = catalog_item_id)
    or (product_kind != 'character' and character_id is null)
  ),
  add constraint commerce_products_sort_order_nonnegative check (sort_order >= 0),
  add constraint commerce_products_kind_catalog_unique unique (product_kind, catalog_item_id);

insert into public.commerce_products (
  id, display_name, product_description, character_id, entitlement_key,
  product_kind, catalog_item_id, sort_order, active
) values
  ('bubble_bunny_pink', '핑크 토끼 말풍선', '토끼 장식과 진한 글자가 있는 분홍 말풍선', null,
   'bubble:bubble_bunny_pink', 'bubble', 'bubble_bunny_pink', 110, true),
  ('bubble_butter_chick', '버터 병아리 말풍선', '병아리 장식과 진한 글자가 있는 버터색 말풍선', null,
   'bubble:bubble_butter_chick', 'bubble', 'bubble_butter_chick', 120, true),
  ('bubble_starry_cat', '별밤 고양이 말풍선', '별고양이 장식과 밝은 글자가 있는 남보라 말풍선', null,
   'bubble:bubble_starry_cat', 'bubble', 'bubble_starry_cat', 130, true),
  ('throwable_bouncy_heart', '통통 하트', '통통 튀며 날아가는 하트', null,
   'throwable:throwable_bouncy_heart', 'throwable', 'throwable_bouncy_heart', 210, true),
  ('throwable_toy_cannon', '미니 대포', '캐릭터 앞 몸통에 대포가 나타나 심지탄을 발사하고 몸통에서 폭발하는 연출', null,
   'throwable:throwable_toy_cannon', 'throwable', 'throwable_toy_cannon', 220, true),
  ('throwable_squeaky_duck', '삑삑 오리', '빙글빙글 날아가는 노란 오리', null,
   'throwable:throwable_squeaky_duck', 'throwable', 'throwable_squeaky_duck', 230, true);

insert into public.commerce_prices (product_id, amount_krw, currency, tax_inclusive, active)
values
  ('bubble_bunny_pink', 1900, 'KRW', true, true),
  ('bubble_butter_chick', 1900, 'KRW', true, true),
  ('bubble_starry_cat', 1900, 'KRW', true, true),
  ('throwable_bouncy_heart', 990, 'KRW', true, true),
  ('throwable_toy_cannon', 3900, 'KRW', true, true),
  ('throwable_squeaky_duck', 990, 'KRW', true, true);

-- Preserve the disclosure copied onto historical orders, but use a generic
-- product term for every order created after this catalog expansion.
update private.commerce_runtime_settings
set policy_version = '2026-09-05-cosmetics-v1',
    policy_notice = '표시 가격은 부가세 포함 금액이며 구매 전 Google 계정 연결이 필요합니다. 결제창은 PortOne을 통해 연결된 결제대행사가 제공합니다. SIDEY 서버가 결제 금액과 상태를 다시 확인한 뒤 디지털 꾸미기 사용권 제공이 즉시 시작됩니다. 제공 시작 뒤 단순 변심에 따른 청약철회와 환불은 불가합니다. 다만 사용권 미제공, 표시·계약 내용 불일치, 중복 결제, 본인이 승인하지 않은 결제 등 관련 법령상 사유가 확인되면 전액 환불합니다.',
    updated_at = now();

alter table public.profiles
  add column equipped_bubble_style_id text,
  add column equipped_throwable_id text,
  add constraint profiles_equipped_bubble_format check (
    equipped_bubble_style_id is null or equipped_bubble_style_id ~ '^bubble_[a-z0-9_]{1,60}$'
  ),
  add constraint profiles_equipped_throwable_format check (
    equipped_throwable_id is null or equipped_throwable_id ~ '^throwable_[a-z0-9_]{1,60}$'
  );

alter table public.messages
  add column bubble_style_id text,
  add constraint messages_bubble_style_format check (
    bubble_style_id is null or bubble_style_id ~ '^bubble_[a-z0-9_]{1,60}$'
  );

create or replace function private.owned_equipped_catalog_item(
  check_user_id uuid,
  check_product_kind text
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case check_product_kind
    when 'bubble' then profiles.equipped_bubble_style_id
    when 'throwable' then profiles.equipped_throwable_id
  end
  from public.profiles profiles
  join public.commerce_products products
    on products.product_kind = check_product_kind
   and products.catalog_item_id = case check_product_kind
     when 'bubble' then profiles.equipped_bubble_style_id
     when 'throwable' then profiles.equipped_throwable_id
   end
   and products.active is true
  join public.commerce_entitlements entitlements
    on entitlements.user_id = profiles.id
   and entitlements.entitlement_key = products.entitlement_key
   and entitlements.status = 'active'
  where profiles.id = check_user_id
    and check_product_kind in ('bubble', 'throwable');
$$;

revoke all on function private.owned_equipped_catalog_item(uuid, text)
from public, anon, authenticated;

create or replace function public.get_store_state()
returns table (
  product_id text,
  display_name text,
  product_description text,
  product_kind text,
  catalog_item_id text,
  character_id text,
  entitlement_key text,
  sort_order integer,
  amount_krw integer,
  currency text,
  tax_inclusive boolean,
  google_connected boolean,
  entitlement_status text,
  latest_order_status text,
  is_equipped boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  return query
  select products.id,
         products.display_name,
         products.product_description,
         products.product_kind,
         products.catalog_item_id,
         products.character_id,
         products.entitlement_key,
         products.sort_order,
         prices.amount_krw,
         prices.currency,
         prices.tax_inclusive,
         private.has_google_identity(current_user_id),
         (select entitlements.status
          from public.commerce_entitlements entitlements
          where entitlements.user_id = current_user_id
            and entitlements.entitlement_key = products.entitlement_key),
         (select orders.status
          from public.commerce_orders orders
          where orders.user_id = current_user_id
            and orders.product_id = products.id
          order by orders.created_at desc
          limit 1),
         case products.product_kind
           when 'bubble' then products.catalog_item_id = profiles.equipped_bubble_style_id
           when 'throwable' then products.catalog_item_id = profiles.equipped_throwable_id
           when 'character' then products.catalog_item_id = profiles.character_id
           else false
         end
  from public.commerce_products products
  join public.commerce_prices prices
    on prices.product_id = products.id and prices.active is true
  left join public.profiles profiles on profiles.id = current_user_id
  where products.active is true
  order by products.sort_order, products.id;
end;
$$;

revoke all on function public.get_store_state() from public, anon;
grant execute on function public.get_store_state() to authenticated;

create or replace function public.set_equipped_cosmetic(
  p_product_kind text,
  p_catalog_item_id text
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  required_entitlement text;
  saved_profile public.profiles;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_product_kind not in ('bubble', 'throwable') then
    raise exception using errcode = '22023', message = 'invalid_cosmetic_kind';
  end if;

  if p_catalog_item_id is not null then
    select products.entitlement_key into required_entitlement
    from public.commerce_products products
    where products.product_kind = p_product_kind
      and products.catalog_item_id = p_catalog_item_id
      and products.active is true;
    if required_entitlement is null then
      raise exception using errcode = '22023', message = 'unknown_cosmetic';
    end if;
    if not exists (
      select 1 from public.commerce_entitlements entitlements
      where entitlements.user_id = current_user_id
        and entitlements.entitlement_key = required_entitlement
        and entitlements.status = 'active'
    ) then
      raise exception using errcode = '42501', message = 'cosmetic_ownership_required';
    end if;
  end if;

  update public.profiles profiles
  set equipped_bubble_style_id = case
        when p_product_kind = 'bubble' then p_catalog_item_id
        else profiles.equipped_bubble_style_id
      end,
      equipped_throwable_id = case
        when p_product_kind = 'throwable' then p_catalog_item_id
        else profiles.equipped_throwable_id
      end,
      updated_at = now()
  where profiles.id = current_user_id
  returning * into saved_profile;
  if not found then
    raise exception using errcode = 'P0001', message = 'profile_required';
  end if;
  return saved_profile;
end;
$$;

revoke all on function public.set_equipped_cosmetic(text, text) from public, anon;
grant execute on function public.set_equipped_cosmetic(text, text) to authenticated;

create or replace function private.reconcile_cosmetic_entitlement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_user_id uuid := coalesce(new.user_id, old.user_id);
  affected_key text := coalesce(new.entitlement_key, old.entitlement_key);
  item_kind text;
  item_id text;
  entitlement_active boolean := tg_op != 'DELETE' and new.status = 'active';
begin
  select products.product_kind, products.catalog_item_id
  into item_kind, item_id
  from public.commerce_products products
  where products.entitlement_key = affected_key;

  if not entitlement_active and item_kind = 'bubble' then
    update public.profiles
    set equipped_bubble_style_id = null, updated_at = now()
    where id = affected_user_id and equipped_bubble_style_id = item_id;
  elsif not entitlement_active and item_kind = 'throwable' then
    update public.profiles
    set equipped_throwable_id = null, updated_at = now()
    where id = affected_user_id and equipped_throwable_id = item_id;
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function private.reconcile_cosmetic_entitlement()
from public, anon, authenticated;

create trigger commerce_entitlements_reconcile_cosmetics
after insert or update of status or delete on public.commerce_entitlements
for each row execute function private.reconcile_cosmetic_entitlement();

create or replace function private.auto_equip_portone_cosmetic()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  item_kind text;
  item_id text;
begin
  if new.user_id is null then
    return new;
  end if;
  select products.product_kind, products.catalog_item_id
  into item_kind, item_id
  from public.commerce_products products
  where products.id = new.product_id;

  if new.status = 'approved' and item_kind = 'bubble' then
    update public.profiles set equipped_bubble_style_id = item_id, updated_at = now()
    where id = new.user_id;
  elsif new.status = 'approved' and item_kind = 'throwable' then
    update public.profiles set equipped_throwable_id = item_id, updated_at = now()
    where id = new.user_id;
  elsif new.status = 'refunded' and item_kind = 'bubble' then
    update public.profiles set equipped_bubble_style_id = null, updated_at = now()
    where id = new.user_id and equipped_bubble_style_id = item_id;
  elsif new.status = 'refunded' and item_kind = 'throwable' then
    update public.profiles set equipped_throwable_id = null, updated_at = now()
    where id = new.user_id and equipped_throwable_id = item_id;
  end if;
  return new;
end;
$$;

revoke all on function private.auto_equip_portone_cosmetic()
from public, anon, authenticated;

create trigger commerce_orders_update_cosmetic_equipment
after insert or update of status on public.commerce_orders
for each row
when (new.status in ('approved', 'refunded'))
execute function private.auto_equip_portone_cosmetic();

create or replace function private.enforce_app_store_character_product()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.commerce_products products
    where products.id = new.product_id and products.product_kind = 'character'
  ) then
    raise exception using errcode = '22023', message = 'app_store_character_product_required';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_app_store_character_product()
from public, anon, authenticated;

create trigger app_store_transactions_character_only
before insert or update of product_id on private.app_store_transactions
for each row execute function private.enforce_app_store_character_product();

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
  selected_bubble_style_id text;
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
  selected_bubble_style_id := private.owned_equipped_catalog_item(current_user_id, 'bubble');

  insert into public.messages (id, room_id, sender_id, body, bubble_style_id)
  values (p_id, p_room_id, current_user_id, normalized_body, selected_bubble_style_id)
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

create or replace function public.broadcast_character_throw(
  p_room_id uuid,
  p_realtime_epoch bigint,
  p_event_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_epoch bigint;
  source_character_id text;
  selected_throwable_id text;
  recent_attempts integer;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_event_id is null then
    raise exception using errcode = '22023', message = 'event_id_required';
  end if;
  if p_target_user_id is null then
    raise exception using errcode = '22023', message = 'target_user_id_required';
  end if;
  if p_target_user_id = current_user_id then
    raise exception using errcode = '22023', message = 'self_target_forbidden';
  end if;

  select rooms.realtime_epoch into current_epoch
  from public.rooms
  where rooms.id = p_room_id
    and private.is_room_member(rooms.id, current_user_id);
  if not found then
    raise exception using errcode = '42501', message = 'membership_required';
  end if;
  if current_epoch != p_realtime_epoch then
    raise exception using errcode = 'PT409', message = 'stale_realtime_epoch';
  end if;
  if not private.is_room_member(p_room_id, p_target_user_id) then
    raise exception using errcode = '42501', message = 'target_membership_required';
  end if;

  select profiles.character_id into source_character_id
  from public.profiles
  where profiles.id = current_user_id;
  if source_character_id is null then
    raise exception using errcode = 'P0001', message = 'profile_required';
  end if;
  selected_throwable_id := private.owned_equipped_catalog_item(current_user_id, 'throwable');

  perform pg_advisory_xact_lock(hashtextextended(
    'event:' || current_user_id::text || ':character_throw', 0
  ));
  select count(*) into recent_attempts
  from private.realtime_event_attempts
  where user_id = current_user_id
    and event_name = 'character_throw'
    and attempted_at >= now() - interval '10 seconds';
  if recent_attempts >= 20 then
    raise exception using errcode = 'P0001', message = 'realtime_event_rate_limited';
  end if;
  insert into private.realtime_event_attempts (user_id, room_id, event_name)
  values (current_user_id, p_room_id, 'character_throw');

  perform realtime.send(
    jsonb_strip_nulls(jsonb_build_object(
      'schema_version', 1,
      'room_id', p_room_id,
      'event_id', p_event_id,
      'actor_user_id', current_user_id,
      'target_user_id', p_target_user_id,
      'source_character_id', source_character_id,
      'throwable_id', selected_throwable_id
    )),
    'character_throw',
    private.room_topic(p_room_id, current_epoch, 'ephemeral'),
    true
  );
end;
$$;

-- RPC signatures and privileges stay unchanged for older clients.
revoke all on function public.send_message(uuid, uuid, text) from public, anon;
grant execute on function public.send_message(uuid, uuid, text) to authenticated;
revoke all on function public.broadcast_character_throw(uuid, bigint, uuid, uuid)
from public, anon;
grant execute on function public.broadcast_character_throw(uuid, bigint, uuid, uuid)
to authenticated;

commit;
