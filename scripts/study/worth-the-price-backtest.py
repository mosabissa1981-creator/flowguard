#!/usr/bin/env python3
"""
TEST MODE study: replay the shadow `worth_the_price` checker (lib/shadow/modules.ts) on the 2-year candidates.
Needed underlying move for +40% option premium within the 3-session replay window (Black-Scholes at the print's IV,
time decayed by the hold) divided by 1-sigma of the hold (20-day realized vol). boost: ratio < 0.6; flag: ratio > 1;
else pass. (IV rank is not in history -> treated as n/a, same as the live module when UW has no rank.)
Adds `sigma_ratio` to a side file for the loss model.
"""
import math, sys, json
import numpy as np, pandas as pd
F = "/workspace/flowguard/study/loss-model-features.csv.gz"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/flowguard/study/loss-model-work/worth-the-price-backtest.json"
SIDE = "/workspace/flowguard/study/loss-model-work/sigma-ratio.csv.gz"
N = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))
def bs(S, K, T, s, call):
    if T <= 0 or s <= 0: return max(0.0, S - K if call else K - S)
    d1 = (math.log(S / K) + 0.5 * s * s * T) / (s * math.sqrt(T)); d2 = d1 - s * math.sqrt(T)
    return S * N(d1) - K * N(d2) if call else K * N(-d2) - S * N(-d1)
def spot_for(target, S, K, T, s, call):
    lo, hi = (S, S * 3) if call else (S * 0.2, S)
    f = lambda x: bs(x, K, T, s, call) - target
    if call and f(hi) < 0: return None
    if not call and f(lo) < 0: return None
    for _ in range(80):
        mid = (lo + hi) / 2
        if (f(mid) < 0) == call: lo = mid
        else: hi = mid
    return (lo + hi) / 2
df = pd.read_csv(F, low_memory=False)
rat = []
for r in df.itertuples():
    try:
        # strike from the OCC symbol; underlying at the print from the stored moneyness
        k = int(r.contract[-8:]) / 1000; call = r.side == "call"
        if pd.isna(r.otm_pct) or pd.isna(r.iv) or pd.isna(r.stock_rv20) or not r.entry or r.entry <= 0: rat.append(np.nan); continue
        S = k / (1 + r.otm_pct / 100) if call else k / (1 - r.otm_pct / 100)
        sessions = 3; texit = max(1, r.dte - math.ceil(sessions * 7 / 5)) / 365
        Ss = spot_for(r.entry * 1.4, S, k, texit, r.iv, call)
        if Ss is None: rat.append(np.inf); continue
        rat.append(abs(Ss / S - 1) / (r.stock_rv20 * math.sqrt(sessions / 252)))
    except Exception:
        rat.append(np.nan)
df["sigma_ratio"] = rat
df[["day", "list", "contract", "sigma_ratio"]].to_csv(SIDE, index=False)
s = df[df.outcome.isin(["winner", "loser", "flat"])].copy()
s["verdict"] = np.select([s.sigma_ratio < 0.6, s.sigma_ratio > 1, s.sigma_ratio.notna()], ["boost", "flag", "pass"], "n/a")
s["year"] = np.where(s.day < "2025-10-01", "y1", "y2")
def z2(k1, n1, k2, n2):
    p = (k1 + k2) / (n1 + n2); se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2)); return round((k1 / n1 - k2 / n2) / se, 2) if se else None
res = {"definition": __doc__.strip()}
for uni, g0 in (("all_scored_candidates", s), ("board_shown", s[s.shown == 1])):
    for yr, g in g0.groupby("year"):
        t = {}
        for v, x in g.groupby("verdict"):
            t[v] = {"n": len(x), "win_pct": round(100 * (x.outcome == "winner").mean(), 1), "loss_pct": round(100 * (x.outcome == "loser").mean(), 1)}
        b, o = g[g.verdict == "boost"], g[g.verdict != "boost"]
        f, nf = g[g.verdict == "flag"], g[g.verdict != "flag"]
        t["z_boost_vs_rest_win"] = z2((b.outcome == "winner").sum(), len(b), (o.outcome == "winner").sum(), len(o)) if len(b) and len(o) else None
        t["z_flag_vs_rest_win"] = z2((f.outcome == "winner").sum(), len(f), (nf.outcome == "winner").sum(), len(nf)) if len(f) and len(nf) else None
        t["picks_per_day"] = round(len(g) / g.day.nunique(), 2)
        res[f"{uni}_{yr}"] = t
json.dump(res, open(OUT, "w"), indent=1)
for k, v in res.items():
    if k != "definition": print(k, v)
