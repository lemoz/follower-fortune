#!/bin/bash
# Quota-aware batch driver: loops the pool through codex_runner.mjs in rounds.
# Completed accounts replay from disk (skip-if-exists), so each round only
# spends Codex quota on the remainder. Run under `caffeinate -i` overnight.
#
# Usage: ./tools/batch_driver.sh <pool.json> <count> <outfile> [max_rounds]
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
POOL="$1"; COUNT="$2"; OUTFILE="$3"; MAX_ROUNDS="${4:-8}"
LOG="${OUTFILE%.json}.driver.log"
echo "=== batch driver start $(date) — pool=$POOL count=$COUNT ===" >> "$LOG"
for round in $(seq 1 "$MAX_ROUNDS"); do
  echo "--- round $round start $(date) ---" >> "$LOG"
  node "$HERE/codex_runner.mjs" "$POOL" "$COUNT" 0 "$OUTFILE" 2>&1 | tail -3 >> "$LOG"
  line=$(grep -E '^DONE:' "$LOG" | tail -1)
  fails=$(echo "$line" | sed -E 's/.* ([0-9]+) failed.*/\1/')
  echo "round $round result: $line" >> "$LOG"
  if [ -z "$fails" ] || [ "$fails" -le 15 ]; then
    echo "=== complete after round $round $(date) ===" >> "$LOG"
    exit 0
  fi
  echo "sleeping 90min for quota window (fails=$fails)..." >> "$LOG"
  sleep 5400
done
echo "=== hit round cap $(date) ===" >> "$LOG"
