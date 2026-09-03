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

`UNUSUAL_WHALES_API_KEY` is a Production secret on the Vercel project. It is not in git. On the hosted URL you do not paste the key.

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

Set `UNUSUAL_WHALES_API_KEY` in `.env.local`, or paste it in the **Unusual Whales API** box in the app. The key is POSTed to `POST /api/uw-key`, checked against Unusual Whales, stored only on the server (`.env.local`), and never written to the browser or returned by any API.

| FlowGuard route | Unusual Whales endpoint |
| --- | --- |
| `GET /api/flow` | `GET /api/option-trades/flow-alerts` (`unusual=true` when the preset is on) |
| `GET /api/picks` | Same flow alerts, scored and cut with strict anti-fade, top 10 by conviction |
| `GET /api/morning` | Frozen morning shortlist — top 5–8 from the 9:30–10:00 ET window, cached for the trading day |
| `GET /api/tide` | `GET /api/market/market-tide` |
| `GET /api/ticker/{ticker}/net-prem` | `GET /api/stock/{ticker}/net-prem-ticks` |
| `GET/POST /api/watches/check` | `GET /api/stock/{ticker}/option-contracts` (`option_symbol[]`) then `GET /api/option-contract/{id}/historic`; else last flow print |
| `GET/POST/DELETE /api/watches` | Vercel Blob (`flowguard/watches.json`) — durable across deploys; external checker reads `GET /api/watches` |

Requests use `Authorization: Bearer …` and `UW-CLIENT-API-ID: 100001`. If a live request fails, the screener falls back to mock data and shows a warning.

## Filters

- Min premium, DTE range, calls/puts, ticker
- Min conviction
- Unusual preset — passes `unusual=true` to Unusual Whales (live-flow defaults: volume>OI, size>OI, opening, OTM, single-leg, DTE≤60, ask-side≥50%, premium≥$10k)
- Strict anti-fade — hides 0–2 DTE, tiny premium, bid-dominant, and fighting-tide rows
- Auto-refresh every 45s, with pause

Click a row for the detail drawer: score chips, ask/bid split, market tide, ticker net-premium ticks, pin, note, and dismiss.

## Manager layer

The manager book sits on the same Unusual Whales tape. It does not pick stocks.

- **Morning shortlist** — `GET /api/morning` freezes the top 5–8 setups from the 9:30–10:00 ET flow window. The list is computed deterministically from the session's first 30 minutes and does not churn with the live tape. Rolls over automatically on the next trading day. If the pre-open window has fewer than 3 setups, the full tape is used as a fallback (labeled).
- **Picks of the Day** — `GET /api/picks` takes the unusual-flow tape, applies **strict anti-fade**, keeps conviction ≥ 55, and returns the top 5–10 setups by conviction with a plain-English thesis, fade risks, and an explicit options hold window (intraday–2 sessions, 2–7 sessions, or up to ~1–2 weeks — never hold to expiry, never a stock hold).
- **Watchlist** — pin a ticker or a specific option contract. Stored in `localStorage` (`flowguard.watchlist`). Toggle *Watchlist only* to filter the tape.
- **Manager notes** — optional note per alert id (`flowguard.notes`).
- **Dismiss** — hide an alert from picks and the tape (`flowguard.dismissed`). Restore one name or restore all.
- **Price watches** — options only. **Bought** (one tap) arms an adverse-move watch at the last print (15% default). **Watch entry** (one tap) arms an entry-approach watch (5% band). Tap Adjust to change the numbers. Watches are stored in Vercel Blob (durable across deploys) and synced to `localStorage` on load. An external checker calls `GET /api/watches` to read all armed watches, and `GET /api/watches/check` to get live quotes and alerts. On each arm/remove the server also POSTs to `WATCH_WEBHOOK_URL` (with `WATCH_WEBHOOK_SECRET` header) if set. Never auto-trades.

No brokerage routing. Notes and pins stay in the browser. Price watches are durable on the server.

## Conviction score

Base 32, clamped 0–100.

**Boosts:** ask-side premium dominance, `all_opening_trades`, high `volume_oi_ratio`, meaningful `total_premium`, DTE 7–45, sweeps/floor, single-leg, aligned with market/ticker tide.

**Penalties:** DTE 0–2, tiny premium, bid-dominant prints, multi-leg, fighting market or ticker tide (`/api/market/market-tide` and `/api/stock/{ticker}/net-prem-ticks`).

Each chip shows the point delta and a short reason.

## Stack

Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui.
