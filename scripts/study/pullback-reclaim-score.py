"""Quiet study-book scoring of the TEST-mode "Pullback reclaim" lane (stocks/ETFs). Study only, not financial advice.

Usage: python3 scripts/study/pullback-reclaim-score.py        (run once per trading day after the close, e.g. 4:30 PM CT)
Reads  https://flowguard-zeta.vercel.app/api/shadow/pullback-reclaim   (stored book; the Vercel cron computes it)
Writes /workspace/flowguard/study/pullback-reclaim-YYYY-MM-DD.json (snapshot) and pullback-reclaim-scores.json (latest).
No UW calls (Yahoo daily bars server-side). Log only: never affects live picks, never Telegram.

RE-CHECK RULE: after ~100 new resolved signals promote the lane ONLY if gain over baseline (signal EV - other-uptrend-day EV)
stays positive with the 95% CI above zero (per variant). Otherwise keep it test-only or drop it. Not an edge claim.
"""
import json, os, sys, urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo

STUDY = os.environ.get("STUDY_DIR", "/workspace/flowguard/study")
SITE = os.environ.get("FLOWGUARD_URL", "https://flowguard-zeta.vercel.app")

doc = json.loads(urllib.request.urlopen(f"{SITE}/api/shadow/pullback-reclaim", timeout=90).read())
day = datetime.now(ZoneInfo("America/Chicago")).strftime("%Y-%m-%d")
os.makedirs(STUDY, exist_ok=True)
json.dump(doc, open(f"{STUDY}/pullback-reclaim-{day}.json", "w"), indent=1)
summary = {"asOf": day, "through": doc.get("processedThrough"), "signalsLogged": doc.get("signalsLogged"),
           "signalsResolved": doc.get("signalsResolved"), "recheckDue": doc.get("recheckDue"),
           "variants": doc.get("variants"), "rule": doc.get("recheck")}
json.dump(summary, open(f"{STUDY}/pullback-reclaim-scores.json", "w"), indent=1)
print(f"pullback-reclaim through {summary['through']}: {summary['signalsLogged']} logged / {summary['signalsResolved']} resolved")
for k, v in (doc.get("variants") or {}).items():
    print(f"  {k}: n={v['signalN']} EV {v['signalEvPct']}% hit {v['hitPct']}% vs baseline {v['baselineEvPct']}% -> gain {v['gainOverBaselinePct']} CI {v['ci95']}")
if doc.get("recheckDue"):
    ok = all((v.get("gainOverBaselinePct") or 0) > 0 and v.get("ciAboveZero") for v in doc["variants"].values())
    print("RE-CHECK DUE (>=100 resolved signals). Promote only if gain > 0 with CI above zero:", "PASSES" if ok else "does NOT pass - keep test-only")
else:
    print(f"Re-check after ~100 resolved signals ({doc.get('signalsResolved')} so far); promote only if gain over baseline stays > 0 with CI above zero.")
