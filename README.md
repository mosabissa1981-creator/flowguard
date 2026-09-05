# FlowGuard

Options-only flow screener. It ranks Unusual Whales flow alerts by a 0–100 conviction score and downranks the setups that reverse after a few hours: 0–2 DTE lotteries, tiny premium, bid-side dumps, and prints fighting market tide.

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

`UNUSUAL_WHALES_API_KEY` is a Production secret on the Vercel project. It is not in git. To use a **new** Unusual Whales key on the phone, tap the small key icon in the header, paste it, and tap **Replace key**. The box hides again after a successful save. The server checks it against Unusual Whales, then stores it in a private blob (ahead of the Vercel env). The key is never written back to the browser.

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
| `GET /api/quote` | Live arming premium: UW last/mid, else last session flow print, else `alert.price` |

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
- **Picks of the Day** — `GET /api/picks` takes the unusual-flow tape, applies **strict anti-fade**, keeps conviction ≥ 55, and returns the top 5–10 setups by conviction with a plain-English thesis, fade risks, and an explicit options hold window (intraday–2 sessions, 2–7 sessions, or up to ~1–2 weeks — never hold to expiry, never a stock hold).
- **Watchlist** — pin a ticker or a specific option contract. Stored in `localStorage` (`flowguard.watchlist`). Toggle *Watchlist only* to filter the tape.
- **Manager notes** — optional note per alert id (`flowguard.notes`).
- **Dismiss** — hide an alert from picks and the tape (`flowguard.dismissed`). Restore one name or restore all.
- **Price watches** — options only. **Bought** / **Watch entry** resolve a live UW quote **on tap** (not on every row render). Default adverse 15% / approach 5%. The 15-minute check uses **one contract historic** per watch (not the board poll) to see if premium followed through. Watches older than one session with no premium follow-through **expire**. Aged **call** watches without follow-through hard-expire (MMM class, 4 Sep book). GH-class (last still ≥+5% or historic confirmed) stays armed and is flagged only if the path fades. If the daily UW cap is hit, arming uses the alert print and watch checks fail closed (last flow print, no UW retry). Watches are stored in Vercel Blob and synced to `localStorage` on load. An external checker calls `GET /api/watches` to read all armed watches, and `GET /api/watches/check` to get quotes. On each arm/remove the server also POSTs to `WATCH_WEBHOOK_URL` (with `WATCH_WEBHOOK_SECRET` header) if set. Never auto-trades.

No brokerage routing. Notes and pins stay in the browser. Price watches are durable on the server.

## Conviction score

Base 32, clamped 0–100.

**Boosts:** ask-side premium dominance, `all_opening_trades` **(+4, mild — Sep 4 winners MU/INTC were not all-opening)**, high `volume_oi_ratio`, meaningful `total_premium`, DTE 7–45, **sweep (+8)** and **ask-sweep (+3)** when ask-side, single-leg, **tide aligned (+6)**, **fresh session (+3)** if printed in the last two hours, **near-ATM / modest OTM (+3)**, **follow-through (+5)** when a later ask-side hit or rising print confirms.

**Penalties:** DTE 0–2, tiny premium, bid-dominant prints, multi-leg, fighting tide, **floor-only / no sweep (−12)** unless `has_sweep` or a second ask-side hit that session, **aging (−12)** at 4–8h, **aged print (−18)** at 8h+, **aged call watch (−6)** and **aged floor (−8)** on top of that, **one-and-done (−14)** after 2h with no confirming ask-side flow or rising premium, **ITM (−4) / deep ITM (−8) / far OTM (−6)**, **post-print fade (−15)**, **stale print (cap ≤ 32)** when `created_at` is before the prior weekday 9:30 ET. Aged / stale / one-and-done / fade-prone rows are excluded from Picks / morning / Premove. Session `newer_than` still keeps the live board on today only.

Ask-sweep + tide is **necessary but not sufficient**. See `study/lessons-2026-09-04.md`. Fresh MU-class sweeps stay high; MMM-class aged call watches expire; same-day tags without follow-through drop off Picks.

**Bought / Watch entry** arm at live UW last/mid when available, else last session print, else the alert print — and label which. Never silently reuse a week-old `alert.price`.

Each chip shows the point delta and a short reason.

## Stack

Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui.
