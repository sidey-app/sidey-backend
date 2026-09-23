begin;
set local lock_timeout = '5s';
set local statement_timeout = '1min';

-- A legacy Supabase-only member never bootstraps Firebase, so the target's
-- /v2/a/u mirror is not a valid authorization source for a hybrid sender.
-- Mirror the authoritative room roster in the *sender's* existing access
-- grant instead. Rules still require both participants to be room members.
create or replace function public.firebase_realtime_access(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  room_ids jsonb;
  room_targets jsonb;
  throwable_ids jsonb;
  throwable_wire_codes jsonb;
begin
  if p_user_id is null or not exists (
    select 1 from auth.users as users where users.id = p_user_id
  ) then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select coalesce(jsonb_agg(members.room_id order by members.room_id), '[]'::jsonb)
  into room_ids
  from public.room_members as members
  where members.user_id = p_user_id;

  select coalesce(jsonb_object_agg(roster.room_id::text, roster.targets), '{}'::jsonb)
  into room_targets
  from (
    select own.room_id,
           jsonb_object_agg(peer.user_id::text, true order by peer.user_id) as targets
    from public.room_members as own
    join public.room_members as peer on peer.room_id = own.room_id
      and peer.user_id <> p_user_id
    join auth.users as users on users.id = peer.user_id
      and (users.banned_until is null or users.banned_until <= now())
    where own.user_id = p_user_id
    group by own.room_id
  ) as roster;

  select
    coalesce(jsonb_agg(products.catalog_item_id order by products.catalog_item_id), '[]'::jsonb),
    coalesce(jsonb_agg(products.wire_code::text order by products.wire_code), '["0"]'::jsonb)
  into throwable_ids, throwable_wire_codes
  from public.profiles as profiles
  join public.commerce_products as products
    on products.product_kind = 'throwable'
   and products.catalog_item_id = profiles.equipped_throwable_id
   and products.active is true
  join public.commerce_entitlements as entitlements
    on entitlements.user_id = profiles.id
   and entitlements.entitlement_key = products.entitlement_key
   and entitlements.status = 'active'
  where profiles.id = p_user_id;

  if jsonb_array_length(throwable_wire_codes) = 0 then
    throwable_wire_codes := '["0"]'::jsonb;
  end if;

  return jsonb_build_object(
    'user_id', p_user_id,
    'rooms', room_ids,
    'room_targets', room_targets,
    'items', throwable_ids,
    'wire_items', throwable_wire_codes
  );
end;
$$;
revoke all on function public.firebase_realtime_access(uuid)
  from public, anon, authenticated;
grant execute on function public.firebase_realtime_access(uuid) to service_role;

-- Membership mutations must refresh every Firebase sender in the affected
-- room, including a sender whose own membership row did not change. Keep the
-- old trigger name and lock tracked user rows in UUID order.
create function private.capture_firebase_room_target_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  tracked_user_id uuid;
  old_user_id uuid;
  new_user_id uuid;
  old_room_id uuid;
  new_room_id uuid;
begin
  if tg_op <> 'INSERT' then
    old_user_id := old.user_id;
    old_room_id := old.room_id;
  end if;
  if tg_op <> 'DELETE' then
    new_user_id := new.user_id;
    new_room_id := new.room_id;
  end if;
  for tracked_user_id in
    select distinct access_outbox.user_id
    from private.firebase_access_outbox as access_outbox
    where access_outbox.user_id in (old_user_id, new_user_id)
       or exists (
         select 1
         from public.room_members as members
         where members.user_id = access_outbox.user_id
           and members.room_id in (old_room_id, new_room_id)
       )
    order by access_outbox.user_id
  loop
    perform private.enqueue_firebase_access(tracked_user_id);
  end loop;
  return null;
end;
$$;
revoke all on function private.capture_firebase_room_target_access()
  from public, anon, authenticated, service_role;
drop trigger firebase_access_membership on public.room_members;
create trigger firebase_access_membership
after insert or update or delete on public.room_members
for each row execute function private.capture_firebase_room_target_access();

-- Banning/unbanning a legacy target changes the sender's eligible roster.
create function private.capture_firebase_target_ban_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  tracked_user_id uuid;
begin
  for tracked_user_id in
    select distinct access_outbox.user_id
    from private.firebase_access_outbox as access_outbox
    where access_outbox.user_id = new.id
       or exists (
         select 1
         from public.room_members as target_membership
         join public.room_members as peer
           on peer.room_id = target_membership.room_id
         where target_membership.user_id = new.id
           and peer.user_id = access_outbox.user_id
       )
    order by access_outbox.user_id
  loop
    perform private.enqueue_firebase_access(tracked_user_id);
  end loop;
  return null;
end;
$$;
revoke all on function private.capture_firebase_target_ban_access()
  from public, anon, authenticated, service_role;
drop trigger firebase_access_account_banned on auth.users;
create trigger firebase_access_account_banned
after update of banned_until on auth.users
for each row when (old.banned_until is distinct from new.banned_until)
execute function private.capture_firebase_target_ban_access();

-- Functions must be deployed first. This revision bump then backfills the
-- sender rosters through the existing outbox. Wait for access delivery to
-- converge before deploying the new Rules predicate.
update private.firebase_access_outbox
set revision = revision + 1,
    pending_since = coalesce(pending_since, clock_timestamp());

-- A second wake must not settle an expired publication while its first worker
-- still holds the claim. The 90-second claim exceeds the 60-second Function
-- deadline; a truly abandoned claim is settled on a later pass.
create or replace function public.claim_firebase_transient_publications(
  p_worker uuid,
  p_limit integer default 100
)
returns table(
  id bigint,
  event_id uuid,
  room_id uuid,
  actor_id uuid,
  session_id uuid,
  kind text,
  target_user_id uuid,
  wire_code text,
  occurred_at_ms bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid_transient_claim';
  end if;

  update private.firebase_transient_publish_outbox as outbox
  set delivered_at = coalesce(outbox.delivered_at, clock_timestamp()),
      claimed_by = null,
      claim_until = null
  where outbox.delivered_at is null
    and (outbox.claim_until is null or outbox.claim_until <= clock_timestamp())
    and (
      outbox.occurred_at < clock_timestamp() - interval '5 seconds'
      or not exists (
        select 1 from private.firebase_transient_bridge_config as bridge
        where bridge.singleton and bridge.enabled
      )
      or not exists (
        select 1 from private.firebase_client_rollout_config as rollout
        where rollout.id and rollout.enabled and not rollout.kill_switch
          and rollout.cohort_basis_points > 0
      )
      or not exists (
        select 1 from public.rooms as rooms
        join public.room_members as actors
          on actors.room_id = rooms.id and actors.user_id = outbox.actor_id
        where rooms.id = outbox.room_id and rooms.realtime_epoch = outbox.epoch
      )
    );

  return query
  with candidates as (
    select outbox.id
    from private.firebase_transient_publish_outbox as outbox
    where outbox.delivered_at is null
      and (outbox.claim_until is null or outbox.claim_until <= clock_timestamp())
    order by outbox.occurred_at, outbox.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update private.firebase_transient_publish_outbox as outbox
    set claimed_by = p_worker,
        claim_until = clock_timestamp() + interval '90 seconds',
        attempts = outbox.attempts + 1
    from candidates
    where outbox.id = candidates.id
    returning outbox.*
  )
  select claimed.id,
         claimed.event_id,
         claimed.room_id,
         claimed.actor_id,
         claimed.session_id,
         claimed.kind,
         claimed.target_user_id,
         claimed.wire_code,
         floor(extract(epoch from claimed.occurred_at) * 1000)::bigint
  from claimed order by claimed.occurred_at, claimed.id;
end;
$$;

-- The HTTP wake must have enough time to complete a warm worker RPC round
-- trip. pg_net starts only after commit, so this does not block legacy RPCs.
create or replace function private.wake_firebase_transient_publication()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint text;
  wake_secret text;
begin
  select config.wake_url into endpoint
  from private.firebase_transient_bridge_config as config
  where config.singleton and config.enabled;
  if endpoint is null then return null; end if;
  begin
    select decrypted_secret into wake_secret
    from vault.decrypted_secrets
    where name = 'sidey_transient_wake_token';
    if length(wake_secret) >= 32 then
      perform net.http_post(
        url := endpoint,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'X-Sidey-Wake-Token', wake_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 5000
      );
    end if;
  exception when others then
    raise warning 'firebase_transient_wake_failed';
  end;
  return null;
end;
$$;
revoke all on function private.wake_firebase_transient_publication()
  from public, anon, authenticated, service_role;

commit;
