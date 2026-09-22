begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select no_plan();
-- Enqueue cannot make any external HTTP request, even if a test setup changes.
create or replace function private.enqueue_firebase_live_dispatch(p_dispatch uuid,p_secret text)
returns bigint language plpgsql set search_path='' as $$begin raise exception 'ack_claim_test_network_forbidden';end$$;
select ok(not has_function_privilege('anon','public.finish_claim_firebase_live_dispatch(uuid,text[],integer,timestamptz)','execute'),'anonymous cannot ACK or claim');
select ok(not has_function_privilege('authenticated','public.finish_claim_firebase_live_dispatch(uuid,text[],integer,timestamptz)','execute'),'user cannot ACK or claim');
select ok(has_function_privilege('service_role','public.finish_claim_firebase_live_dispatch(uuid,text[],integer,timestamptz)','execute'),'service owns combined RPC');
select throws_ok($$select public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array['1'],26,now())$$,'P0001','invalid_ack_claim','next batch is capped');
select throws_ok($$select public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array['1','1'],1,now())$$,'P0001','invalid_ack_claim','duplicate ACK is invalid');
select throws_ok($$select public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array['bad'],1,now())$$,'P0001','invalid_ack_claim','malformed ACK is invalid');
select throws_ok($$select public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array[null]::text[],1,now())$$,'P0001','invalid_ack_claim','null ACK is invalid');
select throws_ok($$select public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array['1'],1,'infinity')$$,'P0001','invalid_ack_claim','deadline must be finite');
select throws_ok($$select public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array(select n::text from generate_series(1,26)n),1,now())$$,'P0001','invalid_ack_claim','ACK batch is capped');

insert into private.firebase_live_outbox(room_id,epoch,kind) select
 'a2000000-0000-4000-8000-000000000001',1,'message_changed' from generate_series(1,5);
create temp table ack_ids as select row_number() over(order by id) n,id::text from private.firebase_live_outbox;
update private.firebase_live_dispatch_config set enabled=true,owner_run_id='a3000000-0000-4000-8000-000000000001',run_deadline_at=clock_timestamp()+interval '30 minutes';
update private.firebase_live_dispatch_state set owner_run_id='a3000000-0000-4000-8000-000000000001',dispatch_id='a1000000-0000-4000-8000-000000000001',phase='queued',expires_at=clock_timestamp()+interval '10 seconds';
select is(public.begin_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',1)->>'accepted','true','first claim uses existing admission');
-- A later access-control change must precede the older remaining messages.
insert into private.firebase_live_outbox(room_id,epoch,kind) values('a2000000-0000-4000-8000-000000000002',2,'control');
create temp table ack_result as select public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array[(select id from ack_ids where n=1)],1,clock_timestamp()+interval '20 seconds') value;
select is((select jsonb_array_length(value->'completed') from ack_result),1,'combined RPC acknowledges completed work');
select is((select value->'rows'->0->>'kind' from ack_result),'control','new control retains priority over older messages');
select is((select count(*)::int from private.firebase_live_outbox where delivered_at is not null),1,'exactly one durable ACK');
select is((select count(*)::int from private.firebase_live_outbox where claimed_by='a1000000-0000-4000-8000-000000000001' and delivered_at is null),1,'next claim owned by same dispatch');
select is(public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array[(select id from ack_ids where n=1)],25,clock_timestamp()+interval '20 seconds'),' {"completed":[],"rows":[]}'::jsonb,'duplicate/lost-response retry cannot preclaim more work');
select is(public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000002',array[(select value->'rows'->0->>'id' from ack_result)],1,clock_timestamp()+interval '20 seconds'),' {"completed":[],"rows":[]}'::jsonb,'different worker cannot ACK or claim');
-- Partial ACK: one actual owned row plus an unclaimed row; no fresh claim.
update ack_result set value=public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array[(select value->'rows'->0->>'id' from ack_result),(select id from ack_ids where n=2)],1,clock_timestamp()+interval '20 seconds');
select is((select jsonb_array_length(value->'completed') from ack_result),1,'partial ACK records only actually owned work');
select is((select value->'rows' from ack_result),'[]'::jsonb,'partial ACK never preclaims');
select is((select count(*)::int from private.firebase_live_outbox where delivered_at is null and claimed_by is null),4,'unclaimed durable work remains untouched');

