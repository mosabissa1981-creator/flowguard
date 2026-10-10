#!/usr/bin/env python3
"""
TEST MODE study (Grok lessons, step 3): run Grok 4.7 with vs without the lessons sheet + few-shot examples on held-out days.
Each day: candidates = top-12 Picks list + top-12 Premove list (by pool rank), deduped, live filters (spread<=10%, puts ETF/index only),
facts known at the print only. Grok picks 0-3 contracts. Scored with the LIVE exit rules (+30% / -25% / 2 sessions, buy ask / sell bid)
from dataset.csv. Resumable (jsonl per arm), hard dollar cap across all arms (ledger.json), nice-friendly low concurrency.
Usage: grok-lessons-backtest.py <arm: base|lessons> <days.txt> [workers]
No Telegram, no live endpoints, no Unusual Whales calls (cached history only).
"""
import json, os, re, sys, time, threading, urllib.request
import pandas as pd
from concurrent.futures import ThreadPoolExecutor
W = "/workspace/flowguard/study/grok-lessons-work"
CAP = float(os.environ.get("GROK_TEST_CAP_USD", "4.5"))
MODEL = "grok-4.7"
arm, daysfile = sys.argv[1], sys.argv[2]; workers = int(sys.argv[3]) if len(sys.argv) > 3 else 3
KEY = os.environ["LLM_API_KEY"].strip()
LEDGER = f"{W}/ledger.json"; lock = threading.Lock()
def spent():
    return json.load(open(LEDGER))["usd"] if os.path.exists(LEDGER) else 0.0
def add(usd, arm):
    with lock:
        L = json.load(open(LEDGER)) if os.path.exists(LEDGER) else {"usd": 0.0, "calls": 0, "by_arm": {}}
        L["usd"] += usd; L["calls"] += 1; L["by_arm"][arm] = L["by_arm"].get(arm, 0) + usd
        json.dump(L, open(LEDGER, "w"))
d = pd.read_csv(f"{W}/dataset.csv"); d = d[d.ret.notna() & (d.ok_spread == 1) & (d.ok_put == 1)]
def strike(c):
    m = re.search(r"(\d{6})([CP])(\d{8})$", c); return int(m.group(3)) / 1000 if m else None
def fact(r):
    t = pd.to_datetime(r.time).tz_convert("America/Chicago").strftime("%H:%M")
    return (f"{r.contract} | {r.ticker} {r.side} K{strike(r.contract):g} dte{int(r.dte)} px{r.underlying:.2f} ask${r.entry:.2f} spread{100*r.spread:.1f}% "
            f"{'ETF/index' if r.is_etf == 1 else 'stock'} askShare{100*r.askShare:.0f}% prem${r.premium/1000:.0f}k vol/OI{r.volOi:.1f} "
            f"{'sweep' if r.sweep else 'no-sweep'} score{r.score:.0f} lane={r.list} t={t}CT")
def day_cands(day):
    g = d[d.day == day]; parts = []
    for ln in ("picks", "premove"): parts.append(g[g.list == ln].sort_values("poolRank").head(12))
    return pd.concat(parts).drop_duplicates("contract")
SYSTEM_BASE = (
    "You are the risk-aware desk reviewer for FlowGuard, an unusual-options-flow screener (paper-trading study, not financial advice). "
    "You do NOT predict prices. From the candidate list pick between 0 and 3 contracts (exact contract ids, only from the list) worth a small, defined-risk "
    "paper trade today, or none. Trades are bought at the ask and exited with: +30% target, -25% stop, or sold after 2 sessions. "
    "Prefer morning ask-side prints, 11-30 DTE, single-leg sweeps; distrust late prints and same-issuer clusters (never two picks from one issuer). "
    'Respond with JSON only: {"picks":[{"contract":"...","confidence":0-100,"reason":"<=100 chars"}]}')
def build(arm, day):
    sysm = SYSTEM_BASE
    if arm == "lessons":
        sysm += "\n\n" + open(f"{W}/lessons-train.md").read() + "\n\n" + open(f"{W}/examples-train.txt").read()
    c = day_cands(day)
    user = f"Date {day}. Candidates (rank order, pool score shown):\n" + "\n".join(fact(r) for r in c.itertuples())
    return sysm, user, list(c.contract)
def call(sysm, user):
    body = json.dumps({"model": MODEL, "temperature": 0.2, "reasoning_effort": "low", "response_format": {"type": "json_object"},
                       "messages": [{"role": "system", "content": sysm}, {"role": "user", "content": user}]}).encode()
    for attempt in range(3):
        try:
            req = urllib.request.Request("https://api.x.ai/v1/chat/completions", body, {"Authorization": f"Bearer {KEY}", "content-type": "application/json"})
            j = json.load(urllib.request.urlopen(req, timeout=120))
            u = j["usage"]; return j["choices"][0]["message"]["content"], u["cost_in_usd_ticks"] / 1e10, u
        except Exception as e:
            err = str(e); time.sleep(5 * (attempt + 1))
    raise RuntimeError(err)
OUT = f"{W}/runs-{arm}.jsonl"
done = {json.loads(l)["day"] for l in open(OUT)} if os.path.exists(OUT) else set()
days = [x for x in open(daysfile).read().split() if x not in done]
print(arm, len(days), "days to run; spent so far", round(spent(), 4), flush=True)
def work(day):
    if spent() >= CAP: return "capped"
    sysm, user, cids = build(arm, day)
    try: txt, usd, u = call(sysm, user)
    except Exception as e: print('call failed', day, str(e)[:80], flush=True); return 'failed'
    add(usd, arm)
    try: picks = json.loads(txt).get("picks", [])
    except Exception: picks = None
    with lock:
        open(OUT, "a").write(json.dumps({"day": day, "cands": cids, "picks": picks, "usd": usd, "in": u["prompt_tokens"], "out": u["completion_tokens"], "raw": None if picks is not None else txt[:300]}) + "\n")
    return "ok"
with ThreadPoolExecutor(workers) as ex:
    res = list(ex.map(work, days))
print("finished", {k: res.count(k) for k in set(res)}, "spent", round(spent(), 4), flush=True)
