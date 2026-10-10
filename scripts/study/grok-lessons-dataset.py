#!/usr/bin/env python3
"""
TEST MODE study (Grok lessons, step 1): one row per (day, contract) from the Picks+Premove candidate pools with entry-time features
and the outcome under the LIVE exit rules: buy at alert ask, +30% target / -25% stop / 2 sessions after entry day, sell at bid
(conservative same-session order: stop before target). Reuses simulate() from exit-rules-backtest.py (copied logic).
Filters recorded as flags: spread<=10% (ok_spread), puts only ETF/index (ok_put). No Unusual Whales calls (cached files only).
Out: /workspace/flowguard/study/grok-lessons-work/dataset.csv
"""
import csv, gzip, json, os, re, sys, importlib.util
import pandas as pd
H = "/workspace/flowguard/history"; W = "/workspace/flowguard/study"; O = f"{W}/grok-lessons-work"
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "exit-rules-backtest.py")).read()
# pull only the helper defs (num, bars, spread_of, simulate) without running the script body
start = src.index("def num(x)"); end = src.index("rows = list(csv.DictReader")
ns = {"csv": csv, "gzip": gzip, "json": json, "os": os, "H": H}
exec(src[start:end], ns)
s2 = src.index("_bars = {}"); e2 = src.index("BASE = {")
exec(src[s2:e2], ns)
num, bars, simulate = ns["num"], ns["bars"], ns["simulate"]
RULE = {"target": 0.30, "stop": -0.25, "hold": 2}
prep = pd.read_csv(f"{W}/exit-rules-work/prep.csv", low_memory=False)
prep = prep[prep.uni == "pool"].rename(columns={"lane": "list"})
cand = pd.read_csv(f"{H}/datasets/candidates.csv", low_memory=False)
cand = cand.sort_values(["day", "list", "contract", "printTimeUtc"]).drop_duplicates(["day", "list", "contract"])
keep = ["day","list","contract","poolRank","shown","underlying","score","dte","askShare","premium","volOi","sweep","chips","printTimeUtc"]
df = prep.merge(cand[keep], on=["day","list","contract"], how="left", suffixes=("","_c"))
print(len(df), flush=True)
out = []
for k, r in enumerate(df.itertuples(index=False)):
    bs = bars(r.contract)
    after = [b for b in bs if b["date"] > r.day]
    a_bid, a_ask, ep = num(r.alert_bid), num(r.alert_ask), num(r.entry_print)
    if a_ask and a_bid is not None and a_ask >= a_bid and a_ask > 0:
        s0 = (a_ask - a_bid) / ((a_ask + a_bid) / 2); entry = a_ask
    elif ep:
        s0 = 0.05; entry = ep * 1.025
    else: continue
    if entry <= 0 or s0 > 1.5: continue
    expired = bool(after) and after[-1]["date"] >= r.expiry
    sess = after[:2]
    ret = hit = how = None
    if sess and (len(sess) == 2 or expired):
        ret, hit, how = simulate(entry, sess, s0, RULE, None)
    out.append(dict(day=r.day, list=r.list, contract=r.contract, ticker=r.ticker, side=r.side, expiry=r.expiry, shown=r.shown,
        poolRank=getattr(r, "poolRank"), score=r.score, dte=r.dte, askShare=r.askShare, premium=r.premium, volOi=r.volOi, sweep=r.sweep,
        underlying=r.underlying, chips=r.chips, time=r.printTimeUtc, entry=round(entry, 3), spread=round(s0, 4),
        is_etf=r.is_etf, ok_spread=int(s0 <= 0.10), ok_put=int(not (r.side == "put" and r.is_etf != 1)),
        ret=None if ret is None else round(ret, 4), hit=hit, how=how))
    if k % 10000 == 0: print(k, flush=True)
pd.DataFrame(out).to_csv(f"{O}/dataset.csv", index=False); print("saved", len(out))
