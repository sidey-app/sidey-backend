"""Bounded real-transaction wake races in an explicitly selected disposable DB.

Run only while the isolated Database CI instance is otherwise idle. The enqueue
boundary is replaced with a rejecting local stub before enabling any fixture;
its definition and all singleton rows are restored even when an assertion fails.
"""
import json
import subprocess
import sys
import time


container = sys.argv[1]
if not container.startswith("supabase_db_"):
    raise SystemExit("local_supabase_container_required")
base = ["docker", "exec", "-i", container, "psql", "-X", "-U", "postgres", "-d", "postgres",
        "-qAt", "-v", "ON_ERROR_STOP=1"]
uid = "ba000000-0000-4000-8000-000000000001"
sid = "ba000000-0000-4000-8000-000000000002"
owner = "ba000000-0000-4000-8000-000000000003"
dispatch = "ba000000-0000-4000-8000-000000000004"
room = None
transactions = []


def sql(statement):
    result = subprocess.run(base, input="set statement_timeout='8s';\n" + statement,
                            text=True, capture_output=True, timeout=12)
    if result.returncode:
        # Never include query text, stored function definitions, or DB secrets.
        raise AssertionError("publish_wake_sql_failed")
    return result.stdout.strip()


def user_role():
    claims = json.dumps({"sub": uid, "session_id": sid, "exp": int(time.time()) + 3600})
    return f"set local role authenticated; set local request.jwt.claims='{claims}';"


def message(number):
    return f"ba100000-0000-4000-8000-{number:012d}"


def wake(number):
    return (f"select public.authorize_firebase_publish_wake('{room}',"
            f"(select realtime_epoch from public.rooms where id='{room}'),'{message(number)}');")


def call_wake(number):
    return json.loads(sql("begin;" + user_role() + wake(number) + "commit;"))


def wait_for(predicate, failure):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if sql("select " + predicate) == "t":
            return
        time.sleep(0.02)
    raise AssertionError(failure)


class Transaction:
    def __init__(self, name, statement, barrier=None):
        self.name = "sidey_wake_test_" + name
        self.process = subprocess.Popen(base, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True)
        transactions.append(self)
        self.process.stdin.write(
            f"begin; set local application_name='{self.name}'; set local statement_timeout='8s'; "
            "set local idle_in_transaction_session_timeout='12s'; " + statement
            + (f" select pg_advisory_xact_lock({barrier});" if barrier else "") + "\n")
        self.process.stdin.flush()
        if barrier:
            wait_for(f"not pg_try_advisory_lock({barrier})", "transaction_barrier_missing")

    def waiting_for(self, other):
        wait_for("exists(select 1 from pg_stat_activity a join pg_stat_activity b "
                 "on b.pid=any(pg_blocking_pids(a.pid)) "
                 f"where a.application_name='{self.name}' and b.application_name='{other.name}')",
                 "expected_transaction_blocker_missing")

    def finish(self, statement="commit;", error=None):
        output, errors = self.process.communicate(statement + "\n", timeout=12)
        if error:
            assert self.process.returncode != 0 and error in errors, "expected_wake_rejection_missing"
        else:
            assert self.process.returncode == 0, "concurrent_transaction_failed"
        return [line for line in output.splitlines() if line]


def queued():
    sql(f"""update private.firebase_live_dispatch_config set enabled=true,
      owner_run_id='{owner}',run_deadline_at=clock_timestamp()+interval '10 minutes';
      update private.firebase_live_dispatch_state set owner_run_id='{owner}',dispatch_id='{dispatch}',
      phase='queued',expires_at=clock_timestamp()+interval '1 minute';""")


singleton_tables = ["firebase_live_config", "firebase_live_dispatch_config", "firebase_live_dispatch_state"]
assert sql("select not enabled from private.firebase_live_dispatch_config") == "t", "dispatch_must_be_off"
assert sql("select phase is null from private.firebase_live_dispatch_state") == "t", "publisher_must_be_idle"
assert sql("select not running from private.firebase_live_cleanup_state") == "t", "cleaner_must_be_idle"
assert sql("select count(*) from private.firebase_live_users") == "0", "disposable_empty_cohort_required"
assert sql("select count(*) from private.firebase_live_outbox") == "0", "disposable_empty_outbox_required"
assert sql(f"select count(*) from auth.users where id='{uid}'") == "0", "fixture_collision"
snapshots = {table: sql(f"select row_to_json(t) from private.{table} t") for table in singleton_tables}
enqueue_definition = sql("select pg_get_functiondef('private.enqueue_firebase_live_dispatch(uuid,text)'::regprocedure)")

