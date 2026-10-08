"""Spread gate + gamma-flip gate backtest (study only, not financial advice).

Data (2y replay, /workspace/flowguard/history):
  datasets/entries.csv     logged lane entries (picks, premove, puts, lottery, setup lanes) + lane candidates
  datasets/candidates.csv  Picks/Premove candidate pools (bigger sample, no lane split)
  flow/<day>.json.gz       the alert behind each entry (NBBO bid/ask at the print)
  signals/gex/<T>.<day>.json  UW /greek-exposure/strike?date=day (per-strike call/put GEX) for entry ticker-days
Outcome: winner = option +40% before -25% within 3 sessions; loser = -25% first; flat = neither (scored at t3).
Return (per trade): gross = +40 / -25 / t3 (flat, clipped); net = buy at the ask, sell at the bid, assuming the
same relative spread s at exit: (1+gross)*(1-s/2)/(1+s/2) - 1, with the print price as mid.
"""
import csv, gzip, json, os, sys, collections, statistics
from datetime import datetime, timezone

H = os.environ.get("HISTORY_DIR", "/workspace/flowguard/history")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/flowguard/study/spread-gamma-backtest.json"

def num(x):
    try:
        v = float(x)
        return v if v == v else None
    except Exception:
        return None

# ---- alert NBBO per (day, contract, created_at)
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

def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()

def alert_at(day, contract, print_utc):
    rows = flow_idx(day).get(contract)
    if not rows: return None
    t0 = ts(print_utc)
    best = min(rows, key=lambda r: abs(ts(r[0]) - t0))
    return best if abs(ts(best[0]) - t0) <= 120 else None

def spread_at(day, contract, print_utc):
    best = alert_at(day, contract, print_utc)
    if not best: return None
    _, bid, ask, _ = best
    if not bid or not ask or ask <= 0 or bid <= 0 or ask < bid: return None
    mid = (bid + ask) / 2
    return (ask - bid) / mid

# ---- GEX per (ticker, day)
_gex = {}
def gex(ticker, day):
    k = (ticker, day)
    if k in _gex: return _gex[k]
    p = f"{H}/signals/gex/{ticker.replace('/', '_')}.{day}.json"
    rows = None
    if os.path.exists(p):
        try:
            rows = [(num(r["strike"]), num(r["call_gex"]) or 0, num(r["put_gex"]) or 0) for r in json.load(open(p))]
            rows = sorted(r for r in rows if r[0])
        except Exception:
            rows = None
    _gex[k] = rows
    return rows

def flip_level(rows, spot):
    """Gamma flip ~ strike where cumulative net GEX (low -> high strikes) crosses zero; nearest crossing to spot."""
    cum, prev_s, prev_c, xs = 0.0, None, None, []
    for s, c, p in rows:
        cum += c + p
        if prev_c is not None and (prev_c < 0 <= cum or prev_c > 0 >= cum):
            # linear interpolation between strikes
            w = abs(prev_c) / (abs(prev_c) + abs(cum)) if (abs(prev_c) + abs(cum)) else 0
            xs.append(prev_s + w * (s - prev_s))
        prev_s, prev_c = s, cum
    if not xs: return None
    near = [x for x in xs if abs(x - spot) / spot <= 0.25] or xs
    return min(near, key=lambda x: abs(x - spot))

def gross_ret(r):
    o = r["outcome"]
    if o == "winner": return 0.40
    if o == "loser": return -0.25
    t = num(r.get("t3")) if r.get("t3") not in (None, "") else num(r.get("t1"))
    return max(-0.25, min(0.40, (t or 0) / 100))

def net_ret(g, s): return (1 + g) * (1 - s / 2) / (1 + s / 2) - 1

def tally(xs, with_net=True):
    c = collections.Counter(x["outcome"] for x in xs)
    w, l, f = c["winner"], c["loser"], c["flat"]
    out = {"n": len(xs), "W": w, "L": l, "F": f, "win_pct": round(100 * w / (w + l), 1) if w + l else None}
    if xs:
        out["avg_gross_pct"] = round(100 * statistics.mean(x["gross"] for x in xs), 1)
        if with_net and all(x.get("spread") is not None for x in xs):
            out["avg_net_pct"] = round(100 * statistics.mean(x["net"] for x in xs), 1)
            out["median_spread_pct"] = round(100 * statistics.median(x["spread"] for x in xs), 1)
    return out

