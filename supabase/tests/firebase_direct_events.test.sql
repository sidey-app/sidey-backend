begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select no_plan();
select ok(not(select direct_events_enabled from private.firebase_live_config),'direct publication ships OFF');
select ok(not has_function_privilege('anon','public.authorize_firebase_direct_event(uuid,bigint,uuid,text,uuid,text)','execute'),'anonymous authorization denied');
select ok(not has_table_privilege('authenticated','private.firebase_direct_events','select'),'metadata is private');
select ok(not exists(select 1 from information_schema.columns where table_schema='private' and table_name='firebase_direct_events'
 and column_name in ('payload','claimed_by','delivered_at','attempts')),'no payload or delivery/retry state');
insert into auth.users(id,instance_id,aud,role,raw_app_meta_data,raw_user_meta_data,is_anonymous,created_at,updated_at)
select ('a1000000-0000-4000-8000-00000000000'||n)::uuid,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
 '{"provider":"anonymous","providers":["anonymous"]}','{}',true,now(),now() from generate_series(1,3)n;
insert into auth.sessions(id,user_id,created_at,updated_at) values
 ('a2000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001',now(),now());
select set_config('request.jwt.claim.sub','a1000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',jsonb_build_object('sub','a1000000-0000-4000-8000-000000000001',
 'session_id','a2000000-0000-4000-8000-000000000001','exp',extract(epoch from now()+interval '1 hour'))::text,true);
select public.upsert_profile('직접발행','pixel_hamster');
create temporary table direct_room as select * from public.create_room('direct event tests');
select set_config('request.jwt.claim.sub','a1000000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{}',true);
select public.upsert_profile('친구','pixel_hamster');
select * from public.join_room((select invite_code from direct_room));
select set_config('request.jwt.claim.sub','a1000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims',jsonb_build_object('sub','a1000000-0000-4000-8000-000000000001',
 'session_id','a2000000-0000-4000-8000-000000000001','exp',extract(epoch from now()+interval '1 hour'))::text,true);
insert into private.firebase_live_users values('a1000000-0000-4000-8000-000000000001',true),('a1000000-0000-4000-8000-000000000002',true);
insert into private.firebase_live_rooms select room_id,true from direct_room;
update private.firebase_live_config set enabled=true;
select ok(not(public.prepare_firebase_live_lease()?'directEvents'),'live alone does not advertise direct events');
update private.firebase_live_config set direct_events_enabled=true;
select is(public.prepare_firebase_live_lease()->'directEvents'->>'endpoint','realtime-event','explicit server capability');
create function pg_temp.direct(p_kind text,p_id uuid,p_seq text default null,p_target uuid default null)
returns jsonb language sql as $$select public.authorize_firebase_direct_event((select room_id from direct_room),
 (select realtime_epoch from public.rooms where id=(select room_id from direct_room)),p_id,p_kind,p_target,p_seq)$$;
truncate private.firebase_live_outbox;
create temporary table first_direct as select pg_temp.direct('typing_start','a3000000-0000-4000-8000-000000000001','10') result;
select is((select result->'payload'->>'user_id' from first_direct),'a1000000-0000-4000-8000-000000000001','actor comes from verified auth');
select is((select count(*)::integer from private.firebase_live_outbox),0,'direct event never enters outbox');
select is((select expires_at-occurred_at from private.firebase_direct_events limit 1),interval '5 seconds','immutable five second TTL');
select throws_ok($$select pg_temp.direct('typing_start','a3000000-0000-4000-8000-000000000001','11')$$,'PT409','duplicate_event','lost-response duplicate cannot retry publication');
select lives_ok($$select pg_temp.direct('typing_stop','a3000000-0000-4000-8000-000000000002','12')$$,'new stop accepted');
select throws_ok($$select pg_temp.direct('typing_start','a3000000-0000-4000-8000-000000000003','11')$$,'PT409','stale_typing_sequence','delayed start cannot undo stop');
select ok((select revision from private.firebase_direct_events where event_id='a3000000-0000-4000-8000-000000000002')>
 (select revision from private.firebase_direct_events where event_id='a3000000-0000-4000-8000-000000000001'),'receiver revision orders start and stop');
