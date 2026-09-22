begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select no_plan();
create temporary table wake_http_calls(dispatch_id uuid);
create or replace function private.enqueue_firebase_live_dispatch(p_dispatch uuid,p_secret text)
returns bigint language plpgsql set search_path='' as $$begin
 insert into pg_temp.wake_http_calls values(p_dispatch); return (select count(*) from pg_temp.wake_http_calls);
end $$;
select vault.create_secret('synthetic-only-private-scheduler-secret-32','sidey_firebase_live_publish_secret_staging');
select ok(not has_function_privilege('anon','public.authorize_firebase_publish_wake(uuid,bigint,uuid)','execute'),'anonymous wake forbidden');
select ok(has_function_privilege('authenticated','public.authorize_firebase_publish_wake(uuid,bigint,uuid)','execute'),'authenticated validation available');
select ok(not has_function_privilege('authenticated','public.begin_claim_firebase_live_dispatch(uuid,integer)','execute'),'client cannot acquire publisher ownership');
select ok(not has_column_privilege('authenticated','private.firebase_live_outbox','publish_wake_requested_at','select'),'dedup metadata private');
insert into auth.users(id,instance_id,aud,role,raw_app_meta_data,raw_user_meta_data,is_anonymous,created_at,updated_at)
select ('b1000000-0000-4000-8000-00000000000'||n)::uuid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 '{"provider":"anonymous","providers":["anonymous"]}','{}',true,now(),now() from generate_series(1,2)n;
insert into auth.sessions(id,user_id,created_at,updated_at) values
 ('b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',now(),now());
select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',jsonb_build_object('sub','b1000000-0000-4000-8000-000000000001',
 'session_id','b2000000-0000-4000-8000-000000000001','exp',extract(epoch from now()+interval '1 hour'))::text,true);
