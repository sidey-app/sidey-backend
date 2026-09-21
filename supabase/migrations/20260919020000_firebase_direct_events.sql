-- Staging-only direct transient validation. This is metadata for dedup/cleanup,
-- never a payload outbox, publication claim or delivery retry queue.
begin;
alter table private.firebase_live_config add column direct_events_enabled boolean not null default false;
create table private.firebase_direct_events (
 event_id uuid primary key, room_id uuid not null, epoch bigint not null,
 user_id uuid not null, auth_session_id uuid not null, kind text not null,
 revision bigint not null, occurred_at timestamptz not null, expires_at timestamptz not null,
 cleaned_at timestamptz,
 check(kind in ('typing_start','typing_stop','character_pulse','character_throw'))
);
create index firebase_direct_events_cleanup on private.firebase_direct_events(expires_at) where cleaned_at is null;
create table private.firebase_direct_typing_sequences (
 auth_session_id uuid references auth.sessions(id) on delete cascade,
 room_id uuid references public.rooms(id) on delete cascade,
 sequence bigint not null check(sequence>0), primary key(auth_session_id,room_id)
);
revoke all on private.firebase_direct_events,private.firebase_direct_typing_sequences from public,anon,authenticated;

alter function public.prepare_firebase_live_lease() set schema private;
alter function private.prepare_firebase_live_lease() rename to prepare_firebase_live_lease_before_direct;
revoke all on function private.prepare_firebase_live_lease_before_direct() from public,anon,authenticated,service_role;
create function public.prepare_firebase_live_lease()
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 result:=private.prepare_firebase_live_lease_before_direct();
 if result->>'enabled'='true' and exists(select 1 from private.firebase_live_config where enabled and direct_events_enabled) then
   result:=result||jsonb_build_object('directEvents',jsonb_build_object('endpoint','realtime-event','protocolVersion',1));
 end if;
 return result;
end $$;
revoke all on function public.prepare_firebase_live_lease() from public,anon;
grant execute on function public.prepare_firebase_live_lease() to authenticated;

create function public.authorize_firebase_direct_event(p_room_id uuid,p_epoch bigint,p_event_id uuid,p_kind text,
 p_target_user_id uuid default null,p_sequence text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); sid uuid; ep bigint; attempts integer; max_attempts integer; rate_window interval;
 at_time timestamptz; rev bigint; accepted_sequence bigint; source_character text; throwable text; payload jsonb;
