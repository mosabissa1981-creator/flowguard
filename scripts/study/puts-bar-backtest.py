"""Puts bar backtest (study only, not financial advice). No UW calls: replay datasets + cached flow/tide/ohlc.

Universe A (primary): logged main-board entries (lanes picks + premove) from datasets/entries.csv.
Universe B (robustness): Picks/Premove candidates that were SHOWN on the list (datasets/candidates.csv, shown=true).
Outcome: winner = option +40% before -25% within 3 sessions; loser = -25% first; flat = neither (scored at t3).
Return: net = buy at ask, sell at bid (alert NBBO spread at the print, same relative spread at exit), print price as mid.
Market context at the print (from cached files): market tide (tide/<day>.json, cumulative net call vs put premium,
bias = ratio <= -0.18 bearish like the site), SPY/QQQ price at the print (nearest earlier SPY/QQQ alert's
underlying_price in flow/<day>) vs prior close / day open (ohlc). VWAP is not in the cache; "below open" is the proxy.
Regime proxy (2y): SPY prior close below its 20-day average (downtrend). Live regime-days.json covers only 21 days.
"""
import csv, gzip, json, math, os, statistics, sys, collections, bisect
from datetime import datetime, timezone

H = os.environ.get("HISTORY_DIR", "/workspace/flowguard/history")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/flowguard/study/puts-bar-backtest.json"
YEAR_SPLIT = "2025-10-01"
ETF_FALLBACK = {"SPY", "QQQ", "IWM", "DIA", "SMH", "SOXX", "XLF", "XLE", "XLK", "XLV", "XLY", "XLI", "XLP", "XLU", "XLB", "XLC", "XLRE",
                "KRE", "XBI", "GLD", "SLV", "TLT", "HYG", "EEM", "FXI", "KWEB", "ARKK", "IBIT", "ETHA", "USO", "UNG", "GDX", "TQQQ", "SQQQ",
                "SOXL", "SOXS", "UVXY", "VXX", "EWZ", "IYR", "XOP", "XRT", "JETS", "BITO", "MSTU", "TSLL", "NVDL"}

def num(x):
    try:
        v = float(x); return v if v == v else None
    except Exception:
        return None
def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()

# ---------- ohlc
_ohlc = {}
def bars(t):
    if t in _ohlc: return _ohlc[t]
    m = {}
    for i in range(4):
        p = f"{H}/ohlc/{t}.{i}.json"
        if os.path.exists(p):
            for b in json.load(open(p)): m[b["date"]] = b
    _ohlc[t] = sorted(m.values(), key=lambda b: b["date"])
    return _ohlc[t]
def prior_close(t, day):
    b = bars(t); ds = [x["date"] for x in b]; i = bisect.bisect_left(ds, day)
    return b[i - 1]["c"] if i > 0 else None
def day_open(t, day):
    for x in bars(t):
        if x["date"] == day: return x["o"]
    return None
def spy_downtrend(day):
    b = bars("SPY"); ds = [x["date"] for x in b]; i = bisect.bisect_left(ds, day)
    if i < 21: return None
    closes = [x["c"] for x in b[i - 20:i]]
    return b[i - 1]["c"] < sum(closes) / 20

# ---------- tide
_tide = {}
def tide_bias(day, print_utc):
    if day not in _tide:
        p = f"{H}/tide/{day}.json"
        rows = []
        if os.path.exists(p):
            for r in json.load(open(p)):
                rows.append((ts(r["timestamp"]), num(r["net_call_premium"]) or 0, num(r["net_put_premium"]) or 0))
        _tide.clear(); _tide[day] = sorted(rows)
    rows = _tide[day]
    if not rows: return None
    t0 = ts(print_utc); k = bisect.bisect_right([r[0] for r in rows], t0) - 1
    if k < 0: return None
    _, c, p = rows[k]
    ratio = (c - p) / max(abs(c), abs(p), 1)
    return "bullish" if ratio >= 0.18 else "bearish" if ratio <= -0.18 else "neutral"

