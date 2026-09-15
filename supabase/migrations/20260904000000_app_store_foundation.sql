-- App Store commerce foundation.
--
-- Keep public.commerce_entitlements as the client-facing effective projection,
-- while recording each PortOne, App Store, and complimentary source separately.

create table private.commerce_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  entitlement_key text not null references public.commerce_products(entitlement_key) on delete restrict,
  source_kind text not null,
  source_reference text not null,
  status text not null,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint commerce_grants_source_kind check (
    source_kind in ('portone', 'app_store', 'complimentary')
  ),
  constraint commerce_grants_status check (
    status in ('active', 'refunded', 'revoked')
  ),
  constraint commerce_grants_source_reference_length check (
    char_length(source_reference) between 1 and 240
  ),
  constraint commerce_grants_binding check (
    status != 'active' or user_id is not null
  ),
  constraint commerce_grants_revocation check (
    (status = 'active' and revoked_at is null)
    or (status != 'active' and revoked_at is not null)
  ),
  unique (source_kind, source_reference)
);

create index commerce_grants_user_entitlement_idx
on private.commerce_grants (user_id, entitlement_key, status);

create table private.app_store_transactions (
  transaction_id text primary key,
  original_transaction_id text not null,
  product_id text not null references public.commerce_products(id) on delete restrict,
  user_id uuid references auth.users(id) on delete set null,
  app_account_token uuid,
  environment text not null,
  status text not null,
  binding_state text not null default 'bound',
  purchased_at timestamptz not null,
  revoked_at timestamptz,
  signed_at timestamptz not null,
  signed_data_sha256 bytea not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_store_transactions_id_length check (
    char_length(transaction_id) between 1 and 128
    and char_length(original_transaction_id) between 1 and 128
  ),
  constraint app_store_transactions_environment check (
    environment in ('Sandbox', 'Production')
  ),
  constraint app_store_transactions_status check (
    status in ('active', 'refunded', 'revoked')
  ),
  constraint app_store_transactions_binding_state check (
    binding_state in ('bound', 'unbound')
  ),
  constraint app_store_transactions_binding check (
    (binding_state = 'bound' and user_id is not null)
    or (binding_state = 'unbound' and user_id is null)
  ),
  constraint app_store_transactions_hash_length check (
    octet_length(signed_data_sha256) = 32
  ),
  constraint app_store_transactions_revocation check (
    (status = 'active' and revoked_at is null)
    or (status != 'active' and revoked_at is not null)
  )
);

create index app_store_transactions_original_idx
on private.app_store_transactions (original_transaction_id);

create table private.app_store_notification_events (
  notification_uuid uuid primary key,
  notification_type text not null,
  environment text not null,
  transaction_id text,
  signed_at timestamptz not null,
  payload_sha256 bytea not null,
  processing_status text not null default 'processing',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint app_store_notifications_environment check (
    environment in ('Sandbox', 'Production')
  ),
  constraint app_store_notifications_hash_length check (
    octet_length(payload_sha256) = 32
  ),
  constraint app_store_notifications_status check (
    processing_status in ('processing', 'processed', 'ignored')
  )
);

revoke all on private.commerce_grants,
  private.app_store_transactions,
  private.app_store_notification_events
from public, anon, authenticated;

-- Paid users must be deletable. Orders remain as an anonymized financial audit.
alter table public.commerce_orders
  drop constraint commerce_orders_user_id_fkey,
  alter column user_id drop not null,
  add constraint commerce_orders_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete set null;

alter table public.commerce_entitlements
  drop constraint commerce_entitlements_user_id_fkey,
  add constraint commerce_entitlements_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade;

-- Backfill the source ledger before turning the public table into a projection.
insert into private.commerce_grants (
  user_id, entitlement_key, source_kind, source_reference,
  status, granted_at, revoked_at, updated_at
)
select entitlements.user_id,
       entitlements.entitlement_key,
       case entitlements.grant_kind
         when 'complimentary' then 'complimentary'
         else 'portone'
       end,
       case entitlements.grant_kind
         when 'complimentary' then
           coalesce(entitlements.grant_reference, 'legacy-complimentary')
           || ':' || entitlements.user_id::text
           || ':' || entitlements.entitlement_key
         else 'order:' || entitlements.source_order_id::text
       end,
       entitlements.status,
       entitlements.granted_at,
       entitlements.revoked_at,
       entitlements.updated_at
from public.commerce_entitlements entitlements
on conflict (source_kind, source_reference) do nothing;

drop trigger if exists commerce_entitlements_enforce_consent
on public.commerce_entitlements;
drop function if exists private.enforce_commerce_entitlement_consent();

