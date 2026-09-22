"""Real transactions against the explicitly selected disposable Docker DB only."""
import json
import subprocess
import sys
import time

container = sys.argv[1]
if not container.startswith("supabase_db_"):
    raise SystemExit("local_supabase_container_required")
base = ["docker", "exec", container, "psql", "-U", "postgres", "-d", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1", "-c"]
uid = "a9000000-0000-4000-8000-000000000001"
sid = "a9000000-0000-4000-8000-000000000002"
room = None


def sql(statement):
    return subprocess.run(base + [statement], text=True, capture_output=True, check=True).stdout.strip()


def begin_user():
    claims = json.dumps({"sub": uid, "session_id": sid, "exp": int(time.time()) + 3600})
    return f"begin; set local statement_timeout='8s'; set local role authenticated; set local request.jwt.claims='{claims}';"


def event(identifier, sequence, kind="typing_start"):
    return f"select public.authorize_firebase_direct_event('{room}',(select realtime_epoch from public.rooms where id='{room}'),'{identifier}','{kind}',null,'{sequence}');"


def wait_barrier(key):
    for _ in range(100):
        if sql(f"select pg_try_advisory_lock({key})") == "f":
            return
        time.sleep(0.02)
    raise AssertionError("transaction_barrier_missing")


assert sql("select not enabled from private.firebase_live_dispatch_config") == "t", "network_dispatch_must_be_off"
assert sql("select count(*) from private.firebase_live_users") == "0", "disposable_empty_cohort_required"
initial = sql("select row_to_json(c) from private.firebase_live_config c")
try:
    sql(f"""insert into auth.users(id,instance_id,aud,role,raw_app_meta_data,raw_user_meta_data,is_anonymous,created_at,updated_at)
      values('{uid}','00000000-0000-0000-0000-000000000000','authenticated','authenticated','{{"provider":"anonymous","providers":["anonymous"]}}','{{}}',true,now(),now());
      insert into auth.sessions(id,user_id,created_at,updated_at) values('{sid}','{uid}',now(),now());""")
    output = sql(begin_user() + "select public.upsert_profile('동시검사','pixel_hamster'); select room_id from public.create_room('direct concurrency'); commit;")
    room = output.splitlines()[-1]
    sql(f"insert into private.firebase_live_users values('{uid}',true); insert into private.firebase_live_rooms values('{room}',true); update private.firebase_live_config set enabled=true,direct_events_enabled=true;")
    sql(begin_user() + "select public.prepare_firebase_live_lease(); commit;")

    # A newer stop holds its sequence row until commit. A concurrently delayed
    # older start must wait and then fail; its error cannot roll back the stop.
    stop = subprocess.Popen(base + [begin_user() + event("a9100000-0000-4000-8000-000000000001", 20, "typing_stop")
                                   + "select pg_advisory_xact_lock(991001); select pg_sleep(1); commit;"],
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    wait_barrier(991001)
    old = subprocess.run(base + [begin_user() + event("a9100000-0000-4000-8000-000000000002", 19) + "commit;"], text=True, capture_output=True)
    stop.communicate(timeout=10)
    assert stop.returncode == 0 and old.returncode != 0 and "stale_typing_sequence" in old.stderr
    assert sql(f"select sequence from private.firebase_direct_typing_sequences where room_id='{room}'") == "20"

    duplicate = "a9100000-0000-4000-8000-000000000003"
    left = subprocess.Popen(base + [begin_user() + event(duplicate, 21) + "select pg_advisory_xact_lock(991002); select pg_sleep(1); commit;"],
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    wait_barrier(991002)
    right = subprocess.run(base + [begin_user() + event(duplicate, 22) + "commit;"], text=True, capture_output=True)
    left.communicate(timeout=10)
    assert left.returncode == 0 and right.returncode != 0 and "duplicate_event" in right.stderr
    assert sql(f"select count(*) from private.firebase_direct_events where event_id='{duplicate}'") == "1"

    # Config -> room order must match the rollout trigger, never deadlock with it.
    disabling = subprocess.Popen(base + ["begin; set local statement_timeout='5s'; select id from private.firebase_live_config for update; "
                                         "select pg_advisory_xact_lock(991003); select pg_sleep(1); update private.firebase_live_config set enabled=false; commit;"],
                                 text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    wait_barrier(991003)
    rejected = subprocess.run(base + [begin_user() + event("a9100000-0000-4000-8000-000000000004", 23) + "commit;"], text=True, capture_output=True)
    disabling.communicate(timeout=10)
    assert disabling.returncode == 0 and rejected.returncode != 0 and "direct_events_disabled" in rejected.stderr
    print("PASS direct-event concurrent UUID, reordered typing and rollout lock order")
finally:
    sql("update private.firebase_live_config set enabled=false,direct_events_enabled=false;")
    if room:
        sql(f"delete from public.rooms where id='{room}'; delete from private.firebase_live_rooms where room_id='{room}'; "
            f"delete from private.firebase_live_outbox where room_id='{room}'; delete from private.firebase_live_epochs where room_id='{room}'; "
            f"delete from private.firebase_direct_events where room_id='{room}';")
    sql(f"delete from auth.users where id='{uid}'; delete from private.firebase_live_leases where user_id='{uid}';")
    original = json.loads(initial)
    sql(f"update private.firebase_live_config set enabled={str(original['enabled']).lower()},direct_events_enabled={str(original['direct_events_enabled']).lower()};")
