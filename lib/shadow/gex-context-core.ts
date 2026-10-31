import { impliedVol, sessionsToCalendarDays, spotForPremium } from "@/lib/shadow/bs";
import { gammaFlipLevel, type GexStrike } from "@/lib/shadow/signals-core";

/**
 * TEST MODE ONLY — GEX + DEX context for the GEX/DEX Grok shadow lane (lib/shadow/grok-gex-dex.ts). Pure (no I/O).
 * Same wall / flip definitions as lib/shadow/signals-core.ts and scripts/study/gex-walls-backtest.py:
 *  - call wall = strike >= spot with the largest positive call GEX (±25% of spot); put wall = strike <= spot with the largest |put GEX|.
 *  - gamma flip = zero crossing of cumulative net GEX (low → high strikes) nearest spot.
 *  - "red bar" = biggest negative net-GEX strike within ±25% (magnet / accelerator in folklore; not confirmed by the 2-year test).
 * Context only: the 2-year tests found no reliable edge for flip or walls as a filter.
 */

export type GexView = {
  netSign: "positive" | "negative" | "flat";
  flip: number | null;
  spotVsFlip: "above" | "below" | null;
  flipDistPct: number | null;
  callWall: number | null;
  callWallPct: number | null;
  putWall: number | null;
  putWallPct: number | null;
  redBar: number | null;
  redBarPct: number | null;
  /** Calls: target spot above the call wall; puts: target spot below the put wall. null when unknown. */
  targetPastWall: boolean | null;
};

/** Dealer delta exposure by strike (same UW greek-exposure rows: call_delta / put_delta). */
export type DexStrike = { strike: number; callDelta: number; putDelta: number };

export function parseDexStrikes(rows: Record<string, unknown>[]): DexStrike[] {
  return rows
    .map((r) => ({ strike: Number(r.strike) || 0, callDelta: Number(r.call_delta) || 0, putDelta: Number(r.put_delta) || 0 }))
    .filter((r) => r.strike > 0 && (r.callDelta !== 0 || r.putDelta !== 0));
}

export type DexView = {
  net: number;
  netSign: "positive" | "negative" | "flat";
  /** Largest positive / negative net (call+put) delta strike within ±25% of spot, and signed % from spot. */
  maxPos: number | null;
  maxPosPct: number | null;
  maxNeg: number | null;
  maxNegPct: number | null;
  /** Net DEX within ±5% of spot. */
  nearNet: number;
  priorNet: number | null;
  changePct: number | null;
};

export function dexView(rows: DexStrike[], spot: number, prior: DexStrike[] | null): DexView | null {
  if (!rows.length || !(spot > 0)) return null;
  let net = 0;
  let gross = 0;
  let nearNet = 0;
  let maxPos: number | null = null;
  let pv = 0;
  let maxNeg: number | null = null;
  let nv = 0;
  for (const r of rows) {
    const n = r.callDelta + r.putDelta;
    net += n;
    gross += Math.abs(r.callDelta) + Math.abs(r.putDelta);
    const d = Math.abs(r.strike - spot) / spot;
    if (d <= 0.05) nearNet += n;
    if (d > 0.25) continue;
    if (n > pv) [pv, maxPos] = [n, r.strike];
    if (n < nv) [nv, maxNeg] = [n, r.strike];
  }
  const priorNet = prior && prior.length ? prior.reduce((a, r) => a + r.callDelta + r.putDelta, 0) : null;
  return {
    net: Math.round(net),
    netSign: Math.abs(net) < (gross || 1) * 0.05 ? "flat" : net < 0 ? "negative" : "positive",
    maxPos,
    maxPosPct: maxPos == null ? null : pct(maxPos / spot - 1),
    maxNeg,
    maxNegPct: maxNeg == null ? null : pct(maxNeg / spot - 1),
    nearNet: Math.round(nearNet),
    priorNet: priorNet == null ? null : Math.round(priorNet),
    changePct: priorNet == null || priorNet === 0 ? null : pct((net - priorNet) / Math.abs(priorNet)),
  };
}