begin
 if uid is null then raise exception using errcode='42501',message='authentication_required'; end if;
 sid:=nullif(auth.jwt()->>'session_id','')::uuid;
 perform 1 from auth.sessions where id=sid and user_id=uid and(not_after is null or not_after>clock_timestamp()) for key share;
 if not found or nullif(auth.jwt()->>'exp','') is null or to_timestamp((auth.jwt()->>'exp')::double precision)<=clock_timestamp() then
   raise exception using errcode='42501',message='active_session_required'; end if;
 if p_room_id is null or p_epoch is null or p_epoch<1 or p_event_id is null or p_kind is null
   or p_kind not in ('typing_start','typing_stop','character_pulse','character_throw')
   or (p_kind='character_throw' and (p_target_user_id is null or p_target_user_id=uid))
   or (p_kind<>'character_throw' and p_target_user_id is not null)
   or (p_kind in ('typing_start','typing_stop') and (p_sequence is null or p_sequence!~'^[1-9][0-9]{0,18}$'))
   or (p_kind not in ('typing_start','typing_stop') and p_sequence is not null) then
   raise exception using errcode='22023',message='invalid_realtime_event'; end if;
 if p_sequence is not null and p_sequence::numeric>9223372036854775807 then
   raise exception using errcode='22023',message='invalid_realtime_event'; end if;
 -- Match rollout's config -> room lock order; never invert it during disable.
 perform 1 from private.firebase_live_config where enabled and direct_events_enabled for share;
 if not found then raise exception using errcode='42501',message='direct_events_disabled'; end if;
 -- Membership changes take the room update lock. The snapshot cannot change within this authorization transaction.
 select realtime_epoch into ep from public.rooms where id=p_room_id for share;
 if ep is null or not private.is_room_member(p_room_id,uid) then raise exception using errcode='42501',message='membership_required'; end if;
 if ep<>p_epoch then raise exception using errcode='PT409',message='stale_realtime_epoch'; end if;
 if not private.firebase_room_is_live(p_room_id) then raise exception using errcode='42501',message='direct_events_disabled'; end if;
 if not exists(select 1 from private.firebase_live_leases l where l.auth_session_id=sid and l.user_id=uid
   and l.expires_at>clock_timestamp() and l.rooms->>p_room_id::text=p_epoch::text and not private.firebase_live_lease_invalid(l)) then
   raise exception using errcode='42501',message='session_refresh_required'; end if;
 if p_kind='character_throw' and not private.is_room_member(p_room_id,p_target_user_id) then
   raise exception using errcode='42501',message='target_membership_required'; end if;
 -- Same lock/key and rate ledger as the legacy RPC, so alternating endpoints cannot evade limits.
 perform pg_advisory_xact_lock(hashtextextended(case when p_kind='character_throw' then 'event:'||uid::text||':character_throw'
   else 'event:'||uid::text||':'||p_room_id::text||':'||p_kind end,0));
 perform pg_advisory_xact_lock(hashtextextended('firebase-direct-event:'||p_event_id::text,0));
 if exists(select 1 from private.firebase_direct_events where event_id=p_event_id) then
   raise exception using errcode='PT409',message='duplicate_event'; end if;
 if p_kind in ('typing_start','typing_stop') then
   insert into private.firebase_direct_typing_sequences values(sid,p_room_id,p_sequence::bigint)
   on conflict(auth_session_id,room_id) do update set sequence=excluded.sequence
     where firebase_direct_typing_sequences.sequence<excluded.sequence returning sequence into accepted_sequence;
   if accepted_sequence is null then raise exception using errcode='PT409',message='stale_typing_sequence'; end if;
 end if;
 rate_window:=case when p_kind in ('character_throw','character_pulse') then interval '10 seconds' else interval '1 minute' end;
 max_attempts:=case when p_kind='character_throw' then 20 when p_kind='character_pulse' then 5 else 40 end;
 select count(*) into attempts from private.realtime_event_attempts where user_id=uid and event_name=p_kind
   and(p_kind='character_throw' or room_id=p_room_id) and attempted_at>=clock_timestamp()-rate_window;
 if attempts>=max_attempts then raise exception using errcode='P0001',message='realtime_event_rate_limited'; end if;
 insert into private.realtime_event_attempts(user_id,room_id,event_name) values(uid,p_room_id,p_kind);
 if p_kind='character_throw' then
   select character_id into source_character from public.profiles where id=uid;
   if source_character is null then raise exception using errcode='22023',message='invalid_realtime_event'; end if;
   -- Ignore all client item/actor fields. Revoked or unowned equipment resolves to the default ball.
   select coalesce((select render_asset_id from public.commerce_products where product_kind='throwable' and active
     and catalog_item_id=private.owned_equipped_catalog_item(uid,'throwable')),'patch_soft_ball') into throwable;
   payload:=jsonb_build_object('schema_version',1,'room_id',p_room_id,'event_id',p_event_id,'actor_user_id',uid,
     'target_user_id',p_target_user_id,'source_character_id',source_character,'throwable_id',throwable);
 else payload:=jsonb_build_object('room_id',p_room_id,'user_id',uid,'event_id',p_event_id); end if;
 at_time:=clock_timestamp(); rev:=nextval('private.firebase_live_revision_seq');
 insert into private.firebase_direct_events(event_id,room_id,epoch,user_id,auth_session_id,kind,revision,occurred_at,expires_at)
 values(p_event_id,p_room_id,p_epoch,uid,sid,p_kind,rev,at_time,at_time+interval '5 seconds');
 insert into private.firebase_live_epochs values(p_room_id,p_epoch) on conflict do nothing;
 return jsonb_build_object('event_id',p_event_id,'room_id',p_room_id,'epoch',p_epoch,'kind',p_kind,
   'revision',rev::text,'payload',payload,'occurred_at',at_time);
end $$;
revoke all on function public.authorize_firebase_direct_event(uuid,bigint,uuid,text,uuid,text) from public,anon;
grant execute on function public.authorize_firebase_direct_event(uuid,bigint,uuid,text,uuid,text) to authenticated;

-- Legacy and direct transient revisions share authorization order. A start queued
-- before capability renewal must not acquire a newer revision than a direct stop.
update private.firebase_live_outbox set publication_revision=nextval('private.firebase_live_revision_seq')
 where publication_revision is null and kind in ('typing_start','typing_stop','character_pulse','character_throw');
