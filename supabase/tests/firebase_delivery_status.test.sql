begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select no_plan();

select ok(
  not has_function_privilege(
    'anon', 'public.firebase_delivery_status(uuid[],uuid)', 'execute'
  ),
  'anonymous cannot inspect Firebase delivery state'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.firebase_finalize_deleted_delivery(uuid[],uuid)', 'execute'
  ),
  'authenticated users cannot finalize Firebase delivery state'
);
select ok(
  has_function_privilege(
    'service_role', 'public.firebase_delivery_status(uuid[],uuid)', 'execute'
  ),
  'service role can inspect exact Firebase delivery state'
);
select throws_ok(
  $$select public.firebase_delivery_status('{}'::uuid[],
    'd2000000-0000-4000-8000-000000000001')$$,
  'P0001', 'invalid_delivery_status_scope',
  'empty cleanup scope is rejected'
);

insert into private.firebase_access_outbox(
  user_id, revision, pending_since, delivered_revision
) values (
  'd1000000-0000-4000-8000-000000000001', 2, clock_timestamp(), 1
);
insert into private.firebase_room_revision_outbox(
  room_id, revision, pending_since, delivered_revision, deleted_at
) values (
  'd2000000-0000-4000-8000-000000000001', 3, clock_timestamp(), 2,
  clock_timestamp()
);

select is(
  public.firebase_delivery_status(
    array['d1000000-0000-4000-8000-000000000001'::uuid],
    'd2000000-0000-4000-8000-000000000001'
  )->>'ready',
  'false',
  'unacknowledged exact revisions are not ready'
);
select throws_ok(
  $$select public.firebase_finalize_deleted_delivery(
    array['d1000000-0000-4000-8000-000000000001'::uuid],
    'd2000000-0000-4000-8000-000000000001')$$,
  'P0001', 'delivery_cleanup_pending',
  'pending delivery cannot be finalized'
);

update private.firebase_access_outbox
set pending_since = null,
    delivered_revision = revision,
    delivered_at = clock_timestamp()
where user_id = 'd1000000-0000-4000-8000-000000000001';
update private.firebase_room_revision_outbox
set pending_since = null,
    delivered_revision = revision,
    delivered_at = clock_timestamp(),
    claimed_by = null,
    claim_until = null
where room_id = 'd2000000-0000-4000-8000-000000000001';

select ok(
  public.firebase_finalize_deleted_delivery(
    array['d1000000-0000-4000-8000-000000000001'::uuid],
    'd2000000-0000-4000-8000-000000000001'
  ),
  'fully ACKed deleted delivery state can be finalized'
);
select is(
  (select count(*)::integer from private.firebase_access_outbox
   where user_id = 'd1000000-0000-4000-8000-000000000001'),
  0,
  'test access tombstone is removed'
);
select is(
  (select count(*)::integer from private.firebase_room_revision_outbox
   where room_id = 'd2000000-0000-4000-8000-000000000001'),
  0,
  'test room tombstone is removed'
);
select is(
  public.firebase_delivery_status(
    array['d1000000-0000-4000-8000-000000000001'::uuid],
    'd2000000-0000-4000-8000-000000000001'
  )->>'ready',
  'true',
  'zero exact pending rows remains ready after finalization'
);

select * from finish();
rollback;
