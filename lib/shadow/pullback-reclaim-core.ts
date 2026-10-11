/**
 * TEST / SHADOW "Pullback reclaim" lane — pure logic (no I/O). Never changes live picks.
 * Spec: study/pullback-reclaim-backtest-summary.md (43 mega-caps/ETFs, Oct 2024 – Sep 2026 daily bars).
 *  - Uptrend: close > SMA50 > SMA100, and SMA20 / SMA50 / SMA100 each higher than 5 sessions ago.
 *  - Signal: ≥3% drop from the 10-day high (10-day high vs the lowest low of the last 6 sessions), then the prior close was
 *    under the prior 5-day average and today closes back above the 5-day average AND above the prior day's high.
 *  - ≥5 sessions between signals per ticker.
 *  - Paper score: entry = signal-day close, 10-session hold, stop counts first when both hit in a session, gaps fill at the open,
 *    no costs. Two exit variants: ATR (1.5×ATR14 stop / 3×ATR14 target) and fixed (+5.5% / −1.3%).
 */

export type Bar = { date: string; o: number; h: number; l: number; c: number };

export const PULLBACK_UNIVERSE =
  "GOOGL AAPL MSFT NVDA AMZN META TSLA AVGO NFLX AMD ORCL PLTR COST JPM V LLY WMT BAC GS CRM MU INTC UBER SPY QQQ IWM DIA SMH XLK XLF XLE XLV XLY XLI GLD SLV TLT IBIT ARKK SOXL TQQQ KRE XBI".split(" ");

export const HOLD_SESSIONS = 10;
export const MIN_GAP_SESSIONS = 5;
export const MIN_DIP = 0.03;
export const MIN_BARS = 111;
export const RECHECK_AFTER_SIGNALS = 100;

export type VariantId = "atr" | "fixed";
export const VARIANTS: Record<VariantId, { label: string; stop: (atrPct: number) => number; target: (atrPct: number) => number }> = {
  atr: { label: "ATR 1.5 stop / 3 target, 10 sessions", stop: (a) => 1.5 * a, target: (a) => 3 * a },
  fixed: { label: "Fixed +5.5% / −1.3%, 10 sessions", stop: () => 0.013, target: () => 0.055 },
};

export type SimResult = { outcome: "W" | "L" | "T"; ret: number; exitDate: string };

const sma = (c: number[], i: number, n: number) => {
  let s = 0;
  for (let k = i - n + 1; k <= i; k += 1) s += c[k];
  return s / n;
};

export function atr14(b: Bar[], i: number): number {
  let s = 0;
  for (let k = i - 13; k <= i; k += 1) s += Math.max(b[k].h - b[k].l, Math.abs(b[k].h - b[k - 1].c), Math.abs(b[k].l - b[k - 1].c));
  return s / 14;
}

export type DayEval = { uptrend: boolean; signal: boolean; dip: number; atrPct: number };

/** Evaluate bar index i (needs ≥111 bars up to i; i ≥ 105 and i ≥ 14). Dedupe is applied by the caller. */
export function evalDay(b: Bar[], i: number): DayEval | null {
  if (i < 110 || i >= b.length) return null;
  const c = b.map((x) => x.c);
  const up =
    c[i] > sma(c, i, 50) &&
    sma(c, i, 50) > sma(c, i, 100) &&
    sma(c, i, 50) > sma(c, i - 5, 50) &&
    sma(c, i, 100) > sma(c, i - 5, 100) &&
    sma(c, i, 20) > sma(c, i - 5, 20);
  const atrPct = atr14(b, i) / c[i];
  if (!up) return { uptrend: false, signal: false, dip: 0, atrPct };
  let hi = -Infinity;
  for (let k = i - 10; k < i; k += 1) hi = Math.max(hi, b[k].h);
  let lo = Infinity;
  for (let k = i - 6; k < i; k += 1) lo = Math.min(lo, b[k].l);
  const dip = (hi - lo) / hi;
  const reclaim = c[i - 1] < sma(c, i - 1, 5) && c[i] > sma(c, i, 5) && c[i] > b[i - 1].h;
  return { uptrend: true, signal: dip >= MIN_DIP && reclaim, dip, atrPct };
}

