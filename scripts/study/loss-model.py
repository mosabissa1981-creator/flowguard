#!/usr/bin/env python3
"""
TEST MODE study: "chance of losing" model on the 2-year replay candidates (features from loss-model-features.py).
Label: loser = -25% hit before +40% within 3 sessions. Walk-forward: each month of year 2 (from 2025-10-01) is scored
by models trained only on rows >= 7 calendar days before the month starts (embargo for the 3-session outcome).
Reverse check: train on all of year 2, score year 1. Models: logistic regression (standardized, median-imputed +
missing flags) and LightGBM (shallow trees, 1 thread); isotonic calibration on the last 15% of each training window.
Practical table on the live board (shown rows): drop the riskiest 10/20/30%.
Run niced, single thread:  nice -n 10 .venv-ml/bin/python scripts/study/loss-model.py
"""
import json, math, os, sys, warnings
from datetime import date, timedelta
import numpy as np, pandas as pd
import lightgbm as lgb
from sklearn.linear_model import LogisticRegression
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score, brier_score_loss
warnings.filterwarnings("ignore")

FEAT = os.environ.get("FEAT", "/workspace/flowguard/study/loss-model-features.csv.gz")
OUT = sys.argv[1] if len(sys.argv) > 1 else "/workspace/flowguard/study/loss-model-work/model-results.json"
PRED_OUT = os.environ.get("PRED_OUT", "/workspace/flowguard/study/loss-model-work/predictions.csv.gz")
SPLIT = "2025-10-01"
EMBARGO_DAYS = 7
SPREAD_MAX = 0.10

df = pd.read_csv(FEAT, low_memory=False)
if os.environ.get("ADD_SIGMA"):
    sr = pd.read_csv("/workspace/flowguard/study/loss-model-work/sigma-ratio.csv.gz")
    df = df.merge(sr, on=["day", "list", "contract"], how="left")
    df["sigma_ratio"] = df.sigma_ratio.replace([np.inf], 9.0).clip(upper=9.0)
df = df[df.outcome.isin(["winner", "loser", "flat"])].copy()
# LABEL=loser (default): risk = P(loser). LABEL=notwin: risk = 1 - P(winner) (flats count as misses).
LABEL = os.environ.get("LABEL", "loser")
df["y"] = ((df.outcome == "loser") if LABEL == "loser" else (df.outcome != "winner")).astype(int)
df["win"] = (df.outcome == "winner").astype(int)
def gross(r):
    if r.outcome == "winner": return 0.40
    if r.outcome == "loser": return -0.25
    t = r.t3 if pd.notna(r.t3) else r.t1
    return max(-0.25, min(0.40, (t if pd.notna(t) else 0) / 100))
df["gross"] = df.apply(gross, axis=1)
sp = df.spread_pct.where(df.spread_pct.between(0, 2))
df["spread_used"] = sp.fillna(sp.median())
df["net"] = (1 + df.gross) * (1 - df.spread_used / 2) / (1 + df.spread_used / 2) - 1
df["year"] = np.where(df.day < SPLIT, "y1", "y2")
df["log_entry"] = np.log10(df.entry.clip(lower=0.01))
df["month"] = df.day.str[:7]

DROP = {"day", "list", "contract", "ticker", "side", "print", "shown", "outcome", "t1", "t3", "y", "win", "gross", "net",
        "spread_used", "year", "month", "entry", "capRank", "weekday"}
FEATS = [c for c in df.columns if c not in DROP and pd.api.types.is_numeric_dtype(df[c])]
FEATS = [c for c in FEATS if df[c].notna().mean() > 0.05 and df[c].nunique() > 1]
import re as _re
if os.environ.get("EXCLUDE_RE"): FEATS = [c for c in FEATS if not _re.search(os.environ["EXCLUDE_RE"], c)]
# Winsorize with year-1 quantiles only (bad split-adjusted bars produce a few absurd stock moves).
y1 = df[df.year == "y1"]
for c in FEATS:
    if df[c].nunique() > 10:
        lo, hi = y1[c].quantile(0.002), y1[c].quantile(0.998)
        df[c] = df[c].clip(lo, hi)
print(len(df), "scored rows;", len(FEATS), "features", flush=True)

# ---------- models
class LR:
    def fit(self, X, y):
        self.med = X.median(); self.miss = [c for c in X.columns if X[c].isna().mean() > 0.01]
        Z = self._prep(X, fit=True)
        self.m = LogisticRegression(C=0.05, max_iter=2000).fit(Z, y); return self
    def _prep(self, X, fit=False):
        Z = X.fillna(self.med)
        for c in self.miss: Z[c + "_na"] = X[c].isna().astype(float)
        if fit: self.mu, self.sd = Z.mean(), Z.std().replace(0, 1)
        return ((Z - self.mu) / self.sd).values
    def predict(self, X): return self.m.predict_proba(self._prep(X))[:, 1]
    def coefs(self):
        names = list(self.mu.index); return dict(zip(names, self.m.coef_[0]))
