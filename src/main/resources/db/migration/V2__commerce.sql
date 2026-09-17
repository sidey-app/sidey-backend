-- Independent domain schema. Ownership provenance lives in commerce_grants;
-- commerce_entitlements is a transactionally maintained effective projection.
create table commerce_products (
    id text primary key check (id ~ '^[a-z0-9_]{1,80}$'),
    display_name text not null,
    product_description text not null,
    product_kind text not null check (product_kind in ('character','bubble','throwable')),
    catalog_item_id text not null check (catalog_item_id ~ '^(pixel|bubble|throwable)_[a-z0-9_]{1,60}$'),
    character_id text,
    entitlement_key text not null unique check (entitlement_key ~ '^(character:pixel|bubble:bubble|throwable:throwable)_[a-z0-9_]{1,60}$'),
    sort_order integer not null check (sort_order >= 0),
    active boolean not null default true,
    related_character_product_id text references commerce_products(id) on delete restrict,
    render_asset_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (product_kind,catalog_item_id),
    check ((product_kind='character' and character_id is not null and character_id=catalog_item_id)
        or (product_kind<>'character' and character_id is null))
);
create table commerce_prices (
    id uuid primary key default gen_random_uuid(),
    product_id text not null references commerce_products(id) on delete restrict,
    amount_krw integer not null check (amount_krw > 0),
    currency text not null default 'KRW' check (currency='KRW'),
    tax_inclusive boolean not null default true,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    retired_at timestamptz,
    check (not active or retired_at is null)
);
create unique index commerce_prices_one_active on commerce_prices(product_id) where active;
create table commerce_orders (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references users(id) on delete set null,
    product_id text not null references commerce_products(id) on delete restrict,
    price_id uuid not null references commerce_prices(id) on delete restrict,
    provider_order_id text not null unique,
    amount_krw integer not null check (amount_krw > 0),
    currency text not null check (currency='KRW'),
    payment_environment text not null check (payment_environment in ('test','live')),
    status text not null default 'pending' check (status in ('pending','approved','failed','canceled','refunded')),
    checkout_token_hash bytea not null unique check (octet_length(checkout_token_hash)=32),
    checkout_token_expires_at timestamptz not null,
    policy_version text check (policy_version is null or char_length(policy_version) between 1 and 80),
    policy_notice text check (policy_notice is null or char_length(policy_notice) between 80 and 4000),
    policy_consented_at timestamptz,
    created_at timestamptz not null default now(),
    approved_at timestamptz,
    refunded_at timestamptz,
    updated_at timestamptz not null default now(),
    check ((policy_version is null and policy_notice is null and policy_consented_at is null)
        or (policy_version is not null and policy_notice is not null and policy_consented_at is not null)),
    check (status <> 'approved' or policy_consented_at is not null)
);
create index commerce_orders_user_created on commerce_orders(user_id,created_at desc);
create table commerce_payments (
    order_id uuid primary key references commerce_orders(id) on delete restrict,
    provider text not null check (provider in ('portone','toss')),
    provider_payment_id text not null check (char_length(provider_payment_id) between 1 and 200),
    provider_transaction_id text,
    provider_status text not null,
    store_id text,
    channel_key text,
    provider_version text,
    channel_type text,
    payment_method_type text,
    amount_krw integer not null check (amount_krw > 0),
    balance_amount_krw integer not null check (balance_amount_krw between 0 and amount_krw),
    currency text not null check (currency='KRW'),
    last_verified_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(provider,provider_payment_id),
    check (provider<>'portone' or (store_id is not null and channel_key is not null
        and provider_version is not null and channel_type is not null and payment_method_type is not null
        and char_length(store_id) between 6 and 200 and char_length(channel_key) between 6 and 200
        and provider_version='V2' and channel_type in ('TEST','LIVE') and payment_method_type='EASY_PAY'))
);
create table commerce_webhook_events (
    provider text not null,
    event_id text not null check (char_length(event_id) between 1 and 200),
    event_type text not null,
    payload_sha256 bytea not null check (octet_length(payload_sha256)=32),
    order_id uuid references commerce_orders(id) on delete restrict,
    processing_status text not null check (processing_status in ('processing','processed','ignored')),
    received_at timestamptz not null default now(),
    processed_at timestamptz,
    primary key(provider,event_id)
);
create table commerce_grants (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references users(id) on delete set null,
    entitlement_key text not null references commerce_products(entitlement_key) on delete restrict,
    source_kind text not null check (source_kind in ('portone','app_store','complimentary','toss')),
    source_reference text not null check (char_length(source_reference) between 1 and 240),
    status text not null check (status in ('active','refunded','revoked')),
    granted_at timestamptz not null default now(),
    revoked_at timestamptz,
    parent_grant_id uuid references commerce_grants(id) on delete cascade,
    included_entitlement_key text references commerce_products(entitlement_key) on delete restrict,
    updated_at timestamptz not null default now(),
    unique(source_kind,source_reference),
    check (status<>'active' or user_id is not null),
    check ((status='active' and revoked_at is null) or (status<>'active' and revoked_at is not null)),
    check (parent_grant_id is null or (source_kind='complimentary' and included_entitlement_key is null))
);
create index commerce_grants_user_entitlement on commerce_grants(user_id,entitlement_key,status);
create unique index commerce_grants_one_included on commerce_grants(parent_grant_id) where parent_grant_id is not null;
create table commerce_entitlements (
    user_id uuid not null references users(id) on delete cascade,
    entitlement_key text not null references commerce_products(entitlement_key) on delete restrict,
    status text not null check (status in ('active','refunded','revoked')),
    granted_at timestamptz not null,
    revoked_at timestamptz,
    updated_at timestamptz not null default now(),
    primary key(user_id,entitlement_key),
    check ((status='active' and revoked_at is null) or (status<>'active' and revoked_at is not null))
);
create table app_store_product_offers (
    store_product_id text primary key,
    product_id text not null references commerce_products(id) on delete restrict,
    current_offer boolean not null,
    includes_related_throwable boolean not null default false,
    unique(store_product_id,product_id)
);
create unique index app_store_one_current_offer on app_store_product_offers(product_id) where current_offer;
create table app_store_transactions (
    environment text not null check (environment in ('Sandbox','Production')),
    transaction_id text not null check (char_length(transaction_id) between 1 and 128),
    original_transaction_id text not null check (char_length(original_transaction_id) between 1 and 128),
    product_id text not null references commerce_products(id) on delete restrict,
    store_product_id text not null,
    user_id uuid references users(id) on delete set null,
    app_account_token uuid,
    status text not null check (status in ('active','refunded','revoked')),
    binding_state text not null check (binding_state in ('bound','unbound')),
    purchased_at timestamptz not null,
    revoked_at timestamptz,
    signed_at timestamptz not null,
    signed_data_sha256 bytea not null check (octet_length(signed_data_sha256)=32),
    price_milliunits bigint,
    currency text,
    price_signed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key(environment,transaction_id),
    foreign key(store_product_id,product_id) references app_store_product_offers(store_product_id,product_id) on delete restrict,
    check ((binding_state='bound' and user_id is not null) or (binding_state='unbound' and user_id is null)),
    check ((status='active' and revoked_at is null) or (status<>'active' and revoked_at is not null)),
    check ((price_milliunits is null and currency is null)
        or (price_milliunits is not null and currency is not null
            and price_milliunits between 0 and 9007199254740991 and currency ~ '^[A-Z]{3}$'))
);
create index app_store_original_transaction on app_store_transactions(environment,original_transaction_id);
create index app_store_purchase on app_store_transactions(environment,purchased_at desc,transaction_id);
create table app_store_notification_events (
    notification_uuid uuid primary key,
    environment text not null check (environment in ('Sandbox','Production')),
    notification_type text not null check (char_length(notification_type) between 1 and 100),
    transaction_id text,
    signed_at timestamptz not null,
    payload_sha256 bytea not null check (octet_length(payload_sha256)=32),
    processing_status text not null check (processing_status in ('processing','processed','ignored')),
    received_at timestamptz not null default now(),
    processed_at timestamptz
);
create table commerce_refund_operations (
    order_id uuid primary key references commerce_orders(id) on delete restrict,
    request_id uuid not null unique,
    reason_code text not null check (reason_code in ('not_provided','contract_mismatch','duplicate_payment',
        'unauthorized_payment','minor_without_consent','other_statutory_reason','operations_live_smoke_cleanup')),
    reason_detail text check (reason_detail is null or char_length(reason_detail) between 1 and 500),
    requested_by text not null check (char_length(requested_by) between 3 and 80),
    processing_status text not null default 'requested' check (processing_status in ('requested','provider_canceled','completed','failed')),
    result_code text check (result_code is null or char_length(result_code) between 1 and 120),
    provider_status text check (provider_status is null or char_length(provider_status) between 1 and 80),
    requested_at timestamptz not null default now(),
    processed_at timestamptz,
    updated_at timestamptz not null default now()
);
create table download_metric_snapshots (
    asset_id bigint not null check (asset_id > 0),
    collected_at timestamptz not null,
    asset_name text not null check (char_length(asset_name) between 1 and 255),
    release_tag text not null check (char_length(release_tag) between 1 and 100),
    version text not null check (char_length(version) between 1 and 80),
    channel text not null check (channel in ('direct_dmg','homebrew_dmg','windows_msi','legacy_unclassified')),
    download_count bigint not null check (download_count >= 0),
    primary key(asset_id,collected_at)
);
create index download_metric_snapshots_collected on download_metric_snapshots(collected_at desc);
create index download_metric_snapshots_channel on download_metric_snapshots(channel,collected_at desc);
