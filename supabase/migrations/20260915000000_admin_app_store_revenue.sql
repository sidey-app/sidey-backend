begin;

-- Apple JWS price is an integer in milliunits, not the direct-store KRW price.
-- Unknown historical prices remain null; zero is a verified free purchase.
alter table private.app_store_transactions
  add column price_milliunits bigint,
  add column currency text,
  add column price_signed_at timestamptz,
  add constraint app_store_transactions_money_pair check (
    (price_milliunits is null and currency is null)
    or (price_milliunits is not null and currency is not null
        and price_milliunits between 0 and 9007199254740991
        and currency ~ '^[A-Z]{3}$')
  );

create index app_store_transactions_environment_purchase_idx
on private.app_store_transactions (environment, purchased_at desc, transaction_id);

-- Keep the 11-argument entitlement RPC for older verifier deployments.
-- The extra two arguments deliberately have no defaults (unambiguous PostgREST).
create or replace function public.admin_apply_app_store_transaction(
  p_user_id uuid,
  p_transaction_id text,
  p_original_transaction_id text,
  p_product_id text,
  p_app_account_token uuid,
  p_environment text,
  p_status text,
  p_purchased_at timestamptz,
  p_revoked_at timestamptz,
  p_signed_at timestamptz,
  p_signed_data_sha256_hex text,
  p_price_milliunits bigint,
  p_currency text
)
returns table (entitlement_key text, entitlement_status text, binding_state text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin_service_role();
  if (p_price_milliunits is null) != (p_currency is null)
     or p_price_milliunits not between 0 and 9007199254740991
     or p_currency !~ '^[A-Z]{3}$' then
    raise exception using errcode = '22023', message = 'invalid_app_store_transaction_price';
  end if;

  -- Serialize first-time notifications as well as existing rows for this overload.
  perform pg_advisory_xact_lock(hashtextextended(p_transaction_id, 0));
  return query
  select * from public.admin_apply_app_store_transaction(
    p_user_id, p_transaction_id, p_original_transaction_id, p_product_id,
    p_app_account_token, p_environment, p_status, p_purchased_at, p_revoked_at,
    p_signed_at, p_signed_data_sha256_hex
  );

  -- The original RPC ignores stale signatures. Only enrich the exact signed
  -- state it accepted; a later payload without price must not erase known money.
  if p_price_milliunits is not null then
    update private.app_store_transactions tx
    set price_milliunits = p_price_milliunits, currency = p_currency, price_signed_at = p_signed_at
    where tx.transaction_id = p_transaction_id
      and tx.signed_at = p_signed_at
      and tx.environment = p_environment
      and tx.signed_data_sha256 = decode(p_signed_data_sha256_hex, 'hex');
  end if;
end;
$$;

revoke all on function public.admin_apply_app_store_transaction(
  uuid, text, text, text, uuid, text, text, timestamptz, timestamptz,
  timestamptz, text, bigint, text
) from public, anon, authenticated;
grant execute on function public.admin_apply_app_store_transaction(
  uuid, text, text, text, uuid, text, text, timestamptz, timestamptz,
  timestamptz, text, bigint, text
) to service_role;

-- Bounded service-only historical enrichment. These provider identifiers never
-- appear in reporting RPCs or the browser contract.
create or replace function public.admin_list_app_store_unpriced(
  p_environment text default 'Production', p_limit integer default 25,
  p_before_purchased_at timestamptz default null, p_before_key text default null
)
returns table(transaction_id text, product_id text, environment text, purchased_at timestamptz, cursor_key text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_admin_service_role();
  if p_environment is null or p_environment not in ('Production', 'Sandbox')
     or p_limit is null or p_limit not between 1 and 100
     or (p_before_purchased_at is null) <> (p_before_key is null)
     or (p_before_key is not null and p_before_key !~ '^[0-9a-f]{64}$') then
    raise exception using errcode = '22023', message = 'invalid_app_store_price_backfill_query';
  end if;
  return query select tx.transaction_id, tx.store_product_id, tx.environment, tx.purchased_at,
    encode(sha256(convert_to(tx.transaction_id, 'UTF8')), 'hex')
  from private.app_store_transactions tx
  where tx.environment = p_environment and tx.price_milliunits is null
    and (p_before_purchased_at is null or
      (tx.purchased_at, encode(sha256(convert_to(tx.transaction_id, 'UTF8')), 'hex')) <
      (p_before_purchased_at, p_before_key))
  order by tx.purchased_at desc, encode(sha256(convert_to(tx.transaction_id, 'UTF8')), 'hex') desc
  limit p_limit;
end;
$$;
revoke all on function public.admin_list_app_store_unpriced(text, integer, timestamptz, text) from public, anon, authenticated;
grant execute on function public.admin_list_app_store_unpriced(text, integer, timestamptz, text) to service_role;

create or replace function public.admin_record_app_store_price(
  p_transaction_id text, p_environment text, p_price_milliunits bigint,
  p_currency text, p_signed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_admin_service_role();
  if char_length(coalesce(p_transaction_id, '')) not between 1 and 128
     or p_environment is null or p_environment not in ('Production', 'Sandbox')
     or p_price_milliunits is null or p_price_milliunits not between 0 and 9007199254740991
     or p_currency is null or p_currency !~ '^[A-Z]{3}$'
     or p_signed_at is null then
    raise exception using errcode = '22023', message = 'invalid_app_store_transaction_price';
  end if;
  -- Price belongs to the immutable original purchase. An older, verified Apple
  -- payload can fill unknown money without rolling back newer refund state.
  update private.app_store_transactions tx
  set price_milliunits = p_price_milliunits, currency = p_currency, price_signed_at = p_signed_at
  where tx.transaction_id = p_transaction_id and tx.environment = p_environment
    and tx.price_milliunits is null;
  return found;
end;
$$;
revoke all on function public.admin_record_app_store_price(text, text, bigint, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.admin_record_app_store_price(text, text, bigint, text, timestamptz)
to service_role;

-- Aggregate currencies independently. Revoked amounts are original purchase
-- values, not Apple's actual refund/settlement proceeds or currency conversion.
create or replace function private.app_store_payment_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with grouped as (
    select currency,
           grouping(currency) as is_total,
           count(*) as transaction_count,
           count(*) filter (where price_milliunits is null) as unpriced_count,
           coalesce(sum(price_milliunits::numeric / 1000), 0) as purchase_amount,
           coalesce(sum(price_milliunits::numeric / 1000) filter (where status != 'active'), 0) as revoked_amount,
           coalesce(sum(price_milliunits::numeric / 1000) filter (where status = 'active'), 0) as active_amount
    from private.app_store_transactions
    where environment = 'Production'
    group by grouping sets ((currency), ())
  )
  select jsonb_build_object(
    'transactionCount', (select transaction_count from grouped where is_total = 1),
    'unpricedTransactionCount', (select unpriced_count from grouped where is_total = 1),
    'currencies', coalesce((select jsonb_agg(jsonb_build_object(
      'currency', currency, 'purchaseAmount', purchase_amount,
      'revokedAmount', revoked_amount, 'activeAmount', active_amount
    ) order by currency) from grouped where is_total = 0 and currency is not null), '[]'::jsonb)
  );
$$;
revoke all on function private.app_store_payment_summary() from public, anon, authenticated;

create or replace function public.admin_app_store_payments(
  p_search text default '',
  p_status text default 'all',
  p_environment text default 'Production',
  p_from timestamptz default null,
  p_to timestamptz default null,
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
  if p_search is null or char_length(p_search) > 100
     or p_status is null or p_status not in ('all', 'active', 'refunded', 'revoked')
     or p_environment is null or p_environment not in ('Production', 'Sandbox')
     or p_page is null or p_page < 1
     or p_page_size is null or p_page_size not between 1 and 100
     or (p_from is not null and p_to is not null and p_from > p_to) then
    raise exception using errcode = '22023', message = 'invalid_admin_app_store_payments_query';
  end if;

  with payment_rows as materialized (
    select md5(tx.transaction_id) as id,
           tx.user_id, users.email, profiles.nickname,
           products.display_name as product_name,
           tx.environment, tx.status,
           tx.price_milliunits::numeric / 1000 as amount,
           tx.currency, tx.purchased_at, tx.revoked_at, tx.updated_at as verified_at
    from private.app_store_transactions tx
    left join auth.users users on users.id = tx.user_id
    left join public.profiles profiles on profiles.id = tx.user_id
    join public.commerce_products products on products.id = tx.product_id
    where tx.environment = p_environment
      and (p_status = 'all' or tx.status = p_status)
      and (p_from is null or tx.purchased_at >= p_from)
      and (p_to is null or tx.purchased_at < p_to)
      and (p_search = ''
        or md5(tx.transaction_id) ilike '%' || p_search || '%'
        or coalesce(users.email, '') ilike '%' || p_search || '%'
        or coalesce(profiles.nickname, '') ilike '%' || p_search || '%'
        or products.display_name ilike '%' || p_search || '%')
  ), grouped as (
    select currency, grouping(currency) as is_total,
           count(*) as transaction_count,
           count(*) filter (where amount is null) as unpriced_count,
           coalesce(sum(amount), 0) as purchase_amount,
           coalesce(sum(amount) filter (where status != 'active'), 0) as revoked_amount,
           coalesce(sum(amount) filter (where status = 'active'), 0) as active_amount
    from payment_rows
    group by grouping sets ((currency), ())
  ), paged as (
    select * from payment_rows
    order by purchased_at desc, id asc
    limit p_page_size offset ((p_page::bigint - 1) * p_page_size)
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'userId', user_id, 'email', email, 'nickname', nickname,
      'productName', product_name, 'environment', environment, 'status', status,
      'amount', amount, 'currency', currency,
      'purchasedAt', purchased_at, 'revokedAt', revoked_at, 'verifiedAt', verified_at
    ) order by purchased_at desc, id asc) from paged), '[]'::jsonb),
    'page', p_page, 'pageSize', p_page_size,
    'total', (select transaction_count from grouped where is_total = 1),
    'summary', jsonb_build_object(
      'transactionCount', (select transaction_count from grouped where is_total = 1),
      'unpricedTransactionCount', (select unpriced_count from grouped where is_total = 1),
      'currencies', coalesce((select jsonb_agg(jsonb_build_object(
        'currency', currency, 'purchaseAmount', purchase_amount,
        'revokedAmount', revoked_amount, 'activeAmount', active_amount
      ) order by currency) from grouped where is_total = 0 and currency is not null), '[]'::jsonb)
    )
  ) into result;
  return result;
end;
$$;
revoke all on function public.admin_app_store_payments(text, text, text, timestamptz, timestamptz, integer, integer)
from public, anon, authenticated;
grant execute on function public.admin_app_store_payments(text, text, text, timestamptz, timestamptz, integer, integer)
to service_role;

create or replace function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  kst_today_start timestamptz := (timezone('Asia/Seoul', now())::date::timestamp at time zone 'Asia/Seoul');
  result jsonb;
begin
  perform private.require_admin_service_role();

  with download_counters as (
    select channel,
           collected_at,
           download_count,
           lag(download_count) over (
             partition by asset_id order by collected_at
           ) as previous_download_count
    from private.download_metric_snapshots
  ), download_deltas as (
    select channel,
           collected_at,
           download_count - coalesce(previous_download_count, 0) as total_delta,
           case
             when previous_download_count is null then 0
             else download_count - previous_download_count
           end as period_delta
    from download_counters
  ), download_totals as (
    select coalesce(sum(total_delta), 0)::bigint as total,
           coalesce(sum(period_delta) filter (where collected_at >= kst_today_start), 0)::bigint as today
    from download_deltas
  ), payment_totals as (
    select coalesce(sum(amount_krw) filter (where approved_at is not null), 0)::bigint as approved,
           coalesce(sum(amount_krw) filter (where refunded_at is not null), 0)::bigint as refunded
    from public.commerce_orders
  )
  select jsonb_build_object(
    'authUsers', (select count(*) from auth.users),
    'profileUsers', (select count(*) from public.profiles),
    'anonymousUsers', (select count(*) from auth.users where coalesce(is_anonymous, false)),
    'permanentUsers', (select count(*) from auth.users where not coalesce(is_anonymous, false)),
    'rooms', (select count(*) from public.rooms),
    'memberships', (select count(*) from public.room_members),
    'joinedToday', (select count(*) from auth.users where created_at >= kst_today_start),
    'approvedRevenueKrw', payment_totals.approved,
    'refundedRevenueKrw', payment_totals.refunded,
    'netRevenueKrw', payment_totals.approved - payment_totals.refunded,
    'downloadsToday', download_totals.today,
    'downloadsTotal', download_totals.total,
    'appStore', private.app_store_payment_summary(),
    'generatedAt', now()
  ) into result
  from download_totals cross join payment_totals;

  return result;
end;
$$;

revoke all on function public.admin_overview() from public, anon, authenticated;
grant execute on function public.admin_overview() to service_role;

commit;
