begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select no_plan();
select ok(not has_function_privilege('authenticated','public.begin_claim_firebase_live_dispatch(uuid,integer)','execute'),'clients cannot acquire publisher');
select ok(not has_function_privilege('authenticated','public.finish_firebase_live_batch(uuid,text[])','execute'),'clients cannot complete durable work');
select ok(not has_function_privilege('authenticated','public.firebase_live_owned_maintenance(uuid,integer)','execute'),'clients cannot run cleanup');
select ok(not has_table_privilege('authenticated','private.firebase_live_cleanup_state','select'),'cleanup ownership remains private');
select is(public.begin_claim_firebase_live_dispatch('71000000-0000-4000-8000-000000000001',25)->>'accepted','false','disabled dispatch cannot claim');
select throws_ok($$select public.begin_claim_firebase_live_dispatch('71000000-0000-4000-8000-000000000001',26)$$,'P0001','invalid_dispatch_claim','combined claim keeps bounded limit');

-- A real queued owner can acquire and fetch exactly once in one database transaction.
insert into private.firebase_live_outbox(room_id,epoch,kind) values
('72000000-0000-4000-8000-000000000001',1,'message_changed'),
('72000000-0000-4000-8000-000000000001',1,'structure_changed'),
('72000000-0000-4000-8000-000000000002',1,'control');
update private.firebase_live_dispatch_config set enabled=true,owner_run_id='73000000-0000-4000-8000-000000000001',run_deadline_at=clock_timestamp()+interval '30 minutes';
update private.firebase_live_dispatch_state set owner_run_id='73000000-0000-4000-8000-000000000001',dispatch_id='71000000-0000-4000-8000-000000000001',phase='queued',expires_at=clock_timestamp()+interval '10 seconds';
create temporary table pipeline_admission as select public.begin_claim_firebase_live_dispatch('71000000-0000-4000-8000-000000000001',2) value;
select is((select value->>'accepted' from pipeline_admission),'true','combined begin accepts current queued owner');
select is((select jsonb_array_length(value->'rows') from pipeline_admission),2,'same response includes first claim');
select ok((select bool_and(r->>'kind' in ('control','structure_changed')) from pipeline_admission,jsonb_array_elements(value->'rows') r),'access revocation and membership work precedes older messages');
select is((select count(*)::integer from private.firebase_live_outbox where claimed_by='71000000-0000-4000-8000-000000000001'),2,'first rows are already owned');
select is(public.begin_claim_firebase_live_dispatch('71000000-0000-4000-8000-000000000001',2)->>'accepted','false','duplicate begin cannot acquire or claim again');
select is((select count(*)::integer from private.firebase_live_outbox where claimed_by='71000000-0000-4000-8000-000000000001'),2,'duplicate begin leaves remaining work unclaimed');
select is(public.finish_firebase_live_batch('71000000-0000-4000-8000-000000000002',(select array_agg(r->>'id') from pipeline_admission,jsonb_array_elements(value->'rows') r)),'[]'::jsonb,'wrong worker cannot complete batch');
select throws_ok($$select public.finish_firebase_live_batch('71000000-0000-4000-8000-000000000001',array['1','1'])$$,'P0001','invalid_finish_batch','duplicate ACK IDs rejected');
select throws_ok($$select public.finish_firebase_live_batch('71000000-0000-4000-8000-000000000001',array['bad'])$$,'P0001','invalid_finish_batch','malformed ACK IDs rejected');
select throws_ok($$select public.finish_firebase_live_batch('71000000-0000-4000-8000-000000000001',array[null]::text[])$$,'P0001','invalid_finish_batch','null ACK ID rejected');
select is(jsonb_array_length(public.finish_firebase_live_batch('71000000-0000-4000-8000-000000000001',(select array_agg(r->>'id') from pipeline_admission,jsonb_array_elements(value->'rows') r))),2,'one batch acknowledgement completes owned subset');
select is(public.finish_firebase_live_batch('71000000-0000-4000-8000-000000000001',(select array_agg(r->>'id') from pipeline_admission,jsonb_array_elements(value->'rows') r)),'[]'::jsonb,'repeated acknowledgement cannot claim fresh success');