# ---------- flow (one pass per day)
def load_flow(day):
    p = f"{H}/flow/{day}.json.gz"
    if not os.path.exists(p): return None
    d = json.load(gzip.open(p)); f = {n: i for i, n in enumerate(d["fields"])}
    by_chain = collections.defaultdict(list); idx = {"SPY": [], "QQQ": []}
    for r in d["rows"]:
        tk = r[f["ticker"]]
        by_chain[r[f["option_chain"]]].append((r[f["created_at"]], num(r[f["bid"]]), num(r[f["ask"]]), num(r[f["underlying_price"]]), r[f["issue_type"]]))
        if tk in idx and num(r[f["underlying_price"]]): idx[tk].append((ts(r[f["created_at"]]), num(r[f["underlying_price"]])))
    for k in idx: idx[k].sort()
    return by_chain, idx

def at_print(series, t0):
    if not series: return None
    k = bisect.bisect_right([s[0] for s in series], t0) - 1
    return series[k][1] if k >= 0 and t0 - series[k][0] < 3600 else None

def gross_ret(o, t3, t1):
    if o == "winner": return 0.40
    if o == "loser": return -0.25
    t = num(t3) if t3 not in (None, "") else num(t1)
    return max(-0.25, min(0.40, (t or 0) / 100))
def net_ret(g, s): return (1 + g) * (1 - s / 2) / (1 + s / 2) - 1

# ---------- load rows
def truthy(v): return str(v).lower() in ("true", "1", "yes")
A = []
for r in csv.DictReader(open(f"{H}/datasets/entries.csv")):
    if r["kind"] != "logged" or r["lane"] not in ("picks", "premove") or r["outcome"] not in ("winner", "loser", "flat"): continue
    A.append({"u": "A", "day": r["day"], "lane": r["lane"], "contract": r["contract"], "ticker": r["ticker"], "side": r["side"],
              "print": r["printTimeUtc"], "outcome": r["outcome"], "t3": r["t3"], "t1": r["t1"], "score": num(r["f_score"]),
              "sweep": truthy(r["f_sweep"]), "volOi": num(r["f_volOi"]), "dte": num(r["f_dte"]), "tideRow": r["f_marketTide"] or None})
B, seen = [], set()
for r in sorted(csv.DictReader(open(f"{H}/datasets/candidates.csv")), key=lambda r: (r["day"], r["contract"], r["printTimeUtc"])):
    if not truthy(r["shown"]) or r["outcome"] not in ("winner", "loser", "flat"): continue
    k = (r["day"], r["list"], r["contract"])
    if k in seen: continue
    seen.add(k)
    B.append({"u": "B", "day": r["day"], "lane": r["list"], "contract": r["contract"], "ticker": r["ticker"], "side": r["side"],
              "print": r["printTimeUtc"], "outcome": r["outcome"], "t3": r["t3"], "t1": r["t1"], "score": num(r["rawScore"]) or num(r["score"]),
              "sweep": truthy(r["sweep"]), "volOi": num(r["volOi"]), "dte": num(r["dte"]), "tideRow": None, "underlyingRow": num(r["underlying"])})

