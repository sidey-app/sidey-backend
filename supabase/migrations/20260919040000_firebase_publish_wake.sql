-- A best-effort authenticated fast wake. Durable pg_net scheduling remains the fallback.
-- No rollout, cron, secret or remote deployment is enabled by this migration.
begin;
alter table private.firebase_live_outbox add column publish_wake_requested_at timestamptz;

alter function public.prepare_firebase_live_lease() set schema private;
alter function private.prepare_firebase_live_lease() rename to prepare_firebase_live_lease_before_wake;
revoke all on function private.prepare_firebase_live_lease_before_wake() from public,anon,authenticated,service_role;
create function public.prepare_firebase_live_lease()
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 result:=private.prepare_firebase_live_lease_before_wake();
 if result->>'enabled'='true' and exists(select 1 from private.firebase_live_config where enabled and direct_events_enabled) then
   result:=result||jsonb_build_object('publisherWake',jsonb_build_object('endpoint','realtime-wake','protocolVersion',1));
 end if;
 return result;
end $$;
revoke all on function public.prepare_firebase_live_lease() from public,anon;
grant execute on function public.prepare_firebase_live_lease() to authenticated;

create function public.authorize_firebase_publish_wake(p_room_id uuid,p_epoch bigint,p_message_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); sid uuid; ep bigint; pending private.firebase_live_outbox;
 cfg private.firebase_live_dispatch_config; state private.firebase_live_dispatch_state;
begin
 if uid is null then raise exception using errcode='42501',message='authentication_required'; end if;
 sid:=nullif(auth.jwt()->>'session_id','')::uuid;
 perform 1 from auth.sessions where id=sid and user_id=uid and(not_after is null or not_after>clock_timestamp()) for key share;
 if not found or nullif(auth.jwt()->>'exp','') is null or to_timestamp((auth.jwt()->>'exp')::double precision)<=clock_timestamp() then
   raise exception using errcode='42501',message='active_session_required'; end if;
 if p_room_id is null or p_epoch is null or p_epoch<1 or p_message_id is null then
   raise exception using errcode='22023',message='invalid_publish_wake'; end if;
 -- Same source-config -> room lock order as direct authorization and rollout.
 perform 1 from private.firebase_live_config where enabled and direct_events_enabled for share;
 if not found then raise exception using errcode='42501',message='publisher_wake_disabled'; end if;
 select realtime_epoch into ep from public.rooms where id=p_room_id for share;
 if ep is null or not private.is_room_member(p_room_id,uid) then raise exception using errcode='42501',message='membership_required'; end if;
 if ep<>p_epoch then raise exception using errcode='PT409',message='stale_realtime_epoch'; end if;
 if not private.firebase_room_is_live(p_room_id) then raise exception using errcode='42501',message='publisher_wake_disabled'; end if;
 if not exists(select 1 from private.firebase_live_leases l where l.auth_session_id=sid and l.user_id=uid
   and l.expires_at>clock_timestamp() and l.rooms->>p_room_id::text=p_epoch::text and not private.firebase_live_lease_invalid(l)) then
   raise exception using errcode='42501',message='session_refresh_required'; end if;
 if not exists(select 1 from public.messages m where m.id=p_message_id and m.room_id=p_room_id and m.sender_id=uid) then
   raise exception using errcode='42501',message='message_ownership_required'; end if;
 -- No caller chooses a dispatch ID, claims work, receives payloads or gets a secret.
 -- Serialize only the fast-wake rate ledger. Contention leaves the normal scheduler intact.
 if not pg_try_advisory_xact_lock(hashtextextended('firebase-publish-wake:'||uid::text,0)) then
   return jsonb_build_object('reason','contended'); end if;
 begin
   select o.* into pending from private.firebase_live_outbox o where o.room_id=p_room_id
     and o.kind='message_changed' and o.payload->>'message_id'=p_message_id::text
     and o.payload->>'operation'='INSERT' order by o.id limit 1 for update nowait;
 exception when lock_not_available then return jsonb_build_object('reason','contended'); end;
 if not found or pending.delivered_at is not null then return jsonb_build_object('reason','delivered'); end if;
 if pending.publish_wake_requested_at is not null then return jsonb_build_object('reason','duplicate'); end if;
 -- Optimization only: excess wakes leave the already-committed message/outbox unchanged.
 if (select count(*) from private.realtime_event_attempts where user_id=uid and event_name='firebase_publish_wake'
     and attempted_at>=clock_timestamp()-interval '1 minute')>=30 then
   raise exception using errcode='PT429',message='publisher_wake_rate_limited'; end if;
 insert into private.realtime_event_attempts(user_id,room_id,event_name) values(uid,p_room_id,'firebase_publish_wake');
 update private.firebase_live_outbox set publish_wake_requested_at=clock_timestamp() where id=pending.id;
 begin
   -- Existing publisher finish/stop lock config -> state -> outbox. We already
   -- hold source locks, so NOWAIT is essential: never wait on the inverse order.
   select * into cfg from private.firebase_live_dispatch_config where id for update nowait;
   select * into state from private.firebase_live_dispatch_state where id for update nowait;
   if not cfg.enabled or cfg.owner_run_id is null or cfg.run_deadline_at<=clock_timestamp() then
     return jsonb_build_object('reason','disabled'); end if;
   if state.phase='running' then return jsonb_build_object('reason','running'); end if;
   if state.phase is distinct from 'queued' or state.expires_at<=clock_timestamp()
     or state.owner_run_id is distinct from cfg.owner_run_id then
     perform private.try_dispatch_firebase_live();
     select * into state from private.firebase_live_dispatch_state where id;
   end if;
   if state.phase='queued' and state.expires_at>clock_timestamp() and state.owner_run_id=cfg.owner_run_id then
     return jsonb_build_object('reason','queued','dispatchId',state.dispatch_id);
   end if;
   return jsonb_build_object('reason','unavailable');
 exception when lock_not_available then return jsonb_build_object('reason','contended'); end;
end $$;
revoke all on function public.authorize_firebase_publish_wake(uuid,bigint,uuid) from public,anon;
grant execute on function public.authorize_firebase_publish_wake(uuid,bigint,uuid) to authenticated;
commit;
