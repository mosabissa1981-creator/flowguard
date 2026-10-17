#!/usr/bin/env python3
"""
TEST MODE study: weekly (Friday) refresh of the Grok lessons sheet's "weekly study-book" section.

Reads the box study book (book-YYYY-MM-DD.json) for the Mon-Fri week ending --week-end plus a running window since --since,
recomputes the patterns the sheet tracks, and regenerates:
  - study/grok-lessons/weekly-lessons.md        (the section text, for review)
  - study/grok-lessons/weekly-stats.json        (the numbers behind it)
  - lib/shadow/grok-lessons-weekly.ts           (the same text as a TS string; rides in the lessons_review prompt)
  - study/grok-lessons/live-score.json          (via grok-lessons-live-score.py: lessons_review take/pass graded on the book)
The site only uses this inside the TEST-MODE lessons_review shadow module (FLOWGUARD_LESSONS_TEST=1). Nothing live changes.
No Unusual Whales calls; the only network read is the stored shadow docs (readonly) used by the live scorer (skip with --offline).

Usage: grok-lessons-weekly.py [--week-end YYYY-MM-DD (default: latest Friday <= today)] [--since 2026-10-12]
                              [--study-dir /workspace/flowguard/study] [--offline] [--static]
  --static also rebuilds lib/shadow/grok-lessons.ts from study/grok-lessons/lessons-full.md + examples-full.txt.
Book labels: EOD mark vs flow print or skip-time mid, +/-15% = winner/loser, else flat (not the +30/-25 live plan).
"""
import argparse, glob, json, re, subprocess, sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

REPO = Path(__file__).resolve().parents[2]
CT = ZoneInfo("America/Chicago")
MAX_CHARS = 3500  # keep the prompt add-on small
MIN_N = 8         # smallest group we draw a lean from
MIN_GAP = 15.0    # win-rate points needed before we call it a lean


def latest_friday(d: date) -> date:
    return d - timedelta(days=(d.weekday() - 4) % 7)


def load_books(study, start, end):
    out = {}
    for f in sorted(glob.glob(f"{study}/book-????-??-??.json")):
        day = Path(f).stem[5:]
        if start <= day <= end:
            try:
                out[day] = json.load(open(f))
            except Exception as e:
                print(f"skip {f}: {e}", file=sys.stderr)
    return out


def pct(s):
    m = re.findall(r"([+-−]?\d+(?:\.\d+)?)%", str(s).replace("−", "-"))
    return [float(x) for x in m]


def index_move(book):
    """(gap_pct, from_open_pct) for QQQ (else SPY) from the book's marketMove, whatever format that day used."""
    mm = book.get("marketMove") or {}
    for t in ("QQQ", "SPY"):
        v = mm.get(t)
        if isinstance(v, dict):
            prev = v.get("prev") or v.get("yday_close"); o = v.get("open"); c = v.get("close")
            if v.get("gap_pct") is not None and v.get("from_open_pct") is not None:
                return float(v["gap_pct"]), float(v["from_open_pct"])
            if prev and o and c:
                return 100 * (o / prev - 1), 100 * (c / o - 1)
        elif isinstance(v, str):  # "open -0.87% → -0.33%" = gap at the open -> day change vs prior close
            p = pct(v)
            if len(p) >= 2:
                g, dd = p[0], p[1]
                return g, 100 * ((1 + dd / 100) / (1 + g / 100) - 1)
    return None


def day_type(book):
    m = index_move(book)
    if not m:
        return "unknown"
    g, fo = m
    if fo <= -0.3:
        return "sold-from-open"
    if g <= -0.3 and fo >= 0.3:
        return "gap-down-bounce"
    if fo >= 0.3:
        return "up-from-open"
    return "chop"


def print_time_ct(r, day):
    for k in ("created_at", "first_seen_at"):
        if r.get(k):
            try:
                return datetime.fromisoformat(r[k].replace("Z", "+00:00")).astimezone(CT)
            except ValueError:
                pass
    fs = r.get("first_seen")
    if isinstance(fs, str) and re.fullmatch(r"\d{4}", fs):
        return datetime.fromisoformat(f"{day}T{fs[:2]}:{fs[2:]}:00").replace(tzinfo=CT)
    at = (r.get("spread") or {}).get("at")
    if at:
        return datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone(CT)
    return None


GRADE = {"winner": "W", "loser": "L", "expired_flat": "F", "flat": "F"}


def rows_of(books):
    out = []
    for day, b in books.items():
        dt = day_type(b); ro = (b.get("riskOff") or {}).get("level") or "none"
        for r in b.get("rows", []):
            g = GRADE.get(r.get("outcome"))
            if not g:
                continue
            side = r.get("type"); t = print_time_ct(r, day)
            mins = t.hour * 60 + t.minute if t else None
            out.append({"day": day, "dayType": dt, "riskOff": ro, "side": side, "ticker": r.get("ticker"),
                        "kind": "single-put" if side == "put" and r.get("skip_rule") == "puts" else ("etf-put" if side == "put" else "call"),
                        "skip_rule": r.get("skip_rule"), "live": not r.get("study_only"), "grade": g,
                        "ret": r.get("outcome_pct"), "early": mins < 9 * 60 if t else None, "firstHour": mins < 10 * 60 if t else None,
                        "spread": (r.get("spread") or {}).get("pct")})
    return out


