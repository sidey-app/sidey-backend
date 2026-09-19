begin;

alter table private.commerce_payments
  drop constraint commerce_payments_portone_fields,
  add constraint commerce_payments_portone_fields check (
    provider != 'portone' or (
      char_length(portone_payment_id) between 6 and 200
      and char_length(portone_store_id) between 6 and 200
      and char_length(portone_channel_key) between 6 and 200
      and portone_version = 'V2'
      and portone_channel_type in ('TEST', 'LIVE')
      and payment_method_type is not null
      and payment_method_type in ('CARD', 'EASY_PAY')
      and balance_amount_krw >= 0
    )
  );

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
     or p_payment_method_type is null
     or p_payment_method_type not in ('CARD', 'EASY_PAY')
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

commit;
