-- SIDEY one-time character commerce. Payment provider secrets and raw payment
-- identifiers stay in the private schema; clients see only their own order and
-- entitlement state through RLS or narrowly scoped RPCs.

create table public.commerce_products (
  id text primary key,
  display_name text not null,
  product_description text not null,
  character_id text not null unique,
  entitlement_key text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint commerce_products_id_format check (id ~ '^[a-z0-9_]{1,80}$'),
  constraint commerce_products_character_id_format check (character_id ~ '^pixel_[a-z0-9_]{1,60}$'),
  constraint commerce_products_entitlement_key_format check (entitlement_key ~ '^character:pixel_[a-z0-9_]{1,60}$')
);

create table public.commerce_prices (
  id uuid primary key default extensions.gen_random_uuid(),
  product_id text not null references public.commerce_products(id) on delete restrict,
  amount_krw integer not null,
  currency text not null default 'KRW',
  tax_inclusive boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  constraint commerce_prices_positive check (amount_krw > 0),
  constraint commerce_prices_currency check (currency = 'KRW'),
  constraint commerce_prices_retirement check (
    (active is true and retired_at is null) or active is false
  )
);

create unique index commerce_prices_one_active_per_product
on public.commerce_prices (product_id)
where active is true;

create table public.commerce_orders (
  id uuid primary key default extensions.gen_random_uuid(),
  provider_order_id text not null unique,
  user_id uuid not null references auth.users(id) on delete restrict,
  product_id text not null references public.commerce_products(id) on delete restrict,
  price_id uuid not null references public.commerce_prices(id) on delete restrict,
  amount_krw integer not null,
  currency text not null,
  status text not null default 'pending',
  checkout_token_hash bytea not null unique,
  checkout_token_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  refunded_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint commerce_orders_status check (
    status in ('pending', 'approved', 'failed', 'canceled', 'refunded')
  ),
  constraint commerce_orders_amount_positive check (amount_krw > 0),
  constraint commerce_orders_currency check (currency = 'KRW'),
  constraint commerce_orders_token_length check (octet_length(checkout_token_hash) = 32)
);

create index commerce_orders_user_created_idx
on public.commerce_orders (user_id, created_at desc);

create table public.commerce_entitlements (
  user_id uuid not null references auth.users(id) on delete restrict,
  entitlement_key text not null,
  source_order_id uuid not null unique references public.commerce_orders(id) on delete restrict,
  status text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, entitlement_key),
  constraint commerce_entitlements_status check (status in ('active', 'refunded', 'revoked')),
  constraint commerce_entitlements_revocation check (
    (status = 'active' and revoked_at is null)
    or (status != 'active' and revoked_at is not null)
  )
);

