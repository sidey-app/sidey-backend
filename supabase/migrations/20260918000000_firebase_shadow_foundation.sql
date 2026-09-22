-- Opt-in shadow only. No existing RPC, Auth, commerce, or Realtime behavior changes.
-- Every capture trigger is DISABLED; enabling requires a separately reviewed rollout.
create table private.firebase_shadow_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false
);
create table private.firebase_hint_outbox (
  revision bigint generated always as identity primary key,
  event_id uuid not null default gen_random_uuid() unique,
  room_id uuid not null,
  epoch bigint not null check (epoch > 0),
  kind text not null check (kind in ('message_changed','structure_changed','messages_pruned')),
  occurred_at timestamptz not null default clock_timestamp(),
  attempts integer not null default 0,
  claimed_by uuid,
  claim_until timestamptz,
  delivered_at timestamptz,
  discarded_at timestamptz
);
-- Wire revision is allocated after an outbox row is visible/committed, not during source writes.
create sequence private.firebase_publication_revision_seq;
revoke all on sequence private.firebase_publication_revision_seq from public, anon, authenticated;
create index firebase_hint_outbox_pending on private.firebase_hint_outbox(revision)
  where delivered_at is null and discarded_at is null;
create table private.firebase_shadow_leases (
  id uuid primary key default gen_random_uuid(),
  -- Keep the cleanup address after Auth deletes a session/user. A cascade here
  -- would lose the address of a still-existing RTDB lease before revoking it.
  user_id uuid not null,
  auth_session_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp()
);
create index firebase_shadow_leases_expiry on private.firebase_shadow_leases(expires_at);
revoke all on private.firebase_shadow_users, private.firebase_hint_outbox,
  private.firebase_shadow_leases from public, anon, authenticated;
revoke all on sequence private.firebase_hint_outbox_revision_seq from public, anon, authenticated;

create function private.enqueue_firebase_hint(p_room_id uuid, p_kind text)
returns void language plpgsql security definer set search_path = '' as $$
declare current_epoch bigint;
begin
  -- Capture takes no room row lock: messages already hold FK KEY SHARE, and
  -- profile/prune may visit several rooms in different orders. Adding locks here
  -- would introduce deadlocks into authoritative writes. Stale epoch snapshots
  -- are discarded by the publisher; no hint is retargeted to a newer epoch.
  select realtime_epoch into current_epoch from public.rooms where id = p_room_id;
  if current_epoch is null then return; end if;
  if not exists (select 1 from public.room_members m join private.firebase_shadow_users s
    on s.user_id=m.user_id and s.enabled where m.room_id=p_room_id) then return; end if;
  insert into private.firebase_hint_outbox(room_id,epoch,kind)
    values(p_room_id,current_epoch,p_kind);
end $$;
revoke all on function private.enqueue_firebase_hint(uuid,text) from public, anon, authenticated;

create function private.capture_firebase_hint()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target_room uuid; item record; hint_kind text;
begin
  if tg_table_name='messages' then
    target_room := coalesce(new.room_id,old.room_id);
    hint_kind := case when current_setting('sidey.suppress_message_broadcast',true)='on'
      then 'messages_pruned' else 'message_changed' end;
    perform private.enqueue_firebase_hint(target_room,hint_kind);
  elsif tg_table_name='rooms' then
    -- Membership's existing room epoch UPDATE also reaches this trigger.
    perform private.enqueue_firebase_hint(coalesce(new.id,old.id),'structure_changed');
  elsif tg_table_name='profiles' then
    -- Stable iteration only; capture deliberately takes no room row locks.
    for item in select room_id from public.room_members
      where user_id=coalesce(new.id,old.id) order by room_id
    loop perform private.enqueue_firebase_hint(item.room_id,'structure_changed'); end loop;
  end if;
  return null;
end $$;
revoke all on function private.capture_firebase_hint() from public, anon, authenticated;
create trigger zz_firebase_messages_shadow after insert or update or delete on public.messages
  for each row execute function private.capture_firebase_hint();
alter table public.messages disable trigger zz_firebase_messages_shadow;
create trigger zz_firebase_rooms_shadow after update on public.rooms
  for each row execute function private.capture_firebase_hint();
alter table public.rooms disable trigger zz_firebase_rooms_shadow;
create trigger zz_firebase_profiles_shadow after update on public.profiles
  for each row execute function private.capture_firebase_hint();
alter table public.profiles disable trigger zz_firebase_profiles_shadow;

