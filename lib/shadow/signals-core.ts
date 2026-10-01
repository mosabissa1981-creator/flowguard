/**
 * Richer flow-confirmation signals (SHADOW / study only — never change live picks).
 * Pure functions shared by the live /api/shadow/signals route and the box history backtest.
 *
 *  - Dark pool: large off-exchange prints (≥ $1M) within ±15 min of the flow print; buyer- vs seller-initiated
 *    by print price vs NBBO mid. Confirms a call when buyer-initiated premium dominates (puts: seller-initiated).
 *  - Dealer positioning (GEX by strike, UW greek-exposure/strike): net gamma sign (negative = dealers chase moves,
 *    trend-friendly; positive = pinning), call wall above / put wall below spot, and whether the strike sits
 *    beyond the wall the move must break.
 *  - Open-interest follow-through: next-session OI vs print-day OI on the same contract (positions actually opened).
 */

export type DarkPoolPrint = { price: number; premium: number; nbboBid: number | null; nbboAsk: number | null; executedAt: string };
export type GexStrike = { strike: number; callGex: number; putGex: number };

export type DarkPoolSignal = {
  prints: number;
  premiumUsd: number;
  buyPremiumUsd: number;
  sellPremiumUsd: number;
  bias: number | null; // (buy − sell) / (buy + sell)
  verdict: "confirm" | "conflict" | "neutral" | "none";
};

export type GexSignal = {
  netGex: number;
  regime: "negative" | "positive" | "flat";
  callWall: number | null;
  putWall: number | null;
  /** % from spot to the wall the trade must break (call: call wall above; put: put wall below). */
  roomPct: number | null;
  strikeBeyondWall: boolean;
  verdict: "confirm" | "conflict" | "neutral";
};

export type OiSignal = { oiPrintDay: number | null; oiNextDay: number | null; changePct: number | null; verdict: "confirm" | "conflict" | "neutral" | "pending" };

export const DP_WINDOW_MS = 15 * 60_000;
export const DP_MIN_BLOCK_USD = 1_000_000;
const DP_MIN_TOTAL_USD = 5_000_000;
const DP_BIAS = 0.2;

export function darkPoolSignal(prints: DarkPoolPrint[], side: "call" | "put", printMs: number): DarkPoolSignal {
  let buy = 0;
  let sell = 0;
  let total = 0;
  let n = 0;
  for (const p of prints) {
    const ms = Date.parse(p.executedAt);
    if (!Number.isFinite(ms) || Math.abs(ms - printMs) > DP_WINDOW_MS || p.premium < DP_MIN_BLOCK_USD) continue;
    n += 1;
    total += p.premium;
    if (p.nbboBid != null && p.nbboAsk != null && p.nbboAsk >= p.nbboBid) {
      const mid = (p.nbboBid + p.nbboAsk) / 2;
      if (p.price > mid) buy += p.premium;
      else if (p.price < mid) sell += p.premium;
    }
  }
  const bias = buy + sell > 0 ? Math.round(((buy - sell) / (buy + sell)) * 100) / 100 : null;
  let verdict: DarkPoolSignal["verdict"] = n === 0 ? "none" : "neutral";
  if (total >= DP_MIN_TOTAL_USD && bias != null) {
    const aligned = side === "call" ? bias >= DP_BIAS : bias <= -DP_BIAS;
    const against = side === "call" ? bias <= -DP_BIAS : bias >= DP_BIAS;
    verdict = aligned ? "confirm" : against ? "conflict" : "neutral";
  }
  return { prints: n, premiumUsd: Math.round(total), buyPremiumUsd: Math.round(buy), sellPremiumUsd: Math.round(sell), bias, verdict };
}

export function gexSignal(rows: GexStrike[], spot: number, side: "call" | "put", strike: number): GexSignal | null {
  if (!rows.length || !(spot > 0)) return null;
  let net = 0;
  let callWall: number | null = null;
  let callMax = 0;
  let putWall: number | null = null;
  let putMax = 0;
  for (const r of rows) {
    net += r.callGex + r.putGex;
    // Only strikes within ±25% of spot define walls.
    if (Math.abs(r.strike - spot) / spot > 0.25) continue;
    if (r.strike >= spot && r.callGex > callMax) {
      callMax = r.callGex;
      callWall = r.strike;
    }
    if (r.strike <= spot && Math.abs(r.putGex) > putMax) {
      putMax = Math.abs(r.putGex);
      putWall = r.strike;
    }
  }
  const scale = rows.reduce((m, r) => Math.max(m, Math.abs(r.callGex), Math.abs(r.putGex)), 0) || 1;
  const regime: GexSignal["regime"] = Math.abs(net) < scale * 0.05 ? "flat" : net < 0 ? "negative" : "positive";
  const wall = side === "call" ? callWall : putWall;
  const roomPct = wall != null ? Math.round((Math.abs(wall - spot) / spot) * 1000) / 10 : null;
  const strikeBeyondWall = wall != null && (side === "call" ? strike > wall : strike < wall);
  let verdict: GexSignal["verdict"] = "neutral";
  if (regime === "negative" && !strikeBeyondWall && (roomPct == null || roomPct >= 2)) verdict = "confirm";
  else if (regime === "positive" && (strikeBeyondWall || (roomPct != null && roomPct < 1))) verdict = "conflict";
  return { netGex: Math.round(net), regime, callWall, putWall, roomPct, strikeBeyondWall, verdict };
}

export function oiSignal(oiPrintDay: number | null, oiNextDay: number | null, printSize?: number | null): OiSignal {
  if (oiNextDay == null) return { oiPrintDay, oiNextDay, changePct: null, verdict: "pending" };
  if (!oiPrintDay) return { oiPrintDay, oiNextDay, changePct: null, verdict: oiNextDay > (printSize ?? 0) * 0.5 ? "confirm" : "neutral" };
  const changePct = Math.round(((oiNextDay - oiPrintDay) / oiPrintDay) * 1000) / 10;
  const opened = printSize ? oiNextDay - oiPrintDay >= printSize * 0.5 : changePct >= 10;
  return { oiPrintDay, oiNextDay, changePct, verdict: opened ? "confirm" : changePct <= -5 ? "conflict" : "neutral" };
}

export function parseDarkPool(rows: Record<string, unknown>[]): DarkPoolPrint[] {
  const n = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  return rows
    .filter((r) => !r.canceled)
    .map((r) => ({ price: n(r.price) ?? 0, premium: n(r.premium) ?? 0, nbboBid: n(r.nbbo_bid), nbboAsk: n(r.nbbo_ask), executedAt: String(r.executed_at ?? "") }));
}

export function parseGexStrikes(rows: Record<string, unknown>[]): GexStrike[] {
  return rows.map((r) => ({ strike: Number(r.strike) || 0, callGex: Number(r.call_gex) || 0, putGex: Number(r.put_gex) || 0 })).filter((r) => r.strike > 0);
}
