begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select no_plan();

select has_table('private', 'admin_payment_catalog_snapshot', 'reporting catalog snapshot stays private');
select is(
  (select count(*)::integer from private.admin_payment_catalog_snapshot),
  33,
  'all reviewed catalog products are pinned'
);
select is(
  (select min(source_commit) from private.admin_payment_catalog_snapshot),
  '96f62abc0b350791de8e0d7c3b3af33f4e73dae6',
  'catalog provenance pins the reviewed public commit'
);
select ok(
  not has_table_privilege('anon', 'private.admin_payment_catalog_snapshot', 'select'),
  'anon cannot read the private catalog snapshot'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.admin_payments_summary(timestamptz,timestamptz,text,text,text)',
    'execute'
  ),
  'anon cannot execute payment summary'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.admin_payments_summary(timestamptz,timestamptz,text,text,text)',
    'execute'
  ),
  'authenticated cannot execute payment summary'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.admin_payments_summary(timestamptz,timestamptz,text,text,text)',
    'execute'
  ),
  'service role can execute payment summary'
);

insert into auth.users (
  id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
) values
  ('ae000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'buyer-one@sidey.app',
   '{"provider":"email","providers":["email"]}', '{}', false, now(), now()),
  ('ae000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'buyer-two@sidey.app',
   '{"provider":"email","providers":["email"]}', '{}', false, now(), now());

insert into private.app_store_transactions (
  transaction_id, original_transaction_id, product_id, store_product_id,
  user_id, app_account_token, environment, status, binding_state,
  purchased_at, revoked_at, signed_at, signed_data_sha256,
  price_milliunits, currency
) values
  ('summary-prod-active', 'summary-prod-active', 'character_guinea_pig', 'character_guinea_pig_solo',
   'ae000000-0000-0000-0000-000000000001', 'be000000-0000-0000-0000-000000000001',
   'Production', 'active', 'bound', '2026-09-15T15:00:00Z', null,
   '2026-09-15T15:01:00Z', decode(repeat('01', 32), 'hex'), 1100000, 'KRW'),
  ('summary-prod-refunded', 'summary-prod-refunded', 'character_guinea_pig', 'character_guinea_pig_solo',
   null, 'be000000-0000-0000-0000-000000000002',
   'Production', 'refunded', 'unbound', '2026-09-15T16:00:00Z', '2026-09-15T17:00:00Z',
   '2026-09-15T17:00:00Z', decode(repeat('02', 32), 'hex'), null, null),
  ('summary-prod-revoked', 'summary-prod-revoked', 'bubble_bunny_pink', 'bubble_bunny_pink',
   null, 'be000000-0000-0000-0000-000000000003',
   'Production', 'revoked', 'unbound', '2026-09-15T17:00:00Z', '2026-09-15T18:00:00Z',
   '2026-09-15T18:00:00Z', decode(repeat('03', 32), 'hex'), 2200000, 'KRW'),
  ('summary-prod-missing-price', 'summary-prod-missing-price', 'bubble_starry_cat', 'bubble_starry_cat',
   'ae000000-0000-0000-0000-000000000002', 'be000000-0000-0000-0000-000000000004',
   'Production', 'active', 'bound', '2026-09-15T18:00:00Z', null,
   '2026-09-15T18:01:00Z', decode(repeat('04', 32), 'hex'), 2200000, 'KRW'),
  ('summary-sandbox', 'summary-sandbox', 'character_guinea_pig', 'character_guinea_pig_solo',
   'ae000000-0000-0000-0000-000000000001', 'be000000-0000-0000-0000-000000000001',
   'Sandbox', 'active', 'bound', '2026-09-15T19:00:00Z', null,
   '2026-09-15T19:01:00Z', decode(repeat('05', 32), 'hex'), 1100000, 'KRW'),
  ('summary-at-exclusive-to', 'summary-at-exclusive-to', 'character_guinea_pig', 'character_guinea_pig_solo',
   'ae000000-0000-0000-0000-000000000001', 'be000000-0000-0000-0000-000000000001',
   'Production', 'active', 'bound', '2026-09-16T15:00:00Z', null,
   '2026-09-16T15:01:00Z', decode(repeat('06', 32), 'hex'), 1100000, 'KRW');