rows_by_day = collections.defaultdict(list)
for x in A + B: rows_by_day[x["day"]].append(x)
for i, day in enumerate(sorted(rows_by_day)):
    fl = load_flow(day)
    pcs = {t: prior_close(t, day) for t in ("SPY", "QQQ")}; ops = {t: day_open(t, day) for t in ("SPY", "QQQ")}
    down = spy_downtrend(day)
    for x in rows_by_day[day]:
        t0 = ts(x["print"]) if x["print"] else None
        a = None
        if fl and t0:
            cand = fl[0].get(x["contract"]) or []
            if cand:
                best = min(cand, key=lambda r: abs(ts(r[0]) - t0))
                if abs(ts(best[0]) - t0) <= 120: a = best
        bid, ask = (a[1], a[2]) if a else (None, None)
        x["spread"] = (ask - bid) / ((ask + bid) / 2) if bid and ask and ask >= bid > 0 else None
        x["etf"] = (a[4] == "ETF") if a and a[4] else (x["ticker"] in ETF_FALLBACK)
        und = (a[3] if a else None) or x.get("underlyingRow")
        pc = prior_close(x["ticker"], day)
        x["stockPct"] = (und / pc - 1) * 100 if und and pc else None
        for t in ("SPY", "QQQ"):
            px = at_print(fl[1][t], t0) if fl and t0 else None
            x[f"{t}_vsPrev"] = None if px is None or not pcs[t] else (px / pcs[t] - 1) * 100
            x[f"{t}_vsOpen"] = None if px is None or not ops[t] else (px / ops[t] - 1) * 100
        x["tide"] = x["tideRow"] or (tide_bias(day, x["print"]) if x["print"] else None)
        x["spyDowntrend"] = down
        x["gross"] = gross_ret(x["outcome"], x["t3"], x["t1"])
        x["net"] = net_ret(x["gross"], x["spread"]) if x["spread"] is not None else None
    if i % 50 == 0: print(f"day {i} {day}", file=sys.stderr, flush=True)

# ---------- metrics
def tally(xs):
    c = collections.Counter(x["outcome"] for x in xs); w, l, f = c["winner"], c["loser"], c["flat"]
    nets = [x["net"] for x in xs if x["net"] is not None]; losses = [x["net"] for x in xs if x["net"] is not None and x["outcome"] == "loser"]
    return {"n": len(xs), "W": w, "L": l, "F": f, "win_pct": round(100 * w / (w + l), 1) if w + l else None,
            "avg_ev_net_pct": round(100 * statistics.mean(nets), 1) if nets else None,
            "avg_loss_net_pct": round(100 * statistics.mean(losses), 1) if losses else None}
def z(a, b):
    na, nb = a["W"] + a["L"], b["W"] + b["L"]
    if not na or not nb: return None
    p = (a["W"] + b["W"]) / (na + nb); se = math.sqrt(p * (1 - p) * (1 / na + 1 / nb))
    return round((a["W"] / na - b["W"] / nb) / se, 2) if se else None
YEARS = (("2024-10..2025-09", lambda d: d < YEAR_SPLIT), ("2025-10..2026-10", lambda d: d >= YEAR_SPLIT))

def board(rows, keep_put):
    """Main board with puts filtered by keep_put (calls untouched): win/EV and picks per day."""
    kept = [x for x in rows if x["side"] == "call" or keep_put(x)]
    days = len({x["day"] for x in rows}) or 1
    t = tally(kept)
    return {"win_pct": t["win_pct"], "avg_ev_net_pct": t["avg_ev_net_pct"], "picks_per_day": round(len(kept) / days, 2),
            "puts_per_day": round(sum(1 for x in kept if x["side"] == "put") / days, 2)}

