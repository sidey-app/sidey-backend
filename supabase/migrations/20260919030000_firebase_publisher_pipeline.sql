-- Forward-only publisher pipeline. Does not enable dispatch or deploy an endpoint.
begin;

-- Access changes precede hints, including when older message work fills a batch.
create or replace function public.claim_firebase_live(p_worker uuid,p_limit integer default 100)
returns table(id text,revision text,event_id uuid,room_id uuid,epoch bigint,kind text,payload jsonb,occurred_at timestamptz,access jsonb)
language plpgsql security definer set search_path='' as $$
declare q record; current_epoch bigint; live boolean; access_revision bigint; publish_revision bigint; members jsonb; snapshot jsonb; previous private.firebase_live_access_snapshots;
begin
 if p_worker is null or p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_claim'; end if;
 perform pg_advisory_xact_lock(hashtextextended('firebase-live-publication',0));
 for q in select o.* from private.firebase_live_outbox o where o.delivered_at is null and
 (o.claim_until is null or o.claim_until<clock_timestamp()) order by (o.kind in ('control','structure_changed')) desc,o.id limit p_limit for update skip locked
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


create function public.begin_claim_firebase_live_dispatch(p_dispatch uuid,p_limit integer default 25)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rows jsonb;
begin
 if p_limit is null or p_limit not between 1 and 25 then raise exception 'invalid_dispatch_claim'; end if;
 if not public.begin_firebase_live_dispatch(p_dispatch) then return jsonb_build_object('accepted',false,'rows','[]'::jsonb); end if;
 select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into rows from public.claim_firebase_live_dispatch(p_dispatch,p_limit) q;
 return jsonb_build_object('accepted',true,'rows',rows);
end $$;
revoke all on function public.begin_claim_firebase_live_dispatch(uuid,integer) from public,anon,authenticated;
grant execute on function public.begin_claim_firebase_live_dispatch(uuid,integer) to service_role;