-- A later restore of the same Apple transaction updates one ledger row.
insert into private.app_store_transactions (
  transaction_id, original_transaction_id, product_id, store_product_id,
  user_id, app_account_token, environment, status, binding_state,
  purchased_at, revoked_at, signed_at, signed_data_sha256,
  price_milliunits, currency
) values (
  'summary-prod-active', 'summary-prod-active', 'character_guinea_pig', 'character_guinea_pig_solo',
  'ae000000-0000-0000-0000-000000000001', 'be000000-0000-0000-0000-000000000001',
  'Production', 'active', 'bound', '2026-09-15T15:00:00Z', null,
  '2026-09-15T20:00:00Z', decode(repeat('07', 32), 'hex'), 1100000, 'KRW'
)
on conflict (transaction_id) do update
set signed_at = excluded.signed_at,
    signed_data_sha256 = excluded.signed_data_sha256;

update private.admin_payment_catalog_snapshot
set app_store_price_krw = null
where product_id = 'bubble_starry_cat';

select is(
  (select count(*)::integer
   from private.app_store_transactions
   where transaction_id = 'summary-prod-active'),
  1,
  'restoring one transaction id does not create a duplicate purchase'
);

update private.commerce_runtime_settings
set sales_enabled = true
where singleton is true;

insert into public.commerce_orders (
  id, provider_order_id, user_id, product_id, price_id, amount_krw, currency,
  status, checkout_token_hash, checkout_token_expires_at,
  created_at, approved_at, refunded_at,
  policy_version, policy_notice, policy_consented_at
) values
  ('ce000000-0000-0000-0000-000000000001', 'summary-live-approved',
   'ae000000-0000-0000-0000-000000000001', 'character_guinea_pig',
   (select id from public.commerce_prices where product_id = 'character_guinea_pig' and active),
   2200, 'KRW', 'approved', decode(repeat('11', 32), 'hex'), '2026-09-16T01:00:00Z',
   '2026-09-15T15:30:00Z', '2026-09-15T15:31:00Z', null,
   (select policy_version from private.commerce_runtime_settings),
   (select policy_notice from private.commerce_runtime_settings), '2026-09-15T15:30:00Z'),
  ('ce000000-0000-0000-0000-000000000002', 'summary-live-refunded',
   null, 'throwable_toy_cannon',
   (select id from public.commerce_prices where product_id = 'throwable_toy_cannon' and active),
   3300, 'KRW', 'refunded', decode(repeat('12', 32), 'hex'), '2026-09-16T01:00:00Z',
   '2026-09-15T16:30:00Z', '2026-09-15T16:31:00Z', '2026-09-15T20:00:00Z',
   (select policy_version from private.commerce_runtime_settings),
   (select policy_notice from private.commerce_runtime_settings), '2026-09-15T16:30:00Z'),
  ('ce000000-0000-0000-0000-000000000003', 'summary-live-partial',
   'ae000000-0000-0000-0000-000000000002', 'bubble_bunny_pink',
   (select id from public.commerce_prices where product_id = 'bubble_bunny_pink' and active),
   2200, 'KRW', 'approved', decode(repeat('13', 32), 'hex'), '2026-09-16T01:00:00Z',
   '2026-09-15T17:30:00Z', '2026-09-15T17:31:00Z', null,
   (select policy_version from private.commerce_runtime_settings),
   (select policy_notice from private.commerce_runtime_settings), '2026-09-15T17:30:00Z'),
  ('ce000000-0000-0000-0000-000000000004', 'summary-test-approved',
   'ae000000-0000-0000-0000-000000000001', 'character_guinea_pig',
   (select id from public.commerce_prices where product_id = 'character_guinea_pig' and active),
   2200, 'KRW', 'approved', decode(repeat('14', 32), 'hex'), '2026-09-16T01:00:00Z',
   '2026-09-15T18:30:00Z', '2026-09-15T18:31:00Z', null,
   (select policy_version from private.commerce_runtime_settings),
   (select policy_notice from private.commerce_runtime_settings), '2026-09-15T18:30:00Z'),
  ('ce000000-0000-0000-0000-000000000005', 'summary-live-at-to',
   'ae000000-0000-0000-0000-000000000001', 'character_guinea_pig',
   (select id from public.commerce_prices where product_id = 'character_guinea_pig' and active),
   2200, 'KRW', 'approved', decode(repeat('15', 32), 'hex'), '2026-09-17T01:00:00Z',
   '2026-09-16T14:59:00Z', '2026-09-16T15:00:00Z', null,
   (select policy_version from private.commerce_runtime_settings),
   (select policy_notice from private.commerce_runtime_settings), '2026-09-16T14:59:00Z');

