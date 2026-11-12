#!/bin/bash
set -euo pipefail

# =============================================================
# Chumbaq - Update Deployment Script
# Pulls the branch, re-applies the CERT-In server pieces (scripts/server-security.sh; prod
# only, they are the server's), rebuilds everything, and reloads this environment's
# customer API, admin API and worker, in that order, checking each is healthy.
# Usage: DEPLOY_ENV=prod|stage ./deploy-update.sh [branch]
# =============================================================

# The environment's directory, ports, pm2 names and helpers, from the setup script (which
# sources server-security.sh). It stops after its definitions when sourced, so nothing is
# installed or written here.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy-setup.sh
source "$SCRIPT_DIR/deploy-setup.sh"
BRANCH="${1:-$BRANCH}"

echo "========================================="
echo "  Chumbaq - Deploying $BRANCH to $DEPLOY_ENV"
echo "========================================="

# Before anything changes: log retention may never go under 180 days (CERT-In).
check_log_retention_days "${LOG_RETENTION_DAYS:-$(env_file_value "$APP_DIR/.env" LOG_RETENTION_DAYS)}" > /dev/null

cd "$APP_DIR"

# Local edits would be overwritten or block the pull halfway; stop before touching anything.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "$APP_DIR has uncommitted changes. Commit, stash or discard them first:" >&2
  git status --short >&2
  exit 1
fi

# Files changed since the last deploy are raised now, before this deploy changes any.
check_files_before_deploy

# --- Pull latest ---
echo "[1/5] Pulling $BRANCH..."
PREVIOUS=$(git rev-parse --short HEAD)
git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
CURRENT=$(git rev-parse --short HEAD)

# --- Install deps ---
echo "[2/5] Installing dependencies..."
npm ci

# --- Server pieces: clock, log retention, nginx log format, alarms, collector ---
echo "[3/5] Re-applying the clock, log retention and security alarm setup..."
if server_wide; then
  setup_server_security "$APP_DIR/.env"
else
  echo "  The server's; re-applied by DEPLOY_ENV=prod deploys."
fi

# --- Build ---
echo "[4/5] Building shared, API, dashboard and admin app..."
npm run build:shared
npm run build:api
npm run build:web
npm run build:admin

# --- Reload ---
# Redis restarts here (a first run adds its password), right before the processes that
# use it reload, so they are never left on the old settings for the length of a build.
# The customer API applies migrations as it boots; the admin API and the worker never
# change the schema, so they reload only once it answers healthy.
echo "[5/5] Reloading services..."
ensure_redis_settings "$APP_DIR/.env"
setup_redis "$APP_DIR/.env"
pm2_up api
wait_for_health "$API_PORT"
pm2_up admin-api
pm2_up worker
wait_for_health "$ADMIN_API_PORT"
pm2 save
sudo nginx -t
sudo systemctl reload nginx

# What was just deployed is the new baseline for the daily file check.
update_file_baseline

echo ""
echo "========================================="
echo "  Deployed $BRANCH to $DEPLOY_ENV: $PREVIOUS -> $CURRENT"
echo "========================================="
echo "  To go back: cd $APP_DIR && git checkout $PREVIOUS, then rebuild and restart"
echo "  (a migration that already ran is not undone by this; see migration:revert)."
echo ""
pm2 status
