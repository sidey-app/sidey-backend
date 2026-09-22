-- Renew the staging live-transport lease at most once per hour. The lease is
-- still capped by the current Supabase access-token expiry and the source
-- auth.sessions.not_after deadline, while event-driven access publication
-- remains the immediate revocation path.
begin;

-- These columns already exist in staging. Record their previously deployed
-- forward changes so a clean local reset and future environments converge.
alter table private.firebase_live_config
  add column if not exists direct_events_enabled boolean not null default false;
alter table private.firebase_live_dispatch_config
  add column if not exists edge_region text;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='private.firebase_live_dispatch_config'::regclass
      and conname='firebase_live_dispatch_edge_region_check'
  ) then
    alter table private.firebase_live_dispatch_config
      add constraint firebase_live_dispatch_edge_region_check
      check (edge_region is null or edge_region in ('ap-northeast-2', 'ap-southeast-1'));
  end if;
end
$$;

create or replace function private.prepare_firebase_live_lease_before_direct()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  uid uuid := auth.uid();
  sid uuid;
  expiry timestamptz;
  lid uuid;
  streams jsonb;
  room_map jsonb;
  count_attempts integer;
  lease_revision bigint;
begin
  if uid is null then
    raise exception using errcode='42501', message='authentication_required';
  end if;
  if not exists(select 1 from private.firebase_live_config where enabled)
     or not exists(select 1 from private.firebase_live_users where user_id=uid and enabled) then
    return jsonb_build_object('enabled', false);
  end if;

  sid := nullif(auth.jwt()->>'session_id', '')::uuid;
  if sid is null or not exists(
    select 1
    from auth.sessions
    where id=sid and user_id=uid
      and (not_after is null or not_after > clock_timestamp())
  ) then
    raise exception using errcode='42501', message='active_session_required';
  end if;
  if auth.jwt()->>'exp' is null then
    raise exception using errcode='42501', message='session_refresh_required';
  end if;

  expiry := least(
    clock_timestamp() + interval '1 hour',
    to_timestamp((auth.jwt()->>'exp')::double precision),
    (select not_after from auth.sessions where id=sid)
  );
  if expiry < clock_timestamp() + interval '20 seconds' then
    raise exception using errcode='42501', message='session_refresh_required';
  end if;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'roomId', r.id,
      'epoch', r.realtime_epoch,
      'path', 'v2/rooms/' || r.id || '/epochs/' || r.realtime_epoch,
      'members', (
        select jsonb_object_agg(m2.user_id::text, true)
        from public.room_members m2
        where m2.room_id=r.id
      )
    ) order by r.id), '[]'::jsonb),
    coalesce(jsonb_object_agg(r.id::text, r.realtime_epoch), '{}'::jsonb)
  into streams, room_map
  from public.rooms r
  join public.room_members m on m.room_id=r.id
  where m.user_id=uid and private.firebase_room_is_live(r.id);

  if jsonb_array_length(streams)=0 then
    return jsonb_build_object('enabled', false);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('firebase-live-lease:' || uid::text, 0));
  insert into private.firebase_live_bootstrap_limits
  values(uid, clock_timestamp(), 1)
  on conflict(user_id) do update set
    attempts=case
      when firebase_live_bootstrap_limits.window_started < clock_timestamp() - interval '1 minute' then 1
      else firebase_live_bootstrap_limits.attempts + 1
    end,
    window_started=case
      when firebase_live_bootstrap_limits.window_started < clock_timestamp() - interval '1 minute' then clock_timestamp()
      else firebase_live_bootstrap_limits.window_started
    end
  returning attempts into count_attempts;
  if count_attempts > 12 then
    raise exception using errcode='P0001', message='firebase_bootstrap_rate_limited';
  end if;

  if (
    select count(*)
    from private.firebase_live_leases l
    where l.user_id=uid and l.auth_session_id<>sid
      and not private.firebase_live_lease_invalid(l)
  ) >= 16 then
    raise exception using errcode='P0001', message='firebase_session_limit';
  end if;

  insert into private.firebase_live_leases(user_id, auth_session_id, expires_at, rooms)
  values(uid, sid, expiry, room_map)
  on conflict(auth_session_id) do update set
    expires_at=excluded.expires_at,
    rooms=excluded.rooms,
    revision=excluded.revision,
    cleaned_at=null,
    attempts=case
      when firebase_live_leases.window_started < clock_timestamp() - interval '1 minute' then 1
      else firebase_live_leases.attempts + 1
    end,
    window_started=case
      when firebase_live_leases.window_started < clock_timestamp() - interval '1 minute' then clock_timestamp()
      else firebase_live_leases.window_started
    end
  returning id, attempts, revision into lid, count_attempts, lease_revision;
  if count_attempts > 12 then
    raise exception using errcode='P0001', message='firebase_bootstrap_rate_limited';
  end if;

  return jsonb_build_object(
    'enabled', true,
    'userId', uid,
    'sessionId', lid,
    'leaseExpiresAt', floor(extract(epoch from expiry) * 1000),
    'leaseRevision', lease_revision::text,
    'serverTime', floor(extract(epoch from clock_timestamp()) * 1000),
    'streams', streams
  );
end
$$;

create or replace function private.prepare_firebase_live_lease_before_wake()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare result jsonb;
begin
  result := private.prepare_firebase_live_lease_before_direct();
  if result->>'enabled'='true'
     and exists(select 1 from private.firebase_live_config where enabled and direct_events_enabled) then
    result := result || jsonb_build_object(
      'directEvents', jsonb_build_object('endpoint', 'realtime-event', 'protocolVersion', 1)
    );
  end if;
  return result;
end
$$;

create or replace function private.prepare_firebase_live_lease_before_region()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare result jsonb;
begin
  result := private.prepare_firebase_live_lease_before_wake();
  if result->>'enabled'='true'
     and exists(select 1 from private.firebase_live_config where enabled and direct_events_enabled) then
    result := result || jsonb_build_object(
      'publisherWake', jsonb_build_object('endpoint', 'realtime-wake', 'protocolVersion', 1)
    );
  end if;
  return result;
end
$$;

create or replace function public.prepare_firebase_live_lease()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  result jsonb;
  region text;
begin
  result := private.prepare_firebase_live_lease_before_region();
  select c.edge_region into region
  from private.firebase_live_dispatch_config c
  where c.id and c.enabled and c.owner_run_id is not null
    and c.run_deadline_at > clock_timestamp();
  if result->>'enabled'='true' and region is not null then
    if result ? 'directEvents' then
      result := jsonb_set(
        result,
        '{directEvents}',
        result->'directEvents' || jsonb_build_object('region', region)
      );
    end if;
    if result ? 'publisherWake' then
      result := jsonb_set(
        result,
        '{publisherWake}',
        result->'publisherWake' || jsonb_build_object('region', region)
      );
    end if;
  end if;
  return result;
end
$$;

revoke all on function private.prepare_firebase_live_lease_before_direct() from public, anon, authenticated;
revoke all on function private.prepare_firebase_live_lease_before_wake() from public, anon, authenticated;
revoke all on function private.prepare_firebase_live_lease_before_region() from public, anon, authenticated;
revoke all on function public.prepare_firebase_live_lease() from public, anon;
grant execute on function public.prepare_firebase_live_lease() to authenticated;

comment on function public.prepare_firebase_live_lease() is
  'Issues a Firebase live lease for at most one hour, capped by Supabase JWT and auth session expiry.';

commit;
;
