"""Real transactions in the task's explicitly selected disposable local DB only.

Usage: python3 scripts/supabase/test_publisher_ack_claim_concurrency.py supabase_db_sidey_latency_20260919
No external HTTP: enqueue is replaced with a rejecting stub, then restored.
"""
import json
import os
import subprocess
import sys
import time

container = sys.argv[1]
allowed_containers = {"supabase_db_sidey_latency_20260919", "supabase_db_SIDEY_backend"}
explicit_disposable = os.environ.get("SIDEY_ACK_CLAIM_DISPOSABLE_CONTAINER")
if explicit_disposable:
    allowed_containers.add(explicit_disposable)
if container not in allowed_containers:
    raise SystemExit("task_owned_disposable_container_required")
base = ["docker", "exec", "-i", container, "psql", "-X", "-U", "postgres", "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1"]
worker = "ab000000-0000-4000-8000-000000000001"
owner = "ab000000-0000-4000-8000-000000000002"
room = "ab000000-0000-4000-8000-000000000003"
peers = []


def sql(text):
    result = subprocess.run(base, input="set statement_timeout='8s';\n" + text, text=True, capture_output=True, timeout=12)
    if result.returncode:
        raise AssertionError("ack_claim_sql_failed")
    return result.stdout.strip()


def wait_for(predicate):
    until = time.monotonic() + 5
    while time.monotonic() < until:
        if sql("select " + predicate) == "t":
            return
        time.sleep(0.02)
    raise AssertionError("expected_concurrency_barrier_missing")


