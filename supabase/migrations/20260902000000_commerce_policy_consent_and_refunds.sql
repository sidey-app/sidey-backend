-- Forward-only hardening for live SIDEY commerce.
--
-- The original 20260901010000 migration may already be applied in production,
-- so this migration adds an explicit disclosure/consent trail, a server-side
-- sales lock, entitlement enforcement, and reasoned refund operation records
-- without rewriting the historical migration.

create table private.commerce_runtime_settings (
  singleton boolean primary key default true,
  sales_enabled boolean not null default false,
  payment_environment text not null default 'test',
  policy_version text not null,
  policy_notice text not null,
  updated_at timestamptz not null default now(),
  constraint commerce_runtime_settings_singleton check (singleton is true),
  constraint commerce_runtime_settings_environment check (
    payment_environment in ('test', 'live')
  ),
  constraint commerce_runtime_settings_policy_version check (
    char_length(policy_version) between 1 and 80
  ),
  constraint commerce_runtime_settings_policy_notice check (
    char_length(policy_notice) between 80 and 4000
  )
);

insert into private.commerce_runtime_settings (
  singleton,
  sales_enabled,
  payment_environment,
  policy_version,
  policy_notice
)
values (
  true,
  false,
  'test',
  '2026-09-02-v1',
  '표시 가격은 부가세 포함 금액이며 구매 전 Google 계정 연결이 필요합니다. SIDEY 서버가 결제 승인과 소유권을 확인하면 별빛 우파루파 디지털 사용권 제공이 즉시 시작됩니다. 사용권 제공이 시작된 뒤에는 단순 변심에 따른 청약철회가 제한됩니다. 미제공, 계약 내용 불일치, 중복 결제, 무단 결제 등 법정 사유가 확인되면 전액 환불합니다.'
)
on conflict (singleton) do update
set policy_version = excluded.policy_version,
    policy_notice = excluded.policy_notice,
    updated_at = now();

revoke all on private.commerce_runtime_settings from public, anon, authenticated;

alter table public.commerce_orders
  add column policy_version text,
  add column policy_notice text,
  add column policy_consented_at timestamptz;

alter table public.commerce_orders
  add constraint commerce_orders_policy_consent_complete check (
    (policy_version is null and policy_notice is null and policy_consented_at is null)
    or (policy_version is not null and policy_notice is not null and policy_consented_at is not null)
  ),
  add constraint commerce_orders_policy_version_length check (
    policy_version is null or char_length(policy_version) between 1 and 80
  ),
  add constraint commerce_orders_policy_notice_length check (
    policy_notice is null or char_length(policy_notice) between 80 and 4000
  );

create or replace function private.enforce_commerce_sales_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not coalesce((
    select settings.sales_enabled
    from private.commerce_runtime_settings settings
    where settings.singleton is true
  ), false) then
    raise exception using errcode = 'P0001', message = 'commerce_sales_disabled';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_commerce_sales_lock()
from public, anon, authenticated;

create trigger commerce_orders_enforce_sales_lock
before insert on public.commerce_orders
for each row execute function private.enforce_commerce_sales_lock();

create or replace function private.enforce_commerce_entitlement_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'active' and not exists (
    select 1
    from public.commerce_orders orders
    where orders.id = new.source_order_id
      and orders.user_id = new.user_id
      and orders.policy_version is not null
      and orders.policy_notice is not null
      and orders.policy_consented_at is not null
  ) then
    raise exception using errcode = '42501', message = 'payment_policy_consent_required';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_commerce_entitlement_consent()
from public, anon, authenticated;

create trigger commerce_entitlements_enforce_consent
before insert or update of status, source_order_id on public.commerce_entitlements
for each row execute function private.enforce_commerce_entitlement_consent();

create or replace function public.commerce_runtime_configuration()
returns table (
  sales_enabled boolean,
  payment_environment text,
  policy_version text,
  policy_notice text
)
language sql
stable
security definer
set search_path = ''
as $$
  select settings.sales_enabled,
         settings.payment_environment,
         settings.policy_version,
         settings.policy_notice
  from private.commerce_runtime_settings settings
  where settings.singleton is true;
$$;

revoke all on function public.commerce_runtime_configuration()
from public, anon, authenticated;
grant execute on function public.commerce_runtime_configuration() to service_role;

