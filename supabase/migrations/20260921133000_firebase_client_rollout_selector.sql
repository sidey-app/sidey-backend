begin;

create table private.firebase_client_rollout_config (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  kill_switch boolean not null default true,
  cohort_basis_points integer not null default 0
    check (cohort_basis_points between 0 and 10000),
  protocol_version integer not null default 2 check (protocol_version = 2),
  contract_hash text not null
    check (contract_hash ~ '^[0-9a-f]{64}$'),
  cache_ttl_seconds integer not null default 300
    check (cache_ttl_seconds between 30 and 300),
  updated_at timestamptz not null default clock_timestamp()
);

insert into private.firebase_client_rollout_config(
  id,
  enabled,
  kill_switch,
  cohort_basis_points,
  protocol_version,
  contract_hash,
  cache_ttl_seconds
) values (
  true,
  false,
  true,
  0,
  2,
  '3c836b40cfc44437e9d069b84787cd3d8793026ce40de46d82b9ece79127b7e5',
  300
);

create table private.firebase_client_session_capabilities (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('macos', 'windows')),
  app_version text not null
    check (app_version ~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$'),
  protocol_version integer not null check (protocol_version between 0 and 100),
  contract_hash text not null check (contract_hash ~ '^[0-9a-f]{64}$'),
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  last_selected_enabled boolean not null default false
);

create index firebase_client_capabilities_last_seen
  on private.firebase_client_session_capabilities(last_seen_at desc);
create index firebase_client_capabilities_user
  on private.firebase_client_session_capabilities(user_id, last_seen_at desc);

alter table private.firebase_client_rollout_config enable row level security;
alter table private.firebase_client_session_capabilities enable row level security;
revoke all on private.firebase_client_rollout_config,
  private.firebase_client_session_capabilities
  from public, anon, authenticated, service_role;

create function public.register_realtime_capability_v2(
  p_platform text,
  p_app_version text,
  p_protocol_version integer,
  p_contract_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_session_id uuid;
  config private.firebase_client_rollout_config;
  cohort_bucket integer;
  selected boolean;
  selected_transport text;
  user_hash bytea;
begin
  begin
    current_session_id := nullif(auth.jwt()->>'session_id', '')::uuid;
  exception when invalid_text_representation then
    raise exception using errcode = '42501', message = 'authentication_required';
  end;

  if current_user_id is null or current_session_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_platform not in ('macos', 'windows')
     or p_app_version is null
     or p_app_version !~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$'
     or p_protocol_version is null
     or p_protocol_version not between 0 and 100
     or p_contract_hash is null
     or p_contract_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_client_capability';
  end if;

  perform 1
  from auth.sessions as sessions
  join auth.users as users on users.id = sessions.user_id
  where sessions.id = current_session_id
    and sessions.user_id = current_user_id
    and (sessions.not_after is null or sessions.not_after > clock_timestamp())
    and (users.banned_until is null or users.banned_until <= clock_timestamp())
  for key share of sessions;
  if not found then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select * into strict config
  from private.firebase_client_rollout_config
  where id;

  user_hash := extensions.digest(current_user_id::text, 'sha256');
  cohort_bucket := (
    get_byte(user_hash, 0) * 256 + get_byte(user_hash, 1)
  ) % 10000;
  selected := config.enabled
    and not config.kill_switch
    and cohort_bucket < config.cohort_basis_points
    and p_protocol_version >= config.protocol_version
    and p_contract_hash = config.contract_hash;
  selected_transport := case
    when selected then 'firebase_v2'
    else 'legacy_supabase'
  end;

  insert into private.firebase_client_session_capabilities(
    session_id,
    user_id,
    platform,
    app_version,
    protocol_version,
    contract_hash,
    last_selected_enabled
  ) values (
    current_session_id,
    current_user_id,
    p_platform,
    p_app_version,
    p_protocol_version,
    p_contract_hash,
    selected
  )
  on conflict (session_id) do update
  set user_id = excluded.user_id,
      platform = excluded.platform,
      app_version = excluded.app_version,
      protocol_version = excluded.protocol_version,
      contract_hash = excluded.contract_hash,
      last_seen_at = clock_timestamp(),
      last_selected_enabled = excluded.last_selected_enabled;

  return jsonb_build_object(
    'enabled', selected,
    'protocolVersion', config.protocol_version,
    'transport', selected_transport,
    'contractHash', config.contract_hash,
    'killSwitch', config.kill_switch,
    'cacheTtlSeconds', config.cache_ttl_seconds,
    'failureMode', 'fail_closed_if_last_enabled'
  );
end;
$$;

revoke all on function public.register_realtime_capability_v2(
  text,
  text,
  integer,
  text
) from public, anon;
grant execute on function public.register_realtime_capability_v2(
  text,
  text,
  integer,
  text
) to authenticated;

-- The client selector is advisory UX, not the security boundary. Every
-- bootstrap re-checks the current singleton, exact active Auth session and the
-- capability registered by that same session. The returned lease is bounded by
-- the selector cache TTL so an already-connected RTDB listener is denied by
-- Rules no later than five minutes after the client stops renewing it.
create function public.firebase_realtime_bootstrap_authorization(
  p_user_id uuid,
  p_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  config private.firebase_client_rollout_config;
  capability private.firebase_client_session_capabilities;
  user_hash bytea;
  cohort_bucket integer;
  lease_expires_at timestamptz;
  allowed boolean := false;
begin
  if p_user_id is null or p_session_id is null then
    return jsonb_build_object('allowed', false);
  end if;

  select * into strict config
  from private.firebase_client_rollout_config
  where id;

  select * into capability
  from private.firebase_client_session_capabilities
  where session_id = p_session_id
    and user_id = p_user_id;

  if found
     and config.enabled
     and not config.kill_switch
     and capability.last_selected_enabled
     and capability.protocol_version >= config.protocol_version
     and capability.contract_hash = config.contract_hash
     and capability.last_seen_at >=
       clock_timestamp() - make_interval(secs => config.cache_ttl_seconds)
     and exists (
       select 1
       from auth.sessions as sessions
       join auth.users as users on users.id = sessions.user_id
       where sessions.id = p_session_id
         and sessions.user_id = p_user_id
         and (sessions.not_after is null or sessions.not_after > clock_timestamp())
         and (users.banned_until is null or users.banned_until <= clock_timestamp())
     ) then
    user_hash := extensions.digest(p_user_id::text, 'sha256');
    cohort_bucket := (
      get_byte(user_hash, 0) * 256 + get_byte(user_hash, 1)
    ) % 10000;
    allowed := cohort_bucket < config.cohort_basis_points;
  end if;

  if allowed then
    lease_expires_at := least(
      capability.last_seen_at + make_interval(secs => config.cache_ttl_seconds),
      clock_timestamp() + make_interval(secs => config.cache_ttl_seconds),
      coalesce(
        (select sessions.not_after from auth.sessions as sessions
         where sessions.id = p_session_id and sessions.user_id = p_user_id),
        'infinity'::timestamptz
      )
    );
    if lease_expires_at <= clock_timestamp() then
      allowed := false;
    end if;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'allowed', allowed,
    'leaseExpiresAt', case when allowed then
      floor(extract(epoch from lease_expires_at) * 1000)::bigint end,
    'protocolVersion', config.protocol_version,
    'contractHash', config.contract_hash
  ));