class Transaction:
    def __init__(self, name, statement, barrier=None):
        self.name = "sidey_ack_claim_" + name
        self.process = subprocess.Popen(base, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        peers.append(self)
        self.process.stdin.write(f"begin;set local application_name='{self.name}';set local statement_timeout='8s';set local idle_in_transaction_session_timeout='12s';"
                                 + statement + (f"select pg_advisory_xact_lock({barrier});" if barrier else "") + "\n")
        self.process.stdin.flush()
        if barrier:
            wait_for(f"not pg_try_advisory_lock({barrier})")

    def blocked_by(self, peer):
        wait_for("exists(select 1 from pg_stat_activity a join pg_stat_activity b on b.pid=any(pg_blocking_pids(a.pid)) "
                 f"where a.application_name='{self.name}' and b.application_name='{peer.name}')")

    def finish(self, statement="commit;"):
        output, _ = self.process.communicate(statement + "\n", timeout=12)
        assert self.process.returncode == 0, "concurrent_ack_claim_failed"
        return [line for line in output.splitlines() if line]


def reset_fixture():
    sql("update private.firebase_live_dispatch_config set enabled=false;"
        f"delete from private.firebase_live_outbox where room_id='{room}';"
        f"insert into private.firebase_live_outbox(room_id,epoch,kind) select '{room}',1,'message_changed' from generate_series(1,3);"
        f"update private.firebase_live_dispatch_config set enabled=true,owner_run_id='{owner}',run_deadline_at=clock_timestamp()+interval '10 minutes';"
        f"update private.firebase_live_dispatch_state set owner_run_id='{owner}',dispatch_id='{worker}',phase='running',expires_at=clock_timestamp()+interval '1 minute';")
    first = sql(f"select min(id) from private.firebase_live_outbox where room_id='{room}'")
    sql(f"update private.firebase_live_outbox set claimed_by='{worker}',claim_until=clock_timestamp()+interval '1 minute' where id={first}")
    return first


def ack(first):
    return f"select public.finish_claim_firebase_live_dispatch('{worker}',array['{first}'],1,clock_timestamp()+interval '20 seconds');"


assert sql("select not enabled from private.firebase_live_dispatch_config") == "t", "dispatch_must_be_off"
assert sql("select phase is null from private.firebase_live_dispatch_state") == "t", "publisher_must_be_idle"
assert sql("select not running from private.firebase_live_cleanup_state") == "t", "cleaner_must_be_idle"
assert sql("select count(*) from private.firebase_live_outbox") == "0", "empty_disposable_outbox_required"
tables = ["firebase_live_dispatch_config", "firebase_live_dispatch_state"]
snapshots = {table: sql(f"select row_to_json(t) from private.{table} t") for table in tables}
enqueue = sql("select pg_get_functiondef('private.enqueue_firebase_live_dispatch(uuid,text)'::regprocedure)")
try:
    sql("create or replace function private.enqueue_firebase_live_dispatch(p_dispatch uuid,p_secret text) returns bigint language plpgsql set search_path='' as $$begin raise exception 'ack_claim_network_forbidden';end$$;")
    first = reset_fixture()
    a = Transaction("duplicate_a", ack(first), 993101)
    b = Transaction("duplicate_b", ack(first)); b.blocked_by(a)
    one = json.loads(a.finish()[0]); two = json.loads(b.finish()[0])
    assert one["completed"] == [first] and len(one["rows"]) == 1
    assert two == {"completed": [], "rows": []}
    assert sql(f"select count(*) from private.firebase_live_outbox where room_id='{room}' and delivered_at is null and claimed_by='{worker}'") == "1"
    print("PASS simultaneous ACK+claim: one successor batch, duplicate never expands claims")

    first = reset_fixture()
    maintenance = Transaction("maintenance", "select public.firebase_live_maintenance(1);", 993102)
    combined = Transaction("publication", ack(first)); combined.blocked_by(maintenance)
    # If publication had ACKed before taking the global lock, this NOWAIT would
    # fail: real maintenance owns global while publisher must not own outbox.
    maintenance.finish(f"select id from private.firebase_live_outbox where id={first} for update nowait;commit;")
    assert json.loads(combined.finish()[0])["completed"] == [first]
    print("PASS maintenance inverse graph: publication waits before holding outbox")

    first = reset_fixture()
    disable = Transaction("disable", "update private.firebase_live_dispatch_config set enabled=false;", 993103)
    combined = Transaction("disabled_ack", ack(first)); combined.blocked_by(disable)
    disable.finish(); result = json.loads(combined.finish()[0])
    assert result == {"completed": [first], "rows": []}
    print("PASS concurrent disable: valid old write ACKed, no fresh claim")

    first = reset_fixture()
    replace = Transaction("replace", "update private.firebase_live_dispatch_state set dispatch_id='ab000000-0000-4000-8000-000000000004';", 993104)
    combined = Transaction("stale_ack", ack(first)); combined.blocked_by(replace)
    replace.finish(); assert json.loads(combined.finish()[0]) == {"completed": [], "rows": []}
    assert sql(f"select delivered_at is null from private.firebase_live_outbox where id={first}") == "t"
    print("PASS replaced dispatch: stale completion cannot mutate or preclaim")

    first = reset_fixture()
    combined = Transaction("finish_ack", ack(first), 993105)
    finish = Transaction("finish_owner", f"select public.finish_firebase_live_dispatch('{worker}',false,'{{}}');")
    finish.blocked_by(combined); combined.finish(); assert finish.finish() == ["t"]
    assert sql(f"select count(*) from private.firebase_live_outbox where room_id='{room}' and delivered_at is null and claim_until is not null") == "0"
    print("PASS finish handoff: combined successor claims released after unsuccessful finish")

    first = reset_fixture()
    combined = Transaction("rollback", ack(first), 993106)
    combined.finish("rollback;")
    assert sql(f"select count(*) from private.firebase_live_outbox where room_id='{room}' and delivered_at is not null") == "0"
    assert sql(f"select count(*) from private.firebase_live_outbox where room_id='{room}' and claimed_by='{worker}'") == "1"
    print("PASS transaction rollback: neither ACK nor successor claim escapes")
finally:
    for peer in peers:
        if peer.process.poll() is None:
            peer.process.communicate("rollback;\n", timeout=12)
    sql("update private.firebase_live_dispatch_config set enabled=false;"
        f"delete from private.firebase_live_outbox where room_id='{room}';"
        f"delete from private.firebase_live_epochs where room_id='{room}';"
        f"delete from private.firebase_live_cursors where room_id='{room}';"
        f"delete from private.firebase_live_access_snapshots where room_id='{room}';")
    for table, snapshot in snapshots.items():
        names = ",".join('"' + name + '"' for name in json.loads(snapshot))
        literal = snapshot.replace("'", "''")
        sql(f"update private.{table} set ({names})=(select {names} from json_populate_record(null::private.{table},'{literal}'::json)) where id")
    sql(enqueue)
    for table, snapshot in snapshots.items():
        assert json.loads(sql(f"select row_to_json(t) from private.{table} t")) == json.loads(snapshot)
    assert sql("select pg_get_functiondef('private.enqueue_firebase_live_dispatch(uuid,text)'::regprocedure)") == enqueue
    assert sql("select count(*) from private.firebase_live_outbox") == "0"
    print("PASS cleanup: singleton rows, enqueue and empty outbox restored")
