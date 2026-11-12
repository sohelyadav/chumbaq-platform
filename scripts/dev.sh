#!/bin/bash
set -e

# =============================================================
# Chumbaq — local dev stack
# Starts the customer API, the admin API, the BullMQ worker, the
# customer dashboard (apps/web) and the admin app (apps/admin).
# Usage: npm run dev:all   (or ./scripts/dev.sh)
# Ctrl-C stops all five.
#
# The worker is not optional in dev: push campaigns stay in
# `queued` and segments never materialise without it, with no
# error surfaced anywhere. Running it here avoids losing an
# afternoon to a dashboard that looks healthy but does nothing.
# =============================================================

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; DIM=$'\033[2m'; OFF=$'\033[0m'

fail() { echo "${RED}✗${OFF} $1"; [ -n "$2" ] && echo "  ${DIM}$2${OFF}"; exit 1; }
ok()   { echo "${GREEN}✓${OFF} $1"; }

# ------------------------------------------------------------
# Config — read the same repo-root .env the app loads.
# Values are used for connectivity checks only and never printed.
# ------------------------------------------------------------
[ -f .env ] || fail ".env not found at $ROOT/.env" \
  "The API throws on boot without it. See CLAUDE.md for the required vars."

# dotenv allows whitespace around `=`, so this must too — otherwise the script
# would silently fall back to a default port while the app used the real one.
read_env() {
  grep -E "^[[:space:]]*$1[[:space:]]*=" .env 2>/dev/null | tail -1 | cut -d= -f2- \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" \
    | tr -d '\r'
}

API_PORT="$(read_env API_PORT)";        API_PORT="${API_PORT:-3000}"
DB_HOST="$(read_env DATABASE_HOST)";    DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="$(read_env DATABASE_PORT)";    DB_PORT="${DB_PORT:-5432}"
RD_HOST="$(read_env REDIS_HOST)";       RD_HOST="${RD_HOST:-127.0.0.1}"
RD_PORT="$(read_env REDIS_PORT)";       RD_PORT="${RD_PORT:-6379}"
WEB_PORT=5173
# Optional in .env, like the admin API itself: both default to 3011.
ADMIN_API_PORT="$(read_env ADMIN_API_PORT)"; ADMIN_API_PORT="${ADMIN_API_PORT:-3011}"
# Fixed in apps/admin/vite.config.ts (strictPort), as 5173 is for the customer app.
ADMIN_WEB_PORT=5174

# ------------------------------------------------------------
# Preflight — fail with a fix, not a stack trace
# ------------------------------------------------------------
echo "${DIM}preflight${OFF}"

port_open() { nc -z "$1" "$2" >/dev/null 2>&1; }

port_open "$DB_HOST" "$DB_PORT" \
  || fail "Postgres unreachable on $DB_HOST:$DB_PORT" \
          "Start Postgres.app, or: brew services start postgresql"
ok "postgres  $DB_HOST:$DB_PORT"

if command -v redis-cli >/dev/null 2>&1; then
  [ "$(redis-cli -h "$RD_HOST" -p "$RD_PORT" ping 2>/dev/null)" = "PONG" ] \
    || fail "Redis not answering on $RD_HOST:$RD_PORT" \
            "Run: brew services start redis"
else
  port_open "$RD_HOST" "$RD_PORT" \
    || fail "Redis unreachable on $RD_HOST:$RD_PORT" "Run: brew services start redis"
fi
ok "redis     $RD_HOST:$RD_PORT"

for p in "$API_PORT" "$WEB_PORT" "$ADMIN_API_PORT" "$ADMIN_WEB_PORT"; do
  if lsof -ti ":$p" >/dev/null 2>&1; then
    fail "Port $p is already in use" \
         "Find it with: lsof -ti :$p   then: kill \$(lsof -ti :$p)"
  fi
done
ok "ports     $API_PORT, $WEB_PORT, $ADMIN_API_PORT, $ADMIN_WEB_PORT free"
echo ""

