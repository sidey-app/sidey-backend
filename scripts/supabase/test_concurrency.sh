#!/bin/sh
set -eu

SIDEY_REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && /bin/pwd -P)
SIDEY_DB_CONTAINER=${SIDEY_SUPABASE_DB_CONTAINER:-supabase_db_SIDEY_backend}
SIDEY_CONCURRENCY_TMP=$(mktemp -d "${TMPDIR:-/tmp}/sidey-db-concurrency.XXXXXX")

cleanup() {
	docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
		-c "drop trigger if exists sidey_concurrency_pause_profiles on public.profiles; drop trigger if exists sidey_concurrency_pause_room_members on public.room_members; drop trigger if exists sidey_concurrency_pause_invite_attempts on private.invite_attempts; drop function if exists private.sidey_concurrency_pause_before_insert(); delete from public.rooms where id::text like '40000000-0000-0000-0000-%'; delete from auth.users where id::text like '30000000-0000-0000-0000-%';" \
		>/dev/null 2>&1 || true
	rm -rf "$SIDEY_CONCURRENCY_TMP"
}
trap cleanup EXIT HUP INT TERM

docker inspect "$SIDEY_DB_CONTAINER" >/dev/null
docker exec -i "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres \
	< "$SIDEY_REPO_ROOT/scripts/supabase/concurrency_setup.sql" >/dev/null

run_concurrent_join() {
	SIDEY_USER_ID=$1
	SIDEY_INVITE_CODE=$2
	SIDEY_OUTPUT=$3
	docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -qAt -v ON_ERROR_STOP=1 \
		-c "begin; set local role authenticated; select set_config('request.jwt.claim.sub', '$SIDEY_USER_ID', true); select set_config('sidey.concurrency_test', 'on', true); select pg_sleep(0.25); select coalesce(room_id::text, error_code) from public.join_room('$SIDEY_INVITE_CODE'); commit;" \
		> "$SIDEY_OUTPUT"
}

run_capacity_join() {
	SIDEY_USER_ID=$1
	SIDEY_OUTPUT=$2
	docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -qAt -v ON_ERROR_STOP=1 \
		-c "begin; set local role authenticated; select set_config('request.jwt.claim.sub', '$SIDEY_USER_ID', true); select set_config('sidey.concurrency_test', 'on', true); select pg_sleep(0.25); select coalesce(room_id::text, error_code) from public.join_room('00000000-00000000-00000000-00000007'); commit;" \
		> "$SIDEY_OUTPUT"
}

run_concurrent_join \
	'30000000-0000-0000-0000-000000000040' \
	'00000000-00000000-00000000-00000005' \
	"$SIDEY_CONCURRENCY_TMP/five-a.out" &
SIDEY_PID_ONE=$!
run_concurrent_join \
	'30000000-0000-0000-0000-000000000040' \
	'00000000-00000000-00000000-00000006' \
	"$SIDEY_CONCURRENCY_TMP/five-b.out" &
SIDEY_PID_TWO=$!
wait "$SIDEY_PID_ONE"
wait "$SIDEY_PID_TWO"

SIDEY_USER_ROOM_COUNT=$(docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -At \
	-c "select count(*) from public.room_members where user_id = '30000000-0000-0000-0000-000000000040';")
SIDEY_TARGET_JOIN_COUNT=$(docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -At \
	-c "select count(*) from public.room_members where user_id = '30000000-0000-0000-0000-000000000040' and room_id in ('40000000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-000000000006');")
[ "$SIDEY_USER_ROOM_COUNT" = 5 ]
[ "$SIDEY_TARGET_JOIN_COUNT" = 1 ]
grep -Fq 'room_limit_reached' "$SIDEY_CONCURRENCY_TMP/five-a.out" "$SIDEY_CONCURRENCY_TMP/five-b.out"