def gate(rows, keep_put, defined=lambda x: True):
    P = [x for x in rows if x["side"] == "put" and defined(x)]
    ps, dr = [x for x in P if keep_put(x)], [x for x in P if not keep_put(x)]
    W = sum(1 for x in P if x["outcome"] == "winner")
    out = {"n_puts": len(P), "passed": tally(ps), "dropped": tally(dr),
           "put_setups_kept_pct": round(100 * len(ps) / max(1, len(P)), 1),
           "put_winners_kept_pct": round(100 * sum(1 for x in ps if x["outcome"] == "winner") / max(1, W), 1),
           "z_passed_minus_dropped": z(tally(ps), tally(dr))}
    out["by_year"] = {}
    for lab, cond in YEARS:
        sp = [x for x in ps if cond(x["day"])]; sd = [x for x in dr if cond(x["day"])]
        a, b = tally(sp), tally(sd)
        out["by_year"][lab] = {"passed": a, "dropped": b, "z": z(a, b),
                               "put_setups_kept_pct": round(100 * len(sp) / max(1, len(sp) + len(sd)), 1)}
    zs = [v["z"] for v in out["by_year"].values()]
    out["passed_better_both_years"] = all(v is not None and v > 0 for v in zs)
    out["significant_both_years (z>=2 each)"] = all(v is not None and v >= 2 for v in zs)
    out["ev_better_both_years"] = all((v["passed"]["avg_ev_net_pct"] or -999) > (v["dropped"]["avg_ev_net_pct"] or -999) for v in out["by_year"].values())
    out["board_effect"] = {"baseline (all puts)": board(rows, lambda x: True), "with gate": board(rows, lambda x: (not defined(x)) or keep_put(x))}
    out["board_effect_by_year"] = {lab: {"baseline": board([x for x in rows if cond(x["day"])], lambda x: True),
                                         "with gate": board([x for x in rows if cond(x["day"])], lambda x: (not defined(x)) or keep_put(x))} for lab, cond in YEARS}
    out["by_lane"] = {ln: {"passed": {k: v for k, v in tally([x for x in ps if x["lane"] == ln]).items() if k in ("n", "win_pct", "avg_ev_net_pct")},
                           "dropped": {k: v for k, v in tally([x for x in dr if x["lane"] == ln]).items() if k in ("n", "win_pct", "avg_ev_net_pct")}}
                      for ln in sorted({x["lane"] for x in P})}
    return out

def call_bar_fn(rows):
    """Gate 7 helper: per (day, lane) lowest call score on the board; fallback = lane median call score."""
    bar, med = {}, {}
    for ln in {x["lane"] for x in rows}:
        cs = [x["score"] for x in rows if x["lane"] == ln and x["side"] == "call" and x["score"] is not None]
        med[ln] = statistics.median(cs) if cs else 0
    for x in rows:
        if x["side"] == "call" and x["score"] is not None:
            k = (x["day"], x["lane"]); bar[k] = min(bar.get(k, 1e9), x["score"])
    return lambda x: bar.get((x["day"], x["lane"]), med.get(x["lane"], 0))

def first_put_only(rows):
    keep = set()
    by = collections.defaultdict(list)
    for x in rows:
        if x["side"] == "put": by[(x["day"], x["lane"])].append(x)
    for k, xs in by.items():
        xs.sort(key=lambda x: (-(x["score"] or 0), x["print"] or ""))
        keep.add(id(xs[0]))
    return lambda x: id(x) in keep

def first_put_board_wide(rows):
    """Cap 1 put per day across Picks + Premove combined (highest score, earliest print)."""
    keep, by = set(), collections.defaultdict(list)
    for x in rows:
        if x["side"] == "put": by[x["day"]].append(x)
    for k, xs in by.items():
        xs.sort(key=lambda x: (-(x["score"] or 0), x["print"] or ""))
        keep.add(id(xs[0]))
    return lambda x: id(x) in keep

