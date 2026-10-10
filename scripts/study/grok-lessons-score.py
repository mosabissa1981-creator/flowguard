#!/usr/bin/env python3
"""Step 3b: score the with/without-lessons Grok runs vs baselines on the same held-out days (live exit rules). Study only.
Usage: grok-lessons-score.py [runs-prefix-dir] -> prints + writes grok-lessons-results.json"""
import json, os, sys, numpy as np, pandas as pd
W = "/workspace/flowguard/study/grok-lessons-work"
d = pd.read_csv(f"{W}/dataset.csv"); d = d[d.ret.notna() & (d.ok_spread == 1) & (d.ok_put == 1)]
ret = {(r.day, r.contract): (r.ret, r.hit) for r in d.itertuples()}
def issuer(t): return {"GOOGL": "GOOG"}.get(t, t)
tick = {(r.day, r.contract): r.ticker for r in d.itertuples()}
def load(arm):
    out = {}
    for l in open(f"{W}/runs-{arm}.jsonl"):
        j = json.loads(l)
        if j["day"] in out or j["picks"] is None: continue
        seen, keep = set(), []
        for p in sorted(j["picks"], key=lambda p: -p.get("confidence", 0)):
            c = p.get("contract")
            if c in j["cands"] and (j["day"], c) in ret and issuer(tick[(j["day"], c)]) not in seen:
                seen.add(issuer(tick[(j["day"], c)])); keep.append(c)
        out[j["day"]] = (keep[:3], j["cands"], j["usd"])
    return out
runs = {a: load(a) for a in ("base", "lessons")}
days = sorted(set(runs["base"]) & set(runs["lessons"]))
rng = np.random.RandomState(1)
def trades(sel):  # sel: day -> list of contracts
    return [(day, *ret[(day, c)]) for day in days for c in sel.get(day, []) if (day, c) in ret]
def stats(tr):
    r = np.array([t[1] for t in tr]); h = np.array([t[2] for t in tr])
    return dict(n_trades=len(r), win_pct=round(100 * (r > 0).mean(), 1), target_hit_pct=round(100 * h.mean(), 1), avg_ret_pct=round(100 * r.mean(), 2),
                avg_loss_pct=round(100 * r[r < 0].mean(), 2), trades_per_day=round(len(r) / len(days), 2))
sel = {"grok_base": {x: runs["base"][x][0] for x in days}, "grok_lessons": {x: runs["lessons"][x][0] for x in days}}
cands = {x: [c for c in runs["base"][x][1] if (x, c) in ret] for x in days}
sel["all_candidates"] = cands
# quality-rule baseline (no AI): rule from the lessons, top 3 by pool rank, one per issuer
q = d[(d.spread <= 0.04) & (d.entry >= 2) & (d.premium >= 1e5) & (d.score >= 90)]
qsel = {}
for x in days:
    seen, keep = set(), []
    for r in q[(q.day == x) & q.contract.isin(cands[x])].sort_values("poolRank").itertuples():
        i = issuer(r.ticker)
        if i not in seen: seen.add(i); keep.append(r.contract)
    qsel[x] = keep[:3]
sel["rule_quality_top3"] = qsel
res = {a: stats(trades(s)) for a, s in sel.items()}
# random 3 (one per issuer) from the same candidate lists, 500 draws
rnd = []
for _ in range(500):
    s = {}
    for x in days:
        cs = list(cands[x]); rng.shuffle(cs); seen, keep = set(), []
        for c in cs:
            i = issuer(tick[(x, c)])
            if i not in seen: seen.add(i); keep.append(c)
        s[x] = keep[:3]
    t = trades(s); r = np.array([v[1] for v in t]); rnd.append((100 * (r > 0).mean(), 100 * np.mean([v[2] for v in t]), 100 * r.mean()))
rnd = np.array(rnd)
res["random_3_per_day (mean of 500 draws)"] = dict(win_pct=round(rnd[:, 0].mean(), 1), target_hit_pct=round(rnd[:, 1].mean(), 1), avg_ret_pct=round(rnd[:, 2].mean(), 2),
                                                  avg_ret_pct_p5_p95=[round(float(np.percentile(rnd[:, 2], 5)), 2), round(float(np.percentile(rnd[:, 2], 95)), 2)])
# paired day-bootstrap: per-trade avg return difference lessons - base (days resampled)
def day_arrays(s): return {x: np.array([ret[(x, c)][0] for c in s.get(x, [])]) for x in days}
A, B = day_arrays(sel["grok_lessons"]), day_arrays(sel["grok_base"])
def diff(idx):
    a = np.concatenate([A[days[i]] for i in idx]); b = np.concatenate([B[days[i]] for i in idx])
    return 100 * (a.mean() - b.mean()) if len(a) and len(b) else np.nan
bs = [diff(rng.randint(0, len(days), len(days))) for _ in range(2000)]
res["lessons_minus_base_avg_ret_pts"] = dict(point=round(diff(range(len(days))), 2), ci95=[round(float(np.nanpercentile(bs, 2.5)), 2), round(float(np.nanpercentile(bs, 97.5)), 2)])
def winflag(s): return {x: np.array([ret[(x, c)][0] > 0 for c in s.get(x, [])], dtype=float) for x in days}
WA, WB = winflag(sel["grok_lessons"]), winflag(sel["grok_base"])
def wd(idx):
    a = np.concatenate([WA[days[i]] for i in idx]); b = np.concatenate([WB[days[i]] for i in idx]); return 100 * (a.mean() - b.mean())
bw = [wd(rng.randint(0, len(days), len(days))) for _ in range(2000)]
res["lessons_minus_base_win_pts"] = dict(point=round(wd(range(len(days))), 2), ci95=[round(float(np.percentile(bw, 2.5)), 2), round(float(np.percentile(bw, 97.5)), 2)])
# overlap + halves + cost
ov = np.mean([len(set(sel["grok_lessons"][x]) & set(sel["grok_base"][x])) / max(1, len(set(sel["grok_lessons"][x]) | set(sel["grok_base"][x]))) for x in days])
res["picks_overlap_jaccard"] = round(float(ov), 2)
res["n_days"] = len(days)
for h, dd in (("first_half_days", days[:len(days)//2]), ("second_half_days", days[len(days)//2:])):
    res[h] = {a: stats([t for t in trades(s) if t[0] in dd]) for a, s in sel.items() if a.startswith("grok")}
res["cost_usd"] = {a: round(sum(runs[a][x][2] for x in runs[a]), 4) for a in runs}
res["by_side"] = {a: {sd: stats([t for t in trades(sel[a]) if True and (t[0], ) and False] or [(0, 0, 0)]) for sd in []} for a in []}
json.dump(res, open(f"{W}/grok-lessons-results.json", "w"), indent=1); print(json.dumps(res, indent=1))