class GBM:
    P = dict(n_estimators=300, learning_rate=0.03, num_leaves=8, max_depth=3, min_child_samples=200, subsample=0.8,
             subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0, n_jobs=1, verbose=-1)
    def fit(self, X, y): self.m = lgb.LGBMClassifier(**self.P).fit(X, y); return self
    def predict(self, X): return self.m.predict_proba(X)[:, 1]
    def gains(self): return dict(zip(self.m.booster_.feature_name(), self.m.booster_.feature_importance("gain")))
MODELS = {"logistic": LR, "lightgbm": GBM}
if os.environ.get("ONLY"): MODELS = {k: v for k, v in MODELS.items() if k == os.environ["ONLY"]}

def fit_calibrated(kind, tr):
    tr = tr.sort_values("day"); cut = int(len(tr) * 0.85)
    a, b = tr.iloc[:cut], tr.iloc[cut:]
    m_a = MODELS[kind]().fit(a[FEATS], a.y)
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0.01, y_max=0.99).fit(m_a.predict(b[FEATS]), b.y)
    m = MODELS[kind]().fit(tr[FEATS], tr.y)
    return m, iso

# ---------- walk-forward over year 2 + reverse
preds = []
fold_info = []
y2_months = sorted(df[df.year == "y2"].month.unique())
for kind in MODELS:
    for mo in y2_months:
        start = date.fromisoformat(mo + "-01")
        tr = df[df.day < (start - timedelta(days=EMBARGO_DAYS)).isoformat()]
        te = df[df.month == mo]
        m, iso = fit_calibrated(kind, tr)
        raw = m.predict(te[FEATS])
        p = pd.DataFrame({"idx": te.index, "model": kind, "scheme": "walkforward_y2", "raw": raw, "p": iso.predict(raw)})
        # in-sample board predictions of this fold (for the live-feasible threshold)
        trb = tr[tr.shown == 1]
        tr_board_p = iso.predict(m.predict(trb[FEATS])) if len(trb) else np.array([])
        fold_info.append({"model": kind, "month": mo, "train_rows": len(tr), "test_rows": len(te),
                          "train_board_q": {q: float(np.quantile(tr_board_p, 1 - q)) for q in (0.1, 0.2, 0.3)} if len(trb) else None})
        preds.append(p)
        print(kind, mo, len(tr), len(te), flush=True)
    tr, te = df[df.year == "y2"], df[df.year == "y1"]
    m, iso = fit_calibrated(kind, tr)
    raw = m.predict(te[FEATS])
    preds.append(pd.DataFrame({"idx": te.index, "model": kind, "scheme": "reverse_y1", "raw": raw, "p": iso.predict(raw)}))
    # full-data model for feature importance
    full = MODELS[kind]().fit(df[FEATS], df.y)
    if kind == "lightgbm": gains = full.gains()
    else: coefs = full.coefs()
    print(kind, "reverse + full done", flush=True)
gains = globals().get("gains") or {"n/a": 1.0}; coefs = globals().get("coefs") or {"n/a": 0.0}
P = pd.concat(preds).merge(df, left_on="idx", right_index=True)
P[["idx", "model", "scheme", "raw", "p", "day", "list", "contract", "ticker", "side", "shown", "outcome", "net", "gross", "year"]].to_csv(PRED_OUT, index=False)

# ---------- evaluation
def z2(k1, n1, k2, n2):
    if min(n1, n2) == 0: return None
    p = (k1 + k2) / (n1 + n2); se = math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
    return round((k1 / n1 - k2 / n2) / se, 2) if se > 0 else None
def stats(g, days):
    n = len(g)
    if n == 0: return {"n": 0}
    return {"n": n, "win_pct": round(100 * g.win.mean(), 1), "loss_pct": round(100 * g.y.mean(), 1),
            "avg_net_pct": round(100 * g.net.mean(), 2), "avg_gross_pct": round(100 * g.gross.mean(), 2),
            "avg_loss_pct": round(100 * g[g.net < 0].net.mean(), 2) if (g.net < 0).any() else None,
            "picks_per_day": round(n / days, 2)}
def drop_table(g, score_col, thresholds=None):
    days = g.day.nunique(); base = stats(g, days); out = {"baseline": base}
    for q in (0.1, 0.2, 0.3):
        thr = thresholds[q] if thresholds is not None else g[score_col].quantile(1 - q)
        keep = g[g[score_col] < thr] if thresholds is not None else g[g[score_col].rank(method="first") <= len(g) * (1 - q)]
        dropd = g.drop(keep.index)
        s = stats(keep, days)
        s["pct_kept"] = round(100 * len(keep) / len(g), 1)
        s["winners_kept_pct"] = round(100 * keep.win.sum() / max(1, g.win.sum()), 1)
        s["dropped_win_pct"] = round(100 * dropd.win.mean(), 1) if len(dropd) else None
        s["dropped_avg_net_pct"] = round(100 * dropd.net.mean(), 2) if len(dropd) else None
        s["z_win_kept_vs_dropped"] = z2(keep.win.sum(), len(keep), dropd.win.sum(), len(dropd))
        out[f"drop_riskiest_{int(q * 100)}pct"] = s
    return out
