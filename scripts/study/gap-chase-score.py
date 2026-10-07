"""Score the TEST gap-up chase checker against the study book (study only, not financial advice).

Usage: python3 scripts/study/gap-chase-score.py [YYYY-MM-DD ...]   (default: today, America/Chicago)
Reads  https://flowguard-zeta.vercel.app/api/shadow/gap-chase?day=D  (or study/gap-chase-D.json if saved)
       /workspace/flowguard/study/book-D.json  (outcome: winner / loser / flat / expired_flat)
Writes /workspace/flowguard/study/gap-chase-D.json (raw log + per-row outcome) and
       /workspace/flowguard/study/gap-chase-scores.json (cumulative flagged vs pass W/L/F).
"""
import json, os, sys, urllib.request, collections
from datetime import datetime
from zoneinfo import ZoneInfo

STUDY = os.environ.get("STUDY_DIR", "/workspace/flowguard/study")
SITE = os.environ.get("FLOWGUARD_URL", "https://flowguard-zeta.vercel.app")

def load_log(day):
    path = f"{STUDY}/gap-chase-{day}.json"
    try:
        with urllib.request.urlopen(f"{SITE}/api/shadow/gap-chase?day={day}", timeout=30) as r:
            doc = json.loads(r.read())
        if doc.get("rows"):
            return doc
    except Exception:
        pass
    if os.path.exists(path):
        return json.load(open(path)).get("log_doc") or json.load(open(path))
    return None

def bucket(outcome):
    if outcome == "winner": return "W"
    if outcome == "loser": return "L"
    if outcome in ("flat", "expired_flat"): return "F"
    return None

def score_day(day):
    doc = load_log(day)
    book_path = f"{STUDY}/book-{day}.json"
    if not doc or not os.path.exists(book_path):
        return None
    book = {r["option_chain"]: r for r in json.load(open(book_path)).get("rows", [])}
    rows = []
    for key, v in (doc.get("rows") or {}).items():
        if v.get("side") != "call":
            continue
        b = book.get(key)
        rows.append({
            "contract": key, "lists": v.get("lists"), "firstVerdict": v.get("firstVerdict"), "verdict": v.get("verdict"),
            "penalty": v.get("penalty"), "stockPctAtPrint": v.get("stockPctAtPrint"), "confirmation": v.get("confirmation"),
            "outcome": (b or {}).get("outcome"), "outcome_pct": (b or {}).get("outcome_pct"),
        })
    tally = {"flag": collections.Counter(), "pass": collections.Counter()}
    for r in rows:
        o = bucket(r["outcome"])
        if o and r["firstVerdict"] in tally:
            tally[r["firstVerdict"]][o] += 1
    out = {"day": day, "market": doc.get("market"), "rows": rows,
           "summary": {k: dict(v) for k, v in tally.items()}, "log_doc": doc}
    json.dump(out, open(f"{STUDY}/gap-chase-{day}.json", "w"), indent=1)
    return out

def main():
    days = sys.argv[1:] or [datetime.now(ZoneInfo("America/Chicago")).strftime("%Y-%m-%d")]
    cum_path = f"{STUDY}/gap-chase-scores.json"
    cum = json.load(open(cum_path)) if os.path.exists(cum_path) else {"days": {}}
    for d in days:
        res = score_day(d)
        if res:
            cum["days"][d] = {"gapDay": (res["market"] or {}).get("gapDay"), **res["summary"]}
            print(d, res["summary"])
        else:
            print(d, "no log or no book")
    tot = {"flag": collections.Counter(), "pass": collections.Counter()}
    for v in cum["days"].values():
        for k in ("flag", "pass"):
            tot[k].update(v.get(k, {}))
    cum["total"] = {k: dict(v) for k, v in tot.items()}
    json.dump(cum, open(cum_path, "w"), indent=1)
    print("total", cum["total"])

if __name__ == "__main__":
    main()
