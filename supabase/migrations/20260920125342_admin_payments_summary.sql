begin;

-- This is a reviewed, immutable reporting snapshot. It deliberately does not
-- follow the mutable direct-sale prices in public.commerce_prices.
create table private.admin_payment_catalog_snapshot (
  product_id text primary key,
  product_name text not null,
  product_kind text not null,
  app_store_price_krw integer,
  currency text not null,
  source_commit text not null,
  price_effective_at timestamptz not null,
  constraint admin_payment_catalog_kind check (
    product_kind in ('character', 'bubble', 'throwable')
  ),
  constraint admin_payment_catalog_price check (
    app_store_price_krw is null or app_store_price_krw >= 0
  ),
  constraint admin_payment_catalog_currency check (currency = 'KRW'),
  constraint admin_payment_catalog_source_commit check (
    source_commit ~ '^[0-9a-f]{40}$'
  )
);

alter table private.admin_payment_catalog_snapshot enable row level security;
revoke all on private.admin_payment_catalog_snapshot from public, anon, authenticated;

insert into private.admin_payment_catalog_snapshot (
  product_id, product_name, product_kind, app_store_price_krw,
  currency, source_commit, price_effective_at
) values
  ('character_starlight_upalupa', '별빛 우파루파', 'character', 2200, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('character_guinea_pig', '아기 기니피그', 'character', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('character_monkey', '아기 원숭이', 'character', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('character_chinchilla', '아기 친칠라', 'character', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('character_otter', '아기 수달', 'character', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('character_pig', '아기 돼지', 'character', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('character_tree', '나무', 'character', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('bubble_bunny_pink', '핑크 토끼 말풍선', 'bubble', 2200, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('bubble_butter_chick', '버터 병아리 말풍선', 'bubble', 2200, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('bubble_starry_cat', '별밤 고양이 말풍선', 'bubble', 2200, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_bouncy_heart', '통통 하트', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_toy_cannon', '미니 대포', 'throwable', 3300, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_squeaky_duck', '삑삑 오리', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_snowflake', '눈송이', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_baseball', '야구공', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_wakkuball', '왁뿌볼', 'throwable', 2200, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_dujjonku', '두쫀쿠', 'throwable', 2200, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_mini_paprika', '기니피그의 미니 파프리카', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_banana', '원숭이의 바나나', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_dust_bath_pouch', '친칠라의 모래주머니', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_starlight_orb', '별빛 우파루파의 별빛 구슬', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_clam', '수달의 조개', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_pork', '아기 돼지의 돼지고기', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_timber', '나무의 작은 나무', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('character_shiba', '시바견', 'character', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_tennis_ball', '테니스공', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('character_duck', '오리', 'character', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('character_poop', '똥', 'character', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_tissue_ball', '휴지 뭉치', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('character_tteokbokki', '떡볶이', 'character', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_fish_cake_skewer', '어묵꼬치', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('character_quokka', '쿼카', 'character', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00'),
  ('throwable_leaf', '잎사귀', 'throwable', 1100, 'KRW', '96f62abc0b350791de8e0d7c3b3af33f4e73dae6', '2026-09-16T02:20:05+09:00');

-- The environment/purchase index already serves the App Store summary range.
-- Add only the user-history lookup and the approved web-purchase range index.
create index app_store_transactions_user_production_history_idx
on private.app_store_transactions (user_id, purchased_at desc)
where environment = 'Production' and user_id is not null;

create index commerce_orders_admin_purchase_idx
on public.commerce_orders (approved_at desc, product_id, user_id)
where approved_at is not null and status in ('approved', 'refunded');

create or replace function public.admin_payments_summary(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_source text default 'all',
  p_search text default '',
  p_kind text default 'all'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  perform private.require_admin_service_role();
  if p_source is null or p_source not in ('all', 'app_store', 'web')
     or p_kind is null or p_kind not in ('all', 'character', 'bubble', 'throwable')
     or p_search is null or char_length(p_search) > 100
     or (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception using errcode = '22023', message = 'invalid_admin_payments_summary_query';
  end if;

  with app_store_ledger as materialized (
    select tx.product_id, tx.user_id, tx.app_account_token, tx.binding_state,
           tx.status, tx.price_milliunits, tx.currency
    from private.app_store_transactions tx
    where p_source in ('all', 'app_store')
      and tx.environment = 'Production'
      and (p_from is null or tx.purchased_at >= p_from)
      and (p_to is null or tx.purchased_at < p_to)
  ), app_store_by_product as (
    select product_id,
           count(*)::bigint as transaction_count,
           count(*) filter (where status = 'active')::bigint as active_count,
           count(*) filter (where status != 'active')::bigint as revoked_count
    from app_store_ledger
    group by product_id
  ), web_ledger as materialized (
    select orders.product_id, orders.user_id, orders.status,
           payments.amount_krw, payments.balance_amount_krw
    from public.commerce_orders orders
    join private.commerce_payments payments on payments.order_id = orders.id
    where p_source in ('all', 'web')
      and orders.status in ('approved', 'refunded')
      and orders.approved_at is not null
      and payments.provider = 'portone'
      and payments.portone_channel_type = 'LIVE'
      and payments.currency = 'KRW'
      and payments.balance_amount_krw is not null
      and (p_from is null or orders.approved_at >= p_from)
      and (p_to is null or orders.approved_at < p_to)
  ), web_by_product as (
    select product_id,
           count(*)::bigint as transaction_count,
           count(*) filter (where balance_amount_krw > 0)::bigint as active_count,
           count(*) filter (where balance_amount_krw < amount_krw)::bigint as refunded_count,
           coalesce(sum(amount_krw), 0)::bigint as purchase_krw,
           coalesce(sum(amount_krw - balance_amount_krw), 0)::bigint as refunded_krw,
           coalesce(sum(balance_amount_krw), 0)::bigint as active_krw
    from web_ledger
    group by product_id
  ), sold_products as (
    select product_id from app_store_by_product
    union
    select product_id from web_by_product
  ), filtered_products as (
    select sold.product_id,
           coalesce(catalog.product_name, products.display_name, sold.product_id) as product_name,
           coalesce(catalog.product_kind, products.product_kind) as product_kind,
           catalog.app_store_price_krw
    from sold_products sold
    left join private.admin_payment_catalog_snapshot catalog on catalog.product_id = sold.product_id
    left join public.commerce_products products on products.id = sold.product_id
    where (p_kind = 'all' or coalesce(catalog.product_kind, products.product_kind) = p_kind)
      and (p_search = ''
        or sold.product_id ilike '%' || p_search || '%'
        or coalesce(catalog.product_name, products.display_name, '') ilike '%' || p_search || '%')
  ), app_store_filtered as materialized (
    select ledger.*
    from app_store_ledger ledger
    join filtered_products products on products.product_id = ledger.product_id
  ), app_store_totals as (
    select count(*)::bigint as transaction_count,
           count(distinct coalesce(user_id, app_account_token))::bigint as purchaser_count,
           count(*) filter (where binding_state = 'unbound')::bigint as unbound_count,
           count(*) filter (where status = 'active')::bigint as active_count,
           count(*) filter (where status = 'refunded')::bigint as refunded_count,
           count(*) filter (where status = 'revoked')::bigint as revoked_count
    from app_store_filtered
  ), app_store_estimates as (
    select coalesce(sum(items.transaction_count * products.app_store_price_krw), 0)::bigint as purchase_krw,
           coalesce(sum(items.active_count * products.app_store_price_krw), 0)::bigint as active_krw,
           coalesce(sum(items.revoked_count * products.app_store_price_krw), 0)::bigint as revoked_krw,
           coalesce(sum(items.transaction_count) filter (where products.app_store_price_krw is null), 0)::bigint as missing_count
    from app_store_by_product items
    join filtered_products products on products.product_id = items.product_id
  ), app_store_confirmed as (
    select currency,
           sum(price_milliunits::numeric / 1000) as purchase_amount,
           coalesce(sum(price_milliunits::numeric / 1000) filter (where status != 'active'), 0) as revoked_amount,
           coalesce(sum(price_milliunits::numeric / 1000) filter (where status = 'active'), 0) as active_amount
    from app_store_filtered
    where price_milliunits is not null and currency is not null
    group by currency
  ), web_filtered as materialized (
    select ledger.*
    from web_ledger ledger
    join filtered_products products on products.product_id = ledger.product_id
  ), web_totals as (
    select count(*)::bigint as transaction_count,
           count(distinct user_id)::bigint as purchaser_count,
           count(*) filter (where balance_amount_krw > 0)::bigint as active_count,
           count(*) filter (where balance_amount_krw < amount_krw)::bigint as refunded_count,
           coalesce(sum(amount_krw), 0)::bigint as purchase_krw,
           coalesce(sum(amount_krw - balance_amount_krw), 0)::bigint as refunded_krw,
           coalesce(sum(balance_amount_krw), 0)::bigint as active_krw
    from web_filtered
  ), product_rows as (
    select filtered.product_id,
           filtered.product_name,
           filtered.product_kind,
           filtered.app_store_price_krw,
           coalesce(app_store.transaction_count, 0)::bigint as app_store_transaction_count,
           coalesce(app_store.active_count, 0)::bigint as app_store_active_count,
           coalesce(app_store.revoked_count, 0)::bigint as app_store_revoked_count,
           case when filtered.app_store_price_krw is null then 0
                else coalesce(app_store.transaction_count, 0) * filtered.app_store_price_krw end::bigint as app_store_purchase_krw,
           case when filtered.app_store_price_krw is null then 0
                else coalesce(app_store.active_count, 0) * filtered.app_store_price_krw end::bigint as app_store_active_krw,
           case when filtered.app_store_price_krw is null then coalesce(app_store.transaction_count, 0)
                else 0 end::bigint as app_store_missing_price_count,
           coalesce(web.transaction_count, 0)::bigint as web_transaction_count,
           coalesce(web.active_count, 0)::bigint as web_active_count,
           coalesce(web.refunded_count, 0)::bigint as web_refunded_count,
           coalesce(web.purchase_krw, 0)::bigint as web_purchase_krw,
           coalesce(web.refunded_krw, 0)::bigint as web_refunded_krw,
           coalesce(web.active_krw, 0)::bigint as web_active_krw
    from filtered_products filtered
    left join app_store_by_product app_store on app_store.product_id = filtered.product_id
    left join web_by_product web on web.product_id = filtered.product_id
  ), catalog_metadata as (
    select min(source_commit) as source_commit,
           min(price_effective_at) as price_effective_at,
           min(currency) as currency
    from private.admin_payment_catalog_snapshot
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'catalog', jsonb_build_object(
      'sourceCommit', catalog_metadata.source_commit,
      'priceEffectiveAt', catalog_metadata.price_effective_at,
      'currency', catalog_metadata.currency
    ),
    'combined', jsonb_build_object(
      'transactionCount', app_store_totals.transaction_count + web_totals.transaction_count,
      'activeTransactionCount', app_store_totals.active_count + web_totals.active_count,
      'refundedOrRevokedTransactionCount',
        app_store_totals.refunded_count + app_store_totals.revoked_count
        + web_totals.refunded_count,
      'appStoreActiveAmountKrw', app_store_estimates.active_krw,
      'webActiveAmountKrw', web_totals.active_krw,
      'activePurchaseAmountKrw', app_store_estimates.active_krw + web_totals.active_krw
    ),
    'appStore', jsonb_build_object(
      'transactionCount', app_store_totals.transaction_count,
      'purchaserCount', app_store_totals.purchaser_count,
      'unboundTransactionCount', app_store_totals.unbound_count,
      'activeTransactionCount', app_store_totals.active_count,
      'refundedTransactionCount', app_store_totals.refunded_count,
      'revokedTransactionCount', app_store_totals.revoked_count,
      'estimatedPurchaseKrw', app_store_estimates.purchase_krw,
      'estimatedActiveKrw', app_store_estimates.active_krw,
      'estimatedRevokedKrw', app_store_estimates.revoked_krw,
      'missingPriceTransactionCount', app_store_estimates.missing_count,
      'confirmedAmounts', coalesce((select jsonb_agg(jsonb_build_object(
        'currency', currency,
        'purchaseAmount', purchase_amount,
        'revokedAmount', revoked_amount,
        'activeAmount', active_amount
      ) order by currency) from app_store_confirmed), '[]'::jsonb)
    ),
    'web', jsonb_build_object(
      'transactionCount', web_totals.transaction_count,
      'purchaserCount', web_totals.purchaser_count,
      'activeTransactionCount', web_totals.active_count,
      'refundedTransactionCount', web_totals.refunded_count,
      'purchaseAmountKrw', web_totals.purchase_krw,
      'refundedAmountKrw', web_totals.refunded_krw,
      'activeAmountKrw', web_totals.active_krw
    ),
    'products', coalesce((select jsonb_agg(jsonb_build_object(
      'productId', product_id,
      'productName', product_name,
      'kind', product_kind,
      'listPriceKrw', app_store_price_krw,
      'appStoreTransactionCount', app_store_transaction_count,
      'appStoreActiveTransactionCount', app_store_active_count,
      'appStoreRevokedTransactionCount', app_store_revoked_count,
      'appStoreEstimatedPurchaseKrw', app_store_purchase_krw,
      'appStoreEstimatedActiveKrw', app_store_active_krw,
      'appStoreMissingPriceTransactionCount', app_store_missing_price_count,
      'webTransactionCount', web_transaction_count,
      'webActiveTransactionCount', web_active_count,
      'webRefundedTransactionCount', web_refunded_count,
      'webPurchaseAmountKrw', web_purchase_krw,
      'webRefundedAmountKrw', web_refunded_krw,
      'webActiveAmountKrw', web_active_krw
    ) order by app_store_active_count + web_active_count desc, product_name, product_id)
    from product_rows), '[]'::jsonb)
  ) into result
  from app_store_totals
  cross join app_store_estimates
  cross join web_totals
  cross join catalog_metadata;

  return result;
end;
$$;

revoke all on function public.admin_payments_summary(timestamptz, timestamptz, text, text, text)
from public, anon, authenticated;
grant execute on function public.admin_payments_summary(timestamptz, timestamptz, text, text, text)
to service_role;

create or replace function public.admin_users(
  p_search text default '',
  p_kind text default 'all',
  p_profile text default 'all',
  p_sort text default 'created_at',
  p_direction text default 'desc',
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  perform private.require_admin_service_role();
  if p_kind not in ('all', 'anonymous', 'google', 'permanent')
     or p_profile not in ('all', 'complete', 'incomplete')
     or p_sort not in ('created_at', 'email', 'nickname', 'room_count', 'last_sign_in_at')
     or p_direction not in ('asc', 'desc')
     or p_page < 1 or p_page_size not between 1 and 100
     or char_length(p_search) > 100 then
    raise exception using errcode = '22023', message = 'invalid_admin_users_query';
  end if;

  with app_store_history as (
    select transactions.user_id,
           count(*)::integer as purchase_count,
           count(*) filter (where transactions.status = 'active')::integer as active_purchase_count,
           max(transactions.purchased_at) as last_purchased_at
    from private.app_store_transactions transactions
    where transactions.environment = 'Production'
      and transactions.user_id is not null
    group by transactions.user_id
  ), user_rows as (
    select users.id,
           users.email,
           users.created_at,
           users.last_sign_in_at,
           profiles.nickname,
           profiles.character_id,
           profiles.id is not null as profile_complete,
           coalesce(users.is_anonymous, false) as is_anonymous,
           exists (
             select 1 from auth.identities identities
             where identities.user_id = users.id and identities.provider = 'google'
           ) as has_google,
           count(distinct members.room_id)::integer as room_count,
           coalesce(app_store_history.purchase_count, 0) as app_store_purchase_count,
           coalesce(app_store_history.active_purchase_count, 0) as app_store_active_purchase_count,
           app_store_history.last_purchased_at as app_store_last_purchased_at
    from auth.users users
    left join public.profiles profiles on profiles.id = users.id
    left join public.room_members members on members.user_id = users.id
    left join app_store_history on app_store_history.user_id = users.id
    where (p_search = ''
       or users.id::text ilike '%' || p_search || '%'
       or coalesce(users.email, '') ilike '%' || p_search || '%'
       or coalesce(profiles.nickname, '') ilike '%' || p_search || '%')
      and (p_profile = 'all'
       or (p_profile = 'complete' and profiles.id is not null)
       or (p_profile = 'incomplete' and profiles.id is null))
      and (p_kind = 'all'
       or (p_kind = 'anonymous' and coalesce(users.is_anonymous, false))
       or (p_kind = 'google' and exists (
         select 1 from auth.identities identities
         where identities.user_id = users.id and identities.provider = 'google'
       ))
       or (p_kind = 'permanent' and not coalesce(users.is_anonymous, false)))
    group by users.id, profiles.id, app_store_history.user_id,
             app_store_history.purchase_count, app_store_history.active_purchase_count,
             app_store_history.last_purchased_at
  ), counted as (
    select user_rows.*, count(*) over()::integer as total_count
    from user_rows
  ), paged as (
    select * from counted
    order by
      case when p_sort = 'created_at' and p_direction = 'asc' then created_at end asc,
      case when p_sort = 'created_at' and p_direction = 'desc' then created_at end desc,
      case when p_sort = 'email' and p_direction = 'asc' then email end asc nulls last,
      case when p_sort = 'email' and p_direction = 'desc' then email end desc nulls last,
      case when p_sort = 'nickname' and p_direction = 'asc' then nickname end asc nulls last,
      case when p_sort = 'nickname' and p_direction = 'desc' then nickname end desc nulls last,
      case when p_sort = 'room_count' and p_direction = 'asc' then room_count end asc,
      case when p_sort = 'room_count' and p_direction = 'desc' then room_count end desc,
      case when p_sort = 'last_sign_in_at' and p_direction = 'asc' then last_sign_in_at end asc nulls last,
      case when p_sort = 'last_sign_in_at' and p_direction = 'desc' then last_sign_in_at end desc nulls last,
      id asc
    limit p_page_size offset ((p_page - 1) * p_page_size)
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'email', email,
      'createdAt', created_at,
      'lastSignInAt', last_sign_in_at,
      'nickname', nickname,
      'characterId', character_id,
      'profileComplete', profile_complete,
      'accountKind', case when has_google then 'google' when is_anonymous then 'anonymous' else 'permanent' end,
      'roomCount', room_count,
      'appStorePurchaseCount', app_store_purchase_count,
      'appStoreActivePurchaseCount', app_store_active_purchase_count,
      'appStoreLastPurchasedAt', app_store_last_purchased_at
    )), '[]'::jsonb),
    'page', p_page,
    'pageSize', p_page_size,
    'total', coalesce(max(total_count), 0)
  ) into result
  from paged;

  return result;
end;
$$;

revoke all on function public.admin_users(text, text, text, text, text, integer, integer)
from public, anon, authenticated;
grant execute on function public.admin_users(text, text, text, text, text, integer, integer)
to service_role;

create or replace function public.admin_downloads(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  kst_today date := timezone('Asia/Seoul', now())::date;
  kst_today_start timestamptz := (timezone('Asia/Seoul', now())::date::timestamp at time zone 'Asia/Seoul');
  result jsonb;
begin
  perform private.require_admin_service_role();
  if p_days not between 1 and 365 then
    raise exception using errcode = '22023', message = 'invalid_admin_download_days';
  end if;

  with counters as (
    select asset_id, asset_name, release_tag, version, channel, collected_at, download_count,
           lag(download_count) over (partition by asset_id order by collected_at) as previous_download_count
    from private.download_metric_snapshots
  ), deltas as (
    select asset_id, asset_name, release_tag, version,
           case when channel = 'windows_msi' then 'windows' else 'macos' end as platform,
           collected_at,
           download_count - coalesce(previous_download_count, 0) as total_delta,
           case when previous_download_count is null then 0
                else download_count - previous_download_count end as period_delta
    from counters
  ), platform_totals as (
    select platform,
           sum(total_delta)::bigint as total,
           coalesce(sum(period_delta) filter (where collected_at >= kst_today_start), 0)::bigint as today
    from deltas
    group by platform
  ), version_totals as (
    select asset_name, release_tag, version, platform,
           sum(total_delta)::bigint as total, max(collected_at) as collected_at
    from deltas
    group by asset_name, release_tag, version, platform
  ), dates as (
    select generate_series(kst_today - (p_days - 1), kst_today, interval '1 day')::date as day
  ), daily as (
    select dates.day, platforms.platform,
           coalesce(sum(deltas.period_delta) filter (
             where timezone('Asia/Seoul', deltas.collected_at)::date = dates.day
           ), 0)::bigint as count
    from dates
    cross join (values ('macos'::text), ('windows'::text)) platforms(platform)
    left join deltas on deltas.platform = platforms.platform
    group by dates.day, platforms.platform
  )
  select jsonb_build_object(
    'platforms', coalesce((select jsonb_agg(jsonb_build_object(
      'platform', platform, 'today', today, 'total', total
    ) order by platform) from platform_totals), '[]'::jsonb),
    'versions', coalesce((select jsonb_agg(jsonb_build_object(
      'assetName', asset_name, 'releaseTag', release_tag, 'version', version,
      'platform', platform, 'total', total
    ) order by collected_at desc, platform) from version_totals), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object(
      'date', day, 'platform', platform, 'count', count
    ) order by day, platform) from daily), '[]'::jsonb),
    'lastCollectedAt', (select max(collected_at) from deltas),
    'isStale', coalesce((select max(collected_at) < now() - interval '35 minutes' from deltas), true),
    'homebrewAnalytics', jsonb_build_object(
      'available', false,
      'counts', jsonb_build_object('days30', null, 'days90', null, 'days365', null),
      'reason', '현재 sidey-app/tap은 third-party tap이라 homebrew/homebrew-cask 공식 익명 통계에 포함되지 않습니다.'
    ),
    'boundaryNote', '오늘 수치는 Asia/Seoul 자정 직전·직후 스냅샷 차이이며 최대 약 15분의 경계 오차가 있습니다.',
    'historicalNote', '전용 Homebrew 자산 도입 전 DMG 다운로드도 macOS 합계에 보존됩니다.'
  ) into result;

  return result;
end;
$$;

revoke all on function public.admin_downloads(integer) from public, anon, authenticated;
grant execute on function public.admin_downloads(integer) to service_role;

commit;
