/**
 * Richer flow-confirmation signals (SHADOW / study only — never change live picks).
 * Pure functions shared by the live /api/shadow/signals route and the box history backtest.
 *
 *  - Dark pool: large off-exchange prints (≥ $1M) within ±15 min of the flow print; buyer- vs seller-initiated
 *    by print price vs NBBO mid. Confirms a call when buyer-initiated premium dominates (puts: seller-initiated).
 *  - Dealer positioning (GEX by strike, UW greek-exposure/strike): net gamma sign (negative = dealers chase moves,
 *    trend-friendly; positive = pinning), call wall above / put wall below spot, and whether the strike sits
 *    beyond the wall the move must break.
 *  - Open-interest follow-through: next-session OI change vs the print day's contract volume (positions actually opened).
 *  - Insider trades (Form 4, as of the print day by filing date): open-market buys vs discretionary sells, last 90 days.
 *  - Net premium per ticker (UW net-prem ticks, summed up to the print time): call vs put net premium, direction-aware.
 *  - FLEX OI transfer: FLEX (institutional custom-term) open interest consolidated into the contract (rare; UW daily OI).
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
  /** TEST: gamma flip ≈ zero crossing of cumulative net GEX (low → high strikes) nearest spot. */
  flipLevel?: number | null;
  /** TEST: "below" / "above" = spot vs the flip level (null when no crossing). Logged for scoring only. */
  spotVsFlip?: "below" | "above" | null;
  netNegative?: boolean;
};

/** Gamma flip level: cumulative net (call+put) GEX from the lowest strike up; zero crossing nearest spot (±25% preferred). */
export function gammaFlipLevel(rows: GexStrike[], spot: number): number | null {
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  const xs: number[] = [];
  let cum = 0;
  let prevStrike: number | null = null;
  let prevCum: number | null = null;
  for (const r of sorted) {
    cum += r.callGex + r.putGex;
    if (prevCum != null && prevStrike != null && ((prevCum < 0 && cum >= 0) || (prevCum > 0 && cum <= 0))) {
      const d = Math.abs(prevCum) + Math.abs(cum);
      xs.push(prevStrike + (d ? Math.abs(prevCum) / d : 0) * (r.strike - prevStrike));
    }
    prevStrike = r.strike;
    prevCum = cum;
  }
  if (!xs.length || !(spot > 0)) return null;
  const near = xs.filter((x) => Math.abs(x - spot) / spot <= 0.25);
  const pool = near.length ? near : xs;
  return Math.round(pool.reduce((best, x) => (Math.abs(x - spot) < Math.abs(best - spot) ? x : best), pool[0]) * 100) / 100;
}

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
  const flipLevel = gammaFlipLevel(rows, spot);
  const spotVsFlip = flipLevel == null ? null : spot < flipLevel ? "below" : "above";
  return { netGex: Math.round(net), regime, callWall, putWall, roomPct, strikeBeyondWall, verdict, flipLevel, spotVsFlip, netNegative: net < 0 };
}

/**
 * OI follow-through (v2, stricter): ΔOI on the next session vs the print day's contract volume.
 * confirm = ΔOI ≥ 50% of the day's volume and ≥ 100 contracts (mostly opening); conflict = OI fell or ΔOI < 20% of
 * the day's volume (mostly closing / day-traded); else neutral.
 * (v1 used ΔOI ≥ +10% and confirmed ~96% of entries — not informative.)
 */
export function oiSignal(oiPrintDay: number | null, oiNextDay: number | null, dayVolume?: number | null): OiSignal {
  if (oiNextDay == null) return { oiPrintDay, oiNextDay, changePct: null, verdict: "pending" };
  const base = oiPrintDay ?? 0;
  const delta = oiNextDay - base;
  const changePct = base > 0 ? Math.round((delta / base) * 1000) / 10 : null;
  const vol = dayVolume ?? 0;
  let verdict: OiSignal["verdict"] = "neutral";
  if (delta < 0 || (vol > 0 && delta < 0.2 * vol)) verdict = "conflict";
  else if (delta >= 100 && vol > 0 && delta >= 0.5 * vol) verdict = "confirm";
  return { oiPrintDay, oiNextDay, changePct, verdict };
}

