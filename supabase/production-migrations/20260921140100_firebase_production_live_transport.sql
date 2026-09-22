-- Live v2 is OFF by default. Explicit whole-room and user enrollment only.
-- Source messages/Auth/commerce remain in Supabase. No customer-data backfill.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';
create table private.firebase_live_config(id boolean primary key default true check(id),enabled boolean not null default false);
insert into private.firebase_live_config values(true,false);
create table private.firebase_live_users(user_id uuid primary key references auth.users(id) on delete cascade,enabled boolean not null default false);
-- Keep the routing/cleanup address when a room is deleted.
create table private.firebase_live_rooms(room_id uuid primary key,enabled boolean not null default false);
create sequence private.firebase_live_revision_seq;
create table private.firebase_live_outbox(
 id bigint generated always as identity primary key,event_id uuid not null default gen_random_uuid(),
 room_id uuid not null,epoch bigint not null,kind text not null,
 payload jsonb not null default '{}',occurred_at timestamptz not null default clock_timestamp(),
 publication_revision bigint,claimed_by uuid,claim_until timestamptz,attempts integer not null default 0,
 delivered_at timestamptz,cleaned_at timestamptz,
 check(kind in ('message_changed','structure_changed','messages_pruned','control','typing_start','typing_stop','character_pulse','character_throw'))
);
create index firebase_live_pending on private.firebase_live_outbox(id) where delivered_at is null;
create index firebase_live_changes on private.firebase_live_outbox(room_id,publication_revision) where publication_revision is not null;
create table private.firebase_live_cursors(room_id uuid primary key,high_revision bigint not null default 0,floor_revision bigint not null default 0);
create table private.firebase_live_epochs(room_id uuid not null,epoch bigint not null,primary key(room_id,epoch));
create table private.firebase_live_leases(
 id uuid primary key default gen_random_uuid(),user_id uuid not null,auth_session_id uuid not null unique,
 expires_at timestamptz not null,rooms jsonb not null default '{}',
 revision bigint not null default nextval('private.firebase_live_revision_seq'),cleaned_at timestamptz,
 window_started timestamptz not null default clock_timestamp(),attempts integer not null default 1
);
create table private.firebase_live_bootstrap_limits(user_id uuid primary key references auth.users(id) on delete cascade,window_started timestamptz not null,attempts integer not null);
revoke all on private.firebase_live_bootstrap_limits from public,anon,authenticated;
create index firebase_live_leases_expiry on private.firebase_live_leases(expires_at);
revoke all on private.firebase_live_config,private.firebase_live_users,private.firebase_live_rooms,
 private.firebase_live_outbox,private.firebase_live_cursors,private.firebase_live_epochs,private.firebase_live_leases from public,anon,authenticated;
revoke all on sequence private.firebase_live_revision_seq,private.firebase_live_outbox_id_seq from public,anon,authenticated;

create function private.firebase_room_is_live(p_room uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.firebase_live_config where enabled)
 and exists(select 1 from private.firebase_live_rooms where room_id=p_room and enabled)
 and exists(select 1 from public.rooms where id=p_room)
 and exists(select 1 from public.room_members where room_id=p_room)
 and not exists(select 1 from public.room_members m where m.room_id=p_room and not exists
   (select 1 from private.firebase_live_users u where u.user_id=m.user_id and u.enabled))
$$;
revoke all on function private.firebase_room_is_live(uuid) from public,anon,authenticated;

-- Preserve every existing validation/rate limit/entitlement in the caller. No extra
-- room locks here: source inserts already hold FK KEY SHARE and must not upgrade it.
create function private.route_realtime(p_payload jsonb,p_event text,p_topic text,p_private boolean)
returns void language plpgsql security definer set search_path='' as $$
declare rid uuid; ep bigint; live boolean;
begin
 rid := split_part(p_topic,':',2)::uuid; ep := split_part(p_topic,':',3)::bigint;
 live := private.firebase_room_is_live(rid);
 if not live then perform realtime.send(p_payload,p_event,p_topic,p_private); end if;
 if live or (p_event='structure_changed' and exists(select 1 from private.firebase_live_rooms where room_id=rid)) then
   insert into private.firebase_live_outbox(room_id,epoch,kind,payload)
   values(rid,ep,case when live then p_event else 'control' end,p_payload);
 end if;
end $$;
revoke all on function private.route_realtime(jsonb,text,text,boolean) from public,anon,authenticated;

