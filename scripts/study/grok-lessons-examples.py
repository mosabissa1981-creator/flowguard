#!/usr/bin/env python3
"""Step 2: pick ~24 real past setups (12 winners, 12 losers; hit +30% vs hit -25%) from the TRAIN window as few-shot examples.
Stratified by side and by time (random, fixed seed) from setups that sat in the top-12 of a day's Picks/Premove pool and passed the live filters.
Deliberately NOT cherry-picked to agree with the lessons: some winners are 'low quality' by the lessons and vice versa.
Usage: grok-lessons-examples.py <cutoff_day inclusive> <out.txt>"""
import sys, re, pandas as pd, numpy as np
W = "/workspace/flowguard/study/grok-lessons-work"
cut, out = sys.argv[1], sys.argv[2]
d = pd.read_csv(f"{W}/dataset.csv"); d = d[d.ret.notna() & (d.ok_spread == 1) & (d.ok_put == 1) & (d.day <= cut) & (d.poolRank <= 12)]
rng = np.random.RandomState(42)
def strike(c): m = re.search(r"(\d{8})$", c); return int(m.group(1)) / 1000
def line(r, tag):
    t = pd.to_datetime(r.time).tz_convert("America/Chicago").strftime("%H:%M")
    res = {"target": "hit +30% target in session 1-2", "target_gap": "opened above +30% (gap up)", "stop": "hit -25% stop", "stop_gap": "opened below the stop (gap down)"}[r.how]
    return (f"[{tag}] {r.day} {r.ticker} {r.side} K{strike(r.contract):g} dte{int(r.dte)} ask${r.entry:.2f} spread{100*r.spread:.1f}% "
            f"{'ETF/index' if r.is_etf == 1 else 'stock'} prem${r.premium/1000:.0f}k vol/OI{r.volOi:.1f} {'sweep' if r.sweep else 'no-sweep'} score{r.score:.0f} t={t}CT "
            f"-> {res}, result {100*r.ret:+.0f}%")
W_, L_ = d[d.how.isin(["target", "target_gap"])], d[d.how.isin(["stop", "stop_gap"])]
sel = []
for pool, tag, n in ((W_, "WINNER", 12), (L_, "LOSER", 12)):
    pool = pool.copy(); pool["q"] = pd.qcut(pool.day.rank(method="first"), 4, labels=False)
    got = []
    for side, k in (("call", 2), ("put", 1)):   # 3 per quarter: 2 calls + 1 put
        for q in range(4):
            g = pool[(pool.side == side) & (pool.q == q)]
            got += list(g.sample(k, random_state=rng).itertuples())
    sel += [(tag, r) for r in got]
sel.sort(key=lambda x: x[1].day)
txt = ("## Real past examples (train window only; 12 winners, 12 losers, random picks, not cherry-picked). Use them as texture, not rules:\n"
       + "\n".join(line(r, tag) for tag, r in sel) + "\n")
open(out, "w").write(txt); print(txt)
