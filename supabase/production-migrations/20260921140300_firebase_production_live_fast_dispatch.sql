-- Forward-only optimization. The existing staging gate remains OFF unless explicitly enabled.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- No room FK/cascade: a deleted room's disabled snapshot is a durable revision fence.
-- Only claim_firebase_live mutates this table under the existing global publication lock.
create table private.firebase_live_access_snapshots(
 room_id uuid primary key,snapshot jsonb not null,revision bigint not null check(revision>0)
);
revoke all on private.firebase_live_access_snapshots from public,anon,authenticated;

create or replace function public.claim_firebase_live(p_worker uuid,p_limit integer default 100)
returns table(id text,revision text,event_id uuid,room_id uuid,epoch bigint,kind text,payload jsonb,occurred_at timestamptz,access jsonb)
language plpgsql security definer set search_path='' as $$
declare q record; current_epoch bigint; live boolean; access_revision bigint; publish_revision bigint; members jsonb; snapshot jsonb; previous private.firebase_live_access_snapshots;
begin
 if p_worker is null or p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_claim'; end if;
 perform pg_advisory_xact_lock(hashtextextended('firebase-live-publication',0));
 for q in select o.* from private.firebase_live_outbox o where o.delivered_at is null and
 (o.claim_until is null or o.claim_until<clock_timestamp()) order by o.id limit p_limit for update skip locked
 loop
   -- One SQL statement gives epoch, cohort decision and members one MVCC snapshot.
   select (select r.realtime_epoch from public.rooms r where r.id=q.room_id),
     private.firebase_room_is_live(q.room_id),
     coalesce((select jsonb_object_agg(m.user_id::text,true) from public.room_members m where m.room_id=q.room_id),'{}'::jsonb)
     into current_epoch,live,members;
   publish_revision:=coalesce(q.publication_revision,nextval('private.firebase_live_revision_seq'));
   id:=q.id::text; revision:=publish_revision::text; event_id:=q.event_id; room_id:=q.room_id;
   epoch:=coalesce(current_epoch,q.epoch);kind:=q.kind;payload:=q.payload;occurred_at:=q.occurred_at;
   if q.kind in ('typing_start','typing_stop','character_pulse','character_throw') and
     (not live or q.epoch is distinct from current_epoch or q.occurred_at<clock_timestamp()-interval '5 seconds') then kind:='control';payload:='{}'; end if;
   snapshot:=jsonb_build_object('enabled',live,'epoch',epoch,'members',members);
   select s.* into previous from private.firebase_live_access_snapshots s where s.room_id=q.room_id;
   if not found or previous.snapshot is distinct from snapshot then
     access_revision:=nextval('private.firebase_live_revision_seq');
     insert into private.firebase_live_access_snapshots as s(room_id,snapshot,revision)
       values(q.room_id,snapshot,access_revision)
       on conflict on constraint firebase_live_access_snapshots_pkey
       do update set snapshot=excluded.snapshot,revision=excluded.revision;
   else access_revision:=previous.revision;
   end if;
   access:=snapshot||jsonb_build_object('revision',access_revision::text);
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

-- Source transactions already hold application/outbox locks. Never wait for the
-- scheduler's config/state locks here: finish may need those same outbox rows.
-- The exception block rolls back partial locks and pg_net queue writes on failure.
-- pg_net starts HTTP only after commit, so a rolled-back message cannot wake a worker.
create function private.try_dispatch_firebase_live()
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform 1 from private.firebase_live_dispatch_config where id for update nowait;
 perform 1 from private.firebase_live_dispatch_state where id for update nowait;
 return private.dispatch_firebase_live();
exception
 when lock_not_available then return jsonb_build_object('scheduled',false,'reason','contended');
 when others then return jsonb_build_object('scheduled',false,'reason','deferred_to_cron');
end $$;
revoke all on function private.try_dispatch_firebase_live() from public,anon,authenticated;

create function private.wake_firebase_live_after_insert()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform private.try_dispatch_firebase_live();
 return null;
end $$;
revoke all on function private.wake_firebase_live_after_insert() from public,anon,authenticated;
create trigger firebase_live_outbox_wake after insert on private.firebase_live_outbox
 for each statement execute function private.wake_firebase_live_after_insert();

create or replace function public.finish_firebase_live_dispatch(p_dispatch uuid,p_success boolean,p_stats jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare state private.firebase_live_dispatch_state; metric text; value bigint; totals jsonb;
 allowed constant text[]:=array['claimed','completed','published','expired','suppressed','retries','cleanupSelected','cleanupCompleted',
 'cleanupRetries','httpRequests','responseBodyBytes','rtdbResponseBodyBytes','supabaseResponseBodyBytes','googleAuthResponseBodyBytes','elapsedMs',
 'supabaseRequests','rtdbRequests','googleAuthRequests','supabaseRequestMs','rtdbRequestMs','googleAuthRequestMs',
 'supabaseRequestMaxMs','rtdbRequestMaxMs','googleAuthRequestMaxMs'];
begin
 if p_dispatch is null or p_success is null or p_stats is null or jsonb_typeof(p_stats)<>'object' or pg_column_size(p_stats)>4096 then raise exception 'invalid_dispatch_stats'; end if;
 for metric in select jsonb_object_keys(p_stats) loop
   if not(metric=any(allowed)) or jsonb_typeof(p_stats->metric)<>'number' or (p_stats->>metric)!~'^[0-9]{1,10}$'
     or (p_stats->>metric)::bigint>1073741824 then raise exception 'invalid_dispatch_stats'; end if;
 end loop;
 -- Same config -> state order as begin/dispatcher. An INSERT wake never waits on these locks.
 perform 1 from private.firebase_live_dispatch_config where id for update;
 select * into state from private.firebase_live_dispatch_state where id for update;
 if state.dispatch_id is distinct from p_dispatch or state.phase is distinct from 'running' then return false; end if;
 -- A late but still current invocation may report completion after expiry; it must never complete a replacement dispatch.
 totals:=state.cumulative_totals;
 foreach metric in array allowed loop
   value:=coalesce((p_stats->>metric)::bigint,0);
   if metric like '%RequestMaxMs' then
     totals:=jsonb_set(totals,array[metric],to_jsonb(greatest(coalesce((totals->>metric)::bigint,0),value)));
   else totals:=jsonb_set(totals,array[metric],to_jsonb(coalesce((totals->>metric)::bigint,0)+value)); end if;
 end loop;
 -- All remote work has settled before this call. Unfinished rows remain durable and become immediately reclaimable.
 update private.firebase_live_outbox set claim_until=null where claimed_by=p_dispatch and delivered_at is null;
 update private.firebase_live_dispatch_state set phase=null,expires_at=clock_timestamp(),finished_count=finished_count+1,
   last_finished_at=clock_timestamp(),last_result=p_stats||jsonb_build_object('success',p_success),cumulative_totals=totals where id;
 -- Only a successful completed invocation can chain publication work. Maintenance-only
 -- work and retries wait for the recovery cron; they cannot create a hot invocation loop.
 if p_success and exists(select 1 from private.firebase_live_outbox o where o.delivered_at is null
   and (o.claim_until is null or o.claim_until<clock_timestamp())) then
   perform private.try_dispatch_firebase_live();
 end if;
 return true;
end $$;
revoke all on function public.finish_firebase_live_dispatch(uuid,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.finish_firebase_live_dispatch(uuid,boolean,jsonb) to service_role;
commit;