-- Operator changes are service-side SQL only. Changing a cohort invalidates the
-- old epoch and wakes legacy clients; no existing production room is enrolled.
create function private.firebase_rollout_changed()
returns trigger language plpgsql security definer set search_path='' as $$
declare r record; uid uuid; rid uuid;
begin
 if tg_table_name='firebase_live_users' then uid:=coalesce(new.user_id,old.user_id); end if;
 if tg_table_name='firebase_live_rooms' then rid:=coalesce(new.room_id,old.room_id); end if;
 for r in select id,realtime_epoch from public.rooms where
 (rid is null or id=rid) and (uid is null or exists(select 1 from public.room_members where room_id=id and user_id=uid))
 and (rid is not null or exists(select 1 from private.firebase_live_rooms where room_id=id)) order by id for update
 loop
   perform realtime.send(jsonb_build_object('room_id',r.id,'entity','rooms','operation','UPDATE','realtime_epoch',r.realtime_epoch+1),
     'structure_changed',private.room_topic(r.id,r.realtime_epoch,'db'),true);
   update public.rooms set realtime_epoch=realtime_epoch+1 where id=r.id;
   insert into private.firebase_live_outbox(room_id,epoch,kind) values(r.id,r.realtime_epoch+1,'control');
 end loop;
 return null;
end $$;
revoke all on function private.firebase_rollout_changed() from public,anon,authenticated;
create trigger firebase_config_changed after update on private.firebase_live_config for each row when(old.enabled is distinct from new.enabled) execute function private.firebase_rollout_changed();
create trigger firebase_user_changed after insert or update or delete on private.firebase_live_users for each row execute function private.firebase_rollout_changed();
create trigger firebase_room_changed after insert or update or delete on private.firebase_live_rooms for each row execute function private.firebase_rollout_changed();

create function public.prepare_firebase_live_lease()
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); sid uuid; expiry timestamptz; lid uuid; streams jsonb; room_map jsonb; count_attempts integer; lease_revision bigint;
begin
 if uid is null then raise exception using errcode='42501',message='authentication_required'; end if;
 if not exists(select 1 from private.firebase_live_config where enabled) or not exists(select 1 from private.firebase_live_users where user_id=uid and enabled) then return jsonb_build_object('enabled',false); end if;
 sid:=nullif(auth.jwt()->>'session_id','')::uuid;
 if sid is null or not exists(select 1 from auth.sessions where id=sid and user_id=uid and(not_after is null or not_after>clock_timestamp())) then
   raise exception using errcode='42501',message='active_session_required'; end if;
 if auth.jwt()->>'exp' is null then raise exception using errcode='42501',message='session_refresh_required'; end if;
 expiry:=least(clock_timestamp()+interval '10 minutes',to_timestamp((auth.jwt()->>'exp')::double precision),(select not_after from auth.sessions where id=sid));
 if expiry<clock_timestamp()+interval '20 seconds' then raise exception using errcode='42501',message='session_refresh_required'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('roomId',r.id,'epoch',r.realtime_epoch,'path','v2/rooms/'||r.id||'/epochs/'||r.realtime_epoch,
   'members',(select jsonb_object_agg(m2.user_id::text,true) from public.room_members m2 where m2.room_id=r.id)) order by r.id),'[]'::jsonb),
   coalesce(jsonb_object_agg(r.id::text,r.realtime_epoch),'{}'::jsonb)
 into streams,room_map from public.rooms r join public.room_members m on m.room_id=r.id where m.user_id=uid and private.firebase_room_is_live(r.id);
 if jsonb_array_length(streams)=0 then return jsonb_build_object('enabled',false); end if;
 perform pg_advisory_xact_lock(hashtextextended('firebase-live-lease:'||uid::text,0));
 insert into private.firebase_live_bootstrap_limits values(uid,clock_timestamp(),1) on conflict(user_id) do update set
 attempts=case when firebase_live_bootstrap_limits.window_started<clock_timestamp()-interval '1 minute' then 1 else firebase_live_bootstrap_limits.attempts+1 end,
 window_started=case when firebase_live_bootstrap_limits.window_started<clock_timestamp()-interval '1 minute' then clock_timestamp() else firebase_live_bootstrap_limits.window_started end
 returning attempts into count_attempts;
 if count_attempts>12 then raise exception using errcode='P0001',message='firebase_bootstrap_rate_limited';end if;
 if (select count(*) from private.firebase_live_leases l where l.user_id=uid and l.auth_session_id<>sid and not private.firebase_live_lease_invalid(l))>=16 then
 raise exception using errcode='P0001',message='firebase_session_limit';end if;
 -- Per-session reuse bounds abandoned RTDB leases and permits safe renewal.
 insert into private.firebase_live_leases(user_id,auth_session_id,expires_at,rooms) values(uid,sid,expiry,room_map)
 on conflict(auth_session_id) do update set expires_at=excluded.expires_at,rooms=excluded.rooms,revision=excluded.revision,cleaned_at=null,
 attempts=case when firebase_live_leases.window_started<clock_timestamp()-interval '1 minute' then 1 else firebase_live_leases.attempts+1 end,
 window_started=case when firebase_live_leases.window_started<clock_timestamp()-interval '1 minute' then clock_timestamp() else firebase_live_leases.window_started end
 returning id,attempts,revision into lid,count_attempts,lease_revision;
 if count_attempts>12 then raise exception using errcode='P0001',message='firebase_bootstrap_rate_limited'; end if;
 return jsonb_build_object('enabled',true,'userId',uid,'sessionId',lid,'leaseExpiresAt',floor(extract(epoch from expiry)*1000),'leaseRevision',lease_revision::text,
 'serverTime',floor(extract(epoch from clock_timestamp())*1000),'streams',streams);