create or replace function private.route_realtime(p_payload jsonb,p_event text,p_topic text,p_private boolean)
returns void language plpgsql security definer set search_path='' as $$
declare rid uuid; ep bigint; live boolean;
begin
 rid:=split_part(p_topic,':',2)::uuid; ep:=split_part(p_topic,':',3)::bigint;
 live:=private.firebase_room_is_live(rid);
 if not live then perform realtime.send(p_payload,p_event,p_topic,p_private); end if;
 if live or(p_event='structure_changed' and exists(select 1 from private.firebase_live_rooms where room_id=rid)) then
   insert into private.firebase_live_outbox(room_id,epoch,kind,payload,publication_revision)
   values(rid,ep,case when live then p_event else 'control' end,p_payload,
     case when live and p_event in ('typing_start','typing_stop','character_pulse','character_throw')
       then nextval('private.firebase_live_revision_seq') else null end);
 end if;
end $$;

alter function private.firebase_live_dispatch_has_work() rename to firebase_live_dispatch_has_work_before_direct;
create function private.firebase_live_dispatch_has_work()
returns boolean language sql security definer set search_path='' as $$
 select private.firebase_live_dispatch_has_work_before_direct()
 or exists(select 1 from private.firebase_direct_events where
   (cleaned_at is null and expires_at<clock_timestamp()-interval '30 seconds')
   or(cleaned_at is not null and expires_at<clock_timestamp()-interval '15 minutes'))
$$;
revoke all on function private.firebase_live_dispatch_has_work() from public,anon,authenticated;

alter function public.firebase_live_maintenance(integer) set schema private;
alter function private.firebase_live_maintenance(integer) rename to firebase_live_maintenance_before_direct;
revoke all on function private.firebase_live_maintenance_before_direct(integer) from public,anon,authenticated,service_role;
create function public.firebase_live_maintenance(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 result:=private.firebase_live_maintenance_before_direct(p_limit);
 -- 30 seconds exceeds the bounded gateway HTTP lifetime. Do not delete an epoch under an in-flight direct write.
 result:=jsonb_set(result,'{epochs}',coalesce((select jsonb_agg(e) from jsonb_array_elements(result->'epochs') e
   where not exists(select 1 from private.firebase_direct_events d where d.room_id=(e->>'room_id')::uuid
     and d.epoch=(e->>'epoch')::bigint and d.expires_at>=clock_timestamp()-interval '30 seconds')),'[]'::jsonb));
 result:=result||jsonb_build_object('directEvents',coalesce((select jsonb_agg(jsonb_build_object('id',d.event_id,
   'event_id',d.event_id,'room_id',d.room_id,'epoch',d.epoch,'expires_at',floor(extract(epoch from d.expires_at)*1000)))
   from(select * from private.firebase_direct_events where cleaned_at is null and expires_at<clock_timestamp()-interval '30 seconds'
     order by expires_at limit p_limit) d),'[]'::jsonb));
 delete from private.firebase_direct_events where event_id in(select event_id from private.firebase_direct_events
   where cleaned_at is not null and expires_at<clock_timestamp()-interval '15 minutes' order by expires_at limit 1000);
 return result;
end $$;
alter function public.finish_firebase_live_cleanup(text,text,uuid,bigint) set schema private;
alter function private.finish_firebase_live_cleanup(text,text,uuid,bigint) rename to finish_firebase_live_cleanup_before_direct;
revoke all on function private.finish_firebase_live_cleanup_before_direct(text,text,uuid,bigint) from public,anon,authenticated,service_role;
create function public.finish_firebase_live_cleanup(p_kind text,p_id text,p_room_id uuid default null,p_epoch bigint default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_kind='direct_event' then
   update private.firebase_direct_events set cleaned_at=clock_timestamp() where event_id=p_id::uuid
     and expires_at<clock_timestamp()-interval '30 seconds';
 elsif p_kind='epoch' and exists(select 1 from private.firebase_direct_events where room_id=p_room_id and epoch=p_epoch
   and expires_at>=clock_timestamp()-interval '30 seconds') then return;
 else perform private.finish_firebase_live_cleanup_before_direct(p_kind,p_id,p_room_id,p_epoch); end if;
end $$;
revoke all on function public.firebase_live_maintenance(integer),public.finish_firebase_live_cleanup(text,text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.firebase_live_maintenance(integer),public.finish_firebase_live_cleanup(text,text,uuid,bigint) to service_role;
commit;
