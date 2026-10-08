#!/usr/bin/env python3
"""
TEST MODE study, stage 2: exit-rule backtest on the 2-year replay (no live effect).
Paths: per-contract DAILY bars (history/contracts/<OCC>.json.gz: open/high/low/last + end-of-day NBBO). No intraday
option path exists, so within a session the order of high vs low is unknown -> CONSERVATIVE order: gap at the open
first, then the stop (low) before any target (high). Sessions = the sessions AFTER the entry day (same as the replay
outcome); the time stop exits at that session's end-of-day bid (proxy for the 2:30 PM CT time stop).
Fills: buy at the alert ask at the print; sell at bid = trigger level x (1 - spread/2) using that day's EOD NBBO
spread (else the alert spread); gaps through a level fill at the open x (1 - spread/2).
Fade exit: existing fade-watch proxy on the entry day (exit-rules-prep.py) -> sell at the warning's option price x (1 - s/2).
"""
import csv, gzip, json, math, os, sys, collections
import numpy as np
H = "/workspace/flowguard/history"; W = "/workspace/flowguard/study/exit-rules-work"
OUT = sys.argv[1] if len(sys.argv) > 1 else f"{W}/results.json"
SPLIT = "2025-10-01"
def num(x):
    try:
        v = float(x); return v if v == v else None
    except Exception: return None

rows = list(csv.DictReader(open(f"{W}/prep.csv")))
print(len(rows), "prep rows", flush=True)
_bars = {}
def bars(c):
    if c in _bars: return _bars[c]
    p = f"{H}/contracts/{c}.json.gz"; out = []
    if os.path.exists(p):
        try:
            for b in json.load(gzip.open(p)).get("chains", []):
                o, h, l, last = num(b.get("open_price")), num(b.get("high_price")), num(b.get("low_price")), num(b.get("last_price"))
                nb, na = num(b.get("nbbo_bid")), num(b.get("nbbo_ask"))
                if not last and not (nb and na): continue
                out.append({"date": b["date"], "o": o, "h": h, "l": l, "c": last, "nb": nb, "na": na})
        except Exception: out = []
    out.sort(key=lambda b: b["date"])
    if len(_bars) > 3000: _bars.clear()
    _bars[c] = out
    return out

def spread_of(b, s0):
    if b.get("nb") is not None and b.get("na") and b["na"] >= b["nb"] >= 0 and b["na"] > 0:
        return min(1.0, (b["na"] - b["nb"]) / ((b["na"] + b["nb"]) / 2))
    return s0

def simulate(entry, sess, s0, rule, fade=None, opt=False):
    """Returns (ret, hit, how). entry = ask paid. sess = list of bars after the entry day (already cut to the hold).
    opt=False (headline): conservative same-session order -> stop/low before target/high (and after a scale-out, a
    same-session low under breakeven is assumed to come after the scale). opt=True: best-case order (high first),
    reported only as a bound on how much the unknown intraday order matters."""
    tgt = rule.get("target"); stop = rule.get("stop", -0.25)
    scale = rule.get("scale"); trail = rule.get("trail")
    if fade is not None and rule.get("fade"):
        return fade / entry - 1, False, "fade"
    pos, cash = 1.0, 0.0
    stop_lvl = entry * (1 + stop)
    peak = entry; hit = False; scaled = False; trail_lvl = None
    rest_tgt = entry * (1 + scale["rest_target"]) if (scale and scale.get("rest_target")) else None
    for i, b in enumerate(sess):
        s = spread_of(b, s0); f = 1 - s / 2
        o = b["o"] or b["c"]; c = b["c"] or o
        if not (o or b["h"] or b["l"]):  # no trades that session: mark at the NBBO mid
            if b.get("nb") is None or not b.get("na"): continue
            o = c = (b["nb"] + b["na"]) / 2; b = {**b, "h": o, "l": o}
        h = max(x for x in (b["h"], o, c) if x); l = min(x for x in (b["l"], o, c) if x)
        cur_stop = stop_lvl if trail_lvl is None else max(stop_lvl, trail_lvl)
        # 1) gap at the open (known order)
        if o <= cur_stop: cash += pos * o * f; return cash / entry - 1, hit, "stop_gap"
        if tgt and not scale and o >= entry * (1 + tgt): cash += pos * o * f; return cash / entry - 1, True, "target_gap"
        def stop_out():
            return (cash + pos * cur_stop * f) / entry - 1, hit, ("trail" if (trail_lvl and trail_lvl >= stop_lvl) else "stop")
        # 2) conservative: stop before any upside in the same session
        if not opt and l <= cur_stop: return stop_out()
        # 3) upside
        if scale:
            lvl = entry * (1 + scale["at"])
            if not scaled and h >= lvl:
                px = max(lvl, o); cash += scale["frac"] * px * f; pos -= scale["frac"]; scaled = True; hit = True
                stop_lvl = max(stop_lvl, entry)  # breakeven on the rest
                if not opt and l < entry:
                    cash += pos * entry * f; return cash / entry - 1, hit, "scale_then_be"
            if scaled and rest_tgt and h >= rest_tgt:
                cash += pos * rest_tgt * f; return cash / entry - 1, hit, "scale_then_target"
            if scaled and scale.get("rest_trail"):
                peak = max(peak, h); trail_lvl = peak - scale["rest_trail"] * entry
                if c <= trail_lvl: cash += pos * (b["nb"] if b.get("nb") else c * f); return cash / entry - 1, hit, "scale_then_trail_close"
        elif tgt:
            if h >= entry * (1 + tgt): cash += pos * entry * (1 + tgt) * f; return cash / entry - 1, True, "target"
        if trail:
            peak = max(peak, h)
            if peak >= entry * (1 + trail["activate"]):
                hit = True; trail_lvl = peak - trail["giveback"] * entry
                if c <= trail_lvl: cash += pos * (b["nb"] if b.get("nb") else c * f); return cash / entry - 1, hit, "trail_close"
        if opt and l <= cur_stop: return stop_out()
    if not sess: return None, False, "no_data"
    b = sess[-1]; s = spread_of(b, s0)
    px = b["nb"] if (b.get("nb") and b["nb"] > 0) else (b["c"] or 0) * (1 - s / 2)
    cash += pos * px
    return cash / entry - 1, hit, "time"

