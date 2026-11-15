# AI trader books

Paper / test mode only. Not real money. Not financial advice.

Each Friday after the close, FlowGuard scores four paper books that share one candidate pool (the wide-pool rows Grok, Claude, and GPT already judged — no new model calls):

- `week-YYYY-MM-DD.json` — machine-readable score. The date is the Friday.
- `week-YYYY-MM-DD.md` — the same score as a short table.

The job stores the score for the paper card either way. It writes these files when the process can write the repo (a local or box run). Vercel keeps the score in Redis and on `GET /api/paper` (`aiTrader.week`); the study routine can save that payload here.

Winner = the model with the highest **quality-tier** average take return that also beats the rules-only book, with at least 5 scored quality trades. Otherwise there is no winner, and the main paper book keeps following the rules-only quality book. Study-tier fills are a second table in the same file. They do not pick the winner and they are not copied onto main.

`FLOWGUARD_PAPER_MAIN_SOURCE` is optional. Leave it unset (`auto`) for that default. Set `rules`, `grok`, `claude`, or `gpt` only to force a source.

`FLOWGUARD_AI_TRADER_STUDY_BOOST` is on through 2026-12-11 unless set to `0`. While it is on, the report-day quality list cap is 8 (calm stays 10) and each AI book may add up to 8 study-tier fills (live floor: spread ≤ 10%, premium ≥ $10k, score ≥ 45). Quiet-test AI spend still stops at $3/day.