/** Entry at b[i].c; walks the following sessions. Returns null while unresolved (fewer than `hold` sessions and no hit yet). */
export function simulate(b: Bar[], i: number, tp: number, sl: number, hold = HOLD_SESSIONS): SimResult | null {
  const e = b[i].c;
  const T = e * (1 + tp);
  const S = e * (1 - sl);
  const last = Math.min(i + hold, b.length - 1);
  for (let j = i + 1; j <= last; j += 1) {
    const { o, h, l, date } = b[j];
    if (o <= S) return { outcome: "L", ret: o / e - 1, exitDate: date };
    if (o >= T) return { outcome: "W", ret: o / e - 1, exitDate: date };
    if (l <= S) return { outcome: "L", ret: -sl, exitDate: date };
    if (h >= T) return { outcome: "W", ret: tp, exitDate: date };
  }
  if (i + hold < b.length) return { outcome: "T", ret: b[i + hold].c / e - 1, exitDate: b[i + hold].date };
  return null;
}

/** Seeded PRNG so the CI is reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type DayAgg = Record<string, { n: number; s: number }>;

const mean = (d: DayAgg) => {
  let n = 0;
  let s = 0;
  for (const v of Object.values(d)) {
    n += v.n;
    s += v.s;
  }
  return { n, ev: n ? s / n : null };
};

/** Date-cluster bootstrap CI of (signal EV − baseline EV), % per trade. Matches the backtest method (B=1000). */
export function diffCi(sig: DayAgg, base: DayAgg, B = 1000): { diff: number | null; lo: number | null; hi: number | null } {
  const a = mean(sig);
  const b = mean(base);
  if (a.ev == null || b.ev == null) return { diff: null, lo: null, hi: null };
  const diff = a.ev - b.ev;
  const days = [...new Set([...Object.keys(sig), ...Object.keys(base)])];
  if (Object.keys(sig).length < 3) return { diff, lo: null, hi: null };
  const rand = rng(1);
  const out: number[] = [];
  for (let r = 0; r < B; r += 1) {
    let sa = 0, na = 0, sb = 0, nb = 0;
    for (let k = 0; k < days.length; k += 1) {
      const d = days[Math.floor(rand() * days.length)];
      const x = sig[d];
      const y = base[d];
      if (x) { sa += x.s; na += x.n; }
      if (y) { sb += y.s; nb += y.n; }
    }
    if (na && nb) out.push(sa / na - sb / nb);
  }
  if (out.length < 50) return { diff, lo: null, hi: null };
  out.sort((p, q) => p - q);
  return { diff, lo: out[Math.floor(0.025 * out.length)], hi: out[Math.floor(0.975 * out.length)] };
}

export function summarize(sig: DayAgg, base: DayAgg, hits: { w: number; l: number; t: number }) {
  const a = mean(sig);
  const b = mean(base);
  const ci = diffCi(sig, base);
  const r = (v: number | null) => (v == null ? null : Math.round(v * 1000) / 1000);
  return {
    signalN: a.n,
    signalEvPct: r(a.ev),
    hitPct: a.n ? Math.round((hits.w / a.n) * 1000) / 10 : null,
    stopPct: a.n ? Math.round((hits.l / a.n) * 1000) / 10 : null,
    timeoutPct: a.n ? Math.round((hits.t / a.n) * 1000) / 10 : null,
    baselineN: b.n,
    baselineEvPct: r(b.ev),
    gainOverBaselinePct: r(ci.diff),
    ci95: ci.lo == null || ci.hi == null ? null : [r(ci.lo), r(ci.hi)],
    ciAboveZero: ci.lo != null && ci.lo > 0,
  };
}
