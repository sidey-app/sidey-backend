#!/usr/bin/env python3
"""Exercise account isolation and the tenth-send race against the local DB."""

import concurrent.futures
import subprocess
import sys


container = sys.argv[1]
if not container.startswith("supabase_db_"):
    raise SystemExit("local_supabase_container_required")
psql = [
    "docker", "exec", container, "psql", "-U", "postgres", "-d", "postgres",
    "-qAt", "-v", "ON_ERROR_STOP=1", "-c",
]


def run(sql):
    return subprocess.run(
        psql + [sql], capture_output=True, text=True, check=False, timeout=20
    )


def user_id(number):
    return f"30000000-0000-0000-0000-{number:012d}"


def room_id(number):
    return f"40000000-0000-0000-0000-{number:012d}"


def message_id(number, sequence):
    return f"50000000-0000-4000-8000-{number * 1000 + sequence:012d}"


def authenticated_sql(number, statement, pause=False):
    pause_sql = (
        "select set_config('sidey.concurrency_test', 'on', true);"
        if pause else ""
    )
    return (
        "begin; set local role authenticated; "
        f"select set_config('request.jwt.claim.sub', '{user_id(number)}', true); "
        f"{pause_sql} {statement} commit;"
    )


def seed(number):
    statement = (
        "do $body$ declare n integer; begin for n in 1..9 loop "
        "perform public.send_message("
        f"('50000000-0000-4000-8000-' || lpad(({number} * 1000 + n)::text, 12, '0'))::uuid, "
        f"'{room_id(number)}', 'seed-' || n); "
        "end loop; end $body$;"
    )
    result = run(authenticated_sql(number, statement))
    if result.returncode:
        raise RuntimeError(f"seed for user {number}: {result.stderr}")


def send(number, sequence):
    statement = (
        "select (public.send_message("
        f"'{message_id(number, sequence)}', '{room_id(number)}', "
        f"'race-{sequence}')).id;"
    )
    return run(authenticated_sql(number, statement, pause=True))


with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(seed, (1, 2, 3)))

# Pin all seeded successes to a fresh common window even on slow CI runners.
fresh_window = run(
    "update private.message_attempts set attempted_at = clock_timestamp() "
    "where user_id in ("
    + ",".join(f"'{user_id(number)}'" for number in (1, 2, 3))
    + ");"
)
if fresh_window.returncode:
    raise RuntimeError(f"refresh seed window: {fresh_window.stderr}")

# Distinct account locks must allow both tenth sends. Two concurrent calls on
# account 3 must serialize so only one can take the final available slot.
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    pending = {
        label: pool.submit(send, number, sequence)
        for label, number, sequence in (
            ("first", 1, 10),
            ("second", 2, 10),
            ("same-a", 3, 10),
            ("same-b", 3, 11),
        )
    }
    results = {label: future.result() for label, future in pending.items()}

for label in ("first", "second"):
    if results[label].returncode:
        raise AssertionError(f"{label} account was blocked: {results[label].stderr}")

same_account = (results["same-a"], results["same-b"])
if sorted(result.returncode == 0 for result in same_account) != [False, True]:
    raise AssertionError("same-account race did not have exactly one winner")
if not any("message_rate_limited" in result.stderr for result in same_account):
    raise AssertionError("same-account loser did not receive message_rate_limited")

for number in (1, 2, 3):
    count = run(
        "select count(*)::text || ':' || count(blocked_until)::text "
        "from private.message_attempts "
        f"where user_id = '{user_id(number)}';"
    )
    if count.returncode or count.stdout.strip() != "10:1":
        raise AssertionError(f"account {number} ledger: {count.stdout} {count.stderr}")

for number in (1, 2):
    rejected = send(number, 11)
    if rejected.returncode == 0 or "message_rate_limited" not in rejected.stderr:
        raise AssertionError(f"account {number} eleventh send: {rejected}")

print("Message rate concurrency passed: independent accounts and one tenth-send winner")
