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
| `GET /api/tide` | `GET /api/market/market-tide` |
| `GET /api/ticker/{ticker}/net-prem` | `GET /api/stock/{ticker}/net-prem-ticks` |
| `POST /api/watches/check` | `GET /api/stock/{ticker}/option-contracts` (`option_symbol[]`) then `GET /api/option-contract/{id}/historic`; else last flow print |
| `GET/POST/DELETE /api/watches` | Local `data/watches.json` for monitor jobs (ephemeral on Vercel — pass watches into `/check`) |

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

- **Picks of the Day** — `GET /api/picks` takes the unusual-flow tape, applies **strict anti-fade**, keeps conviction ≥ 55, and returns the top 5–10 setups by conviction with a plain-English thesis, fade risks, and an explicit options hold window (intraday–2 sessions, 2–7 sessions, or up to ~1–2 weeks — never hold to expiry, never a stock hold).
- **Watchlist** — pin a ticker or a specific option contract. Stored in `localStorage` (`flowguard.watchlist`). Toggle *Watchlist only* to filter the tape.
- **Manager notes** — optional note per alert id (`flowguard.notes`).
- **Dismiss** — hide an alert from picks and the tape (`flowguard.dismissed`). Restore one name or restore all.
- **Price watches** — options only. **Track entry** alerts if live premium moves against a fill (default 15% or a stop). **Watch for entry** alerts when live premium is within 5% of a target. Stored in `localStorage` (`flowguard.priceWatches`); `POST /api/watches/check` quotes Unusual Whales last/NBBO (else last flow print) and returns structured alerts. Never auto-trades.

No brokerage routing. Notes, pins, and price watches never leave the browser except when you ask the server to check quotes.

## Conviction score

Base 32, clamped 0–100.

**Boosts:** ask-side premium dominance, `all_opening_trades`, high `volume_oi_ratio`, meaningful `total_premium`, DTE 7–45, sweeps/floor, single-leg, aligned with market/ticker tide.

**Penalties:** DTE 0–2, tiny premium, bid-dominant prints, multi-leg, fighting market or ticker tide (`/api/market/market-tide` and `/api/stock/{ticker}/net-prem-ticks`).

Each chip shows the point delta and a short reason.

## Stack

Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui.