-- Fences are checked independently of recording an already settled write.
update private.firebase_live_outbox set claimed_by='a1000000-0000-4000-8000-000000000001',claim_until=clock_timestamp()+interval '30 seconds' where id=(select id::bigint from ack_ids where n=2);
update private.firebase_live_dispatch_config set enabled=false;
update ack_result set value=public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array[(select id from ack_ids where n=2)],1,clock_timestamp()+interval '20 seconds');
select is((select jsonb_array_length(value->'completed') from ack_result),1,'disabled dispatch may ACK its already settled valid claim');
select is((select value->'rows' from ack_result),'[]'::jsonb,'disabled dispatch cannot acquire successor');
update private.firebase_live_dispatch_config set enabled=true;
update private.firebase_live_outbox set claimed_by='a1000000-0000-4000-8000-000000000001',claim_until=clock_timestamp()+interval '30 seconds' where id=(select id::bigint from ack_ids where n=3);
update private.firebase_live_dispatch_state set expires_at=clock_timestamp()-interval '1 second';
update ack_result set value=public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array[(select id from ack_ids where n=3)],1,clock_timestamp()+interval '20 seconds');
select is((select jsonb_array_length(value->'completed') from ack_result),1,'expired dispatch may ACK a still valid row claim');
select is((select value->'rows' from ack_result),'[]'::jsonb,'expired dispatch cannot preclaim');
update private.firebase_live_dispatch_state set expires_at=clock_timestamp()+interval '25 seconds';
update private.firebase_live_outbox set claimed_by='a1000000-0000-4000-8000-000000000001',claim_until=clock_timestamp()+interval '30 seconds' where id=(select id::bigint from ack_ids where n=4);
update ack_result set value=public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array[(select id from ack_ids where n=4)],1,clock_timestamp()-interval '1 second');
select is((select jsonb_array_length(value->'completed') from ack_result),1,'expired local budget still records valid completion');
select is((select value->'rows' from ack_result),'[]'::jsonb,'local budget prevents preclaim');
update private.firebase_live_outbox set claimed_by='a1000000-0000-4000-8000-000000000001',claim_until=clock_timestamp()-interval '1 second' where id=(select id::bigint from ack_ids where n=5);
select is(public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array[(select id from ack_ids where n=5)],1,clock_timestamp()+interval '20 seconds'),' {"completed":[],"rows":[]}'::jsonb,'expired row claim remains durable and cannot preclaim');
update private.firebase_live_outbox set claim_until=clock_timestamp()+interval '30 seconds' where id=(select id::bigint from ack_ids where n=5);
update private.firebase_live_dispatch_config set owner_run_id='a3000000-0000-4000-8000-000000000002';
select is(public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array[(select id from ack_ids where n=5)],1,clock_timestamp()+interval '20 seconds'),' {"completed":[],"rows":[]}'::jsonb,'changed run owner fences the same dispatch UUID');
update private.firebase_live_dispatch_config set owner_run_id='a3000000-0000-4000-8000-000000000001',run_deadline_at=clock_timestamp()+interval '20 milliseconds';
do $$begin perform pg_sleep(0.03);end$$;
update ack_result set value=public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array[(select id from ack_ids where n=5)],1,clock_timestamp()+interval '20 seconds');
select is((select jsonb_array_length(value->'completed') from ack_result),1,'run deadline still permits settled claim ACK');
select is((select value->'rows' from ack_result),'[]'::jsonb,'expired run deadline forbids successor claim');
update private.firebase_live_dispatch_config set run_deadline_at=clock_timestamp()+interval '30 minutes';
update private.firebase_live_outbox set delivered_at=null,claim_until=clock_timestamp()+interval '30 seconds' where id=(select id::bigint from ack_ids where n=5);
update private.firebase_live_dispatch_state set dispatch_id='a1000000-0000-4000-8000-000000000002';
select is(public.finish_claim_firebase_live_dispatch('a1000000-0000-4000-8000-000000000001',array[(select id from ack_ids where n=5)],1,clock_timestamp()+interval '20 seconds'),' {"completed":[],"rows":[]}'::jsonb,'old dispatch cannot ACK after replacement');
select is((select count(*)::int from private.firebase_live_outbox where delivered_at is null),1,'old worker leaves pending work recoverable');
select is(jsonb_array_length(public.finish_firebase_live_batch('a1000000-0000-4000-8000-000000000001',array[(select id from ack_ids where n=5)])),1,'legacy ACK RPC stays available and unchanged');
select * from finish();
rollback;
