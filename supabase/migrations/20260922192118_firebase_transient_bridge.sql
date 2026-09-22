begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- The previous contract was observed live at 100%. Applying a contract hash
-- change while sessions still hold old five-minute rollout leases would split
-- behavior. Force the operator to complete the documented fail-closed disable
-- and read-back before this forward migration can start.
do $$
begin
  if not exists (
    select 1 from private.firebase_client_rollout_config as rollout
    where rollout.id
      and not rollout.enabled
      and rollout.kill_switch
      and rollout.cohort_basis_points = 0
  ) then
    raise exception using
      errcode = '55000',
      message = 'disable_old_firebase_rollout_before_transient_bridge_migration';
  end if;
end;
$$;

update private.firebase_client_rollout_config
set contract_hash = '0f2845d033df248b1745c6526c8c7100b8d8fa6839b45f28c73b1023053fce2e',
    updated_at = clock_timestamp()
where id;

-- Presence remains on Supabase. This switch owns only typing/pulse/throw
-- compatibility. It starts armed while the independent client selector and
-- Firebase global gate remain OFF. Operators may later disable both bridge
-- directions without an app release; there is deliberately no timed cutoff.
create table private.firebase_transient_bridge_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default true,
  wake_url text check (
    wake_url is null or wake_url ~
      '^https://asia-southeast1-sidey-realtime\.cloudfunctions\.net/syncRealtimeTransients$'
  ),
  updated_at timestamptz not null default clock_timestamp()
);
insert into private.firebase_transient_bridge_config(singleton) values (true);
alter table private.firebase_transient_bridge_config enable row level security;
revoke all on private.firebase_transient_bridge_config
  from public, anon, authenticated, service_role;

-- Old client -> Firebase. A durable outbox makes the optional wake a latency
-- optimization only. Event UUID plus monotonic compact timestamps make every
-- remote retry idempotent and prevent an old claim from replacing a newer slot.
create table private.firebase_transient_publish_outbox (
  id bigint generated always as identity primary key,
  event_id uuid not null unique,
  room_id uuid not null,
  epoch bigint not null check (epoch > 0),
  actor_id uuid not null,
  session_id uuid,
  kind text not null check (
    kind in ('typing_start', 'typing_stop', 'character_pulse', 'character_throw')
  ),
  target_user_id uuid,
  wire_code text,
  occurred_at timestamptz not null default clock_timestamp(),
  claimed_by uuid,
  claim_until timestamptz,
  delivered_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  check ((claimed_by is null) = (claim_until is null)),
  check (session_id is not null),
  check (
    (kind = 'character_throw'
      and target_user_id is not null
      and target_user_id <> actor_id
      and wire_code ~ '^(0|[1-9][0-9]{0,5})$')
    or (kind <> 'character_throw' and target_user_id is null and wire_code is null)
  )
);
create index firebase_transient_publish_pending
  on private.firebase_transient_publish_outbox(occurred_at, id)
  where delivered_at is null;
create index firebase_transient_publish_retention
  on private.firebase_transient_publish_outbox(delivered_at, id)
  where delivered_at is not null;
alter table private.firebase_transient_publish_outbox enable row level security;
revoke all on private.firebase_transient_publish_outbox
  from public, anon, authenticated, service_role;
revoke all on sequence private.firebase_transient_publish_outbox_id_seq
  from public, anon, authenticated, service_role;

-- Firebase -> old client. Keep only retry/deduplication metadata, never message
-- bodies or transient history. Eight days exceeds the compatibility observation
-- minimum and the trigger retry horizon used by this deployment.
create table private.firebase_transient_bridge_events (
  event_id uuid primary key,
  room_id uuid not null,
  actor_id uuid not null,
  session_id uuid,
  kind text not null check (
    kind in ('typing_start', 'typing_stop', 'character_pulse', 'character_throw')
  ),
  target_user_id uuid,
  wire_code text,
  occurred_at timestamptz not null,
  accepted_at timestamptz not null default clock_timestamp(),
  legacy_delivered boolean not null,
  check (
    (kind in ('typing_start', 'typing_stop') and session_id is not null)
    or (kind not in ('typing_start', 'typing_stop') and session_id is null)
  ),
  check (
    (kind = 'character_throw'
      and target_user_id is not null
      and target_user_id <> actor_id
      and wire_code ~ '^(0|[1-9][0-9]{0,5})$')
    or (kind <> 'character_throw' and target_user_id is null and wire_code is null)
  )
);
create index firebase_transient_bridge_events_retention
  on private.firebase_transient_bridge_events(accepted_at);
