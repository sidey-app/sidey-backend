begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

select is(
  (select enabled::text || ':' || kill_switch::text || ':' || cohort_basis_points::text
   from private.firebase_client_rollout_config where id),
  'false:true:0',
  'forward migration leaves the client selector fail-closed'
);
select is(
  (select contract_hash from private.firebase_client_rollout_config where id),
  '0f2845d033df248b1745c6526c8c7100b8d8fa6839b45f28c73b1023053fce2e',
  'selector pins the new transient bridge contract hash'
);
select ok(
  (select enabled and wake_url is null from private.firebase_transient_bridge_config where singleton),
  'bridge starts enabled internally but without an unverified wake URL'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.bridge_firebase_transient_to_legacy(uuid,uuid,uuid,uuid,text,uuid,text,bigint)',
    'execute'
  ),
  'users cannot invoke the Firebase service bridge'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bridge_firebase_transient_to_legacy(uuid,uuid,uuid,uuid,text,uuid,text,bigint)',
    'execute'
  ),
  'service role owns the Firebase service bridge'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.claim_firebase_transient_publications(uuid,integer)', 'execute'
  ) and not has_function_privilege(
    'authenticated', 'public.validate_firebase_transient_publication(uuid,bigint)', 'execute'
  ) and not has_function_privilege(
    'authenticated', 'public.ack_firebase_transient_publication(uuid,bigint)', 'execute'
  ),
  'users cannot claim validate or acknowledge the durable outbox'
);
select ok(
  not has_function_privilege(
    'service_role', 'private.delete_expired_firebase_transient_publications()', 'execute'
  ) and not has_function_privilege(
    'service_role', 'private.delete_expired_firebase_transient_bridge_events()', 'execute'
  ),
  'retention helpers remain private even from API roles'
);

insert into auth.users(
  id, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
) values
  ('c1000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"anonymous","providers":["anonymous"]}',
   '{}', true, now(), now()),
  ('c1000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"anonymous","providers":["anonymous"]}',
   '{}', true, now(), now()),
  ('c1000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', '{"provider":"anonymous","providers":["anonymous"]}',
   '{}', true, now(), now());
insert into auth.sessions(id, user_id, created_at, updated_at) values
  ('c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', now(), now()),
  ('c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002', now(), now()),
  ('c2000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003', now(), now());

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-000000000001","session_id":"c2000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select public.upsert_profile('브리지 발신자', 'pixel_penguin');
create temporary table transient_bridge_room as
select * from public.create_room('transient bridge');
grant select on transient_bridge_room to authenticated, service_role;

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-000000000002","session_id":"c2000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
select public.upsert_profile('브리지 수신자', 'pixel_hamster');
select * from public.join_room((select invite_code from transient_bridge_room));

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000003', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-000000000003","session_id":"c2000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select public.upsert_profile('브리지 외부인', 'pixel_cat');

update private.firebase_client_rollout_config
set enabled = true, kill_switch = false, cohort_basis_points = 10000
where id;

-- A revoked old-client session must not enqueue a throw into Firebase.
update auth.sessions set not_after = clock_timestamp() - interval '1 second'
where id = 'c2000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-000000000001","session_id":"c2000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
set local role authenticated;
select throws_ok(
  format(
    'select public.broadcast_character_throw(%L::uuid,%s,%L::uuid,%L::uuid)',
    (select room_id from transient_bridge_room),
    (select realtime_epoch from public.rooms where id = (select room_id from transient_bridge_room)),
    'e3000000-0000-4000-8000-000000000000',
    'c1000000-0000-4000-8000-000000000002'
  ),
  '42501', 'authentication_required',
  'revoked legacy session cannot publish a throw'
);
set local role postgres;
update auth.sessions set not_after = null
where id = 'c2000000-0000-4000-8000-000000000001';

delete from realtime.messages where topic = (
  select private.room_topic(id, realtime_epoch, 'ephemeral')
  from public.rooms where id = (select room_id from transient_bridge_room)
);
truncate private.firebase_transient_publish_outbox restart identity;
delete from private.realtime_event_attempts
where user_id = 'c1000000-0000-4000-8000-000000000001';

