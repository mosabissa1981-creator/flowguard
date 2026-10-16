/**
 * TEST / SHADOW "Risk-off continuation" lane — pure logic (no I/O). Never changes live picks.
 * Spec: study/risk-off-continuation-backtest.md (scripts/study/risk-off-continuation-backtest.py).
 *  - Only on PRIMARY risk-off mornings (lib/risk-off-core evaluateRiskOff, the same flag that holds ETF/index puts back live).
 *  - Continuation check at ~10:30 ET (9:30 CT): UW market tide still bearish AND SPY and QQQ both below today's open.
 *  - Paper puts: ETF/index puts, ask-side (≥65% ask premium), spread ≤10% of mid, printed at/after 10:30 ET; one per ticker.
 *  - Paper score: buy the ask, +30% target / −25% stop, 2 sessions (session 1 = entry day: only its close is used because the daily
 *    bar includes pre-entry prices), exit at session-2 bid (proxy for the 2:30 PM CT time stop). Stop counts first.
 */
import { isEtfOrIndex } from "@/lib/puts-rule";

export const CHECK_AFTER_ET_MIN = 10 * 60 + 30;
export const ENTRY_UNTIL_ET_MIN = 14 * 60;
export const TARGET = 0.3;
export const STOP = -0.25;
export const SPREAD_MAX = 0.1;
export const MIN_ASK_SHARE = 0.65;
export const MAX_PUTS_PER_DAY = 12;

export type TideBias = "bullish" | "bearish" | "neutral";
export type ContinuationCheck = {
  tide: TideBias | null;
  spyOpen: number | null;
  spyNow: number | null;
  qqqOpen: number | null;
  qqqNow: number | null;
  pass: boolean;
  reasons: string[];
};

export function evaluateContinuation(i: { tide: TideBias | null; spyOpen: number | null; spyNow: number | null; qqqOpen: number | null; qqqNow: number | null }): ContinuationCheck {
  const reasons: string[] = [];
  if (i.tide !== "bearish") reasons.push(`market tide ${i.tide ?? "unknown"} (needs bearish)`);
  const below = (o: number | null, n: number | null) => o != null && n != null && o > 0 && n < o;
  if (!below(i.spyOpen, i.spyNow)) reasons.push("SPY not below its open");
  if (!below(i.qqqOpen, i.qqqNow)) reasons.push("QQQ not below its open");
  return { ...i, pass: reasons.length === 0, reasons };
}

export type PutPrint = { contract: string; ticker: string; issueType: string | null; side: string; printUtc: string; price: number; bid: number | null; ask: number | null; askShare: number; premium: number; expiry: string };

export function spreadPct(bid: number | null, ask: number | null): number | null {
  if (bid == null || ask == null || !(ask > 0) || ask < bid || bid < 0) return null;
  return (ask - bid) / ((ask + bid) / 2);
}

/** Qualifying puts (one per ticker, largest premium), entry = ask at print. etMin = ET minutes of the print. */
export function selectPuts(prints: Array<PutPrint & { etMin: number }>, max = MAX_PUTS_PER_DAY) {
  const best = new Map<string, PutPrint & { etMin: number; spread: number; entry: number }>();
  for (const p of prints) {
    if (p.side !== "put" || !isEtfOrIndex(p.ticker, p.issueType)) continue;
    if (p.etMin < CHECK_AFTER_ET_MIN || p.etMin > ENTRY_UNTIL_ET_MIN) continue;
    if (p.askShare < MIN_ASK_SHARE) continue;
    const s = spreadPct(p.bid, p.ask);
    if (s == null || s > SPREAD_MAX) continue;
    const entry = p.ask as number;
    const cur = best.get(p.ticker);
    if (!cur || p.premium > cur.premium) best.set(p.ticker, { ...p, spread: s, entry });
  }
  return [...best.values()].sort((a, b) => b.premium - a.premium).slice(0, max);
}

export type OptBar = { date: string; o: number | null; h: number | null; l: number | null; c: number | null; bid: number | null; ask: number | null };
export type PutResult = { outcome: "W" | "L" | "T"; ret: number; how: string; exitDate: string };

/** Score with the entry-day bar + the next session bar. null until session 2 is complete. */
export function scorePut(entry: number, day: string, bars: OptBar[]): PutResult | null {
  const sess = bars.filter((b) => b.date >= day).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 2);
  if (sess.length < 2 || sess[0].date !== day || !(entry > 0)) return null;
  const sp = (b: OptBar) => spreadPct(b.bid, b.ask) ?? 0.05;
  const stop = entry * (1 + STOP), tgt = entry * (1 + TARGET);
  const out = (px: number, how: string, d: string): PutResult => {
    const ret = px / entry - 1;
    return { outcome: how.startsWith("target") ? "W" : how.startsWith("stop") ? "L" : ret > 0 ? "W" : ret < 0 ? "L" : "T", ret, how, exitDate: d };
  };
  const [b0, b1] = sess;
  if (b0.c) {
    const px = b0.c * (1 - sp(b0) / 2);
    if (px <= stop) return out(px, "stop_d1close", b0.date);
    if (px >= tgt) return out(px, "target_d1close", b0.date);
  }
  const f = 1 - sp(b1) / 2;
  const o = b1.o ?? b1.c;
  if (o) {
    const vals = [b1.h, o, b1.c].filter((x): x is number => x != null && x > 0);
    const lows = [b1.l, o, b1.c].filter((x): x is number => x != null && x > 0);
    const h = Math.max(...vals), l = Math.min(...lows);
    if (o <= stop) return out(o * f, "stop_gap", b1.date);
    if (o >= tgt) return out(o * f, "target_gap", b1.date);
    if (l <= stop) return out(stop * f, "stop", b1.date);
    if (h >= tgt) return out(tgt * f, "target", b1.date);
  }
  const px = b1.bid ?? (b1.c != null ? b1.c * f : null);
  return px ? out(px, "time", b1.date) : null;
}
