#!/usr/bin/env python3
"""
TEST MODE study: score the 8 shadow reviewer/checker modules (news_x_check, x_sentiment_shift, earnings_check,
same_buyer_tracking, worth_the_price, regime_analogs, adaptive_exits, debate) against outcomes.
Shadow days: stored /api/shadow?day= docs (Oct 1+) + the Sep 30 local run. Outcome: 2-year replay rule
(+40% before -25% in 3 sessions; candidates.csv / entries.csv) when decided, else the study book's outcome
(book-<day>.json, same +/- rule on the book's quotes; expired_flat -> flat). Unknown -> excluded.
"take" = pass or boost; "skip" = flag. skip-verdicts ("could not judge") reported separately.
Optional: joins the loss model's predictions (walk-forward) where the contract is in the replay.
"""
import csv, glob, json, math, os, sys, collections
S = "/workspace/flowguard/study"; H = "/workspace/flowguard/history"
OUT = sys.argv[1] if len(sys.argv) > 1 else f"{S}/loss-model-work/shadow-checkers.json"
MODS = ["news_x_check", "x_sentiment_shift", "earnings_check", "same_buyer_tracking", "worth_the_price", "regime_analogs", "adaptive_exits", "debate"]

rep = {}
for f in ("candidates.csv", "entries.csv"):
    for r in csv.DictReader(open(f"{H}/datasets/{f}")):
        if r["day"] >= "2026-09-28" and r["outcome"] in ("winner", "loser", "flat"): rep.setdefault((r["day"], r["contract"]), r["outcome"])
book = {}
for f in glob.glob(f"{S}/book-2026-*.json"):
    d = json.load(open(f))
    for r in d.get("rows", []):
        o = r.get("outcome"); o = "flat" if o == "expired_flat" else o
        if o in ("winner", "loser", "flat"): book[(d["day"], r.get("option_chain"))] = o
pred = {}
pf = f"{S}/loss-model-work/predictions.csv.gz"
if os.path.exists(pf):
    import gzip
    for r in csv.DictReader(gzip.open(pf, "rt")):
        if r["model"] == "lightgbm" and r["scheme"] == "walkforward_y2" and r["day"] >= "2026-09-28":
            pred[(r["day"], r["contract"])] = max(pred.get((r["day"], r["contract"]), 0), float(r["p"]))

def fisher_two_sided(a, b, c, d):
    # 2x2 [[a,b],[c,d]] exact p (hypergeometric)
    n = a + b + c + d; r1, c1 = a + b, a + c
    def p(x): return math.comb(c1, x) * math.comb(n - c1, r1 - x) / math.comb(n, r1)
    p0 = p(a); lo, hi = max(0, r1 - (n - c1)), min(r1, c1)
    return round(sum(p(x) for x in range(lo, hi + 1) if p(x) <= p0 + 1e-12), 3)

rows = []
for f in sorted(glob.glob(f"{S}/loss-model-work/shadow/shadow-*.json")):
    d = json.load(open(f)); day = d["day"]
    for c in d.get("candidates", []):
        k = (day, c["contract"]); o = rep.get(k); src = "replay"
        if not o: o = book.get(k); src = "book"
        vs = {v["module"]: v for v in d.get("verdicts", {}).get(c["contract"], [])}
        rows.append({"day": day, "contract": c["contract"], "outcome": o, "src": src if o else None, "p_loss": pred.get(k),
                     **{m: (vs.get(m) or {}).get("verdict") for m in MODS}})
known = [r for r in rows if r["outcome"]]
res = {"note": "Tiny sample (shadow modules only ran Sep 30 + Oct 1-7). Treat as directional at best.",
       "candidate_days": len(rows), "with_outcome": len(known),
       "outcome_sources": dict(collections.Counter(r["src"] for r in known)),
       "overall": {"n": len(known), "win_pct": round(100 * sum(r["outcome"] == "winner" for r in known) / max(1, len(known)), 1),
                   "loss_pct": round(100 * sum(r["outcome"] == "loser" for r in known) / max(1, len(known)), 1)}, "modules": {}}
for m in MODS:
    out = {}
    for name, sel in (("take", ("pass", "boost")), ("skip_flag", ("flag",)), ("boost", ("boost",)), ("could_not_judge", ("skip", None))):
        g = [r for r in known if r[m] in sel]
        out[name] = {"n": len(g), "win_pct": round(100 * sum(r["outcome"] == "winner" for r in g) / len(g), 1) if g else None,
                     "loss_pct": round(100 * sum(r["outcome"] == "loser" for r in g) / len(g), 1) if g else None}
    t = [r for r in known if r[m] in ("pass", "boost")]; s = [r for r in known if r[m] == "flag"]
    a, b = sum(r["outcome"] == "winner" for r in t), sum(r["outcome"] != "winner" for r in t)
    c_, d_ = sum(r["outcome"] == "winner" for r in s), sum(r["outcome"] != "winner" for r in s)
    out["fisher_p_win_take_vs_flag"] = fisher_two_sided(a, b, c_, d_) if (t and s) else None
    out["edge_win_pts_take_minus_flag"] = round(out["take"]["win_pct"] - out["skip_flag"]["win_pct"], 1) if (t and s) else None
    tp = [r["p_loss"] for r in t if r["p_loss"] is not None]; sp = [r["p_loss"] for r in s if r["p_loss"] is not None]
    out["model_p_loss_mean_take_vs_flag"] = [round(sum(tp) / len(tp), 3) if tp else None, round(sum(sp) / len(sp), 3) if sp else None, len(tp), len(sp)]
    res["modules"][m] = out
res["rows"] = rows
json.dump(res, open(OUT, "w"), indent=1)
for m in MODS: print(m, res["modules"][m]["take"], res["modules"][m]["skip_flag"], res["modules"][m]["fisher_p_win_take_vs_flag"])
print(res["overall"], res["outcome_sources"])
