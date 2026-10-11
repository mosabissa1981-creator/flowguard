# Pullback-reclaim vs plain uptrend - backtest (study only, not financial advice)

Setup: 43 mega-caps/ETFs, daily OHLC, signals Oct 2024 - Sep 2026. Uptrend = close>SMA50>SMA100, SMA20/50/100 rising. Signal = uptrend + >=3% drop from 10d high (low within last 6 sessions) + prev close<SMA5, close>SMA5 and close>prior-day high. Deduped to >=5 sessions/ticker. Entry = signal close, stop counts first on same-day hit, gaps fill at open, no costs. Baseline = all other uptrend days (n=7,075). Signals n=465 on 213 dates (max 13 on one date; 61 dates had 3+). CIs below are date-cluster bootstrap.
Dark-pool data is NOT in cached history: not tested. Flow = same-day call ask-side premium >=$2M and >=60% of call premium (UW alerts; only 13.5% coverage), Premove call candidate (22%), tide net call-put >0 (75%).

| Exit | Signal hit / EV% (95% CI) | Baseline hit / EV% | Diff EV (95% CI) |
|---|---|---|---|
| ATR 1.5 stop/3 target, 5d | 7.5% / +0.39 (-0.45..1.27) | 9.4% / +0.32 | +0.08 (-0.72..1.03) |
| ATR 1.5/3, 10d | 22.2% / +0.79 (-0.20..1.75) | 20.1% / +0.32 | +0.47 (-0.48..1.43) |
| Fixed +5.5/-1.3, 5d | 15.9% / +0.48 (0.10..0.90) | 11.9% / +0.15 | +0.33 (-0.04..0.74) |
| Fixed +5.5/-1.3, 10d | 21.5% / +0.52 (0.11..0.95) | 16.6% / +0.13 | +0.38 (-0.01..0.80) |

ATR breakeven for 1.5:3 (2:1) is ~33% hit if no timeouts; hit rates are 7-22% with many timeouts, so EV comes from drift on timed-out trades, not from the stop/target geometry. Fixed 1.3% stop is ~0.55x median ATR (2.4%), so 60-67% stop out; positive EV there is mostly a few big winners.

Flow overlay (signals): 
- Ask-call $2M/60%: n=63, EV +0.14 to +0.51 vs +0.43 to +0.52 without. Hit rate no better (4.8% / 20.6% / 15.9% / 25.4%). No benefit.
- Premove candidate: n=104; best single filter: ATR10d 30.8% hit, +1.85% (CI -0.09..3.73); fixed 10d 25.0%, +0.74 (-0.03..1.49). Borderline, CI touches zero, not significant after trying many cuts.
- Tide bullish: no help; tide-bearish days were actually better on fixed variants (n=114, +0.86..0.89, CI excludes 0), consistent with a mean-reversion/noise effect, not a confirmed rule.
- All three flags: n=31 (27 dates): +1.3 to +3.0% EV, CIs above zero in 3 of 4 variants, but this is the most-sliced cut of ~30 compared, tiny n; treat as a hypothesis only.

Stability by half (signal EV%, fixed 10d / ATR 10d): 2024H2 +0.84/+1.12 (n=73); 2025H1 -0.29/+0.19 (47); 2025H2 +0.62/+1.08 (200); 2026H1 +0.76/+1.39 (99); 2026H2 (Jul-Sep) -0.16/-1.66 (46). Baseline moves the same way (2025H1 and 2026H2 weak for both), so it is regime-driven. Signal beat baseline in most halves but the gap is small relative to noise.

Caveats: overlapping 5-10d trades and market-wide clustered days (effective n ~ number of dates, and far lower in terms of independent regimes); one rising-market 2-year sample with a hand-picked mega-cap universe (survivorship); many variants/filters tested (multiple comparisons); daily bars, no costs/slippage, stop-first rule is conservative; flow alerts are same-day aggregate (entry at close, slight timing looseness).

Findings: reclaim modestly improves on plain uptrend in the fixed +5.5/-1.3 variants (+0.3-0.4pp EV/trade, diff CI just touches 0, p~0.05-0.1) and positively but insignificantly in ATR variants. This is better than the earlier bounce-off-swing-low pattern (which showed nothing). FlowGuard flow confirmation (ask-call $2M, tide) does not add; Premove is the only filter hinting at lift.

Recommendation: weak yes for a small, clearly-labeled TEST-MODE paper lane only (stock/ETF reclaim, fixed or ATR exit, 10-session hold, no real sizing), with Premove as a tag to log rather than a gate; do not gate on ask-call/tide. Re-evaluate after ~100 new live paper signals; promote only if signal-minus-baseline EV stays positive with CI excluding 0. Not an edge claim.

Files: pullback-reclaim-backtest.json, pullback_reclaim_backtest.py (read-only on history; no UW calls made).
