"""Gap-DOWN put chase rule backtest (mirror of the gap-up call chase) (study only, not financial advice).
Data: history/datasets/candidates.csv (replayed Picks/Premove candidate pools, 2024-10-07..2026-10-05)
      + history/ohlc/{T}.{0,1,2}.json daily bars.
Outcome (per backtest): winner = option +40% before -25% within 3 sessions; loser = -25% first; flat otherwise.
"""
import csv, json, os, glob, collections, sys
from datetime import datetime, timezone, timedelta

H = os.environ.get("HISTORY_DIR", "/workspace/flowguard/history")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/flowguard/study/gapchase"
OUT_NAME = "gap-down-put-backtest.json"

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
    if r["side"] != "put": continue
    day = r["day"]
    spy, qqq = gap("SPY", day), gap("QQQ", day)
    mkt_gap = min([g for g in (spy, qqq) if g is not None], default=None)   # most negative
    pc = prev_close(r["ticker"], day)
    und = float(r["underlying"] or 0)
    stock_pct = (und / pc - 1) if pc and und else None
    o = day_open(r["ticker"], day)
    cs = chips(r)
    mins = et_minutes(r["printTimeUtc"])
    second_ask = "chain-repeat" in cs
    ticker_building = "building" in cs
    bounce = (o is not None and und and und >= o * 1.003)   # printed after bouncing >=0.3% off the open
    enriched.append(dict(day=day, contract=r["contract"], ticker=r["ticker"], shown=r["shown"], outcome=r["outcome"], mins=mins,
        mkt_gap=mkt_gap, stock_pct=stock_pct, second_ask=second_ask, ticker_building=ticker_building, bounce=bool(bounce)))

def tally(rs):
    c = collections.Counter(x["outcome"] for x in rs)
    w, l, f = c["winner"], c["loser"], c["flat"]
    dec = w + l
    return dict(n=len(rs), W=w, L=l, F=f, win_pct=round(100 * w / dec, 1) if dec else None)

def morning(x): return 570 <= x["mins"] < 660
def gap_down(x, th=0.003): return x["mkt_gap"] is not None and x["mkt_gap"] <= -th
def down(x, th): return x["stock_pct"] is not None and x["stock_pct"] <= -th
def unconf(x): return not (x["second_ask"] or x["bounce"])

rules = {
  "A_gapdown_morning_unconfirmed": lambda x: gap_down(x) and morning(x) and unconf(x),
  "B_gapdown_stock_down_2pct": lambda x: gap_down(x) and down(x, 0.02),
  "B3_gapdown_stock_down_3pct": lambda x: gap_down(x) and down(x, 0.03),
  "C_anyday_stock_down_3pct": lambda x: down(x, 0.03),
  "FULL_A_or_B": lambda x: (gap_down(x) and morning(x) and unconf(x)) or (gap_down(x) and down(x, 0.02)),
  "FULL_morning_only": lambda x: gap_down(x) and morning(x) and (unconf(x) or down(x, 0.02)),
  "FULL_3pct": lambda x: gap_down(x) and morning(x) and (unconf(x) or down(x, 0.03)),
  "GAP05_FULL": lambda x: gap_down(x, 0.005) and morning(x) and (unconf(x) or down(x, 0.02)),
  # Chosen shadow flag: gap-down morning put on a stock already down 1-3% at the print ("sold the low" zone).
  # Puts on stocks down >=3% are NOT flagged: in the replay they won more, not less.
  "D_gapdown_morning_down_1to3": lambda x: gap_down(x) and morning(x) and x["stock_pct"] is not None and -0.03 < x["stock_pct"] <= -0.01,
  "D2_gapdown_morning_down_2to3": lambda x: gap_down(x) and morning(x) and x["stock_pct"] is not None and -0.03 < x["stock_pct"] <= -0.02,
}

def report(name, U):
    out = {"universe": name, "baseline": tally(U), "rules": {}}
    for rn, fn in rules.items():
        fl = [x for x in U if fn(x)]; kp = [x for x in U if not fn(x)]
        tf, tk = tally(fl), tally(kp)
        out["rules"][rn] = dict(flagged=tf, kept=tk, losers_cut_pct=round(100*tf["L"]/max(1,out["baseline"]["L"]),1), winners_cut_pct=round(100*tf["W"]/max(1,out["baseline"]["W"]),1))
    return out

universes = {
  "all_puts": enriched,
  "shown_puts": [x for x in enriched if x["shown"]],
  "gap_down_day_puts": [x for x in enriched if gap_down(x)],
  "gap_down_morning_puts": [x for x in enriched if gap_down(x) and morning(x)],
  "gap_down_morning_shown": [x for x in enriched if gap_down(x) and morning(x) and x["shown"]],
}
res = {"generated": datetime.now(timezone.utc).isoformat(), "n_put_candidates": len(enriched),
       "gap_down_days": len({x["day"] for x in enriched if gap_down(x)}), "days": len({x["day"] for x in enriched}),
       "missing_prev_close": sum(1 for x in enriched if x["stock_pct"] is None),
       "reports": [report(k, v) for k, v in universes.items()]}
bk = collections.OrderedDict()
for lo, hi, lab in [(0, 9, ">0%"), (-.01, 0, "0 to -1%"), (-.02, -.01, "-1 to -2%"), (-.03, -.02, "-2 to -3%"), (-.05, -.03, "-3 to -5%"), (-9, -.05, "<=-5%")]:
    bk[lab] = tally([x for x in universes["gap_down_morning_puts"] if x["stock_pct"] is not None and lo <= x["stock_pct"] < hi])
res["gap_down_morning_by_stock_move"] = bk
bk2 = collections.OrderedDict()
for lab, fn in [("2nd ask print", lambda x: x["second_ask"]), ("bounce only", lambda x: x["bounce"] and not x["second_ask"]), ("neither", lambda x: unconf(x))]:
    bk2[lab] = tally([x for x in universes["gap_down_morning_puts"] if fn(x)])
res["gap_down_morning_by_confirmation"] = bk2
res["non_gap_morning_puts"] = tally([x for x in enriched if not gap_down(x) and morning(x)])
json.dump(res, open(f"{OUT}/{OUT_NAME}", "w"), indent=1)
print(json.dumps(res, indent=1)[:12000])

# In-sample check: the 1-3% band was picked after looking at the buckets, so split by year.
half = {}
U = universes["gap_down_morning_puts"]
for lab, fn in [("2024-10..2025-09", lambda x: x["day"] < "2025-10-01"), ("2025-10..2026-10", lambda x: x["day"] >= "2025-10-01")]:
    sub = [x for x in U if fn(x)]
    f = rules["D_gapdown_morning_down_1to3"]
    half[lab] = {"flagged": tally([x for x in sub if f(x)]), "kept": tally([x for x in sub if not f(x)])}
res["D_rule_by_year"] = half
json.dump(res, open(f"{OUT}/{OUT_NAME}", "w"), indent=1)
print(json.dumps(half))