export type InsiderSignal = { buys: number; sells: number; buyUsd: number; sellUsd: number; verdict: "confirm" | "conflict" | "neutral" | "none" };
const INSIDER_WINDOW_DAYS = 90;

/** As of `day` (by filing date), last 90 days: open-market purchases (code P) vs discretionary sales (code S, not 10b5-1). */
export function insiderSignal(rows: Record<string, unknown>[], side: "call" | "put", day: string): InsiderSignal {
  const from = new Date(Date.parse(`${day}T12:00:00Z`) - INSIDER_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
  let buys = 0;
  let sells = 0;
  let buyUsd = 0;
  let sellUsd = 0;
  for (const r of rows) {
    const filed = String(r.filing_date ?? r.transaction_date ?? "").slice(0, 10);
    if (!filed || filed >= day || filed < from) continue;
    const code = String(r.transaction_code ?? "");
    const usd = Math.abs(Number(r.amount) || 0) * (Number(r.price) || Number(r.stock_price) || 0);
    if (code === "P") {
      buys += 1;
      buyUsd += usd;
    } else if (code === "S" && !r.is_10b5_1) {
      sells += 1;
      sellUsd += usd;
    }
  }
  let verdict: InsiderSignal["verdict"] = buys + sells === 0 ? "none" : "neutral";
  const bullish = buyUsd >= 100_000 && buyUsd >= sellUsd * 0.5;
  const bearish = sellUsd >= 1_000_000 && buyUsd < 100_000;
  if (bullish) verdict = side === "call" ? "confirm" : "conflict";
  else if (bearish) verdict = side === "put" ? "confirm" : "conflict";
  return { buys, sells, buyUsd: Math.round(buyUsd), sellUsd: Math.round(sellUsd), verdict };
}

export type NetPremSignal = { netCallPremium: number; netPremium: number; netPutPremium: number; verdict: "confirm" | "conflict" | "neutral" | "none" };

/** Ticker net premium from session start up to the print (no look-ahead). Bullish = net call − net put premium > 0. */
export function netPremSignal(ticks: Array<{ tape_time: string; net_call_premium: string | number; net_put_premium: string | number }>, side: "call" | "put", printMs: number): NetPremSignal {
  let c = 0;
  let p = 0;
  let n = 0;
  for (const t of ticks) {
    const ms = Date.parse(t.tape_time);
    if (!Number.isFinite(ms) || ms > printMs) continue;
    c += Number(t.net_call_premium) || 0;
    p += Number(t.net_put_premium) || 0;
    n += 1;
  }
  const net = c - p;
  let verdict: NetPremSignal["verdict"] = n === 0 ? "none" : "neutral";
  const scale = Math.max(Math.abs(c), Math.abs(p), 1);
  if (n > 0 && Math.abs(net) >= 1_000_000 && Math.abs(net) >= 0.25 * scale) {
    const bullish = net > 0;
    verdict = (side === "call") === bullish ? "confirm" : "conflict";
  }
  return { netCallPremium: Math.round(c), netPutPremium: Math.round(p), netPremium: Math.round(net), verdict };
}

export type FlexSignal = { transferredOi: number; verdict: "confirm" | "none" };
/** FLEX OI consolidated into the contract on the print day or the next two sessions (institutional custom-term positions). */
export function flexSignal(bars: Array<{ date: string; flexOiTransfer?: number | null }>, day: string): FlexSignal {
  const after = bars.filter((b) => b.date >= day).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 3);
  const t = after.reduce((s, b) => s + (b.flexOiTransfer ?? 0), 0);
  return { transferredOi: t, verdict: t > 0 ? "confirm" : "none" };
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
