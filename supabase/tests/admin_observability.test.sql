begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(41);

select has_table('private', 'download_metric_snapshots', 'download snapshots stay private');
select has_index('private', 'download_metric_snapshots', 'download_metric_snapshots_asset_time_idx', 'asset timeline is indexed');

select ok(not has_function_privilege('anon', 'public.admin_overview()', 'execute'), 'anon cannot execute overview');
select ok(not has_function_privilege('authenticated', 'public.admin_overview()', 'execute'), 'authenticated cannot execute overview');
select ok(not has_function_privilege('anon', 'public.admin_rooms(text,text,text,integer,integer)', 'execute'), 'anon cannot execute room listing');
select ok(not has_function_privilege('authenticated', 'public.admin_rooms(text,text,text,integer,integer)', 'execute'), 'authenticated cannot execute room listing');
select ok(not has_function_privilege('anon', 'public.admin_room_members(uuid)', 'execute'), 'anon cannot execute room members');
select ok(not has_function_privilege('authenticated', 'public.admin_room_members(uuid)', 'execute'), 'authenticated cannot execute room members');
select ok(not has_function_privilege('anon', 'public.admin_users(text,text,text,text,text,integer,integer)', 'execute'), 'anon cannot execute user listing');
select ok(not has_function_privilege('authenticated', 'public.admin_users(text,text,text,text,text,integer,integer)', 'execute'), 'authenticated cannot execute user listing');
select ok(not has_function_privilege('anon', 'public.admin_downloads(integer)', 'execute'), 'anon cannot execute downloads');
select ok(not has_function_privilege('authenticated', 'public.admin_downloads(integer)', 'execute'), 'authenticated cannot execute downloads');
select ok(not has_function_privilege('anon', 'public.admin_payments(text,text,timestamptz,timestamptz,text,text,integer,integer)', 'execute'), 'anon cannot execute payments');
select ok(not has_function_privilege('authenticated', 'public.admin_payments(text,text,timestamptz,timestamptz,text,text,integer,integer)', 'execute'), 'authenticated cannot execute payments');
select ok(not has_function_privilege('anon', 'public.admin_ingest_download_metrics(timestamptz,jsonb)', 'execute'), 'anon cannot ingest downloads');
select ok(not has_function_privilege('authenticated', 'public.admin_ingest_download_metrics(timestamptz,jsonb)', 'execute'), 'authenticated cannot ingest downloads');

select ok(has_function_privilege('service_role', 'public.admin_overview()', 'execute'), 'service role can execute overview');
select ok(has_function_privilege('service_role', 'public.admin_rooms(text,text,text,integer,integer)', 'execute'), 'service role can execute room listing');
select ok(has_function_privilege('service_role', 'public.admin_room_members(uuid)', 'execute'), 'service role can execute room members');
select ok(has_function_privilege('service_role', 'public.admin_users(text,text,text,text,text,integer,integer)', 'execute'), 'service role can execute user listing');
select ok(has_function_privilege('service_role', 'public.admin_downloads(integer)', 'execute'), 'service role can execute downloads');
select ok(has_function_privilege('service_role', 'public.admin_payments(text,text,timestamptz,timestamptz,text,text,integer,integer)', 'execute'), 'service role can execute payments');
select ok(has_function_privilege('service_role', 'public.admin_ingest_download_metrics(timestamptz,jsonb)', 'execute'), 'service role can ingest downloads');

set local role postgres;
insert into auth.users (
  id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
) values (
  'ad000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'admin-test@sidey.app',
  '{"provider":"email","providers":["email"]}', '{}', false, now(), now()
);
insert into public.profiles (id, nickname, character_id)
values ('ad000000-0000-0000-0000-000000000001', '운영테스트', 'pixel_hamster');
insert into public.rooms (id, name, owner_id, invite_code_hint, invite_code_ready)
values (
  'ad100000-0000-0000-0000-000000000001', '운영 그룹',
  'ad000000-0000-0000-0000-000000000001', '••••0001', true
);
insert into public.room_members (room_id, user_id)
values ('ad100000-0000-0000-0000-000000000001', 'ad000000-0000-0000-0000-000000000001');
insert into public.messages (id, room_id, sender_id, body, created_at)
values (
  'ad200000-0000-0000-0000-000000000001',
  'ad100000-0000-0000-0000-000000000001',
  'ad000000-0000-0000-0000-000000000001',
  '절대 어드민 응답에 노출되면 안 되는 본문', now()
);

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_like(
  $$select public.admin_overview()$$,
  '%permission denied%',
  'authenticated request is denied before reading operational data'
);

set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);