BASE = {"target": 0.40, "stop": -0.25, "hold": 3}
RULES = {
    "base_T40_S25_H3": BASE,
    "a_T15": {**BASE, "target": 0.15}, "a_T20": {**BASE, "target": 0.20}, "a_T25": {**BASE, "target": 0.25}, "a_T30": {**BASE, "target": 0.30},
    "b_half_at20_BE_rest_T40": {**BASE, "target": None, "scale": {"frac": 0.5, "at": 0.20, "rest_target": 0.40}},
    "b_half_at20_BE_rest_trail10": {**BASE, "target": None, "scale": {"frac": 0.5, "at": 0.20, "rest_trail": 0.10}},
    "b_half_at20_BE_rest_trail15": {**BASE, "target": None, "scale": {"frac": 0.5, "at": 0.20, "rest_trail": 0.15}},
    "c_trail_after15_give10": {**BASE, "target": None, "trail": {"activate": 0.15, "giveback": 0.10}},
    "c_trail_after15_give15": {**BASE, "target": None, "trail": {"activate": 0.15, "giveback": 0.15}},
    "d_S15": {**BASE, "stop": -0.15}, "d_S20": {**BASE, "stop": -0.20}, "d_S30": {**BASE, "stop": -0.30},
    "e_H1": {**BASE, "hold": 1}, "e_H2": {**BASE, "hold": 2}, "e_H5": {**BASE, "hold": 5},
    "f_fade_exit_else_base": {**BASE, "fade": True},
    # combos of the levers above (added after the single-lever pass)
    "combo_T25_S30": {**BASE, "target": 0.25, "stop": -0.30},
    "combo_T30_S30": {**BASE, "target": 0.30, "stop": -0.30},
    "combo_T25_S25_H5": {**BASE, "target": 0.25, "hold": 5},
    "combo_T20_S30": {**BASE, "target": 0.20, "stop": -0.30},
    "combo_half20_rest_T40_S30": {**BASE, "target": None, "stop": -0.30, "scale": {"frac": 0.5, "at": 0.20, "rest_target": 0.40}},
}

trades = []  # per row per rule
nodata = collections.Counter()
for k, r in enumerate(rows):
    bs = bars(r["contract"])
    after = [b for b in bs if b["date"] > r["day"]]
    day0 = [b for b in bs if b["date"] == r["day"]]
    a_bid, a_ask, ep = num(r["alert_bid"]), num(r["alert_ask"]), num(r["entry_print"])
    if a_ask and a_bid is not None and a_ask >= a_bid and a_ask > 0:
        s0 = (a_ask - a_bid) / ((a_ask + a_bid) / 2); entry = a_ask
    elif ep:
        s0 = 0.05; entry = ep * (1 + s0 / 2)
    else:
        nodata["no_entry"] += 1; continue
    if entry <= 0 or s0 > 1.5: nodata["bad_entry"] += 1; continue
    expired = bool(after) and after[-1]["date"] >= r["expiry"]
    fade = None
    if r["fade_warn"] == "1":
        fp = num(r["fade_price"]) or (day0[0]["c"] if day0 else None)
        if fp: fade = fp * (1 - s0 / 2)
    rec = {"day": r["day"], "uni": r["uni"], "lane": r["lane"], "contract": r["contract"], "side": r["side"], "shown": r["shown"],
           "is_etf": r["is_etf"], "s0": s0, "year": "y1" if r["day"] < SPLIT else "y2", "fade_warn": r["fade_warn"] == "1"}
    for name, rule in RULES.items():
        hold = rule["hold"]
        sess = after[:hold]
        if not sess or (len(sess) < hold and not expired):
            rec[name] = None; continue  # no path, or too recent to have the full hold
        ret, hit, how = simulate(entry, sess, s0, rule, fade)
        rec[name] = None if ret is None else (round(ret, 5), int(hit), how)
        ro, ho, wo = simulate(entry, sess, s0, rule, fade, opt=True)
        rec[name + "@opt"] = None if ro is None else (round(ro, 5), int(ho), wo)
    rec["orig"] = r["orig_outcome"]
    trades.append(rec)
    if k % 5000 == 0: print(k, flush=True)
