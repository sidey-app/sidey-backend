begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select no_plan();

-- A rollback-only local stub guarantees this test never calls cloud staging.
create temporary table dispatch_http_calls(dispatch_id uuid,secret_valid boolean);
create or replace function private.enqueue_firebase_live_dispatch(p_dispatch uuid,p_secret text)
returns bigint language plpgsql set search_path='' as $$
begin
 insert into pg_temp.dispatch_http_calls values(p_dispatch,p_secret='synthetic-only-private-scheduler-secret-32');
 return (select count(*) from pg_temp.dispatch_http_calls);
end $$;

select ok(not(select enabled from private.firebase_live_dispatch_config),'scheduler ships off');
select is((select count(*)::integer from cron.job where jobname='sidey-firebase-live-staging'),0,'migration registers no cron job');
select is(private.dispatch_firebase_live()->>'reason','off','off wakeup cannot enqueue');
select ok(not has_function_privilege('authenticated','public.begin_firebase_live_dispatch(uuid)','execute'),'client cannot acquire dispatch');
select ok(not has_function_privilege('anon','public.finish_firebase_live_dispatch(uuid,boolean,jsonb)','execute'),'anonymous finish denied');
select ok(not has_function_privilege('authenticated','private.dispatch_firebase_live()','execute'),'client cannot schedule HTTP');
select ok(not has_table_privilege('authenticated','private.firebase_live_dispatch_config','update'),'client cannot enable scheduler');
select throws_ok($$update private.firebase_live_dispatch_config set enabled=true$$,'23514',null,'run owner and bounded deadline required');
select throws_ok($$update private.firebase_live_dispatch_config set enabled=true,owner_run_id='81000000-0000-4000-8000-000000000001',run_deadline_at=clock_timestamp()+interval '61 minutes'$$,'23514',null,'run cannot authorize unbounded future wakeups');
update private.firebase_live_dispatch_config set enabled=true,owner_run_id='81000000-0000-4000-8000-000000000001',run_deadline_at=clock_timestamp()+interval '30 minutes';
select is(private.dispatch_firebase_live()->>'reason','empty','empty queue avoids actual function invocation');
insert into private.firebase_live_outbox(room_id,epoch,kind,occurred_at) values('82000000-0000-4000-8000-000000000001',1,'typing_start',clock_timestamp()-interval '6 seconds');
select throws_ok($$select private.dispatch_firebase_live()$$,'P0001','firebase_dispatch_secret_unavailable','missing secret fails before HTTP');
select vault.create_secret('synthetic-only-private-scheduler-secret-32','sidey_firebase_live_publish_secret_staging');
select is((private.dispatch_firebase_live()->>'scheduled')::boolean,true,'eligible queue reserves one dispatch and enqueues once');
select is(private.dispatch_firebase_live()->>'reason','busy','subsequent tick does not invoke while lease is queued');
select is((select count(*)::integer from dispatch_http_calls),1,'only one HTTP enqueue occurred');
select ok((select secret_valid from dispatch_http_calls),'scheduler obtains its credential from the named Vault entry');
select is((select dispatch_id from dispatch_http_calls),(select dispatch_id from private.firebase_live_dispatch_state),'HTTP enqueue carries exactly the reserved dispatch identity');
create temporary table first_dispatch as select dispatch_id from private.firebase_live_dispatch_state;
select ok(not public.begin_firebase_live_dispatch('83000000-0000-4000-8000-000000000001'),'invented dispatch denied');
select ok(public.begin_firebase_live_dispatch((select dispatch_id from first_dispatch)),'reserved dispatch begins once');
select ok(not public.begin_firebase_live_dispatch((select dispatch_id from first_dispatch)),'duplicate request cannot start same dispatch twice');
select is((select started_count from private.firebase_live_dispatch_state),1::bigint,'only accepted invocation increments started counter');
create temporary table dispatch_claim as select * from public.claim_firebase_live_dispatch((select dispatch_id from first_dispatch),25);
select is((select count(*)::integer from dispatch_claim),1,'accepted dispatch can claim durable work');
select is((select original_kind from dispatch_claim),'typing_start','expired source kind remains available for measurement');
select is((select kind from dispatch_claim),'control','legacy expiry and access contract remains intact');
select is((select count(*)::integer from public.claim_firebase_live_dispatch('83000000-0000-4000-8000-000000000001',25)),0,'unowned dispatch cannot claim');
select throws_ok($$select public.finish_firebase_live_dispatch((select dispatch_id from first_dispatch),true,'{"unknown":1}')$$,'P0001','invalid_dispatch_stats','unknown stats cannot be persisted');
select ok(public.finish_firebase_live_dispatch((select dispatch_id from first_dispatch),false,'{"claimed":1,"completed":0,"retries":1,"responseBodyBytes":100}'),'failed dispatch releases its reservation after work settles');
select ok((select claim_until is null from private.firebase_live_outbox),'unfinished durable claim is immediately retryable');
select ok(not public.finish_firebase_live_dispatch((select dispatch_id from first_dispatch),true,'{"responseBodyBytes":100}'),'duplicate finish cannot double count');
select is((select cumulative_totals->>'responseBodyBytes' from private.firebase_live_dispatch_state),'100','response byte counter aggregates once');
select is((private.dispatch_firebase_live()->>'scheduled')::boolean,true,'failure leaves work eligible for the next real invocation');
select ok(not public.begin_firebase_live_dispatch((select dispatch_id from first_dispatch)),'old delayed HTTP request cannot acquire replacement');
select ok(not public.finish_firebase_live_dispatch((select dispatch_id from first_dispatch),true,'{}'),'old completion cannot clear replacement lease');
update private.firebase_live_dispatch_config set enabled=false;
select ok(not public.begin_firebase_live_dispatch((select dispatch_id from private.firebase_live_dispatch_state)),'stop rejects already queued HTTP');
update private.firebase_live_dispatch_config set enabled=true;
update private.firebase_live_dispatch_state set expires_at=clock_timestamp()-interval '1 second';
select is((private.dispatch_firebase_live()->>'scheduled')::boolean,true,'crashed queued dispatch recovers only after its lease expires');
select ok(public.begin_firebase_live_dispatch((select dispatch_id from private.firebase_live_dispatch_state)),'recovery dispatch can start');
update private.firebase_live_dispatch_state set expires_at=clock_timestamp()-interval '1 second';
select is((select count(*)::integer from public.claim_firebase_live_dispatch((select dispatch_id from private.firebase_live_dispatch_state),25)),0,'expired running dispatch cannot acquire additional work');
select is(private.dispatch_firebase_live()->>'reason','busy','expired accepted work remains tracked until explicit finish');
select is((select phase from private.firebase_live_dispatch_state),'running','expiry is not evidence that accepted work stopped');

-- No cron command can execute before this transaction commits; the whole test rolls back.
select cron.schedule('sidey-firebase-live-staging','1 second','select private.dispatch_firebase_live();');
select cron.schedule('sidey-firebase-dispatch-unrelated-test','1 second','select 1;');
update private.firebase_live_dispatch_config set run_deadline_at=clock_timestamp()+interval '20 milliseconds';
select pg_sleep(0.03);
select ok(not public.begin_firebase_live_dispatch((select dispatch_id from private.firebase_live_dispatch_state)),'deadline blocks delayed handler before cron cleanup');
select is(private.dispatch_firebase_live()->>'reason','run_deadline','deadline stops further paid function invocations');
select ok(not(select enabled from private.firebase_live_dispatch_config),'deadline disables scheduler config');
select is((select count(*)::integer from cron.job where jobname='sidey-firebase-live-staging'),0,'deadline removes exact reserved staging wakeup');
select is((select count(*)::integer from cron.job where jobname='sidey-firebase-dispatch-unrelated-test'),1,'deadline preserves unrelated cron jobs');
select * from finish();
rollback;
