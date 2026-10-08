"""GEX walls backtest (study only, not financial advice). No UW calls: reuses the cached per-strike GEX files.

Data (2y replay, /workspace/flowguard/history):
  datasets/entries.csv        logged lane entries (picks, premove, puts, lottery, setup lanes)
  datasets/candidates.csv     Picks/Premove candidate pools (deduped by day+contract)
  signals/gex/<T>.<day>.json  UW /greek-exposure/strike?date=day (per-strike call/put GEX), entry ticker-days only
  ohlc/<T>.<n>.json           daily underlying bars (through 2026-10-01) for the wall touch/reject study
  flow/<day>.json.gz          alert NBBO at the print (for ask/bid returns)

Walls (strikes within ±25% of spot):
  call wall = strike >= spot with the largest positive call GEX
  put wall  = strike <= spot with the largest |put GEX|
  support   = strike <= spot with the largest |net GEX| (call+put)
  share     = wall's GEX / total gross |GEX| (all strikes)
Needed move to target: Black-Scholes, IV solved from the entry price; underlying level where the option is worth
  +40% one session later (r = 4%, no dividends).
Outcome: winner = option +40% before -25% within 3 sessions; loser = -25% first; flat = neither (scored at t3).
GEX is the entry day's end-of-day snapshot -> some same-day look-ahead vs an intraday entry.
"""
import csv, gzip, json, math, os, random, statistics, sys, collections
from datetime import date, datetime, timezone

H = os.environ.get("HISTORY_DIR", "/workspace/flowguard/history")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/flowguard/study/gex-walls-backtest.json"
R = 0.04
YEAR_SPLIT = "2025-10-01"

def num(x):
    try:
        v = float(x)
        return v if v == v else None
    except Exception:
        return None

def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()

# ---------- alert NBBO / spot at print
_flow = {}
def flow_idx(day):
    if day in _flow: return _flow[day]
    idx = collections.defaultdict(list)
    p = f"{H}/flow/{day}.json.gz"
    if os.path.exists(p):
        d = json.load(gzip.open(p)); f = {n: i for i, n in enumerate(d["fields"])}
        for r in d["rows"]:
            idx[r[f["option_chain"]]].append((r[f["created_at"]], num(r[f["bid"]]), num(r[f["ask"]]), num(r[f["underlying_price"]])))
    if len(_flow) > 4: _flow.clear()
    _flow[day] = idx
    return idx

def alert_at(day, contract, print_utc):
    rows = flow_idx(day).get(contract)
    if not rows or not print_utc: return None
    t0 = ts(print_utc)
    best = min(rows, key=lambda r: abs(ts(r[0]) - t0))
    return best if abs(ts(best[0]) - t0) <= 120 else None

# ---------- GEX
def gex(ticker, day):
    p = f"{H}/signals/gex/{ticker.replace('/', '_')}.{day}.json"
    if not os.path.exists(p): return None
    try:
        rows = [(num(r["strike"]), num(r["call_gex"]) or 0.0, num(r["put_gex"]) or 0.0) for r in json.load(open(p))]
        return sorted(r for r in rows if r[0])
    except Exception:
        return None

def walls(rows, spot):
    gross = sum(abs(c) + abs(p) for _, c, p in rows) or 1.0
    cw = pw = sp = nw = None; cmax = pmax = smax = 0.0; nmin = 0.0
    for s, c, p in rows:
        if abs(s - spot) / spot > 0.25: continue
        if s >= spot and c > cmax: cmax, cw = c, s
        if s <= spot and abs(p) > pmax: pmax, pw = abs(p), s
        if s <= spot and abs(c + p) > smax: smax, sp = abs(c + p), s
        if c + p < nmin: nmin, nw = c + p, s
    return {
        "negWall": nw, "negWallPct": None if nw is None else (nw / spot - 1) * 100, "negWallShare": abs(nmin) / gross,
        "callWall": cw, "callWallPct": None if cw is None else (cw / spot - 1) * 100, "callWallShare": cmax / gross,
        "putWall": pw, "putWallPct": None if pw is None else (1 - pw / spot) * 100, "putWallShare": pmax / gross,
        "support": sp, "supportPct": None if sp is None else (1 - sp / spot) * 100, "supportShare": smax / gross,
        "netNeg": sum(c + p for _, c, p in rows) < 0,
    }

