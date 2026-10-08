#!/usr/bin/env python3
"""
TEST MODE study: entry-time feature table for the "chance of losing" model.
Universe: history/datasets/candidates.csv (2-year replay, picks + premove pools). One row per (day, list, contract),
first print. Only facts known at the print (no look-ahead): candidate score/chips, the matching flow alert
(bid/ask, OI, trade count, issue type...), underlying daily bars up to the PRIOR close + the price at the print,
SPY/QQQ at the print, market tide at the print, earnings calendar, macro calendar, same-day pool before the print.
GEX is end-of-day and sparse in history -> excluded. IV is backed out of the entry price (Black-Scholes, no dividends).
Out: /workspace/flowguard/study/loss-model-features.csv.gz
Run niced: nice -n 10 python3 scripts/study/loss-model-features.py
"""
import bisect, collections, csv, gzip, json, math, os, re, sys
from datetime import datetime, date, timedelta, timezone
from zoneinfo import ZoneInfo

H = os.environ.get("HISTORY_DIR", "/workspace/flowguard/history")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/flowguard/study/loss-model-features.csv.gz"
ET = ZoneInfo("America/New_York")
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def num(x):
    try:
        v = float(x); return v if v == v else None
    except Exception:
        return None
def ts(s): return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
def truthy(v): return str(v).lower() in ("true", "1", "yes")

# ---------- sector map (same static map as lib/issuers.ts)
src = open(os.path.join(REPO, "lib/issuers.ts")).read()
ALIAS = dict(re.findall(r'^\s*"?([A-Z.]+)"?: "([A-Z\-]+)",', src.split("const SECTORS")[0], re.M))
SECTOR = {}
for name, body in re.findall(r'^\s*"?([A-Za-z /\-]+)"?: \[(.*?)\],', src.split("const SECTORS")[1].split("const SECTOR_BY_ISSUER")[0], re.M | re.S):
    for t in re.findall(r'"([A-Z\-]+)"', body): SECTOR[t] = name.strip()
def issuer(t): return ALIAS.get(t, t)
def sector(t): return SECTOR.get(issuer(t), "Other:" + issuer(t))

# ---------- daily bars
_ohlc = {}
def bars(t):
    if t in _ohlc: return _ohlc[t]
    m = {}
    for i in range(4):
        p = f"{H}/ohlc/{t}.{i}.json"
        if os.path.exists(p):
            for b in json.load(open(p)): m[b["date"]] = b
    b = sorted(m.values(), key=lambda b: b["date"])
    _ohlc[t] = (b, [x["date"] for x in b])
    return _ohlc[t]
def daily_ctx(t, day):
    b, ds = bars(t)
    i = bisect.bisect_left(ds, day)
    out = {}
    if i == 0: return out
    pc = b[i - 1]["c"]; out["pc"] = pc
    if i < len(b) and ds[i] == day: out["open"] = b[i]["o"]
    closes = [x["c"] for x in b[max(0, i - 21):i]]
    if len(closes) >= 6: out["chg5"] = (pc / closes[-6] - 1) * 100
    if len(closes) >= 21:
        sma = sum(closes[-20:]) / 20; out["vs_sma20"] = (pc / sma - 1) * 100
        rets = [math.log(closes[k] / closes[k - 1]) for k in range(1, len(closes))]
        mu = sum(rets) / len(rets)
        out["rv20"] = math.sqrt(sum((r - mu) ** 2 for r in rets) / (len(rets) - 1)) * math.sqrt(252)
        hi = max(x["h"] for x in b[i - 20:i]); lo = min(x["l"] for x in b[i - 20:i])
        out["vs_hi20"] = (pc / hi - 1) * 100; out["vs_lo20"] = (pc / lo - 1) * 100
    return out

# ---------- tide
def load_tide(day):
    p = f"{H}/tide/{day}.json"
    rows = []
    if os.path.exists(p):
        for r in json.load(open(p)):
            rows.append((ts(r["timestamp"]), num(r["net_call_premium"]) or 0, num(r["net_put_premium"]) or 0))
    rows.sort(); return rows
def tide_at(rows, t0):
    if not rows: return None
    k = bisect.bisect_right([r[0] for r in rows], t0) - 1
    if k < 0: return None
    _, c, p = rows[k]
    return (c - p) / max(abs(c), abs(p), 1)

# ---------- earnings
_earn = {}
def earn_dates(t):
    if t not in _earn:
        p = f"{H}/earnings/{t}.json"
        ds = []
        if os.path.exists(p):
            try: ds = sorted({r["date"] for r in json.load(open(p)).get("rows", []) if r.get("date")})
            except Exception: ds = []
        _earn[t] = ds
    return _earn[t]

