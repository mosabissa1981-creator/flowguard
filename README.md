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

```bash
npm run build
npm start
```

## Live data

Set `UNUSUAL_WHALES_API_KEY` in `.env.local`. The key is read only in Next.js Route Handlers and is never sent to the client.

| FlowGuard route | Unusual Whales endpoint |
| --- | --- |
| `GET /api/flow` | `GET /api/option-trades/flow-alerts` (`unusual=true` when the preset is on) |
| `GET /api/tide` | `GET /api/market/market-tide` |
| `GET /api/ticker/{ticker}/net-prem` | `GET /api/stock/{ticker}/net-prem-ticks` |

Requests use `Authorization: Bearer …` and `UW-CLIENT-API-ID: 100001`. If a live request fails, the screener falls back to mock data and shows a warning.

## Filters

- Min premium, DTE range, calls/puts, ticker
- Min conviction
- Unusual preset — passes `unusual=true` to Unusual Whales (live-flow defaults: volume>OI, size>OI, opening, OTM, single-leg, DTE≤60, ask-side≥50%, premium≥$10k)
- Strict anti-fade — hides 0–2 DTE, tiny premium, bid-dominant, and fighting-tide rows
- Auto-refresh every 45s, with pause

Click a row for the detail drawer: score chips, ask/bid split, market tide, and ticker net-premium ticks.

## Conviction score

Base 42, clamped 0–100.

**Boosts:** ask-side premium dominance, `all_opening_trades`, high `volume_oi_ratio`, meaningful `total_premium`, DTE 7–45, sweeps/floor, single-leg, aligned with market/ticker tide.

**Penalties:** DTE 0–2, tiny premium, bid-dominant prints, multi-leg, fighting market or ticker tide (`/api/market/market-tide` and `/api/stock/{ticker}/net-prem-ticks`).

Each chip shows the point delta and a short reason.

## Stack

Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui.