select lives_ok($$select public.admin_overview()$$, 'service role overview succeeds');
select ok((public.admin_overview() ->> 'authUsers')::integer >= 1, 'overview returns auth totals');
select is(
  (public.admin_rooms('운영', 'created_at', 'desc', 1, 25) ->> 'total')::integer,
  1,
  'room search and pagination return the matching room'
);
select ok(
  public.admin_room_members('ad100000-0000-0000-0000-000000000001'::uuid)::text not like '%절대 어드민%',
  'room member response never contains message bodies'
);
select is(
  (public.admin_users('admin-test@sidey.app', 'permanent', 'complete', 'created_at', 'desc', 1, 25) ->> 'total')::integer,
  1,
  'user filters return the permanent completed account'
);

select is(
  public.admin_ingest_download_metrics(
    now() - interval '45 minutes',
    '[{"asset_id":900001,"asset_name":"SIDEY-macOS-arm64-v1.0.4.dmg","release_tag":"v1.0.4","version":"1.0.4","channel":"legacy_unclassified","download_count":100}]'::jsonb
  ),
  1,
  'first historical baseline is recorded'
);
select is((public.admin_downloads(7) ->> 'isStale')::boolean, true, 'collector delay is reported as stale');
select is(
  (select (metric ->> 'today')::integer
   from jsonb_array_elements(public.admin_downloads(7) -> 'channels') metric
   where metric ->> 'channel' = 'legacy_unclassified'),
  0,
  'first same-day snapshot is a baseline and not a today increment'
);
select is(
  public.admin_ingest_download_metrics(
    now() - interval '5 minutes',
    '[{"asset_id":900001,"asset_name":"SIDEY-macOS-arm64-v1.0.4.dmg","release_tag":"v1.0.4","version":"1.0.4","channel":"legacy_unclassified","download_count":104}]'::jsonb
  ),
  1,
  'increasing counter is recorded'
);
select is(
  public.admin_ingest_download_metrics(
    now() - interval '4 minutes',
    '[{"asset_id":900001,"asset_name":"SIDEY-macOS-arm64-v1.0.4.dmg","release_tag":"v1.0.4","version":"1.0.4","channel":"legacy_unclassified","download_count":104}]'::jsonb
  ),
  1,
  'stagnant counter is valid and recorded'
);
select is(
  public.admin_ingest_download_metrics(
    now() - interval '2 minutes',
    '[{"asset_id":900001,"asset_name":"SIDEY-macOS-arm64-v1.0.4.dmg","release_tag":"v1.0.4","version":"1.0.4","channel":"direct_dmg","download_count":105}]'::jsonb
  ),
  1,
  'post-split increments can move to the direct channel without rewriting history'
);
select is(
  (select (metric ->> 'total')::integer
   from jsonb_array_elements(public.admin_downloads(7) -> 'channels') metric
   where metric ->> 'channel' = 'legacy_unclassified'),
  104,
  'historical mixed counter remains in the legacy channel'
);
select is(
  (select (metric ->> 'total')::integer
   from jsonb_array_elements(public.admin_downloads(7) -> 'channels') metric
   where metric ->> 'channel' = 'direct_dmg'),
  1,
  'only the post-split delta is attributed to direct DMG'
);
select throws_ok(
  $$select public.admin_ingest_download_metrics(
    now() - interval '3 minutes',
    '[{"asset_id":900001,"asset_name":"SIDEY-macOS-arm64-v1.0.4.dmg","release_tag":"v1.0.4","version":"1.0.4","channel":"legacy_unclassified","download_count":103}]'::jsonb
  )$$,
  '22023',
  'download_counter_regressed',
  'counter regression is rejected'
);
select is((public.admin_downloads(7) ->> 'isStale')::boolean, false, 'fresh collection clears stale warning');

set local role postgres;
insert into private.download_metric_snapshots (
  asset_id, asset_name, release_tag, version, channel, download_count, collected_at
) values
  (900002, 'SIDEY-macOS-arm64-v1.0.5-homebrew.dmg', 'v1.0.5', '1.0.5', 'homebrew_dmg', 10,
   (timezone('Asia/Seoul', now())::date::timestamp at time zone 'Asia/Seoul') - interval '1 minute'),
  (900002, 'SIDEY-macOS-arm64-v1.0.5-homebrew.dmg', 'v1.0.5', '1.0.5', 'homebrew_dmg', 13,
   (timezone('Asia/Seoul', now())::date::timestamp at time zone 'Asia/Seoul') + interval '1 minute');
set local role service_role;
select set_config('request.jwt.claim.role', 'service_role', true);
select is(
  (select (metric ->> 'total')::integer
   from jsonb_array_elements(public.admin_downloads(7) -> 'channels') metric
   where metric ->> 'channel' = 'homebrew_dmg'),
  13,
  'Homebrew cumulative total includes the pre-midnight baseline'
);
select is(
  (select (metric ->> 'today')::integer
   from jsonb_array_elements(public.admin_downloads(7) -> 'channels') metric
   where metric ->> 'channel' = 'homebrew_dmg'),
  3,
  'KST today includes only the post-midnight counter delta'
);

select * from finish();
rollback;