-- Old Supabase clients keep receiving Broadcast and enqueue one compact write.
set local role authenticated;
select public.broadcast_room_event(
  (select room_id from transient_bridge_room),
  (select realtime_epoch from public.rooms where id = (select room_id from transient_bridge_room)),
  'typing_start', 'e3000000-0000-4000-8000-000000000001'
);
select public.broadcast_room_event(
  (select room_id from transient_bridge_room),
  (select realtime_epoch from public.rooms where id = (select room_id from transient_bridge_room)),
  'typing_stop', 'e3000000-0000-4000-8000-000000000002'
);
select public.broadcast_room_event(
  (select room_id from transient_bridge_room),
  (select realtime_epoch from public.rooms where id = (select room_id from transient_bridge_room)),
  'character_pulse', 'e3000000-0000-4000-8000-000000000003'
);
select public.broadcast_character_throw(
  (select room_id from transient_bridge_room),
  (select realtime_epoch from public.rooms where id = (select room_id from transient_bridge_room)),
  'e3000000-0000-4000-8000-000000000004',
  'c1000000-0000-4000-8000-000000000002'
);
set local role postgres;
select is(
  (select count(*)::integer from realtime.messages
   where event in ('typing_start', 'typing_stop', 'character_pulse', 'character_throw')
     and payload->>'event_id' like 'e3000000-0000-4000-8000-00000000000%'),
  4,
  'old client events still reach Supabase clients once'
);
select is(
  (select count(*)::integer from private.firebase_transient_publish_outbox),
  4,
  'old client events enqueue all four Firebase compact publications'
);
select is(
  (select count(*)::integer from private.firebase_transient_publish_outbox
   where session_id = 'c2000000-0000-4000-8000-000000000001'),
  4,
  'all publications preserve the exact authenticated Supabase session'
);
select is(
  (select wire_code from private.firebase_transient_publish_outbox
   where event_id = 'e3000000-0000-4000-8000-000000000004'),
  '0',
  'throw publication freezes the authorized compact wire code'
);