def gex_exp(ticker, day, expiry):
    p = f"{H}/signals/gex-exp/{ticker.replace('/', '_')}.{day}.{expiry}.json"
    if not os.path.exists(p): return None
    try:
        rows = [(num(r["strike"]), num(r["call_gex"]) or 0.0, num(r["put_gex"]) or 0.0) for r in json.load(open(p))]
        rows = sorted(r for r in rows if r[0])
        return rows or None
    except Exception:
        return None

def nearest_expiry(ticker, day):
    p = f"{H}/signals/gex-exp/{ticker.replace('/', '_')}.{day}.nearest.json"
    if not os.path.exists(p): return None
    try:
        return json.load(open(p)).get("expiry")
    except Exception:
        return None

# ---------- Black-Scholes
def ncdf(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))
def bs(S, K, T, v, call):
    if T <= 0 or v <= 0: return max(0.0, (S - K) if call else (K - S))
    d1 = (math.log(S / K) + (R + v * v / 2) * T) / (v * math.sqrt(T)); d2 = d1 - v * math.sqrt(T)
    return S * ncdf(d1) - K * math.exp(-R * T) * ncdf(d2) if call else K * math.exp(-R * T) * ncdf(-d2) - S * ncdf(-d1)
def implied_vol(price, S, K, T, call):
    lo, hi = 0.01, 5.0
    if bs(S, K, T, hi, call) < price or bs(S, K, T, lo, call) > price: return None
    for _ in range(60):
        mid = (lo + hi) / 2
        if bs(S, K, T, mid, call) > price: hi = mid
        else: lo = mid
    return (lo + hi) / 2
def target_spot(price, S, K, T, call, mult=1.4):
    v = implied_vol(price, S, K, T, call)
    if v is None: return None
    T1 = max(T - 1 / 252, 1 / 365); goal = price * mult
    lo, hi = (S, S * 2.0) if call else (S * 0.3, S)
    f = lambda x: bs(x, K, T1, v, call) - goal
    if call and f(hi) < 0: return None
    if not call and f(lo) < 0: return None
    for _ in range(60):
        mid = (lo + hi) / 2
        if call: lo, hi = (mid, hi) if f(mid) < 0 else (lo, mid)
        else: lo, hi = (lo, mid) if f(mid) < 0 else (mid, hi)
    return (lo + hi) / 2

def occ(contract):
    try:
        tail = contract[-15:]
        return {"expiry": "20" + tail[:2] + "-" + tail[2:4] + "-" + tail[4:6], "call": tail[6] == "C", "strike": int(tail[7:]) / 1000}
    except Exception:
        return None

# ---------- OHLC
_ohlc = {}
def bars(ticker):
    if ticker in _ohlc: return _ohlc[ticker]
    m = {}
    for i in range(4):
        p = f"{H}/ohlc/{ticker}.{i}.json"
        if os.path.exists(p):
            for b in json.load(open(p)): m[b["date"]] = b
    _ohlc[ticker] = sorted(m.values(), key=lambda b: b["date"])
    return _ohlc[ticker]
def window(ticker, day, n=4):
    bs_ = bars(ticker)
    idx = next((i for i, b in enumerate(bs_) if b["date"] >= day), None)
    if idx is None or bs_[idx]["date"] != day: return None
    w = bs_[idx: idx + n]
    return w if len(w) == n else None

