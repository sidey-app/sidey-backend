-- Unknown historical facts remain unknown; new orders always select an environment.
alter table commerce_orders alter column payment_environment drop not null;
alter table commerce_payments alter column balance_amount_krw drop not null;
alter table commerce_payments add constraint portone_balance_known
    check (provider <> 'portone' or balance_amount_krw is not null);
alter table commerce_grants add column legacy_source_reference text;
create table commerce_runtime_settings (
    singleton boolean primary key default true check (singleton),
    sales_enabled boolean not null default false,
    payment_environment text not null check (payment_environment in ('test','live')),
    policy_version text not null check (char_length(policy_version) between 1 and 80),
    policy_notice text not null check (char_length(policy_notice) between 80 and 4000),
    updated_at timestamptz not null default now()
);
create table character_item_transition (
    singleton boolean primary key default true check (singleton),
    cutover_at timestamptz not null
);
create table migration_runs (
    id uuid primary key,
    completed_at timestamptz not null default now(),
    report jsonb not null
);
