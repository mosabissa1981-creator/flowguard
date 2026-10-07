"""Gap-up chase rule backtest (study only, not financial advice).
Data: history/datasets/candidates.csv (replayed Picks/Premove candidate pools, 2024-10-07..2026-10-05)
      + history/ohlc/{T}.{0,1,2}.json daily bars.
Outcome (per backtest): winner = option +40% before -25% within 3 sessions; loser = -25% first; flat otherwise.
"""
import csv, json, os, glob, collections, sys
from datetime import datetime, timezone, timedelta

H = os.environ.get("HISTORY_DIR", "/workspace/flowguard/history")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/flowguard/study/gapchase"

# ---- daily bars
bars = {}
def load_bars(t):
    if t in bars: return bars[t]
    m = {}
    for f in glob.glob(f"{H}/ohlc/{t}.*.json"):
        try:
            for b in json.load(open(f)):
                m[b["date"]] = b
        except Exception:
            pass
    dates = sorted(m)
    bars[t] = (m, dates)
    return bars[t]

def prev_close(t, day):
    m, dates = load_bars(t)
    import bisect
    i = bisect.bisect_left(dates, day)
    if i == 0: return None
    return m[dates[i-1]]["c"]

def day_open(t, day):
    m, _ = load_bars(t)
    return m.get(day, {}).get("o")

def gap(t, day):
    pc, o = prev_close(t, day), day_open(t, day)
    if not pc or not o: return None
    return o / pc - 1

def et_minutes(iso):
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    # DST: second Sunday Mar .. first Sunday Nov (approx by US rules)
    y = dt.year
    def nth_sunday(month, n):
        d = datetime(y, month, 1, tzinfo=timezone.utc)
        d += timedelta(days=(6 - d.weekday()) % 7)
        return d + timedelta(weeks=n-1)
    dst = nth_sunday(3, 2) + timedelta(hours=7) <= dt < nth_sunday(11, 1) + timedelta(hours=6)
    et = dt - timedelta(hours=4 if dst else 5)
    return et.hour * 60 + et.minute

rows = list(csv.DictReader(open(f"{H}/datasets/candidates.csv")))
# Dedupe: first appearance of each (day, contract) across Picks/Premove pools (earliest print).
rows.sort(key=lambda r: (r["day"], r["contract"], r["printTimeUtc"]))
seen = {}
for r in rows:
    if r["outcome"] not in ("winner", "loser", "flat"): continue
    k = (r["day"], r["contract"])
    if k in seen:
        seen[k]["shown"] = seen[k]["shown"] or r["shown"] == "true"
        continue
    r = dict(r); r["shown"] = r["shown"] == "true"
    seen[k] = r
cands = list(seen.values())

def chips(r): return set(filter(None, r["chips"].split(";"))) | set(x.split(":")[0] for x in r["chips"].split(";") if x)

enriched = []
for r in cands:
    if r["side"] != "call": continue
    day = r["day"]
    spy, qqq = gap("SPY", day), gap("QQQ", day)
    mkt_gap = max([g for g in (spy, qqq) if g is not None], default=None)
    pc = prev_close(r["ticker"], day)
    und = float(r["underlying"] or 0)
    stock_pct = (und / pc - 1) if pc and und else None
    o = day_open(r["ticker"], day)
    cs = chips(r)
    mins = et_minutes(r["printTimeUtc"])
    second_ask = "chain-repeat" in cs            # 2nd ask-side print on the SAME contract
    ticker_building = "building" in cs           # >=2 ask-side prints on the ticker this session
    pullback = (o is not None and und and und <= o * 0.997)  # printed after giving back >=0.3% from the open
    enriched.append(dict(
        day=day, contract=r["contract"], ticker=r["ticker"], list=r["list"], shown=r["shown"],
        outcome=r["outcome"], score=float(r["score"] or 0), mins=mins,
        mkt_gap=mkt_gap, stock_pct=stock_pct, second_ask=second_ask, ticker_building=ticker_building, pullback=bool(pullback),
        maxGain=float(r["maxGainPct"] or 0), t1=r["t1"], t3=r["t3"],
    ))

def tally(rs):
    c = collections.Counter(x["outcome"] for x in rs)
    w, l, f = c["winner"], c["loser"], c["flat"]
    dec = w + l
    return dict(n=len(rs), W=w, L=l, F=f, win_pct=round(100 * w / dec, 1) if dec else None)

