# FlowGuard

Options-only flow screener. It ranks Unusual Whales flow alerts by a 0–100 conviction score and downranks the setups that reverse after a few hours: 0–2 DTE lotteries, tiny premium, bid-side dumps, and prints fighting market tide. No-follow-through and tide-fight contracts are dropped from the actionable cards.

This is a screener, not a broker. It does not route orders.

## Run locally

```bash
npm install
cp .env.example .env.local
# Optional: paste UNUSUAL_WHALES_API_KEY into .env.local
npm run dev
```

Open [http://localhost:43127](http://localhost:43127). Without a key, FlowGuard serves a local mock tape so the UI is fully usable.

## Hosted (stable URL)

Open **[https://flowguard-zeta.vercel.app](https://flowguard-zeta.vercel.app)** on your phone. Bookmark it. That copy stays up; it is not a tunnel.

`UNUSUAL_WHALES_API_KEY` is a Production secret on the Vercel project. It is not in git. To use a **new** Unusual Whales key on the phone, tap the small key icon in the header, copy the token from unusualwhales.com, tap **Paste and save**, and tap **Allow** if iPhone asks. There is no type-in box (Safari was blocking UUID tokens). The server checks the token against Unusual Whales, then stores it in a private blob. The key is never written back to the browser.

To publish again from this repo:

```bash
npx vercel login
npx vercel --prod --yes --project flowguard
```

```bash
npm run build
npm start
```

## Live data

Set `UNUSUAL_WHALES_API_KEY` in `.env.local`, or paste it in the **Unusual Whales API** box in the app. The key is POSTed to `POST /api/uw-key`, checked against Unusual Whales, stored only on the server (private blob + `.env.local` when writable), and never written to the browser or returned by any API.

| FlowGuard route | Unusual Whales endpoint |
| --- | --- |
| `GET /api/flow` | `GET /api/option-trades/flow-alerts` with `newer_than` = unix seconds of today's 9:30 ET open (paginated with `older_than`, `limit=200`). Never `unusual=true`. Expired contracts are dropped locally (`created_at` ≥ 9:30 ET and `expiry` ≥ today). |
| `GET /api/picks` | Same **today-only** tape, scored and cut with strict anti-fade, top 10 by conviction. Empty session stays empty. |
| `GET /api/premove` | Building ask-side flow on a still-quiet underlying (UW `stock-state` `close` vs `prev_close`). Mid-size stacked hits over late whale floors. |
| `GET /api/morning` | Frozen morning shortlist — top 5–8 from **this session's** 9:30–10:00 ET window. No fallback to older whale floors. |
| `GET /api/tide` | `GET /api/market/market-tide` |
| `GET /api/ticker/{ticker}/net-prem` | `GET /api/stock/{ticker}/net-prem-ticks` |
| `GET/POST /api/watches/check` | One `GET /api/option-contract/{id}/historic` (`limit=5`) per armed watch on the 15-min path. Quote + fade path (last vs open / prior, ask vs bid volume, IV) from that payload. Last flow print if historic is empty or the 429 breaker is open. Not on the board poll. |
| `GET/POST/DELETE /api/watches` | Vercel Blob (`flowguard/watches.json`) — durable across deploys; external checker reads `GET /api/watches` |
| `GET /api/quote?ticker=NFLX&option_chain=NFLX261023C00070000&alertPrice=1.83` | Live premium: `uw_nbbo` (NBBO mid) in the cash session, `uw_last` (last trade/close) after the close or when the book is one-sided/wide; UW option-contracts → historic bar → last option trade. Only when UW has nothing: last session flow print, else `alertPrice` (`source: alert`, with a `diag` step trace). `symbol=<OCC>` is accepted as an alias (ticker read from it); bad input returns a 400 with usage. UW allows 3 concurrent requests per key: the server queues UW calls (`UW_MAX_CONCURRENCY`, default 2) and retries a concurrency 429 instead of tripping the quota circuit. |
| `GET/POST /api/notify` | Lock-screen ping (Pushover + Telegram). POST `{ title, body }`. |
| `POST /api/notify/test` | Sends “FlowGuard test” to configured channels. |

Requests use `Authorization: Bearer …` and `UW-CLIENT-API-ID: 100001`.

**Quota:** Unusual Whales allows 40,000 requests/day. The board auto-refreshes every **15 minutes** (`BOARD_REFRESH_MS` in `lib/refresh.ts`). Flow, picks, premove, and morning share **one** session tape (cached 12 min in memory + blob, slightly under the poll). Market tide and stock-state use the same 12 min TTL. Ticker tide is derived from the tape (no per-name net-prem on poll). Chain quotes are not fetched on poll. Bought/Watch quotes run **on tap only**. Price-alert checks run every 15 minutes and fail closed on 429. Manual refresh (`?fresh=1`) may bypass cache but still respects the circuit breaker. A 429 trips a circuit breaker until next UTC midnight — no further UW calls. Mock/demo names are never shown when a key is configured; 429 serves last-good live tape or an empty board with a hard banner.

If a live request fails, the screener does **not** substitute the demo tape.

## Filters

- Min premium, DTE range, calls/puts, ticker
- Min conviction
- Unusual preset — applied **locally** on today's session tape (opening, vol&gt;OI, size&gt;OI, sweep/floor, or a named alert rule such as RepeatedHits). Does **not** send `unusual=true` to Unusual Whales.
- Strict anti-fade — hides 0–2 DTE, tiny premium, bid-dominant, fighting-tide, post-print fade, and **stale** rows (also excluded from Picks)
- **Session filter** — UW `GET /api/option-trades/flow-alerts` with documented `newer_than` (unix seconds of 9:30 ET). There is no `intraday_only` param; `hide_expired` is not on this endpoint (it exists on `/api/option-trades`). FlowGuard then keeps only `created_at` ≥ 9:30 ET today and unexpired contracts. Rank/conviction apply inside that window. Empty windows stay empty — they do not fill from multi-week `LowHistoricVolumeFloor` alerts. `unusual=true` is never sent (UW docs: that flag is a live-options-flow *criteria* preset, not a session cut).
- Auto-refresh every **15 minutes**, with pause. Server tape cache is 12 minutes so a 15-minute poll usually does one UW pull; faster traffic hits cache. Tap refresh to force a fetch (still blocked after 429).

Click a row for the detail drawer: score chips, ask/bid split, market tide, ticker net-premium ticks, pin, note, and dismiss.

## Manager layer

The manager book sits on the same Unusual Whales tape. It does not pick stocks.

- **Morning shortlist** — `GET /api/morning` freezes the top 5–8 setups from the 9:30–10:00 ET window **of this session**. If that window is empty, the panel stays empty — it does not fall back to older whale floors. Cache freezes after 10:00 ET.
- **Premove** — `GET /api/premove` ranks **building** ask-side interest (several $25k–$150k hits / repeated hits, DTE 7–45) while the stock is still close to the prior close. Honest early-flow lane, not a prediction. Picks of the Day stays the larger clean-print book.
- **Picks of the Day** — `GET /api/picks` takes the unusual-flow tape, applies **strict anti-fade**, keeps conviction ≥ 55, and returns the top 5–10 setups by conviction with a plain-English thesis, fade risks, and an explicit options hold window (intraday–2 sessions, 2–7 sessions, or up to ~1–2 weeks — never hold to expiry, never a stock hold). No-follow-through and tide-fight rows are hard-excluded. DTE ≤9 is demoted. Contracts on both Picks and Premove, and base scores ≥ 90, are boosted. Prints at or after 14:00 ET stay on the live board and sort behind earlier-session names on this card.
- **Watchlist** — pin a ticker or a specific option contract. Stored in `localStorage` (`flowguard.watchlist`). Toggle *Watchlist only* to filter the tape.
- **Manager notes** — optional note per alert id (`flowguard.notes`).
- **Dismiss** — hide an alert from picks and the tape (`flowguard.dismissed`). Restore one name or restore all.
- **Price watches** — options only. **Bought** / **Watch entry** resolve a live UW quote **on tap** (not on every row render). Default adverse 15% / approach 5%. The 15-minute check uses **one contract historic** per armed watch (not the board poll) to see if premium followed through. Watches older than one session with no premium follow-through **expire and are deleted** from the server book (`GET /api/watches`). Aged **call** watches without follow-through hard-expire (MMM class). Live premium **≤−40% vs arm** also deletes. GH-class (last still ≥+5% or historic confirmed) stays armed. If the daily UW cap is hit, arming uses the alert print and watch checks fail closed (last flow print, no UW retry). Armed watches live in Vercel Blob; expired rows are archived then dropped. `localStorage` syncs the armed list and will not resurrect tombstoned ids. An external checker reads `GET /api/watches` and `GET /api/watches/check` (check persists the prune). Actionable **adverse** (consider cutting) and **entry-approach** fires ping **Pushover and Telegram** (60-minute dedupe per watch+status). Chat webhook (`WATCH_WEBHOOK_URL`) stays as backup. Never auto-trades.

## Lock-screen alerts (Pushover + Telegram)

Set these as Production secrets on the Vercel project (or in `.env.local`). A channel is skipped if its pair is empty. Secrets are never logged or returned by the API.

| Env | Where to get it |
| --- | --- |
| `PUSHOVER_APP_TOKEN` | [Create a Pushover application](https://pushover.net/apps/build) — the API token/key |
| `PUSHOVER_USER_KEY` | Your user key on [pushover.net](https://pushover.net) (the device is already linked to this account) |
| `TELEGRAM_BOT_TOKEN` | Message [@BotFather](https://t.me/BotFather) → `/newbot` |
| `TELEGRAM_CHAT_ID` | Message your bot, then open `https://api.telegram.org/bot<token>/getUpdates` and copy `chat.id` |

After env is set, `POST /api/notify/test` sends **FlowGuard test** to every configured channel. `POST /api/notify` with `{ "title", "body" }` sends an arbitrary ping. `GET /api/notify` only reports which channels are configured (no secrets).

No brokerage routing. Notes and pins stay in the browser. Price watches are durable on the server.

## Conviction score

Base 32, clamped 0–100.

**Boosts:** ask-side premium dominance, `all_opening_trades` **(+4, mild — Sep 4 winners MU/INTC were not all-opening)**, high `volume_oi_ratio`, meaningful `total_premium`, **DTE 11–30 (+12, primary window)** and DTE 31–45 (+8), **sweep (+8)** and **ask-sweep (+3)** when ask-side, single-leg, **tide aligned (+6)**, **fresh session (+3)** if printed in the last two hours, **near-ATM / modest OTM (+3)**, **follow-through (+5)** when a later ask-side hit or rising print confirms. On Picks, Premove, and the morning shortlist only: **both lanes (+8)** when the contract qualifies for Picks and Premove, and **score ≥ 90 (+6)**.

**Penalties:** DTE 0–2, **DTE 3–9 (−16, soft demote — still eligible so a quiet board does not go empty)**, tiny premium, bid-dominant prints, multi-leg, **fighting tide (−24)** for call flow into a bearish market tide or put flow into a bullish market tide (ask-side ticker-tide fights still count), **floor-only / no sweep (−12)** unless `has_sweep` or a second ask-side hit that session, **aging (−12)** at 4–8h, **aged print (−18)** at 8h+, **aged call watch (−6)** and **aged floor (−8)** on top of that, **one-and-done / no follow-through (−14)** after 2h with no confirming ask-side flow or rising premium, **ITM (−4) / deep ITM (−8) / far OTM (−6)**, **post-print fade (−15)**, **stale print (cap ≤ 32)** when `created_at` is before the prior weekday 9:30 ET. **Late print (−18, actionable cards only)** when `created_at` is at or after 14:00 ET — those rows stay on the live board and sort behind earlier-session names. No-follow-through and tide-fight rows are hard-excluded from Picks, Premove, and the morning shortlist (Sep 2026 backtest: no follow-through 6/6 losers; tide fight 0W / 3L / 74 flat). Other fade-prone rows (lottery, tiny, bid-side, aged, stale) stay off those cards via strict anti-fade. Session `newer_than` still keeps the live board on today only.

Ask-sweep + tide is **necessary but not sufficient**. See `study/lessons-2026-09-04.md` and `study/lessons-2026-09-08.md`. Fresh MU-class sweeps stay high; MMM-class aged call watches expire **and are removed from storage**; same-day tags without follow-through drop off Picks.

**Bought / Watch entry** arm at live UW last/mid when available, else last session print, else the alert print — and label which. Never silently reuse a week-old `alert.price`.

Each chip shows the point delta and a short reason.

## Stack

Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui.

## Macro regime + concentration caps (Phase A, Oct 2026)

- `GET /api/regime` — `calm` / `risky` / `report-day` from the US economic calendar
  (Forex Factory weekly JSON, cached per ET day; falls back to UW `economic-calendar`, 24h cache),
  US10Y/US30Y change vs prior close (Yahoo `^TNX`/`^TYX`, 15-min cache; Treasury daily CSV fallback),
  and the UW market tide (re-uses the shared tape cache — no new per-poll UW calls).
- Risky / report-day: morning, picks and premove lists capped at 3, DTE < 14 dropped,
  calls on long-duration tech docked −15 when long yields are rising (−6 on calm days), and caps tighten
  to 1 per issuer / 2 per sector.
- Always: max 2 contracts per issuer (GOOG + GOOGL = one; QQQ/TQQQ = NDX, etc.), max 3 per sector.
- Scoring: both-lane bonus removed (chip is informational, delta 0); late prints (≥14:00 ET) excluded
  from actionable lists; +8 morning ask-side (9:30–11:00 ET, ≥70% ask), +4 extra for 11–30 DTE,
  +10 quiet underlying / −10 extended (re-uses Premove's stock-state spots). Ties at the 100 clamp are
  broken by the unclamped `rawScore`.

## AI picks + exit plans (Phase B)

- `GET /api/ai-picks` — top ~8 actionable candidates (morning lane first, issuer/sector capped) plus the
  regime, flow facts and the study-book summary go to an LLM, which returns 3 (risky/report-day) to 5 (calm)
  picks with confidence + reason and an explicit skip reason for every other candidate. Guardrails (list cap,
  1/issuer on risky days, sector cap) are re-applied after the model. 12-min cache; `?rerun=1` bypasses it.
  Zero extra UW calls — it re-uses the morning / picks / premove lists.
- LLM config (Vercel env): `LLM_API_KEY` (required to enable), optional `LLM_PROVIDER`
  (`openai` | `anthropic`; auto-detected from an `sk-ant-` key), `LLM_MODEL`, `LLM_BASE_URL`
  (any OpenAI-compatible endpoint, e.g. xAI / Groq / OpenRouter). Without a key — or on LLM error / bad
  JSON — the endpoint returns a deterministic rules fallback (`engine: "deterministic"`, `llmStatus` says why).
- Every pick in `/api/ai-picks`, `/api/morning`, `/api/picks`, `/api/premove` carries `exitPlan`:
  entry (flow print), target (+30% risky / +40% calm / +50% calm high-confidence), stop (−25%), time stop
  (3 sessions risky / 5 calm, capped at half the DTE) and `alertLevels` for the price-alert routine.
- `GET /api/study-summary?n=20` — compact study-book outcomes from `study/study-summary.json`.
  Refresh with `node scripts/build-study-summary.mjs <path-to-study-dir>` and commit.

### Regime v2: seed calendar, lockouts, auctions, rate-sensitive sectors
- `lib/macro-seed.ts` — researched Oct 1–9 2026 calendar (+ CPI 10/14, PPI 10/15, FOMC 10/28) with desk day
  ratings (good / careful / careful-afternoon / sit-out), merged with the live calendar. Replay:
  `npx tsx --conditions=react-server scripts/regime-seed-check.ts`.
- Pre-release lockout: NFP/CPI/PPI/ISM/PCE/GDP/FOMC/minutes and 10Y/20Y/30Y auctions open a window
  (pre-market releases: open → max(release+60m, open+30m); intraday: release−30m → release+45m; auctions
  −15m → +45m). While active, picks / premove / AI picks return no new picks with a lockout warning.
- Long-bond auction afternoons (after 12:00 ET) → at least `risky`.
- Calls on rate-sensitive groups (utilities, REITs, homebuilders, IWM, KRE/regional banks, long bonds) docked
  −12 on risky days / −6 calm when the long end is rising (day ≥ +3bp or 5-session ≥ +10bp).
- `ivEvents` + an informational `event-iv` chip and `exitPlan.eventRisk` when an expiry spans CPI/PPI/NFP/FOMC.
- Yields: official Treasury daily par-curve CSV first (prior close + 5-session trend, bear-steepening flag);
  Yahoo only supplies the intraday last before Treasury posts the day's close.

## Gap-up chase checker (TEST / shadow)

`GET /api/shadow/gap-chase` · card "Gap-up chase check" under Shadow signals, plus an orange dashed
`test · gap-up chase` badge on flagged Picks / Premove / Morning / AI picks. **Flags only — never filters,
re-ranks or changes live picks, the AI review or paper fills.**

- Gap-up day = SPY or QQQ regular open ≥ +0.3% vs prior close (frozen at the first market-hours check).
- On a gap-up day a call printed 9:30–11:00 ET needs a 2nd ask-side print on the same contract (session tape)
  or a ≥0.3% pullback before it counts; a call whose stock was already ≥ +2% at the print gets a shadow penalty
  (−6; −10 at ≥ +3%).
- Verdicts + change log are stored per day (`flowguard/shadow/gap-chase-<day>.json`, 45 days);
  `GET /api/shadow/gap-chase?day=YYYY-MM-DD` returns a past day. Score against the study book with
  `python3 scripts/study/gap-chase-score.py YYYY-MM-DD` (writes `study/gap-chase-<day>.json` + `study/gap-chase-scores.json`).
- Backtest (`scripts/study/gap-chase-backtest.py`, results `study/gap-chase-backtest.json`): 2-year replay,
  1,802 gap-up-morning call candidates — flagged 40.4% win (495W/729L/111F) vs kept 46.5% (198W/228L/41F),
  baseline 42.0%. It cuts ~76% of losers but ~71% of winners, so it stays a flag. Oct 6 2026: all 11 morning
  calls on the book would have been flagged (5 losers, 6 flat, 0 winners).
- UW: SPY/QQQ + pick tickers `stock-state` (12-min cache), recomputed at most every 3 min in market hours.

## Paper account (test mode — fake money)

`GET /api/paper` · card "Paper account" under AI picks. **Paper / test mode, not real money, not financial advice.**
Never places orders and never changes live picks.

- **Books:** `main` = Picks of the Day + Premove that the rules/AI actually **took** (`/api/ai-picks` `picks` +
  `premove.picks`; watch-only, skipped and lockout picks never enter). Headline balance = main only. Test lanes
  (`lottery`, `puts`, `lanes`, `earnings-calendar`) are separate $10k sub-books for comparison.
- **Size:** 2% of the book value per trade (min 1 contract); skip if 1 contract > 5%; total open cost ≤ 10%.
  Lottery 0.5% per trade, open ≤ 5%.
- **Fill:** live UW ask when the pick is taken (batched `option-contracts?option_symbol[]=…`, one call per underlying);
  no ask → alert price +5%. **Exit:** live bid when it reaches the pick's target/stop (its exit-plan %, applied to the
  fill) or at the time stop (15:30 ET on the plan date; lottery: expiry day, +100% take-profit, no stop). No bid → last −5%.
- **Ticks:** after responses on `/api/ai-picks`, `/api/lanes`, `/api/puts`, `/api/lottery`, `/api/watches/check`, `/api/paper`
  (shared Redis gap `PAPER_TICK_GAP_S`, default 120 s, market hours only); exits re-quoted at most every 15 min.
  Daily Vercel crons `/api/paper?tick=1` at 19:40 and 20:40 UTC force a tick for time stops after 15:30 ET.
- **UW budget:** `PAPER_UW_DAILY_CAP` (default 800) quote calls/day; typical ≈ 26 checks × distinct open underlyings.
- **Storage:** Redis `paper:positions`, `paper:closed`, `paper:balance`, `paper:main-picks`, `paper:snapshot:YYYY-MM-DD`.
  The study routine saves `GET /api/paper?day=YYYY-MM-DD` (or plain `/api/paper` after the close) as `study/paper-YYYY-MM-DD.json`.
- **External test trade (admin):** `POST /api/paper?key=<AI_PICKS_ADMIN_SECRET>` with
  `{ "book": "earnings-calendar", "legs": [{"option_chain":"LW261016C00045000","action":"sell"},{"option_chain":"LW261120C00045000","action":"buy"}], "alertDebit": 0.5, "exitBy": "2026-10-07T14:00:00Z" }`.
- `npm run paper-check` runs the pure-logic assertions.

## Shadow modules (study only — never change the live lists)

Each module returns `{ module, verdict: pass|flag|boost|skip, score, confidence, reason, data }` per finalist
(the ≤8 AI-review candidates), stored per day in Blob (`flowguard/shadow/day-YYYY-MM-DD.json`).

| Module | Source | Flags / boosts |
| --- | --- | --- |
| `news_x_check` | Grok + xAI `web_search`/`x_search` (one batched call for new issuers) | flag: flow chasing public news / high fade risk; boost: catalyst not yet priced |
| `x_sentiment_shift` | same call | boost: X chatter rising while price flat, aligned; flag: chatter against the side |
| `earnings_check` | UW `/stock/{t}/info` + `/earnings/{t}` (only if earnings < expiry), cached daily | flag: earnings before expiry (implied + avg 1-day move) |
| `same_buyer_tracking` | UW `/option-contract/{id}/historic` (prior sessions only) + `study/candidate-history.json` | boost: repeated ask-side adds + OI growth / repeat appearances; flag: bid-heavy + OI shrinking |
| `worth_the_price` | Black–Scholes from the print IV + UW `/volatility/stats` (RV, IV rank) | flag: target needs > 1σ move by the time stop |
| `regime_analogs` | `study/regime-days.json` (yields Δ, tide, calendar type) | boost/flag by how the same pick type did on the closest days |
| `adaptive_exits` | σ-scaled target/stop/time stop logged next to the fixed plan | flag: fixed target ≫ typical move |
| `debate` | one combined Grok call: bull / bear / macro + judge per finalist | take → boost, avoid → flag |

Endpoints: `GET /api/shadow` (today; `?day=YYYY-MM-DD` stored day for the study routine to save as
`study/shadow-YYYY-MM-DD.json`; `&full=1` raw caches; `?readonly=1`), `GET /api/brief` (premarket brief, once per
trading day from 8:25 CT; also attached read-only to `/api/regime` as `brief`), `GET /api/release-read` (post-release
hot/cool read for NFP/CPI/PPI/PCE/ISM/FOMC/minutes ≥3 min after release), `GET /api/weights-proposal`
(`scripts/propose-weights.mjs`, proposal only). The shadow pass also runs after `/api/morning` and `/api/ai-picks`
responses (`after()`), so it needs no extra cron.

Cost guards: LLM only on trading days 9:00–16:15 ET, ≥30 min apart, only for new issuers/contracts, ≤6 runs/day,
hard daily cap `SHADOW_LLM_DAILY_USD` (default $1, provider-reported cost). Env: `SHADOW_SEARCH_MODEL` (default
`grok-4.3`), `SHADOW_LLM_MODEL` (default `LLM_MODEL`), `SHADOW_MAX_LLM_RUNS`, `SHADOW_UW=off`, `SHADOW_SEARCH=off`,
`SHADOW_MODE=off`, `SHADOW_BRIEF_IN_AI_PICKS=1` (opt-in: add the brief to the AI-picks prompt). Without
`LLM_API_KEY` the LLM modules return `skip`. Local replay:
`SHADOW_LOCAL_DIR=/tmp/shadow npx tsx --conditions=react-server scripts/shadow-local.ts <studyDir> 2026-09-30 09:52`.
`scripts/build-study-summary.mjs` adds `shadowAccuracy` (per module: W/L/flat of boosted vs passed vs flagged).

## Notify auth

`POST /api/notify` and `POST /api/notify/test` require `NOTIFY_SECRET` (header `x-flowguard-key` or `?key=`);
`GET /api/notify` (health) stays public. Fails closed when the env var is missing.

## Intraday shadow monitors (TEST / SHADOW only)

Logged only — never change live picks, the AI review or paper fills.

| Endpoint | What it logs | UW calls/day (est.) |
|---|---|---|
| `/api/shadow/fade-watch?day=YYYY-MM-DD` | Early fade warnings on open paper positions (bid-side takeover, −10% from entry, ticker tide flip) | ~3,000 |
| `/api/shadow/follow-through?day=YYYY-MM-DD` | 2nd ask-side print on the contract / ticker within 15/30/60 min (session tape) | 0 |
| `/api/shadow/chain-scan?day=YYYY-MM-DD` | Whole-chain "ask building" hits, top 30 tickers, every ~20 min, self-scored | ~600 |
| `/api/uw-usage?day=YYYY-MM-DD` | UW calls by job + whole-token count (UW day resets 8 PM ET) | 0 |
| `/api/shadow/tick` | Runs the jobs (≤ 1 per 170 s) | — |

Scheduling: 88 daily Vercel crons on `/api/shadow/tick` spread over 13:00–20:59 UTC Mon–Fri (Hobby = once/day each, ±59 min),
plus the gap-chase poll from open browsers, plus the optional box loop `scripts/study/shadow-ticker.sh`.
New jobs stop when UW's daily count reaches `UW_JOBS_STOP_AT` (default 35,000), leaving ~2,500 of the 37,500 ceiling for the live site.
Backtest: `scripts/study/intraday-signals-backtest.py` → `study/intraday-signals-backtest.json`.
