#!/usr/bin/env python3
"""TEST MODE study, stage 3: build study/exit-rules-backtest.json (plain-words summary on top + full tables) from
exit-rules-work/results.json and trades.json.gz (exit-rules-backtest.py)."""
import json, gzip, collections
import numpy as np
W = "/workspace/flowguard/study/exit-rules-work"; OUT = "/workspace/flowguard/study/exit-rules-backtest.json"
R = json.load(open(f"{W}/results.json")); T = json.load(gzip.open(f"{W}/trades.json.gz", "rt"))["trades"]
BASE = "base_T40_S25_H3"; rng = np.random.RandomState(5)
def ci(xs, name, base=BASE):
    pr = [(x["day"], x[name][0] - x[base][0]) for x in xs if x.get(name) and x.get(base)]
    if not pr: return None
    by = collections.defaultdict(list)
    for d, v in pr: by[d].append(v)
    ds = list(by); arr = [np.array(by[d]) for d in ds]
    ms = [np.concatenate([arr[i] for i in rng.randint(0, len(ds), len(ds))]).mean() for _ in range(400)]
    return {"avg_diff_pts": round(100 * float(np.mean([v for _, v in pr])), 2),
            "ci95": [round(100 * float(np.percentile(ms, 2.5)), 2), round(100 * float(np.percentile(ms, 97.5)), 2)], "n": len(pr)}
def win(xs, name):
    v = [x[name][0] for x in xs if x.get(name)]; return round(100 * float(np.mean(np.array(v) > 0)), 1) if v else None
def avg(xs, name):
    v = [x[name][0] for x in xs if x.get(name)]; return round(100 * float(np.mean(v)), 2) if v else None

U = R["universes"]; B = U["board_current_rules"]
def holds_both(u, name):
    a, b = U[u][name]["y1"]["vs_base"], U[u][name]["y2"]["vs_base"]
    return a and b and a["avg_diff_vs_base_pts"] > 0 and b["avg_diff_vs_base_pts"] > 0
ranking = []
for name in B:
    if name == BASE: continue
    a, b = B[name]["y1"], B[name]["y2"]
    ranking.append({"rule": name, "both_years_better": bool(holds_both("board_current_rules", name)),
                    "y1_diff": a["vs_base"]["avg_diff_vs_base_pts"], "y1_ci": a["vs_base"]["ci95"],
                    "y2_diff": b["vs_base"]["avg_diff_vs_base_pts"], "y2_ci": b["vs_base"]["ci95"],
                    "y1_best_case_order_diff": (a["best_case_intraday_order"].get("vs_base_best_case") or {}).get("avg_diff_vs_base_pts"),
                    "y2_best_case_order_diff": (b["best_case_intraday_order"].get("vs_base_best_case") or {}).get("avg_diff_vs_base_pts"),
                    "win_pct_y1": a["win_any_profit_pct"], "win_pct_y2": b["win_any_profit_pct"],
                    "hit_pct_y1": a["hit_target_pct"], "hit_pct_y2": b["hit_target_pct"]})
ranking.sort(key=lambda r: (not r["both_years_better"], -min(r["y1_diff"], r["y2_diff"])))

lg = [x for x in T if x["uni"] == "logged"]
lane_hits = {}
for ln in sorted({x["lane"] for x in lg}):
    for name in ("c_trail_after15_give10", "c_trail_after15_give15", "e_H2", "a_T30", "f_fade_exit_else_base"):
        res = {}
        for yr in ("y1", "y2"):
            xs = [x for x in lg if x["lane"] == ln and x["year"] == yr]
            res[yr] = {"base_avg": avg(xs, BASE), "rule_avg": avg(xs, name), "base_win": win(xs, BASE), "rule_win": win(xs, name),
                       "vs_base": ci(xs, name), "vs_base_best_case_order": ci(xs, name + "@opt", BASE + "@opt")}
        if all(res[y]["vs_base"] and res[y]["vs_base"]["ci95"][0] > 0 for y in ("y1", "y2")):
            lane_hits[f"{ln} / {name}"] = res