def T(rows):
    w = sum(r["grade"] == "W" for r in rows); l = sum(r["grade"] == "L" for r in rows); f = sum(r["grade"] == "F" for r in rows)
    n = w + l + f; rets = [r["ret"] for r in rows if r["ret"] is not None]
    return {"n": n, "W": w, "L": l, "F": f, "win": round(100 * w / n, 1) if n else None, "avg": round(sum(rets) / len(rets), 1) if rets else None}


def s(t):
    return f"{t['W']}W/{t['L']}L/{t['F']}F" + (f" ({t['win']:.0f}% win, avg {t['avg']:+.1f}%)" if t["n"] else "")


def lean(a, b):
    return a["n"] >= MIN_N and b["n"] >= MIN_N and a["win"] is not None and b["win"] is not None and a["win"] - b["win"] >= MIN_GAP


def stats(rows):
    by = lambda f: [r for r in rows if f(r)]
    st = {"all": T(rows), "days": {}}
    for d in sorted({r["day"] for r in rows}):
        rr = by(lambda r: r["day"] == d)
        st["days"][d] = {"dayType": rr[0]["dayType"], "riskOff": rr[0]["riskOff"], "puts": T([r for r in rr if r["side"] == "put"]), "calls": T([r for r in rr if r["side"] == "call"])}
    for dt in ("sold-from-open", "gap-down-bounce", "up-from-open", "chop", "unknown"):
        st[f"etfPuts|{dt}"] = T(by(lambda r: r["kind"] == "etf-put" and r["dayType"] == dt))
        st[f"allPuts|{dt}"] = T(by(lambda r: r["side"] == "put" and r["dayType"] == dt))
        st[f"calls|{dt}"] = T(by(lambda r: r["side"] == "call" and r["dayType"] == dt))
    st["riskOffHeld|sold-from-open"] = T(by(lambda r: r["skip_rule"] == "risk-off" and r["dayType"] == "sold-from-open"))
    st["riskOffHeld|other"] = T(by(lambda r: r["skip_rule"] == "risk-off" and r["dayType"] != "sold-from-open"))
    st["early"] = T(by(lambda r: r["early"] is True)); st["late"] = T(by(lambda r: r["early"] is False))
    # on sell-from-open days the useful cut was the first ~90 minutes (8:30-10:00 CT), not 9:00 CT
    st["early|down"] = T(by(lambda r: r["firstHour"] is True and r["side"] == "put" and r["dayType"] == "sold-from-open"))
    st["late|down"] = T(by(lambda r: r["firstHour"] is False and r["side"] == "put" and r["dayType"] == "sold-from-open"))
    st["spread<=2%"] = T(by(lambda r: r["spread"] is not None and r["spread"] <= 0.02))
    st["spread>2%"] = T(by(lambda r: r["spread"] is not None and r["spread"] > 0.02))
    st["singlePuts"] = T(by(lambda r: r["kind"] == "single-put"))
    return st


def lines_for(st, label):
    L = []
    d, b = st["etfPuts|sold-from-open"], st["etfPuts|gap-down-bounce"]
    ro = st["riskOffHeld|sold-from-open"]
    if d["n"] or b["n"]:
        txt = f"Index/ETF puts on days QQQ/SPY kept selling from the open: {s(d)}; on gap-downs that bounced: {s(b)}."
        if ro["n"]:
            txt += f" Risk-off held-back index puts on sold-from-open days: {s(ro)}."
        if lean(d, b):
            txt += " Lean: a morning index put needs the selloff to be holding (tide still bearish, SPY/QQQ below the open); same-day index puts are ONE bet, take at most one."
        L.append(txt)
    c, p = st["calls|gap-down-bounce"], st["allPuts|gap-down-bounce"]
    if c["n"] or p["n"]:
        txt = f"Gap-down that bounced: calls {s(c)} vs puts {s(p)}."
        if lean(c, p):
            txt += " Lean: on a gap-down that is bouncing, favor calls and pass on puts."
        L.append(txt)
    e, l = st["early"], st["late"]
    if e["n"] and l["n"]:
        txt = f"Prints before 9:00 CT: {s(e)}; 9:00 CT or later: {s(l)}."
        ed, ld = st["early|down"], st["late|down"]
        if ed["n"] and ld["n"]:
            txt += f" Puts on sold-from-open days, printed before 10:00 CT {s(ed)} vs 10:00 CT or later {s(ld)}."
        if lean(e, l):
            txt += " Lean: early ask-side prints over late ones."
        if lean(ed, ld):
            txt += " Lean: on a down day, puts printed after 10:00 CT are chases."
        L.append(txt)
    t2, w2 = st["spread<=2%"], st["spread>2%"]
    if t2["n"] and w2["n"]:
        txt = f"Spread <= 2%: {s(t2)}; spread > 2%: {s(w2)}."
        if lean(t2, w2):
            txt += " Lean: prefer the tightest spreads."
        L.append(txt)
    return [f"- {label}: {x}" for x in L]