select ok(public.begin_firebase_live_cleanup_dispatch('71000000-0000-4000-8000-000000000001'),'current dispatch obtains independent cleanup ownership');
select ok(not public.begin_firebase_live_cleanup_dispatch('71000000-0000-4000-8000-000000000001'),'duplicate cleanup cannot overlap');
select throws_ok($$select public.firebase_live_owned_maintenance('71000000-0000-4000-8000-000000000002',1)$$,'P0001','cleanup_owner_required','stale cleaner cannot select work');
select lives_ok($$select public.firebase_live_owned_maintenance('71000000-0000-4000-8000-000000000001',1)$$,'owned cleanup uses original revision-safe maintenance');
select ok(public.finish_firebase_live_dispatch('71000000-0000-4000-8000-000000000001',false,'{}'),'publisher releases without waiting for cleanup');
select ok((select running from private.firebase_live_cleanup_state),'cleanup retains only its own ownership');
-- Model the scheduler issuing a successor while expiry cleanup is still in progress.
update private.firebase_live_dispatch_state set dispatch_id='71000000-0000-4000-8000-000000000002',phase='queued',expires_at=clock_timestamp()+interval '10 seconds';
create temporary table successor_admission as select public.begin_claim_firebase_live_dispatch('71000000-0000-4000-8000-000000000002',25) value;
select is((select value->>'accepted' from successor_admission),'true','successor publisher starts during previous cleanup');
select is((select jsonb_array_length(value->'rows') from successor_admission),1,'successor claims remaining durable message');
select ok(not public.begin_firebase_live_cleanup_dispatch('71000000-0000-4000-8000-000000000002'),'successor cannot replace active cleanup owner');
select ok(not public.finish_firebase_live_cleanup_dispatch('71000000-0000-4000-8000-000000000002','{}'),'successor cannot release previous cleaner');
select ok(public.finish_firebase_live_cleanup_dispatch('71000000-0000-4000-8000-000000000001','{"cleanupSelected":2,"cleanupCompleted":2,"rtdbRequests":4,"rtdbRequestMaxMs":20}'),'original cleaner finishes independently');
select is((select phase from private.firebase_live_dispatch_state),'running','cleanup finish cannot release successor publisher');
select ok(public.begin_firebase_live_cleanup_dispatch('71000000-0000-4000-8000-000000000002'),'successor may clean after prior work settles');
select throws_ok($$select public.finish_firebase_live_owned_cleanup('71000000-0000-4000-8000-000000000001','event','1')$$,'P0001','cleanup_owner_required','old cleaner cannot acknowledge replacement work');
select ok(not public.finish_firebase_live_cleanup_dispatch('71000000-0000-4000-8000-000000000001','{}'),'old cleanup finish cannot release successor');
select ok(public.finish_firebase_live_cleanup_dispatch('71000000-0000-4000-8000-000000000002','{"cleanupSelected":1,"cleanupCompleted":1,"rtdbRequests":2,"rtdbRequestMaxMs":10}'),'successor cleanup finishes');
select is((select cumulative_totals->>'rtdbRequests' from private.firebase_live_cleanup_state),'6','cleanup costs accumulate separately');
select is((select cumulative_totals->>'rtdbRequestMaxMs' from private.firebase_live_cleanup_state),'20','cleanup request maxima are not summed');
update private.firebase_live_outbox set claim_until=clock_timestamp()-interval '1 second' where claimed_by='71000000-0000-4000-8000-000000000002';
select is(public.finish_firebase_live_batch('71000000-0000-4000-8000-000000000002',(select array_agg(r->>'id') from successor_admission,jsonb_array_elements(value->'rows') r)),'[]'::jsonb,'expired claims remain recoverable instead of false ACK');
select is((select count(*)::integer from private.firebase_live_outbox where delivered_at is null),1,'lost completion preserves durable message recovery');
select * from finish();
rollback;