run_capacity_join \
	'30000000-0000-0000-0000-000000000021' \
	"$SIDEY_CONCURRENCY_TMP/capacity-a.out" &
SIDEY_PID_ONE=$!
run_capacity_join \
	'30000000-0000-0000-0000-000000000022' \
	"$SIDEY_CONCURRENCY_TMP/capacity-b.out" &
SIDEY_PID_TWO=$!
wait "$SIDEY_PID_ONE"
wait "$SIDEY_PID_TWO"

SIDEY_ROOM_MEMBER_COUNT=$(docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -At \
	-c "select count(*) from public.room_members where room_id = '40000000-0000-0000-0000-000000000007';")
[ "$SIDEY_ROOM_MEMBER_COUNT" = 12 ]
grep -Fq 'member_limit_reached' "$SIDEY_CONCURRENCY_TMP/capacity-a.out" "$SIDEY_CONCURRENCY_TMP/capacity-b.out"

run_concurrent_join \
	'30000000-0000-0000-0000-000000000030' \
	'FFFFFFFF-FFFFFFFF-FFFFFFFF-FFFFFFFF' \
	"$SIDEY_CONCURRENCY_TMP/rate-a.out" &
SIDEY_PID_ONE=$!
run_concurrent_join \
	'30000000-0000-0000-0000-000000000030' \
	'EEEEEEEE-EEEEEEEE-EEEEEEEE-EEEEEEEE' \
	"$SIDEY_CONCURRENCY_TMP/rate-b.out" &
SIDEY_PID_TWO=$!
wait "$SIDEY_PID_ONE"
wait "$SIDEY_PID_TWO"

SIDEY_INVITE_ATTEMPT_COUNT=$(docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -At \
	-c "select count(*) from private.invite_attempts where user_id = '30000000-0000-0000-0000-000000000030';")
[ "$SIDEY_INVITE_ATTEMPT_COUNT" = 10 ]
grep -Fq 'invalid_invite_code' "$SIDEY_CONCURRENCY_TMP/rate-a.out" "$SIDEY_CONCURRENCY_TMP/rate-b.out"
grep -Fq 'invite_rate_limited' "$SIDEY_CONCURRENCY_TMP/rate-a.out" "$SIDEY_CONCURRENCY_TMP/rate-b.out"

# Two devices race to migrate different local preferences at revision zero.
# Both must receive the same committed winner and only one revision is created.
run_tree_preference() {
	SIDEY_PAUSED=$1
	SIDEY_OUTPUT=$2
	docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -qAt -v ON_ERROR_STOP=1 \
		-c "begin; set local role authenticated; select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000001', true); select set_config('sidey.concurrency_test', 'on', true); select pg_sleep(0.25); select tree_movement_paused::text || ':' || tree_movement_revision::text from public.set_tree_movement_paused($SIDEY_PAUSED, 0); commit;" \
		> "$SIDEY_OUTPUT"
}
run_tree_preference true "$SIDEY_CONCURRENCY_TMP/tree-a.out" &
SIDEY_PID_ONE=$!
run_tree_preference false "$SIDEY_CONCURRENCY_TMP/tree-b.out" &
SIDEY_PID_TWO=$!
wait "$SIDEY_PID_ONE"
wait "$SIDEY_PID_TWO"
SIDEY_TREE_STATE=$(docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -At \
	-c "select tree_movement_paused::text || ':' || tree_movement_revision::text from public.profiles where id='30000000-0000-0000-0000-000000000001';")
case "$SIDEY_TREE_STATE" in true:1|false:1) ;; *) exit 1 ;; esac
grep -Fxq "$SIDEY_TREE_STATE" "$SIDEY_CONCURRENCY_TMP/tree-a.out"
grep -Fxq "$SIDEY_TREE_STATE" "$SIDEY_CONCURRENCY_TMP/tree-b.out"

printf 'Supabase concurrent checks passed: five rooms, twelve members, invite rate limit, tree preference CAS\n'