insert into private.commerce_payments (
  order_id, payment_key, provider, provider_status, provider_transaction_key,
  amount_krw, balance_amount_krw, currency, last_verified_at,
  portone_payment_id, portone_store_id, portone_channel_key,
  portone_version, portone_channel_type, payment_method_type
) values
  ('ce000000-0000-0000-0000-000000000001', null, 'portone', 'PAID', 'summary-transaction-1',
   2200, 2200, 'KRW', '2026-09-15T15:31:00Z', 'summary-live-approved', 'summary-store', 'summary-channel', 'V2', 'LIVE', 'CARD'),
  ('ce000000-0000-0000-0000-000000000002', null, 'portone', 'CANCELLED', 'summary-transaction-2',
   3300, 0, 'KRW', '2026-09-15T20:00:00Z', 'summary-live-refunded', 'summary-store', 'summary-channel', 'V2', 'LIVE', 'CARD'),
  ('ce000000-0000-0000-0000-000000000003', null, 'portone', 'PARTIAL_CANCELLED', 'summary-transaction-3',
   2200, 1100, 'KRW', '2026-09-15T20:00:00Z', 'summary-live-partial', 'summary-store', 'summary-channel', 'V2', 'LIVE', 'CARD'),
  ('ce000000-0000-0000-0000-000000000004', null, 'portone', 'PAID', 'summary-transaction-4',
   2200, 2200, 'KRW', '2026-09-15T18:31:00Z', 'summary-test-approved', 'summary-store', 'summary-channel', 'V2', 'TEST', 'CARD'),
  ('ce000000-0000-0000-0000-000000000005', null, 'portone', 'PAID', 'summary-transaction-5',
   2200, 2200, 'KRW', '2026-09-16T15:00:00Z', 'summary-live-at-to', 'summary-store', 'summary-channel', 'V2', 'LIVE', 'CARD');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_like(
  $$select public.admin_payments_summary(null, null, 'all', '', 'all')$$,
  '%permission denied%',
  'authenticated requests are denied'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select throws_ok(
  $$select public.admin_payments_summary(null, null, 'invalid', '', 'all')$$,
  '22023',
  'invalid_admin_payments_summary_query',
  'invalid source is rejected'
);
select throws_ok(
  $$select public.admin_payments_summary(null, null, 'all', repeat('x', 101), 'all')$$,
  '22023',
  'invalid_admin_payments_summary_query',
  'search is bounded to 100 characters'
);

select ok(
  public.admin_payments_summary(
    '2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all'
  ) ?& array['generatedAt', 'catalog', 'appStore', 'web', 'products'],
  'summary exposes the complete top-level camelCase contract'
);
select ok(
  (public.admin_payments_summary(
    '2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all'
  ) -> 'appStore') ?& array[
    'transactionCount', 'purchaserCount', 'unboundTransactionCount',
    'activeTransactionCount', 'refundedTransactionCount', 'revokedTransactionCount',
    'estimatedPurchaseKrw', 'estimatedActiveKrw', 'estimatedRevokedKrw',
    'missingPriceTransactionCount', 'confirmedAmounts'
  ],
  'App Store summary exposes every contracted field'
);
select ok(
  (public.admin_payments_summary(
    '2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all'
  ) -> 'web') ?& array[
    'transactionCount', 'purchaserCount', 'approvedTransactionCount',
    'refundedTransactionCount', 'purchaseAmountKrw', 'refundedAmountKrw',
    'activeAmountKrw'
  ],
  'web summary exposes every contracted field'
);
select ok(
  (public.admin_payments_summary(
    '2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all'
  ) -> 'products' -> 0) ?& array[
    'productId', 'productName', 'kind', 'listPriceKrw',
    'appStoreTransactionCount', 'appStoreActiveTransactionCount',
    'appStoreRevokedTransactionCount', 'appStoreEstimatedPurchaseKrw',
    'appStoreEstimatedActiveKrw', 'appStoreMissingPriceTransactionCount',
    'webTransactionCount', 'webRefundedTransactionCount', 'webPurchaseAmountKrw',
    'webRefundedAmountKrw', 'webActiveAmountKrw'
  ],
  'product rows expose every contracted field'
);

select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all')
    -> 'appStore' ->> 'transactionCount')::integer,
  4,
  'Production App Store rows are counted once and p_to is exclusive'
);
select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all')
    -> 'appStore' ->> 'purchaserCount')::integer,
  4,
  'bound, unbound, and deleted-account tokens all contribute distinct purchasers'
);
select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all')
    -> 'appStore' ->> 'activeTransactionCount')::integer,
  2,
  'active App Store purchases are separated'
);
select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all')
    -> 'appStore' ->> 'refundedTransactionCount')::integer,
  1,
  'App Store refunds are separated'
);
select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all')
    -> 'appStore' ->> 'revokedTransactionCount')::integer,
  1,
  'App Store revocations are separated'
);
select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all')
    -> 'appStore' ->> 'estimatedPurchaseKrw')::bigint,
  4400::bigint,
  'catalog estimates exclude missing prices'
);
select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all')
    -> 'appStore' ->> 'estimatedActiveKrw')::bigint,
  1100::bigint,
  'active estimate excludes missing-price transactions'
);
select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all')
    -> 'appStore' ->> 'missingPriceTransactionCount')::integer,
  1,
  'missing catalog prices remain visible'
);
select is(
  (select (amount ->> 'purchaseAmount')::numeric
   from jsonb_array_elements(public.admin_payments_summary(
     '2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all'
   ) -> 'appStore' -> 'confirmedAmounts') amount
   where amount ->> 'currency' = 'KRW'),
  5500::numeric,
  'confirmed Apple amounts are reported independently of estimates'
);

