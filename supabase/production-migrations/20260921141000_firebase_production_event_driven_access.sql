begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- Only Firebase-bootstrapped users are tracked. No FK: deletion must leave a
-- versioned tombstone until the Firebase mirror has been revoked.
create table private.firebase_access_outbox (
  user_id uuid primary key,
  revision bigint not null default 1 check (revision > 0),
  pending_since timestamptz,
  reconcile_requested boolean not null default false,
  delivered_revision bigint not null default 0,
  delivered_at timestamptz
);
alter table private.firebase_access_outbox enable row level security;
revoke all on private.firebase_access_outbox from public, anon, authenticated, service_role;
create index firebase_access_outbox_pending
  on private.firebase_access_outbox(pending_since nulls last, user_id)
  where pending_since is not null or reconcile_requested;

create table private.firebase_access_dispatch (
  singleton boolean primary key default true check (singleton),
  wake_url text check (wake_url ~ '^https://[A-Za-z0-9.-]+(/[^[:space:]]*)?$'),
  last_reconcile_date date
);
insert into private.firebase_access_dispatch(singleton) values (true);
alter table private.firebase_access_dispatch enable row level security;
revoke all on private.firebase_access_dispatch from public, anon, authenticated, service_role;

create function private.wake_firebase_access()
returns trigger language plpgsql security definer set search_path = '' as $$
declare endpoint text; wake_secret text;
begin
  if current_setting('sidey.access_reconciling', true) = 'on' then return null; end if;
  select wake_url into endpoint from private.firebase_access_dispatch where singleton;
  if endpoint is null then return null; end if;
  -- Optional low-latency wake; the durable outbox + scheduler are the fallback.
  -- Secret is provisioned separately in Vault, never in migration history.
  begin
    select decrypted_secret into wake_secret from vault.decrypted_secrets
    where name = 'sidey_access_wake_token';
    if length(wake_secret) >= 32 then
      perform net.http_post(
        url := endpoint,
        headers := jsonb_build_object('Content-Type', 'application/json',
                                     'Authorization', 'Bearer ' || wake_secret),
        body := '{}'::jsonb,
        timeout_milliseconds := 1000
      );
    end if;
  exception when others then
    -- Do not roll back a purchase/refund/kick if the wake mechanism is down.
    -- Do not log request headers or decrypted secrets.
    raise warning 'firebase_access_wake_failed';
  end;
  return null;
end;
$$;
revoke all on function private.wake_firebase_access() from public, anon, authenticated, service_role;
create trigger firebase_access_wake after insert or update of revision
  on private.firebase_access_outbox for each row execute function private.wake_firebase_access();

create function private.enqueue_firebase_access(p_user_id uuid)
returns void language sql security definer set search_path = '' as $$
  update private.firebase_access_outbox
  set revision = revision + 1,
      pending_since = coalesce(pending_since, clock_timestamp())
  where user_id = p_user_id;
$$;
revoke all on function private.enqueue_firebase_access(uuid) from public, anon, authenticated, service_role;

create function private.capture_firebase_access()
returns trigger language plpgsql security definer set search_path = '' as $$
declare old_uid uuid; new_uid uuid; uid uuid;
begin
  if tg_table_name in ('profiles', 'users') then
    if tg_op <> 'INSERT' then old_uid := old.id; end if;
    if tg_op <> 'DELETE' then new_uid := new.id; end if;
  else
    if tg_op <> 'INSERT' then old_uid := old.user_id; end if;
    if tg_op <> 'DELETE' then new_uid := new.user_id; end if;
  end if;
  for uid in select distinct id from unnest(array[old_uid, new_uid]) id
             where id is not null order by id loop
    perform private.enqueue_firebase_access(uid);
  end loop;
  return null;
end;
$$;
revoke all on function private.capture_firebase_access() from public, anon, authenticated, service_role;

create trigger firebase_access_membership after insert or update or delete on public.room_members
  for each row execute function private.capture_firebase_access();
create trigger firebase_access_entitlement after insert or delete on public.commerce_entitlements
  for each row execute function private.capture_firebase_access();
create trigger firebase_access_entitlement_update after update on public.commerce_entitlements
  for each row when (old.user_id is distinct from new.user_id
    or old.entitlement_key is distinct from new.entitlement_key or old.status is distinct from new.status)
  execute function private.capture_firebase_access();
create trigger firebase_access_equipment after update on public.profiles
  for each row when (old.equipped_throwable_id is distinct from new.equipped_throwable_id)
  execute function private.capture_firebase_access();
create trigger firebase_access_profile_deleted after delete on public.profiles
  for each row execute function private.capture_firebase_access();
create trigger firebase_access_account_deleted after delete on auth.users
  for each row execute function private.capture_firebase_access();
create trigger firebase_access_account_banned after update on auth.users
  for each row when (old.banned_until is distinct from new.banned_until)
  execute function private.capture_firebase_access();
create trigger firebase_access_session after insert or delete on auth.sessions
  for each row execute function private.capture_firebase_access();