create or replace function public.commerce_checkout_prepare(
  p_checkout_token_hash_hex text
)
returns table (
  order_id uuid,
  provider_order_id text,
  display_name text,
  amount_krw integer,
  currency text,
  customer_name text,
  policy_version text,
  policy_notice text,
  policy_consented_at timestamptz,
  payment_environment text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_checkout_token_hash_hex !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  return query
  select orders.id,
         orders.provider_order_id,
         products.display_name,
         orders.amount_krw,
         orders.currency,
         profiles.nickname,
         settings.policy_version,
         settings.policy_notice,
         orders.policy_consented_at,
         settings.payment_environment
  from public.commerce_orders orders
  join public.commerce_products products on products.id = orders.product_id
  join public.profiles profiles on profiles.id = orders.user_id
  cross join private.commerce_runtime_settings settings
  where settings.singleton is true
    and settings.sales_enabled is true
    and orders.checkout_token_hash = decode(p_checkout_token_hash_hex, 'hex')
    and orders.status = 'pending'
    and orders.checkout_token_expires_at > now();
end;
$$;

revoke all on function public.commerce_checkout_prepare(text)
from public, anon, authenticated;
grant execute on function public.commerce_checkout_prepare(text) to service_role;

create or replace function public.commerce_record_policy_consent(
  p_checkout_token_hash_hex text,
  p_policy_version text
)
returns table (
  order_id uuid,
  provider_order_id text,
  display_name text,
  amount_krw integer,
  currency text,
  customer_name text,
  policy_version text,
  policy_notice text,
  policy_consented_at timestamptz,
  payment_environment text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_order public.commerce_orders;
  settings private.commerce_runtime_settings;
begin
  if p_checkout_token_hash_hex !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_checkout_token';
  end if;

  select * into settings
  from private.commerce_runtime_settings
  where singleton is true;
  if not found or settings.sales_enabled is not true then
    raise exception using errcode = 'P0001', message = 'commerce_sales_disabled';
  end if;
  if p_policy_version is distinct from settings.policy_version then
    raise exception using errcode = '22023', message = 'commerce_policy_version_mismatch';
  end if;

  select * into target_order
  from public.commerce_orders
  where checkout_token_hash = decode(p_checkout_token_hash_hex, 'hex')
    and status = 'pending'
    and checkout_token_expires_at > now()
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'checkout_expired';
  end if;

  if target_order.policy_consented_at is null then
    update public.commerce_orders
    set policy_version = settings.policy_version,
        policy_notice = settings.policy_notice,
        policy_consented_at = now(),
        updated_at = now()
    where id = target_order.id
    returning * into target_order;
  elsif target_order.policy_version is distinct from settings.policy_version
     or target_order.policy_notice is distinct from settings.policy_notice then
    raise exception using errcode = '23505', message = 'commerce_policy_consent_conflict';
  end if;

  return query
  select target_order.id,
         target_order.provider_order_id,
         products.display_name,
         target_order.amount_krw,
         target_order.currency,
         profiles.nickname,
         target_order.policy_version,
         target_order.policy_notice,
         target_order.policy_consented_at,
         settings.payment_environment
  from public.commerce_products products
  join public.profiles profiles on profiles.id = target_order.user_id
  where products.id = target_order.product_id;
end;
$$;

revoke all on function public.commerce_record_policy_consent(text, text)
from public, anon, authenticated;
grant execute on function public.commerce_record_policy_consent(text, text) to service_role;

-- Keep the original RPC signature for return URLs and a rolling Edge Function
-- deployment, but make it impossible to retrieve payment configuration before
-- the canonical disclosure has been accepted.
create or replace function public.commerce_checkout_order(p_checkout_token_hash_hex text)
returns table (
  order_id uuid,
  provider_order_id text,
  display_name text,
  amount_krw integer,
  currency text,
  customer_name text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_checkout_token_hash_hex !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  return query
  select orders.id,
         orders.provider_order_id,
         products.display_name,
         orders.amount_krw,
         orders.currency,
         profiles.nickname
  from public.commerce_orders orders
  join public.commerce_products products on products.id = orders.product_id
  join public.profiles profiles on profiles.id = orders.user_id
  where orders.checkout_token_hash = decode(p_checkout_token_hash_hex, 'hex')
    and orders.status = 'pending'
    and orders.checkout_token_expires_at > now()
    and orders.policy_version is not null
    and orders.policy_notice is not null
    and orders.policy_consented_at is not null;
end;
$$;

revoke all on function public.commerce_checkout_order(text)
from public, anon, authenticated;
grant execute on function public.commerce_checkout_order(text) to service_role;

create table private.commerce_refund_operations (
  order_id uuid primary key references public.commerce_orders(id) on delete restrict,
  request_id uuid not null unique,
  reason_code text not null,
  reason_detail text,
  requested_by text not null,
  requested_at timestamptz not null default now(),
  processing_status text not null default 'requested',
  result_code text,
  provider_status text,
  processed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint commerce_refund_reason_code check (
    reason_code in (
      'not_provided',
      'contract_mismatch',
      'duplicate_payment',
      'unauthorized_payment',
      'minor_without_consent',
      'other_statutory_reason'
    )
  ),
  constraint commerce_refund_reason_detail check (
    reason_detail is null or char_length(reason_detail) between 1 and 500
  ),
  constraint commerce_refund_requested_by check (
    char_length(requested_by) between 3 and 80
  ),
  constraint commerce_refund_processing_status check (
    processing_status in ('requested', 'provider_canceled', 'completed', 'failed')
  ),
  constraint commerce_refund_result_code check (
    result_code is null or char_length(result_code) between 1 and 120
  ),
  constraint commerce_refund_provider_status check (
    provider_status is null or char_length(provider_status) between 1 and 80
  )
);

revoke all on private.commerce_refund_operations from public, anon, authenticated;

-- Disable the old reasonless refund lookup. The replacement below requires a
-- statutory reason and records the authenticated operations request first.
create or replace function public.commerce_refund_target(p_order_id uuid)
returns table (
  provider_order_id text,
  payment_key text,
  amount_krw integer,
  currency text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using errcode = '22023', message = 'refund_reason_required';
end;
$$;

revoke all on function public.commerce_refund_target(uuid)
from public, anon, authenticated, service_role;

create or replace function public.commerce_refund_target(
  p_order_id uuid,
  p_reason_code text,
  p_request_id uuid,
  p_requested_by text,
  p_reason_detail text default null
)
returns table (
  request_id uuid,
  provider_order_id text,
  payment_key text,
  amount_krw integer,
  currency text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_request private.commerce_refund_operations;
begin
  if p_order_id is null then
    raise exception using errcode = '22023', message = 'invalid_refund_order_id';
  end if;
  if p_reason_code is null or p_reason_code not in (
    'not_provided',
    'contract_mismatch',
    'duplicate_payment',
    'unauthorized_payment',
    'minor_without_consent',
    'other_statutory_reason'
  ) then
    raise exception using errcode = '22023', message = 'invalid_refund_reason';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_refund_request_id';
  end if;
  if char_length(btrim(coalesce(p_requested_by, ''))) not between 3 and 80 then
    raise exception using errcode = '22023', message = 'invalid_refund_operator';
  end if;
  if p_reason_detail is not null
     and char_length(btrim(p_reason_detail)) not between 1 and 500 then
    raise exception using errcode = '22023', message = 'invalid_refund_reason_detail';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('commerce-refund:' || p_order_id::text, 0));

  if not exists (
    select 1 from public.commerce_orders orders
    join private.commerce_payments payments on payments.order_id = orders.id
    where orders.id = p_order_id and orders.status = 'approved'
  ) then
    return;
  end if;

  insert into private.commerce_refund_operations (
    order_id,
    request_id,
    reason_code,
    reason_detail,
    requested_by
  ) values (
    p_order_id,
    p_request_id,
    p_reason_code,
    nullif(btrim(p_reason_detail), ''),
    btrim(p_requested_by)
  )
  on conflict (order_id) do nothing;

  select * into existing_request
  from private.commerce_refund_operations
  where order_id = p_order_id;
  if existing_request.reason_code is distinct from p_reason_code then
    raise exception using errcode = '23505', message = 'refund_request_conflict';
  end if;

  return query
  select existing_request.request_id,
         orders.provider_order_id,
         payments.payment_key,
         orders.amount_krw,
         orders.currency
  from public.commerce_orders orders
  join private.commerce_payments payments on payments.order_id = orders.id
  where orders.id = p_order_id and orders.status = 'approved';
end;
$$;

revoke all on function public.commerce_refund_target(uuid, text, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.commerce_refund_target(uuid, text, uuid, text, text)
to service_role;

create or replace function public.commerce_record_refund_result(
  p_order_id uuid,
  p_processing_status text,
  p_result_code text,
  p_provider_status text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_processing_status not in ('provider_canceled', 'completed', 'failed') then
    raise exception using errcode = '22023', message = 'invalid_refund_processing_status';
  end if;
  if char_length(coalesce(p_result_code, '')) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'invalid_refund_result_code';
  end if;

  update private.commerce_refund_operations
  set processing_status = p_processing_status,
      result_code = p_result_code,
      provider_status = p_provider_status,
      processed_at = case
        when p_processing_status in ('completed', 'failed') then now()
        else processed_at
      end,
      updated_at = now()
  where order_id = p_order_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'refund_request_not_found';
  end if;
end;
$$;

revoke all on function public.commerce_record_refund_result(uuid, text, text, text)
from public, anon, authenticated;
grant execute on function public.commerce_record_refund_result(uuid, text, text, text)
to service_role;
