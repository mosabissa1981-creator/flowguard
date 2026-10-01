#!/usr/bin/env bash
# FlowGuard nightly history backfill + backtest (box only). Safe to re-run: resumable and budget-capped.
# Usage: scripts/backtest/run-nightly.sh [--days=N] [--from=YYYY-MM-DD] [--no-fetch] [--summary-only]
# Budget: stops when UW's own x-uw-daily-req-count reaches UW_STOP_AT (default 37500; never above 37500).
set -euo pipefail
cd "$(dirname "$0")/../.."
HIST="${HISTORY_DIR:-/workspace/flowguard/history}"
mkdir -p "$HIST/logs"
LOCK="$HIST/.nightly.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "another history run is active"; exit 0; }
# Clean env: only the UW key (no LLM / Telegram / KV / Blob credentials reach the replay).
exec env -i PATH="$PATH" HOME="$HOME" TZ=America/Chicago NODE_OPTIONS="--max-old-space-size=6144" \
  UNUSUAL_WHALES_API_KEY="${UNUSUAL_WHALES_API_KEY:?UNUSUAL_WHALES_API_KEY missing}" \
  HISTORY_DIR="$HIST" UW_STOP_AT="${UW_STOP_AT:-37500}" \
  npx tsx --conditions=react-server scripts/backtest/nightly.ts "$@" \
  >>"$HIST/logs/nightly-$(date +%F).log" 2>&1