-- Ordinary token refresh updates must NOT wake the permissions worker.
create trigger firebase_access_session_expiry after update on auth.sessions
  for each row when (old.not_after is distinct from new.not_after or old.user_id is distinct from new.user_id)
  execute function private.capture_firebase_access();

create function private.capture_firebase_product_access()
returns trigger language plpgsql security definer set search_path = '' as $$
declare uid uuid;
begin
  for uid in
    select distinct e.user_id from public.commerce_entitlements e
    join private.firebase_access_outbox o on o.user_id = e.user_id
    where e.entitlement_key in (old.entitlement_key, new.entitlement_key)
    order by e.user_id
  loop perform private.enqueue_firebase_access(uid); end loop;
  return null;
end;
$$;
revoke all on function private.capture_firebase_product_access() from public, anon, authenticated, service_role;
create trigger firebase_access_product after update on public.commerce_products
  for each row when (old.active is distinct from new.active
    or old.entitlement_key is distinct from new.entitlement_key
    or old.catalog_item_id is distinct from new.catalog_item_id
    or old.product_kind is distinct from new.product_kind)
  execute function private.capture_firebase_product_access();
create trigger firebase_access_product_deleted after delete on public.commerce_products
  for each row execute function private.capture_firebase_product_access();

-- One transaction locks the revision and reads authoritative state. Concurrent
-- source changes increment that same row before their own transaction commits.
create function public.firebase_access_snapshot(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare rev bigint; enabled boolean; snapshot jsonb; session_map jsonb;
begin
  if p_user_id is null then raise exception 'invalid_user_id'; end if;
  insert into private.firebase_access_outbox(user_id, pending_since)
  values (p_user_id, clock_timestamp()) on conflict (user_id) do nothing;
  select revision into rev from private.firebase_access_outbox where user_id = p_user_id for update;
  select exists(select 1 from auth.users u where u.id = p_user_id
    and (u.banned_until is null or u.banned_until <= clock_timestamp())) into enabled;
  snapshot := jsonb_build_object('user_id', p_user_id, 'rooms', '[]'::jsonb, 'items', '[]'::jsonb);
  session_map := '{}'::jsonb;
  if enabled then
    snapshot := public.firebase_realtime_access(p_user_id);
    select coalesce(jsonb_object_agg(s.id::text,
      case when s.not_after is null then 8640000000000000::bigint
           else floor(extract(epoch from s.not_after) * 1000)::bigint end), '{}'::jsonb)
    into session_map from auth.sessions s where s.user_id = p_user_id
      and (s.not_after is null or s.not_after > clock_timestamp());
  end if;
  return snapshot || jsonb_build_object('revision', lpad(rev::text, 20, '0'),
    'active', enabled, 'sessions', session_map);
end;
$$;

create function public.firebase_access_pending(p_limit integer default 100)
returns table(user_id uuid) language sql stable security definer set search_path = '' as $$
  select o.user_id from private.firebase_access_outbox o
  where o.pending_since is not null or o.reconcile_requested
  order by o.pending_since nulls last, o.user_id
  limit greatest(1, least(coalesce(p_limit, 100), 100));
$$;

create function public.firebase_access_ack(p_user_id uuid, p_revision text)
returns void language sql security definer set search_path = '' as $$
  update private.firebase_access_outbox
  set delivered_revision = revision, delivered_at = clock_timestamp(),
      pending_since = null, reconcile_requested = false
  where user_id = p_user_id and lpad(revision::text, 20, '0') = p_revision;
$$;

create function public.firebase_access_status()
returns jsonb language sql volatile security definer set search_path = '' as $$
  select jsonb_build_object(
    'checked_at', floor(extract(epoch from statement_timestamp()) * 1000)::bigint,
    'oldest_pending_at', floor(extract(epoch from min(pending_since)) * 1000)::bigint
  ) from private.firebase_access_outbox where pending_since is not null;
$$;

create function public.firebase_access_reconcile()
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- Duplicate Cloud Scheduler deliveries must not restart the whole sweep.
  update private.firebase_access_dispatch
  set last_reconcile_date = (clock_timestamp() at time zone 'Asia/Seoul')::date
  where singleton and last_reconcile_date is distinct from
    (clock_timestamp() at time zone 'Asia/Seoul')::date;
  if not found then return; end if;
  perform set_config('sidey.access_reconciling', 'on', true);
  update private.firebase_access_outbox
  set revision = revision + 1, reconcile_requested = true;
  -- Do not mark the sweep as an overdue security mutation. Actual changes have
  -- pending_since set by triggers and always take priority over reconciliation.
  perform set_config('sidey.access_reconciling', 'off', true);
end;
$$;

revoke all on function public.firebase_access_snapshot(uuid),
  public.firebase_access_pending(integer), public.firebase_access_ack(uuid,text),
  public.firebase_access_status(), public.firebase_access_reconcile()
  from public, anon, authenticated;
grant execute on function public.firebase_access_snapshot(uuid),
  public.firebase_access_pending(integer), public.firebase_access_ack(uuid,text),
  public.firebase_access_status(), public.firebase_access_reconcile() to service_role;

commit;