def lane_group(lane):
    if lane in ("picks",): return "main picks"
    if lane == "premove": return "premove"
    if lane == "puts": return "puts"
    if lane == "lottery": return "lottery"
    if "earnings" in lane: return "earnings run-up/run-down lanes"
    return "setup lanes"

# ---- load
entries = []
for r in csv.DictReader(open(f"{H}/datasets/entries.csv")):
    if r["outcome"] not in ("winner", "loser", "flat") or r["kind"] != "logged": continue
    entries.append(r)
cands, seen = [], set()
for r in sorted(csv.DictReader(open(f"{H}/datasets/candidates.csv")), key=lambda r: (r["day"], r["contract"], r["printTimeUtc"])):
    if r["outcome"] not in ("winner", "loser", "flat"): continue
    k = (r["day"], r["contract"])
    if k in seen: continue
    seen.add(k); cands.append(r)

def enrich(r, lane):
    s = spread_at(r["day"], r["contract"], r["printTimeUtc"])
    g = gross_ret(r)
    x = {"day": r["day"], "lane": lane, "group": lane_group(lane), "ticker": r["ticker"], "side": r["side"], "outcome": r["outcome"],
         "gross": g, "spread": s, "net": net_ret(g, s) if s is not None else None, "underlying": num(r.get("underlying"))}
    if not x["underlying"]:
        a = alert_at(r["day"], r["contract"], r["printTimeUtc"])
        x["underlying"] = a[3] if a else None
    return x

E = [enrich(r, r["lane"]) for r in entries]
C = [enrich(r, r["list"]) for r in cands]
res = {"generated": datetime.now(timezone.utc).isoformat(), "window": "2024-10-07..2026-10-06 (replay)",
       "outcome_rule": "winner +40% before -25% within 3 sessions; loser -25% first; flat scored at t3",
       "return_rule": "net = buy at ask, sell at bid (same relative spread at exit), print price as mid",
       "notes": ["Earnings-calendar spread lane has no 2-year history (started live Oct 2026) — not scored.",
                 "Spread = alert NBBO at the print (UW flow alert bid/ask), matched within 2 min."]}

# ===== 1) spread gate
def spread_block(X, label):
    have = [x for x in X if x["spread"] is not None]
    blk = {"universe": label, "n_total": len(X), "n_with_spread": len(have), "baseline": tally(have), "cutoffs": {}}
    for cut in (0.05, 0.10, 0.15):
        fl = [x for x in have if x["spread"] > cut]; kp = [x for x in have if x["spread"] <= cut]
        blk["cutoffs"][f">{int(cut*100)}%"] = {"flagged": tally(fl), "kept": tally(kp), "flagged_share_pct": round(100 * len(fl) / max(1, len(have)), 1)}
    return blk
res["spread_gate"] = {"candidates_pool": spread_block(C, "Picks+Premove candidate pools (candidates.csv)"),
                      "logged_entries_all": spread_block(E, "All logged lane entries (entries.csv)"),
                      "by_lane": {g: spread_block([x for x in E if x["group"] == g], g) for g in sorted({x["group"] for x in E})}}

# ===== 2) gamma flip gate (entries + candidates where a GEX file exists for ticker-day)
def gamma_rows(X, src_rows):
    out = []
    for x, r in zip(X, src_rows):
        rows = gex(x["ticker"], x["day"])
        spot = x["underlying"]
        if not rows or not spot: continue
        net = sum(c + p for _, c, p in rows)
        fl = flip_level(rows, spot)
        y = dict(x)
        y["netNeg"] = net < 0
        y["flip"] = fl
        y["wrongSide"] = None if fl is None else ((x["side"] == "call" and spot < fl) or (x["side"] == "put" and spot > fl))
        out.append(y)
    return out