def auc(g, col="p"):
    r = {}
    if g.y.nunique() == 2: r["auc_loser"] = round(roc_auc_score(g.y, g[col]), 3)
    if g.win.nunique() == 2: r["auc_winner_inverse"] = round(roc_auc_score(1 - g.win, g[col]), 3)
    r["brier"] = round(brier_score_loss(g.y, g.p.clip(0, 1)), 4); r["base_loss_rate"] = round(g.y.mean(), 3); r["n"] = len(g)
    return r
def calib(g):
    g = g.copy(); g["bin"] = pd.qcut(g.p.rank(method="first"), 10, labels=False)
    return [{"decile": int(b) + 1, "pred_loss_pct": round(100 * x.p.mean(), 1), "actual_loss_pct": round(100 * x.y.mean(), 1),
             "actual_win_pct": round(100 * x.win.mean(), 1), "n": len(x)} for b, x in g.groupby("bin")]

res = {"features": FEATS, "rows_scored": len(df), "split": SPLIT, "embargo_days": EMBARGO_DAYS, "models": {}}
for kind in MODELS:
    R = {}
    for scheme in ("walkforward_y2", "reverse_y1"):
        g = P[(P.model == kind) & (P.scheme == scheme)].copy()
        board = g[g.shown == 1].copy()
        live = board[~((board.side == "put") & (df.loc[board.idx, "is_etf"].values == 0)) & ~(df.loc[board.idx, "spread_pct"].values > SPREAD_MAX)]
        # benchmark: drop lowest rawScore (higher = riskier proxy)
        board["neg_raw"] = -df.loc[board.idx, "rawScore"].fillna(0).values + np.random.RandomState(0).rand(len(board)) * 1e-6
        R[scheme] = {
            "auc_all_candidates": auc(g), "auc_board": auc(board), "auc_live_rules_board": auc(live),
            "calibration_all": calib(g), "calibration_board": calib(board) if len(board) >= 50 else None,
            "board_drop_table_by_year_quantile": drop_table(board, "p"),
            "live_rules_board_drop_table": drop_table(live, "p"),
            "benchmark_drop_lowest_rawScore": drop_table(board, "neg_raw"),
            "monthly_auc_board": {m: auc(x)["auc_loser"] if x.y.nunique() == 2 else None for m, x in board.groupby(board.day.str[:7])},
        }
        if scheme == "walkforward_y2":
            # live-feasible thresholds: each month uses the quantile of its own training-window board predictions
            fi = {f["month"]: f["train_board_q"] for f in fold_info if f["model"] == kind}
            rows = []
            for m, x in board.groupby(board.day.str[:7]):
                q = fi.get(m)
                for qq in (0.1, 0.2, 0.3):
                    x = x.assign(**{f"keep{int(qq * 100)}": x.p < q[qq]})
                rows.append(x)
            B = pd.concat(rows); days = B.day.nunique(); t = {"baseline": stats(B, days)}
            for qq in (10, 20, 30):
                k = B[B[f"keep{qq}"]]; d = B[~B[f"keep{qq}"]]
                s = stats(k, days); s["pct_kept"] = round(100 * len(k) / len(B), 1)
                s["winners_kept_pct"] = round(100 * k.win.sum() / max(1, B.win.sum()), 1)
                s["dropped_win_pct"] = round(100 * d.win.mean(), 1) if len(d) else None
                s["z_win_kept_vs_dropped"] = z2(k.win.sum(), len(k), d.win.sum(), len(d))
                t[f"drop_above_train_q{qq}"] = s
            R[scheme]["board_drop_table_live_feasible_thresholds"] = t
    res["models"][kind] = R
imp = sorted(gains.items(), key=lambda kv: -kv[1])
res["lightgbm_top_gain"] = [[k, round(v / sum(gains.values()) * 100, 1)] for k, v in imp[:25]]
res["logistic_top_coefs"] = [[k, round(v, 3)] for k, v in sorted(coefs.items(), key=lambda kv: -abs(kv[1]))[:25]]
# plain-words direction: loss rate in top vs bottom quintile of each top feature (all scored rows)
dirs = {}
for k, _ in [kv for kv in imp if kv[0] in df.columns][:15]:
    s = df[k]
    if s.nunique() <= 2:
        a, b = df[s == s.max()], df[s == s.min()]
        dirs[k] = {"high": round(100 * a.y.mean(), 1), "low": round(100 * b.y.mean(), 1), "n_high": len(a), "n_low": len(b), "binary": True}
    else:
        qs = s.quantile([0.2, 0.8]); a, b = df[s >= qs[0.8]], df[s <= qs[0.2]]
        dirs[k] = {"top20_loss_pct": round(100 * a.y.mean(), 1), "bottom20_loss_pct": round(100 * b.y.mean(), 1),
                   "top20_win_pct": round(100 * a.win.mean(), 1), "bottom20_win_pct": round(100 * b.win.mean(), 1),
                   "q20": round(float(qs[0.2]), 3), "q80": round(float(qs[0.8]), 3)}
res["feature_direction"] = dirs
res["fold_info"] = fold_info
json.dump(res, open(OUT, "w"), indent=1, default=float)
print("saved", OUT)