b0, h2 = B[BASE], B["e_H2"]; t30 = B["a_T30"]
summary = [
 "TEST ONLY - nothing live changed. 2-year replay (Oct 2024 - Oct 2026), split at 2025-10-01. Buy at the alert ask, sell at the bid.",
 f"Current board (shown picks/premove, spread <= 10%, ETF/index-only puts): {b0['y1']['n']} trades in year 1, {b0['y2']['n']} in year 2. "
 f"Today's exit (+40% / -25% / 3 sessions): win rate {b0['y1']['win_any_profit_pct']}% / {b0['y2']['win_any_profit_pct']}%, average {b0['y1']['avg_ret_pct']:+}% / {b0['y2']['avg_ret_pct']:+}% per trade after the spread, "
 f"average loss {b0['y1']['avg_loss_pct']}% / {b0['y2']['avg_loss_pct']}%, worst 5% {b0['y1']['worst5_pct']}% / {b0['y2']['worst5_pct']}%.",
 f"Best rule by average return that beats today's in BOTH years on the current board: hold 2 sessions instead of 3 (same +40/-25). "
 f"+{h2['y1']['vs_base']['avg_diff_vs_base_pts']} pts in year 1 and +{h2['y2']['vs_base']['avg_diff_vs_base_pts']} pts in year 2 "
 f"(averages {h2['y1']['avg_ret_pct']:+}% / {h2['y2']['avg_ret_pct']:+}%). Win rate goes UP a little: {b0['y1']['win_any_profit_pct']}% -> {h2['y1']['win_any_profit_pct']}% and {b0['y2']['win_any_profit_pct']}% -> {h2['y2']['win_any_profit_pct']}%; "
 f"the target is hit less often ({b0['y1']['hit_target_pct']}% -> {h2['y1']['hit_target_pct']}%, {b0['y2']['hit_target_pct']}% -> {h2['y2']['hit_target_pct']}%). It is small: the year-1 range includes zero, "
 "the year-2 range just clears it, and it was also slightly positive on the full pool and the logged lanes. Treat as 'no worse, maybe a bit better', not a big win.",
 f"If the goal is purely a higher win rate: a +30% target lifts wins from {b0['y1']['win_any_profit_pct']}% to {t30['y1']['win_any_profit_pct']}% (year 1) and {b0['y2']['win_any_profit_pct']}% to {t30['y2']['win_any_profit_pct']}% (year 2) "
 f"for about the same average return ({t30['y1']['vs_base']['avg_diff_vs_base_pts']:+} / {t30['y2']['vs_base']['avg_diff_vs_base_pts']:+} pts, both ranges include zero). +15/+20% targets push win rate past 50% but cost ~1.5 pts per trade in year 2.",
 "Scaling out half at +20% with a breakeven stop is clearly worse (-4 to -6 pts per trade in both years; still worse even if every same-day path is assumed to go our way). "
 "Tighter/looser stops (-15/-20/-30%) and the fade-watch exit change little (fade warnings fire on only ~2% of board trades). Trailing after +15% is mixed overall (worse in year 1, better in year 2).",
 "Lane finding worth a follow-up: on the calls-sector-wave lane a trailing stop after +15% (give back 10 pts, no fixed target) beat the fixed +40% exit by about +6 to +8 pts per trade in both years with ranges above zero "
 "(still +5 to +7 pts under the best-case order), but its win rate dips ~2-3 pts (39% -> 37%) because it lets winners run. "
 "This came out of 9 lanes x 5 rules checked, so it needs a fresh-data check before acting on it.",
 "How intraday paths were handled: only DAILY option bars exist (open/high/low/last + end-of-day bid/ask), no intraday prices. Order inside a day is unknown, so the headline numbers use the conservative order: "
 "an opening gap through a level fills at the open; otherwise the stop (day low) counts before the target (day high); after a scale-out, a same-day dip under breakeven is assumed to come after the scale. "
 "Fills at a level are level x (1 - half the day's spread). Like the replay, the path starts the session AFTER the entry day; the 2:30 PM CT time stop is approximated by the last session's end-of-day bid. "
 "Each rule is also re-run with the best-case order (high before low) as a bound; the ranking above holds under both orders.",
 "Full pool and logged-lane tables are below; per-lane and per-year tables are under universes.<universe>.<rule>.by_lane.",
]
out = {"summary_plain_words": summary, "board_rule_ranking": ranking, "lane_level_robust_findings": lane_hits,
       "live_exit_plan_note": "lib/exit-plan.ts on main uses +30% in a risky regime, +50% at confidence >= 75, else +40% (stop -25%, 3 sessions); the replay baseline here is the fixed +40/-25/3 used by the replay outcomes.",
       "definition": R["definition"], "rules": R["rules"], "rows": R["rows"], "skipped": R["skipped"], "universes": U}
json.dump(out, open(OUT, "w"), indent=1, default=float)
print("\n".join(summary)); print("lane hits:", list(lane_hits)); print("saved", OUT)
