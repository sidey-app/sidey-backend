#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
SIDEY_PG_BIN=${SIDEY_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
mkdir -p .runtime
if [ ! -f .runtime/postgres/PG_VERSION ]; then
  "$SIDEY_PG_BIN/initdb" -D .runtime/postgres -U sidey --auth=trust --encoding=UTF8 --locale=C >/dev/null
fi
if ! "$SIDEY_PG_BIN/pg_ctl" -D .runtime/postgres status >/dev/null 2>&1; then
  "$SIDEY_PG_BIN/pg_ctl" -D .runtime/postgres -l .runtime/postgres.log -o '-h 127.0.0.1 -p 55432' start
fi
if ! "$SIDEY_PG_BIN/psql" -h 127.0.0.1 -p 55432 -U sidey -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='sidey'" | rg -q 1; then
  "$SIDEY_PG_BIN/createdb" -h 127.0.0.1 -p 55432 -U sidey sidey
fi