end;
$$;

revoke all on function public.firebase_realtime_bootstrap_authorization(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.firebase_realtime_bootstrap_authorization(uuid, uuid)
  to service_role;

-- Operator-only half of the global emergency gate. The operational publisher
-- changes this singleton and Firebase RTDB in fail-closed order; this function
-- never implements a timer or automatic seven-day cutoff.
create function public.configure_firebase_client_rollout_v2(
  p_enabled boolean,
  p_kill_switch boolean,
  p_cohort_basis_points integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  config private.firebase_client_rollout_config;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  if p_enabled is null
     or p_kill_switch is null
     or p_cohort_basis_points is null
     or not (
       (not p_enabled and p_kill_switch and p_cohort_basis_points = 0)
       or
       (p_enabled and not p_kill_switch
        and p_cohort_basis_points between 1 and 10000)
     ) then
    raise exception using errcode = '22023', message = 'invalid_rollout_state';
  end if;

  update private.firebase_client_rollout_config
  set enabled = p_enabled,
      kill_switch = p_kill_switch,
      cohort_basis_points = p_cohort_basis_points,
      updated_at = clock_timestamp()
  where id
  returning * into strict config;

  return jsonb_build_object(
    'enabled', config.enabled,
    'killSwitch', config.kill_switch,
    'cohortBasisPoints', config.cohort_basis_points,
    'protocolVersion', config.protocol_version,
    'contractHash', config.contract_hash,
    'cacheTtlSeconds', config.cache_ttl_seconds
  );
end;
$$;

revoke all on function public.configure_firebase_client_rollout_v2(
  boolean,
  boolean,
  integer
) from public, anon, authenticated;
grant execute on function public.configure_firebase_client_rollout_v2(
  boolean,
  boolean,
  integer
) to service_role;

create function public.firebase_client_rollout_state_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  config private.firebase_client_rollout_config;
begin
  if coalesce(auth.jwt()->>'role', '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'service_role_required';
  end if;
  select * into strict config
  from private.firebase_client_rollout_config
  where id;
  return jsonb_build_object(
    'enabled', config.enabled,
    'killSwitch', config.kill_switch,
    'cohortBasisPoints', config.cohort_basis_points,
    'protocolVersion', config.protocol_version,
    'contractHash', config.contract_hash,
    'cacheTtlSeconds', config.cache_ttl_seconds
  );
end;
$$;

revoke all on function public.firebase_client_rollout_state_v2()
  from public, anon, authenticated;
grant execute on function public.firebase_client_rollout_state_v2()
  to service_role;

create function public.firebase_client_capability_summary(
  p_since timestamptz default clock_timestamp() - interval '7 days'
)
returns table(
  platform text,
  app_version text,
  protocol_version integer,
  contract_hash text,
  selected_enabled boolean,
  session_count bigint,
  user_count bigint,
  latest_seen_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_since is null
     or p_since < clock_timestamp() - interval '90 days'
     or p_since > clock_timestamp() then
    raise exception using errcode = '22023', message = 'invalid_since';
  end if;
  return query
  select capabilities.platform,
         capabilities.app_version,
         capabilities.protocol_version,
         capabilities.contract_hash,
         capabilities.last_selected_enabled,
         count(*),
         count(distinct capabilities.user_id),
         max(capabilities.last_seen_at)
  from private.firebase_client_session_capabilities as capabilities
  where capabilities.last_seen_at >= p_since
    and exists (
      select 1
      from auth.sessions as sessions
      where sessions.id = capabilities.session_id
        and sessions.user_id = capabilities.user_id
        and (sessions.not_after is null or sessions.not_after > clock_timestamp())
    )
  group by capabilities.platform,
           capabilities.app_version,
           capabilities.protocol_version,
           capabilities.contract_hash,
           capabilities.last_selected_enabled
  order by capabilities.platform,
           capabilities.app_version,
           capabilities.protocol_version,
           capabilities.contract_hash,
           capabilities.last_selected_enabled;
end;
$$;

revoke all on function public.firebase_client_capability_summary(timestamptz)
  from public, anon, authenticated;
grant execute on function public.firebase_client_capability_summary(timestamptz)
  to service_role;

commit;
