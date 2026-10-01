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