try:
    sql("""create or replace function private.enqueue_firebase_live_dispatch(p_dispatch uuid,p_secret text)
      returns bigint language plpgsql set search_path='' as $$begin
        raise exception 'publish_wake_concurrency_network_forbidden';
      end $$;""")
    sql(f"""insert into auth.users(id,instance_id,aud,role,raw_app_meta_data,raw_user_meta_data,is_anonymous,created_at,updated_at)
      values('{uid}','00000000-0000-0000-0000-000000000000','authenticated','authenticated',
      '{{"provider":"anonymous","providers":["anonymous"]}}','{{}}',true,now(),now());
      insert into auth.sessions(id,user_id,created_at,updated_at) values('{sid}','{uid}',now(),now());""")
    room = sql("begin;" + user_role() + "select public.upsert_profile('경합검사','pixel_hamster'); "
               "select room_id from public.create_room('wake concurrency'); commit;").splitlines()[-1]
    sql(f"insert into private.firebase_live_users values('{uid}',true); "
        f"insert into private.firebase_live_rooms values('{room}',true); "
        "update private.firebase_live_config set enabled=true,direct_events_enabled=true;")
    sql("begin;" + user_role() + "select public.prepare_firebase_live_lease(); commit;")
    sql(f"""insert into public.messages(id,room_id,sender_id,body)
      select ('ba100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'{room}','{uid}','synthetic'
      from generate_series(1,6)n;""")
    queued()

    # Hold the winning authorization uncommitted; the concurrent duplicate must
    # not wait or acquire another wake. A committed duplicate stays deduplicated.
    first = Transaction("authorize", user_role() + wake(1), 992101)
    assert call_wake(1) == {"reason": "contended"}
    first_result = json.loads(first.finish()[0])
    assert first_result == {"reason": "queued", "dispatchId": dispatch}
    assert call_wake(1) == {"reason": "duplicate"}
    assert sql(f"select count(*) from private.realtime_event_attempts where user_id='{uid}' "
               "and event_name='firebase_publish_wake'") == "1"
    print("PASS concurrent wake: one accepted authorization, one contention, durable dedup")

    # Both fast wake and delayed pg_net enter this same atomic begin+claim RPC.
    first = Transaction("begin_first", f"select public.begin_claim_firebase_live_dispatch('{dispatch}',25);", 992102)
    second = Transaction("begin_second", f"select public.begin_claim_firebase_live_dispatch('{dispatch}',25);")
    second.waiting_for(first)
    first_result = json.loads(first.finish()[0])
    second_result = json.loads(second.finish()[0])
    assert first_result["accepted"] and first_result["rows"]
    assert second_result == {"accepted": False, "rows": []}
    assert sql(f"select public.finish_firebase_live_dispatch('{dispatch}',false,'{{}}')") == "t"
    print("PASS concurrent begin+claim: one publisher wins, duplicate claims no rows")

    # Real inverse lock graph: wake owns outbox; finish owns config/state and is
    # waiting on that outbox. Wake must NOWAIT out of the scheduler lock request.
    queued()
    sql(f"update private.firebase_live_dispatch_state set phase='running'; "
        f"update private.firebase_live_outbox set claimed_by='{dispatch}',claim_until=clock_timestamp()+interval '1 minute' "
        f"where payload->>'message_id'='{message(2)}';")
    wake_tx = Transaction("inverse_wake", "select id from private.firebase_live_outbox "
                          f"where payload->>'message_id'='{message(2)}' for update;", 992103)
    finish_tx = Transaction("inverse_finish", f"select public.finish_firebase_live_dispatch('{dispatch}',false,'{{}}');")
    finish_tx.waiting_for(wake_tx)
    result = wake_tx.finish(user_role() + wake(2) + "commit;")
    assert json.loads(result[-1]) == {"reason": "contended"}
    assert finish_tx.finish() == ["t"]
    assert sql("select phase is null from private.firebase_live_dispatch_state") == "t"
    assert sql(f"select claim_until is null and publish_wake_requested_at is not null "
               f"from private.firebase_live_outbox where payload->>'message_id'='{message(2)}'") == "t"
    print("PASS finish inverse lock: NOWAIT avoids deadlock and preserves pending message")

    # State contention occurs after wake has acquired config. The exception
    # subtransaction must release config before the outer authorization commits.
    queued()
    state_tx = Transaction("state_lock", "select id from private.firebase_live_dispatch_state for update;", 992104)
    wake_tx = Transaction("state_wake", user_role() + wake(3), 992105)
    assert sql("begin; select id from private.firebase_live_dispatch_config for update nowait; rollback;") == "t"
    assert json.loads(wake_tx.finish()[0]) == {"reason": "contended"}
    state_tx.finish()
    print("PASS state contention: partial scheduler locks released before caller commit")

    # Stop owns config while a stale queued callback arrives. Wake cannot wait
    # behind stop, and begin must observe disabled after the stop transaction commits.
    disable_tx = Transaction("dispatch_disable", "update private.firebase_live_dispatch_config set enabled=false;", 992106)
    assert call_wake(4) == {"reason": "contended"}
    begin_tx = Transaction("disabled_begin", f"select public.begin_claim_firebase_live_dispatch('{dispatch}',25);")
    begin_tx.waiting_for(disable_tx)
    disable_tx.finish()
    assert json.loads(begin_tx.finish()[0]) == {"accepted": False, "rows": []}
    assert call_wake(5) == {"reason": "disabled"}
    print("PASS dispatch disable race: neither wake nor queued callback restores ownership")

    # Source rollout uses config -> room locks too. A blocked authorization must
    # recheck approval after the concurrent disabling transaction commits.
    disable_tx = Transaction("rollout_disable", "update private.firebase_live_config set enabled=false;", 992107)
    wake_tx = Transaction("rollout_wake", user_role() + wake(6))
    wake_tx.waiting_for(disable_tx)
    disable_tx.finish()
    wake_tx.finish(error="publisher_wake_disabled")
    assert sql(f"select count(*) from public.messages where room_id='{room}'") == "6"
    assert sql(f"select count(*) from private.firebase_live_outbox where room_id='{room}' "
               "and kind='message_changed' and delivered_at is null") == "6"
    print("PASS rollout disable race: rejected after commit, all source messages durable")