def review_line(score):
    if not score or not score.get("graded"):
        return []
    t, p = score["take"], score["pass"]
    out = f"- This review's own record so far ({score['window']['since']} to {score['window']['until']}): takes {t['W']}W/{t['L']}L/{t['F']}F, passes {p['W']}W/{p['L']}L/{p['F']}F."
    if score.get("passed_winners"):
        out += f" Passed winners: {len(score['passed_winners'])} (e.g. " + ", ".join(x.split(' ')[1] for x in score["passed_winners"][:4]) + ")."
    return [out]


def render(week_start, week_end, since, wk, run, score):
    days = ", ".join(f"{d[5:]} {v['dayType']}{' / risk-off ' + v['riskOff'] if v['riskOff'] not in ('none', None) else ''}" for d, v in wk["days"].items())
    hdr = [f"## Weekly study-book refresh (auto, week of {week_start} to {week_end}; generated {datetime.now(CT):%Y-%m-%d %H:%M} CT)",
           "Study book labels (EOD mark vs print, +/-15%), small samples; tilts only, the 2-year sections above win any conflict.",
           f"- Days: {days or 'no study-book days'}. Week rows {s(wk['all'])}."]
    body = lines_for(wk, "Week")
    if since < week_start:
        body += lines_for(run, f"Since {since}")
    body += review_line(score)
    if not body:
        body = ["- Not enough graded rows this week to state any lean."]
    text = "\n".join(hdr + body) + "\n"
    if len(text) > MAX_CHARS:
        text = text[: MAX_CHARS - 20].rsplit("\n", 1)[0] + "\n- (trimmed)\n"
    return text


def ts_string(name, value):
    return f"export const {name} = {json.dumps(value)};\n"


def write_static():
    sheet = (REPO / "study/grok-lessons/lessons-full.md").read_text()
    ex = (REPO / "study/grok-lessons/examples-full.txt").read_text()
    head = ('/**\n * Grok "lessons" pack for the TEST-MODE lessons_review shadow module. Generated from study/grok-lessons/lessons-full.md and\n'
            ' * examples-full.txt (distilled from the 2-year replay, Oct 2024 - Oct 2026, plus live-week notes). Study notes, not financial advice.\n'
            ' * Regenerate: python3 scripts/study/grok-lessons-weekly.py --static (weekly section lives in grok-lessons-weekly.ts). Not used by live picks.\n */\n')
    (REPO / "lib/shadow/grok-lessons.ts").write_text(head + ts_string("GROK_LESSONS_SHEET", sheet) + "\n" + ts_string("GROK_LESSONS_EXAMPLES", ex))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--week-end", default=None)
    ap.add_argument("--since", default="2026-10-12")
    ap.add_argument("--study-dir", default="/workspace/flowguard/study")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--static", action="store_true")
    a = ap.parse_args()
    we = date.fromisoformat(a.week_end) if a.week_end else latest_friday(datetime.now(CT).date())
    ws = we - timedelta(days=4)
    wk_books = load_books(a.study_dir, ws.isoformat(), we.isoformat())
    run_books = load_books(a.study_dir, a.since, we.isoformat())
    if not wk_books:
        sys.exit(f"no study-book files for {ws}..{we} in {a.study_dir}; nothing regenerated")
    # lessons_review take/pass record (reuses the live scorer; storage-read only)
    score = None
    try:
        cmd = [sys.executable, str(REPO / "scripts/study/grok-lessons-live-score.py"), "--since", a.since, "--until", we.isoformat(), "--study-dir", a.study_dir]
        subprocess.run(cmd + (["--offline"] if a.offline else []), check=True, stdout=subprocess.DEVNULL)
        score = json.load(open(REPO / "study/grok-lessons/live-score.json"))
    except Exception as e:
        print(f"live score skipped: {e}", file=sys.stderr)
    wk, run = stats(rows_of(wk_books)), stats(rows_of(run_books))
    text = render(ws.isoformat(), we.isoformat(), a.since, wk, run, score)
    meta = {"weekStart": ws.isoformat(), "weekEnd": we.isoformat(), "since": a.since, "days": sorted(wk_books),
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    g = REPO / "study/grok-lessons"
    (g / "weekly-lessons.md").write_text(text)
    json.dump({"meta": meta, "week": wk, "since": run}, open(g / "weekly-stats.json", "w"), indent=1)
    (REPO / "lib/shadow/grok-lessons-weekly.ts").write_text(
        "/**\n * GENERATED by scripts/study/grok-lessons-weekly.py (Friday refresh). Do not edit by hand.\n"
        " * Weekly study-book section for the TEST-MODE lessons_review shadow module only (FLOWGUARD_LESSONS_TEST=1). Not used by live picks.\n */\n"
        + ts_string("GROK_LESSONS_WEEKLY", text) + "\nexport const GROK_LESSONS_WEEKLY_META = " + json.dumps(meta) + " as const;\n")
    if a.static:
        write_static()
    print(text)


if __name__ == "__main__":
    main()