# ---------- returns + tallies
def gross_ret(r):
    o = r["outcome"]
    if o == "winner": return 0.40
    if o == "loser": return -0.25
    t = num(r.get("t3")) if r.get("t3") not in (None, "") else num(r.get("t1"))
    return max(-0.25, min(0.40, (t or 0) / 100))
def net_ret(g, s): return (1 + g) * (1 - s / 2) / (1 + s / 2) - 1

def lane_group(lane):
    if lane == "picks": return "main picks"
    if lane in ("premove", "puts", "lottery"): return lane
    if "earnings" in lane: return "earnings run-up/run-down lanes"
    return "setup lanes"

def tally(xs):
    c = collections.Counter(x["outcome"] for x in xs)
    w, l, f = c["winner"], c["loser"], c["flat"]
    out = {"n": len(xs), "W": w, "L": l, "F": f, "win_pct": round(100 * w / (w + l), 1) if w + l else None}
    nets = [x["net"] for x in xs if x["net"] is not None]
    losses = [x["net"] for x in xs if x["net"] is not None and x["outcome"] == "loser"]
    out["avg_gross_pct"] = round(100 * statistics.mean(x["gross"] for x in xs), 1) if xs else None
    out["avg_ev_net_pct"] = round(100 * statistics.mean(nets), 1) if nets else None
    out["avg_loss_net_pct"] = round(100 * statistics.mean(losses), 1) if losses else None
    return out

def z(a, b):
    na, nb = a["W"] + a["L"], b["W"] + b["L"]
    if not na or not nb: return None
    p = (a["W"] + b["W"]) / (na + nb); se = math.sqrt(p * (1 - p) * (1 / na + 1 / nb))
    return round((b["W"] / nb - a["W"] / na) / se, 2) if se else None

def gate(X, fn, by_lane=True):
    fl = [x for x in X if fn(x)]; kp = [x for x in X if not fn(x)]
    W = sum(1 for x in X if x["outcome"] == "winner")
    tf, tk = tally(fl), tally(kp)
    out = {"n": len(X), "flagged": tf, "kept": tk,
           "dropped_pct_of_setups": round(100 * len(fl) / max(1, len(X)), 1),
           "winners_kept_pct": round(100 * sum(1 for x in kp if x["outcome"] == "winner") / max(1, W), 1),
           "z_win_kept_minus_flagged": z(tf, tk)}
    yrs = {}
    for lab, cond in (("2024-10..2025-09", lambda d: d < YEAR_SPLIT), ("2025-10..2026-10", lambda d: d >= YEAR_SPLIT)):
        sub = [x for x in X if cond(x["day"])]
        a, b = tally([x for x in sub if fn(x)]), tally([x for x in sub if not fn(x)])
        yrs[lab] = {"flagged": {k: a[k] for k in ("n", "win_pct", "avg_ev_net_pct")}, "kept": {k: b[k] for k in ("n", "win_pct", "avg_ev_net_pct")}, "z": z(a, b)}
    out["by_year"] = yrs
    zs = [v["z"] for v in yrs.values()]
    out["same_direction_both_years"] = all(v is not None for v in zs) and (all(v > 0 for v in zs) or all(v < 0 for v in zs))
    out["significant_both_years (|z|>=2, same sign)"] = out["same_direction_both_years"] and all(abs(v) >= 2 for v in zs)
    if by_lane:
        out["by_lane"] = {}
        for g in sorted({x["group"] for x in X}):
            sub = [x for x in X if x["group"] == g]
            a, b = tally([x for x in sub if fn(x)]), tally([x for x in sub if not fn(x)])
            out["by_lane"][g] = {"flagged": {k: a[k] for k in ("n", "win_pct", "avg_ev_net_pct", "avg_loss_net_pct")},
                                 "kept": {k: b[k] for k in ("n", "win_pct", "avg_ev_net_pct", "avg_loss_net_pct")},
                                 "dropped_pct": round(100 * a["n"] / max(1, len(sub)), 1), "z": z(a, b),
                                 "z_by_year": {lab: z(tally([x for x in sub if cond(x["day"]) and fn(x)]), tally([x for x in sub if cond(x["day"]) and not fn(x)]))
                                               for lab, cond in (("2024-10..2025-09", lambda d: d < YEAR_SPLIT), ("2025-10..2026-10", lambda d: d >= YEAR_SPLIT))}}
    return out