# ------------------------------------------------------------
# Process management
#
# Each service runs `npm → nest start --watch → node dist/…`, so the
# pid we hold is three levels above the process that actually binds
# the port. `set -m` puts every background job in its own process
# group, which lets teardown signal the whole chain at once — and,
# unlike walking parent links with pgrep, a process group still
# catches a child that got reparented to init on the way down.
# ------------------------------------------------------------
set -m

PGIDS=""

start() {
  name="$1"; shift
  ( "$@" 2>&1 | awk -v tag="[$name]" '{ print tag, $0; fflush() }' ) &
  # With job control enabled, a job's pid is also its process group id.
  PGIDS="$PGIDS $!"
  # Drop the job from the shell's table so teardown doesn't print three lines
  # of "Terminated: 15 ( "$@" 2>&1 | awk ... )" over our own status output.
  # The process group is a kernel object and outlives the job entry, so the
  # signalling below is unaffected.
  disown %% 2>/dev/null || true
}

group_alive() { kill -0 "-$1" 2>/dev/null; }

# The worker calls app.enableShutdownHooks(), and BullMQ's blocking Redis
# connection can leave that shutdown hanging indefinitely — an observed run
# left a `dist/worker` alive and reparented to init long after SIGTERM. So
# TERM is only an invitation: anything still up after GRACE_SECS gets SIGKILL.
GRACE_SECS=5

STOPPING=0
cleanup() {
  [ "$STOPPING" = "1" ] && return
  STOPPING=1
  trap - INT TERM EXIT
  echo ""
  echo "${YELLOW}→${OFF} stopping…"

  for pgid in $PGIDS; do kill -TERM "-$pgid" 2>/dev/null || true; done

  waited=0
  while [ "$waited" -lt "$GRACE_SECS" ]; do
    still=""
    for pgid in $PGIDS; do group_alive "$pgid" && still="yes"; done
    [ -z "$still" ] && break
    sleep 1
    waited=$((waited + 1))
  done

  for pgid in $PGIDS; do
    group_alive "$pgid" && kill -KILL "-$pgid" 2>/dev/null || true
  done
  ok "all stopped"
}

# Ctrl-C exits here rather than returning into the watchdog below, which
# would otherwise see the processes cleanup just killed and report a clean
# shutdown as a crash.
on_signal() { cleanup; exit 0; }
# HUP matters as much as INT here: closing the terminal kills this script
# without it, and the five service trees are then orphaned to init, still
# holding ports 3010, 3011, 5173 and 5174.
trap on_signal INT TERM HUP
trap cleanup EXIT

# ------------------------------------------------------------
# Go
# ------------------------------------------------------------
start api       npm run dev:api
start admin-api npm run dev:admin-api
start worker    npm run dev:worker
start web       npm run dev:web
start admin     npm run dev:admin

echo "${GREEN}▸${OFF} api        http://localhost:$API_PORT"
echo "${GREEN}▸${OFF} admin-api  http://127.0.0.1:$ADMIN_API_PORT"
echo "${GREEN}▸${OFF} web        https://localhost:$WEB_PORT  ${DIM}(customer dashboard; self-signed cert — expect a browser warning)${OFF}"
echo "${GREEN}▸${OFF} admin      https://localhost:$ADMIN_WEB_PORT  ${DIM}(staff only; self-signed cert)${OFF}"
echo "${GREEN}▸${OFF} worker     consuming push-campaign, cohort-sync, segment-materialize"
echo "${DIM}Ctrl-C stops all five.${OFF}"
echo ""

# If any one dies, take the whole stack down rather than leaving
# a half-running setup that looks fine from the dashboard.
while true; do
  for pgid in $PGIDS; do
    group_alive "$pgid" || { echo ""; echo "${RED}✗${OFF} a process exited — stopping the rest"; exit 1; }
  done
  sleep 2
done
