begin;

-- Production-safe first step. Staging is enabled explicitly after migrations.
update private.commerce_runtime_settings
set sales_enabled = false,
    payment_environment = 'test',
    policy_version = '2026-09-02-portone-v1',
    policy_notice = '표시 가격은 부가세 포함 금액이며 구매 전 Google 계정 연결이 필요합니다. 결제창은 PortOne을 통해 연결된 결제대행사가 제공합니다. SIDEY 서버가 결제 금액과 상태를 다시 확인한 뒤 디지털 캐릭터 사용권 제공이 즉시 시작됩니다. 구매 승인 후 7일 이내에는 사용 여부와 관계없이 전액 환불하며, 그 이후에도 법정 사유가 확인되면 전액 환불합니다.',
    updated_at = now()
where singleton is true;

update public.commerce_orders
set status = 'canceled', updated_at = now()
where status = 'pending';

-- Retire the historical 990 KRW starlight price without rewriting history.
update public.commerce_prices
set active = false,
    retired_at = coalesce(retired_at, now())
where product_id = 'character_starlight_upalupa'
  and active is true;

insert into public.commerce_products (
  id, display_name, product_description, character_id, entitlement_key, active
)
values
  (
    'character_guinea_pig', '아기 기니피그',
    '낮고 동글동글한 몸에 비대칭 삼색 무늬가 매력인 작은 친구예요.',
    'pixel_guinea_pig', 'character:pixel_guinea_pig', true
  ),
  (
    'character_monkey', '아기 원숭이',
    '세 갈래 머리털과 시안 목도리로 씩씩하게 산책하는 친구예요.',
    'pixel_monkey', 'character:pixel_monkey', true
  ),
  (
    'character_chinchilla', '아기 친칠라',
    '크고 둥근 귀와 포근한 회색 털, 파란 목도리를 가진 친구예요.',
    'pixel_chinchilla', 'character:pixel_chinchilla', true
  )
on conflict (id) do update
set display_name = excluded.display_name,
    product_description = excluded.product_description,
    character_id = excluded.character_id,
    entitlement_key = excluded.entitlement_key,
    active = true,
    updated_at = now();

insert into public.commerce_prices (
  id, product_id, amount_krw, currency, tax_inclusive, active
)
values
  ('510e7000-0000-0000-0000-000000001900', 'character_starlight_upalupa', 1900, 'KRW', true, true),
  ('510e7000-0000-0000-0000-000000000991', 'character_guinea_pig', 990, 'KRW', true, true),
  ('510e7000-0000-0000-0000-000000000992', 'character_monkey', 990, 'KRW', true, true),
  ('510e7000-0000-0000-0000-000000000993', 'character_chinchilla', 990, 'KRW', true, true)
on conflict (id) do update
set amount_krw = excluded.amount_krw,
    currency = excluded.currency,
    tax_inclusive = excluded.tax_inclusive,
    active = true,
    retired_at = null;

alter table public.commerce_entitlements
  alter column source_order_id drop not null,
  add column grant_kind text not null default 'purchase',
  add column grant_reference text;

update public.commerce_entitlements
set grant_kind = 'purchase',
    grant_reference = coalesce(grant_reference, 'order:' || source_order_id::text);

alter table public.commerce_entitlements
  add constraint commerce_entitlements_grant_kind check (
    grant_kind in ('purchase', 'complimentary')
  ),
  add constraint commerce_entitlements_grant_source check (
    (grant_kind = 'purchase' and source_order_id is not null
      and char_length(grant_reference) between 1 and 200)
    or
    (grant_kind = 'complimentary' and source_order_id is null
      and char_length(grant_reference) between 1 and 200)
  );

drop trigger if exists commerce_entitlements_enforce_consent
on public.commerce_entitlements;