def gates(rows):
    cb = call_bar_fn(rows)
    g = {}
    has_mkt = lambda x: x["tide"] is not None and x["SPY_vsPrev"] is not None and x["QQQ_vsPrev"] is not None
    g["1a tide bearish AND SPY & QQQ below prior close"] = gate(rows, lambda x: x["tide"] == "bearish" and x["SPY_vsPrev"] < 0 and x["QQQ_vsPrev"] < 0, has_mkt)
    g["1b tide bearish AND SPY & QQQ below prior close AND below open (VWAP proxy)"] = gate(
        rows, lambda x: x["tide"] == "bearish" and x["SPY_vsPrev"] < 0 and x["QQQ_vsPrev"] < 0 and (x["SPY_vsOpen"] or 0) < 0 and (x["QQQ_vsOpen"] or 0) < 0, has_mkt)
    g["1c tide bearish only"] = gate(rows, lambda x: x["tide"] == "bearish", lambda x: x["tide"] is not None)
    g["1d SPY & QQQ below prior close only"] = gate(rows, lambda x: x["SPY_vsPrev"] < 0 and x["QQQ_vsPrev"] < 0, lambda x: x["SPY_vsPrev"] is not None and x["QQQ_vsPrev"] is not None)
    g["2a index/ETF puts only (drop single-stock puts)"] = gate(rows, lambda x: x["etf"])
    g["2b single-stock puts only (drop ETF puts)"] = gate(rows, lambda x: not x["etf"])
    g["3 require sweep AND vol/OI > 2"] = gate(rows, lambda x: x["sweep"] and (x["volOi"] or 0) > 2)
    for cut in (1, 2, 3):
        g[f"4 drop if stock already down > {cut}% at print"] = gate(rows, lambda x, c=cut: x["stockPct"] > -c, lambda x: x["stockPct"] is not None)
    g["5 DTE 14-30 only"] = gate(rows, lambda x: x["dte"] is not None and 14 <= x["dte"] <= 30)
    g["6a SPY downtrend days only (prior close < 20-day avg; 2y regime proxy)"] = gate(rows, lambda x: x["spyDowntrend"], lambda x: x["spyDowntrend"] is not None)
    for X in (0, 5, 10, 15):
        g[f"7 put score >= that day's lowest board call score + {X}"] = gate(rows, lambda x, X=X: (x["score"] or 0) >= cb(x) + X, lambda x: x["score"] is not None)
    g["8a cap: max 1 put per day per list (Picks / Premove)"] = gate(rows, first_put_only(rows))
    g["8b cap: max 1 put per day across the whole main board"] = gate(rows, first_put_board_wide(rows))
    g["9 no puts at all"] = gate(rows, lambda x: False)
    return g

def side_summary(rows):
    out = {}
    for side in ("call", "put"):
        xs = [x for x in rows if x["side"] == side]
        out[side] = {"all": tally(xs), **{lab: tally([x for x in xs if cond(x["day"])]) for lab, cond in YEARS}}
    return out

# Live regime-days (21 study days) for reference only
regime_ref = None
try:
    rd = json.load(open("/workspace/fg-fix/study/regime-days.json"))["days"]
    lab = {d["day"]: d.get("label") for d in rd}
    sub = [x for x in A if x["day"] in lab and x["side"] == "put"]
    regime_ref = {"note": "Live regime labels exist only for 2026-09-04..2026-10-06 (21 days); too small to score.",
                  "puts_on_risky_or_report_days": tally([x for x in sub if lab[x["day"]] in ("risky", "report-day")]),
                  "puts_on_other_days": tally([x for x in sub if lab[x["day"]] not in ("risky", "report-day")])}
except Exception as e:
    regime_ref = {"error": str(e)}

res = {
    "generated": datetime.now(timezone.utc).isoformat(), "window": "2024-10-07..2026-10-06 (replay)",
    "outcome_rule": "winner +40% before -25% within 3 sessions; loser -25% first; flat scored at t3",
    "return_rule": "avg_ev_net = buy at ask, sell at bid (alert NBBO spread at the print, same relative spread at exit)",
    "caveats": ["Dropped puts are not replaced by the next candidate (board just gets shorter).",
                "VWAP is not cached; 'below open' is the proxy. Regime: SPY below its 20-day average is the 2-year proxy (live regime labels only cover 21 days).",
                "No UW calls were made."],
    "side_summary": {"A_logged_main_board": side_summary(A), "B_shown_candidates": side_summary(B)},
    "gates": {"A_logged_main_board": gates(A), "B_shown_candidates": gates(B)},
    "live_regime_reference": regime_ref,
}
json.dump(res, open(OUT, "w"), indent=1)
print("ok", OUT, file=sys.stderr)
