-- Keep the store RPC JSON contract stable when a profile uses the default
-- bubble or throwable. SQL equality against NULL yields NULL, but clients
-- consume is_equipped as a required boolean.
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
         coalesce(
           case products.product_kind
             when 'bubble' then products.catalog_item_id = profiles.equipped_bubble_style_id
             when 'throwable' then products.catalog_item_id = profiles.equipped_throwable_id
             when 'character' then products.catalog_item_id = profiles.character_id
             else false
           end,
           false
         )
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
