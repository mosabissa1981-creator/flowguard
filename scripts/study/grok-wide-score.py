#!/usr/bin/env python3
"""
TEST MODE study: grade the live Grok wide-pool take/pass verdicts (FLOWGUARD_GROK_WIDE=1). Reads each day's STORED wide doc
(GET /api/shadow?wide=1&day=YYYY-MM-DD: storage read only, never runs Grok or Unusual Whales). Grades are written by the
wide-pool tick itself with the LIVE exit rules on daily bars (+30% / -25% / 2 sessions, buy ask, sell at price x (1 - spread/2)).
Scored separately per tier ("pool" = cut by list caps, "near-miss" = score 45-54) so the wide pool never mixes with the
live finalists' lessons_review record. Never changes anything live.
Usage: grok-wide-score.py [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--out PATH]
"""
import argparse, json, os, urllib.error, urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
REPO = Path(__file__).resolve().parents[2]
SITE = os.environ.get("FLOWGUARD_SITE", "https://flowguard-zeta.vercel.app")

def fetch(day):
    try:
        with urllib.request.urlopen(urllib.request.Request(f"{SITE}/api/shadow?wide=1&day={day}", headers={"user-agent": "flowguard-study"}), timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise

def tally(rows):
    n = len(rows); w = sum(r["ret"] > 0 for r in rows)
    return {"n": n, "win_pct": round(100 * w / n, 1) if n else None, "avg_ret_pct": round(100 * sum(r["ret"] for r in rows) / n, 2) if n else None}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--since", default="2026-10-19"); ap.add_argument("--until", default=str(date.today()))
    ap.add_argument("--out", default=str(REPO / "study/grok-lessons/wide-live-score.json")); a = ap.parse_args()
    d = datetime.fromisoformat(a.since).date(); end = datetime.fromisoformat(a.until).date(); rows = []; days = {}; cost = 0.0
    while d <= end:
        if d.weekday() < 5:
            doc = fetch(str(d))
            if doc:
                cost += doc["llm"]["spendUsd"]; days[str(d)] = {"candidates": len(doc["candidates"]), "judged": len(doc["judgements"]), "uwGradeCalls": doc.get("uwGradeCalls", 0)}
                for c in doc["candidates"]:
                    j = doc["judgements"].get(c["contract"]); g = doc["grades"].get(c["contract"])
                    if j and g and g["status"] == "graded":
                        rows.append({"day": str(d), "contract": c["contract"], "tier": c["tier"], "judge": j["judge"], "ret": g["ret"], "how": g["how"]})
        d += timedelta(days=1)
    res = {"mode": "TEST MODE study only: Grok wide-pool verdicts, graded with live exit rules. Never affects live picks.",
           "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "window": [a.since, a.until], "grok_usd": round(cost, 4), "days": days,
           "graded": len(rows), "by_tier": {t: {"take": tally([r for r in rows if r["tier"] == t and r["judge"] == "take"]),
                                                  "pass": tally([r for r in rows if r["tier"] == t and r["judge"] == "pass"])} for t in ("pool", "near-miss")},
           "rows": rows}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True); json.dump(res, open(a.out, "w"), indent=1)
    print(json.dumps({k: res[k] for k in ("window", "grok_usd", "graded", "by_tier")}, indent=1))

if __name__ == "__main__":
    main()