-- Called as the actual Supabase user, never with a user ID supplied by the caller.
create function public.prepare_firebase_shadow_lease()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); sid uuid; lease_id uuid; expiry timestamptz; streams jsonb;
begin
  if uid is null then raise exception using errcode='42501',message='authentication_required'; end if;
  if not exists (select 1 from private.firebase_shadow_users where user_id=uid and enabled) then
    return jsonb_build_object('enabled',false);
  end if;
  sid := nullif(auth.jwt()->>'session_id','')::uuid;
  if sid is null or not exists(select 1 from auth.sessions where id=sid and user_id=uid
    and (not_after is null or not_after>clock_timestamp())) then
    raise exception using errcode='42501',message='active_session_required';
  end if;
  if auth.jwt()->>'exp' is null then
    raise exception using errcode='42501',message='session_refresh_required';
  end if;
  expiry := least(clock_timestamp()+interval '60 seconds',
    to_timestamp((auth.jwt()->>'exp')::double precision),
    (select not_after from auth.sessions where id=sid and user_id=uid));
  if expiry is null or expiry < clock_timestamp()+interval '10 seconds' then
    raise exception using errcode='42501',message='session_refresh_required';
  end if;
  -- Bound bootstrap abuse without changing any commerce or application rate limit.
  perform pg_advisory_xact_lock(hashtextextended('firebase-lease:'||uid::text,0));
  if (select count(*) from private.firebase_shadow_leases
    where user_id=uid and created_at>clock_timestamp()-interval '1 minute')>=12 then
    raise exception using errcode='P0001',message='firebase_bootstrap_rate_limited';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('roomId',r.id,'epoch',r.realtime_epoch,
    'path','v1/rooms/'||r.id::text||'/epochs/'||r.realtime_epoch::text||'/hint') order by r.id),'[]'::jsonb)
    into streams from public.rooms r join public.room_members m on m.room_id=r.id where m.user_id=uid;
  insert into private.firebase_shadow_leases(user_id,auth_session_id,expires_at)
    values(uid,sid,expiry) returning id into lease_id;
  return jsonb_build_object('enabled',true,'userId',uid,'sessionId',lease_id,
    'leaseExpiresAt',floor(extract(epoch from expiry)*1000),'streams',streams);
end $$;
revoke all on function public.prepare_firebase_shadow_lease() from public,anon;
grant execute on function public.prepare_firebase_shadow_lease() to authenticated;

-- Publisher credentials only. SKIP LOCKED plus a fenced claim makes retries bounded.
create function public.claim_firebase_hints(p_worker uuid, p_limit integer default 50)
returns table(revision text,publication_revision text,event_id uuid,room_id uuid,epoch bigint,kind text,occurred_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  if p_worker is null or p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode='22023',message='invalid_firebase_claim'; end if;
  -- An obsolete epoch is never re-targeted to the new epoch or new members.
  update private.firebase_hint_outbox o set discarded_at=clock_timestamp()
    where o.delivered_at is null and o.discarded_at is null and not exists
      (select 1 from public.rooms r where r.id=o.room_id and r.realtime_epoch=o.epoch);
  return query with candidates as (
    select o.revision from private.firebase_hint_outbox o
    where o.delivered_at is null and o.discarded_at is null and o.attempts<8
      and (o.claim_until is null or o.claim_until<clock_timestamp())
      and exists(select 1 from public.room_members m join private.firebase_shadow_users s
        on s.user_id=m.user_id and s.enabled where m.room_id=o.room_id)
    order by o.revision for update skip locked limit p_limit
  ), claimed as (
    update private.firebase_hint_outbox o set claimed_by=p_worker,
      claim_until=clock_timestamp()+interval '2 minutes',attempts=o.attempts+1
    from candidates c where c.revision=o.revision
    returning o.revision,o.event_id,o.room_id,o.epoch,o.kind,o.occurred_at
  ) select c.revision::text,nextval('private.firebase_publication_revision_seq')::text,
    c.event_id,c.room_id,c.epoch,c.kind,c.occurred_at from claimed c order by c.revision;
end $$;
create function public.finish_firebase_hint(p_worker uuid,p_revision bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  update private.firebase_hint_outbox set delivered_at=clock_timestamp(),claim_until=null
    where revision=p_revision and claimed_by=p_worker and claim_until>clock_timestamp()
      and delivered_at is null and discarded_at is null;
  get diagnostics changed=row_count;
  return changed=1;
end $$;
revoke all on function public.claim_firebase_hints(uuid,integer),
  public.finish_firebase_hint(uuid,bigint) from public,anon,authenticated;
grant execute on function public.claim_firebase_hints(uuid,integer),
  public.finish_firebase_hint(uuid,bigint) to service_role;

create function public.expired_firebase_leases(p_limit integer default 20)
returns table(session_id uuid,user_id uuid)
language sql security definer set search_path = '' as $$
  select l.id,l.user_id from private.firebase_shadow_leases l
  where l.expires_at<=clock_timestamp()
    or not exists(select 1 from auth.sessions s where s.id=l.auth_session_id and s.user_id=l.user_id
      and (s.not_after is null or s.not_after>clock_timestamp()))
    or not exists(select 1 from private.firebase_shadow_users u where u.user_id=l.user_id and u.enabled)
  order by l.expires_at limit greatest(0,least(coalesce(p_limit,0),100))
$$;
create function public.finish_firebase_lease_cleanup(p_session_id uuid)
returns void language sql security definer set search_path = '' as $$
  delete from private.firebase_shadow_leases where id=p_session_id
$$;
revoke all on function public.expired_firebase_leases(integer),
  public.finish_firebase_lease_cleanup(uuid) from public,anon,authenticated;
grant execute on function public.expired_firebase_leases(integer),
  public.finish_firebase_lease_cleanup(uuid) to service_role;