-- Lost-response retries do not duplicate outbox rows; UUID reuse with another
-- payload is rejected transactionally.
set local role authenticated;
select public.broadcast_room_event(
  (select room_id from transient_bridge_room),
  (select realtime_epoch from public.rooms where id = (select room_id from transient_bridge_room)),
  'typing_start', 'e3000000-0000-4000-8000-000000000001'
);
select throws_ok(
  format(
    'select public.broadcast_room_event(%L::uuid,%s,%L,%L::uuid)',
    (select room_id from transient_bridge_room),
    (select realtime_epoch from public.rooms where id = (select room_id from transient_bridge_room)),
    'character_pulse',
    'e3000000-0000-4000-8000-000000000001'
  ),
  '23505', 'event_id_conflict',
  'same event UUID cannot alias another compact payload'
);
set local role postgres;
select is(
  (select count(*)::integer from private.firebase_transient_publish_outbox
   where event_id = 'e3000000-0000-4000-8000-000000000001'),
  1,
  'old-client retry remains one durable publication'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table claimed_transient as
select * from public.claim_firebase_transient_publications(
  'e4000000-0000-4000-8000-000000000001', 1
);
select is((select count(*)::integer from claimed_transient), 1, 'worker claims a bounded publication');
select ok(
  public.validate_firebase_transient_publication(
    'e4000000-0000-4000-8000-000000000001', (select id from claimed_transient)
  ),
  'claimed publication is revalidated before the remote write'
);
select ok(
  public.ack_firebase_transient_publication(
    'e4000000-0000-4000-8000-000000000001', (select id from claimed_transient)
  ),
  'worker can acknowledge its live claim'
);
select ok(
  not public.ack_firebase_transient_publication(
    'e4000000-0000-4000-8000-000000000001', (select id from claimed_transient)
  ),
  'duplicate acknowledgement is a no-op'
);
create temporary table remaining_transients as
select * from public.claim_firebase_transient_publications(
  'e4000000-0000-4000-8000-000000000002', 100
);
set local role postgres;
update auth.sessions set not_after = clock_timestamp() - interval '1 second'
where id = 'c2000000-0000-4000-8000-000000000001';
set local role service_role;
select ok(
  not public.validate_firebase_transient_publication(
    'e4000000-0000-4000-8000-000000000002',
    (select id from remaining_transients where kind = 'character_pulse')
  ),
  'pulse publication is rejected if its exact source session is revoked after enqueue'
);
set local role postgres;
update auth.sessions set not_after = null
where id = 'c2000000-0000-4000-8000-000000000001';

-- A concurrent wake must not expire another worker's still-valid 90-second
-- claim just because the transient crossed its five-second freshness bound.
update private.firebase_transient_publish_outbox
set delivered_at = clock_timestamp(), claimed_by = null, claim_until = null
where delivered_at is null;
insert into private.firebase_transient_publish_outbox(
  event_id, room_id, epoch, actor_id, session_id, kind
) values (
  'e4000000-0000-4000-8000-000000000003',
  (select room_id from transient_bridge_room),
  (select realtime_epoch from public.rooms where id = (select room_id from transient_bridge_room)),
  'c1000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000001',
  'character_pulse'
);
set local role service_role;
create temporary table raced_transient_claim as
select * from public.claim_firebase_transient_publications(
  'e4000000-0000-4000-8000-000000000003', 1
);
select is((select count(*)::integer from raced_transient_claim), 1,
  'first worker claims the fresh publication');
set local role postgres;
update private.firebase_transient_publish_outbox
set occurred_at = clock_timestamp() - interval '6 seconds'
where event_id = 'e4000000-0000-4000-8000-000000000003';
set local role service_role;
select is(
  (select count(*)::integer from public.claim_firebase_transient_publications(
    'e4000000-0000-4000-8000-000000000004', 100
  )),
  0,
  'second worker neither claims nor settles an in-flight expired publication'
);
select ok(
  public.validate_firebase_transient_publication(
    'e4000000-0000-4000-8000-000000000003',
    (select id from raced_transient_claim)
  ),
  'first worker retains its security claim after a concurrent wake'
);
select ok(
  public.ack_firebase_transient_publication(
    'e4000000-0000-4000-8000-000000000003',
    (select id from raced_transient_claim)
  ),
  'first worker can settle the claim itself'
);
set local role postgres;

-- Firebase-origin events use a direct private Broadcast and never re-enter the
-- legacy outbox. CloudEvent-derived UUIDs dedupe retries.
delete from private.realtime_event_attempts
where user_id = 'c1000000-0000-4000-8000-000000000001';
create temporary table outbox_before as
select count(*)::integer as n from private.firebase_transient_publish_outbox;
grant select on outbox_before to service_role;
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table fresh_bridge as
with source as (
  select floor(extract(epoch from clock_timestamp()) * 1000)::bigint as occurred_at_ms
)
select source.occurred_at_ms,
       public.bridge_firebase_transient_to_legacy(
         'e5000000-0000-4000-8000-000000000001',
         (select room_id from transient_bridge_room),
         'c1000000-0000-4000-8000-000000000001',
         'c2000000-0000-4000-8000-000000000001',
         'typing_start', null, null, source.occurred_at_ms
       ) as value
from source;
select is((select value->>'bridged' from fresh_bridge), 'true', 'fresh Firebase event reaches old clients');
select is((select value->>'duplicate' from fresh_bridge), 'false', 'first Firebase event is new');
select is(
  (public.bridge_firebase_transient_to_legacy(
    'e5000000-0000-4000-8000-000000000001',
    (select room_id from transient_bridge_room),
    'c1000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001',
    'typing_start', null, null,
    (select occurred_at_ms from fresh_bridge)
  )->>'duplicate'),
  'true',
  'CloudEvent retry resolves from durable dedupe metadata'
);
select throws_ok(
  format(
    'select public.bridge_firebase_transient_to_legacy(%L::uuid,%L::uuid,%L::uuid,%L::uuid,%L,null,null,%s)',
    'e5000000-0000-4000-8000-000000000001',
    (select room_id from transient_bridge_room),
    'c1000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001',
    'typing_stop',
    floor(extract(epoch from clock_timestamp()) * 1000)::bigint
  ),
  '23505', 'event_id_conflict',
  'Firebase UUID reuse with changed semantics is rejected'
);
set local role postgres;
select is(
  (select count(*)::integer from private.firebase_transient_publish_outbox),
  (select n from outbox_before),
  'Firebase to Supabase delivery cannot loop back into the outbox'
);
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table stale_bridge as
select public.bridge_firebase_transient_to_legacy(
  'e5000000-0000-4000-8000-000000000002',
  (select room_id from transient_bridge_room),
  'c1000000-0000-4000-8000-000000000001', null,
  'character_pulse', null, null,
  floor(extract(epoch from clock_timestamp() - interval '6 seconds') * 1000)::bigint
) as value;
select is((select value->>'bridged' from stale_bridge), 'false', 'stale Firebase animation is recorded but suppressed');
select throws_ok(
  format(
    'select public.bridge_firebase_transient_to_legacy(%L::uuid,%L::uuid,%L::uuid,null,%L,null,null,%s)',
    'e5000000-0000-4000-8000-000000000003',
    (select room_id from transient_bridge_room),
    'c1000000-0000-4000-8000-000000000003',
    'character_pulse',
    floor(extract(epoch from clock_timestamp()) * 1000)::bigint
  ),
  '42501', 'membership_required',
  'Firebase actor must still be a room member'
);
select throws_ok(
  format(
    'select public.bridge_firebase_transient_to_legacy(%L::uuid,%L::uuid,%L::uuid,null,%L,%L::uuid,%L,%s)',
    'e5000000-0000-4000-8000-000000000004',
    (select room_id from transient_bridge_room),
    'c1000000-0000-4000-8000-000000000001',
    'character_throw',
    'c1000000-0000-4000-8000-000000000002',
    '99',
    floor(extract(epoch from clock_timestamp()) * 1000)::bigint
  ),
  '42501', 'throwable_entitlement_required',
  'Firebase throw wire code is rechecked against current entitlement'
);

-- Shared rate ledger caps Firebase pulses at the RTDB cooldown capacity.
set local role postgres;
delete from private.realtime_event_attempts
where user_id = 'c1000000-0000-4000-8000-000000000001';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $rate$
declare n integer;
begin
  for n in 1..10 loop
    perform public.bridge_firebase_transient_to_legacy(
      ('e6000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
      (select room_id from transient_bridge_room),
      'c1000000-0000-4000-8000-000000000001', null,
      'character_pulse', null, null,
      floor(extract(epoch from clock_timestamp()) * 1000)::bigint
    );
  end loop;
end
$rate$;
select throws_ok(
  format(
    'select public.bridge_firebase_transient_to_legacy(%L::uuid,%L::uuid,%L::uuid,null,%L,null,null,%s)',
    'e6000000-0000-4000-8000-000000000011',
    (select room_id from transient_bridge_room),
    'c1000000-0000-4000-8000-000000000001',
    'character_pulse',
    floor(extract(epoch from clock_timestamp()) * 1000)::bigint
  ),
  'P0001', 'realtime_event_rate_limited',
  'Firebase bridge shares the server pulse rate ledger'
);

-- Runtime switch is symmetric: pending old publications settle, new transient
-- calls stop in both directions, while non-transient private routing survives.
set local role postgres;
update private.firebase_transient_publish_outbox
set delivered_at = null, claimed_by = null, claim_until = null
where event_id = 'e3000000-0000-4000-8000-000000000002';
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.configure_firebase_transient_bridge_v2(false)->>'enabled',
  'false',
  'operator can disable both transient bridge directions'
);
select throws_ok(
  format(
    'select public.bridge_firebase_transient_to_legacy(%L::uuid,%L::uuid,%L::uuid,null,%L,null,null,%s)',
    'e7000000-0000-4000-8000-000000000001',
    (select room_id from transient_bridge_room),
    'c1000000-0000-4000-8000-000000000001',
    'character_pulse',
    floor(extract(epoch from clock_timestamp()) * 1000)::bigint
  ),
  '42501', 'transient_bridge_disabled',
  'disabled bridge rejects Firebase-origin transient delivery'
);
set local role postgres;
select ok(
  (select delivered_at is not null from private.firebase_transient_publish_outbox
   where event_id = 'e3000000-0000-4000-8000-000000000002'),
  'disable operation settles pending old-client publications'
);
delete from private.realtime_event_attempts
where user_id = 'c1000000-0000-4000-8000-000000000001'
  and event_name = 'character_pulse';
create temporary table counts_before_disable as
select
  (select count(*)::integer from realtime.messages) as messages,
  (select count(*)::integer from private.firebase_transient_publish_outbox) as publications;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"c1000000-0000-4000-8000-000000000001","session_id":"c2000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
set local role authenticated;
select public.broadcast_room_event(
  (select room_id from transient_bridge_room),
  (select realtime_epoch from public.rooms where id = (select room_id from transient_bridge_room)),
  'character_pulse', 'e7000000-0000-4000-8000-000000000002'
);
set local role postgres;
select is(
  (select count(*)::integer from realtime.messages),
  (select messages from counts_before_disable),
  'disabled bridge suppresses old-client transient Broadcast'
);
select is(
  (select count(*)::integer from private.firebase_transient_publish_outbox),
  (select publications from counts_before_disable),
  'disabled bridge suppresses new old-client outbox rows'
);
select private.route_realtime(
  jsonb_build_object('room_id', (select room_id from transient_bridge_room)),
  'structure_changed',
  (select private.room_topic(id, realtime_epoch, 'db')
   from public.rooms where id = (select room_id from transient_bridge_room)),
  true
);
select is(
  (select count(*)::integer from realtime.messages),
  (select messages + 1 from counts_before_disable),
  'runtime transient switch does not disable non-transient Supabase routing'
);

-- Both durable tables have bounded eight-day retention.
insert into private.firebase_transient_publish_outbox(
  event_id, room_id, epoch, actor_id, session_id, kind, occurred_at, delivered_at
) values (
  'e8000000-0000-4000-8000-000000000001',
  (select room_id from transient_bridge_room),
  (select realtime_epoch from public.rooms where id = (select room_id from transient_bridge_room)),
  'c1000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000001', 'character_pulse',
  clock_timestamp() - interval '9 days', clock_timestamp() - interval '9 days'
), (
  'e8000000-0000-4000-8000-000000000002',
  (select room_id from transient_bridge_room),
  (select realtime_epoch from public.rooms where id = (select room_id from transient_bridge_room)),
  'c1000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000001', 'character_pulse',
  clock_timestamp(), clock_timestamp()
);
update private.firebase_transient_bridge_events
set accepted_at = clock_timestamp() - interval '9 days'
where event_id = 'e5000000-0000-4000-8000-000000000002';
select is(
  private.delete_expired_firebase_transient_publications(), 1::bigint,
  'outbox cleanup removes only delivered rows older than eight days'
);
select ok(
  exists (select 1 from private.firebase_transient_publish_outbox
          where event_id = 'e8000000-0000-4000-8000-000000000002'),
  'outbox cleanup preserves recent delivered rows'
);
select is(
  private.delete_expired_firebase_transient_bridge_events(), 1::bigint,
  'bridge dedupe cleanup removes only metadata older than eight days'
);
select ok(
  exists (select 1 from cron.job where jobname = 'sidey-delete-firebase-transient-publications')
  and exists (select 1 from cron.job where jobname = 'sidey-delete-firebase-transient-bridge-events'),
  'hourly bounded retention jobs are scheduled for both bridge tables'
);

select * from finish();
rollback;
