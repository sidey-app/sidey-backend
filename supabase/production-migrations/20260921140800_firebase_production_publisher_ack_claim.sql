-- Service-only pipeline: acknowledge one settled batch and claim its successor
-- in one round trip. Existing RPCs remain compatible with older publishers.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';
create function public.finish_claim_firebase_live_dispatch(
 p_worker uuid,p_ids text[],p_limit integer,p_claim_before timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg private.firebase_live_dispatch_config; state private.firebase_live_dispatch_state;
 completed jsonb; rows jsonb:='[]'::jsonb;
begin
 if p_worker is null or p_ids is null or cardinality(p_ids) not between 1 and 25
   or p_limit is null or p_limit not between 1 and 25
   or p_claim_before is null or not isfinite(p_claim_before)
   or exists(select 1 from unnest(p_ids) value where value is null or value !~ '^[1-9][0-9]{0,18}$')
   or cardinality(p_ids)<>(select count(distinct value) from unnest(p_ids) value) then
   raise exception 'invalid_ack_claim'; end if;
 -- Match begin/finish config -> state, then maintenance/claim publication ->
 -- outbox. Never acquire outbox first and wait for the publication lock.
 select * into cfg from private.firebase_live_dispatch_config where id for update;
 select * into state from private.firebase_live_dispatch_state where id for update;
 if state.dispatch_id is distinct from p_worker or state.phase is distinct from 'running'
   or state.owner_run_id is distinct from cfg.owner_run_id then
   return jsonb_build_object('completed','[]'::jsonb,'rows',rows); end if;
 perform pg_advisory_xact_lock(hashtextextended('firebase-live-publication',0));
 completed:=public.finish_firebase_live_batch(p_worker,p_ids);
 -- Partial acknowledgements never expand the outstanding claim set. An expired
 -- local budget still permits recording completed writes but claims nothing new.
 -- The existing claim RPC independently enforces enabled/deadline/owner/expiry.
 if jsonb_array_length(completed)=cardinality(p_ids) and clock_timestamp()<p_claim_before then
   select coalesce(jsonb_agg(to_jsonb(q)),'[]'::jsonb) into rows
     from public.claim_firebase_live_dispatch(p_worker,p_limit) q;
 end if;
 return jsonb_build_object('completed',completed,'rows',rows);
end $$;
revoke all on function public.finish_claim_firebase_live_dispatch(uuid,text[],integer,timestamptz)
 from public,anon,authenticated;
grant execute on function public.finish_claim_firebase_live_dispatch(uuid,text[],integer,timestamptz) to service_role;
commit;
