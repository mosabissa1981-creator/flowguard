#!/usr/bin/env python3
"""
TEST MODE study (Grok wide pool): does Grok + lessons separate winners from losers on the candidates the live lists CUT
before Grok ever saw them? Wide pool = Picks/Premove pool rows ranked 13-80 (beyond the top-12 the lessons backtest and
the live finalists use), spread <= 10%, held-out test days only (2026-02-02 -> 2026-10-06, after the lessons-train cutoff).
Stock puts are kept (tagged 'stock' in the fact line) because the wide pool is for learning, not trading.
Grok gets the TRAIN-window lessons sheet + examples (no test-window leakage) and judges every candidate take/pass in batches
of <= 20 (at most 3 takes per batch, never two from one issuer), the same contract as the live lessons_review module.
Scored with the LIVE exit rules from dataset.csv (+30% / -25% / 2 sessions, buy ask / sell bid). Cached history only: no
Unusual Whales calls, no Telegram, no live endpoints. Resumable (runs-wide.jsonl), hard dollar cap (GROK_WIDE_CAP_USD, default 15).
Usage: grok-wide-backtest.py run <days.txt> [workers]   |   grok-wide-backtest.py score [out.json]
"""
import json, os, re, sys, time, threading, urllib.request
import numpy as np, pandas as pd
from concurrent.futures import ThreadPoolExecutor
W = os.environ.get("GROK_LESSONS_WORK", "/workspace/flowguard/study/grok-lessons-work")
CAP = float(os.environ.get("GROK_WIDE_CAP_USD", "15"))
MODEL = os.environ.get("GROK_WIDE_MODEL", "grok-4.7")
BATCH = 20
LEDGER = os.environ.get("GROK_WIDE_LEDGER", f"{W}/ledger-wide.json"); OUT = f"{W}/runs-wide.jsonl"; lock = threading.Lock()
d = pd.read_csv(f"{W}/dataset.csv"); d = d[d.ret.notna() & (d.ok_spread == 1)]
def issuer(t): return {"GOOGL": "GOOG"}.get(t, t)
def strike(c):
    m = re.search(r"(\d{6})([CP])(\d{8})$", c); return int(m.group(3)) / 1000 if m else None
def fact(r):
    t = pd.to_datetime(r.time).tz_convert("America/Chicago").strftime("%H:%M")
    return (f"{r.contract} | {r.ticker} {r.side} K{strike(r.contract):g} dte{int(r.dte)} px{r.underlying:.2f} ask${r.entry:.2f} spread{100*r.spread:.1f}% "
            f"{'ETF/index' if r.is_etf == 1 else 'stock'} askShare{100*r.askShare:.0f}% prem${r.premium/1000:.0f}k vol/OI{r.volOi:.1f} "
            f"{'sweep' if r.sweep else 'no-sweep'} score{r.score:.0f} lanes=wide-pool+{r.list} t={t}CT")
def wide(day):
    g = d[(d.day == day) & (d.poolRank > 12)].sort_values("poolRank")
    return g.drop_duplicates("contract")
SYSTEM = (
    "You are the risk-aware desk reviewer for FlowGuard, an unusual-options-flow screener (paper-trading study, not financial advice). "
    "You do NOT predict prices. For each candidate say take or pass. Most should be pass: take at most 3 and never two from one issuer. "
    "Trades are bought at the ask and exited at +30% target, -25% stop, or after 2 sessions. Use the lessons sheet and real examples below. "
    "These candidates are a WIDE study pool: setups the live lists ranked below their cut, judged only so the desk learns. "
    'Return JSON only: {"reviews":[{"contract":"","judge":"take|pass","confidence":0-100,"why":"<=120 chars"}]}')
def spent():
    return json.load(open(LEDGER))["usd"] if os.path.exists(LEDGER) else 0.0
def add(usd):
    with lock:
        L = json.load(open(LEDGER)) if os.path.exists(LEDGER) else {"usd": 0.0, "calls": 0}
        L["usd"] += usd; L["calls"] += 1; json.dump(L, open(LEDGER, "w"))
