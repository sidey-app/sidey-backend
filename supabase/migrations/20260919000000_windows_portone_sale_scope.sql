-- Windows 1.4 candidate: public SIDEY catalog snapshot 43c489ff2da69745c8bc7122795019f77ade6239.
-- Independent from Apple offers: future products fail closed for PortOne.
alter table public.commerce_products
  add column portone_sale_enabled boolean not null default false;

update public.commerce_products set portone_sale_enabled = true where id in (
  'bubble_bunny_pink',
  'bubble_butter_chick',
  'bubble_starry_cat',
  'character_chinchilla',
  'character_guinea_pig',
  'character_monkey',
  'character_otter',
  'character_pig',
  'character_starlight_upalupa',
  'character_tree',
  'throwable_banana',
  'throwable_baseball',
  'throwable_bouncy_heart',
  'throwable_clam',
  'throwable_dujjonku',
  'throwable_dust_bath_pouch',
  'throwable_mini_paprika',
  'throwable_pork',
  'throwable_snowflake',
  'throwable_squeaky_duck',
  'throwable_starlight_orb',
  'throwable_timber',
  'throwable_toy_cannon',
  'throwable_wakkuball'
);

create or replace function public.create_commerce_order(
  p_product_id text,
  p_checkout_token_hash_hex text
)
returns table (
  order_id uuid,
  provider_order_id text,
  display_name text,
  amount_krw integer,
  currency text,
  checkout_token_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  selected_product public.commerce_products;
  selected_price public.commerce_prices;
  created_order public.commerce_orders;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if not private.has_google_identity(current_user_id) then
    raise exception using errcode = 'P0001', message = 'google_identity_required';
  end if;
  if p_checkout_token_hash_hex !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_checkout_token';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('commerce-order:' || current_user_id::text, 0));
  if (
    select count(*) from public.commerce_orders
    where user_id = current_user_id and created_at >= now() - interval '1 minute'
  ) >= 5 then
    raise exception using errcode = 'P0001', message = 'commerce_order_rate_limited';
  end if;

  select * into selected_product
  from public.commerce_products
  where id = p_product_id and active is true and portone_sale_enabled is true;
  if not found then
    raise exception using errcode = 'P0001', message = 'commerce_product_unavailable';
  end if;

  if exists (
    select 1 from public.commerce_entitlements
    where user_id = current_user_id
      and entitlement_key = selected_product.entitlement_key
      and status = 'active'
  ) then
    raise exception using errcode = 'P0001', message = 'already_owned';
  end if;

  select * into selected_price
  from public.commerce_prices
  where product_id = selected_product.id and active is true
  for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'commerce_price_unavailable';
  end if;

  update public.commerce_orders
  set status = 'canceled', updated_at = now()
  where user_id = current_user_id and product_id = selected_product.id and status = 'pending';

  insert into public.commerce_orders (
    provider_order_id,
    user_id,
    product_id,
    price_id,
    amount_krw,
    currency,
    checkout_token_hash,
    checkout_token_expires_at
  )
  values (
    'sidey_' || replace(extensions.gen_random_uuid()::text, '-', ''),
    current_user_id,
    selected_product.id,
    selected_price.id,
    selected_price.amount_krw,
    selected_price.currency,
    decode(p_checkout_token_hash_hex, 'hex'),
    now() + interval '15 minutes'
  )
  returning * into created_order;

  return query select created_order.id,
                      created_order.provider_order_id,
                      selected_product.display_name,
                      created_order.amount_krw,
                      created_order.currency,
                      created_order.checkout_token_expires_at;
end;
$$;

revoke all on function public.create_commerce_order(text, text) from public, anon;
grant execute on function public.create_commerce_order(text, text) to authenticated;

create or replace function public.get_windows_store_state()
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
  is_equipped boolean,
  related_character_product_id text,
  render_asset_id text,
  app_store_product_id text
)
language sql
stable
security definer
set search_path = ''
as $$
  select state.* from public.get_store_state() state
  join public.commerce_products product on product.id = state.product_id
  where product.portone_sale_enabled is true;
$$;
revoke all on function public.get_windows_store_state() from public, anon;
grant execute on function public.get_windows_store_state() to authenticated;
