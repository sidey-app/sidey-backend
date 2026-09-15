-- Record an operator-initiated live smoke cancellation honestly instead of
-- misclassifying it as a statutory consumer refund.

alter table private.commerce_refund_operations
  drop constraint commerce_refund_reason_code;
alter table private.commerce_refund_operations
  add constraint commerce_refund_reason_code check (
    reason_code in (
      'not_provided',
      'contract_mismatch',
      'duplicate_payment',
      'unauthorized_payment',
      'minor_without_consent',
      'other_statutory_reason',
      'operations_live_smoke_cleanup'
    )
  );
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
    'other_statutory_reason',
    'operations_live_smoke_cleanup'
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
  if p_reason_code = 'operations_live_smoke_cleanup'
     and char_length(btrim(coalesce(p_reason_detail, ''))) not between 12 and 500 then
    raise exception using errcode = '22023', message = 'smoke_refund_detail_required';
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