def gamma_block(G, label):
    hasflip = [g for g in G if g["wrongSide"] is not None]
    blk = {"universe": label, "n_with_gex": len(G), "n_with_flip": len(hasflip), "days_covered": len({g["day"] for g in G}),
           "first_day": min((g["day"] for g in G), default=None), "last_day": max((g["day"] for g in G), default=None),
           "baseline": tally(G, False)}
    blk["flip_gate"] = {"flagged (call below flip / put above flip)": tally([g for g in hasflip if g["wrongSide"]], False),
                        "kept": tally([g for g in hasflip if not g["wrongSide"]], False)}
    for side in ("call", "put"):
        hs = [g for g in hasflip if g["side"] == side]
        blk["flip_gate"][side] = {"flagged": tally([g for g in hs if g["wrongSide"]], False), "kept": tally([g for g in hs if not g["wrongSide"]], False)}
    blk["net_gex_negative"] = {"negative": tally([g for g in G if g["netNeg"]], False), "positive_or_flat": tally([g for g in G if not g["netNeg"]], False)}
    blk["flip_and_negative"] = {
        f"{'flagged' if w else 'kept'}+{'neg' if n else 'pos'}": tally([g for g in hasflip if g["wrongSide"] == w and g["netNeg"] == n], False)
        for w in (True, False) for n in (True, False)}
    return blk

