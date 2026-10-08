#!/usr/bin/env bash
# TEST MODE daily logger loop (no cron on the box). Weekdays after 3:20 PM CT: score today's board (read-only shadow book)
# into study/loss-model-daily-YYYY-MM-DD.json; also backfills the last 7 calendar days if a file is missing (e.g. after a
# host restart killed the loop). Niced, single-threaded. Start:  nohup scripts/study/loss-model-daily-loop.sh >> /tmp/loss-model-daily.log 2>&1 &
set -u
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PY=/workspace/flowguard/.venv-ml/bin/python
OUT=/workspace/flowguard/study
export OMP_NUM_THREADS=1
while true; do
  dow=$(TZ=America/Chicago date +%u); hm=$(TZ=America/Chicago date +%H%M); today=$(TZ=America/New_York date +%F)
  if [ "$dow" -le 5 ] && [ "$hm" -ge 1520 ] && [ ! -f "$OUT/loss-model-daily-$today.json" ]; then
    echo "$(TZ=America/Chicago date '+%F %H:%M CT') scoring $today"
    nice -n 10 "$PY" "$REPO/scripts/study/loss-model-daily.py" score "$today" || echo "score $today failed"
  fi
  for k in 1 2 3 4 5 6 7; do
    d=$(TZ=America/New_York date -d "$today -$k day" +%F); wd=$(date -d "$d" +%u)
    if [ "$wd" -le 5 ] && [ ! -f "$OUT/loss-model-daily-$d.json" ] && [ ! -f "/tmp/loss-model-daily-miss-$d" ]; then
      echo "$(TZ=America/Chicago date '+%F %H:%M CT') backfill $d"
      nice -n 10 "$PY" "$REPO/scripts/study/loss-model-daily.py" score "$d" || touch "/tmp/loss-model-daily-miss-$d"
    fi
  done
  sleep 600
done
