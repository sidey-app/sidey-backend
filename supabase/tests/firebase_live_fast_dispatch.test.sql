begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select no_plan();
create temporary table fast_http_calls(dispatch_id uuid);
create or replace function private.enqueue_firebase_live_dispatch(p_dispatch uuid,p_secret text)
returns bigint language plpgsql set search_path='' as $$
begin
 insert into pg_temp.fast_http_calls values(p_dispatch);
 return (select count(*) from pg_temp.fast_http_calls);
end $$;
select ok(not has_function_privilege('authenticated','private.try_dispatch_firebase_live()','execute'),'client cannot request wake');
select ok(not has_table_privilege('authenticated','private.firebase_live_access_snapshots','select'),'access snapshots remain private');
insert into private.firebase_live_outbox(room_id,epoch,kind) values('92000000-0000-4000-8000-000000000001',1,'control');
select is((select count(*)::integer from fast_http_calls),0,'OFF insert does not enqueue');
truncate private.firebase_live_outbox;
select vault.create_secret('synthetic-only-private-scheduler-secret-32','sidey_firebase_live_publish_secret_staging');
update private.firebase_live_dispatch_config set enabled=true,owner_run_id='91000000-0000-4000-8000-000000000001',run_deadline_at=clock_timestamp()+interval '30 minutes';
savepoint rollback_wake;
insert into private.firebase_live_outbox(room_id,epoch,kind) values('92000000-0000-4000-8000-000000000001',1,'control');
select is((select count(*)::integer from fast_http_calls),1,'insert immediately enqueues without a cron tick');
rollback to rollback_wake;
select is((select count(*)::integer from fast_http_calls),0,'rolled-back source also rolls back HTTP queue write');
select ok((select phase is null from private.firebase_live_dispatch_state),'rolled-back source leaves no dispatch reservation');
insert into private.firebase_live_outbox(room_id,epoch,kind)
values('92000000-0000-4000-8000-000000000001',1,'control'),('92000000-0000-4000-8000-000000000001',1,'control');
select is((select count(*)::integer from fast_http_calls),1,'multirow insert enqueues once');
create temporary table first_fast as select dispatch_id from private.firebase_live_dispatch_state;
select ok(public.begin_firebase_live_dispatch((select dispatch_id from first_fast)),'insert reservation begins');
create temporary table first_claim as select * from public.claim_firebase_live_dispatch((select dispatch_id from first_fast),25);
select is((select count(*)::integer from first_claim),2,'batch claims both rows');
select is((select count(distinct access->>'revision')::integer from first_claim),1,'same room access snapshot shares one revision within batch');
select is((select count(distinct revision)::integer from first_claim),2,'publication cursors stay unique');
select public.finish_firebase_live((select dispatch_id from first_fast),id::bigint) from first_claim;
insert into private.firebase_live_outbox(room_id,epoch,kind) values('92000000-0000-4000-8000-000000000001',1,'control');
select is((select count(*)::integer from fast_http_calls),1,'event during running does not overlap invocation');
select ok(public.finish_firebase_live_dispatch((select dispatch_id from first_fast),true,'{"supabaseRequests":2,"supabaseRequestMs":30,"supabaseRequestMaxMs":20}'),'successful finish accepts request timing metrics');
select is((select count(*)::integer from fast_http_calls),2,'successful finish immediately schedules waiting publication');
select is((select phase from private.firebase_live_dispatch_state),'queued','successor is tracked');
select ok(not public.finish_firebase_live_dispatch((select dispatch_id from first_fast),true,'{}'),'old finish cannot clear successor');
create temporary table second_fast as select dispatch_id from private.firebase_live_dispatch_state;
select ok(public.begin_firebase_live_dispatch((select dispatch_id from second_fast)),'successor starts once');
create temporary table second_claim as select * from public.claim_firebase_live_dispatch((select dispatch_id from second_fast),25);
select is((select access->>'revision' from second_claim),(select min(access->>'revision') from first_claim),'unchanged snapshot keeps revision across invocations');
select ok(public.finish_firebase_live_dispatch((select dispatch_id from second_fast),false,'{"supabaseRequests":1,"supabaseRequestMs":10,"supabaseRequestMaxMs":10}'),'failed invocation finishes without chaining');
select is((select count(*)::integer from fast_http_calls),2,'failure does not hot-loop');
select is((select cumulative_totals->>'supabaseRequestMs' from private.firebase_live_dispatch_state),'40','request durations accumulate');
select is((select cumulative_totals->>'supabaseRequestMaxMs' from private.firebase_live_dispatch_state),'20','request maxima use greatest, not sum');
select is((private.dispatch_firebase_live()->>'scheduled')::boolean,true,'cron remains retry recovery path');
select ok(public.begin_firebase_live_dispatch((select dispatch_id from private.firebase_live_dispatch_state)),'retry begins');
update private.firebase_live_dispatch_state set expires_at=clock_timestamp()-interval '1 second';
insert into private.firebase_live_outbox(room_id,epoch,kind) values('92000000-0000-4000-8000-000000000001',1,'control');
select is((select count(*)::integer from fast_http_calls),3,'expired running state is never replaced by insert wake');
update private.firebase_live_dispatch_config set enabled=false;
select ok(public.finish_firebase_live_dispatch((select dispatch_id from private.firebase_live_dispatch_state),true,'{}'),'late finish remains allowed after stop');
select is((select count(*)::integer from fast_http_calls),3,'stopped scheduler cannot chain');
truncate private.firebase_live_outbox;

