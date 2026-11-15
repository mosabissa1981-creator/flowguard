# AI trader books

Paper / test mode only. Not real money. Not financial advice.

Each Friday after the close, FlowGuard scores four paper books that share one candidate pool (the wide-pool rows Grok, Claude, and GPT already judged — no new model calls):

- `week-YYYY-MM-DD.json` — machine-readable score. The date is the Friday.
- `week-YYYY-MM-DD.md` — the same score as a short table.

The job stores the score for the paper card either way. It writes these files when the process can write the repo (a local or box run). Vercel keeps the score in Redis and on `GET /api/paper` (`aiTrader.week`); the study routine can save that payload here.

Winner = the model with the highest average take return that also beats the rules-only book, with at least 5 scored trades. Otherwise there is no winner, and the main paper book keeps following the rules-only quality book.

`FLOWGUARD_PAPER_MAIN_SOURCE` is optional. Leave it unset (`auto`) for that default. Set `rules`, `grok`, `claude`, or `gpt` only to force a source.