# ---------- macro calendar (FOMC decisions; CPI release dates; NFP = first Friday). CPI list best-known, approximate.
FOMC = ["2024-11-07", "2024-12-18", "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30", "2025-09-17",
        "2025-10-29", "2025-12-10", "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28"]
CPI = ["2024-10-10", "2024-11-13", "2024-12-11", "2025-01-15", "2025-02-12", "2025-03-12", "2025-04-10", "2025-05-13",
       "2025-06-11", "2025-07-15", "2025-08-12", "2025-09-11", "2025-10-24", "2025-12-18", "2026-01-13", "2026-02-11",
       "2026-03-11", "2026-04-10", "2026-05-12", "2026-06-10", "2026-07-14", "2026-08-12", "2026-09-11", "2026-10-14"]
def first_fridays():
    out = []
    for y in (2024, 2025, 2026):
        for m in range(1, 13):
            d = date(y, m, 1)
            while d.weekday() != 4: d += timedelta(days=1)
            out.append(d.isoformat())
    return out
MACRO = sorted(set(FOMC + CPI + first_fridays()))
def days_between(a, b): return (date.fromisoformat(b) - date.fromisoformat(a)).days

# ---------- Black-Scholes IV
def bs_price(S, K, T, s, call):
    if s <= 0 or T <= 0: return max(0.0, (S - K) if call else (K - S))
    d1 = (math.log(S / K) + 0.5 * s * s * T) / (s * math.sqrt(T)); d2 = d1 - s * math.sqrt(T)
    N = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))
    return S * N(d1) - K * N(d2) if call else K * N(-d2) - S * N(-d1)
def implied_vol(px, S, K, T, call):
    if not (px and S and K and T and px > 0 and S > 0 and K > 0 and T > 0): return None
    intr = max(0.0, (S - K) if call else (K - S))
    if px <= intr + 1e-4: return None
    lo, hi = 0.01, 6.0
    if bs_price(S, K, T, hi, call) < px: return None
    for _ in range(60):
        mid = (lo + hi) / 2
        if bs_price(S, K, T, mid, call) > px: hi = mid
        else: lo = mid
    return (lo + hi) / 2

# ---------- flow per day
FLOW_KEYS = ["created_at", "ticker", "type", "strike", "price", "underlying_price", "total_premium", "total_ask_side_prem",
             "total_bid_side_prem", "total_size", "trade_count", "volume", "open_interest", "has_sweep", "has_floor",
             "has_multileg", "all_opening_trades", "alert_rule", "issue_type", "marketcap", "ask", "bid"]
def load_flow(day):
    p = f"{H}/flow/{day}.json.gz"
    if not os.path.exists(p): return None
    d = json.load(gzip.open(p)); f = {n: i for i, n in enumerate(d["fields"])}
    by_chain = collections.defaultdict(list); by_tt = collections.defaultdict(list); idx = {"SPY": [], "QQQ": []}
    for r in d["rows"]:
        rec = {k: r[f[k]] for k in FLOW_KEYS if k in f}
        t0 = ts(rec["created_at"]); rec["_t"] = t0
        by_chain[r[f["option_chain"]]].append(rec)
        by_tt[(rec["ticker"], rec["type"])].append(t0)
        if rec["ticker"] in idx and num(rec["underlying_price"]): idx[rec["ticker"]].append((t0, num(rec["underlying_price"])))
    for v in by_chain.values(): v.sort(key=lambda x: x["_t"])
    for v in by_tt.values(): v.sort()
    for k in idx: idx[k].sort()
    return by_chain, by_tt, idx
def at_print(series, t0):
    if not series: return None
    k = bisect.bisect_right([s[0] for s in series], t0) - 1
    return series[k][1] if k >= 0 and t0 - series[k][0] < 3600 else None

# ---------- candidates
rows = list(csv.DictReader(open(f"{H}/datasets/candidates.csv")))
chip_cols = [c for c in rows[0].keys() if c.startswith("chip_")]
rows.sort(key=lambda r: (r["day"], r["list"], r["contract"], r["printTimeUtc"]))
seen, uniq = set(), []
for r in rows:
    k = (r["day"], r["list"], r["contract"])
    if k in seen: continue
    seen.add(k); uniq.append(r)
print(f"{len(rows)} rows -> {len(uniq)} unique (day,list,contract)", flush=True)

by_day = collections.defaultdict(list)
for r in uniq: by_day[r["day"]].append(r)