create table private.commerce_payments (
  order_id uuid primary key references public.commerce_orders(id) on delete restrict,
  payment_key text not null unique,
  provider_status text not null,
  provider_transaction_key text,
  amount_krw integer not null,
  currency text not null,
  last_verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.commerce_webhook_events (
  event_id text primary key,
  event_type text not null,
  payload_sha256 bytea not null,
  processing_status text not null default 'processing',
  order_id uuid references public.commerce_orders(id) on delete restrict,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint commerce_webhook_event_id_length check (char_length(event_id) between 1 and 200),
  constraint commerce_webhook_payload_hash_length check (octet_length(payload_sha256) = 32),
  constraint commerce_webhook_status check (processing_status in ('processing', 'processed', 'ignored'))
);

revoke all on private.commerce_payments, private.commerce_webhook_events
from public, anon, authenticated;

alter table public.commerce_products enable row level security;
alter table public.commerce_prices enable row level security;
alter table public.commerce_orders enable row level security;
alter table public.commerce_entitlements enable row level security;

revoke all on public.commerce_products, public.commerce_prices,
  public.commerce_orders, public.commerce_entitlements
from public, anon, authenticated;

grant select on public.commerce_products, public.commerce_prices,
  public.commerce_orders, public.commerce_entitlements
to authenticated;

create policy commerce_products_select_active
on public.commerce_products for select to authenticated
using (active is true);

create policy commerce_prices_select_active
on public.commerce_prices for select to authenticated
using (active is true);

create policy commerce_orders_select_own
on public.commerce_orders for select to authenticated
using (user_id = (select auth.uid()));

create policy commerce_entitlements_select_own
on public.commerce_entitlements for select to authenticated
using (user_id = (select auth.uid()));

insert into public.commerce_products (
  id, display_name, product_description, character_id, entitlement_key, active
)
values (
  'character_starlight_upalupa',
  '별빛 우파루파',
  '진주빛 몸과 별빛 아가미를 가진 우파루파예요. 가만히 있을 때 별이 은은하게 반짝이고, 더블클릭하면 별무리가 팡 터져요.',
  'pixel_starlight_upalupa',
  'character:pixel_starlight_upalupa',
  true
)
on conflict (id) do update
set display_name = excluded.display_name,
    product_description = excluded.product_description,
    character_id = excluded.character_id,
    entitlement_key = excluded.entitlement_key,
    active = excluded.active,
    updated_at = now();

insert into public.commerce_prices (
  id, product_id, amount_krw, currency, tax_inclusive, active
)
values (
  '510e7000-0000-0000-0000-000000000990',
  'character_starlight_upalupa',
  990,
  'KRW',
  true,
  true
)
on conflict (id) do update
set amount_krw = excluded.amount_krw,
    currency = excluded.currency,
    tax_inclusive = excluded.tax_inclusive,
    active = excluded.active,
    retired_at = null;

create or replace function private.has_google_identity(check_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.identities
    where user_id = check_user_id and provider = 'google'
  ) or coalesce((
    select raw_app_meta_data -> 'providers' ? 'google'
    from auth.users where id = check_user_id
  ), false);
$$;

revoke all on function private.has_google_identity(uuid) from public, anon, authenticated;

create or replace function public.get_commerce_state(
  p_product_id text default 'character_starlight_upalupa'
)
returns table (
  product_id text,
  display_name text,
  product_description text,
  character_id text,
  entitlement_key text,
  amount_krw integer,
  currency text,
  tax_inclusive boolean,
  google_connected boolean,
  entitlement_status text,
  latest_order_status text
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
         products.character_id,
         products.entitlement_key,
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
          limit 1)
  from public.commerce_products products
  join public.commerce_prices prices
    on prices.product_id = products.id and prices.active is true
  where products.id = p_product_id and products.active is true;
end;
$$;

revoke all on function public.get_commerce_state(text) from public, anon;
grant execute on function public.get_commerce_state(text) to authenticated;

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
  where id = p_product_id and active is true;
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
    and orders.checkout_token_expires_at > now();
end;
$$;

revoke all on function public.commerce_checkout_order(text) from public, anon, authenticated;
grant execute on function public.commerce_checkout_order(text) to service_role;

create or replace function public.commerce_cancel_checkout(p_checkout_token_hash_hex text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_checkout_token_hash_hex !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  update public.commerce_orders
  set status = 'canceled', updated_at = now()
  where checkout_token_hash = decode(p_checkout_token_hash_hex, 'hex')
    and status = 'pending'
    and checkout_token_expires_at > now();
  return found;
end;
$$;

revoke all on function public.commerce_cancel_checkout(text) from public, anon, authenticated;
grant execute on function public.commerce_cancel_checkout(text) to service_role;

create or replace function private.apply_commerce_payment_state(
  p_provider_order_id text,
  p_payment_key text,
  p_amount_krw integer,
  p_balance_amount_krw integer,
  p_currency text,
  p_provider_status text,
  p_provider_transaction_key text,
  p_verified_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_order public.commerce_orders;
  target_product public.commerce_products;
  changed_user_id uuid;
begin
  select * into target_order
  from public.commerce_orders
  where provider_order_id = p_provider_order_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'commerce_order_not_found';
  end if;
  if target_order.amount_krw != p_amount_krw or target_order.currency != p_currency then
    raise exception using errcode = '22023', message = 'commerce_amount_mismatch';
  end if;
  if char_length(coalesce(p_payment_key, '')) < 10 then
    raise exception using errcode = '22023', message = 'invalid_payment_key';
  end if;

  select * into target_product
  from public.commerce_products where id = target_order.product_id;

  insert into private.commerce_payments (
    order_id, payment_key, provider_status, provider_transaction_key,
    amount_krw, currency, last_verified_at
  )
  values (
    target_order.id, p_payment_key, p_provider_status, p_provider_transaction_key,
    p_amount_krw, p_currency, p_verified_at
  )
  on conflict (order_id) do update
  set provider_status = excluded.provider_status,
      provider_transaction_key = coalesce(excluded.provider_transaction_key, private.commerce_payments.provider_transaction_key),
      amount_krw = excluded.amount_krw,
      currency = excluded.currency,
      last_verified_at = greatest(private.commerce_payments.last_verified_at, excluded.last_verified_at),
      updated_at = now()
  where private.commerce_payments.payment_key = excluded.payment_key;
  if not found then
    raise exception using errcode = '23505', message = 'payment_key_conflict';
  end if;

  if p_provider_status = 'DONE' then
    if target_order.status = 'refunded' then return 'refunded'; end if;
    update public.commerce_orders
    set status = 'approved',
        approved_at = coalesce(approved_at, p_verified_at),
        updated_at = now()
    where id = target_order.id;

    insert into public.commerce_entitlements (
      user_id, entitlement_key, source_order_id, status, granted_at, revoked_at
    )
    values (
      target_order.user_id, target_product.entitlement_key, target_order.id,
      'active', p_verified_at, null
    )
    on conflict (user_id, entitlement_key) do update
    set source_order_id = excluded.source_order_id,
        status = 'active',
        granted_at = excluded.granted_at,
        revoked_at = null,
        updated_at = now();
    return 'approved';
  end if;

  if p_provider_status in ('CANCELED', 'PARTIAL_CANCELED')
     and p_balance_amount_krw = 0 then
    update public.commerce_orders
    set status = 'refunded', refunded_at = coalesce(refunded_at, p_verified_at), updated_at = now()
    where id = target_order.id;

    update public.commerce_entitlements
    set status = 'refunded', revoked_at = coalesce(revoked_at, p_verified_at), updated_at = now()
    where user_id = target_order.user_id
      and entitlement_key = target_product.entitlement_key
      and source_order_id = target_order.id
      and status = 'active'
    returning user_id into changed_user_id;

    if changed_user_id is not null then
      update public.profiles
      set character_id = 'pixel_hamster', updated_at = now()
      where id = changed_user_id
        and character_id = target_product.character_id;
    end if;
    return 'refunded';
  end if;

  if p_provider_status in ('ABORTED', 'EXPIRED') and target_order.status = 'pending' then
    update public.commerce_orders
    set status = 'failed', updated_at = now()
    where id = target_order.id;
    return 'failed';
  end if;

  return target_order.status;
end;
$$;

revoke all on function private.apply_commerce_payment_state(
  text, text, integer, integer, text, text, text, timestamptz
) from public, anon, authenticated;

create or replace function public.commerce_record_approval(
  p_provider_order_id text,
  p_payment_key text,
  p_amount_krw integer,
  p_currency text,
  p_provider_transaction_key text,
  p_verified_at timestamptz
)
returns text
language sql
security definer
set search_path = ''
as $$
  select private.apply_commerce_payment_state(
    p_provider_order_id,
    p_payment_key,
    p_amount_krw,
    p_amount_krw,
    p_currency,
    'DONE',
    p_provider_transaction_key,
    p_verified_at
  );
$$;

revoke all on function public.commerce_record_approval(
  text, text, integer, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.commerce_record_approval(
  text, text, integer, text, text, timestamptz
) to service_role;

create or replace function public.commerce_record_provider_state(
  p_event_id text,
  p_event_type text,
  p_payload_sha256_hex text,
  p_provider_order_id text,
  p_payment_key text,
  p_amount_krw integer,
  p_balance_amount_krw integer,
  p_currency text,
  p_provider_status text,
  p_provider_transaction_key text,
  p_verified_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_hash bytea;
  applied_status text;
  target_order_id uuid;
begin
  if char_length(coalesce(p_event_id, '')) not between 1 and 200
     or p_payload_sha256_hex !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_webhook_event';
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
    select status into applied_status
    from public.commerce_orders where provider_order_id = p_provider_order_id;
    return coalesce(applied_status, 'ignored');
  end if;

  applied_status := private.apply_commerce_payment_state(
    p_provider_order_id,
    p_payment_key,
    p_amount_krw,
    p_balance_amount_krw,
    p_currency,
    p_provider_status,
    p_provider_transaction_key,
    p_verified_at
  );
  select id into target_order_id
  from public.commerce_orders where provider_order_id = p_provider_order_id;
  update private.commerce_webhook_events
  set processing_status = case when applied_status in ('approved', 'refunded', 'failed')
        then 'processed' else 'ignored' end,
      order_id = target_order_id,
      processed_at = now()
  where event_id = p_event_id;
  return applied_status;
end;
$$;

revoke all on function public.commerce_record_provider_state(
  text, text, text, text, text, integer, integer, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.commerce_record_provider_state(
  text, text, text, text, text, integer, integer, text, text, text, timestamptz
) to service_role;

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
  return query
  select orders.provider_order_id,
         payments.payment_key,
         orders.amount_krw,
         orders.currency
  from public.commerce_orders orders
  join private.commerce_payments payments on payments.order_id = orders.id
  where orders.id = p_order_id
    and orders.status = 'approved'
    and orders.approved_at >= now() - interval '7 days';
end;
$$;

revoke all on function public.commerce_refund_target(uuid) from public, anon, authenticated;
grant execute on function public.commerce_refund_target(uuid) to service_role;

-- Paid character selection is server-authoritative. Remote profile reads do
-- not consult the viewer's entitlement, so friends can always render it.
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
    else p_character_id
  end;
  saved_profile public.profiles;
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if char_length(btrim(p_nickname)) not between 2 and 8 or p_nickname ~ E'[\n\r\t]' then
    raise exception using errcode = '22023', message = 'invalid_nickname';
  end if;
  if normalized_character_id not in (
    'pixel_hamster', 'pixel_cat', 'pixel_puppy', 'pixel_rabbit', 'pixel_penguin',
    'pixel_starlight_upalupa'
  ) then
    raise exception using errcode = '22023', message = 'invalid_character_id';
  end if;
  if normalized_character_id = 'pixel_starlight_upalupa' and not exists (
    select 1 from public.commerce_entitlements
    where user_id = current_user_id
      and entitlement_key = 'character:pixel_starlight_upalupa'
      and status = 'active'
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
