begin;

-- The recovered live publisher was a staging-only experiment. Its original
-- migration intentionally pinned the staging project URL, but that must not
-- remain as a latent production egress target. Keep the experiment OFF and
-- require an operator-owned, environment-specific endpoint before it can be
-- enabled for an explicit validation run.
alter table private.firebase_live_dispatch_config
  add column publisher_url text,
  add constraint firebase_live_dispatch_publisher_url_check check (
    publisher_url is null
    or publisher_url ~ '^https://[a-z]{20}\.supabase\.co/functions/v1/realtime-publish-live$'
  );

create or replace function private.enqueue_firebase_live_dispatch(
  p_dispatch uuid,
  p_secret text
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  endpoint text;
  region text;
begin
  select config.publisher_url, config.edge_region
  into endpoint, region
  from private.firebase_live_dispatch_config as config
  where config.id;

  if endpoint is null then
    raise exception using
      errcode = 'P0001',
      message = 'firebase_dispatch_endpoint_unconfigured';
  end if;

  return net.http_post(
    url := endpoint,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || p_secret
    ) || case
      when region is null then '{}'::jsonb
      else jsonb_build_object('x-region', region)
    end,
    body := jsonb_build_object('dispatchId', p_dispatch),
    timeout_milliseconds := 25000
  );
end;
$$;

revoke all on function private.enqueue_firebase_live_dispatch(uuid, text)
  from public, anon, authenticated, service_role;

-- A revoked Supabase session rotates the Presence authorization epoch. Mixed
-- legacy/Firebase rooms still need the legacy structure_changed notification;
-- suppressing it strands an already-open legacy channel on the old epoch.
-- private.route_realtime keeps whole-room Firebase cohorts on their durable
-- control path, while non-live/mixed rooms receive the existing Broadcast.
create or replace function private.rotate_user_presence_epochs(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_room_id uuid;
begin
  if p_user_id is null or not exists (
    select 1
    from private.firebase_access_outbox as access_outbox
    where access_outbox.user_id = p_user_id
  ) then
    return;
  end if;

  for affected_room_id in
    select members.room_id
    from public.room_members as members
    where members.user_id = p_user_id
    order by members.room_id
  loop
    update public.rooms as rooms
    set realtime_epoch = rooms.realtime_epoch + 1
    where rooms.id = affected_room_id;

    perform private.enqueue_firebase_room_revision(affected_room_id);
  end loop;
end;
$$;

revoke all on function private.rotate_user_presence_epochs(uuid)
  from public, anon, authenticated, service_role;

-- Legacy RPC result shapes stay untouched. Firebase-aware clients use these
-- additive wrappers and receive the exact access revision created by the same
-- source transaction. The revision is then passed to bootstrapRealtime as the
-- minimum grant barrier before opening a new listener or throwable write.
create function private.firebase_access_revision_for_user(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  result text;
begin
  if p_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  insert into private.firebase_access_outbox as access_outbox(
    user_id,
    pending_since
  ) values (
    p_user_id,
    clock_timestamp()
  )
  on conflict (user_id) do update
  set pending_since = coalesce(
    access_outbox.pending_since,
    excluded.pending_since
  )
  returning lpad(revision::text, 20, '0') into result;

  return result;
end;
$$;

revoke all on function private.firebase_access_revision_for_user(uuid)
  from public, anon, authenticated, service_role;

create function public.create_room_v2(p_name text)
returns table (
  room_id uuid,
  invite_code text,
  "accessRevision" text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  created record;
  current_user_id uuid := auth.uid();
begin
  select * into created from public.create_room(p_name);
  return query select
    created.room_id,
    created.invite_code,
    private.firebase_access_revision_for_user(current_user_id);
end;
$$;

create function public.join_room_v2(p_invite_code text)
returns table (
  room_id uuid,
  error_code text,
  "accessRevision" text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  joined record;
  current_user_id uuid := auth.uid();
begin
  select * into joined from public.join_room(p_invite_code);
  return query select
    joined.room_id,
    joined.error_code,
    case
      when joined.room_id is null then null
      else private.firebase_access_revision_for_user(current_user_id)
    end;
end;
$$;

create function public.set_equipped_cosmetic_v2(
  p_product_kind text,
  p_catalog_item_id text
)
returns table (
  profile jsonb,
  "accessRevision" text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_profile public.profiles;
  current_user_id uuid := auth.uid();
begin
  saved_profile := public.set_equipped_cosmetic(
    p_product_kind,
    p_catalog_item_id
  );
  return query select
    to_jsonb(saved_profile),
    private.firebase_access_revision_for_user(current_user_id);
end;
$$;

create function public.current_firebase_access_revision()
returns text
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
  return private.firebase_access_revision_for_user(current_user_id);
end;
$$;

create function public.get_store_state_v2()
returns table (
  product_id text,
  display_name text,
  product_description text,
  product_kind text,
  catalog_item_id text,
  character_id text,
  entitlement_key text,
  sort_order integer,
  amount_krw integer,
  currency text,
  tax_inclusive boolean,
  google_connected boolean,
  entitlement_status text,
  latest_order_status text,
  is_equipped boolean,
  "wireCode" integer
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
         products.product_kind,
         products.catalog_item_id,
         products.character_id,
         products.entitlement_key,
         products.sort_order,
         prices.amount_krw,
         prices.currency,
         prices.tax_inclusive,
         private.has_google_identity(current_user_id),
         (select entitlements.status
          from public.commerce_entitlements as entitlements
          where entitlements.user_id = current_user_id
            and entitlements.entitlement_key = products.entitlement_key),
         (select orders.status
          from public.commerce_orders as orders
          where orders.user_id = current_user_id
            and orders.product_id = products.id
          order by orders.created_at desc
          limit 1),
         coalesce(
           case products.product_kind
             when 'bubble' then products.catalog_item_id = profiles.equipped_bubble_style_id
             when 'throwable' then products.catalog_item_id = profiles.equipped_throwable_id
             when 'character' then products.catalog_item_id = profiles.character_id
             else false
           end,
           false
         ),
         products.wire_code
  from public.commerce_products as products
  join public.commerce_prices as prices
    on prices.product_id = products.id and prices.active is true
  left join public.profiles as profiles on profiles.id = current_user_id
  where products.active is true
  order by products.sort_order, products.id;
end;
$$;

revoke all on function public.create_room_v2(text),
  public.join_room_v2(text),
  public.set_equipped_cosmetic_v2(text, text),
  public.current_firebase_access_revision(),
  public.get_store_state_v2()
  from public, anon;
grant execute on function public.create_room_v2(text),
  public.join_room_v2(text),
  public.set_equipped_cosmetic_v2(text, text),
  public.current_firebase_access_revision(),
  public.get_store_state_v2()
  to authenticated;

commit;