select public.broadcast_room_event((select room_id from direct_room),(select realtime_epoch from public.rooms where id=(select room_id from direct_room)),'typing_start');
select pg_temp.direct('typing_stop','a3000000-0000-4000-8000-000000000007','13');
create temporary table legacy_claim as select * from public.claim_firebase_live('a4000000-0000-4000-8000-000000000001',100);
select ok((select revision::bigint from legacy_claim where kind='typing_start') <
 (select revision from private.firebase_direct_events where event_id='a3000000-0000-4000-8000-000000000007'),'queued legacy start stays older than direct stop even when claimed later');
truncate private.firebase_live_outbox;
delete from private.firebase_direct_events where event_id='a3000000-0000-4000-8000-000000000007';
select throws_ok($$select pg_temp.direct('typing_start','a3000000-0000-4000-8000-000000000003','9223372036854775808')$$,'22023','invalid_realtime_event','sequence overflow rejected');
select throws_ok($$select pg_temp.direct('character_throw','a3000000-0000-4000-8000-000000000004',null,'a1000000-0000-4000-8000-000000000003')$$,
 '42501','target_membership_required','outsider target forbidden');
-- Even a stale equipped value cannot grant an unowned paid throwable.
update public.profiles set equipped_throwable_id=(select catalog_item_id from public.commerce_products where product_kind='throwable' and active limit 1)
 where id='a1000000-0000-4000-8000-000000000001';
select is(pg_temp.direct('character_throw','a3000000-0000-4000-8000-000000000004',null,'a1000000-0000-4000-8000-000000000002')->'payload'->>'throwable_id',
 'patch_soft_ball','unowned equipment never authorizes paid item');
select throws_ok(format('select public.authorize_firebase_direct_event(%L,0,%L,%L)',(select room_id from direct_room),
 'a3000000-0000-4000-8000-000000000005','character_pulse'),'22023','invalid_realtime_event','invalid epoch rejected');
select throws_ok(format('select public.authorize_firebase_direct_event(%L,1,%L,%L)',(select room_id from direct_room),
 'a3000000-0000-4000-8000-000000000005','character_pulse'),'PT409','stale_realtime_epoch','stale epoch rejected');
insert into private.realtime_event_attempts(user_id,room_id,event_name)
 select 'a1000000-0000-4000-8000-000000000001',room_id,'character_pulse' from direct_room cross join generate_series(1,5);
select throws_ok($$select pg_temp.direct('character_pulse','a3000000-0000-4000-8000-000000000005')$$,'P0001','realtime_event_rate_limited','legacy/shared rate ledger enforced');
select is(jsonb_array_length(public.firebase_live_maintenance()->'directEvents'),0,'cleanup cannot race active gateway writes');
update private.firebase_direct_events set expires_at=clock_timestamp()-interval '6 seconds';
select is(jsonb_array_length(public.firebase_live_maintenance()->'directEvents'),0,'expired event waits in-flight HTTP grace');
update private.firebase_direct_events set expires_at=clock_timestamp()-interval '31 seconds';
select ok(private.firebase_live_dispatch_has_work(),'direct-only expired records wake maintenance without outbox');
select is(jsonb_array_length(public.firebase_live_maintenance()->'directEvents'),3,'expired metadata supplies cleanup addresses');
select public.finish_firebase_live_cleanup('direct_event','a3000000-0000-4000-8000-000000000001');
select is(jsonb_array_length(public.firebase_live_maintenance()->'directEvents'),2,'cleanup acknowledgment is independent of delivery');
select throws_ok($$select pg_temp.direct('typing_start','a3000000-0000-4000-8000-000000000001','13')$$,'PT409','duplicate_event','cleanup preserves short dedup record');
update private.firebase_direct_events set expires_at=clock_timestamp()-interval '16 minutes';
select public.firebase_live_maintenance();
select is((select count(*)::integer from private.firebase_direct_events),2,'only cleaned dedup metadata prunes');
delete from public.room_members where room_id=(select room_id from direct_room) and user_id='a1000000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.direct('typing_start','a3000000-0000-4000-8000-000000000006','14')$$,'42501','membership_required','kicked actor cannot authorize');
delete from auth.sessions where id='a2000000-0000-4000-8000-000000000001';
select throws_ok($$select pg_temp.direct('typing_start','a3000000-0000-4000-8000-000000000006','15')$$,'42501','active_session_required','revoked auth session denied');
select * from finish();
rollback;
