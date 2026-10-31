"""Save the TEST-mode GEX/DEX Grok lane day view (GEX Grok vs current Grok vs rules) into the study folder.
GET /api/shadow?gexdex=1&day=YYYY-MM-DD (storage read only: never runs Grok or Unusual Whales).
Usage: grok-gex-dex-save.py [YYYY-MM-DD ...]   (default: today, America/New_York)
Writes $STUDY_DIR/grok-gex-dex-<day>.json (default /workspace/flowguard/study). Re-run later in the week to pick up grades.
"""
import datetime as dt, json, os, sys, urllib.request, urllib.error
from zoneinfo import ZoneInfo

SITE = os.environ.get("FLOWGUARD_SITE", "https://flowguard-zeta.vercel.app")
OUT = os.environ.get("STUDY_DIR", "/workspace/flowguard/study")
days = sys.argv[1:] or [dt.datetime.now(ZoneInfo("America/New_York")).date().isoformat()]
for day in days:
    try:
        with urllib.request.urlopen(urllib.request.Request(f"{SITE}/api/shadow?gexdex=1&day={day}", headers={"user-agent": "flowguard-study"}), timeout=30) as r:
            doc = json.load(r)
    except urllib.error.HTTPError as e:
        print(f"{day}: HTTP {e.code} (no GEX/DEX Grok doc?)"); continue
    path = f"{OUT}/grok-gex-dex-{day}.json"
    json.dump(doc, open(path, "w"), indent=1)
    c = doc.get("compare", {})
    print(f"{day}: {c.get('rows', 0)} rows, agree {c.get('agree', 0)}; gexDexGrok {c.get('gexDexGrok')}; grok {c.get('grok')}; rules {c.get('rules')} -> {path}")