alter table private.firebase_transient_bridge_events enable row level security;
revoke all on private.firebase_transient_bridge_events
  from public, anon, authenticated, service_role;

create function private.current_throwable_wire(p_user_id uuid)
returns table(wire_code text, render_asset_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(products.wire_code::text, '0'),
         coalesce(products.render_asset_id, 'patch_soft_ball')
  from (select 1) as singleton
  left join public.profiles as profiles on profiles.id = p_user_id
  left join public.commerce_products as products
    on products.product_kind = 'throwable'
   and products.catalog_item_id =
     private.owned_equipped_catalog_item(p_user_id, 'throwable')
   and products.active is true
$$;
revoke all on function private.current_throwable_wire(uuid)
  from public, anon, authenticated, service_role;

create function private.enqueue_firebase_transient_publication(
  p_payload jsonb,
  p_event text,
  p_room_id uuid,
  p_epoch bigint
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_event_id uuid;
  actor uuid;
  source_session uuid;
  target uuid;
  source_wire text;
  existing private.firebase_transient_publish_outbox;
begin
  if p_event not in (
    'typing_start', 'typing_stop', 'character_pulse', 'character_throw'
  ) then return; end if;

  begin
    source_event_id := nullif(p_payload->>'event_id', '')::uuid;
    actor := nullif(coalesce(p_payload->>'actor_user_id', p_payload->>'user_id'), '')::uuid;
    source_session := nullif(p_payload->>'session_id', '')::uuid;
    target := nullif(p_payload->>'target_user_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '22023', message = 'invalid_realtime_event';
  end;
  if source_event_id is null then source_event_id := gen_random_uuid(); end if;
  if actor is null
     or source_session is null
     or (p_event = 'character_throw' and (target is null or target = actor))
     or (p_event <> 'character_throw' and target is not null) then
    raise exception using errcode = '22023', message = 'invalid_realtime_event';
  end if;

  source_wire := case when p_event = 'character_throw'
    then nullif(p_payload->>'wire_code', '') else null end;
  if p_event = 'character_throw'
     and (source_wire is null or source_wire !~ '^(0|[1-9][0-9]{0,5})$') then
    raise exception using errcode = '22023', message = 'invalid_realtime_event';
  end if;

  insert into private.firebase_transient_publish_outbox(
    event_id, room_id, epoch, actor_id, session_id, kind,
    target_user_id, wire_code
  ) values (
    source_event_id, p_room_id, p_epoch, actor, source_session, p_event,
    target, source_wire
  ) on conflict (event_id) do nothing;
  if not found then
    select * into strict existing
    from private.firebase_transient_publish_outbox as outbox
    where outbox.event_id = source_event_id;
    if existing.room_id is distinct from p_room_id
       or existing.epoch is distinct from p_epoch
       or existing.actor_id is distinct from actor
       or existing.session_id is distinct from source_session
       or existing.kind is distinct from p_event
       or existing.target_user_id is distinct from target
       or existing.wire_code is distinct from source_wire then
      raise exception using errcode = '23505', message = 'event_id_conflict';
    end if;
  end if;
end;
$$;
revoke all on function private.enqueue_firebase_transient_publication(
  jsonb, text, uuid, bigint
) from public, anon, authenticated, service_role;

-- Preserve durable/structure behavior and the dormant historical staging
-- pipeline. Only transient Broadcast and compact mirroring obey the new bridge
-- switch. Firebase-origin calls use their service-only RPC below and therefore
-- never re-enter this router.
create or replace function private.route_realtime(
  p_payload jsonb,
  p_event text,
  p_topic text,
  p_private boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  rid uuid;
  ep bigint;
  live boolean;
  transient boolean;
  source_event_id uuid;
  bridge_enabled boolean;
  rollout_enabled boolean;
begin
  rid := split_part(p_topic, ':', 2)::uuid;
  ep := split_part(p_topic, ':', 3)::bigint;
  live := private.firebase_room_is_live(rid);
  transient := p_event in (
    'typing_start', 'typing_stop', 'character_pulse', 'character_throw'
  );
  select config.enabled into strict bridge_enabled
  from private.firebase_transient_bridge_config as config
  where config.singleton
  for share;
  select config.enabled and not config.kill_switch
         and config.cohort_basis_points > 0
  into strict rollout_enabled
  from private.firebase_client_rollout_config as config
  where config.id;

  if not transient or bridge_enabled then
    perform realtime.send(
      case
        when p_event = 'character_throw' then p_payload - array['wire_code', 'session_id']
        when p_event = 'character_pulse' then p_payload - 'session_id'
        else p_payload
      end,
      p_event, p_topic, p_private
    );
  end if;
  if transient and bridge_enabled and rollout_enabled then
    perform private.enqueue_firebase_transient_publication(
      p_payload, p_event, rid, ep
    );
  end if;

  if live or (
    p_event = 'structure_changed'
    and exists (
      select 1 from private.firebase_live_rooms where room_id = rid
    )
  ) then
    if transient
       and coalesce(p_payload->>'event_id', '')
         ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      source_event_id := (p_payload->>'event_id')::uuid;
    end if;
    insert into private.firebase_live_outbox(
      event_id, room_id, epoch, kind, payload, publication_revision
    ) values (
      coalesce(source_event_id, gen_random_uuid()), rid, ep,
      case when live then p_event else 'control' end,
      p_payload,
      case when live and transient
        then nextval('private.firebase_live_revision_seq') else null end
    );
  end if;
end;
$$;
revoke all on function private.route_realtime(jsonb, text, text, boolean)
  from public, anon, authenticated, service_role;

-- Add the authenticated Supabase session to typing payloads so the compact
-- Firebase session slot can be mirrored exactly. Existing clients ignore this
-- additive private Broadcast field.
create or replace function public.broadcast_room_event(
  p_room_id uuid,
  p_realtime_epoch bigint,
  p_event text,
  p_event_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_session_id uuid;
  current_epoch bigint;
  recent_attempts integer;
  rate_window interval;
  rate_limit integer;
begin
  begin
    current_session_id := nullif(auth.jwt()->>'session_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '42501', message = 'authentication_required';
  end;
  if current_user_id is null or current_session_id is null or not exists (
    select 1 from auth.sessions as sessions
    where sessions.id = current_session_id
      and sessions.user_id = current_user_id
      and (sessions.not_after is null or sessions.not_after > clock_timestamp())
  ) then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_event not in ('typing_start', 'typing_stop', 'character_pulse') then
    raise exception using errcode = '22023', message = 'invalid_realtime_event';
  end if;
  if p_event = 'character_pulse' and p_event_id is null then
    raise exception using errcode = '22023', message = 'event_id_required';
  end if;

  select realtime_epoch into current_epoch
  from public.rooms
  where id = p_room_id and private.is_room_member(id, current_user_id);
  if not found then
    raise exception using errcode = '42501', message = 'membership_required';
  end if;
  if current_epoch != p_realtime_epoch then
    raise exception using errcode = 'PT409', message = 'stale_realtime_epoch';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'event:' || current_user_id::text || ':' || p_room_id::text || ':' || p_event,
    0
  ));
  if p_event = 'character_pulse' then
    rate_window := interval '10 seconds'; rate_limit := 5;
  else
    rate_window := interval '1 minute'; rate_limit := 40;
  end if;
  select count(*) into recent_attempts
  from private.realtime_event_attempts
  where user_id = current_user_id
    and room_id = p_room_id
    and event_name = p_event
    and attempted_at >= clock_timestamp() - rate_window;
  if recent_attempts >= rate_limit then
    raise exception using errcode = 'P0001', message = 'realtime_event_rate_limited';
  end if;
  insert into private.realtime_event_attempts(user_id, room_id, event_name)
  values (current_user_id, p_room_id, p_event);

  perform private.route_realtime(
    jsonb_strip_nulls(jsonb_build_object(
      'room_id', p_room_id,
      'user_id', current_user_id,
      'session_id', current_session_id,
      'event_id', coalesce(p_event_id, gen_random_uuid())
    )),
    p_event,
    private.room_topic(p_room_id, current_epoch, 'ephemeral'),
    true
  );
end;
$$;

create or replace function public.broadcast_character_throw(
  p_room_id uuid,
  p_realtime_epoch bigint,
  p_event_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_session_id uuid;
  current_epoch bigint;
  source_character_id text;
  selected_throwable_id text;
  selected_wire_code text;
  recent_attempts integer;
begin
  begin
    current_session_id := nullif(auth.jwt()->>'session_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '42501', message = 'authentication_required';
  end;
  if current_user_id is null or current_session_id is null or not exists (
    select 1 from auth.sessions as sessions
    where sessions.id = current_session_id
      and sessions.user_id = current_user_id
      and (sessions.not_after is null or sessions.not_after > clock_timestamp())
  ) then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_event_id is null then
    raise exception using errcode = '22023', message = 'event_id_required';
  end if;
  if p_target_user_id is null then
    raise exception using errcode = '22023', message = 'target_user_id_required';
  end if;
  if p_target_user_id = current_user_id then
    raise exception using errcode = '22023', message = 'self_target_forbidden';
  end if;
  select rooms.realtime_epoch into current_epoch
  from public.rooms as rooms
  where rooms.id = p_room_id
    and private.is_room_member(rooms.id, current_user_id);
  if not found then
    raise exception using errcode = '42501', message = 'membership_required';
  end if;
  if current_epoch != p_realtime_epoch then
    raise exception using errcode = 'PT409', message = 'stale_realtime_epoch';
  end if;
  if not private.is_room_member(p_room_id, p_target_user_id) then
    raise exception using errcode = '42501', message = 'target_membership_required';
  end if;

  select profiles.character_id into source_character_id
  from public.profiles as profiles where profiles.id = current_user_id;
  if source_character_id is null then
    raise exception using errcode = 'P0001', message = 'profile_required';
  end if;
  select current_wire.wire_code, current_wire.render_asset_id
  into selected_wire_code, selected_throwable_id
  from private.current_throwable_wire(current_user_id) as current_wire;

  perform pg_advisory_xact_lock(hashtextextended(
    'event:' || current_user_id::text || ':character_throw', 0
  ));
  select count(*) into recent_attempts
  from private.realtime_event_attempts
  where user_id = current_user_id
    and event_name = 'character_throw'
    and attempted_at >= clock_timestamp() - interval '10 seconds';
  if recent_attempts >= 20 then
    raise exception using errcode = 'P0001', message = 'realtime_event_rate_limited';
  end if;
  insert into private.realtime_event_attempts(user_id, room_id, event_name)
  values (current_user_id, p_room_id, 'character_throw');

  perform private.route_realtime(
    jsonb_build_object(
      'schema_version', 1,
      'room_id', p_room_id,
      'event_id', p_event_id,
      'actor_user_id', current_user_id,
      'session_id', current_session_id,
      'target_user_id', p_target_user_id,
      'source_character_id', source_character_id,
      'throwable_id', selected_throwable_id,
      'wire_code', selected_wire_code
    ),
    'character_throw',
    private.room_topic(p_room_id, current_epoch, 'ephemeral'),
    true
  );
end;
$$;

revoke all on function public.broadcast_room_event(uuid, bigint, text, uuid),
  public.broadcast_character_throw(uuid, bigint, uuid, uuid)
  from public, anon;
grant execute on function public.broadcast_room_event(uuid, bigint, text, uuid),
  public.broadcast_character_throw(uuid, bigint, uuid, uuid)
  to authenticated;

create function public.claim_firebase_transient_publications(
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

create function public.validate_firebase_transient_publication(
  p_worker uuid,
  p_id bigint
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  publication private.firebase_transient_publish_outbox;
  current_wire text;
begin
  select * into publication
  from private.firebase_transient_publish_outbox as outbox
  where outbox.id = p_id
    and outbox.claimed_by = p_worker
    and outbox.claim_until > clock_timestamp()
    and outbox.delivered_at is null;
  if not found then return false; end if;
  if not exists (
    select 1 from private.firebase_transient_bridge_config as bridge
    where bridge.singleton and bridge.enabled
  ) or not exists (
    select 1 from private.firebase_client_rollout_config as rollout
    where rollout.id and rollout.enabled and not rollout.kill_switch
      and rollout.cohort_basis_points > 0
  ) or not exists (
    select 1 from public.rooms as rooms
    join public.room_members as actors
      on actors.room_id = rooms.id and actors.user_id = publication.actor_id
    where rooms.id = publication.room_id
      and rooms.realtime_epoch = publication.epoch
  ) then return false; end if;
  if not exists (
    select 1 from auth.users as users
    where users.id = publication.actor_id
      and (users.banned_until is null or users.banned_until <= clock_timestamp())
  ) or not exists (
    select 1 from auth.sessions as sessions
    where sessions.id = publication.session_id
      and sessions.user_id = publication.actor_id
      and (sessions.not_after is null or sessions.not_after > clock_timestamp())
  ) then return false; end if;
  if publication.kind = 'character_throw' then
    if not private.is_room_member(publication.room_id, publication.target_user_id) then
      return false;
    end if;
    select throwable.wire_code into current_wire
    from private.current_throwable_wire(publication.actor_id) as throwable;
    if current_wire is distinct from publication.wire_code then return false; end if;
  end if;
  return true;
end;
$$;

create function public.ack_firebase_transient_publication(
  p_worker uuid,
  p_id bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.firebase_transient_publish_outbox as outbox
  set delivered_at = clock_timestamp(), claimed_by = null, claim_until = null
  where outbox.id = p_id
    and outbox.claimed_by = p_worker
    and outbox.claim_until > clock_timestamp()
    and outbox.delivered_at is null;
  return found;
end;
$$;

revoke all on function public.claim_firebase_transient_publications(uuid, integer),
  public.validate_firebase_transient_publication(uuid, bigint),
  public.ack_firebase_transient_publication(uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.claim_firebase_transient_publications(uuid, integer),
  public.validate_firebase_transient_publication(uuid, bigint),
  public.ack_firebase_transient_publication(uuid, bigint)
  to service_role;

create function public.bridge_firebase_transient_to_legacy(
  p_event_id uuid,
  p_room_id uuid,
  p_actor_id uuid,
  p_session_id uuid,
  p_kind text,
  p_target_user_id uuid,
  p_wire_code text,
  p_occurred_at_ms bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing private.firebase_transient_bridge_events;
  current_epoch bigint;
  current_wire text;
  current_throwable text;
  source_character text;
  occurred timestamptz;
  payload jsonb;
  deliver boolean;
  recent_attempts integer;
  rate_window interval;
  rate_limit integer;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_event_id is null or p_room_id is null or p_actor_id is null
     or p_kind not in ('typing_start', 'typing_stop', 'character_pulse', 'character_throw')
     or p_occurred_at_ms is null or p_occurred_at_ms < 1
     or p_occurred_at_ms > floor(extract(epoch from clock_timestamp()) * 1000)::bigint + 1000
     or (p_kind in ('typing_start', 'typing_stop')) <> (p_session_id is not null)
     or (p_kind = 'character_throw' and (
       p_target_user_id is null or p_target_user_id = p_actor_id
       or p_wire_code is null or p_wire_code !~ '^(0|[1-9][0-9]{0,5})$'
     ))
     or (p_kind <> 'character_throw' and (
       p_target_user_id is not null or p_wire_code is not null
     )) then
    raise exception using errcode = '22023', message = 'invalid_realtime_event';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'firebase-transient-bridge:' || p_event_id::text, 0
  ));
  select * into existing
  from private.firebase_transient_bridge_events as events
  where events.event_id = p_event_id;
  if found then
    if existing.room_id is distinct from p_room_id
       or existing.actor_id is distinct from p_actor_id
       or existing.session_id is distinct from p_session_id
       or existing.kind is distinct from p_kind
       or existing.target_user_id is distinct from p_target_user_id
       or existing.wire_code is distinct from p_wire_code
       or floor(extract(epoch from existing.occurred_at) * 1000)::bigint
          is distinct from p_occurred_at_ms then
      raise exception using errcode = '23505', message = 'event_id_conflict';
    end if;
    return jsonb_build_object(
      'bridged', existing.legacy_delivered,
      'duplicate', true
    );
  end if;

  if not exists (
    select 1 from private.firebase_transient_bridge_config as bridge
    where bridge.singleton and bridge.enabled
  ) or not exists (
    select 1 from private.firebase_client_rollout_config as rollout
    where rollout.id and rollout.enabled and not rollout.kill_switch
      and rollout.cohort_basis_points > 0
  ) then
    raise exception using errcode = '42501', message = 'transient_bridge_disabled';
  end if;
  if not exists (
    select 1 from auth.users as users
    where users.id = p_actor_id
      and (users.banned_until is null or users.banned_until <= clock_timestamp())
  ) or not exists (
    select 1 from auth.sessions as sessions
    where sessions.user_id = p_actor_id
      and (sessions.not_after is null or sessions.not_after > clock_timestamp())
      and (p_session_id is null or sessions.id = p_session_id)
  ) then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  select rooms.realtime_epoch into current_epoch
  from public.rooms as rooms
  where rooms.id = p_room_id and private.is_room_member(rooms.id, p_actor_id);
  if not found then
    raise exception using errcode = '42501', message = 'membership_required';
  end if;
  if p_kind = 'character_throw' then
    if not private.is_room_member(p_room_id, p_target_user_id) then
      raise exception using errcode = '42501', message = 'target_membership_required';
    end if;
    select throwable.wire_code, throwable.render_asset_id
    into current_wire, current_throwable
    from private.current_throwable_wire(p_actor_id) as throwable;
    if current_wire is distinct from p_wire_code then
      raise exception using errcode = '42501', message = 'throwable_entitlement_required';
    end if;
    select profiles.character_id into source_character
    from public.profiles as profiles where profiles.id = p_actor_id;
    if source_character is null then
      raise exception using errcode = '42501', message = 'profile_required';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    case when p_kind = 'character_throw'
      then 'event:' || p_actor_id::text || ':character_throw'
      else 'event:' || p_actor_id::text || ':' || p_room_id::text || ':' || p_kind
    end,
    0
  ));
  rate_window := case when p_kind in ('character_throw', 'character_pulse')
    then interval '10 seconds' else interval '1 minute' end;
  rate_limit := case when p_kind = 'character_throw' then 20
    when p_kind = 'character_pulse' then 10 else 40 end;
  select count(*) into recent_attempts
  from private.realtime_event_attempts as attempts
  where attempts.user_id = p_actor_id
    and attempts.event_name = p_kind
    and (p_kind = 'character_throw' or attempts.room_id = p_room_id)
    and attempts.attempted_at >= clock_timestamp() - rate_window;
  if recent_attempts >= rate_limit then
    raise exception using errcode = 'P0001', message = 'realtime_event_rate_limited';
  end if;
  insert into private.realtime_event_attempts(user_id, room_id, event_name)
  values (p_actor_id, p_room_id, p_kind);

  occurred := to_timestamp(p_occurred_at_ms::double precision / 1000.0);
  deliver := occurred >= clock_timestamp() - interval '5 seconds';
  if p_kind = 'character_throw' then
    payload := jsonb_build_object(
      'schema_version', 1,
      'room_id', p_room_id,
      'event_id', p_event_id,
      'actor_user_id', p_actor_id,
      'target_user_id', p_target_user_id,
      'source_character_id', source_character,
      'throwable_id', current_throwable
    );
  else
    payload := jsonb_strip_nulls(jsonb_build_object(
      'room_id', p_room_id,
      'user_id', p_actor_id,
      'session_id', p_session_id,
      'event_id', p_event_id
    ));
  end if;
  if deliver then
    perform realtime.send(
      payload,
      p_kind,
      private.room_topic(p_room_id, current_epoch, 'ephemeral'),
      true
    );
  end if;
  insert into private.firebase_transient_bridge_events(
    event_id, room_id, actor_id, session_id, kind,
    target_user_id, wire_code, occurred_at, legacy_delivered
  ) values (
    p_event_id, p_room_id, p_actor_id, p_session_id, p_kind,
    p_target_user_id, p_wire_code, occurred, deliver
  );
  return jsonb_build_object('bridged', deliver, 'duplicate', false);
end;
$$;
revoke all on function public.bridge_firebase_transient_to_legacy(
  uuid, uuid, uuid, uuid, text, uuid, text, bigint
) from public, anon, authenticated;
grant execute on function public.bridge_firebase_transient_to_legacy(
  uuid, uuid, uuid, uuid, text, uuid, text, bigint
) to service_role;

create function private.wake_firebase_transient_publication()
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
    where name = 'sidey_access_wake_token';
    if length(wake_secret) >= 32 then
      perform net.http_post(
        url := endpoint,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'X-Sidey-Wake-Token', wake_secret
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 1000
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
create trigger firebase_transient_publish_wake
after insert on private.firebase_transient_publish_outbox
for each row execute function private.wake_firebase_transient_publication();

create function public.configure_firebase_transient_bridge_v2(
  p_enabled boolean,
  p_wake_url text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  bridge private.firebase_transient_bridge_config;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_enabled is null or (
    p_wake_url is not null and p_wake_url !~
      '^https://asia-southeast1-sidey-realtime\.cloudfunctions\.net/syncRealtimeTransients$'
  ) then
    raise exception using errcode = '22023', message = 'invalid_transient_bridge_state';
  end if;
  update private.firebase_transient_bridge_config
  set enabled = p_enabled,
      wake_url = coalesce(p_wake_url, wake_url),
      updated_at = clock_timestamp()
  where singleton
  returning * into strict bridge;
  if not p_enabled then
    update private.firebase_transient_publish_outbox
    set delivered_at = coalesce(delivered_at, clock_timestamp()),
        claimed_by = null,
        claim_until = null
    where delivered_at is null;
  end if;
  return jsonb_build_object(
    'enabled', bridge.enabled,
    'wakeConfigured', bridge.wake_url is not null,
    'updatedAt', bridge.updated_at
  );
end;
$$;

create function public.firebase_transient_bridge_state_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare bridge private.firebase_transient_bridge_config;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  select * into strict bridge
  from private.firebase_transient_bridge_config where singleton;
  return jsonb_build_object(
    'enabled', bridge.enabled,
    'wakeConfigured', bridge.wake_url is not null,
    'updatedAt', bridge.updated_at
  );
end;
$$;
revoke all on function public.configure_firebase_transient_bridge_v2(boolean, text),
  public.firebase_transient_bridge_state_v2()
  from public, anon, authenticated;
grant execute on function public.configure_firebase_transient_bridge_v2(boolean, text),
  public.firebase_transient_bridge_state_v2()
  to service_role;

create function private.delete_expired_firebase_transient_publications()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare removed bigint;
begin
  with doomed as (
    select outbox.id
    from private.firebase_transient_publish_outbox as outbox
    where outbox.delivered_at < clock_timestamp() - interval '8 days'
    order by outbox.delivered_at, outbox.id
    limit 100000
  ), deleted as (
    delete from private.firebase_transient_publish_outbox as outbox
    using doomed
    where outbox.id = doomed.id
    returning 1
  ) select count(*) into removed from deleted;
  return removed;
end;
$$;
revoke all on function private.delete_expired_firebase_transient_publications()
  from public, anon, authenticated, service_role;

create function private.delete_expired_firebase_transient_bridge_events()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare removed bigint;
begin
  with doomed as (
    select events.event_id
    from private.firebase_transient_bridge_events as events
    where events.accepted_at < clock_timestamp() - interval '8 days'
    order by events.accepted_at
    limit 100000
  ), deleted as (
    delete from private.firebase_transient_bridge_events as events
    using doomed
    where events.event_id = doomed.event_id
    returning 1
  ) select count(*) into removed from deleted;
  return removed;
end;
$$;
revoke all on function private.delete_expired_firebase_transient_bridge_events()
  from public, anon, authenticated, service_role;
select cron.schedule(
  'sidey-delete-firebase-transient-publications',
  '12 * * * *',
  'select private.delete_expired_firebase_transient_publications()'
);
select cron.schedule(
  'sidey-delete-firebase-transient-bridge-events',
  '17 * * * *',
  'select private.delete_expired_firebase_transient_bridge_events()'
);

commit;
