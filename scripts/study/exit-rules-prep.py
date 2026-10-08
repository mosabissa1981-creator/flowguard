#!/usr/bin/env python3
"""
TEST MODE study, stage 1 of the exit-rules backtest (resumable, one pass over the flow files).
Rows: (1) candidates.csv unique (day, list, contract) = Picks/Premove pools (board = shown);
      (2) entries.csv logged lane entries (picks, premove, puts test lane, 6 setup lanes; lottery excluded).
Per row: alert bid/ask at the print (entry = ask), ETF/index flag (alert issue_type), and the existing fade-watch
proxy on the entry day (same rule as scripts/study/intraday-signals-backtest.py: S1 bid takeover, S2 prem <= -10%,
S3 tide flip; warning = S2&(S1|S3) or S1&S3, from print +5 min) with the option price at the warning.
Out: /workspace/flowguard/study/exit-rules-work/prep.csv (+ prep-done-days.txt checkpoint)
"""
import bisect, collections, csv, gzip, json, os, re, sys
from datetime import datetime
H = "/workspace/flowguard/history"; W = "/workspace/flowguard/study/exit-rules-work"
os.makedirs(W, exist_ok=True)
OUT, DONE = f"{W}/prep.csv", f"{W}/prep-done-days.txt"
def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
def num(x):
    try:
        v = float(x); return v if v == v else None
    except Exception: return None

rows = []
seen = set()
for r in sorted(csv.DictReader(open(f"{H}/datasets/candidates.csv")), key=lambda r: (r["day"], r["list"], r["contract"], r["printTimeUtc"])):
    k = (r["day"], r["list"], r["contract"])
    if k in seen: continue
    seen.add(k)
    rows.append({"uni": "pool", "day": r["day"], "lane": r["list"], "contract": r["contract"], "ticker": r["ticker"], "side": r["side"],
                 "expiry": r["expiry"], "print": r["printTimeUtc"], "entry_print": r["entry"], "shown": int(r["shown"] == "true"), "orig_outcome": r["outcome"]})
for r in csv.DictReader(open(f"{H}/datasets/entries.csv")):
    if r["kind"] != "logged" or r["lane"] == "lottery": continue
    rows.append({"uni": "logged", "day": r["day"], "lane": r["lane"], "contract": r["contract"], "ticker": r["ticker"], "side": r["side"],
                 "expiry": r["expiry"], "print": r["printTimeUtc"], "entry_print": r["entry"], "shown": 1, "orig_outcome": r["outcome"]})
by_day = collections.defaultdict(list)
for r in rows: by_day[r["day"]].append(r)
done = set(open(DONE).read().split()) if os.path.exists(DONE) else set()
cols = list(rows[0].keys()) + ["alert_bid", "alert_ask", "issue_type", "is_etf", "fade_warn", "fade_mins", "fade_price", "fade_sigs"]
new = not os.path.exists(OUT)
fo = open(OUT, "a", newline=""); w = csv.DictWriter(fo, fieldnames=cols)
if new: w.writeheader()
print(len(rows), "rows,", len(by_day), "days,", len(done), "done", flush=True)

def load_day(day):
    p = f"{H}/flow/{day}.json.gz"
    by_chain = collections.defaultdict(list); by_ticker = collections.defaultdict(list)
    if os.path.exists(p):
        d = json.load(gzip.open(p)); f = {n: i for i, n in enumerate(d["fields"])}
        for row in d["rows"]:
            a = {"t": ts(row[f["created_at"]]), "chain": row[f["option_chain"]], "ticker": row[f["ticker"]], "type": row[f["type"]],
                 "ask": num(row[f["total_ask_side_prem"]]) or 0, "bid": num(row[f["total_bid_side_prem"]]) or 0,
                 "price": num(row[f["price"]]) or 0, "nb": num(row[f["bid"]]), "na": num(row[f["ask"]]), "it": row[f["issue_type"]] or ""}
            by_chain[a["chain"]].append(a); by_ticker[a["ticker"]].append(a)
        for v in list(by_chain.values()) + list(by_ticker.values()): v.sort(key=lambda a: a["t"])
    pts = []
    tp = f"{H}/tide/{day}.json"
    if os.path.exists(tp):
        for x in json.load(open(tp)): pts.append((ts(x["timestamp"]), (num(x["net_call_premium"]) or 0) - (num(x["net_put_premium"]) or 0)))
    pts.sort()
    return by_chain, by_ticker, pts
def tide_delta(pts, keys, t, window=1800):
    i = bisect.bisect_right(keys, t) - 1; j = bisect.bisect_right(keys, t - window) - 1
    return None if i < 0 or j < 0 else pts[i][1] - pts[j][1]

for di, day in enumerate(sorted(by_day)):
    if day in done: continue
    bc, bt, pts = load_day(day); keys = [p[0] for p in pts]
    for r in by_day[day]:
        out = dict(r); t0 = ts(r["print"]) if r["print"] else None; entry = num(r["entry_print"]) or 0
        chain = bc.get(r["contract"], [])
        a = min(chain, key=lambda q: abs(q["t"] - t0)) if (chain and t0) else None
        if a and abs(a["t"] - t0) > 120: a = None
        out.update(alert_bid=a["nb"] if a else "", alert_ask=a["na"] if a else "", issue_type=(a["it"] if a else (chain[0]["it"] if chain else "")))
        out["is_etf"] = int(bool(re.search("etf|index", out["issue_type"] or "", re.I))) if out["issue_type"] else ""
        warn = None; sigs = set(); wprice = None
        if t0:
            later_c = [q for q in chain if q["t"] > t0 + 1]
            later_t = [q for q in bt.get(r["ticker"], []) if q["t"] > t0 + 1 and q["type"] == r["side"] and q["chain"] != r["contract"]]
            cum_ask = cum_bid = 0.0; last_px = None
            for q in sorted(later_c + later_t, key=lambda q: q["t"]):
                if q["chain"] == r["contract"]:
                    cum_ask += q["ask"]; cum_bid += q["bid"]
                    if q["price"] > 0: last_px = q["price"]
                if q["t"] < t0 + 300: continue
                s1 = cum_bid >= 25_000 and cum_bid > 1.5 * cum_ask
                s2 = q["chain"] == r["contract"] and entry > 0 and q["price"] > 0 and q["price"] <= entry * 0.9
                td = tide_delta(pts, keys, q["t"]) if pts else None
                s3 = td is not None and ((r["side"] == "call" and td <= -20e6) or (r["side"] == "put" and td >= 20e6))
                if (s2 and (s1 or s3)) or (s1 and s3):
                    warn = q["t"]; wprice = last_px
                    sigs = {k for k, v in (("bid-takeover", s1), ("prem-10", s2), ("tide-flip", s3)) if v}
                    break
        out.update(fade_warn=int(warn is not None), fade_mins=round((warn - t0) / 60) if warn else "", fade_price=wprice or "", fade_sigs="+".join(sorted(sigs)))
        w.writerow(out)
    fo.flush(); open(DONE, "a").write(day + "\n")
    if di % 25 == 0: print(day, di + 1, flush=True)
fo.close(); print("done")