finally:
    # Roll back any unfinished peers before cleanup; never leave lock holders or
    # a synthetic enabled scheduler behind after an assertion failure.
    for transaction in transactions:
        if transaction.process.poll() is None:
            transaction.process.communicate("rollback;\n", timeout=12)
    sql("update private.firebase_live_dispatch_config set enabled=false; "
        "update private.firebase_live_config set enabled=false,direct_events_enabled=false;")
    if room:
        sql(f"delete from public.rooms where id='{room}'; "
            f"delete from private.firebase_live_rooms where room_id='{room}'; "
            f"delete from private.firebase_live_outbox where room_id='{room}'; "
            f"delete from private.firebase_live_epochs where room_id='{room}'; "
            f"delete from private.firebase_live_cursors where room_id='{room}'; "
            f"delete from private.firebase_live_access_snapshots where room_id='{room}';")
    sql(f"delete from private.firebase_live_leases where user_id='{uid}'; "
        f"delete from auth.users where id='{uid}';")
    for table, snapshot in snapshots.items():
        columns = list(json.loads(snapshot))
        names = ",".join('"' + column + '"' for column in columns)
        literal = snapshot.replace("'", "''")
        sql(f"update private.{table} set ({names})=(select {names} "
            f"from json_populate_record(null::private.{table},'{literal}'::json)) where id;")
    sql(enqueue_definition)
    for table, snapshot in snapshots.items():
        assert json.loads(sql(f"select row_to_json(t) from private.{table} t")) == json.loads(snapshot), "singleton_restore_failed"
    assert sql("select pg_get_functiondef('private.enqueue_firebase_live_dispatch(uuid,text)'::regprocedure)") == enqueue_definition, "enqueue_restore_failed"
    assert sql(f"select count(*) from auth.users where id='{uid}'") == "0", "fixture_user_cleanup_failed"
    assert sql("select count(*) from private.firebase_live_outbox") == "0", "fixture_outbox_cleanup_failed"
    print("PASS cleanup: singleton snapshots and enqueue restored; synthetic fixtures removed")