alter table public.commerce_entitlements
  drop constraint commerce_entitlements_grant_source,
  drop constraint commerce_entitlements_grant_kind,
  alter column grant_kind drop not null,
  alter column grant_kind drop default;

comment on column public.commerce_entitlements.source_order_id is
  'Deprecated source field. Effective ownership is derived from private.commerce_grants.';
comment on column public.commerce_entitlements.grant_kind is
  'Deprecated source field. Effective ownership is derived from private.commerce_grants.';
comment on column public.commerce_entitlements.grant_reference is
  'Deprecated source field. Effective ownership is derived from private.commerce_grants.';

update public.commerce_entitlements
set source_order_id = null,
    grant_kind = null,
    grant_reference = null;

create or replace function private.refresh_commerce_entitlement(
  target_user_id uuid,
  target_entitlement_key text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  effective_status text;
  first_granted_at timestamptz;
  effective_revoked_at timestamptz;
begin
  if target_user_id is null then
    return;
  end if;

  select case
           when bool_or(grants.status = 'active') then 'active'
           when bool_or(grants.status = 'refunded') then 'refunded'
           else 'revoked'
         end,
         min(grants.granted_at),
         case when bool_or(grants.status = 'active') then null
              else max(grants.revoked_at)
         end
  into effective_status, first_granted_at, effective_revoked_at
  from private.commerce_grants grants
  where grants.user_id = target_user_id
    and grants.entitlement_key = target_entitlement_key;

  if effective_status is null then
    delete from public.commerce_entitlements
    where user_id = target_user_id
      and entitlement_key = target_entitlement_key;
    return;
  end if;

  insert into public.commerce_entitlements (
    user_id, entitlement_key, source_order_id, status, grant_kind,
    grant_reference, granted_at, revoked_at, updated_at
  ) values (
    target_user_id, target_entitlement_key, null, effective_status, null,
    null, first_granted_at, effective_revoked_at, now()
  )
  on conflict (user_id, entitlement_key) do update
  set source_order_id = null,
      status = excluded.status,
      grant_kind = null,
      grant_reference = null,
      granted_at = excluded.granted_at,
      revoked_at = excluded.revoked_at,
      updated_at = now();
end;
$$;

revoke all on function private.refresh_commerce_entitlement(uuid, text)
from public, anon, authenticated;

create or replace function private.sync_legacy_commerce_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_kind_value text;
  source_reference_value text;
begin
  if new.grant_kind is null then
    return new;
  end if;

  if new.grant_kind = 'purchase' and new.source_order_id is not null then
    source_kind_value := 'portone';
    source_reference_value := 'order:' || new.source_order_id::text;
  elsif new.grant_kind = 'complimentary' and new.source_order_id is null then
    source_kind_value := 'complimentary';
    source_reference_value := coalesce(new.grant_reference, 'legacy-complimentary')
      || ':' || new.user_id::text || ':' || new.entitlement_key;
  else
    raise exception using errcode = '22023', message = 'invalid_legacy_commerce_grant';
  end if;

  insert into private.commerce_grants (
    user_id, entitlement_key, source_kind, source_reference,
    status, granted_at, revoked_at, updated_at
  ) values (
    new.user_id, new.entitlement_key, source_kind_value,
    source_reference_value, new.status, new.granted_at,
    new.revoked_at, now()
  )
  on conflict (source_kind, source_reference) do update
  set user_id = excluded.user_id,
      entitlement_key = excluded.entitlement_key,
      status = excluded.status,
      granted_at = excluded.granted_at,
      revoked_at = excluded.revoked_at,
      updated_at = now();

  perform private.refresh_commerce_entitlement(new.user_id, new.entitlement_key);
  return new;
end;
$$;

revoke all on function private.sync_legacy_commerce_grant()
from public, anon, authenticated;

create trigger commerce_entitlements_sync_legacy_grant
after insert or update of status, source_order_id, grant_kind, grant_reference
on public.commerce_entitlements
for each row
when (new.grant_kind is not null)
execute function private.sync_legacy_commerce_grant();

-- PortOne functions update the order before touching the legacy entitlement row.
-- Synchronize from the order so refunds still work after the public row becomes
-- a source-agnostic projection.
create or replace function private.sync_portone_order_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_entitlement_key text;
  target_character_id text;
  grant_status text;
  grant_revoked_at timestamptz;
begin
  if new.user_id is null or new.status not in ('approved', 'refunded') then
    return new;
  end if;

  if new.status = 'approved'
     and (new.policy_version is null
       or new.policy_notice is null
       or new.policy_consented_at is null) then
    raise exception using errcode = '42501', message = 'payment_policy_consent_required';
  end if;

  select products.entitlement_key, products.character_id
  into target_entitlement_key, target_character_id
  from public.commerce_products products
  where products.id = new.product_id;

  grant_status := case when new.status = 'approved' then 'active' else 'refunded' end;
  grant_revoked_at := case when grant_status = 'active' then null
                           else coalesce(new.refunded_at, now()) end;

  insert into private.commerce_grants (
    user_id, entitlement_key, source_kind, source_reference,
    status, granted_at, revoked_at, updated_at
  ) values (
    new.user_id, target_entitlement_key, 'portone', 'order:' || new.id::text,
    grant_status, coalesce(new.approved_at, now()), grant_revoked_at, now()
  )
  on conflict (source_kind, source_reference) do update
  set user_id = excluded.user_id,
      entitlement_key = excluded.entitlement_key,
      status = excluded.status,
      revoked_at = excluded.revoked_at,
      updated_at = now();

  perform private.refresh_commerce_entitlement(new.user_id, target_entitlement_key);

  if grant_status != 'active' and not exists (
    select 1 from private.commerce_grants grants
    where grants.user_id = new.user_id
      and grants.entitlement_key = target_entitlement_key
      and grants.status = 'active'
  ) then
    update public.profiles
    set character_id = 'pixel_hamster', updated_at = now()
    where id = new.user_id and character_id = target_character_id;
  end if;

  return new;
end;
$$;

revoke all on function private.sync_portone_order_grant()
from public, anon, authenticated;

create trigger commerce_orders_sync_portone_grant
after insert or update of status, approved_at, refunded_at
on public.commerce_orders
for each row
when (new.status in ('approved', 'refunded'))
execute function private.sync_portone_order_grant();

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
  p_signed_data_sha256_hex text
)
returns table (entitlement_key text, entitlement_status text, binding_state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing_transaction private.app_store_transactions;
  target_user_id uuid;
  target_entitlement_key text;
  target_character_id text;
begin
  if p_environment not in ('Sandbox', 'Production')
     or p_status not in ('active', 'refunded', 'revoked')
     or char_length(coalesce(p_transaction_id, '')) not between 1 and 128
     or char_length(coalesce(p_original_transaction_id, '')) not between 1 and 128
     or p_signed_data_sha256_hex !~ '^[0-9a-f]{64}$'
     or (p_status = 'active' and p_revoked_at is not null)
     or (p_status != 'active' and p_revoked_at is null) then
    raise exception using errcode = '22023', message = 'invalid_app_store_transaction';
  end if;

  select products.entitlement_key, products.character_id
  into target_entitlement_key, target_character_id
  from public.commerce_products products
  where products.id = p_product_id and products.active is true;
  if target_entitlement_key is null then
    raise exception using errcode = '22023', message = 'unknown_app_store_product';
  end if;

  select * into existing_transaction
  from private.app_store_transactions transactions
  where transactions.transaction_id = p_transaction_id
  for update;

  if found and p_signed_at < existing_transaction.signed_at then
    return query
    select target_entitlement_key,
           existing_transaction.status,
           existing_transaction.binding_state;
    return;
  end if;

  if existing_transaction.transaction_id is not null
     and existing_transaction.user_id is not null
     and p_user_id is not null
     and existing_transaction.user_id != p_user_id then
    raise exception using errcode = '23505', message = 'app_store_transaction_already_bound';
  end if;

  target_user_id := coalesce(existing_transaction.user_id, p_user_id);
  if existing_transaction.transaction_id is null
     and target_user_id is not null
     and p_app_account_token is distinct from target_user_id then
    raise exception using errcode = '42501', message = 'app_account_token_mismatch';
  end if;

  insert into private.app_store_transactions (
    transaction_id, original_transaction_id, product_id, user_id,
    app_account_token, environment, status, binding_state, purchased_at,
    revoked_at, signed_at, signed_data_sha256, updated_at
  ) values (
    p_transaction_id, p_original_transaction_id, p_product_id, target_user_id,
    p_app_account_token, p_environment, p_status,
    case when target_user_id is null then 'unbound' else 'bound' end,
    p_purchased_at, p_revoked_at, p_signed_at,
    decode(p_signed_data_sha256_hex, 'hex'), now()
  )
  on conflict (transaction_id) do update
  set original_transaction_id = excluded.original_transaction_id,
      product_id = excluded.product_id,
      user_id = excluded.user_id,
      app_account_token = coalesce(private.app_store_transactions.app_account_token,
                                   excluded.app_account_token),
      environment = excluded.environment,
      status = excluded.status,
      binding_state = excluded.binding_state,
      purchased_at = excluded.purchased_at,
      revoked_at = excluded.revoked_at,
      signed_at = excluded.signed_at,
      signed_data_sha256 = excluded.signed_data_sha256,
      updated_at = now();

  if target_user_id is not null then
    insert into private.commerce_grants (
      user_id, entitlement_key, source_kind, source_reference,
      status, granted_at, revoked_at, updated_at
    ) values (
      target_user_id, target_entitlement_key, 'app_store',
      'transaction:' || p_transaction_id, p_status, p_purchased_at,
      p_revoked_at, now()
    )
    on conflict (source_kind, source_reference) do update
    set user_id = excluded.user_id,
        entitlement_key = excluded.entitlement_key,
        status = excluded.status,
        granted_at = excluded.granted_at,
        revoked_at = excluded.revoked_at,
        updated_at = now();

    perform private.refresh_commerce_entitlement(target_user_id, target_entitlement_key);

    if p_status != 'active' and not exists (
      select 1 from private.commerce_grants grants
      where grants.user_id = target_user_id
        and grants.entitlement_key = target_entitlement_key
        and grants.status = 'active'
    ) then
      update public.profiles
      set character_id = 'pixel_hamster', updated_at = now()
      where id = target_user_id and character_id = target_character_id;
    end if;
  end if;

  return query
  select target_entitlement_key,
         p_status,
         case when target_user_id is null then 'unbound' else 'bound' end;
end;
$$;

revoke all on function public.admin_apply_app_store_transaction(
  uuid, text, text, text, uuid, text, text, timestamptz, timestamptz,
  timestamptz, text
) from public, anon, authenticated;
grant execute on function public.admin_apply_app_store_transaction(
  uuid, text, text, text, uuid, text, text, timestamptz, timestamptz,
  timestamptz, text
) to service_role;

create or replace function public.admin_record_app_store_notification(
  p_notification_uuid uuid,
  p_notification_type text,
  p_environment text,
  p_transaction_id text,
  p_signed_at timestamptz,
  p_payload_sha256_hex text,
  p_processing_status text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted boolean;
begin
  if p_environment not in ('Sandbox', 'Production')
     or p_processing_status not in ('processed', 'ignored')
     or char_length(coalesce(p_notification_type, '')) not between 1 and 100
     or p_payload_sha256_hex !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_app_store_notification';
  end if;

  insert into private.app_store_notification_events (
    notification_uuid, notification_type, environment, transaction_id,
    signed_at, payload_sha256, processing_status, processed_at
  ) values (
    p_notification_uuid, p_notification_type, p_environment, p_transaction_id,
    p_signed_at, decode(p_payload_sha256_hex, 'hex'), p_processing_status, now()
  ) on conflict (notification_uuid) do nothing;
  inserted := found;
  return inserted;
end;
$$;

revoke all on function public.admin_record_app_store_notification(
  uuid, text, text, text, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.admin_record_app_store_notification(
  uuid, text, text, text, timestamptz, text, text
) to service_role;

-- Make auth deletion atomic with room ownership transfer and commerce unlinking.
create or replace function private.prepare_user_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  owned_room_id uuid;
  next_owner_id uuid;
begin
  for owned_room_id in
    select rooms.id from public.rooms rooms
    where rooms.owner_id = old.id
    order by rooms.created_at, rooms.id
    for update
  loop
    select members.user_id into next_owner_id
    from public.room_members members
    where members.room_id = owned_room_id
      and members.user_id != old.id
    order by members.joined_at, members.user_id
    limit 1;

    if next_owner_id is null then
      delete from public.rooms where id = owned_room_id;
    else
      update public.rooms set owner_id = next_owner_id
      where id = owned_room_id;
    end if;
  end loop;

  delete from public.room_members where user_id = old.id;
  delete from public.commerce_entitlements where user_id = old.id;
  update public.commerce_orders set user_id = null where user_id = old.id;
  update private.commerce_grants
  set user_id = null,
      status = case when status = 'active' then 'revoked' else status end,
      revoked_at = case when status = 'active' then now() else revoked_at end,
      updated_at = now()
  where user_id = old.id;
  update private.app_store_transactions
  set user_id = null, binding_state = 'unbound', updated_at = now()
  where user_id = old.id;

  return old;
end;
$$;

revoke all on function private.prepare_user_deletion()
from public, anon, authenticated;

drop trigger if exists sidey_prepare_user_deletion on auth.users;
create trigger sidey_prepare_user_deletion
before delete on auth.users
for each row execute function private.prepare_user_deletion();

create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  delete from auth.users where id = current_user_id;
end;
$$;

revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