# ---------- load + enrich
def enrich(r, lane, spot_field):
    o = occ(r["contract"])
    if not o: return None
    rows = gex(r["ticker"], r["day"])
    if not rows: return None
    a = alert_at(r["day"], r["contract"], r.get("printTimeUtc"))
    spot = num(r.get(spot_field)) if spot_field else None
    if not spot and a: spot = a[3]
    if not spot: return None
    price = num(r.get("entry"))
    s = None
    if a and a[1] and a[2] and a[2] >= a[1] > 0: s = (a[2] - a[1]) / ((a[1] + a[2]) / 2)
    g = gross_ret(r)
    w = walls(rows, spot)
    dte = (date.fromisoformat(o["expiry"]) - date.fromisoformat(r["day"])).days
    tgt = target_spot(price, spot, o["strike"], max(dte, 0.5) / 365, o["call"]) if price and price > 0 else None
    ex = {}
    near_x = nearest_expiry(r["ticker"], r["day"])
    for tag, xp in (("near", near_x), ("own", o["expiry"])):
        rr = gex_exp(r["ticker"], r["day"], xp) if xp else None
        if rr:
            ex.update({f"{tag}_{k}": v for k, v in walls(rr, spot).items()})
            ex[f"{tag}_expiry"] = xp
    x = {**ex, "day": r["day"], "lane": lane, "group": lane_group(lane), "ticker": r["ticker"], "side": "call" if o["call"] else "put",
         "strike": o["strike"], "spot": spot, "outcome": r["outcome"], "gross": g, "spread": s, "net": net_ret(g, s) if s is not None else None,
         "targetSpot": tgt, "targetMovePct": None if tgt is None else (tgt / spot - 1) * 100, **w}
    return x

entries = [r for r in csv.DictReader(open(f"{H}/datasets/entries.csv")) if r["kind"] == "logged" and r["outcome"] in ("winner", "loser", "flat")]
cands, seen = [], set()
for r in sorted(csv.DictReader(open(f"{H}/datasets/candidates.csv")), key=lambda r: (r["day"], r["contract"], r["printTimeUtc"])):
    if r["outcome"] not in ("winner", "loser", "flat"): continue
    k = (r["day"], r["contract"])
    if k in seen: continue
    seen.add(k); cands.append(r)

E = [x for x in (enrich(r, r["lane"], None) for r in entries) if x]
C = [x for x in (enrich(r, r["list"], "underlying") for r in cands) if x]
print("enriched", len(E), len(C), file=sys.stderr)

# ---------- gates
def calls(X): return [x for x in X if x["side"] == "call"]
def puts(X): return [x for x in X if x["side"] == "put"]