def call(sysm, user, key):
    body = json.dumps({"model": MODEL, "temperature": 0.2, "reasoning_effort": "low", "response_format": {"type": "json_object"},
                       "messages": [{"role": "system", "content": sysm}, {"role": "user", "content": user}]}).encode()
    err = ""
    for attempt in range(3):
        try:
            req = urllib.request.Request("https://api.x.ai/v1/chat/completions", body, {"Authorization": f"Bearer {key}", "content-type": "application/json"})
            j = json.load(urllib.request.urlopen(req, timeout=180))
            u = j["usage"]; return j["choices"][0]["message"]["content"], u["cost_in_usd_ticks"] / 1e10, u
        except Exception as e:
            err = str(e); time.sleep(5 * (attempt + 1))
    raise RuntimeError(err)
def run(daysfile, workers):
    key = os.environ["LLM_API_KEY"].strip()
    sysm = SYSTEM + "\n\n" + open(f"{W}/lessons-train.md").read() + "\n\n" + open(f"{W}/examples-train.txt").read()
    done = set()
    if os.path.exists(OUT):
        for l in open(OUT): j = json.loads(l); done.add((j["day"], j["batch"]))
    jobs = []
    for day in open(daysfile).read().split():
        g = wide(day)
        for b in range(0, len(g), BATCH):
            if (day, b // BATCH) not in done: jobs.append((day, b // BATCH, g.iloc[b:b + BATCH]))
    print(len(jobs), "batches to run; spent so far", round(spent(), 4), flush=True)
    def work(job):
        day, bi, g = job
        if spent() >= CAP: return "capped"
        user = f"Date {day}. Candidates:\n" + "\n".join(fact(r) for r in g.itertuples())
        try: txt, usd, u = call(sysm, user, key)
        except Exception as e: print("call failed", day, bi, str(e)[:80], flush=True); return "failed"
        add(usd)
        try: reviews = json.loads(txt).get("reviews", [])
        except Exception: reviews = None
        with lock:
            open(OUT, "a").write(json.dumps({"day": day, "batch": bi, "cands": list(g.contract), "reviews": reviews, "usd": usd,
                                             "in": u["prompt_tokens"], "out": u["completion_tokens"], "raw": None if reviews is not None else txt[:300]}) + "\n")
        return "ok"
    with ThreadPoolExecutor(workers) as ex: res = list(ex.map(work, jobs))
    print("finished", {k: res.count(k) for k in set(res)}, "spent", round(spent(), 4), flush=True)
def score(out):
    rows = []; cost = 0.0; calls = 0; bad = 0
    lut = {(r.day, r.contract): r for r in d.drop_duplicates(["day", "contract"]).itertuples()}
    seen = set()
    for l in open(OUT):
        j = json.loads(l)
        if (j["day"], j["batch"]) in seen: continue
        seen.add((j["day"], j["batch"])); cost += j["usd"]; calls += 1
        if j["reviews"] is None: bad += 1; continue
        rv = {str(x.get("contract", "")).strip(): x for x in j["reviews"]}
        # enforce the module contract: <= 3 takes per batch by confidence, one per issuer; unreviewed = pass
        takes = sorted([c for c in j["cands"] if str(rv.get(c, {}).get("judge")) == "take"], key=lambda c: -float(rv[c].get("confidence") or 0))
        keep, iss = set(), set()
        for c in takes:
            r = lut[(j["day"], c)]
            if issuer(r.ticker) in iss or len(keep) >= 3: continue
            keep.add(c); iss.add(issuer(r.ticker))
        for c in j["cands"]:
            r = lut[(j["day"], c)]
            rows.append({"day": j["day"], "batch": j["batch"], "contract": c, "tk": c in keep, "ret": r.ret, "side": r.side,
                         "etf": int(r.is_etf == 1), "stock_put": int(r.side == "put" and r.is_etf != 1), "conf": float(rv.get(c, {}).get("confidence") or 0)})
    R = pd.DataFrame(rows); rng = np.random.default_rng(7)
    days = R.day.unique(); byday = {k: v for k, v in R.groupby("day")}
    def stats(m):
        v = R[m].ret.values; return {"n": int(len(v)), "win_pct": round(100 * float((v > 0).mean()), 1) if len(v) else None, "avg_ret_pct": round(100 * float(v.mean()), 2) if len(v) else None}
    # day-clustered bootstrap for take/pass and the gap
    B = 2000; bw = {"take": [], "pass": [], "gap": []}; ba = {"take": [], "pass": [], "gap": []}
    for _ in range(B):
        S = pd.concat([byday[x] for x in rng.choice(days, len(days))]); t = S[S.tk].ret.values; p = S[~S.tk].ret.values
        if not len(t) or not len(p): continue
        bw["take"].append(100 * (t > 0).mean()); bw["pass"].append(100 * (p > 0).mean()); bw["gap"].append(bw["take"][-1] - bw["pass"][-1])
        ba["take"].append(100 * t.mean()); ba["pass"].append(100 * p.mean()); ba["gap"].append(ba["take"][-1] - ba["pass"][-1])
    ci = lambda a: [round(float(np.percentile(a, 2.5)), 2), round(float(np.percentile(a, 97.5)), 2)]
    # chance: shuffle the same number of takes inside each batch
    obs_gap = 100 * (R[R.tk].ret.mean() - R[~R.tk].ret.mean()); obs_wgap = 100 * ((R[R.tk].ret > 0).mean() - (R[~R.tk].ret > 0).mean())
    perm, permw = [], []; groups = [g for _, g in R.groupby(["day", "batch"])]
    for _ in range(B):
        tk = []
        for g in groups:
            k = int(g.tk.sum()); m = np.zeros(len(g), bool); m[rng.choice(len(g), k, replace=False)] = True if k else False; tk.append(m)
        m = np.concatenate(tk); rr = np.concatenate([g.ret.values for g in groups])
        perm.append(100 * (rr[m].mean() - rr[~m].mean())); permw.append(100 * ((rr[m] > 0).mean() - (rr[~m] > 0).mean()))
    res = {
        "mode": "TEST MODE study only (Grok wide pool, held-out days, cached data, live exit rules). Never affects live picks.",
        "days": int(len(days)), "batches": calls, "unparsed_batches": bad, "cost_usd": round(cost, 4), "usd_per_batch": round(cost / max(calls, 1), 4),
        "candidates": int(len(R)), "take": stats(R.tk), "pass": stats(~R.tk), "all": stats(R.tk | ~R.tk),
        "take_win_ci95": ci(bw["take"]), "pass_win_ci95": ci(bw["pass"]), "win_gap_pts": round(obs_wgap, 2), "win_gap_ci95": ci(bw["gap"]),
        "take_avg_ci95": ci(ba["take"]), "pass_avg_ci95": ci(ba["pass"]), "avg_gap_pts": round(obs_gap, 2), "avg_gap_ci95": ci(ba["gap"]),
        "chance_p_avg_gap": round(float(np.mean(np.array(perm) >= obs_gap)), 4), "chance_p_win_gap": round(float(np.mean(np.array(permw) >= obs_wgap)), 4),
        "by_side": {s: {"take": stats(R.tk & (R.side == s)), "pass": stats(~R.tk & (R.side == s))} for s in ("call", "put")},
        "stock_puts": {"take": stats(R.tk & (R.stock_put == 1)), "pass": stats(~R.tk & (R.stock_put == 1))},
        "takes_per_day": round(float(R.tk.sum()) / len(days), 2),
    }
    json.dump(res, open(out, "w"), indent=1); print(json.dumps(res, indent=1))
if __name__ == "__main__":
    if sys.argv[1] == "run": run(sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 3)
    else: score(sys.argv[2] if len(sys.argv) > 2 else f"{W}/grok-wide-results.json")
