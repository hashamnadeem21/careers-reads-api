#!/usr/bin/env bash
# Private local Postgres for development and tests (port 54329, databases blognest + blognest_test).
# Uses the Homebrew Postgres binaries; it never touches any other Postgres server.
# Data lives in PG_DATA_DIR. Default: .data/pg, or the admin's ../blognest-admin/.data/pg if that
# already exists, so the API, admin and website all share the one local database.
set -euo pipefail
cd "$(dirname "$0")/.."
export LC_ALL="${LC_ALL:-en_US.UTF-8}" LANG="${LANG:-en_US.UTF-8}"
PGBIN="${PGBIN:-$(dirname "$(command -v pg_ctl || echo /opt/homebrew/opt/postgresql@18/bin/pg_ctl)")}"
PORT="${PGPORT_LOCAL:-54329}"
if [ -n "${PG_DATA_DIR:-}" ]; then DATA="$PG_DATA_DIR"
elif [ ! -d .data/pg ] && [ -d ../blognest-admin/.data/pg ]; then DATA="../blognest-admin/.data/pg"
else DATA=".data/pg"; fi
LOG="$(dirname "$DATA")/pg.log"

case "${1:-start}" in
  start)
    if [ ! -d "$DATA" ]; then
      mkdir -p "$(dirname "$DATA")"
      "$PGBIN/initdb" -D "$DATA" --auth=trust -U postgres -E UTF8 >/dev/null
    fi
    if ! "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
      "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$LOG" -w start >/dev/null
    fi
    for db in blognest blognest_test; do
      "$PGBIN/psql" -h localhost -p "$PORT" -U postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 \
        || "$PGBIN/psql" -h localhost -p "$PORT" -U postgres -qc "create database $db"
    done
    echo "Postgres running ($DATA): postgres://postgres@localhost:$PORT/blognest"
    ;;
  stop) "$PGBIN/pg_ctl" -D "$DATA" -w stop ;;
  status) "$PGBIN/pg_ctl" -D "$DATA" status ;;
  *) echo "usage: db-local.sh start|stop|status" >&2; exit 1 ;;
esac
