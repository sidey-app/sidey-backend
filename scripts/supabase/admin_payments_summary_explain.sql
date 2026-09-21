\set ON_ERROR_STOP on
\timing on

begin;
set local role postgres;

-- 50,000 Production App Store purchases.
insert into private.app_store_transactions (
  transaction_id, original_transaction_id, product_id, store_product_id,
  user_id, app_account_token, environment, status, binding_state,
  purchased_at, revoked_at, signed_at, signed_data_sha256,
  price_milliunits, currency
)
select 'perf-app-' || value,
       'perf-app-' || value,
       'character_guinea_pig',
       'character_guinea_pig_solo',
       null,
       md5('perf-app-account-' || value)::uuid,
       'Production',
       case when value % 10 = 0 then 'refunded' else 'active' end,
       'unbound',
       '2026-01-01T00:00:00Z'::timestamptz + value * interval '1 second',
       case when value % 10 = 0
            then '2026-01-02T00:00:00Z'::timestamptz + value * interval '1 second'
            else null end,
       '2026-01-02T00:00:00Z'::timestamptz + value * interval '1 second',
       decode(md5('perf-app-signature-' || value) || md5('perf-app-signature-2-' || value), 'hex'),
       1100000,
       'KRW'
from generate_series(1, 50000) value;

-- 50,000 verified PortOne LIVE purchases.
update private.commerce_runtime_settings
set sales_enabled = true
where singleton is true;

insert into public.commerce_orders (
  id, provider_order_id, user_id, product_id, price_id, amount_krw, currency,
  status, checkout_token_hash, checkout_token_expires_at,
  created_at, approved_at, refunded_at,
  policy_version, policy_notice, policy_consented_at
)
select md5('perf-web-order-' || value)::uuid,
       'perf-web-' || value,
       null,
       'character_guinea_pig',
       (select id from public.commerce_prices where product_id = 'character_guinea_pig' and active),
       1100,
       'KRW',
       case when value % 10 = 0 then 'refunded' else 'approved' end,
       decode(md5('perf-web-token-' || value) || md5('perf-web-token-2-' || value), 'hex'),
       '2027-01-01T00:00:00Z',
       '2026-01-01T00:00:00Z'::timestamptz + value * interval '1 second',
       '2026-01-01T00:00:00Z'::timestamptz + value * interval '1 second',
       case when value % 10 = 0
            then '2026-01-02T00:00:00Z'::timestamptz + value * interval '1 second'
            else null end,
       (select policy_version from private.commerce_runtime_settings),
       (select policy_notice from private.commerce_runtime_settings),
       '2026-01-01T00:00:00Z'::timestamptz + value * interval '1 second'
from generate_series(1, 50000) value;

insert into private.commerce_payments (
  order_id, payment_key, provider, provider_status, provider_transaction_key,
  amount_krw, balance_amount_krw, currency, last_verified_at,
  portone_payment_id, portone_store_id, portone_channel_key,
  portone_version, portone_channel_type, payment_method_type
)
select md5('perf-web-order-' || value)::uuid,
       null,
       'portone',
       case when value % 10 = 0 then 'CANCELLED' else 'PAID' end,
       'perf-web-transaction-' || value,
       1100,
       case when value % 10 = 0 then 0 else 1100 end,
       'KRW',
       '2026-01-02T00:00:00Z'::timestamptz + value * interval '1 second',
       'perf-web-payment-' || value,
       'perf-store',
       'perf-live-channel',
       'V2',
       'LIVE',
       'CARD'
from generate_series(1, 50000) value;

analyze private.app_store_transactions;
analyze public.commerce_orders;
analyze private.commerce_payments;

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

\echo 'all sources (100,000 transactions)'
explain (analyze, buffers, settings, summary, timing off)
select public.admin_payments_summary(
  '2026-01-01T00:00:00Z',
  '2026-02-01T00:00:00Z',
  'all',
  '',
  'all'
);

\echo 'App Store only (50,000 transactions)'
explain (analyze, buffers, settings, summary, timing off)
select public.admin_payments_summary(
  '2026-01-01T00:00:00Z',
  '2026-02-01T00:00:00Z',
  'app_store',
  '',
  'all'
);

\echo 'web only (50,000 transactions)'
explain (analyze, buffers, settings, summary, timing off)
select public.admin_payments_summary(
  '2026-01-01T00:00:00Z',
  '2026-02-01T00:00:00Z',
  'web',
  '',
  'all'
);

rollback;
