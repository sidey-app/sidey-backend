-- Staging-only Edge wakeup. No cron job, secret, remote request or rollout is enabled by this migration.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';
create extension if not exists pg_net with schema extensions;

create table private.firebase_live_dispatch_config(
 id boolean primary key default true check(id),
 enabled boolean not null default false,
 owner_run_id uuid,run_deadline_at timestamptz,
 check(not enabled or (owner_run_id is not null and run_deadline_at is not null
   and run_deadline_at>clock_timestamp() and run_deadline_at<=clock_timestamp()+interval '60 minutes'))
);
insert into private.firebase_live_dispatch_config(id) values(true);
create table private.firebase_live_dispatch_state(
 id boolean primary key default true check(id),
 owner_run_id uuid,dispatch_id uuid,phase text check(phase in ('queued','running')),
 expires_at timestamptz not null default '-infinity',
 enqueue_count bigint not null default 0,started_count bigint not null default 0,finished_count bigint not null default 0,
 last_enqueued_at timestamptz,last_started_at timestamptz,last_finished_at timestamptz,
 last_result jsonb not null default '{}',cumulative_totals jsonb not null default '{}'
);
insert into private.firebase_live_dispatch_state(id) values(true);
revoke all on private.firebase_live_dispatch_config,private.firebase_live_dispatch_state from public,anon,authenticated;

create function private.firebase_live_dispatch_has_work()
returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from private.firebase_live_outbox o where o.delivered_at is null
   and (o.claim_until is null or o.claim_until<clock_timestamp()))
 or exists(select 1 from private.firebase_live_leases l where private.firebase_live_lease_invalid(l)
   and (l.cleaned_at is null or l.cleaned_at<clock_timestamp()-interval '5 seconds'))
 or exists(select 1 from private.firebase_live_outbox o where o.kind in ('typing_start','typing_stop','character_pulse','character_throw')
   and o.occurred_at<clock_timestamp()-interval '5 seconds' and o.delivered_at is not null and o.cleaned_at is null)
 or exists(select 1 from private.firebase_live_epochs e
   where not exists(select 1 from public.rooms r where r.id=e.room_id and r.realtime_epoch<=e.epoch)
   and not exists(select 1 from private.firebase_live_outbox o where o.room_id=e.room_id and o.claim_until>clock_timestamp()-interval '30 seconds'))
 or exists(select 1 from private.firebase_live_outbox o where o.delivered_at<clock_timestamp()-interval '15 minutes'
   and (o.kind not in ('typing_start','typing_stop','character_pulse','character_throw') or o.cleaned_at is not null))
$$;
revoke all on function private.firebase_live_dispatch_has_work() from public,anon,authenticated;

-- Explicit network boundary allows rollback-only DB tests to replace it without
-- changing the managed pg_net extension's supabase_admin-owned functions.
create function private.enqueue_firebase_live_dispatch(p_dispatch uuid,p_secret text)
returns bigint language sql set search_path='' as $$
 select net.http_post(
   url:='https://fjglrvhvdthntkvrduyi.supabase.co/functions/v1/realtime-publish-live',
   headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||p_secret),
   body:=jsonb_build_object('dispatchId',p_dispatch),timeout_milliseconds:=25000)
$$;
revoke all on function private.enqueue_firebase_live_dispatch(uuid,text) from public,anon,authenticated;

create function private.dispatch_firebase_live()
returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg private.firebase_live_dispatch_config; state private.firebase_live_dispatch_state; dispatch uuid; secret text; request_id bigint; job record;
begin
 -- Serialize only this short scheduling transaction. No HTTP response or publisher work holds this lock.
 select * into cfg from private.firebase_live_dispatch_config where id for update;
 if cfg.enabled and cfg.run_deadline_at<=clock_timestamp() then
   update private.firebase_live_dispatch_config set enabled=false where id and owner_run_id=cfg.owner_run_id;
   -- The harness reserves this exact name/command under the config run owner before enabling.
   -- SECURITY DEFINER current_user is the function owner, not necessarily the cron creator.
   for job in select jobid from cron.job where jobname='sidey-firebase-live-staging'
     and database=current_database() and command='select private.dispatch_firebase_live();'
   loop perform cron.unschedule(job.jobid); end loop;
   return jsonb_build_object('scheduled',false,'reason','run_deadline');
 end if;
 if not cfg.enabled then return jsonb_build_object('scheduled',false,'reason','off'); end if;
 select * into state from private.firebase_live_dispatch_state where id for update;
 -- Expiry permits retrying an unaccepted HTTP enqueue, never forgetting accepted work.
 -- CPU termination / lost finish evidence requires explicit recovery after shutdown is verified.
 if state.phase='running' or (state.phase='queued' and state.expires_at>clock_timestamp()) then
   return jsonb_build_object('scheduled',false,'reason','busy'); end if;
 if not private.firebase_live_dispatch_has_work() then return jsonb_build_object('scheduled',false,'reason','empty'); end if;
 select decrypted_secret into secret from vault.decrypted_secrets where name='sidey_firebase_live_publish_secret_staging';
 if secret is null or length(secret)<32 then raise exception using errcode='P0001',message='firebase_dispatch_secret_unavailable'; end if;
 dispatch:=gen_random_uuid();
 -- The destination cannot be supplied by an app, caller or Vault value. This code never schedules production.
 begin
   request_id:=private.enqueue_firebase_live_dispatch(dispatch,secret);
 exception when others then raise exception using errcode='P0001',message='firebase_dispatch_enqueue_failed';
 end;
 update private.firebase_live_dispatch_state set owner_run_id=cfg.owner_run_id,dispatch_id=dispatch,phase='queued',
   expires_at=clock_timestamp()+interval '10 seconds',last_enqueued_at=clock_timestamp(),enqueue_count=enqueue_count+1 where id;
 return jsonb_build_object('scheduled',true,'requestId',request_id);