def gates_for(X):
    cx = [x for x in calls(X) if x["callWall"] is not None]
    px = [x for x in puts(X) if x["putWall"] is not None]
    cxt = [x for x in cx if x["targetSpot"] is not None]
    pxt = [x for x in px if x["targetSpot"] is not None]
    g = {
        "a1 calls: strike beyond call wall": gate(cx, lambda x: x["strike"] > x["callWall"]),
        "a1 calls: strike inside call wall (reverse)": gate(cx, lambda x: x["strike"] <= x["callWall"], by_lane=False),
        "a2 calls: +40% target needs move beyond call wall": gate(cxt, lambda x: x["targetSpot"] > x["callWall"]),
        "a1 puts: strike beyond put wall": gate(px, lambda x: x["strike"] < x["putWall"]),
        "a2 puts: +40% target needs move beyond put wall": gate(pxt, lambda x: x["targetSpot"] < x["putWall"]),
        "b calls: call wall <1% above spot": gate(cx, lambda x: x["callWallPct"] < 1),
        "b calls: call wall <2% above spot": gate(cx, lambda x: x["callWallPct"] < 2),
        "b puts: put wall <1% below spot": gate(px, lambda x: x["putWallPct"] < 1),
        "b puts: put wall <2% below spot": gate(px, lambda x: x["putWallPct"] < 2),
        "b combined: own-side wall <1% (calls: call wall, puts: put wall)": gate(cx + px, lambda x: (x["callWallPct"] if x["side"] == "call" else x["putWallPct"]) < 1),
        "b combined: own-side wall <2%": gate(cx + px, lambda x: (x["callWallPct"] if x["side"] == "call" else x["putWallPct"]) < 2),
        "b+size calls: call wall <2% AND wall >=10% of gross GEX": gate(cx, lambda x: x["callWallPct"] < 2 and x["callWallShare"] >= 0.10),
        "b+size puts: put wall <2% AND wall >=10% of gross GEX": gate(px, lambda x: x["putWallPct"] < 2 and x["putWallShare"] >= 0.10),
        "support (puts): big net-GEX support <2% below spot": gate([x for x in puts(X) if x["support"] is not None], lambda x: x["supportPct"] < 2),
    }
    return g

def dist_summary(X):
    out = {}
    for side, key, sk in (("call", "callWallPct", "callWallShare"), ("put", "putWallPct", "putWallShare")):
        v = [x[key] for x in X if x["side"] == side and x[key] is not None]
        sh = [x[sk] for x in X if x["side"] == side and x[key] is not None]
        tm = [abs(x["targetMovePct"]) for x in X if x["side"] == side and x["targetMovePct"] is not None]
        if v:
            q = statistics.quantiles(v, n=4)
            out[side] = {"n": len(v), "wall_dist_pct_p25_med_p75": [round(q[0], 2), round(statistics.median(v), 2), round(q[2], 2)],
                         "wall_share_median_pct": round(100 * statistics.median(sh), 1),
                         "needed_move_to_target_median_pct": round(statistics.median(tm), 2) if tm else None}
    return out

# ---------- (c) wall as a profit target: touch vs close-through within the entry day + 3 sessions
def wall_touch(X, seed=7):
    rnd = random.Random(seed)
    res = {}
    for side in ("call", "put"):
        rows = []
        for x in X:
            if x["side"] != side: continue
            lvl = x["callWall"] if side == "call" else x["putWall"]
            if lvl is None or lvl == x["spot"]: continue
            w = window(x["ticker"], x["day"])
            if not w: continue
            rows.append((x, lvl, w))
        if not rows: continue
        dists = [abs(l / x["spot"] - 1) for x, l, _ in rows]
        def stats(level_of):
            reach = rej = 0; n = 0; wins_reach = []
            for i, (x, lvl, w) in enumerate(rows):
                L = level_of(i, x, lvl)
                if L is None: continue
                n += 1
                if side == "call":
                    reached = max(b["h"] for b in w) >= L; passed = max(b["c"] for b in w) > L
                else:
                    reached = min(b["l"] for b in w) <= L; passed = min(b["c"] for b in w) < L
                if reached:
                    reach += 1
                    if not passed: rej += 1
                    wins_reach.append(x)
            return {"n": n, "reached_pct": round(100 * reach / max(1, n), 1),
                    "reached_but_no_close_beyond_pct_of_reached": round(100 * rej / max(1, reach), 1),
                    "trade_outcomes_when_reached": tally(wins_reach)}
        wall = stats(lambda i, x, lvl: lvl)
        # Control: same-distance pseudo level drawn from the distance distribution (no wall there by construction).
        ctrl = stats(lambda i, x, lvl: x["spot"] * (1 + rnd.choice(dists)) if side == "call" else x["spot"] * (1 - rnd.choice(dists)))
        # Matched control: exact same distance on the opposite side is not comparable; use the wall distance shifted ±25%.
        res[side] = {"wall": wall, "control_random_level_same_distance_dist": ctrl,
                     "note": "Reached = daily high/low touched the wall from entry day through 3 more sessions; no close beyond = never closed past it in that window."}
        # By year
        res[side]["by_year"] = {}
        for lab, cond in (("2024-10..2025-09", lambda d: d < YEAR_SPLIT), ("2025-10..2026-10", lambda d: d >= YEAR_SPLIT)):
            idx = [i for i, (x, _, _) in enumerate(rows) if cond(x["day"])]
            sel = set(idx)
            a = stats(lambda i, x, lvl: lvl if i in sel else None)
            b = stats(lambda i, x, lvl: (x["spot"] * (1 + rnd.choice(dists)) if side == "call" else x["spot"] * (1 - rnd.choice(dists))) if i in sel else None)
            res[side]["by_year"][lab] = {"wall": {k: a[k] for k in ("n", "reached_pct", "reached_but_no_close_beyond_pct_of_reached")},
                                         "control": {k: b[k] for k in ("n", "reached_pct", "reached_but_no_close_beyond_pct_of_reached")}}
    return res