select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all')
    -> 'web' ->> 'transactionCount')::integer,
  3,
  'only verified PortOne LIVE purchases in the half-open period are counted'
);
select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all')
    -> 'web' ->> 'approvedTransactionCount')::integer,
  2,
  'web approved count includes transactions with a remaining active balance'
);
select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all')
    -> 'web' ->> 'refundedTransactionCount')::integer,
  2,
  'web refunded count includes full and partial refunds'
);
select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all')
    -> 'web' ->> 'refundedAmountKrw')::bigint,
  4400::bigint,
  'web refund amount includes full and partial refunds from amount minus balance'
);
select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '', 'all')
    -> 'web' ->> 'activeAmountKrw')::bigint,
  3300::bigint,
  'web active amount is the verified PortOne balance'
);
select is(
  (public.admin_payments_summary('2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'app_store', '', 'all')
    -> 'web' ->> 'transactionCount')::integer,
  0,
  'source filter excludes the unselected ledger'
);
select is(
  jsonb_array_length(public.admin_payments_summary(
    '2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '기니', 'character'
  ) -> 'products'),
  1,
  'kind and search filter only matching product rows'
);
select is(
  (public.admin_payments_summary(
    '2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '기니', 'character'
  ) -> 'appStore' ->> 'transactionCount')::integer,
  2,
  'App Store card totals follow the product search and kind filters'
);
select is(
  (public.admin_payments_summary(
    '2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'all', '기니', 'character'
  ) -> 'web' ->> 'transactionCount')::integer,
  1,
  'web card totals follow the product search and kind filters'
);
select is(
  (select (product ->> 'webRefundedTransactionCount')::integer
   from jsonb_array_elements(public.admin_payments_summary(
     '2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'web', '핑크 토끼', 'bubble'
   ) -> 'products') product),
  1,
  'product refund count includes a partial PortOne refund'
);

select is(
  (public.admin_payments_summary(
    '2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'app_store', '', 'all'
  ) -> 'appStore' ->> 'transactionCount')::integer,
  (public.admin_app_store_payments(
    '', 'all', 'Production', '2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 1, 25
  ) ->> 'total')::integer,
  'new summary count matches the existing App Store query on one DB snapshot'
);

set local role postgres;
select is(
  (public.admin_payments_summary(
    '2026-09-15T15:00:00Z', '2026-09-16T15:00:00Z', 'app_store', '', 'all'
  ) -> 'appStore' ->> 'estimatedPurchaseKrw')::bigint,
  (select coalesce(sum(product_counts.transaction_count * catalog.app_store_price_krw), 0)::bigint
   from (
     select transactions.product_id, count(*)::bigint as transaction_count
     from private.app_store_transactions transactions
     where transactions.environment = 'Production'
       and transactions.purchased_at >= '2026-09-15T15:00:00Z'
       and transactions.purchased_at < '2026-09-16T15:00:00Z'
     group by transactions.product_id
   ) product_counts
   left join private.admin_payment_catalog_snapshot catalog
     on catalog.product_id = product_counts.product_id),
  'new estimate matches a direct calculation from the same pinned snapshot'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  ((public.admin_users('buyer-one@sidey.app', 'all', 'all', 'created_at', 'desc', 1, 25)
    -> 'items' -> 0 ->> 'appStorePurchaseCount')::integer),
  2,
  'user listing includes Production App Store purchase history only'
);
select is(
  ((public.admin_users('buyer-one@sidey.app', 'all', 'all', 'created_at', 'desc', 1, 25)
    -> 'items' -> 0 ->> 'appStoreActivePurchaseCount')::integer),
  2,
  'user listing includes active App Store purchase history'
);
select is(
  (public.admin_users('buyer-one@sidey.app', 'all', 'all', 'created_at', 'desc', 1, 25)
    -> 'items' -> 0 ->> 'appStoreLastPurchasedAt'),
  '2026-09-16T15:00:00+00:00',
  'user listing reports the last Production purchase timestamp'
);

set local role postgres;
insert into private.download_metric_snapshots (
  asset_id, asset_name, release_tag, version, channel, download_count, collected_at
) values
  (910001, 'SIDEY-direct.dmg', 'v-summary', 'summary', 'direct_dmg', 10, now() - interval '4 minutes'),
  (910002, 'SIDEY-homebrew.dmg', 'v-summary', 'summary', 'homebrew_dmg', 20, now() - interval '3 minutes'),
  (910003, 'SIDEY-legacy.dmg', 'v-summary', 'summary', 'legacy_unclassified', 30, now() - interval '2 minutes'),
  (910004, 'SIDEY-windows.msi', 'v-summary', 'summary', 'windows_msi', 40, now() - interval '1 minute');

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(
  (select (platform ->> 'total')::bigint
   from jsonb_array_elements(public.admin_downloads(7) -> 'platforms') platform
   where platform ->> 'platform' = 'macos'),
  60::bigint,
  'legacy and current DMG counters are preserved in the macOS total'
);
select is(
  (select sum((platform ->> 'total')::bigint)
   from jsonb_array_elements(public.admin_downloads(7) -> 'platforms') platform),
  100::numeric,
  'platform aggregation preserves the complete download ledger total'
);
select ok(
  public.admin_downloads(7)::text not like '%legacy_unclassified%',
  'download response no longer exposes the legacy classification label'
);
select ok(
  not exists (
    select 1 from jsonb_array_elements(public.admin_downloads(7) -> 'versions') item
    where not item ? 'platform' or item ? 'channel'
  ),
  'version rows use platform instead of channel'
);
select ok(
  not exists (
    select 1 from jsonb_array_elements(public.admin_downloads(7) -> 'daily') item
    where not item ? 'platform' or item ? 'channel'
  ),
  'daily rows use platform instead of channel'
);

select * from finish();
rollback;
