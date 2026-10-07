#!/usr/bin/env bash
# Box backup driver for the TEST / SHADOW intraday jobs (primary = Vercel daily crons on /api/shadow/tick).
# Curls /api/shadow/tick every ~4 min during US market hours (Mon–Fri 9:30–16:05 ET). Read-only GETs; the server
# self-throttles (≤ 1 tick / 170 s across all callers) and pauses new jobs at 35,000 UW calls/day.
# Start: nohup scripts/study/shadow-ticker.sh >>/tmp/shadow-ticker.log 2>&1 &   Stop: kill "$(cat /tmp/shadow-ticker.pid)"
PIDFILE=/tmp/shadow-ticker.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
echo $$ >"$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT
BASE="${FLOWGUARD_URL:-https://flowguard-zeta.vercel.app}"
while true; do
  dow=$(TZ=America/New_York date +%u); hm=$(TZ=America/New_York date +%H%M)
  if [ "$dow" -le 5 ] && [ "$((10#$hm))" -ge 930 ] && [ "$((10#$hm))" -lt 1605 ]; then
    echo "$(date '+%F %T %Z') $(curl -s -m 110 "$BASE/api/shadow/tick" | head -c 300)"
    sleep 240
  else
    sleep 300
  fi
done
