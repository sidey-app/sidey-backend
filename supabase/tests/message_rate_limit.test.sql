begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select no_plan();

insert into auth.users (
  id, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data,
  is_anonymous, created_at, updated_at
) select
  ('d1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated', 'authenticated',
  '{"provider":"anonymous","providers":["anonymous"]}'::jsonb,
  '{}'::jsonb, true, now(), now()
from generate_series(1, 3) as n;

insert into auth.sessions (id, user_id, created_at, updated_at)
values (
  'd2000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001',
  now(), now()
);

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select public.upsert_profile('제한 A', 'pixel_hamster');
create temporary table rate_rooms as
select 'first'::text as label, room_id, invite_code
from public.create_room('제한 첫 번째 방');
insert into rate_rooms
select 'second', room_id, invite_code
from public.create_room('제한 두 번째 방');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select public.upsert_profile('제한 B', 'pixel_hamster');
select * from public.join_room((select invite_code from rate_rooms where label = 'first'));
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select public.upsert_profile('제한 C', 'pixel_hamster');
select * from public.join_room((select invite_code from rate_rooms where label = 'first'));

-- Interleave two accounts. A also switches rooms and transport paths, so each
-- successful send must count toward one account-wide window.
select lives_ok($$
  do $body$
  declare n integer;
  begin
    for n in 1..9 loop
      perform set_config('request.jwt.claim.sub',
        'd1000000-0000-4000-8000-000000000001', true);
      if n <= 3 then
        perform public.send_message(
          ('d3000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
          (select room_id from rate_rooms where label = 'first'),
          'burst-' || n
        );
      elsif n <= 6 then
        perform public.firebase_persist_message(
          ('d3000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
          (select room_id from rate_rooms where label = 'second'),
          'd1000000-0000-4000-8000-000000000001',
          'burst-' || n
        );
      else
        perform public.firebase_persist_realtime_message(
          ('d3000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
          (select room_id from rate_rooms where label = 'first'),
          'd1000000-0000-4000-8000-000000000001',
          'd2000000-0000-4000-8000-000000000001',
          'burst-' || n
        );
      end if;

      perform set_config('request.jwt.claim.sub',
        'd1000000-0000-4000-8000-000000000002', true);
      perform public.send_message(
        ('d4000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
        (select room_id from rate_rooms where label = 'first'),
        'other-' || n
      );
    end loop;
  end;
  $body$;
$$, 'two accounts can each send nine interleaved messages');

select is(
  (select count(*)::integer from private.message_attempts
   where user_id = 'd1000000-0000-4000-8000-000000000001'),
  9, 'A has nine successful sends across three paths and two rooms'
);
select is(
  (select count(*)::integer from private.message_attempts
   where user_id = 'd1000000-0000-4000-8000-000000000002'),
  9, 'B has an independent nine-message window'
);
select is(
  (select count(*)::integer from private.message_attempts
   where user_id = 'd1000000-0000-4000-8000-000000000001'
     and blocked_until is not null),
  0, 'nine messages do not start a cooldown'
);

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select lives_ok($$
  select public.firebase_persist_realtime_message(
    'd3000000-0000-4000-8000-000000000010',
    (select room_id from rate_rooms where label = 'second'),
    'd1000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001',
    'burst-10'
  )
$$, 'tenth mixed-path message succeeds in the other room');
select is(
  (select count(*)::integer from private.message_attempts
   where user_id = 'd1000000-0000-4000-8000-000000000001'),
  10, 'A has exactly ten counted messages'
);
select ok(
  (select blocked_until = attempted_at + interval '10 seconds'
   from private.message_attempts
   where user_id = 'd1000000-0000-4000-8000-000000000001'
     and blocked_until is not null),
  'the tenth send immediately starts an exact ten-second cooldown'
);
create temporary table rate_cooldown_snapshot as
select blocked_until
from private.message_attempts
where user_id = 'd1000000-0000-4000-8000-000000000001'
  and blocked_until is not null;

select throws_ok($$
  select public.send_message(
    'd3000000-0000-4000-8000-000000000011',
    (select room_id from rate_rooms where label = 'first'), 'blocked legacy'
  )
$$, 'P0001', 'message_rate_limited', 'legacy send rejects the eleventh message');
select throws_ok($$
  select public.firebase_persist_message(
    'd3000000-0000-4000-8000-000000000012',
    (select room_id from rate_rooms where label = 'second'),
    'd1000000-0000-4000-8000-000000000001', 'blocked Firebase bridge'
  )
$$, 'P0001', 'message_rate_limited', 'Firebase bridge shares the cooldown');
select throws_ok($$
  select public.firebase_persist_realtime_message(
    'd3000000-0000-4000-8000-000000000013',
    (select room_id from rate_rooms where label = 'first'),
    'd1000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001',
    'blocked Firebase realtime'
  )
$$, 'P0001', 'message_rate_limited', 'Firebase realtime shares the cooldown');

select lives_ok($$
  select public.firebase_persist_realtime_message(
    'd3000000-0000-4000-8000-000000000010',
    (select room_id from rate_rooms where label = 'second'),
    'd1000000-0000-4000-8000-000000000001',
    'd2000000-0000-4000-8000-000000000001', 'burst-10'
  )
$$, 'Firebase realtime duplicate UUID remains idempotent during cooldown');
select lives_ok($$
  select public.firebase_persist_message(
    'd3000000-0000-4000-8000-000000000010',
    (select room_id from rate_rooms where label = 'second'),
    'd1000000-0000-4000-8000-000000000001', 'burst-10'
  )
$$, 'Firebase bridge duplicate UUID remains idempotent during cooldown');
select lives_ok($$
  select public.send_message(
    'd3000000-0000-4000-8000-000000000010',
    (select room_id from rate_rooms where label = 'second'), 'burst-10'
  )
$$, 'legacy duplicate UUID remains idempotent during cooldown');
select is(
  (select count(*)::integer from private.message_attempts
   where user_id = 'd1000000-0000-4000-8000-000000000001'),
  10, 'blocked calls and duplicate UUID retries add no attempts'
);
select is(
  (select blocked_until from private.message_attempts
   where user_id = 'd1000000-0000-4000-8000-000000000001'
     and blocked_until is not null),
  (select blocked_until from rate_cooldown_snapshot),
  'blocked retries and duplicate UUIDs never extend the cooldown'
);

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select lives_ok($$
  select public.send_message(
    'd4000000-0000-4000-8000-000000000010',
    (select room_id from rate_rooms where label = 'first'), 'other-10'
  )
$$, 'B can send its tenth message while A is blocked');
select is(
  (select count(*)::integer from private.message_attempts
   where user_id = 'd1000000-0000-4000-8000-000000000002'),
  10, 'B has its own ten successful sends'
);
select throws_ok($$
  select public.send_message(
    'd4000000-0000-4000-8000-000000000011',
    (select room_id from rate_rooms where label = 'first'), 'other-11'
  )
$$, 'P0001', 'message_rate_limited', 'B is blocked only after its own tenth send');

-- Move the successful sends and their original cooldown into the past. This
-- models elapsed wall time without making the suite wait ten seconds.
update private.message_attempts
set attempted_at = attempted_at - interval '11 seconds',
    blocked_until = blocked_until - interval '11 seconds'
where user_id = 'd1000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select lives_ok($$
  select public.send_message(
    'd3000000-0000-4000-8000-000000000014',
    (select room_id from rate_rooms where label = 'first'), 'after cooldown'
  )
$$, 'A can send again after the ten-second cooldown');
select is(
  (select count(*)::integer from private.message_attempts
   where user_id = 'd1000000-0000-4000-8000-000000000001'),
  11, 'post-cooldown send creates one fresh counted attempt'
);

-- A separate account establishes the five-second sliding window itself.
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select lives_ok($$
  do $body$
  declare n integer;
  begin
    for n in 1..9 loop
      perform public.send_message(
        ('d5000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
        (select room_id from rate_rooms where label = 'first'),
        'window-' || n
      );
    end loop;
  end;
  $body$;
$$, 'C sends nine messages inside the first window');
update private.message_attempts
set attempted_at = attempted_at - interval '6 seconds'
where user_id = 'd1000000-0000-4000-8000-000000000003';
select lives_ok($$
  do $body$
  declare n integer;
  begin
    for n in 10..19 loop
      perform public.send_message(
        ('d5000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
        (select room_id from rate_rooms where label = 'first'),
        'window-' || n
      );
    end loop;
  end;
  $body$;
$$, 'C can send ten more after the prior five-second window expires');
select is(
  (select count(*)::integer from private.message_attempts
   where user_id = 'd1000000-0000-4000-8000-000000000003'),
  19, 'five-second accounting retains old history without counting it'
);
select throws_ok($$
  select public.send_message(
    'd5000000-0000-4000-8000-000000000020',
    (select room_id from rate_rooms where label = 'first'), 'window-20'
  )
$$, 'P0001', 'message_rate_limited', 'new window also stops after ten sends');

select * from finish();
rollback;