print("simulated", len(trades), dict(nodata), flush=True)
# sanity: base rule (ask/bid fills) vs the replay's own outcome label (print price, trade highs/lows)
agree = collections.Counter((x["orig"], x["base_T40_S25_H3"][2] if x.get("base_T40_S25_H3") else None) for x in trades if x["orig"] in ("winner", "loser", "flat"))
print("orig vs base exit:", agree.most_common(12), flush=True)
json.dump({"rules": RULES, "trades": trades}, gzip.open(f"{W}/trades.json.gz", "wt"))

# ---------- aggregate
def agg(xs):
    xs = [x for x in xs if x is not None]
    if not xs: return {"n": 0}
    r = np.array([x[0] for x in xs]); h = np.array([x[1] for x in xs])
    return {"n": len(xs), "win_any_profit_pct": round(100 * (r > 0).mean(), 1), "hit_target_pct": round(100 * h.mean(), 1),
            "avg_ret_pct": round(100 * r.mean(), 2), "median_ret_pct": round(100 * float(np.median(r)), 2),
            "avg_loss_pct": round(100 * r[r < 0].mean(), 2) if (r < 0).any() else None,
            "worst5_pct": round(100 * float(np.percentile(r, 5)), 2),
            "exit_mix": dict(collections.Counter(x[2] for x in xs).most_common(6))}
def universes(t):
    out = {}
    pool = [x for x in t if x["uni"] == "pool"]
    out["full_pool"] = pool
    board = [x for x in pool if x["shown"] == "1"]
    out["board_all"] = board
    out["board_current_rules"] = [x for x in board if not (x["side"] == "put" and x["is_etf"] != "1") and x["s0"] <= 0.10]
    out["logged_lanes"] = [x for x in t if x["uni"] == "logged"]
    return out
U = universes(trades)
rng = np.random.RandomState(11)
def paired_ci(xs, name, base="base_T40_S25_H3", B=400):
    pairs = [(x["day"], x[name][0] - x[base][0]) for x in xs if x.get(name) and x.get(base)]
    if not pairs: return None
    days = sorted({d for d, _ in pairs}); by = collections.defaultdict(list)
    for d, v in pairs: by[d].append(v)
    arr = [np.array(by[d]) for d in days]; means = []
    for _ in range(B):
        pick = rng.randint(0, len(days), len(days)); v = np.concatenate([arr[i] for i in pick]); means.append(v.mean())
    m = np.mean([v for _, v in pairs])
    return {"avg_diff_vs_base_pts": round(100 * m, 2), "ci95": [round(100 * float(np.percentile(means, 2.5)), 2), round(100 * float(np.percentile(means, 97.5)), 2)], "n": len(pairs)}
res = {"definition": __doc__.strip(), "rules": RULES, "rows": {k: len(v) for k, v in U.items()}, "skipped": dict(nodata), "universes": {}}
for uname, xs in U.items():
    R = {}
    for name in RULES:
        e = {"all": agg([x.get(name) for x in xs])}
        for yr in ("y1", "y2"):
            ys = [x for x in xs if x["year"] == yr]
            e[yr] = agg([x.get(name) for x in ys])
            e[yr]["vs_base"] = paired_ci(ys, name) if name != "base_T40_S25_H3" else None
            ob = agg([x.get(name + "@opt") for x in ys])
            e[yr]["best_case_intraday_order"] = {k: ob.get(k) for k in ("n", "win_any_profit_pct", "hit_target_pct", "avg_ret_pct")}
            e[yr]["best_case_intraday_order"]["vs_base_best_case"] = paired_ci(ys, name + "@opt", base="base_T40_S25_H3@opt") if name != "base_T40_S25_H3" else None
        lanes = sorted({x["lane"] for x in xs})
        e["by_lane"] = {ln: {yr: agg([x.get(name) for x in xs if x["lane"] == ln and x["year"] == yr]) for yr in ("y1", "y2")} for ln in lanes}
        R[name] = e
    res["universes"][uname] = R
    print("aggregated", uname, flush=True)
json.dump(res, open(OUT, "w"), indent=1, default=float)
print("saved", OUT)
