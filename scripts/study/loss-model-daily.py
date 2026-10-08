#!/usr/bin/env python3
"""
TEST MODE daily log (no live effect, no UW calls): score each day's board with the study "chance of not winning" model
(LightGBM, label = not a +40%-before--25% winner in 3 sessions, all entry-time features, isotonic-calibrated) and record
the shadow worth_the_price verdict next to it.  Board = candidates in the site's shadow book for the day, read with
GET /api/shadow?readonly=1 (today) or ?day=YYYY-MM-DD (past) -- read-only, never triggers a refresh.
Features available live: candidate fields (score, chips, dte, ask share, premium, moneyness, entry, print time), IV backed
out of the print, stock/SPY/QQQ daily context (Yahoo daily bars, prior closes) and SPY/QQQ at the print (Yahoo 5-min),
earnings/macro calendar, sigma ratio (+40% in 3 sessions, same formula as the backtest). Flow-alert-only fields
(OI, trade count, market cap, spread, tide, same-day pool) are not in the shadow book -> the daily model is trained
WITHOUT them (a "live-rebuildable" version of the headline model); coverage is logged per row.
Usage:
  python loss-model-daily.py train            # fit + save study/loss-model-work/daily-model.pkl
  python loss-model-daily.py score [YYYY-MM-DD]
Output: /workspace/flowguard/study/loss-model-daily-YYYY-MM-DD.json
"""
import bisect, json, math, os, pickle, re, sys, time, urllib.request
from datetime import datetime, date, timedelta, timezone
from zoneinfo import ZoneInfo
import numpy as np, pandas as pd

ROOT = "/workspace/flowguard"; W = f"{ROOT}/study/loss-model-work"; MODEL = f"{W}/daily-model.pkl"
SITE = "https://flowguard-zeta.vercel.app"; ET = ZoneInfo("America/New_York")
SPLIT = "2025-10-01"

LIVE_MISSING = {"spread_pct", "log_mcap", "trade_count", "log_oi", "log_size", "has_floor", "has_multileg", "all_opening",
                "rule_repeated", "rule_sweep", "rule_floor", "bidShare", "tide", "tide_dir", "pool_before", "pool_same_side_issuers",
                "sector_wave", "pool_call_share", "sector_known", "poolRank", "preActRaw", "log_volOi", "ticker_side_alerts_before",
                "repeat_hits_before", "locked"}
def train():
    import lightgbm as lgb
    from sklearn.isotonic import IsotonicRegression
    df = pd.read_csv(f"{ROOT}/study/loss-model-features.csv.gz", low_memory=False)
    sr = pd.read_csv(f"{W}/sigma-ratio.csv.gz"); df = df.merge(sr, on=["day", "list", "contract"], how="left")
    df["sigma_ratio"] = df.sigma_ratio.replace([np.inf], 9.0).clip(upper=9.0)
    df = df[df.outcome.isin(["winner", "loser", "flat"])].copy()
    df["y"] = (df.outcome != "winner").astype(int)
    df["log_entry"] = np.log10(df.entry.clip(lower=0.01))
    drop = {"day", "list", "contract", "ticker", "side", "print", "shown", "outcome", "t1", "t3", "y", "entry", "capRank", "weekday"}
    feats = [c for c in df.columns if c not in drop and pd.api.types.is_numeric_dtype(df[c])]
    feats = [c for c in feats if df[c].notna().mean() > 0.05 and df[c].nunique() > 1]
    # Keep only features the daily job can rebuild from the shadow book + Yahoo + calendars (tested: scoring the full
    # model with the flow-alert/tide/pool fields left blank shifted scores up ~13 pts and broke the ranking, corr 0.56).
    feats = [c for c in feats if c not in LIVE_MISSING]
    y1 = df[df.day < SPLIT]; clips = {}
    for c in feats:
        if df[c].nunique() > 10:
            clips[c] = (float(y1[c].quantile(0.002)), float(y1[c].quantile(0.998))); df[c] = df[c].clip(*clips[c])
    P = dict(n_estimators=300, learning_rate=0.03, num_leaves=8, max_depth=3, min_child_samples=200, subsample=0.8,
             subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0, n_jobs=1, verbose=-1)
    from sklearn.metrics import roc_auc_score
    a, b = df[df.day < SPLIT], df[df.day >= SPLIT]
    chk = lgb.LGBMClassifier(**P).fit(a[feats], a.y); auc_y2 = float(roc_auc_score(b.y, chk.predict_proba(b[feats])[:, 1]))
    bb = b[b.shown == 1]; auc_y2_board = float(roc_auc_score(bb.y, chk.predict_proba(bb[feats])[:, 1])) if bb.y.nunique() > 1 else None
    print("train y1 -> test y2 AUC", round(auc_y2, 3), "board", auc_y2_board)
    df = df.sort_values("day"); cut = int(len(df) * 0.85)
    m_a = lgb.LGBMClassifier(**P).fit(df[feats].iloc[:cut], df.y.iloc[:cut])
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.01, y_max=0.99).fit(m_a.predict_proba(df[feats].iloc[cut:])[:, 1], df.y.iloc[cut:])
    m = lgb.LGBMClassifier(**P).fit(df[feats], df.y)
    board = df[df.shown == 1]; pb = iso.predict(m.predict_proba(board[feats])[:, 1])
    q = {f"riskiest_{k}pct_cut": float(np.quantile(pb, 1 - k / 100)) for k in (10, 20, 30)}
    pickle.dump({"model": m, "iso": iso, "feats": feats, "clips": clips, "board_quantiles": q, "trained_rows": len(df),
                 "trained_through": df.day.max(), "label": "not_winner",
                 "check_auc_train_y1_test_y2": round(auc_y2, 3), "check_auc_y2_board": None if auc_y2_board is None else round(auc_y2_board, 3)}, open(MODEL, "wb"))
    print("saved", MODEL, len(df), "rows", len(feats), "features", q)

