begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select no_plan();
select ok((select edge_region is null and not enabled from private.firebase_live_dispatch_config),'migration leaves region automatic and dispatch disabled');
select ok(not has_column_privilege('authenticated','private.firebase_live_dispatch_config','edge_region','update'),'clients cannot change publisher region');
select ok(not has_function_privilege('authenticated','private.prepare_firebase_live_lease_before_region()','execute'),'previous lease function remains private');
select ok(not has_function_privilege('anon','public.prepare_firebase_live_lease()','execute'),'anonymous lease denied');
select ok(has_function_privilege('authenticated','public.prepare_firebase_live_lease()','execute'),'authenticated lease contract retained');
select throws_ok($$update private.firebase_live_dispatch_config set edge_region='us-east-1'$$,'23514',
 'new row for relation "firebase_live_dispatch_config" violates check constraint "firebase_live_dispatch_edge_region_check"','unapproved region is rejected');

-- pg_net dispatches only after commit. These real queue records and headers are
-- inspected inside this rollback-only transaction; no external HTTP is sent.
create temporary table region_requests(label text,request_id bigint);
insert into region_requests values('default',private.enqueue_firebase_live_dispatch('bc000000-0000-4000-8000-000000000001','synthetic-only-region-test'));
select ok(not(select q.headers?'x-region' from net.http_request_queue q join region_requests r on r.request_id=q.id where r.label='default'),'default request has no routing override');
update private.firebase_live_dispatch_config set edge_region='ap-southeast-1';
insert into region_requests values('singapore',private.enqueue_firebase_live_dispatch('bc000000-0000-4000-8000-000000000002','synthetic-only-region-test'));
select is((select q.headers->>'x-region' from net.http_request_queue q join region_requests r on r.request_id=q.id where r.label='singapore'),'ap-southeast-1','publisher request selects Singapore');
update private.firebase_live_dispatch_config set edge_region='ap-northeast-2';
insert into region_requests values('seoul',private.enqueue_firebase_live_dispatch('bc000000-0000-4000-8000-000000000003','synthetic-only-region-test'));
select is((select q.headers->>'x-region' from net.http_request_queue q join region_requests r on r.request_id=q.id where r.label='seoul'),'ap-northeast-2','publisher request selects Seoul');
select ok((select bool_and(q.url='https://fjglrvhvdthntkvrduyi.supabase.co/functions/v1/realtime-publish-live'
  and q.method='POST' and q.timeout_milliseconds=25000
  and q.headers->>'Authorization'='Bearer synthetic-only-region-test'
  and q.headers->>'Content-Type'='application/json'
  and (convert_from(q.body,'UTF8')::jsonb-'dispatchId')='{}'::jsonb)
  from net.http_request_queue q join region_requests r on r.request_id=q.id),'fixed staging URL, secret, method, body and timeout unchanged');

insert into auth.users(id,instance_id,aud,role,raw_app_meta_data,raw_user_meta_data,is_anonymous,created_at,updated_at)
values('bc100000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 '{"provider":"anonymous","providers":["anonymous"]}','{}',true,now(),now());
insert into auth.sessions(id,user_id,created_at,updated_at)
values('bc200000-0000-4000-8000-000000000001','bc100000-0000-4000-8000-000000000001',now(),now());
select set_config('request.jwt.claims',jsonb_build_object('sub','bc100000-0000-4000-8000-000000000001',
 'session_id','bc200000-0000-4000-8000-000000000001','exp',extract(epoch from now()+interval '1 hour'))::text,true);
select public.upsert_profile('지역검사','pixel_hamster');
create temporary table region_room as select * from public.create_room('region comparison');
insert into private.firebase_live_users values('bc100000-0000-4000-8000-000000000001',true);
insert into private.firebase_live_rooms select room_id,true from region_room;
update private.firebase_live_config set enabled=true,direct_events_enabled=true;
create temporary table region_leases(label text,value jsonb);
insert into region_leases values('disabled',public.prepare_firebase_live_lease());
select ok((select not(value->'directEvents'?'region') and not(value->'publisherWake'?'region') from region_leases where label='disabled'),'disabled scheduler never advertises a retained experiment region');
update private.firebase_live_dispatch_config set enabled=true,owner_run_id='bc300000-0000-4000-8000-000000000001',
  run_deadline_at=clock_timestamp()+interval '10 minutes',edge_region=null;
-- No fixture source write can enqueue another request while this queue fence lives.
update private.firebase_live_dispatch_state set phase='queued',owner_run_id='bc300000-0000-4000-8000-000000000001',
 dispatch_id='bc400000-0000-4000-8000-000000000001',expires_at=clock_timestamp()+interval '1 minute';
insert into region_leases values('automatic',public.prepare_firebase_live_lease());
select is((select value->'directEvents' from region_leases where label='automatic'),'{"endpoint":"realtime-event","protocolVersion":1}'::jsonb,'NULL region preserves direct capability exactly');
select is((select value->'publisherWake' from region_leases where label='automatic'),'{"endpoint":"realtime-wake","protocolVersion":1}'::jsonb,'NULL region preserves wake capability exactly');
update private.firebase_live_dispatch_config set edge_region='ap-southeast-1';
insert into region_leases values('singapore',public.prepare_firebase_live_lease());
select is((select value->'directEvents' from region_leases where label='singapore'),'{"endpoint":"realtime-event","protocolVersion":1,"region":"ap-southeast-1"}'::jsonb,'direct capability uses active Singapore approval');
select is((select value->'publisherWake' from region_leases where label='singapore'),'{"endpoint":"realtime-wake","protocolVersion":1,"region":"ap-southeast-1"}'::jsonb,'wake capability uses same Singapore approval');
update private.firebase_live_dispatch_config set edge_region='ap-northeast-2';
insert into region_leases values('seoul',public.prepare_firebase_live_lease());
select ok((select value->'directEvents'->>'region'='ap-northeast-2' and value->'publisherWake'->>'region'='ap-northeast-2'
 from region_leases where label='seoul'),'both capability routes switch together to Seoul');
update private.firebase_live_dispatch_config set enabled=false;
update private.firebase_live_config set direct_events_enabled=false;
insert into region_leases values('not-approved',public.prepare_firebase_live_lease());
select ok((select not(value?'directEvents') and not(value?'publisherWake') from region_leases where label='not-approved'),'region cannot grant missing direct or wake capability');
update private.firebase_live_config set enabled=false;
select is(public.prepare_firebase_live_lease(),'{"enabled":false}'::jsonb,'disabled live transport remains disabled');
select * from finish();
rollback;