end $$;
revoke all on function private.dispatch_firebase_live() from public,anon,authenticated;

create function public.begin_firebase_live_dispatch(p_dispatch uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare cfg private.firebase_live_dispatch_config; n integer;
begin
 -- Same lock order as dispatcher prevents stop/start and duplicate-request races.
 select * into cfg from private.firebase_live_dispatch_config where id for update;
 if not cfg.enabled or cfg.run_deadline_at<=clock_timestamp() or p_dispatch is null then return false; end if;
 update private.firebase_live_dispatch_state set phase='running',expires_at=clock_timestamp()+interval '25 seconds',
   last_started_at=clock_timestamp(),started_count=started_count+1
 where id and dispatch_id=p_dispatch and owner_run_id=cfg.owner_run_id and phase='queued' and expires_at>clock_timestamp();
 get diagnostics n=row_count;return n=1;
end $$;
revoke all on function public.begin_firebase_live_dispatch(uuid) from public,anon,authenticated;
grant execute on function public.begin_firebase_live_dispatch(uuid) to service_role;

-- Keep the original claim/CAS contract, adding only the source kind for expiry accounting.
-- A stopped or superseded dispatch cannot claim more work, even if its HTTP invocation resumes late.
create function public.claim_firebase_live_dispatch(p_worker uuid,p_limit integer default 25)
returns table(id text,revision text,event_id uuid,room_id uuid,epoch bigint,kind text,payload jsonb,occurred_at timestamptz,access jsonb,original_kind text)
language plpgsql security definer set search_path='' as $$
begin
 if p_limit is null or p_limit not between 1 and 25 then raise exception 'invalid_dispatch_claim'; end if;
 if not exists(select 1 from private.firebase_live_dispatch_state s join private.firebase_live_dispatch_config c on c.id=s.id
   where s.id and c.enabled and c.run_deadline_at>clock_timestamp() and s.owner_run_id=c.owner_run_id
   and s.dispatch_id=p_worker and s.phase='running' and s.expires_at>clock_timestamp()) then return; end if;
 return query select q.*,o.kind from public.claim_firebase_live(p_worker,p_limit) q
   join private.firebase_live_outbox o on o.id=q.id::bigint;
end $$;
revoke all on function public.claim_firebase_live_dispatch(uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_firebase_live_dispatch(uuid,integer) to service_role;

create function public.finish_firebase_live_dispatch(p_dispatch uuid,p_success boolean,p_stats jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare state private.firebase_live_dispatch_state; metric text; value bigint; totals jsonb;
 allowed constant text[]:=array['claimed','completed','published','expired','suppressed','retries','cleanupSelected','cleanupCompleted',
 'cleanupRetries','httpRequests','responseBodyBytes','rtdbResponseBodyBytes','supabaseResponseBodyBytes','googleAuthResponseBodyBytes','elapsedMs'];
begin
 if p_dispatch is null or p_success is null or p_stats is null or jsonb_typeof(p_stats)<>'object' or pg_column_size(p_stats)>4096 then raise exception 'invalid_dispatch_stats'; end if;
 for metric in select jsonb_object_keys(p_stats) loop
   if not(metric=any(allowed)) or jsonb_typeof(p_stats->metric)<>'number' or (p_stats->>metric)!~'^[0-9]{1,10}$'
     or (p_stats->>metric)::bigint>1073741824 then raise exception 'invalid_dispatch_stats'; end if;
 end loop;
 select * into state from private.firebase_live_dispatch_state where id for update;
 if state.dispatch_id is distinct from p_dispatch or state.phase is distinct from 'running' then return false; end if;
 -- A late but still current invocation may report completion after expiry; it must never complete a replacement dispatch.
 totals:=state.cumulative_totals;
 foreach metric in array allowed loop
   value:=coalesce((p_stats->>metric)::bigint,0);
   totals:=jsonb_set(totals,array[metric],to_jsonb(coalesce((totals->>metric)::bigint,0)+value));
 end loop;
 -- All remote work has settled before this call. Unfinished rows remain durable and become immediately reclaimable.
 update private.firebase_live_outbox set claim_until=null where claimed_by=p_dispatch and delivered_at is null;
 update private.firebase_live_dispatch_state set phase=null,expires_at=clock_timestamp(),finished_count=finished_count+1,
   last_finished_at=clock_timestamp(),last_result=p_stats||jsonb_build_object('success',p_success),cumulative_totals=totals where id;
 return true;
end $$;
revoke all on function public.finish_firebase_live_dispatch(uuid,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.finish_firebase_live_dispatch(uuid,boolean,jsonb) to service_role;
commit;