select public.upsert_profile('빠른깨우기','pixel_hamster');
create temporary table wake_room as select * from public.create_room('publish wake');
select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000002',true);
select public.upsert_profile('친구','pixel_hamster');
select * from public.join_room((select invite_code from wake_room));
select set_config('request.jwt.claim.sub','b1000000-0000-4000-8000-000000000001',true);
insert into private.firebase_live_users values('b1000000-0000-4000-8000-000000000001',true),('b1000000-0000-4000-8000-000000000002',true);
insert into private.firebase_live_rooms select room_id,true from wake_room;
update private.firebase_live_config set enabled=true;
select ok(not(public.prepare_firebase_live_lease()?'publisherWake'),'live-only enrollment advertises no fast wake');
update private.firebase_live_config set direct_events_enabled=true;
select is(public.prepare_firebase_live_lease()->'publisherWake',jsonb_build_object('endpoint','realtime-wake','protocolVersion',1),'same approved staging lease advertises wake capability');
truncate private.firebase_live_outbox;
insert into public.messages(id,room_id,sender_id,body)
select ('b3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,room_id,
 case when n=9 then 'b1000000-0000-4000-8000-000000000002'::uuid else 'b1000000-0000-4000-8000-000000000001'::uuid end,
 'synthetic' from wake_room cross join generate_series(1,9)n;
create function pg_temp.wake(n integer) returns jsonb language sql as $$
 select public.authorize_firebase_publish_wake((select room_id from wake_room),
 (select realtime_epoch from public.rooms where id=(select room_id from wake_room)),
 ('b3000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid)$$;
select throws_ok($$select pg_temp.wake(9)$$,'42501','message_ownership_required','another member message cannot wake');
select throws_ok($$select pg_temp.wake(10)$$,'42501','message_ownership_required','forged UUID cannot wake');
select throws_ok(format('select public.authorize_firebase_publish_wake(%L,1,%L)',(select room_id from wake_room),
 'b3000000-0000-4000-8000-000000000001'),'PT409','stale_realtime_epoch','old epoch denied');
update private.firebase_live_leases set expires_at=clock_timestamp()-interval '1 second';
select throws_ok($$select pg_temp.wake(1)$$,'42501','session_refresh_required','expired lease denied');
select public.prepare_firebase_live_lease();
update private.firebase_live_config set direct_events_enabled=false;
select throws_ok($$select pg_temp.wake(1)$$,'42501','publisher_wake_disabled','approval off blocks wake');
update private.firebase_live_config set direct_events_enabled=true;
select is(pg_temp.wake(1)->>'reason','disabled','disabled scheduler remains off');
select is((select count(*)::integer from wake_http_calls),0,'disabled wake never enqueues');
select is(pg_temp.wake(1)->>'reason','duplicate','a message gets only one fast-wake attempt');
update private.firebase_live_dispatch_config set enabled=true,owner_run_id='b4000000-0000-4000-8000-000000000001',run_deadline_at=clock_timestamp()+interval '30 minutes';
create temporary table wake_result as select pg_temp.wake(2) result;
select is((select result->>'reason' from wake_result),'queued','first fast wake reserves normal durable fallback dispatch');
select is((select count(*)::integer from wake_http_calls),1,'pg_net fallback still enqueued exactly once');
select ok((select result=jsonb_build_object('reason','queued','dispatchId',(select dispatch_id from private.firebase_live_dispatch_state)) from wake_result),'response exposes only reserved ID and reason');
select is((select phase from private.firebase_live_dispatch_state),'queued','authorization never claims running work');
select is(pg_temp.wake(2)->>'reason','duplicate','repeat cannot invoke again');
select ok(public.begin_firebase_live_dispatch((select dispatch_id from private.firebase_live_dispatch_state)),'service handler atomically wins queued dispatch');
select ok(not public.begin_firebase_live_dispatch((select dispatch_id from private.firebase_live_dispatch_state)),'late pg_net duplicate cannot start twice');
select is(pg_temp.wake(3)->>'reason','running','active publisher receives no parallel ownership');
select is((select count(*)::integer from wake_http_calls),1,'running no-op creates no extra HTTP queue entry');
select public.finish_firebase_live_dispatch((select dispatch_id from private.firebase_live_dispatch_state),false,'{}');
select private.dispatch_firebase_live();
create temporary table expired_wake as select dispatch_id from private.firebase_live_dispatch_state;
update private.firebase_live_dispatch_state set expires_at=clock_timestamp()-interval '1 second';
select is(pg_temp.wake(4)->>'reason','queued','expired queued dispatch is replaced through the normal scheduler');
select ok((select dispatch_id from private.firebase_live_dispatch_state)<>(select dispatch_id from expired_wake),'expired queue gets a new fence');
select ok(not public.begin_firebase_live_dispatch((select dispatch_id from expired_wake)),'old queued callback cannot acquire replacement');
update private.firebase_live_dispatch_config set enabled=false;
select ok(not public.begin_firebase_live_dispatch((select dispatch_id from private.firebase_live_dispatch_state)),'disable between authorization and service start prevents ownership');
update private.firebase_live_outbox set delivered_at=clock_timestamp() where payload->>'message_id'='b3000000-0000-4000-8000-000000000005';
select is(pg_temp.wake(5)->>'reason','delivered','completed message needs no wake');
insert into private.realtime_event_attempts(user_id,room_id,event_name)
 select 'b1000000-0000-4000-8000-000000000001',room_id,'firebase_publish_wake' from wake_room cross join generate_series(1,30);
select throws_ok($$select pg_temp.wake(6)$$,'PT429','publisher_wake_rate_limited','fast wakes have an independent bounded rate');
select ok((select publish_wake_requested_at is null from private.firebase_live_outbox where payload->>'message_id'='b3000000-0000-4000-8000-000000000006'),'rate rejection preserves original outbox');
select is((select count(*)::integer from public.messages where room_id=(select room_id from wake_room)),9,'wake never writes or resends source messages');
delete from public.room_members where room_id=(select room_id from wake_room) and user_id='b1000000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.wake(7)$$,'42501','membership_required','kicked sender cannot wake old message');
delete from auth.sessions where id='b2000000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.wake(7)$$,'42501','active_session_required','revoked auth session cannot wake');
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{}',true);
select throws_ok($$select pg_temp.wake(7)$$,'42501','authentication_required','missing verified user denied');
select * from finish();
rollback;