-- One acknowledgement for the whole successfully published subset. Missing IDs
-- are unacknowledged (expired/replaced claims); callers must never count them PASS.
create function public.finish_firebase_live_batch(p_worker uuid,p_ids text[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if p_worker is null or p_ids is null or cardinality(p_ids) not between 1 and 100
   or exists(select 1 from unnest(p_ids) value where value is null or value !~ '^[1-9][0-9]{0,18}$')
   or cardinality(p_ids)<>(select count(distinct value) from unnest(p_ids) value) then raise exception 'invalid_finish_batch'; end if;
 with updated as (
   update private.firebase_live_outbox set delivered_at=clock_timestamp(),claim_until=null
   where id=any(p_ids::bigint[]) and claimed_by=p_worker and claim_until>clock_timestamp() and delivered_at is null
   returning id)
 select coalesce(jsonb_agg(id::text order by id),'[]'::jsonb) into result from updated;
 return result;
end $$;
revoke all on function public.finish_firebase_live_batch(uuid,text[]) from public,anon,authenticated;
grant execute on function public.finish_firebase_live_batch(uuid,text[]) to service_role;

-- Expiry collection has an independent owner. Never take over an unconfirmed
-- running cleaner solely by wall-clock expiry: a suspended HTTP request may resume.
-- Recovery must first verify the previous invocation stopped, as for publisher state.
create table private.firebase_live_cleanup_state(
 id boolean primary key default true check(id),dispatch_id uuid,owner_run_id uuid,
 running boolean not null default false,last_started_at timestamptz,last_finished_at timestamptz,
 last_result jsonb not null default '{}',cumulative_totals jsonb not null default '{}'
);
insert into private.firebase_live_cleanup_state(id) values(true);
revoke all on private.firebase_live_cleanup_state from public,anon,authenticated;

-- Avoid cleanup-only wakeups while another invocation already owns that work.
-- The previous predicate also includes direct-event metadata introduced earlier.
alter function private.firebase_live_dispatch_has_work() rename to firebase_live_dispatch_has_work_before_pipeline;
create function private.firebase_live_dispatch_has_work()
returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from private.firebase_live_outbox o where o.delivered_at is null
   and (o.claim_until is null or o.claim_until<clock_timestamp()))
 or (not exists(select 1 from private.firebase_live_cleanup_state where id and running)
   and private.firebase_live_dispatch_has_work_before_pipeline())
$$;
revoke all on function private.firebase_live_dispatch_has_work() from public,anon,authenticated;

create function public.begin_firebase_live_cleanup_dispatch(p_dispatch uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare cfg private.firebase_live_dispatch_config; n integer;
begin
 select * into cfg from private.firebase_live_dispatch_config where id for update;
 if p_dispatch is null or not cfg.enabled or cfg.run_deadline_at<=clock_timestamp() then return false; end if;
 if not exists(select 1 from private.firebase_live_dispatch_state where id and dispatch_id=p_dispatch
   and owner_run_id=cfg.owner_run_id) then return false; end if;
 update private.firebase_live_cleanup_state set running=true,dispatch_id=p_dispatch,owner_run_id=cfg.owner_run_id,
   last_started_at=clock_timestamp() where id and not running;
 get diagnostics n=row_count; return n=1;
end $$;
revoke all on function public.begin_firebase_live_cleanup_dispatch(uuid) from public,anon,authenticated;
grant execute on function public.begin_firebase_live_cleanup_dispatch(uuid) to service_role;

create function public.firebase_live_owned_maintenance(p_worker uuid,p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_worker is null or not exists(select 1 from private.firebase_live_cleanup_state
   where id and running and dispatch_id=p_worker) then raise exception 'cleanup_owner_required'; end if;
 return public.firebase_live_maintenance(p_limit);
end $$;
create function public.finish_firebase_live_owned_cleanup(p_worker uuid,p_kind text,p_id text,p_room_id uuid default null,p_epoch bigint default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_worker is null or not exists(select 1 from private.firebase_live_cleanup_state
   where id and running and dispatch_id=p_worker) then raise exception 'cleanup_owner_required'; end if;
 perform public.finish_firebase_live_cleanup(p_kind,p_id,p_room_id,p_epoch);
end $$;
revoke all on function public.firebase_live_owned_maintenance(uuid,integer),public.finish_firebase_live_owned_cleanup(uuid,text,text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.firebase_live_owned_maintenance(uuid,integer),public.finish_firebase_live_owned_cleanup(uuid,text,text,uuid,bigint) to service_role;

create function public.finish_firebase_live_cleanup_dispatch(p_dispatch uuid,p_stats jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare state private.firebase_live_cleanup_state; totals jsonb; metric text; value bigint;
 allowed constant text[]:=array['claimed','completed','published','expired','suppressed','retries','cleanupSelected','cleanupCompleted',
 'cleanupRetries','httpRequests','responseBodyBytes','rtdbResponseBodyBytes','supabaseResponseBodyBytes','googleAuthResponseBodyBytes','elapsedMs',
 'supabaseRequests','rtdbRequests','googleAuthRequests','supabaseRequestMs','rtdbRequestMs','googleAuthRequestMs',
 'supabaseRequestMaxMs','rtdbRequestMaxMs','googleAuthRequestMaxMs'];
begin
 if p_stats is null or jsonb_typeof(p_stats)<>'object' or pg_column_size(p_stats)>4096 then raise exception 'invalid_cleanup_stats'; end if;
 for metric in select jsonb_object_keys(p_stats) loop
   if not(metric=any(allowed)) or jsonb_typeof(p_stats->metric)<>'number'
     or (p_stats->>metric)!~'^[0-9]{1,10}$' or (p_stats->>metric)::bigint>1073741824 then raise exception 'invalid_cleanup_stats'; end if;
 end loop;
 select * into state from private.firebase_live_cleanup_state where id for update;
 if p_dispatch is null or not state.running or state.dispatch_id is distinct from p_dispatch then return false; end if;
 totals:=state.cumulative_totals;
 foreach metric in array allowed loop
   value:=coalesce((p_stats->>metric)::bigint,0);
   if metric like '%RequestMaxMs' then
     totals:=jsonb_set(totals,array[metric],to_jsonb(greatest(coalesce((totals->>metric)::bigint,0),value)));
   else totals:=jsonb_set(totals,array[metric],to_jsonb(coalesce((totals->>metric)::bigint,0)+value)); end if;
 end loop;
 update private.firebase_live_cleanup_state set running=false,last_finished_at=clock_timestamp(),
   last_result=p_stats,cumulative_totals=totals where id;
 return true;
end $$;
revoke all on function public.finish_firebase_live_cleanup_dispatch(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.finish_firebase_live_cleanup_dispatch(uuid,jsonb) to service_role;
commit;