end $$;
revoke all on function public.prepare_firebase_live_lease() from public,anon;
grant execute on function public.prepare_firebase_live_lease() to authenticated;

-- Publication revisions are assigned AFTER commit, under a serial publication
-- lock. Source sequence order is not commit order. Reclaims reuse durable cursors.
create function public.claim_firebase_live(p_worker uuid,p_limit integer default 100)
returns table(id text,revision text,event_id uuid,room_id uuid,epoch bigint,kind text,payload jsonb,occurred_at timestamptz,access jsonb)
language plpgsql security definer set search_path='' as $$
declare q record; current_epoch bigint; live boolean; access_revision bigint; publish_revision bigint;
begin
 if p_worker is null or p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_claim'; end if;
 perform pg_advisory_xact_lock(hashtextextended('firebase-live-publication',0));
 for q in select o.* from private.firebase_live_outbox o where o.delivered_at is null and
 (o.claim_until is null or o.claim_until<clock_timestamp()) order by o.id limit p_limit for update skip locked
 loop
   select r.realtime_epoch into current_epoch from public.rooms r where r.id=q.room_id;
   live:=private.firebase_room_is_live(q.room_id);
   publish_revision:=coalesce(q.publication_revision,nextval('private.firebase_live_revision_seq'));
   access_revision:=nextval('private.firebase_live_revision_seq');
   id:=q.id::text; revision:=publish_revision::text; event_id:=q.event_id; room_id:=q.room_id;
   epoch:=coalesce(current_epoch,q.epoch);kind:=q.kind;payload:=q.payload;occurred_at:=q.occurred_at;
   if q.kind in ('typing_start','typing_stop','character_pulse','character_throw') and
     (not live or q.epoch is distinct from current_epoch or q.occurred_at<clock_timestamp()-interval '5 seconds') then kind:='control';payload:='{}'; end if;
   access:=jsonb_build_object('enabled',live,'epoch',epoch,'revision',access_revision::text,'members',
     coalesce((select jsonb_object_agg(m.user_id::text,true) from public.room_members m where m.room_id=q.room_id),'{}'::jsonb));
   update private.firebase_live_outbox o set publication_revision=publish_revision,claimed_by=p_worker,
     claim_until=clock_timestamp()+interval '30 seconds',attempts=o.attempts+1 where o.id=q.id;
   if q.kind in ('message_changed','structure_changed','messages_pruned') then
     insert into private.firebase_live_cursors values(q.room_id,publish_revision,0)
     on conflict on constraint firebase_live_cursors_pkey do update set high_revision=greatest(firebase_live_cursors.high_revision,excluded.high_revision);
   end if;
   insert into private.firebase_live_epochs values(q.room_id,epoch) on conflict do nothing;
   return next;
 end loop;
