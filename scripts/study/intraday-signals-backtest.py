"""Backtest: follow-through confirmation + early fade warning (study only, not financial advice).
Data: history/datasets/candidates.csv (scored Picks/Premove candidates, 2y replay), history/flow/<day>.json.gz
(session flow alerts), history/tide/<day>.json (market tide, cumulative net call/put premium, 5-min).
Outcome: winner = option +40% before -25% within 3 sessions; loser = -25% first; flat otherwise.
"""
import csv, gzip, json, os, sys, collections, bisect
from datetime import datetime

H = os.environ.get("HISTORY_DIR", "/workspace/flowguard/history")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/flowguard/study/intraday-signals-backtest.json"

def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
def num(x):
    try: return float(x)
    except Exception: return 0.0

rows = list(csv.DictReader(open(f"{H}/datasets/candidates.csv")))
rows.sort(key=lambda r: (r["day"], r["contract"], r["printTimeUtc"]))
cands, seen = [], set()
for r in rows:
    if r["outcome"] not in ("winner", "loser", "flat"): continue
    k = (r["day"], r["contract"])
    if k in seen: continue
    seen.add(k); cands.append(r)

flow_cache = {}
def day_flow(day):
    if day in flow_cache: return flow_cache[day]
    p = f"{H}/flow/{day}.json.gz"
    out = {"by_chain": collections.defaultdict(list), "by_ticker": collections.defaultdict(list)}
    if os.path.exists(p):
        d = json.load(gzip.open(p)); f = {n: i for i, n in enumerate(d["fields"])}
        for row in d["rows"]:
            a = {"t": ts(row[f["created_at"]]), "chain": row[f["option_chain"]], "ticker": row[f["ticker"]], "type": row[f["type"]],
                 "ask": num(row[f["total_ask_side_prem"]]), "bid": num(row[f["total_bid_side_prem"]]), "prem": num(row[f["total_premium"]]),
                 "price": num(row[f["price"]]), "sweep": bool(row[f["has_sweep"]])}
            out["by_chain"][a["chain"]].append(a); out["by_ticker"][a["ticker"]].append(a)
        for v in list(out["by_chain"].values()) + list(out["by_ticker"].values()): v.sort(key=lambda a: a["t"])
    if len(flow_cache) > 6: flow_cache.clear()
    flow_cache[day] = out
    return out

tide_cache = {}
def day_tide(day):
    if day in tide_cache: return tide_cache[day]
    p = f"{H}/tide/{day}.json"; pts = []
    if os.path.exists(p):
        for x in json.load(open(p)):
            pts.append((ts(x["timestamp"]), num(x["net_call_premium"]) - num(x["net_put_premium"])))
    pts.sort(); tide_cache.clear(); tide_cache[day] = pts
    return pts

def tide_delta(pts, t, window=1800):
    if not pts: return None
    i = bisect.bisect_right([p[0] for p in pts], t) - 1
    j = bisect.bisect_right([p[0] for p in pts], t - window) - 1
    if i < 0 or j < 0: return None
    return pts[i][1] - pts[j][1]

def ask_share(a):
    s = a["ask"] + a["bid"]
    return a["ask"] / s if s > 0 else 0

def tally(xs):
    c = collections.Counter(x["outcome"] for x in xs); w, l, f = c["winner"], c["loser"], c["flat"]
    return {"n": len(xs), "W": w, "L": l, "F": f, "win_pct": round(100 * w / (w + l), 1) if w + l else None,
            "loser_pct_of_all": round(100 * l / len(xs), 1) if xs else None}

res = {"generated": datetime.now().astimezone().isoformat(), "candidates": len(cands)}
ft = {N: {"contract": [], "ticker": [], "either": [], "none": []} for N in (15, 30, 60)}
fade_rows = []
for r in cands:
    day, chain, tick, side = r["day"], r["contract"], r["ticker"], r["side"]
    t0 = ts(r["printTimeUtc"]); entry = num(r["entry"])
    fl = day_flow(day)
    later_c = [a for a in fl["by_chain"].get(chain, []) if a["t"] > t0 + 1]
    later_t = [a for a in fl["by_ticker"].get(tick, []) if a["t"] > t0 + 1 and a["type"] == side and a["chain"] != chain]
    o = {"outcome": r["outcome"]}
    # --- follow-through confirmation
    for N in (15, 30, 60):
        cc = any(ask_share(a) >= 0.6 and a["t"] <= t0 + N * 60 for a in later_c)
        tc = any(ask_share(a) >= 0.6 and a["prem"] >= 25_000 and a["t"] <= t0 + N * 60 for a in later_t)
        if cc: ft[N]["contract"].append(o)
        if tc: ft[N]["ticker"].append(o)
        (ft[N]["either"] if (cc or tc) else ft[N]["none"]).append(o)
    # --- fade warning (same session, from print +5 min)
    pts = day_tide(day)
    cum_ask = cum_bid = 0.0; warn = None; sigs = set()
    events = sorted(later_c + later_t, key=lambda a: a["t"])
    for a in events:
        if a["t"] < t0 + 300: 
            if a["chain"] == chain: cum_ask += a["ask"]; cum_bid += a["bid"]
            continue
        if a["chain"] == chain:
            cum_ask += a["ask"]; cum_bid += a["bid"]
        s1 = cum_bid >= 25_000 and cum_bid > 1.5 * cum_ask
        s2 = a["chain"] == chain and entry > 0 and a["price"] > 0 and a["price"] <= entry * 0.9
        td = tide_delta(pts, a["t"])
        s3 = td is not None and ((side == "call" and td <= -20e6) or (side == "put" and td >= 20e6))
        if (s2 and (s1 or s3)) or (s1 and s3):
            warn = a["t"]; sigs = {k for k, v in (("bid-takeover", s1), ("prem-10", s2), ("tide-flip", s3)) if v}
            break
    fade_rows.append({**o, "warned": warn is not None, "mins_after": round((warn - t0) / 60) if warn else None, "sigs": sorted(sigs), "side": side, "shown": r["shown"] == "true"})

res["follow_through"] = {f"{N}min": {k: tally(v) for k, v in d.items()} for N, d in ft.items()}
res["baseline"] = tally([{"outcome": r["outcome"]} for r in cands])
W = [x for x in fade_rows if x["warned"]]; NW = [x for x in fade_rows if not x["warned"]]
res["fade_warning"] = {"warned": tally(W), "not_warned": tally(NW),
    "share_of_losers_warned_pct": round(100 * sum(x["outcome"] == "loser" for x in W) / max(1, sum(x["outcome"] == "loser" for x in fade_rows)), 1),
    "share_of_winners_warned_pct": round(100 * sum(x["outcome"] == "winner" for x in W) / max(1, sum(x["outcome"] == "winner" for x in fade_rows)), 1),
    "median_mins_after_print": sorted(x["mins_after"] for x in W)[len(W) // 2] if W else None,
    "by_signal_combo": {"+".join(k): tally(v) for k, v in collections.groupby_like.items()} if False else None}
combos = collections.defaultdict(list)
for x in W: combos["+".join(x["sigs"])].append(x)
res["fade_warning"]["by_signal_combo"] = {k: tally(v) for k, v in combos.items()}
for side in ("call", "put"):
    res["fade_warning"][side] = {"warned": tally([x for x in W if x["side"] == side]), "not_warned": tally([x for x in NW if x["side"] == side])}
res["fade_warning"]["shown_only"] = {"warned": tally([x for x in W if x["shown"]]), "not_warned": tally([x for x in NW if x["shown"]])}
json.dump(res, open(OUT, "w"), indent=1)
print(json.dumps(res, indent=1))
