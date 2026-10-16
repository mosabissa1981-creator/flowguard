# Early ping vs current ping — 2-year backtest (study only, test mode)
Sessions 2024-10-07 → 2026-10-14 (528 flow days). Script: `scripts/study/early-ping-backtest.py`. Same screen both arms (ask-side ≥70%, premium ≥$200k, DTE 5–60, vol/OI ≥1, spread ≤10%, ETF/index-only puts), top 5 by premium/day. Exits +30% / −25% / 2 sessions.

| Arm | Trades | Fill rate | Win % | Mean | Median | Avg per day (mean of day means) |
|---|---:|---:|---:|---:|---:|---:|
| (a) current: 9:30–10:00 ET flow, entry ≈ live ask at 10:00 ET, skip >10% over print | 628 | 79.9% | 36.3 | −5.0% | −25.0% | −5.3% |
| (b) early, max = print +5% | 1653 | 86.9% | 41.4 | −2.1% | −22.6% | −2.4% |
| (b) early, max = print +10% | 1696 | 89.1% | 39.0 | −3.5% | −25.0% | −3.8% |

Data limits: option history is DAILY bars only (open/high/low/close/avg). (a)'s "live ask" is proxied as max(print, day open, day avg price); (b) fills use the full-day low (overstates first-60-min fills) at the max price (prior-afternoon prints: min(open, max)). If target and stop both touch on one daily bar we count the stop. Historic risk-off level is not stored, so the risk-off hold-back is not applied in the backtest (live shadow applies it). All arms lose on average — this is a relative comparison, not an edge claim.
