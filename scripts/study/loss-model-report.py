#!/usr/bin/env python3
"""Build /workspace/flowguard/study/loss-model-report.json from the loss-model runs (TEST MODE study, no live effect)."""
import json, math, os
import numpy as np, pandas as pd
W = "/workspace/flowguard/study/loss-model-work"; S = "/workspace/flowguard/study"
OUT = f"{S}/loss-model-report.json"
feat = pd.read_csv(f"{S}/loss-model-features.csv.gz", usecols=["day", "list", "contract", "is_etf", "spread_pct"], low_memory=False)
RUNS = {
    "A_loser_lgbm_all_features": ("model-results.json", "predictions.csv.gz", "lightgbm"),
    "A_loser_logistic_all_features": ("model-results.json", "predictions.csv.gz", "logistic"),
    "B_loser_lgbm_no_market_features": ("model-results-nomarket.json", "pred-nomarket.csv.gz", "lightgbm"),
    "C_notwin_lgbm_all_features": ("model-results-notwin-nosigma.json", "pred-notwin-nosigma.csv.gz", "lightgbm"),
    "D_notwin_lgbm_plus_sigma_ratio": ("model-results-notwin.json", "pred-notwin.csv.gz", "lightgbm"),
    "E_notwin_lgbm_no_market_plus_sigma": ("model-results-notwin-nomarket.json", "pred-notwin-nomarket.csv.gz", "lightgbm"),
    "F_notwin_logistic_plus_sigma": ("model-results-notwin-lr.json", "pred-notwin-lr.csv.gz", "logistic"),
}
HEADLINE = "C_notwin_lgbm_all_features"
rng = np.random.RandomState(7)

def metrics(g, days):
    n = len(g)
    return {"n": n, "win_pct": round(100 * (g.outcome == "winner").mean(), 1), "loss_pct": round(100 * (g.outcome == "loser").mean(), 1),
            "avg_net_pct_ask_bid": round(100 * g.net.mean(), 2), "avg_loss_pct": round(100 * g[g.net < 0].net.mean(), 2),
            "picks_per_day": round(n / days, 2)}
def table(g):
    days = g.day.nunique(); base = metrics(g, days); out = {"baseline": base}
    g = g.assign(r=g.p.rank(method="first"))
    dl = sorted(g.day.unique()); idx = {d: g.index[g.day == d] for d in dl}
    for q in (0.1, 0.2, 0.3):
        keep = g[g.r <= len(g) * (1 - q)]
        m = metrics(keep, days)
        m["winners_kept_pct"] = round(100 * (keep.outcome == "winner").sum() / max(1, (g.outcome == "winner").sum()), 1)
        m["win_lift_pts"] = round(m["win_pct"] - base["win_pct"], 1)
        m["net_lift_pts"] = round(m["avg_net_pct_ask_bid"] - base["avg_net_pct_ask_bid"], 2)
        # day-clustered bootstrap of the win-rate lift (threshold fixed)
        kept_flag = g.r <= len(g) * (1 - q); lifts = []
        win = (g.outcome == "winner").values; kf = kept_flag.values
        pos = {d: np.where(g.day.values == d)[0] for d in dl}
        for _ in range(400):
            pick = np.concatenate([pos[d] for d in rng.choice(dl, len(dl))])
            w, k = win[pick], kf[pick]
            if k.sum(): lifts.append(100 * (w[k].mean() - w.mean()))
        m["win_lift_95ci"] = [round(float(np.percentile(lifts, 2.5)), 1), round(float(np.percentile(lifts, 97.5)), 1)]
        out[f"drop_riskiest_{int(q * 100)}pct"] = m
    return out

report = {"runs": {}}
for name, (rf, pf, kind) in RUNS.items():
    if not (os.path.exists(f"{W}/{rf}") and os.path.exists(f"{W}/{pf}")): continue
    R = json.load(open(f"{W}/{rf}"))
    if kind not in R["models"]: continue
    P = pd.read_csv(f"{W}/{pf}"); P = P[P.model == kind].merge(feat, on=["day", "list", "contract"], how="left")
    run = {}
    for scheme, label in (("walkforward_y2", "held_out_year2_walkforward"), ("reverse_y1", "reverse_check_year1")):
        g = P[P.scheme == scheme]; b = g[g.shown == 1]
        live = b[~((b.side == "put") & (b.is_etf == 0)) & ~(b.spread_pct > 0.10)]
        x = R["models"][kind][scheme]
        run[label] = {"auc": {"all_candidates": x["auc_all_candidates"], "board": x["auc_board"], "board_under_current_live_rules": x["auc_live_rules_board"]},
                      "board_table": table(b), "board_under_current_live_rules_table": table(live)}
        if scheme == "walkforward_y2":
            run[label]["board_table_live_feasible_thresholds"] = x.get("board_drop_table_live_feasible_thresholds")
            run[label]["monthly_auc_board"] = x.get("monthly_auc_board")
            run[label]["calibration_board"] = x.get("calibration_board")
    run["top_features_gain_pct"] = R.get("lightgbm_top_gain") if kind == "lightgbm" else R.get("logistic_top_coefs")
    run["feature_direction"] = R.get("feature_direction")
    report["runs"][name] = run
    print(name, "ok", flush=True)
report["headline_model"] = HEADLINE
report["checkers"] = json.load(open(f"{W}/shadow-checkers.json"))
report["checkers"].pop("rows", None)
report["worth_the_price_2y_replay"] = json.load(open(f"{W}/worth-the-price-backtest.json"))
json.dump(report, open(f"{W}/report-tables.json", "w"), indent=1, default=float)
print("saved tables")