end $$;
create function public.finish_firebase_live(p_worker uuid,p_id bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 update private.firebase_live_outbox set delivered_at=clock_timestamp(),claim_until=null
 where id=p_id and claimed_by=p_worker and claim_until>clock_timestamp() and delivered_at is null;
 get diagnostics n=row_count; return n=1;
end $$;
revoke all on function public.claim_firebase_live(uuid,integer),public.finish_firebase_live(uuid,bigint) from public,anon,authenticated;
grant execute on function public.claim_firebase_live(uuid,integer),public.finish_firebase_live(uuid,bigint) to service_role;

-- DB remains the only message source. Clients cannot enumerate another room's
-- changes, and deleted messages are returned as tombstones, never stale bodies.
create function public.firebase_realtime_changes(p_room_id uuid,p_after_revision text default null,p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path='' as $$
declare hi bigint; floor_value bigint; after_value bigint; changes jsonb; cursor_value bigint;
begin
 if auth.uid() is null or not private.is_room_member(p_room_id,auth.uid()) then raise exception using errcode='42501',message='membership_required'; end if;
 if p_limit is null or p_limit not between 1 and 100 or (p_after_revision is not null and p_after_revision !~ '^[0-9]{1,18}$') then raise exception using errcode='22023',message='invalid_cursor'; end if;
 select high_revision,floor_revision into hi,floor_value from private.firebase_live_cursors where room_id=p_room_id for share;
 hi:=coalesce(hi,0);floor_value:=coalesce(floor_value,0);
 if p_after_revision is null then return jsonb_build_object('cursor',hi::text,'resetRequired',false,'changes','[]'::jsonb); end if;
 after_value:=p_after_revision::bigint;
 if after_value<floor_value or after_value>hi then return jsonb_build_object('cursor',hi::text,'resetRequired',true,'changes','[]'::jsonb); end if;
 select coalesce(jsonb_agg(jsonb_build_object('revision',o.publication_revision::text,'kind',o.kind,
 'messageId',o.payload->>'message_id','operation',o.payload->>'operation','message',to_jsonb(m)) order by o.publication_revision),'[]'::jsonb),max(o.publication_revision)
 into changes,cursor_value from (select * from private.firebase_live_outbox where room_id=p_room_id and publication_revision>after_value
 and publication_revision<=hi and kind in ('message_changed','structure_changed','messages_pruned') order by publication_revision limit p_limit) o
 left join public.messages m on m.id=nullif(o.payload->>'message_id','')::uuid and m.room_id=p_room_id;
 return jsonb_build_object('cursor',coalesce(cursor_value,hi)::text,'resetRequired',false,'changes',changes);
end $$;
revoke all on function public.firebase_realtime_changes(uuid,text,integer) from public,anon;
grant execute on function public.firebase_realtime_changes(uuid,text,integer) to authenticated;

create function private.firebase_live_lease_invalid(p private.firebase_live_leases)
returns boolean language sql stable security definer set search_path='' as $$
 select p.expires_at<=clock_timestamp() or not exists(select 1 from auth.sessions where id=p.auth_session_id and user_id=p.user_id and(not_after is null or not_after>clock_timestamp()))
 or not exists(select 1 from private.firebase_live_config where enabled)
 or not exists(select 1 from private.firebase_live_users where user_id=p.user_id and enabled)
$$;
revoke all on function private.firebase_live_lease_invalid(private.firebase_live_leases) from public,anon,authenticated;
create function public.firebase_live_maintenance(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_limit'; end if;
 perform pg_advisory_xact_lock(hashtextextended('firebase-live-publication',0));
 select jsonb_build_object(
 'leases',coalesce((select jsonb_agg(jsonb_build_object('user_id',l.user_id,'session_id',l.id,'expires_at',floor(extract(epoch from l.expires_at)*1000),'rooms',l.rooms,'revision',l.revision::text,'purge',l.expires_at<clock_timestamp()-interval '1 minute')) from
 (select * from private.firebase_live_leases p where private.firebase_live_lease_invalid(p) and (p.cleaned_at is null or p.cleaned_at<clock_timestamp()-interval '5 seconds') order by coalesce(p.cleaned_at,'-infinity'::timestamptz),expires_at limit p_limit) l),'[]'::jsonb),
 'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id::text,'room_id',e.room_id,'epoch',e.epoch,'event_id',e.event_id,'expires_at',floor(extract(epoch from e.occurred_at)*1000)+5000)) from
 (select * from private.firebase_live_outbox where kind in ('typing_start','typing_stop','character_pulse','character_throw') and occurred_at<clock_timestamp()-interval '5 seconds' and delivered_at is not null and cleaned_at is null order by id limit p_limit) e),'[]'::jsonb),
 'epochs',coalesce((select jsonb_agg(jsonb_build_object('room_id',e.room_id,'epoch',e.epoch)) from
 (select * from private.firebase_live_epochs e where not exists(select 1 from public.rooms r where r.id=e.room_id and r.realtime_epoch<=e.epoch) and not exists(select 1 from private.firebase_live_outbox o where o.room_id=e.room_id and o.claim_until>clock_timestamp()-interval '30 seconds') limit p_limit) e),'[]'::jsonb)) into result;
 -- Only acknowledged rows are pruned. Advance a per-room reset floor before
 -- deletion so offline clients never silently skip a retention gap.
 with doomed as (select * from private.firebase_live_outbox where delivered_at<clock_timestamp()-interval '15 minutes'
 and (kind not in ('typing_start','typing_stop','character_pulse','character_throw') or cleaned_at is not null) order by id limit 1000),
 floors as (insert into private.firebase_live_cursors(room_id,high_revision,floor_revision)
 select room_id,max(publication_revision),max(publication_revision) from doomed where kind in ('message_changed','structure_changed','messages_pruned') group by room_id
 on conflict(room_id) do update set floor_revision=greatest(firebase_live_cursors.floor_revision,excluded.floor_revision) returning room_id)
 delete from private.firebase_live_outbox where id in(select id from doomed);
 return result;
end $$;
create function public.finish_firebase_live_cleanup(p_kind text,p_id text,p_room_id uuid default null,p_epoch bigint default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('firebase-live-publication',0));
 if p_kind='lease' then
 delete from private.firebase_live_leases l where l.id=p_id::uuid and l.expires_at<clock_timestamp()-interval '1 minute' and private.firebase_live_lease_invalid(l);
 update private.firebase_live_leases l set cleaned_at=clock_timestamp() where l.id=p_id::uuid and private.firebase_live_lease_invalid(l);
 elsif p_kind='event' then update private.firebase_live_outbox set cleaned_at=clock_timestamp() where id=p_id::bigint and occurred_at<clock_timestamp()-interval '5 seconds' and delivered_at is not null;
 elsif p_kind='epoch' then delete from private.firebase_live_epochs e where e.room_id=p_room_id and e.epoch=p_epoch and not exists(select 1 from public.rooms r where r.id=e.room_id and r.realtime_epoch<=e.epoch) and not exists(select 1 from private.firebase_live_outbox o where o.room_id=e.room_id and o.claim_until>clock_timestamp()-interval '30 seconds');
 else raise exception 'invalid_cleanup_kind';end if;
end $$;
revoke all on function public.firebase_live_maintenance(integer),public.finish_firebase_live_cleanup(text,text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.firebase_live_maintenance(integer),public.finish_firebase_live_cleanup(text,text,uuid,bigint) to service_role;

create or replace function private.broadcast_room_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_room_id uuid := coalesce(new.room_id, old.room_id);
  changed_id uuid := coalesce(new.id, old.id);
  epoch bigint;
begin
  if current_setting('sidey.suppress_message_broadcast', true) = 'on' then
    return null;
  end if;
  select realtime_epoch into epoch from public.rooms where id = changed_room_id;
  if epoch is null then return null; end if;
  perform private.route_realtime(
    jsonb_build_object(
      'room_id', changed_room_id,
      'message_id', changed_id,
      'operation', tg_op
    ),
    'message_changed',
    private.room_topic(changed_room_id, epoch, 'db'),
    true
  );
  return null;
end;
$$;

create or replace function private.broadcast_room_record_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_room_id uuid := coalesce(new.id, old.id);
  epoch bigint := coalesce(new.realtime_epoch, old.realtime_epoch);
begin
  if current_setting('sidey.suppress_room_broadcast', true) = 'on' then
    return null;
  end if;
  perform private.route_realtime(
    jsonb_build_object(
      'room_id', changed_room_id,
      'entity', 'rooms',
      'operation', tg_op,
      'realtime_epoch', epoch
    ),
    'structure_changed',
    private.room_topic(changed_room_id, epoch, 'db'),
    true
  );
  return null;
end;
$$;

create or replace function private.broadcast_membership_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_room_id uuid := coalesce(new.room_id, old.room_id);
  previous_epoch bigint;
  next_epoch bigint;
begin
  select realtime_epoch into previous_epoch
  from public.rooms where id = changed_room_id for update;
  if previous_epoch is null then return null; end if;

  perform private.route_realtime(
    jsonb_build_object(
      'room_id', changed_room_id,
      'entity', 'room_members',
      'operation', tg_op,
      'realtime_epoch', previous_epoch + 1
    ),
    'structure_changed',
    private.room_topic(changed_room_id, previous_epoch, 'db'),
    true
  );

  perform set_config('sidey.suppress_room_broadcast', 'on', true);
  update public.rooms
  set realtime_epoch = realtime_epoch + 1
  where id = changed_room_id
  returning realtime_epoch into next_epoch;
  perform set_config('sidey.suppress_room_broadcast', 'off', true);
  return null;
end;
$$;

create or replace function private.broadcast_profile_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  membership record;
begin
  for membership in
    select rooms.id as room_id, rooms.realtime_epoch
    from public.room_members
    join public.rooms on rooms.id = room_members.room_id
    where room_members.user_id = coalesce(new.id, old.id)
  loop
    perform private.route_realtime(
      jsonb_build_object(
        'room_id', membership.room_id,
        'entity', 'profiles',
        'operation', tg_op,
        'realtime_epoch', membership.realtime_epoch
      ),
      'structure_changed',
      private.room_topic(membership.room_id, membership.realtime_epoch, 'db'),
      true
    );
  end loop;
  return null;
end;
$$;

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
  current_epoch bigint;
  recent_attempts integer;
  rate_window interval;
  rate_limit integer;
begin
  if current_user_id is null then
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
    rate_window := interval '10 seconds';
    rate_limit := 5;
  else
    rate_window := interval '1 minute';
    rate_limit := 40;
  end if;
  select count(*) into recent_attempts
  from private.realtime_event_attempts
  where user_id = current_user_id
    and room_id = p_room_id
    and event_name = p_event
    and attempted_at >= now() - rate_window;
  if recent_attempts >= rate_limit then
    raise exception using errcode = 'P0001', message = 'realtime_event_rate_limited';
  end if;
  insert into private.realtime_event_attempts (user_id, room_id, event_name)
  values (current_user_id, p_room_id, p_event);

  perform private.route_realtime(
    jsonb_strip_nulls(jsonb_build_object(
      'room_id', p_room_id,
      'user_id', current_user_id,
      'event_id', p_event_id
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
  current_epoch bigint;
  source_character_id text;
  selected_throwable_id text;
  recent_attempts integer;
begin
  if current_user_id is null then
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
  from public.rooms
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
  from public.profiles
  where profiles.id = current_user_id;
  if source_character_id is null then
    raise exception using errcode = 'P0001', message = 'profile_required';
  end if;
  select coalesce((select products.render_asset_id from public.commerce_products products
    where products.catalog_item_id=private.owned_equipped_catalog_item(current_user_id,'throwable')
      and products.product_kind='throwable' and products.active), 'patch_soft_ball') into selected_throwable_id;

  perform pg_advisory_xact_lock(hashtextextended(
    'event:' || current_user_id::text || ':character_throw', 0
  ));
  select count(*) into recent_attempts
  from private.realtime_event_attempts
  where user_id = current_user_id
    and event_name = 'character_throw'
    and attempted_at >= now() - interval '10 seconds';
  if recent_attempts >= 20 then
    raise exception using errcode = 'P0001', message = 'realtime_event_rate_limited';
  end if;
  insert into private.realtime_event_attempts (user_id, room_id, event_name)
  values (current_user_id, p_room_id, 'character_throw');

  perform private.route_realtime(
    jsonb_strip_nulls(jsonb_build_object(
      'schema_version', 1,
      'room_id', p_room_id,
      'event_id', p_event_id,
      'actor_user_id', current_user_id,
      'target_user_id', p_target_user_id,
      'source_character_id', source_character_id,
      'throwable_id', selected_throwable_id
    )),
    'character_throw',
    private.room_topic(p_room_id, current_epoch, 'ephemeral'),
    true
  );
end;
$$;

create or replace function private.delete_expired_messages()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
  changed_room_id uuid;
  changed_room_ids uuid[];
  epoch bigint;
begin
  perform set_config('sidey.suppress_message_broadcast', 'on', true);
  with deleted as (
    delete from public.messages
    where created_at < now() - interval '3 days'
    returning room_id
  )
  select count(*), array_agg(distinct room_id)
  into deleted_count, changed_room_ids
  from deleted;
  perform set_config('sidey.suppress_message_broadcast', 'off', true);

  foreach changed_room_id in array coalesce(changed_room_ids, array[]::uuid[])
  loop
    select realtime_epoch into epoch from public.rooms where id = changed_room_id;
    if epoch is not null then
      perform private.route_realtime(
        jsonb_build_object('room_id', changed_room_id),
        'messages_pruned',
        private.room_topic(changed_room_id, epoch, 'db'),
        true
      );
    end if;
  end loop;
  return deleted_count;
end;
$$;

commit;