res = {
    "generated": datetime.now(timezone.utc).isoformat(),
    "window": "2024-10-07..2026-10-06 (replay)",
    "outcome_rule": "winner +40% before -25% within 3 sessions; loser -25% first; flat scored at t3",
    "return_rule": "avg_ev_net = buy at ask, sell at bid (alert NBBO spread at the print, same relative spread at exit), print price as mid",
    "wall_rules": {"call wall": "strike >= spot with the largest positive call GEX (±25% of spot)",
                   "put wall": "strike <= spot with the largest |put GEX| (±25%)",
                   "support": "strike <= spot with the largest |net GEX| (±25%)",
                   "share": "wall GEX / total gross |GEX| across all strikes",
                   "needed move": "Black-Scholes: IV from the entry price; spot where the option is +40% one session later (r=4%)"},
    "caveats": ["GEX = entry day's end-of-day per-strike snapshot (UW greek-exposure/strike?date=), so there is same-day look-ahead vs an intraday entry.",
                "Wall touch study uses daily bars (entry day + 3 sessions); OHLC history ends 2026-10-01.",
                "No new UW calls were made; only cached files."],
    "samples": {"logged_entries_with_gex": len(E), "candidates_with_gex": len(C)},
    "distributions": {"logged_entries": dist_summary(E), "candidates_pool": dist_summary(C)},
    "gates": {"logged_entries": gates_for(E), "candidates_pool": gates_for(C)},
    "wall_as_profit_target": {"logged_entries": wall_touch(E), "candidates_pool": wall_touch(C)},
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(res, open(OUT, "w"), indent=1)
print("ok", OUT, file=sys.stderr)

# ---------- confound check: does "own-side wall <2%" still matter within the same needed-move bucket?
def stratified(X):
    xs = [x for x in X if x["targetMovePct"] is not None and (x["callWallPct"] if x["side"] == "call" else x["putWallPct"]) is not None]
    mv = sorted(abs(x["targetMovePct"]) for x in xs)
    if len(mv) < 30: return None
    cuts = [mv[len(mv) // 3], mv[2 * len(mv) // 3]]
    out = {"needed_move_terciles_pct": [round(c, 2) for c in cuts]}
    for lab, lo, hi in (("small move", -1, cuts[0]), ("mid move", cuts[0], cuts[1]), ("big move", cuts[1], 1e9)):
        sub = [x for x in xs if lo < abs(x["targetMovePct"]) <= hi]
        near = lambda x: (x["callWallPct"] if x["side"] == "call" else x["putWallPct"]) < 2
        a, b = tally([x for x in sub if near(x)]), tally([x for x in sub if not near(x)])
        yz = {}
        for ylab, cond in (("2024-10..2025-09", lambda d: d < YEAR_SPLIT), ("2025-10..2026-10", lambda d: d >= YEAR_SPLIT)):
            s2 = [x for x in sub if cond(x["day"])]
            yz[ylab] = z(tally([x for x in s2 if near(x)]), tally([x for x in s2 if not near(x)]))
        out[lab] = {"wall<2%": {k: a[k] for k in ("n", "win_pct", "avg_ev_net_pct")}, "wall>=2%": {k: b[k] for k in ("n", "win_pct", "avg_ev_net_pct")},
                    "z_far_minus_near": z(a, b), "z_by_year": yz}
    return out

res["confound_check_own_wall_lt2_by_needed_move"] = {"logged_entries": stratified(E), "candidates_pool": stratified(C)}
json.dump(res, open(OUT, "w"), indent=1)
print(json.dumps(res["confound_check_own_wall_lt2_by_needed_move"], indent=1))

# =====================================================================================
# Per-expiry walls (nearest weekly / the pick's own expiry) vs all-expiries, and the "big red bar"
# =====================================================================================
def wk(src, key): return key if src == "all" else f"{src}_{key}"

def source_gates(X, src):
    cw, cp, pw, pp = wk(src, "callWall"), wk(src, "callWallPct"), wk(src, "putWall"), wk(src, "putWallPct")
    cx = [x for x in X if x["side"] == "call" and x.get(cw) is not None]
    px = [x for x in X if x["side"] == "put" and x.get(pw) is not None]
    own = lambda x: x[cp] if x["side"] == "call" else x[pp]
    return {
        "a1 calls: strike beyond call wall": gate(cx, lambda x: x["strike"] > x[cw]),
        "a2 calls: +40% target beyond call wall": gate([x for x in cx if x["targetSpot"] is not None], lambda x: x["targetSpot"] > x[cw]),
        "a1 puts: strike beyond put wall": gate(px, lambda x: x["strike"] < x[pw]),
        "a2 puts: +40% target beyond put wall": gate([x for x in px if x["targetSpot"] is not None], lambda x: x["targetSpot"] < x[pw]),
        "b calls: call wall <1%": gate(cx, lambda x: x[cp] < 1, by_lane=False),
        "b calls: call wall <2%": gate(cx, lambda x: x[cp] < 2),
        "b puts: put wall <1%": gate(px, lambda x: x[pp] < 1, by_lane=False),
        "b puts: put wall <2%": gate(px, lambda x: x[pp] < 2),
        "b combined: own-side wall <1%": gate(cx + px, lambda x: own(x) < 1, by_lane=False),
        "b combined: own-side wall <2%": gate(cx + px, lambda x: own(x) < 2),
    }

def touch(X, level_of, seed=11):
    """Reach / close-through for a level within entry day + 3 sessions, vs a random same-direction level drawn
    from the same distance distribution (control)."""
    rnd = random.Random(seed)
    rows = []
    for x in X:
        L = level_of(x)
        if L is None or L == x["spot"]: continue
        w = window(x["ticker"], x["day"])
        if w: rows.append((x, L, w))
    if not rows: return None
    dists = [abs(L / x["spot"] - 1) for x, L, _ in rows]
    def one(x, L, w):
        up = L > x["spot"]
        reached = (max(b["h"] for b in w) >= L) if up else (min(b["l"] for b in w) <= L)
        through = (max(b["c"] for b in w) > L) if up else (min(b["c"] for b in w) < L)
        return reached, through
    def agg(sel):
        out = {}
        for lab, lvl in (("level", lambda x, L: L), ("control", lambda x, L: x["spot"] * (1 + rnd.choice(dists)) if L > x["spot"] else x["spot"] * (1 - rnd.choice(dists)))):
            n = re = th = 0
            for x, L, w in sel:
                r_, t_ = one(x, lvl(x, L), w)
                n += 1; re += r_; th += (r_ and t_)
            out[lab] = {"n": n, "reached_pct": round(100 * re / max(1, n), 1), "closed_through_pct_of_reached": round(100 * th / max(1, re), 1)}
        return out
    res = agg(rows)
    res["median_distance_pct"] = round(100 * statistics.median(dists), 2)
    res["by_year"] = {lab: agg([r for r in rows if cond(r[0]["day"])]) for lab, cond in
                      (("2024-10..2025-09", lambda d: d < YEAR_SPLIT), ("2025-10..2026-10", lambda d: d >= YEAR_SPLIT))}
    return res

def expiry_block(X):
    # Same rows for every source (fair comparison): has all-expiries, nearest and own-expiry walls.
    S = [x for x in X if x.get("near_expiry") and x.get("own_expiry")]
    out = {"n_rows_with_all_three_sources": len(S),
           "nearest_equals_own_expiry_pct": round(100 * sum(1 for x in S if x["near_expiry"] == x["own_expiry"]) / max(1, len(S)), 1),
           "same_call_wall_as_all_expiries_pct": {src: round(100 * sum(1 for x in S if x.get(wk(src, "callWall")) == x["callWall"]) / max(1, len(S)), 1) for src in ("near", "own")},
           "gates": {src: source_gates(S, src) for src in ("all", "near", "own")},
           "wall_as_profit_target": {}, "big_red_bar": {}}
    for src in ("all", "near", "own"):
        out["wall_as_profit_target"][src] = {
            "call wall (calls)": touch([x for x in S if x["side"] == "call"], lambda x, s=src: x.get(wk(s, "callWall"))),
            "put wall (puts)": touch([x for x in S if x["side"] == "put"], lambda x, s=src: x.get(wk(s, "putWall"))),
        }
        nw, np_ = wk(src, "negWall"), wk(src, "negWallPct")
        # Magnet / acceleration: does price reach the biggest negative-GEX strike more than a random level at the
        # same distance (magnet), and close through it more once reached (acceleration)?
        blk = {"touch_all_rows": touch(S, lambda x, k=nw: x.get(k))}
        # Trade view: big red bar in the trade's direction (calls: above spot, puts: below) within 3% vs not.
        toward = lambda x, k=np_: x.get(k) is not None and ((x["side"] == "call" and 0 < x[k] <= 3) or (x["side"] == "put" and -3 <= x[k] < 0))
        blk["gate: red bar within 3% in the trade's direction (flagged) vs not"] = gate([x for x in S if x.get(np_) is not None], toward)
        against = lambda x, k=np_: x.get(k) is not None and ((x["side"] == "call" and -3 <= x[k] < 0) or (x["side"] == "put" and 0 < x[k] <= 3))
        blk["gate: red bar within 3% against the trade (flagged) vs not"] = gate([x for x in S if x.get(np_) is not None], against)
        out["big_red_bar"][src] = blk
    return out

res["per_expiry"] = {
    "method": "UW /api/stock/{T}/greek-exposure/strike-expiry?date=D&expiry=X (end-of-day per strike, per expiry). "
              "Nearest = first weekly Friday after the entry day (Thu if holiday, else next Friday, else the monthly). "
              "Own = the pick's expiry. Gates scored on the same rows for all three sources.",
    "logged_entries": expiry_block(E),
    "candidates_pool": expiry_block(C),
}
res["big_red_bar_all_expiries_full_sample"] = {"logged_entries": touch(E, lambda x: x.get("negWall")), "candidates_pool": touch(C, lambda x: x.get("negWall"))}
json.dump(res, open(OUT, "w"), indent=1)
print("per-expiry ok", file=sys.stderr)
