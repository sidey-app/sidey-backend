-- Retire the original cannon price without rewriting any order that already
-- snapshots it, then publish the newly confirmed active price.
update public.commerce_prices
set active = false,
    retired_at = coalesce(retired_at, now())
where product_id = 'throwable_toy_cannon'
  and active is true;

insert into public.commerce_prices (
  id, product_id, amount_krw, currency, tax_inclusive, active
)
values (
  '510e7000-0000-0000-0000-000000002900',
  'throwable_toy_cannon',
  2900,
  'KRW',
  true,
  true
)
on conflict (id) do update
set amount_krw = excluded.amount_krw,
    currency = excluded.currency,
    tax_inclusive = excluded.tax_inclusive,
    active = true,
    retired_at = null;

-- Keep the cosmetic reset RPC callable by both older clients that omit the
-- catalog item argument and newer clients that send an explicit JSON null.
create or replace function public.set_equipped_cosmetic(
  p_product_kind text,
  p_catalog_item_id text default null
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

-- Messages are deliberately short-lived. Suppress row-by-row broadcasts and
-- emit exactly one invalidation per room whose retained history changed.
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
    where created_at < now() - interval '3 days'
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

-- Enforce the new boundary immediately. This is intentionally irreversible.
select private.delete_expired_messages();

-- PostgREST must rediscover the optional second RPC argument.
notify pgrst, 'reload schema';
