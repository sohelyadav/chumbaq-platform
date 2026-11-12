#!/bin/bash
# Gathers every log for a time window into one root-only archive, for CERT-In
# (directions of 28 April 2022, (iv): logs "provided to CERT-In along with reporting
# of any incident or when ordered"). Run on the server as root:
#
#   sudo chumbaq-collect-logs --from 2026-11-10T08:00:00Z --to 2026-11-11T10:00:00Z [--out DIR]
#
# deploy-setup.sh installs this as /usr/local/sbin/chumbaq-collect-logs and the .mjs
# beside it in /usr/local/lib/chumbaq, root-owned: root never runs code from the app's
# directory, which the app user can write. The admin Incidents page shows the command
# for each incident's window. The work is in collect-logs.mjs (Node, as the app needs).
set -euo pipefail
if [ "$(id -u)" != "0" ] && [ "${COLLECT_LOGS_ALLOW_NON_ROOT:-}" != "1" ]; then
  echo "collect-logs.sh must run as root (sudo): the logs are readable only by root and adm." >&2
  exit 1
fi
HERE="$(dirname "$0")"
[ -f "$HERE/collect-logs.mjs" ] || HERE=/usr/local/lib/chumbaq
exec "${NODE_BIN:-node}" "$HERE/collect-logs.mjs" "$@"