# ---------------- live features
def get(url, tries=3):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (flowguard study, read-only)"})
            return json.load(urllib.request.urlopen(req, timeout=30))
        except Exception as e:
            if k == tries - 1: raise
            time.sleep(3 * (k + 1))
_yd = {}
def ydaily(t):
    if t in _yd: return _yd[t]
    try:
        r = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{t.replace('.', '-')}?range=6mo&interval=1d")["chart"]["result"][0]
        q = r["indicators"]["quote"][0]; out = []
        for i, tt in enumerate(r["timestamp"]):
            if None in (q["open"][i], q["high"][i], q["low"][i], q["close"][i]): continue
            out.append({"date": datetime.fromtimestamp(tt, ET).date().isoformat(), "o": q["open"][i], "h": q["high"][i], "l": q["low"][i], "c": q["close"][i]})
    except Exception:
        out = []
    _yd[t] = out; return out
_yi = {}
def yintraday(t, day):
    k = (t, day)
    if k in _yi: return _yi[k]
    out = []
    try:
        d0 = datetime.fromisoformat(day).replace(tzinfo=ET); p1 = int(d0.timestamp()); p2 = p1 + 86400
        r = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{t}?period1={p1}&period2={p2}&interval=5m")["chart"]["result"][0]
        cl = r["indicators"]["quote"][0]["close"]
        out = [(tt, c) for tt, c in zip(r["timestamp"], cl) if c is not None]
    except Exception:
        pass
    _yi[k] = out; return out
def daily_ctx(t, day):
    b = ydaily(t); ds = [x["date"] for x in b]; i = bisect.bisect_left(ds, day); out = {}
    if i == 0: return out
    pc = b[i - 1]["c"]; out["pc"] = pc
    if i < len(b) and ds[i] == day: out["open"] = b[i]["o"]
    closes = [x["c"] for x in b[max(0, i - 21):i]]
    if len(closes) >= 6: out["chg5"] = (pc / closes[-6] - 1) * 100
    if len(closes) >= 21:
        out["vs_sma20"] = (pc / (sum(closes[-20:]) / 20) - 1) * 100
        rets = [math.log(closes[k] / closes[k - 1]) for k in range(1, len(closes))]; mu = sum(rets) / len(rets)
        out["rv20"] = math.sqrt(sum((r - mu) ** 2 for r in rets) / (len(rets) - 1)) * math.sqrt(252)
        hi = max(x["h"] for x in b[i - 20:i]); lo = min(x["l"] for x in b[i - 20:i])
        out["vs_hi20"] = (pc / hi - 1) * 100; out["vs_lo20"] = (pc / lo - 1) * 100
    return out
N = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))
def bs(S, K, T, s, call):
    if s <= 0 or T <= 0: return max(0.0, (S - K) if call else (K - S))
    d1 = (math.log(S / K) + 0.5 * s * s * T) / (s * math.sqrt(T)); d2 = d1 - s * math.sqrt(T)
    return S * N(d1) - K * N(d2) if call else K * N(-d2) - S * N(-d1)
def implied_vol(px, S, K, T, call):
    if not (px and S and K and T and px > 0 and S > 0 and K > 0 and T > 0): return None
    if px <= max(0.0, (S - K) if call else (K - S)) + 1e-4: return None
    lo, hi = 0.01, 6.0
    if bs(S, K, T, hi, call) < px: return None
    for _ in range(60):
        mid = (lo + hi) / 2
        if bs(S, K, T, mid, call) > px: hi = mid
        else: lo = mid
    return (lo + hi) / 2
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
FOMC = ["2026-10-28", "2026-12-09", "2027-01-27", "2027-03-17"]
CPI = ["2026-10-14", "2026-11-12", "2026-12-10", "2027-01-13"]
def first_fridays():
    out = []
    for y in (2026, 2027):
        for m in range(1, 13):
            d = date(y, m, 1)
            while d.weekday() != 4: d += timedelta(days=1)
            out.append(d.isoformat())
    return out
