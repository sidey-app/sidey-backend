"""Exercise the three-resource 141300 lock order on an exact-prefix database.

Production exposed two distinct hosted lock cycles. The first frozen fixture
recorded migration auth.users -> rooms against live rooms -> auth.users. The
second server DETAIL recorded migration rooms -> realtime.messages against a
hosted realtime.messages -> rooms path. The model cases preserve only those
observed modes/directions; they do not invent a hosted implementation.

The final cases run the real 141300 migration. They prove its first bounded
Realtime lock times out before any catalog mutation, rolls the transaction
back byte-for-byte for every touched contract object, and resumes successfully.
"""

import pathlib
import subprocess
import sys
import time


ROOT = pathlib.Path(__file__).resolve().parents[2]
MIGRATION = (
    ROOT
    / "supabase"
    / "production-migrations"
    / "20260921141300_firebase_production_presence_inbox_delivery.sql"
)

if len(sys.argv) != 3:
    raise SystemExit("usage: test_presence_inbox_migration_lock_order.py CONTAINER DATABASE")

container, database = sys.argv[1:]
if not container.startswith("supabase_db_"):
    raise SystemExit("local_supabase_container_required")
if database in {"postgres", "template0", "template1"}:
    raise SystemExit("disposable_exact_prefix_database_required")

base = [
    "docker", "exec", "-i", container, "psql", "-X", "-qAt",
    "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database,
]


def run(statement: str, *, timeout: int = 15) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        base,
        input=statement,
        text=True,
        capture_output=True,
        timeout=timeout,
    )


def require_success(statement: str, *, timeout: int = 15) -> str:
    result = run(statement, timeout=timeout)
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