create or replace function private.enforce_commerce_entitlement_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.grant_kind = 'purchase' and new.status = 'active' and not exists (
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
  if new.grant_kind = 'complimentary' and new.source_order_id is not null then
    raise exception using errcode = '22023', message = 'complimentary_order_not_allowed';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_commerce_entitlement_consent()
from public, anon, authenticated;

create trigger commerce_entitlements_enforce_consent
before insert or update of status, source_order_id, grant_kind
on public.commerce_entitlements
for each row execute function private.enforce_commerce_entitlement_consent();

-- Grant the three newly paid characters to the five approved active accounts.
with recipients(user_id) as (
  values
    ('9c169b9f-e95c-4a3e-b0e9-ab329a035c6f'::uuid),
    ('e68ec90f-6f5a-4a93-be0a-364f6a3f378f'::uuid),
    ('839ec4d5-ada1-466d-bb1d-2a100dea2185'::uuid),
    ('b4877c8c-3147-46ef-b035-5dbb95e86d4f'::uuid),
    ('f0462289-2465-4a27-b90d-d4820ccf4b8c'::uuid)
), grants(entitlement_key) as (
  values
    ('character:pixel_guinea_pig'::text),
    ('character:pixel_monkey'::text),
    ('character:pixel_chinchilla'::text)
)
insert into public.commerce_entitlements (
  user_id, entitlement_key, source_order_id, status, grant_kind,
  grant_reference, granted_at, revoked_at
)
select recipients.user_id,
       grants.entitlement_key,
       null,
       'active',
       'complimentary',
       'paid-transition-2026-09-02:' || recipients.user_id::text,
       now(),
       null
from recipients
join auth.users users on users.id = recipients.user_id
cross join grants
on conflict (user_id, entitlement_key) do nothing;

-- Preserve legacy Toss rows as audit history and store all new PortOne facts
-- in provider-specific columns.
alter table private.commerce_payments
  alter column payment_key drop not null,
  add column provider text not null default 'toss',
  add column portone_payment_id text,
  add column portone_store_id text,
  add column portone_channel_key text,
  add column portone_version text,
  add column portone_channel_type text,
  add column payment_method_type text,
  add column balance_amount_krw integer;

alter table private.commerce_payments
  add constraint commerce_payments_provider check (provider in ('toss', 'portone')),
  add constraint commerce_payments_portone_fields check (
    provider != 'portone' or (
      char_length(portone_payment_id) between 6 and 200
      and char_length(portone_store_id) between 6 and 200
      and char_length(portone_channel_key) between 6 and 200
      and portone_version = 'V2'
      and portone_channel_type in ('TEST', 'LIVE')
      and payment_method_type = 'EASY_PAY'
      and balance_amount_krw >= 0
    )
  );

create unique index commerce_payments_portone_payment_id_unique
on private.commerce_payments (portone_payment_id)
where portone_payment_id is not null;

-- Old provider mutation endpoints are retained only as migration history, not
-- as executable service-role payment paths.
revoke all on function public.commerce_record_approval(
  text, text, integer, text, text, timestamptz
) from service_role;
revoke all on function public.commerce_record_provider_state(
  text, text, text, text, text, integer, integer, text, text, text, timestamptz
) from service_role;

create or replace function public.commerce_record_portone_state(
  p_event_id text,
  p_event_type text,
  p_payload_sha256_hex text,
  p_payment_id text,
  p_store_id text,
  p_channel_key text,
  p_portone_version text,
  p_channel_type text,
  p_amount_krw integer,
  p_balance_amount_krw integer,
  p_currency text,
  p_provider_status text,
  p_transaction_id text,
  p_payment_method_type text,
  p_verified_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_hash bytea;
  target_order public.commerce_orders;
  target_product public.commerce_products;
  applied_status text;
  required_environment text;
  changed_user_id uuid;
begin
  if char_length(coalesce(p_event_id, '')) not between 1 and 200
     or p_payload_sha256_hex !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_webhook_event';
  end if;

  select settings.payment_environment into required_environment
  from private.commerce_runtime_settings settings
  where settings.singleton is true;

  if p_portone_version != 'V2'
     or p_channel_type != upper(required_environment)
     or p_provider_status not in ('PAID', 'FAILED', 'CANCELLED', 'PARTIAL_CANCELLED')
     or p_currency != 'KRW'
     or p_payment_method_type != 'EASY_PAY'
     or char_length(coalesce(p_store_id, '')) < 6
     or char_length(coalesce(p_channel_key, '')) < 6 then
    raise exception using errcode = '22023', message = 'portone_payment_environment_mismatch';
  end if;

  select * into target_order
  from public.commerce_orders orders
  where orders.provider_order_id = p_payment_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'commerce_order_not_found';
  end if;
  if target_order.amount_krw != p_amount_krw
     or target_order.currency != p_currency
     or p_balance_amount_krw < 0
     or p_balance_amount_krw > p_amount_krw then
    raise exception using errcode = '22023', message = 'commerce_amount_mismatch';
  end if;

  insert into private.commerce_webhook_events (
    event_id, event_type, payload_sha256
  ) values (
    p_event_id, p_event_type, decode(p_payload_sha256_hex, 'hex')
  ) on conflict (event_id) do nothing;

  if not found then
    select payload_sha256 into existing_hash
    from private.commerce_webhook_events where event_id = p_event_id;
    if existing_hash != decode(p_payload_sha256_hex, 'hex') then
      raise exception using errcode = '23505', message = 'webhook_event_conflict';
    end if;
    return target_order.status;
  end if;

  insert into private.commerce_payments (
    order_id, payment_key, provider, provider_status,
    provider_transaction_key, amount_krw, balance_amount_krw, currency,
    portone_payment_id, portone_store_id, portone_channel_key,
    portone_version, portone_channel_type, payment_method_type,
    last_verified_at
  ) values (
    target_order.id, null, 'portone', p_provider_status,
    p_transaction_id, p_amount_krw, p_balance_amount_krw, p_currency,
    p_payment_id, p_store_id, p_channel_key,
    p_portone_version, p_channel_type, p_payment_method_type,
    p_verified_at
  )
  on conflict (order_id) do update
  set provider_status = excluded.provider_status,
      provider_transaction_key = coalesce(excluded.provider_transaction_key, private.commerce_payments.provider_transaction_key),
      amount_krw = excluded.amount_krw,
      balance_amount_krw = excluded.balance_amount_krw,
      currency = excluded.currency,
      portone_store_id = excluded.portone_store_id,
      portone_channel_key = excluded.portone_channel_key,
      portone_version = excluded.portone_version,
      portone_channel_type = excluded.portone_channel_type,
      payment_method_type = excluded.payment_method_type,
      last_verified_at = greatest(private.commerce_payments.last_verified_at, excluded.last_verified_at),
      updated_at = now()
  where private.commerce_payments.provider = 'portone'
    and private.commerce_payments.portone_payment_id = excluded.portone_payment_id;
  if not found then
    raise exception using errcode = '23505', message = 'portone_payment_conflict';
  end if;

  select * into target_product
  from public.commerce_products products
  where products.id = target_order.product_id;

  if p_provider_status = 'PAID' then
    if target_order.status = 'refunded' then
      applied_status := 'refunded';
    else
      update public.commerce_orders
      set status = 'approved',
          approved_at = coalesce(approved_at, p_verified_at),
          updated_at = now()
      where id = target_order.id;

      insert into public.commerce_entitlements (
        user_id, entitlement_key, source_order_id, status, grant_kind,
        grant_reference, granted_at, revoked_at
      ) values (
        target_order.user_id, target_product.entitlement_key, target_order.id,
        'active', 'purchase', 'order:' || target_order.id::text,
        p_verified_at, null
      )
      on conflict (user_id, entitlement_key) do update
      set source_order_id = excluded.source_order_id,
          status = 'active',
          grant_kind = 'purchase',
          grant_reference = excluded.grant_reference,
          granted_at = excluded.granted_at,
          revoked_at = null,
          updated_at = now()
      where public.commerce_entitlements.grant_kind = 'purchase';

      if not found and exists (
        select 1 from public.commerce_entitlements entitlements
        where entitlements.user_id = target_order.user_id
          and entitlements.entitlement_key = target_product.entitlement_key
          and entitlements.status = 'active'
      ) then
        -- A complimentary grant already owns the key; keep its provenance.
        null;
      end if;
      applied_status := 'approved';
    end if;
  elsif p_provider_status = 'CANCELLED' and p_balance_amount_krw = 0 then
    update public.commerce_orders
    set status = 'refunded',
        refunded_at = coalesce(refunded_at, p_verified_at),
        updated_at = now()
    where id = target_order.id;

    update public.commerce_entitlements
    set status = 'refunded',
        revoked_at = coalesce(revoked_at, p_verified_at),
        updated_at = now()
    where user_id = target_order.user_id
      and entitlement_key = target_product.entitlement_key
      and source_order_id = target_order.id
      and grant_kind = 'purchase'
      and status = 'active'
    returning user_id into changed_user_id;

    if changed_user_id is not null then
      update public.profiles
      set character_id = 'pixel_hamster', updated_at = now()
      where id = changed_user_id
        and character_id = target_product.character_id;
    end if;
    applied_status := 'refunded';
  elsif p_provider_status = 'FAILED' and target_order.status = 'pending' then
    update public.commerce_orders
    set status = 'failed', updated_at = now()
    where id = target_order.id;
    applied_status := 'failed';
  else
    applied_status := target_order.status;
  end if;

  update private.commerce_webhook_events
  set processing_status = case
        when applied_status in ('approved', 'refunded', 'failed') then 'processed'
        else 'ignored'
      end,
      order_id = target_order.id,
      processed_at = now()
  where event_id = p_event_id;

  return applied_status;
end;
$$;

revoke all on function public.commerce_record_portone_state(
  text, text, text, text, text, text, text, text,
  integer, integer, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.commerce_record_portone_state(
  text, text, text, text, text, text, text, text,
  integer, integer, text, text, text, text, timestamptz
) to service_role;

drop function if exists public.commerce_refund_target(uuid);
drop function if exists public.commerce_refund_target(uuid, text, uuid, text, text);

create function public.commerce_refund_target(
  p_order_id uuid,
  p_reason_code text,
  p_request_id uuid,
  p_requested_by text,
  p_reason_detail text default null
)
returns table (
  request_id uuid,
  payment_id text,
  amount_krw integer,
  currency text,
  payment_environment text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_request private.commerce_refund_operations;
begin
  if p_order_id is null or p_request_id is null then
    raise exception using errcode = '22023', message = 'invalid_refund_request';
  end if;
  if p_reason_code is null or p_reason_code not in (
    'not_provided', 'contract_mismatch', 'duplicate_payment',
    'unauthorized_payment', 'minor_without_consent',
    'other_statutory_reason', 'operations_live_smoke_cleanup'
  ) then
    raise exception using errcode = '22023', message = 'invalid_refund_reason';
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
    select 1
    from public.commerce_orders orders
    join private.commerce_payments payments on payments.order_id = orders.id
    where orders.id = p_order_id
      and orders.status = 'approved'
      and payments.provider = 'portone'
      and payments.portone_payment_id is not null
  ) then
    return;
  end if;

  insert into private.commerce_refund_operations (
    order_id, request_id, reason_code, reason_detail, requested_by
  ) values (
    p_order_id, p_request_id, p_reason_code,
    nullif(btrim(p_reason_detail), ''), btrim(p_requested_by)
  ) on conflict (order_id) do nothing;

  select * into existing_request
  from private.commerce_refund_operations operations
  where operations.order_id = p_order_id;
  if existing_request.reason_code is distinct from p_reason_code then
    raise exception using errcode = '23505', message = 'refund_request_conflict';
  end if;

  return query
  select existing_request.request_id,
         payments.portone_payment_id,
         orders.amount_krw,
         orders.currency,
         settings.payment_environment
  from public.commerce_orders orders
  join private.commerce_payments payments on payments.order_id = orders.id
  cross join private.commerce_runtime_settings settings
  where orders.id = p_order_id and orders.status = 'approved';
end;
$$;

revoke all on function public.commerce_refund_target(uuid, text, uuid, text, text)
from public, anon, authenticated;
grant execute on function public.commerce_refund_target(uuid, text, uuid, text, text)
to service_role;

create function public.commerce_portone_checkout_prepare(
  p_checkout_token_hash_hex text
)
returns table (
  order_id uuid,
  payment_id text,
  product_id text,
  display_name text,
  character_id text,
  amount_krw integer,
  currency text,
  customer_name text,
  policy_version text,
  policy_notice text,
  policy_consented_at timestamptz,
  payment_environment text
)
language sql
security definer
set search_path = ''
as $$
  select orders.id,
         orders.provider_order_id,
         orders.product_id,
         products.display_name,
         products.character_id,
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
    and p_checkout_token_hash_hex ~ '^[0-9a-f]{64}$'
    and orders.checkout_token_hash = decode(p_checkout_token_hash_hex, 'hex')
    and orders.status = 'pending'
    and orders.checkout_token_expires_at > now();
$$;

revoke all on function public.commerce_portone_checkout_prepare(text)
from public, anon, authenticated;
grant execute on function public.commerce_portone_checkout_prepare(text) to service_role;

create function public.commerce_portone_completion_order(
  p_checkout_token_hash_hex text,
  p_payment_id text
)
returns table (
  order_id uuid,
  payment_id text,
  product_id text,
  display_name text,
  amount_krw integer,
  currency text,
  order_status text,
  payment_environment text
)
language sql
security definer
set search_path = ''
as $$
  select orders.id,
         orders.provider_order_id,
         orders.product_id,
         products.display_name,
         orders.amount_krw,
         orders.currency,
         orders.status,
         settings.payment_environment
  from public.commerce_orders orders
  join public.commerce_products products on products.id = orders.product_id
  cross join private.commerce_runtime_settings settings
  where p_checkout_token_hash_hex ~ '^[0-9a-f]{64}$'
    and orders.checkout_token_hash = decode(p_checkout_token_hash_hex, 'hex')
    and orders.provider_order_id = p_payment_id
    and orders.checkout_token_expires_at > now() - interval '5 minutes'
    and orders.status in ('pending', 'approved', 'refunded');
$$;

revoke all on function public.commerce_portone_completion_order(text, text)
from public, anon, authenticated;
grant execute on function public.commerce_portone_completion_order(text, text)
to service_role;

create function public.commerce_portone_order_by_payment_id(p_payment_id text)
returns table (
  order_id uuid,
  payment_id text,
  product_id text,
  display_name text,
  amount_krw integer,
  currency text,
  order_status text,
  payment_environment text
)
language sql
security definer
set search_path = ''
as $$
  select orders.id,
         orders.provider_order_id,
         orders.product_id,
         products.display_name,
         orders.amount_krw,
         orders.currency,
         orders.status,
         settings.payment_environment
  from public.commerce_orders orders
  join public.commerce_products products on products.id = orders.product_id
  cross join private.commerce_runtime_settings settings
  where orders.provider_order_id = p_payment_id;
$$;

revoke all on function public.commerce_portone_order_by_payment_id(text)
from public, anon, authenticated;
grant execute on function public.commerce_portone_order_by_payment_id(text)
to service_role;

create or replace function public.upsert_profile(
  p_nickname text,
  p_character_id text default 'pixel_hamster'
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  normalized_character_id text := case
    when p_character_id = 'minty_pup' then 'pixel_hamster'
    when p_character_id = 'pixel_koala' then 'pixel_chinchilla'
    else p_character_id
  end;
  required_entitlement text;
  saved_profile public.profiles;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if char_length(btrim(p_nickname)) not between 2 and 8
     or p_nickname ~ E'[\n\r\t]' then
    raise exception using errcode = '22023', message = 'invalid_nickname';
  end if;
  if normalized_character_id not in (
    'pixel_hamster', 'pixel_cat', 'pixel_puppy', 'pixel_rabbit', 'pixel_penguin',
    'pixel_guinea_pig', 'pixel_monkey', 'pixel_chinchilla',
    'pixel_starlight_upalupa'
  ) then
    raise exception using errcode = '22023', message = 'invalid_character_id';
  end if;

  select products.entitlement_key into required_entitlement
  from public.commerce_products products
  where products.character_id = normalized_character_id
    and products.active is true;

  if required_entitlement is not null and not exists (
    select 1 from public.commerce_entitlements entitlements
    where entitlements.user_id = current_user_id
      and entitlements.entitlement_key = required_entitlement
      and entitlements.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'character_ownership_required';
  end if;

  insert into public.profiles (id, nickname, character_id)
  values (current_user_id, btrim(p_nickname), normalized_character_id)
  on conflict (id) do update
  set nickname = excluded.nickname,
      character_id = excluded.character_id,
      updated_at = now()
  returning * into saved_profile;
  return saved_profile;
end;
$$;

revoke all on function public.upsert_profile(text, text) from public, anon;
grant execute on function public.upsert_profile(text, text) to authenticated;

commit;