MACRO = sorted(set(FOMC + CPI + first_fridays()))
def dbetween(a, b): return (date.fromisoformat(b) - date.fromisoformat(a)).days
ETF = {"SPY", "QQQ", "IWM", "DIA", "SMH", "XLF", "XLE", "GLD", "SLV", "TLT", "IBIT", "SOXL", "TQQQ", "SQQQ", "KRE", "XBI", "EEM", "FXI",
       "KWEB", "USO", "GDX", "EWZ", "ARKK", "HYG", "UVXY", "VXX", "XLK", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLC", "XLRE", "SPX", "SPXW", "NDX", "RUT", "VIX"}

def features(c, day, spy, qqq):
    x = {}; side = c["side"]; call = side == "call"; sgn = 1 if call else -1
    lanes = c.get("lanes") or []
    x["is_put"] = int(not call); x["is_premove"] = int("premove" in lanes and "picks" not in lanes)
    for k, src in (("score", "score"), ("rawScore", "rawScore"), ("dte", "dte"), ("askShare", "askSharePct")): x[k] = c.get(src)
    if c.get("premiumUsd"): x["log_premium"] = math.log10(c["premiumUsd"])
    chips = c.get("chips") or []; x["n_chips"] = len(chips)
    for ch in chips:
        m = re.match(r"^(.*)\(([+-]?\d+)\)$", ch)
        if m: x["chip_" + m.group(1)] = float(m.group(2))
    x["sweep"] = int(any(ch.startswith("sweep") for ch in chips))
    t0 = None
    if c.get("printTimeUtc"):
        t0 = datetime.fromisoformat(c["printTimeUtc"].replace("Z", "+00:00")).timestamp()
        et = datetime.fromtimestamp(t0, ET); x["min_from_open"] = et.hour * 60 + et.minute - 570
    S, K, entry = c.get("underlying"), c.get("strike"), c.get("optionPrint")
    x["is_etf"] = int(c["ticker"] in ETF)
    if S and K: x["otm_pct"] = ((K / S - 1) if call else (1 - K / S)) * 100
    if entry: x["log_entry"] = math.log10(max(entry, 0.01))
    dte = c.get("dte") or 0
    iv = implied_vol(entry, S, K, max(dte, 0.5) / 365, call) if S and K else None; x["iv"] = iv
    dc = daily_ctx(c["ticker"], day); pc = dc.get("pc")
    x["stock_vs_prev"] = (S / pc - 1) * 100 if S and pc else None
    x["stock_vs_open"] = (S / dc["open"] - 1) * 100 if S and dc.get("open") else None
    x["gap_pct"] = (dc["open"] / pc - 1) * 100 if dc.get("open") and pc else None
    for k in ("chg5", "vs_sma20", "rv20", "vs_hi20", "vs_lo20"): x["stock_" + k] = dc.get(k)
    x["iv_rv"] = iv / dc["rv20"] if iv and dc.get("rv20") else None
    for k in ("stock_vs_prev", "stock_vs_open", "gap_pct", "stock_chg5", "stock_vs_sma20"):
        x[k + "_dir"] = x[k] * sgn if x.get(k) is not None else None
    for name, ctx, tk in (("spy", spy, "SPY"), ("qqq", qqq, "QQQ")):
        px = None
        if t0:
            ser = yintraday(tk, day); kk = bisect.bisect_right([s[0] for s in ser], t0) - 1
            if kk >= 0 and t0 - ser[kk][0] < 3600: px = ser[kk][1]
        x[f"{name}_vs_prev"] = (px / ctx["pc"] - 1) * 100 if px and ctx.get("pc") else None
        x[f"{name}_vs_open"] = (px / ctx["open"] - 1) * 100 if px and ctx.get("open") else None
    x["spy_chg5"] = spy.get("chg5"); x["spy_vs_sma20"] = spy.get("vs_sma20")
    x["spy_downtrend"] = int(spy.get("vs_sma20") is not None and spy["vs_sma20"] < 0)
    x["spy_vs_prev_dir"] = x["spy_vs_prev"] * sgn if x.get("spy_vs_prev") is not None else None
    exp = c.get("expiry") or day
    ep = f"{ROOT}/history/earnings/{c['ticker']}.json"
    if os.path.exists(ep):
        try:
            eds = sorted({r["date"] for r in json.load(open(ep)).get("rows", []) if r.get("date")})
            nxt = next((e for e in eds if e >= day), None); prv = next((e for e in reversed(eds) if e < day), None)
            x["days_to_earn"] = dbetween(day, nxt) if nxt else None; x["days_since_earn"] = dbetween(prv, day) if prv else None
            x["earn_before_exp"] = int(bool(nxt and nxt <= exp))
        except Exception: pass
    k = bisect.bisect_left(MACRO, day)
    x["days_to_macro"] = dbetween(day, MACRO[k]) if k < len(MACRO) else None
    x["macro_today"] = int(k < len(MACRO) and MACRO[k] == day)
    x["macro_before_exp"] = sum(1 for m in MACRO[k:k + 12] if m <= exp)
    x["fomc_before_exp"] = int(any(day <= f <= exp for f in FOMC))
    # sigma ratio (+40% in 3 sessions), same as the backtest
    if S and K and iv and dc.get("rv20") and entry:
        texit = max(1, dte - math.ceil(3 * 7 / 5)) / 365
        Ss = spot_for(entry * 1.4, S, K, texit, iv, call)
        x["sigma_ratio"] = 9.0 if Ss is None else min(9.0, abs(Ss / S - 1) / (dc["rv20"] * math.sqrt(3 / 252)))
    return x

def score(day):
    M = pickle.load(open(MODEL, "rb")); feats = M["feats"]
    today = datetime.now(ET).date().isoformat()
    url = f"{SITE}/api/shadow?readonly=1" if day == today else f"{SITE}/api/shadow?day={day}"
    doc = get(url)
    if doc.get("day") and doc["day"] != day:
        print("shadow book day", doc.get("day"), "!= requested", day); return None
    cands = doc.get("candidates") or []; verdicts = doc.get("verdicts") or {}
    spy, qqq = daily_ctx("SPY", day), daily_ctx("QQQ", day)
    out_rows = []
    for c in cands:
        x = features(c, day, spy, qqq)
        row = {f: (x.get(f) if x.get(f) is not None else np.nan) for f in feats}
        X = pd.DataFrame([row])[feats].astype(float)
        for f, (lo, hi) in M["clips"].items():
            if f in X: X[f] = X[f].clip(lo, hi)
        raw = float(M["model"].predict_proba(X)[:, 1][0]); p = float(M["iso"].predict([raw])[0])
        wtp = next((v for v in verdicts.get(c["contract"], []) if v.get("module") == "worth_the_price"), None)
        q = M["board_quantiles"]
        out_rows.append({
            "contract": c["contract"], "ticker": c["ticker"], "side": c["side"], "lanes": c.get("lanes"), "score": c.get("score"),
            "print_time_utc": c.get("printTimeUtc"), "entry": c.get("optionPrint"), "exit_plan": c.get("exitPlan"),
            "loss_model": {"p_not_win": round(p, 4), "p_win": round(1 - p, 4), "raw": round(raw, 4),
                           "riskiest_bucket": ("top10%" if p >= q["riskiest_10pct_cut"] else "top20%" if p >= q["riskiest_20pct_cut"]
                                               else "top30%" if p >= q["riskiest_30pct_cut"] else "rest"),
                           "features_present": int(sum(1 for f in feats if not pd.isna(row[f]))), "features_total": len(feats),
                           "sigma_ratio_40pct": None if pd.isna(row.get("sigma_ratio", np.nan)) else round(row["sigma_ratio"], 3)},
            "worth_the_price": None if not wtp else {k: wtp.get(k) for k in ("verdict", "score", "reason", "data")},
        })
    res = {"day": day, "mode": "TEST ONLY - logged for the study, never changes any live list", "generated_at_ct": datetime.now(ZoneInfo("America/Chicago")).isoformat(timespec="seconds"),
           "source": url, "model": {"label": M["label"], "trained_rows": M["trained_rows"], "trained_through": M["trained_through"],
           "features": "live-rebuildable subset (no flow-alert/tide/pool fields)", "check_auc_train_y1_test_y2": M.get("check_auc_train_y1_test_y2"),
           "check_auc_y2_board": M.get("check_auc_y2_board"),
           "board_quantiles": M["board_quantiles"]},
           "note": "p_not_win = calibrated chance the pick does NOT hit +40% before -25% within 3 sessions, from a study model trained "
                   "only on features rebuildable from the shadow book (no flow-alert OI/spread/market cap/tide/pool). "
                   "worth_the_price = the site's shadow verdict as stored (it uses the live exit plan's target).",
           "candidates": out_rows}
    path = f"{ROOT}/study/loss-model-daily-{day}.json"
    json.dump(res, open(path, "w"), indent=1, default=float); print("saved", path, len(out_rows), "candidates")
    return path

if __name__ == "__main__":
    if sys.argv[1] == "train": train()
    else: score(sys.argv[2] if len(sys.argv) > 2 else datetime.now(ET).date().isoformat())