out_cols = None
fo = gzip.open(OUT, "wt", newline="")
w = None
n_match = 0
for di, day in enumerate(sorted(by_day)):
    fl = load_flow(day)
    tide = load_tide(day)
    spy, qqq = daily_ctx("SPY", day), daily_ctx("QQQ", day)
    spy_down = (spy.get("vs_sma20") is not None and spy["vs_sma20"] < 0)
    pool = sorted(by_day[day], key=lambda r: r["printTimeUtc"] or "")
    pool_t = [(ts(r["printTimeUtc"]) if r["printTimeUtc"] else None, r) for r in pool]
    for r in by_day[day]:
        t0 = ts(r["printTimeUtc"]) if r["printTimeUtc"] else None
        tk, side = r["ticker"], r["side"]
        x = {"day": day, "list": r["list"], "contract": r["contract"], "ticker": tk, "side": side, "print": r["printTimeUtc"],
             "shown": int(truthy(r["shown"])), "outcome": r["outcome"], "t1": r["t1"], "t3": r["t3"],
             "is_put": int(side == "put"), "is_premove": int(r["list"] == "premove"), "locked": int(truthy(r["locked"])),
             "poolRank": num(r["poolRank"]), "capRank": num(r["capRank"]), "score": num(r["score"]), "rawScore": num(r["rawScore"]),
             "preActRaw": num(r["preActRaw"]), "dte": num(r["dte"]), "askShare": num(r["askShare"]),
             "log_premium": math.log10(num(r["premium"])) if (num(r["premium"]) or 0) > 0 else None,
             "log_volOi": math.log10(num(r["volOi"])) if (num(r["volOi"]) or 0) > 0 else None,
             "sweep": int(truthy(r["sweep"])), "entry": num(r["entry"]), "n_chips": len([c for c in (r["chips"] or "").split(";") if c])}
        for c in chip_cols: x[c] = num(r[c]) or 0.0
        # time of day (minutes after 9:30 ET), weekday
        if t0:
            et = datetime.fromtimestamp(t0, ET); x["min_from_open"] = (et.hour * 60 + et.minute) - 570; x["weekday"] = et.weekday()
        # flow alert match
        a = None; reps = None
        if fl and t0:
            cand = fl[0].get(r["contract"]) or []
            if cand:
                best = min(cand, key=lambda q: abs(q["_t"] - t0))
                if abs(best["_t"] - t0) <= 120: a = best
                reps = sum(1 for q in cand if q["_t"] < t0 - 1)
            tt = fl[1].get((tk, side)) or []
            x["ticker_side_alerts_before"] = bisect.bisect_left(tt, t0 - 1)
        x["repeat_hits_before"] = reps
        und = num(r["underlying"])
        if a:
            n_match += 1
            bid, ask = num(a.get("bid")), num(a.get("ask"))
            x["spread_pct"] = (ask - bid) / ((ask + bid) / 2) if bid is not None and ask and ask >= bid and (ask + bid) > 0 else None
            it = a.get("issue_type") or ""
            x["is_etf"] = int(bool(re.search("etf|index", it, re.I)))
            mc = num(a.get("marketcap")); x["log_mcap"] = math.log10(mc) if mc and mc > 0 else None
            x["trade_count"] = num(a.get("trade_count")); oi = num(a.get("open_interest")); x["log_oi"] = math.log10(oi + 1) if oi is not None else None
            x["log_size"] = math.log10((num(a.get("total_size")) or 0) + 1)
            x["has_floor"] = int(truthy(a.get("has_floor"))); x["has_multileg"] = int(truthy(a.get("has_multileg")))
            x["all_opening"] = int(truthy(a.get("all_opening_trades")))
            rule = (a.get("alert_rule") or "")
            x["rule_repeated"] = int("Repeat" in rule); x["rule_sweep"] = int("Sweep" in rule); x["rule_floor"] = int("Floor" in rule)
            tp = num(a.get("total_premium")) or 0; bsp = num(a.get("total_bid_side_prem")) or 0
            x["bidShare"] = bsp / tp if tp > 0 else None
            und = und or num(a.get("underlying_price"))
            strike = num(a.get("strike"))
        else:
            strike = None
        if strike is None:
            m = re.match(r"^[A-Z.]+(\d{6})([CP])(\d{8})$", r["contract"])
            if m: strike = int(m.group(3)) / 1000
        if "is_etf" not in x:
            x["is_etf"] = int(tk in {"SPY", "QQQ", "IWM", "DIA", "SMH", "XLF", "XLE", "GLD", "SLV", "TLT", "IBIT", "SOXL", "TQQQ", "SQQQ", "KRE", "XBI", "EEM", "FXI", "KWEB", "USO", "GDX", "EWZ", "ARKK", "HYG", "UVXY", "VXX"})
        if und and strike:
            x["otm_pct"] = ((strike / und - 1) if side == "call" else (1 - strike / und)) * 100
        # implied vol from entry price
        dte = num(r["dte"]) or 0
        iv = implied_vol(num(r["entry"]), und, strike, max(dte, 0.5) / 365, side == "call") if und and strike else None
        x["iv"] = iv
        # underlying context (prior bars only) + move at the print
        dc = daily_ctx(tk, day)
        pc = dc.get("pc")
        x["stock_vs_prev"] = (und / pc - 1) * 100 if und and pc else None
        x["stock_vs_open"] = (und / dc["open"] - 1) * 100 if und and dc.get("open") else None
        x["gap_pct"] = (dc["open"] / pc - 1) * 100 if dc.get("open") and pc else None
        for k in ("chg5", "vs_sma20", "rv20", "vs_hi20", "vs_lo20"): x["stock_" + k] = dc.get(k)
        x["iv_rv"] = iv / dc["rv20"] if iv and dc.get("rv20") else None
        # direction-aligned versions (positive = move in the trade's favour)
        sgn = 1 if side == "call" else -1
        for k in ("stock_vs_prev", "stock_vs_open", "gap_pct", "stock_chg5", "stock_vs_sma20"):
            x[k + "_dir"] = x[k] * sgn if x.get(k) is not None else None
        # market at the print
        for name, ctx, key in (("spy", spy, "SPY"), ("qqq", qqq, "QQQ")):
            px = at_print(fl[2][key], t0) if fl and t0 else None
            x[f"{name}_vs_prev"] = (px / ctx["pc"] - 1) * 100 if px and ctx.get("pc") else None
            x[f"{name}_vs_open"] = (px / ctx["open"] - 1) * 100 if px and ctx.get("open") else None
        x["spy_chg5"] = spy.get("chg5"); x["spy_vs_sma20"] = spy.get("vs_sma20"); x["spy_downtrend"] = int(spy_down)
        x["spy_vs_prev_dir"] = x["spy_vs_prev"] * sgn if x["spy_vs_prev"] is not None else None
        tr = tide_at(tide, t0) if t0 else None
        x["tide"] = tr; x["tide_dir"] = tr * sgn if tr is not None else None
        # earnings proximity
        eds = earn_dates(tk); exp = r["expiry"]
        nxt = next((e for e in eds if e >= day), None); prv = next((e for e in reversed(eds) if e < day), None)
        x["days_to_earn"] = days_between(day, nxt) if nxt else None
        x["days_since_earn"] = days_between(prv, day) if prv else None
        x["earn_before_exp"] = int(bool(nxt and nxt <= exp))
        # macro proximity
        k = bisect.bisect_left(MACRO, day)
        x["days_to_macro"] = days_between(day, MACRO[k]) if k < len(MACRO) else None
        x["macro_today"] = int(k < len(MACRO) and MACRO[k] == day)
        x["macro_before_exp"] = sum(1 for m in MACRO[k:k + 12] if m <= exp)
        x["fomc_before_exp"] = int(any(day <= f <= exp for f in FOMC))
        # same-day pool before the print (sector wave / breadth)
        sec = sector(tk)
        before = [q for tq, q in pool_t if tq is not None and t0 and tq < t0 - 1]
        x["pool_before"] = len(before)
        x["pool_same_side_issuers"] = len({issuer(q["ticker"]) for q in before if q["side"] == side})
        x["sector_wave"] = len({issuer(q["ticker"]) for q in before if q["side"] == side and sector(q["ticker"]) == sec and not sec.startswith("Other:")}) if not sec.startswith("Other:") else 0
        x["pool_call_share"] = (sum(1 for q in before if q["side"] == "call") / len(before)) if before else None
        x["sector_known"] = int(not sec.startswith("Other:"))
        if w is None:
            out_cols = list(x.keys())
            w = csv.DictWriter(fo, fieldnames=out_cols, extrasaction="ignore"); w.writeheader()
        w.writerow({k: ("" if x.get(k) is None else (round(x[k], 6) if isinstance(x[k], float) else x[k])) for k in out_cols})
    if di % 25 == 0: print(f"{day} ({di + 1}/{len(by_day)}) matched {n_match}", flush=True)
fo.close()
print("done", OUT, "flow-matched", n_match)
