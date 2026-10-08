"""Box-only, budget-capped fetch of UW per-strike GEX by expiry for backtest entry ticker-days (study only).
GET /api/stock/{T}/greek-exposure/strike-expiry?date=D&expiry=X -> history/signals/gex-exp/<T>.<D>.<X>.json
Nearest weekly = first Friday strictly after the entry day (Thu fallback for holiday Fridays, then the next Friday,
then the monthly 3rd Friday). Own expiry = the contract's expiry.
Budget: UW_RUN_MAX calls this run (default 20,000), 2 in flight (UW limit 3 incl. the site), stop on daily 429.
"""
import csv, json, os, sys, time, threading, urllib.request, urllib.error, datetime as dt
from concurrent.futures import ThreadPoolExecutor

H = os.environ.get("HISTORY_DIR", "/workspace/flowguard/history")
OUTD = f"{H}/signals/gex-exp"; os.makedirs(OUTD, exist_ok=True)
RUN_MAX = int(os.environ.get("UW_RUN_MAX", "20000"))
KEY = os.environ["UNUSUAL_WHALES_API_KEY"].strip()
lock = threading.Lock(); state = {"calls": 0, "stop": "", "errors": 0, "empty": 0}

def fpath(t, d, x): return f"{OUTD}/{t.replace('/', '_')}.{d}.{x}.json"

def fetch(t, d, x):
    f = fpath(t, d, x)
    if os.path.exists(f): return json.load(open(f))
    for attempt in range(5):
        with lock:
            if state["stop"]: return None
            if state["calls"] >= RUN_MAX: state["stop"] = f"run max {RUN_MAX}"; return None
            state["calls"] += 1
        req = urllib.request.Request(f"https://api.unusualwhales.com/api/stock/{t}/greek-exposure/strike-expiry?date={d}&expiry={x}",
                                     headers={"Authorization": f"Bearer {KEY}", "UW-CLIENT-API-ID": "100001", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r).get("data") or []
            rows = [{"strike": z.get("strike"), "call_gex": z.get("call_gex"), "put_gex": z.get("put_gex")} for z in data]
            json.dump(rows, open(f, "w"))
            if not rows: state["empty"] += 1
            return rows
        except urllib.error.HTTPError as e:
            body = e.read()[:300].decode("utf8", "ignore")
            state["errors"] += 1
            if e.code == 429 and "daily" in body.lower():
                state["stop"] = "UW daily limit"; return None
            if e.code in (429,) or e.code >= 500:
                time.sleep(1.5 * 2 ** attempt); continue
            json.dump([], open(f, "w")); return []
        except Exception:
            state["errors"] += 1; time.sleep(1.5 * 2 ** attempt)
    return None

def fridays_after(day):
    d = dt.date.fromisoformat(day)
    f = d + dt.timedelta(days=(4 - d.weekday()) % 7 or 7)
    third = None
    m = dt.date(d.year, d.month, 1)
    for _ in range(3):
        t = m + dt.timedelta(days=(4 - m.weekday()) % 7 + 14)
        if t > d: third = t; break
        m = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    out = [f, f - dt.timedelta(days=1), f + dt.timedelta(days=7)]
    if third and third not in out: out.append(third)
    return [x.isoformat() for x in out]

def nearest(t, d):
    for x in fridays_after(d):
        rows = fetch(t, d, x)
        if rows is None: return None
        if rows: 
            json.dump({"expiry": x}, open(f"{OUTD}/{t}.{d}.nearest.json", "w"))
            return x
    json.dump({"expiry": None}, open(f"{OUTD}/{t}.{d}.nearest.json", "w"))
    return None

def exp(c): t = c[-15:]; return "20" + t[:2] + "-" + t[2:4] + "-" + t[4:6]

E = [r for r in csv.DictReader(open(f"{H}/datasets/entries.csv")) if r["kind"] == "logged" and r["outcome"] in ("winner", "loser", "flat")]
seen = set(); C = []
for r in csv.DictReader(open(f"{H}/datasets/candidates.csv")):
    if r["outcome"] not in ("winner", "loser", "flat") or not os.path.exists(f"{H}/signals/gex/{r['ticker']}.{r['day']}.json"): continue
    k = (r["day"], r["contract"])
    if k not in seen: seen.add(k); C.append(r)
jobs, js = [], set()
for r in E + C:  # logged entries first
    for j in (("near", r["ticker"], r["day"], None), ("own", r["ticker"], r["day"], exp(r["contract"]))):
        if j not in js: js.add(j); jobs.append(j)
print(f"jobs {len(jobs)} run max {RUN_MAX}", flush=True)

def run(j):
    kind, t, d, x = j
    if kind == "near":
        if os.path.exists(f"{OUTD}/{t}.{d}.nearest.json"): return
        nearest(t, d)
    else:
        fetch(t, d, x)

done = 0
with ThreadPoolExecutor(max_workers=2) as ex:
    for _ in ex.map(run, jobs):
        done += 1
        if done % 500 == 0: print(f"{dt.datetime.now():%H:%M:%S} done {done}/{len(jobs)} calls {state['calls']} empty {state['empty']} errors {state['errors']} stop={state['stop']}", flush=True)
        if state["stop"]: break
print(f"FINISHED done {done}/{len(jobs)} calls {state['calls']} empty {state['empty']} errors {state['errors']} stop={state['stop']}", flush=True)