def start(statement: str) -> subprocess.Popen[str]:
    process = subprocess.Popen(
        base,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdin is not None
    process.stdin.write(statement)
    process.stdin.close()
    process.stdin = None
    return process


def finish(process: subprocess.Popen[str], *, timeout: int = 15) -> tuple[int, str]:
    _, errors = process.communicate(timeout=timeout)
    return process.returncode, errors


def wait_for_application(name: str) -> None:
    escaped = name.replace("'", "''")
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if require_success(
            "select exists(select 1 from pg_stat_activity "
            f"where application_name='{escaped}');"
        ) == "t":
            return
        time.sleep(0.02)
    raise AssertionError("fixture_session_missing")


def assert_deadlock(
    left: subprocess.Popen[str], right: subprocess.Popen[str], label: str
) -> None:
    left_result = finish(left)
    right_result = finish(right)
    errors = left_result[1] + right_result[1]
    assert left_result[0] != 0 or right_result[0] != 0, f"{label}_deadlock_missing"
    assert "deadlock detected" in errors, f"unexpected_{label}_failure:{errors}"


assert require_success(
    "select to_regclass('private.firebase_room_revision_outbox') is not null "
    "and to_regclass('public.rooms') is not null "
    "and to_regclass('auth.users') is not null "
    "and to_regclass('realtime.messages') is not null;"
) == "t", "exact_prefix_objects_missing"
assert require_success(
    "select not exists(select 1 from pg_attribute "
    "where attrelid='private.firebase_room_revision_outbox'::regclass "
    "and attname='deletion_recipient_ids' and not attisdropped);"
) == "t", "141300_already_applied"

migration_sql = MIGRATION.read_text(encoding="utf-8")
realtime_lock = "lock table realtime.messages in access exclusive mode;"
rooms_lock = "lock table public.rooms in access exclusive mode;"
assert migration_sql.count(realtime_lock) == 1, "realtime_prelock_count_drift"
assert migration_sql.count(rooms_lock) == 1, "rooms_prelock_count_drift"
assert migration_sql.index(realtime_lock) < migration_sql.index(rooms_lock), (
    "141300_lock_order_drift"
)

# Frozen first production observation: migration owned auth AE then requested
# rooms AE while a live transaction owned rooms RS then requested auth RS.
migration = start(
    "begin; set local application_name='sidey_141300_old_migration'; "
    "set local deadlock_timeout='100ms'; "
    "lock table auth.users in access exclusive mode; select pg_sleep(0.4); "
    "lock table public.rooms in access exclusive mode; commit;"
)
wait_for_application("sidey_141300_old_migration")
live = start(
    "begin; set local application_name='sidey_141300_old_live'; "
    "set local deadlock_timeout='100ms'; "
    "lock table public.rooms in row share mode; select pg_sleep(0.4); "
    "lock table auth.users in row share mode; commit;"
)
assert_deadlock(migration, live, "auth_rooms")
print("PASS observed auth->rooms / rooms->auth order deadlocks")

# Second production observation: rooms AE -> realtime AE against a hosted
# realtime lock -> rooms AS. ACCESS SHARE is the weakest sufficient held mode,
# so this model does not overclaim the unavailable hosted held-lock detail.
migration = start(
    "begin; set local application_name='sidey_141300_rooms_realtime_migration'; "
    "set local deadlock_timeout='100ms'; "
    "lock table public.rooms in access exclusive mode; select pg_sleep(0.4); "
    "lock table realtime.messages in access exclusive mode; commit;"
)
wait_for_application("sidey_141300_rooms_realtime_migration")
live = start(
    "begin; set local application_name='sidey_141300_realtime_rooms_live'; "
    "set local deadlock_timeout='100ms'; "
    "lock table realtime.messages in access share mode; select pg_sleep(0.4); "
    "lock table public.rooms in access share mode; commit;"
)
assert_deadlock(migration, live, "rooms_realtime")
print("PASS observed rooms->realtime / realtime->rooms order deadlocks")

# Realtime -> rooms -> later auth lets the first live path finish its auth lock
# before the migration owns rooms.
live = start(
    "begin; set local application_name='sidey_141300_candidate_auth_live'; "
    "lock table public.rooms in row share mode; select pg_sleep(0.4); "
    "lock table auth.users in row share mode; commit;"
)
wait_for_application("sidey_141300_candidate_auth_live")
migration = start(
    "begin; set local application_name='sidey_141300_candidate_auth_migration'; "
    "set local lock_timeout='5s'; "
    "lock table realtime.messages in access exclusive mode; "
    "lock table public.rooms in access exclusive mode; "
    "lock table auth.users in access exclusive mode; commit;"
)
assert finish(live)[0] == 0, "candidate_auth_live_failed"
assert finish(migration)[0] == 0, "candidate_deadlocked_with_auth_path"
print("PASS realtime->rooms->auth drains observed auth/rooms live path")

# The same order waits on Realtime while owning no dependent lock, allowing the
# second live path to finish its rooms read.
live = start(
    "begin; set local application_name='sidey_141300_candidate_realtime_live'; "
    "lock table realtime.messages in access share mode; select pg_sleep(0.4); "
    "lock table public.rooms in access share mode; commit;"
)
wait_for_application("sidey_141300_candidate_realtime_live")
migration = start(
    "begin; set local application_name='sidey_141300_candidate_realtime_migration'; "
    "set local lock_timeout='5s'; "
    "lock table realtime.messages in access exclusive mode; "
    "lock table public.rooms in access exclusive mode; "
    "lock table auth.users in access exclusive mode; commit;"
)
assert finish(live)[0] == 0, "candidate_realtime_live_failed"
assert finish(migration)[0] == 0, "candidate_deadlocked_with_realtime_path"
print("PASS realtime->rooms->auth drains observed realtime/rooms live path")

# Both observed live paths can overlap. The candidate must still wait without
# closing a cycle and resume after both complete.
auth_live = start(
    "begin; set local application_name='sidey_141300_candidate_both_auth'; "
    "lock table public.rooms in row share mode; select pg_sleep(0.4); "
    "lock table auth.users in row share mode; commit;"
)
realtime_live = start(
    "begin; set local application_name='sidey_141300_candidate_both_realtime'; "
    "lock table realtime.messages in access share mode; select pg_sleep(0.4); "
    "lock table public.rooms in access share mode; commit;"
)
wait_for_application("sidey_141300_candidate_both_auth")
wait_for_application("sidey_141300_candidate_both_realtime")
migration = start(
    "begin; set local application_name='sidey_141300_candidate_both_migration'; "
    "set local lock_timeout='5s'; "
    "lock table realtime.messages in access exclusive mode; "
    "lock table public.rooms in access exclusive mode; "
    "lock table auth.users in access exclusive mode; commit;"
)
assert finish(auth_live)[0] == 0, "candidate_both_auth_live_failed"
assert finish(realtime_live)[0] == 0, "candidate_both_realtime_live_failed"
assert finish(migration)[0] == 0, "candidate_deadlocked_with_overlapping_paths"
print("PASS realtime->rooms->auth drains both observed live paths together")

# Snapshot every catalog object 141300 can replace or create. A first-lock
# timeout must leave this serialized inventory byte-identical.
catalog_snapshot_sql = r"""
select jsonb_build_object(
  'column', exists(
    select 1 from pg_attribute
    where attrelid='private.firebase_room_revision_outbox'::regclass
      and attname='deletion_recipient_ids' and not attisdropped
  ),
  'functions', coalesce((
    select jsonb_agg(jsonb_build_array(
      n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
      pg_get_functiondef(p.oid)
    ) order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname,p.proname) in (
      ('private','can_read_user_presence_topic'),
      ('private','can_write_user_presence_topic'),
      ('private','tombstone_firebase_room_revision'),
      ('private','capture_firebase_room_deletion'),
      ('public','claim_firebase_room_revisions')
    )
  ), '[]'::jsonb),
  'policies', coalesce((
    select jsonb_agg(to_jsonb(p) order by p.policyname)
    from pg_policies p
    where p.schemaname='realtime' and p.tablename='messages'
      and p.policyname in ('sidey_room_channels_select','sidey_room_channels_insert')
  ), '[]'::jsonb),
  'trigger', coalesce((
    select jsonb_agg(jsonb_build_array(t.tgname, pg_get_triggerdef(t.oid, true)) order by t.tgname)
    from pg_trigger t
    where t.tgrelid='public.rooms'::regclass
      and t.tgname='firebase_room_revision_deleted' and not t.tgisinternal
  ), '[]'::jsonb)
)::text;
"""

before_timeout = require_success(catalog_snapshot_sql)
holder = start(
    "begin; set local application_name='sidey_141300_timeout_holder'; "
    "lock table realtime.messages in access share mode; select pg_sleep(6); commit;"
)
wait_for_application("sidey_141300_timeout_holder")
timed_out = run(migration_sql, timeout=12)
assert timed_out.returncode != 0 and "lock timeout" in timed_out.stderr, (
    "bounded_timeout_missing"
)
after_timeout = require_success(catalog_snapshot_sql)
assert after_timeout == before_timeout, "timeout_changed_141300_catalog"
assert finish(holder, timeout=12)[0] == 0, "timeout_holder_failed"
print("PASS first-lock five-second timeout leaves 141300 catalog byte-identical")

retry = run(migration_sql, timeout=60)
assert retry.returncode == 0, f"141300_resume_failed:{retry.stderr}"
assert require_success(
    "select exists(select 1 from pg_attribute "
    "where attrelid='private.firebase_room_revision_outbox'::regclass "
    "and attname='deletion_recipient_ids' and not attisdropped) "
    "and to_regprocedure('private.can_read_user_presence_topic(text,uuid)') is not null "
    "and to_regprocedure('private.can_write_user_presence_topic(text,uuid)') is not null "
    "and to_regprocedure('private.tombstone_firebase_room_revision(uuid)') is not null "
    "and to_regprocedure('private.capture_firebase_room_deletion()') is not null "
    "and exists(select 1 from pg_trigger "
    "where tgrelid='public.rooms'::regclass "
    "and tgname='firebase_room_revision_deleted' and not tgisinternal) "
    "and exists(select 1 from pg_policies where schemaname='realtime' "
    "and tablename='messages' and policyname='sidey_room_channels_select') "
    "and exists(select 1 from pg_policies where schemaname='realtime' "
    "and tablename='messages' and policyname='sidey_room_channels_insert');"
) == "t", "141300_resume_readback_failed"
print("PASS exact 141300 resumes and installs presence/deletion delivery contract")
