# Pullback reclaim — TEST-mode paper lane (approved by Mosab 2026-10-11)

- Stocks/ETFs, 43-name liquid universe (lib/shadow/pullback-reclaim-core.ts). Spec: pullback-reclaim-backtest-summary.md.
- Runs: Vercel cron `/api/shadow/pullback-reclaim` weekdays 21:15 UTC (+ retry 23:30 UTC), idempotent; Yahoo daily bars, **no UW calls**.
- Results: shadow store doc `flowguard/shadow/pullback-reclaim-book.json`, read via `GET /api/shadow/pullback-reclaim`; study snapshot via `scripts/study/pullback-reclaim-score.py` -> study/pullback-reclaim-<day>.json + pullback-reclaim-scores.json.
- Scoring: entry = signal-day close, 10-session hold, stop first; ATR (1.5/3) and fixed (+5.5%/-1.3%) variants vs other-uptrend-day baseline, date-cluster bootstrap 95% CI.
- Premove = tag only (log). No ask-call / tide gating. Never changes live picks, never Telegram.
- **RE-CHECK after ~100 new resolved signals: promote only if gain over baseline stays positive with the 95% CI above zero.**