GE = gamma_rows(E, entries)
GC = gamma_rows(C, cands)
res["gamma_flip_gate"] = {
    "data": "UW /api/stock/{T}/greek-exposure/strike?date=D per-strike GEX, cached for logged-entry ticker-days only (7.6k files). "
            "Daily (end-of-day) values for the entry day, so there is some same-day look-ahead vs an intraday entry.",
    "flip_method": "cumulative net (call+put) GEX from the lowest strike up; flip = zero crossing nearest spot (±25%).",
    "logged_entries": gamma_block(GE, "logged lane entries"),
    "candidates_pool": gamma_block(GC, "Picks+Premove candidates on ticker-days with GEX"),
    "by_lane": {g: gamma_block([x for x in GE if x["group"] == g], g) for g in sorted({x["group"] for x in GE})},
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(res, open(OUT, "w"), indent=1)
print("ok", OUT)

# ===== robustness: two-proportion z-score and year split for the main splits
import math
def z(a, b):
    na, nb = a["W"] + a["L"], b["W"] + b["L"]
    if not na or not nb: return None
    pa, pb = a["W"] / na, b["W"] / nb
    p = (a["W"] + b["W"]) / (na + nb)
    se = math.sqrt(p * (1 - p) * (1 / na + 1 / nb))
    return round((pb - pa) / se, 2) if se else None

def by_year(X, fn):
    out = {}
    for lab, cond in (("2024-10..2025-09", lambda d: d < "2025-10-01"), ("2025-10..2026-10", lambda d: d >= "2025-10-01")):
        sub = [x for x in X if cond(x["day"])]
        fl, kp = tally([x for x in sub if fn(x)], False), tally([x for x in sub if not fn(x)], False)
        out[lab] = {"flagged": fl, "kept": kp, "z_kept_minus_flagged": z(fl, kp)}
    return out

rob = {}
for name, X in (("candidates_pool", [x for x in C if x["spread"] is not None]), ("logged_entries", [x for x in E if x["spread"] is not None])):
    fn = lambda x: x["spread"] > 0.10
    fl, kp = tally([x for x in X if fn(x)], False), tally([x for x in X if not fn(x)], False)
    rob[f"spread>10% {name}"] = {"z_win_rate_kept_minus_flagged": z(fl, kp), "by_year": by_year(X, fn)}
for name, G in (("candidates_pool", GC), ("logged_entries", GE)):
    H2 = [g for g in G if g["wrongSide"] is not None]
    fn = lambda g: g["wrongSide"]
    fl, kp = tally([g for g in H2 if fn(g)], False), tally([g for g in H2 if not fn(g)], False)
    rob[f"gamma_flip {name}"] = {"z_win_rate_kept_minus_flagged": z(fl, kp), "by_year": by_year(H2, fn)}
res["robustness"] = rob
json.dump(res, open(OUT, "w"), indent=1)
print(json.dumps(rob, indent=1))

# ===== gate metrics (EV per trade at ask/bid, avg loss, % of setups dropped, % of winners kept)
def side_metrics(xs):
    xs_n = [x for x in xs if x.get("net") is not None]
    losers = [x["net"] for x in xs_n if x["outcome"] == "loser"]
    t = tally(xs, False)
    t["avg_ev_net_pct"] = round(100 * statistics.mean(x["net"] for x in xs_n), 1) if xs_n else None
    t["avg_loss_net_pct"] = round(100 * statistics.mean(losers), 1) if losers else None
    return t

def gate_metrics(X, fn):
    fl = [x for x in X if fn(x)]; kp = [x for x in X if not fn(x)]
    W = sum(1 for x in X if x["outcome"] == "winner")
    out = {"n": len(X), "flagged": side_metrics(fl), "kept": side_metrics(kp),
           "dropped_pct_of_setups": round(100 * len(fl) / max(1, len(X)), 1),
           "winners_kept_pct": round(100 * sum(1 for x in kp if x["outcome"] == "winner") / max(1, W), 1),
           "z_win_kept_minus_flagged": z(tally(fl, False), tally(kp, False))}
    out["meets_target (drop 20-30%, keep >80% winners, kept win% > flagged)"] = (
        20 <= out["dropped_pct_of_setups"] <= 30 and out["winners_kept_pct"] > 80
        and (out["kept"]["win_pct"] or 0) > (out["flagged"]["win_pct"] or 0))
    return out

gm = {"spread": {}, "gamma": {}}
for uname, X in (("candidates_pool", [x for x in C if x["spread"] is not None]), ("logged_entries", [x for x in E if x["spread"] is not None])):
    gm["spread"][uname] = {f">{int(c*100)}%": gate_metrics(X, lambda x, c=c: x["spread"] > c) for c in (0.05, 0.10, 0.15)}
gm["spread"]["by_lane_10pct"] = {g: gate_metrics([x for x in E if x["spread"] is not None and x["group"] == g], lambda x: x["spread"] > 0.10)
                                 for g in sorted({x["group"] for x in E})}
variants = {
    "A: calls below flip + puts above flip flagged": lambda g: (g["side"] == "call" and g["underlying"] < g["flip"]) or (g["side"] == "put" and g["underlying"] > g["flip"]),
    "B: calls above flip + puts below flip flagged": lambda g: (g["side"] == "call" and g["underlying"] > g["flip"]) or (g["side"] == "put" and g["underlying"] < g["flip"]),
}
side_variants = {
    "calls below flip flagged": ("call", lambda g: g["underlying"] < g["flip"]),
    "calls above flip flagged": ("call", lambda g: g["underlying"] > g["flip"]),
    "puts above flip flagged": ("put", lambda g: g["underlying"] > g["flip"]),
    "puts below flip flagged": ("put", lambda g: g["underlying"] < g["flip"]),
}
for uname, G in (("candidates_pool", GC), ("logged_entries", GE)):
    H2 = [g for g in G if g["flip"] is not None]
    blk = {k: gate_metrics(H2, fn) for k, fn in variants.items()}
    for k, (side, fn) in side_variants.items():
        blk[k] = gate_metrics([g for g in H2 if g["side"] == side], fn)
    blk["net GEX negative flagged"] = gate_metrics(G, lambda g: g["netNeg"])
    blk["net GEX positive flagged"] = gate_metrics(G, lambda g: not g["netNeg"])
    for k, fn in variants.items():
        blk[f"{k} — by year"] = by_year(H2, fn)
    gm["gamma"][uname] = blk
gm["gamma"]["by_lane_variant_A"] = {g: gate_metrics([x for x in GE if x["flip"] is not None and x["group"] == g], variants["A: calls below flip + puts above flip flagged"]) for g in sorted({x["group"] for x in GE})}
gm["gamma"]["by_lane_variant_B"] = {g: gate_metrics([x for x in GE if x["flip"] is not None and x["group"] == g], variants["B: calls above flip + puts below flip flagged"]) for g in sorted({x["group"] for x in GE})}
res["gate_metrics"] = gm
json.dump(res, open(OUT, "w"), indent=1)
print("metrics ok")
