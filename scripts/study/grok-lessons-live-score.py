#!/usr/bin/env python3
"""
TEST MODE study: grade the lessons_review shadow verdicts (Grok + lessons sheet, take/pass) against study-book outcomes.
Reads each day's STORED shadow doc from the site (GET /api/shadow?day=YYYY-MM-DD&full=1&readonly=1: storage read only, never
refreshes, no LLM and no Unusual Whales calls) and the box study book (book-YYYY-MM-DD.json). Book labels: EOD mark vs flow print
or skip-time mid, +/-15% = winner/loser, else flat (not the +30/-25 live plan). Never changes anything live.
Usage: grok-lessons-live-score.py [--since 2026-10-12] [--until YYYY-MM-DD] [--study-dir DIR] [--out PATH] [--offline]
  --offline: use only cached shadow docs (<study-dir>/grok-lessons-work/shadow-days/).
"""
import argparse, glob, json, os, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SITE = os.environ.get("FLOWGUARD_SITE", "https://flowguard-zeta.vercel.app")


def load_books(study, since, until):
    out = {}
    for f in sorted(glob.glob(f"{study}/book-????-??-??.json")):
        day = Path(f).stem[5:]
        if day < since or (until and day > until):
            continue
        try:
            out[day] = json.load(open(f))
        except Exception as e:  # a half-written book should not kill the run
            print(f"skip {f}: {e}", file=sys.stderr)
    return out


def shadow_doc(day, cache, offline, today):
    p = cache / f"{day}.json"
    # re-fetch the last few days (verdicts can still land the same afternoon); older cached days are final
    fresh = p.exists() and (offline or (today - datetime.fromisoformat(day).date()).days > 3)
    if fresh:
        return json.load(open(p))
    if offline:
        return None
    url = f"{SITE}/api/shadow?day={day}&full=1&readonly=1"
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "flowguard-study"}), timeout=30) as r:
                doc = json.load(r)
            cache.mkdir(parents=True, exist_ok=True)
            json.dump(doc, open(p, "w"))
            return doc
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None  # no shadow doc stored that day (e.g. risk-off sit-out)
            time.sleep(2 * (attempt + 1))
        except Exception:
            time.sleep(2 * (attempt + 1))
    return json.load(open(p)) if p.exists() else None


def grade(o):
    return {"winner": "W", "loser": "L", "expired_flat": "F", "flat": "F"}.get(o)


def tally(rows):
    w = sum(r["grade"] == "W" for r in rows); l = sum(r["grade"] == "L" for r in rows); f = sum(r["grade"] == "F" for r in rows)
    n = w + l + f; pcts = [r["outcome_pct"] for r in rows if r["outcome_pct"] is not None]
    return {"n": n, "W": w, "L": l, "F": f, "win_pct": round(100 * w / n, 1) if n else None,
            "avg_outcome_pct": round(sum(pcts) / len(pcts), 1) if pcts else None}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-10-12")
    ap.add_argument("--until", default=None)
    ap.add_argument("--study-dir", default="/workspace/flowguard/study")
    ap.add_argument("--out", default=str(REPO / "study/grok-lessons/live-score.json"))
    ap.add_argument("--offline", action="store_true")
    a = ap.parse_args()
    today = datetime.now().date()
    cache = Path(a.study_dir) / "grok-lessons-work/shadow-days"
    books = load_books(a.study_dir, a.since, a.until)
    rows, days = [], {}
    for day, b in books.items():
        doc = shadow_doc(day, cache, a.offline, today)
        notes = ((doc or {}).get("dayNotes") or {}).get("lessons_review") or {}
        book = {r.get("option_chain") or r.get("id"): r for r in b.get("rows", [])}
        days[day] = {"shadow_doc": doc is not None, "verdicts": len(notes)}
        for contract, v in notes.items():
            r = book.get(contract)
            g = grade(r.get("outcome")) if r else None
            rows.append({"day": day, "contract": contract, "ticker": (r or {}).get("ticker"), "side": (r or {}).get("type"),
                         "judge": v.get("judge"), "confidence": v.get("confidence"), "why": (v.get("why") or "")[:160],
                         "grade": g, "outcome_pct": (r or {}).get("outcome_pct") if g else None,
                         "study_only": (r or {}).get("study_only")})
    graded = [r for r in rows if r["grade"]]
    takes = [r for r in graded if r["judge"] == "take"]; passes = [r for r in graded if r["judge"] == "pass"]
    res = {
        "mode": "TEST MODE study only: lessons_review shadow verdicts graded on the study book. Never affects live picks.",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window": {"since": a.since, "until": a.until or max(books, default=None)},
        "label_rule": "study book: EOD mark vs flow print (or skip-time mid), +/-15% = winner/loser, else flat",
        "verdicts": len(rows), "graded": len(graded), "not_in_book": len(rows) - len(graded),
        "take": tally(takes), "pass": tally(passes),
        "passed_winners": [f"{r['day']} {r['contract']} {r['outcome_pct']:+.0f}%" for r in passes if r["grade"] == "W"],
        "take_rows": [f"{r['day']} {r['contract']} {r['grade']} {r['outcome_pct']:+.0f}%" for r in takes],
        "days": days, "rows": rows,
    }
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(res, open(a.out, "w"), indent=1)
    print(json.dumps({k: res[k] for k in ("window", "verdicts", "graded", "take", "pass", "passed_winners", "take_rows")}, indent=1))


if __name__ == "__main__":
    main()