update private.firebase_live_dispatch_config set enabled=true;
update private.firebase_live_dispatch_state set phase='running',dispatch_id='95000000-0000-4000-8000-000000000001';
select ok(public.finish_firebase_live_dispatch('95000000-0000-4000-8000-000000000001',true,'{}'),'maintenance-only successful finish completes');
select is((select count(*)::integer from fast_http_calls),3,'maintenance-only work never immediately chains');

-- Enqueue failure must preserve source data and leave cron able to retry.
create or replace function private.enqueue_firebase_live_dispatch(p_dispatch uuid,p_secret text)
returns bigint language plpgsql set search_path='' as $$begin raise exception 'synthetic enqueue failure'; end $$;
update private.firebase_live_dispatch_config set enabled=true;
select lives_ok($$insert into private.firebase_live_outbox(room_id,epoch,kind) values('92000000-0000-4000-8000-000000000001',1,'control')$$,'HTTP enqueue failure cannot roll back source event');
select is((select count(*)::integer from private.firebase_live_outbox),1,'failed enqueue retains durable outbox');
select ok((select phase is null from private.firebase_live_dispatch_state),'failed enqueue leaves no false queued state');
update private.firebase_live_dispatch_state set phase='running',dispatch_id='96000000-0000-4000-8000-000000000001';
select ok(public.finish_firebase_live_dispatch('96000000-0000-4000-8000-000000000001',true,'{"published":1}'),'successor enqueue failure does not roll back completed finish');
select ok((select phase is null from private.firebase_live_dispatch_state),'failed successor enqueue leaves completed invocation released');
select is((select cumulative_totals->>'published' from private.firebase_live_dispatch_state),'1','failed successor preserves completed metrics');
update private.firebase_live_dispatch_config set enabled=false;
truncate private.firebase_live_outbox;

-- Authoritative room snapshots: membership, epoch and cohort enablement all fence.
insert into auth.users(id,instance_id,aud,role,raw_app_meta_data,raw_user_meta_data,is_anonymous,created_at,updated_at)
values('93000000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','{"provider":"anonymous","providers":["anonymous"]}','{}',true,now(),now()),
('93000000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','{"provider":"anonymous","providers":["anonymous"]}','{}',true,now(),now());
select set_config('request.jwt.claim.sub','93000000-0000-4000-8000-000000000001',true);
select public.upsert_profile('빠른발행','pixel_hamster');
create temporary table fast_room as select * from public.create_room('fast dispatch');
insert into private.firebase_live_users values('93000000-0000-4000-8000-000000000001',true),('93000000-0000-4000-8000-000000000002',true);
insert into private.firebase_live_rooms select room_id,true from fast_room;
update private.firebase_live_config set enabled=true;
truncate private.firebase_live_outbox;
insert into private.firebase_live_outbox(room_id,epoch,kind) select room_id,1,'control' from fast_room;
create temporary table snapshots(stage text,access jsonb);
insert into snapshots select 'initial',access from public.claim_firebase_live('94000000-0000-4000-8000-000000000001',100);
select is((select (access->>'enabled')::boolean from snapshots where stage='initial'),true,'enabled cohort snapshot');
update private.firebase_live_outbox set claim_until=null;
insert into snapshots select 'reclaim',access from public.claim_firebase_live('94000000-0000-4000-8000-000000000002',100);
select is((select access from snapshots where stage='reclaim'),(select access from snapshots where stage='initial'),'retry preserves authority revision and complete snapshot');
truncate private.firebase_live_outbox;
select set_config('request.jwt.claim.sub','93000000-0000-4000-8000-000000000002',true);
select public.upsert_profile('둘째','pixel_hamster');
select * from public.join_room((select invite_code from fast_room));
insert into snapshots select 'join',access from public.claim_firebase_live('94000000-0000-4000-8000-000000000003',100) limit 1;
select ok((select (access->>'revision')::bigint from snapshots where stage='join')>(select (access->>'revision')::bigint from snapshots where stage='initial'),'membership change advances access revision');
select ok((select access->'members' ? '93000000-0000-4000-8000-000000000002' from snapshots where stage='join'),'snapshot contains new member');
truncate private.firebase_live_outbox;
update public.rooms set realtime_epoch=realtime_epoch+1 where id=(select room_id from fast_room);
insert into private.firebase_live_outbox(room_id,epoch,kind) select room_id,1,'control' from fast_room;
insert into snapshots select 'epoch',access from public.claim_firebase_live('94000000-0000-4000-8000-000000000004',100) limit 1;
select ok((select (access->>'revision')::bigint from snapshots where stage='epoch')>(select (access->>'revision')::bigint from snapshots where stage='join'),'epoch change advances access revision');
truncate private.firebase_live_outbox;
update private.firebase_live_config set enabled=false;
insert into private.firebase_live_outbox(room_id,epoch,kind) select room_id,1,'control' from fast_room;
insert into snapshots select 'disabled',access from public.claim_firebase_live('94000000-0000-4000-8000-000000000005',100) limit 1;
select ok((select (access->>'revision')::bigint from snapshots where stage='disabled')>(select (access->>'revision')::bigint from snapshots where stage='epoch'),'enabled state change advances revision');
select is((select (access->>'enabled')::boolean from snapshots where stage='disabled'),false,'disabled tombstone retained');
truncate private.firebase_live_outbox;
update private.firebase_live_config set enabled=true;
insert into private.firebase_live_outbox(room_id,epoch,kind) select room_id,1,'control' from fast_room;
insert into snapshots select 'reenabled',access from public.claim_firebase_live('94000000-0000-4000-8000-000000000006',100) limit 1;
select ok((select (access->>'revision')::bigint from snapshots where stage='reenabled')>(select (access->>'revision')::bigint from snapshots where stage='disabled'),'A to B to A never reuses old authorization revision');
select * from finish();
rollback;
