#!/usr/bin/env bash
# Exit 0 if the bridge wrote its health file within the last 60s.
# Used by Docker HEALTHCHECK and by cron/monitoring watchdogs.
set -euo pipefail
FILE="${HEALTH_FILE:-/tmp/mt5-bridge.health}"
MAX_AGE="${HEALTH_MAX_AGE:-60}"
if [[ ! -f "$FILE" ]]; then
  echo "no health file at $FILE"; exit 1
fi
AGE=$(( $(date +%s) - $(stat -c %Y "$FILE") ))
if (( AGE > MAX_AGE )); then
  echo "health file stale (${AGE}s > ${MAX_AGE}s)"; exit 1
fi
cat "$FILE"