def morning(x): return 570 <= x["mins"] < 660   # 9:30-11:00 ET
def gap_day(x, th=0.003): return x["mkt_gap"] is not None and x["mkt_gap"] >= th
def up(x, th): return x["stock_pct"] is not None and x["stock_pct"] >= th

rules = {
  # Candidate rule (full): on a gap-up morning, a call needs a 2nd ask-side print or a pullback;
  # and any call whose stock is already up >=2% at the pick (gap-up day) is flagged.
  "A_gap_morning_unconfirmed": lambda x: gap_day(x) and morning(x) and not (x["second_ask"] or x["pullback"]),
  "B_gapday_stock_up_2pct": lambda x: gap_day(x) and up(x, 0.02),
  "B3_gapday_stock_up_3pct": lambda x: gap_day(x) and up(x, 0.03),
  "C_anyday_stock_up_3pct": lambda x: up(x, 0.03),
  "FULL_A_or_B": lambda x: (gap_day(x) and morning(x) and not (x["second_ask"] or x["pullback"])) or (gap_day(x) and up(x, 0.02)),
  "FULL_morning_only": lambda x: gap_day(x) and morning(x) and ((not (x["second_ask"] or x["pullback"])) or up(x, 0.02)),
  "A_loose_ticker_building_ok": lambda x: gap_day(x) and morning(x) and not (x["second_ask"] or x["ticker_building"] or x["pullback"]),
  "FULL_loose": lambda x: gap_day(x) and morning(x) and ((not (x["second_ask"] or x["ticker_building"] or x["pullback"])) or up(x, 0.02)),
  "FULL_3pct": lambda x: gap_day(x) and morning(x) and ((not (x["second_ask"] or x["pullback"])) or up(x, 0.03)),
  "GAP05_FULL": lambda x: gap_day(x, 0.005) and morning(x) and ((not (x["second_ask"] or x["pullback"])) or up(x, 0.02)),
}

def report(universe_name, U):
    out = {"universe": universe_name, "baseline": tally(U), "rules": {}}
    for name, fn in rules.items():
        flagged = [x for x in U if fn(x)]
        kept = [x for x in U if not fn(x)]
        tf, tk = tally(flagged), tally(kept)
        out["rules"][name] = dict(flagged=tf, kept=tk,
            losers_cut=tf["L"], winners_cut=tf["W"],
            losers_cut_pct=round(100*tf["L"]/max(1,out["baseline"]["L"]),1),
            winners_cut_pct=round(100*tf["W"]/max(1,out["baseline"]["W"]),1))
    return out

universes = {
  "all_calls": enriched,
  "shown_calls": [x for x in enriched if x["shown"]],
  "gap_day_calls": [x for x in enriched if gap_day(x)],
  "gap_day_morning_calls": [x for x in enriched if gap_day(x) and morning(x)],
  "gap_day_morning_shown": [x for x in enriched if gap_day(x) and morning(x) and x["shown"]],
}
res = {"generated": datetime.now(timezone.utc).isoformat(), "n_call_candidates": len(enriched),
       "gap_days": len({x["day"] for x in enriched if gap_day(x)}), "days": len({x["day"] for x in enriched}),
       "missing_prev_close": sum(1 for x in enriched if x["stock_pct"] is None),
       "reports": [report(k, v) for k, v in universes.items()]}

# stock_pct buckets on gap-day mornings
bk = collections.OrderedDict()
for lo, hi, lab in [(-9, 0, "<0%"), (0, .01, "0-1%"), (.01, .02, "1-2%"), (.02, .03, "2-3%"), (.03, .05, "3-5%"), (.05, 9, ">=5%")]:
    bk[lab] = tally([x for x in universes["gap_day_morning_calls"] if x["stock_pct"] is not None and lo <= x["stock_pct"] < hi])
res["gap_morning_by_stock_move"] = bk
bk2 = collections.OrderedDict()
for lab, fn in [("2nd ask print (same contract)", lambda x: x["second_ask"]), ("pullback only", lambda x: x["pullback"] and not x["second_ask"]), ("ticker building only", lambda x: x["ticker_building"] and not x["second_ask"] and not x["pullback"]), ("neither", lambda x: not x["second_ask"] and not x["pullback"])]:
    bk2[lab] = tally([x for x in universes["gap_day_morning_calls"] if fn(x)])
res["gap_morning_by_confirmation"] = bk2
nongap = [x for x in enriched if not gap_day(x) and morning(x)]
res["non_gap_morning_calls"] = tally(nongap)
json.dump(res, open(f"{OUT}/gap-chase-backtest.json", "w"), indent=1)
print(json.dumps(res, indent=1)[:12000])
