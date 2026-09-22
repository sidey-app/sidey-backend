#!/bin/sh
set -eu

SIDEY_REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && /bin/pwd -P)
SIDEY_DB_CONTAINER=${SIDEY_SUPABASE_DB_CONTAINER:-supabase_db_SIDEY_backend}
SIDEY_CONCURRENCY_TMP=$(mktemp -d "${TMPDIR:-/tmp}/sidey-db-concurrency.XXXXXX")

cleanup() {
	docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
		-c "drop trigger if exists sidey_concurrency_pause_profiles on public.profiles; drop trigger if exists sidey_concurrency_pause_room_members on public.room_members; drop trigger if exists sidey_concurrency_pause_invite_attempts on private.invite_attempts; drop function if exists private.sidey_concurrency_pause_before_insert(); delete from public.rooms where id::text like '40000000-0000-0000-0000-%'; delete from auth.users where id::text like '30000000-0000-0000-0000-%';" \
		>/dev/null 2>&1 || true
	docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
		-c "update private.firebase_live_dispatch_config set enabled=false,owner_run_id=null,run_deadline_at=null where owner_run_id='81000000-0000-4000-8000-000000000099'; update private.firebase_live_dispatch_state set phase=null,owner_run_id=null,dispatch_id=null,expires_at='-infinity',enqueue_count=0,started_count=0,finished_count=0,cumulative_totals='{}',last_result='{}' where owner_run_id='81000000-0000-4000-8000-000000000099';" \
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

# Duplicate queued HTTP requests may race across isolates. Only one can acquire
# the DB dispatch; duplicate completion must not double-count response bytes.
# No scheduler, pg_net request or remote endpoint is used in this local test.
docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 \
	-c "update private.firebase_live_dispatch_config set enabled=true,owner_run_id='81000000-0000-4000-8000-000000000099',run_deadline_at=clock_timestamp()+interval '5 minutes'; update private.firebase_live_dispatch_state set owner_run_id='81000000-0000-4000-8000-000000000099',dispatch_id='83000000-0000-4000-8000-000000000099',phase='queued',expires_at=clock_timestamp()+interval '10 seconds';"
run_dispatch_race() {
	SIDEY_DISPATCH_SQL=$1
	SIDEY_DISPATCH_OUTPUT=$2
	docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -qAt -v ON_ERROR_STOP=1 \
		-c "begin; select pg_sleep(0.25); $SIDEY_DISPATCH_SQL; commit;" > "$SIDEY_DISPATCH_OUTPUT"
}
run_dispatch_race "select public.begin_firebase_live_dispatch('83000000-0000-4000-8000-000000000099')" "$SIDEY_CONCURRENCY_TMP/dispatch-a.out" &
SIDEY_PID_ONE=$!
run_dispatch_race "select public.begin_firebase_live_dispatch('83000000-0000-4000-8000-000000000099')" "$SIDEY_CONCURRENCY_TMP/dispatch-b.out" &
SIDEY_PID_TWO=$!
wait "$SIDEY_PID_ONE"
wait "$SIDEY_PID_TWO"
[ "$(cat "$SIDEY_CONCURRENCY_TMP/dispatch-a.out" "$SIDEY_CONCURRENCY_TMP/dispatch-b.out" | grep -cx t)" = 1 ]
[ "$(cat "$SIDEY_CONCURRENCY_TMP/dispatch-a.out" "$SIDEY_CONCURRENCY_TMP/dispatch-b.out" | grep -cx f)" = 1 ]
run_dispatch_race "select public.finish_firebase_live_dispatch('83000000-0000-4000-8000-000000000099',true,'{\"responseBodyBytes\":64}')" "$SIDEY_CONCURRENCY_TMP/finish-a.out" &
SIDEY_PID_ONE=$!
run_dispatch_race "select public.finish_firebase_live_dispatch('83000000-0000-4000-8000-000000000099',true,'{\"responseBodyBytes\":64}')" "$SIDEY_CONCURRENCY_TMP/finish-b.out" &
SIDEY_PID_TWO=$!
wait "$SIDEY_PID_ONE"
wait "$SIDEY_PID_TWO"
[ "$(cat "$SIDEY_CONCURRENCY_TMP/finish-a.out" "$SIDEY_CONCURRENCY_TMP/finish-b.out" | grep -cx t)" = 1 ]
[ "$(cat "$SIDEY_CONCURRENCY_TMP/finish-a.out" "$SIDEY_CONCURRENCY_TMP/finish-b.out" | grep -cx f)" = 1 ]
SIDEY_DISPATCH_COUNTS=$(docker exec "$SIDEY_DB_CONTAINER" psql -U postgres -d postgres -At \
	-c "select started_count::text||':'||finished_count::text||':'||(cumulative_totals->>'responseBodyBytes') from private.firebase_live_dispatch_state;")
[ "$SIDEY_DISPATCH_COUNTS" = '1:1:64' ]

# A source transaction holds an outbox row while finish holds config/state.
# The source INSERT wake must skip contended scheduler locks instead of deadlocking.
# Advisory barriers below coordinate local DB sessions; no network boundary runs.
python3 - "$SIDEY_DB_CONTAINER" <<'PY_LOCK_CHECK'
import subprocess,time,json,sys
base=['docker','exec',sys.argv[1],'psql','-U','postgres','-d','postgres','-qAt','-v','ON_ERROR_STOP=1','-c']
def sql(q):
 return subprocess.run(base+[q],text=True,capture_output=True,check=True).stdout.strip()
room='97000000-0000-4000-8000-000000000001'
worker='97000000-0000-4000-8000-000000000002'
try:
 sql(f"update private.firebase_live_dispatch_config set enabled=false; insert into private.firebase_live_outbox(room_id,epoch,kind,claimed_by,claim_until) values('{room}',1,'control','{worker}',clock_timestamp()+interval '30 seconds'); update private.firebase_live_dispatch_state set phase='running',dispatch_id='{worker}';")
 a=subprocess.Popen(base+[f"begin; set local statement_timeout='5s'; select pg_advisory_xact_lock(970001); update private.firebase_live_outbox set attempts=attempts+1 where room_id='{room}'; select pg_sleep(2); insert into private.firebase_live_outbox(room_id,epoch,kind) values('{room}',1,'control'); commit;"],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 for _ in range(30):
  if sql('select pg_try_advisory_lock(970001)')=='f':break
  time.sleep(.02)
 else:raise RuntimeError(('source lock readiness unavailable',a.communicate(timeout=10)))
 result=sql(f"set statement_timeout='4s'; select public.finish_firebase_live_dispatch('{worker}',false,'{{}}');")
 out,err=a.communicate(timeout=8)
 assert a.returncode==0,(out,err)
 assert result=='t',result
 assert sql(f"select count(*) from private.firebase_live_outbox where room_id='{room}'")=='2'
 # Lock only state, so source wrapper acquires config then must roll it back on NOWAIT failure.
 b=subprocess.Popen(base+["begin; select 1 from private.firebase_live_dispatch_state where id for update; select pg_advisory_xact_lock(970002); select pg_sleep(2); rollback;"],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 for _ in range(30):
  if sql('select pg_try_advisory_lock(970002)')=='f':break
  time.sleep(.02)
 else:raise RuntimeError('state lock readiness unavailable')
 result=sql("set statement_timeout='750ms'; select private.try_dispatch_firebase_live()->>'reason';")
 assert result=='contended',result
 out,err=b.communicate(timeout=5)
 assert b.returncode==0,(out,err)
 print(json.dumps({'sourceOutboxVsFinishConfigDeadlock':'PASS','nowaitStateContention':'PASS'}))
finally:
 sql(f"delete from private.firebase_live_outbox where room_id='{room}'; update private.firebase_live_dispatch_state set phase=null,dispatch_id=null,expires_at='-infinity';")
PY_LOCK_CHECK

python3 "$SIDEY_REPO_ROOT/scripts/supabase/test_direct_event_concurrency.py" "$SIDEY_DB_CONTAINER"

printf 'Supabase concurrent checks passed: five rooms, twelve members, invite rate limit, tree preference CAS, Edge dispatch acquire/finish, immediate-wake lock order/NOWAIT\n'

python3 "$SIDEY_REPO_ROOT/scripts/supabase/test_publish_wake_concurrency.py" "$SIDEY_DB_CONTAINER"

python3 "$SIDEY_REPO_ROOT/scripts/supabase/test_publisher_ack_claim_concurrency.py" "$SIDEY_DB_CONTAINER"
