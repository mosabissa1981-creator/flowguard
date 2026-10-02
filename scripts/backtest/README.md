# FlowGuard history backfill + backtest (box only)

Study tooling, not financial advice. Runs on the box, never on Vercel.

```
scripts/backtest/run-nightly.sh            # resumable; stops at UW used-today ≥ 37,500 (39,000 hard ceiling − 1,500 live reserve)
scripts/backtest/run-nightly.sh --days=5   # limit sessions this run
scripts/backtest/run-nightly.sh --summary-only   # re-score outcomes + rebuild summary/dataset only
```

Data lands in `/workspace/flowguard/history/` (override `HISTORY_DIR`):

| Path | What |
|---|---|
| `flow/<day>.json.gz` | every UW flow alert ≥ $10K, 09:30–16:15 ET (same compact fields as the live session tape) |
| `tide/<day>.json` | UW market tide for the day |
| `ohlc/<T>.<k>.json`, `earnings/<T>.json` | daily bars / earnings dates for chart + catalyst lookups (as-of views in replay) |
| `contracts/<OCC>.json.gz` | full daily history per logged/candidate contract (price + open interest) |
| `signals/dp`, `signals/gex` | dark-pool windows and GEX-by-strike for logged entries |
| `replay/<day>.json` | current live rules replayed at 10:00/10:30/11:00/12:00/13:00/13:55/15:45 ET: logged lane/puts/lottery entries, picks (13:55), premove (15:45), top-5 candidates per lane |
| `datasets/outcomes.json.gz`, `datasets/entries.csv` | outcomes + features (ML-ready) |
| `backtest-summary.{json,md}` | per-lane W/L/flat and shadow-signal win rates |
| `logs/` | run logs |

Replay = fake clock + fetch shim (UW/Yahoo served from the files above; calendar/treasury/LLM/Telegram refused; the
wrapper passes only the UW key). Days are fetched newest → oldest and replayed in ascending blocks in a fresh process.
Known gaps: no yields / economic-calendar lockouts in replay; sector field absent (same as the live tape).

## Candidate pools (Picks / Premove re-weighting)

- Every replay also stores the **full scored Picks pool (13:55 ET) and Premove pool (15:45 ET)** in `pools/<day>.json`:
  up to 80 rows per list after the live sort, with chips (+ deltas), `score`, `rawScore`, the raw score and chips
  entering the actionable overlay (`preActRaw` / `preActChips`, for the score-90 rule), pool rank and post-cap rank.
  `check` confirms the pool's top 3 equals what `loadDailyPicks` / `loadPremoveShortlist` returned.
- Older replays get pools from cache via `pools-block.ts` (the nightly runs it automatically; `UW_OFFLINE=1` = never call UW).
- `candidates.ts` scores rows down to `CAND_DEPTH` (default 25) plus the shown top 3 with the same outcome rule as the
  logged picks → `datasets/candidate-outcomes.json.gz` + `datasets/candidates.csv` (`chip_<id>` = delta, blank = absent;
  `outcome=unscored` beyond the depth). Contract histories share the `contracts/` cache; misses are budgeted UW calls.
- `weight-test.ts [--proposal=path] [--from=YYYY-MM-DD]` rebuilds the top 3/day under current vs proposed chip deltas
  (same sort, caps, lockouts) → `weight-test-<date>.{json,md}`. Study only; live scoring is never changed by these scripts.