const big = (x: number) => {
  const a = Math.abs(x);
  const t = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}k` : `${Math.round(a)}`;
  return `${x < 0 ? "-" : "+"}${t}`;
};

export type GexContext = {
  /** Underlying level where the option is +30% one session later (Black-Scholes, IV from the entry ask). */
  targetSpot: number | null;
  targetMovePct: number | null;
  all: GexView | null;
  weekly: GexView | null;
  weeklyExpiry: string;
  /** All-expiry dealer delta exposure (live context only: no 2-year DEX history exists). */
  dex?: DexView | null;
};

const pct = (x: number) => Math.round(x * 1000) / 10;

export function gexView(rows: GexStrike[], spot: number, side: "call" | "put", targetSpot: number | null): GexView | null {
  if (!rows.length || !(spot > 0)) return null;
  let net = 0;
  let scale = 0;
  let callWall: number | null = null;
  let callMax = 0;
  let putWall: number | null = null;
  let putMax = 0;
  let redBar: number | null = null;
  let redMin = 0;
  for (const r of rows) {
    const n = r.callGex + r.putGex;
    net += n;
    scale = Math.max(scale, Math.abs(r.callGex), Math.abs(r.putGex));
    if (Math.abs(r.strike - spot) / spot > 0.25) continue;
    if (r.strike >= spot && r.callGex > callMax) [callMax, callWall] = [r.callGex, r.strike];
    if (r.strike <= spot && Math.abs(r.putGex) > putMax) [putMax, putWall] = [Math.abs(r.putGex), r.strike];
    if (n < redMin) [redMin, redBar] = [n, r.strike];
  }
  const flip = gammaFlipLevel(rows, spot);
  const wall = side === "call" ? callWall : putWall;
  return {
    netSign: Math.abs(net) < (scale || 1) * 0.05 ? "flat" : net < 0 ? "negative" : "positive",
    flip,
    spotVsFlip: flip == null ? null : spot < flip ? "below" : "above",
    flipDistPct: flip == null ? null : pct(flip / spot - 1),
    callWall,
    callWallPct: callWall == null ? null : pct(callWall / spot - 1),
    putWall,
    putWallPct: putWall == null ? null : pct(putWall / spot - 1),
    redBar,
    redBarPct: redBar == null ? null : pct(redBar / spot - 1),
    targetPastWall: wall == null || targetSpot == null ? null : side === "call" ? targetSpot > wall : targetSpot < wall,
  };
}

/** Underlying level at which the option is worth +30% one session later. */
export function targetSpotFor(c: { side: "call" | "put"; strike: number; dte: number; entry: number; underlying: number }): number | null {
  const T = Math.max(c.dte, 1) / 365;
  const iv = impliedVol(c.entry, c.underlying, c.strike, T, c.side);
  if (iv == null) return null;
  const T1 = Math.max(T - sessionsToCalendarDays(1) / 365, 0.5 / 365);
  const s = spotForPremium(c.entry * 1.3, c.underlying, c.strike, T1, iv, c.side);
  return s == null ? null : Math.round(s * 100) / 100;
}

/** First Friday strictly after `day` (YYYY-MM-DD) = the nearest weekly expiry used by the 2-year per-expiry study. */
export function nearestWeeklyExpiry(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  const add = (5 - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + add);
  return d.toISOString().slice(0, 10);
}

function viewText(v: GexView | null, side: "call" | "put"): string {
  if (!v) return "n/a";
  const f = (x: number | null) => (x == null ? "n/a" : `${x > 0 ? "+" : ""}${x}%`);
  const flip = v.flip == null ? "flip n/a" : `spot ${v.spotVsFlip} flip ${v.flip} (${f(v.flipDistPct)})`;
  const past = v.targetPastWall == null ? "n/a" : v.targetPastWall ? "yes" : "no";
  return (
    `net ${v.netSign}, ${flip}, call wall ${v.callWall ?? "n/a"} (${f(v.callWallPct)}), put wall ${v.putWall ?? "n/a"} (${f(v.putWallPct)}), ` +
    `red bar ${v.redBar ?? "n/a"} (${f(v.redBarPct)}), target past ${side === "call" ? "call" : "put"} wall: ${past}`
  );
}

function dexText(v: DexView | null | undefined): string {
  if (!v) return "n/a";
  const f = (x: number | null) => (x == null ? "n/a" : `${x > 0 ? "+" : ""}${x}%`);
  const chg = v.priorNet == null ? "prior day n/a" : `vs prior day ${big(v.priorNet)} (${f(v.changePct)})`;
  return `net ${v.netSign} ${big(v.net)}, within ±5% ${big(v.nearNet)}, biggest + strike ${v.maxPos ?? "n/a"} (${f(v.maxPosPct)}), biggest - strike ${v.maxNeg ?? "n/a"} (${f(v.maxNegPct)}), ${chg}`;
}

/** One GEX line appended under each candidate's fact line. */
export function gexContextLine(ctx: GexContext | null, side: "call" | "put"): string {
  if (!ctx || (!ctx.all && !ctx.weekly && !ctx.dex)) return "  GEX/DEX: unavailable";
  const t = ctx.targetSpot == null ? "target spot n/a" : `+30% target needs spot ${ctx.targetSpot} (${ctx.targetMovePct! > 0 ? "+" : ""}${ctx.targetMovePct}%)`;
  return `  GEX: ${t}\n    all expiries: ${viewText(ctx.all, side)}\n    nearest weekly ${ctx.weeklyExpiry}: ${viewText(ctx.weekly, side)}\n  DEX (all expiries, live context only): ${dexText(ctx.dex)}`;
}
