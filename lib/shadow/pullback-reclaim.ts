import "server-only";

import { kvSetNx } from "@/lib/kv";
import { loadPremoveShortlist } from "@/lib/premove";
import { tradingDateET } from "@/lib/session";
import { etClock } from "@/lib/shadow/budget";
import {
  type Bar,
  type DayAgg,
  HOLD_SESSIONS,
  MIN_GAP_SESSIONS,
  PULLBACK_UNIVERSE,
  RECHECK_AFTER_SIGNALS,
  type VariantId,
  VARIANTS,
  evalDay,
  simulate,
  summarize,
} from "@/lib/shadow/pullback-reclaim-core";
import { loadDoc, persistenceMode, saveDoc } from "@/lib/shadow/store";

/**
 * TEST MODE ONLY — "Pullback reclaim" paper lane (stocks/ETFs, 43-name liquid universe). Approved by Mosab 10/11/2026.
 * Log + quiet study-book scoring only: never feeds picks / premove / morning / AI picks / paper account, never Telegram.
 * Data: Yahoo daily bars (NO Unusual Whales calls). Premove is a TAG on the signal (log only); no ask-call / tide gating.
 * Runs once after the close (Vercel cron /api/shadow/pullback-reclaim, idempotent) and stores one doc in the shadow store.
 */
export const PULLBACK_DISCLAIMER =
  "TEST / SHADOW — Pullback reclaim paper lane. Logged and scored quietly in the study book; never affects live picks, never sends Telegram. Not financial advice; FlowGuard never trades.";

export const PULLBACK_RECHECK =
  `Re-check after ~${RECHECK_AFTER_SIGNALS} new resolved signals: promote ONLY if gain over baseline (signal EV − other-uptrend-day EV) stays positive with the 95% CI above zero. Backtest (465 signals, Oct 2024–Sep 2026): fixed variant +0.38pp (CI −0.01..0.80), ATR +0.47pp (CI −0.48..1.43) — not an edge claim.`;

const KIND = "pullback-reclaim";
const DAY = "book";
const UA = "Mozilla/5.0 (compatible; FlowGuard/1.0)";
const CHART = (s: string) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1y&interval=1d`;

type Res = { outcome: "W" | "L" | "T"; ret: number; exitDate: string };
export type PullbackSignal = {
  key: string;
  ticker: string;
  day: string;
  entry: number;
  atrPct: number;
  dipPct: number;
  /** Premove call candidate on the list when the signal was logged (null = unknown). Tag only, never a gate. */
  premove: boolean | null;
  loggedAt: string;
  res: Partial<Record<VariantId, Res>>;
};
type PendingBase = { ticker: string; day: string; entry: number; atrPct: number };
type Agg = Record<VariantId, { sig: DayAgg; base: DayAgg; sigPremove: DayAgg; hits: { w: number; l: number; t: number } }>;
export type PullbackBook = {
  updatedAt: string;
  processedThrough: string | null;
  lastSignal: Record<string, string>;
  signals: PullbackSignal[];
  pendingBase: PendingBase[];
  agg: Agg;
  runs: Array<{ at: string; through: string; newSignals: number; note: string }>;
};

const emptyAgg = (): Agg => ({
  atr: { sig: {}, base: {}, sigPremove: {}, hits: { w: 0, l: 0, t: 0 } },
  fixed: { sig: {}, base: {}, sigPremove: {}, hits: { w: 0, l: 0, t: 0 } },
});
const emptyBook = (): PullbackBook => ({ updatedAt: "", processedThrough: null, lastSignal: {}, signals: [], pendingBase: [], agg: emptyAgg(), runs: [] });

async function fetchBars(sym: string): Promise<Bar[]> {
  const res = await fetch(CHART(sym), { headers: { "User-Agent": UA, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(9000) });
  if (!res.ok) return [];
  const j = (await res.json()) as {
    chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[] }> } }> };
  };
  const r = j.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0] ?? {};
  const out: Bar[] = [];
  for (let i = 0; i < ts.length; i += 1) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null || !(c > 0) || !(o > 0)) continue;
    out.push({ date: tradingDateET(new Date(ts[i] * 1000)), o, h, l, c });
  }
  return out;
}

async function allBars(): Promise<Record<string, Bar[]>> {
  const out: Record<string, Bar[]> = {};
  for (let i = 0; i < PULLBACK_UNIVERSE.length; i += 8) {
    const chunk = PULLBACK_UNIVERSE.slice(i, i + 8);
    const got = await Promise.all(chunk.map((t) => fetchBars(t).catch(() => [] as Bar[])));
    chunk.forEach((t, k) => {
      out[t] = got[k];
    });
  }
  return out;
}

const addAgg = (d: DayAgg, day: string, ret: number) => {
  const x = (d[day] ??= { n: 0, s: 0 });
  x.n += 1;
  x.s += ret * 100;
};

function record(book: PullbackBook, v: VariantId, kind: "sig" | "base", day: string, r: Res, premove = false) {
  const a = book.agg[v];
  addAgg(a[kind], day, r.ret);
  if (kind === "sig") {
    if (premove) addAgg(a.sigPremove, day, r.ret);
    if (r.outcome === "W") a.hits.w += 1;
    else if (r.outcome === "L") a.hits.l += 1;
    else a.hits.t += 1;
  }
}

/** Tag only: is the ticker a Premove CALL candidate on the cached list right now? null if the list is unavailable. */
async function premoveTickers(): Promise<Set<string> | null> {
  try {
    const r = await loadPremoveShortlist();
    return new Set(r.picks.filter((p) => p.alert.type === "call").map((p) => p.alert.ticker.toUpperCase()));
  } catch {
    return null;
  }
}

export async function runPullbackReclaim(now = new Date()): Promise<{ book: PullbackBook; note: string }> {
  const book = (await loadDoc<PullbackBook>(KIND, DAY, { fresh: true })) ?? emptyBook();
  book.agg ??= emptyAgg();
  const today = tradingDateET(now);
  const c = etClock(now);
  const closed = c.minutes >= 16 * 60 + 10 || !c.weekday;
  const bars = await allBars();
  let have = 0;
  const complete: Record<string, Bar[]> = {};
  for (const t of PULLBACK_UNIVERSE) {
    const b = (bars[t] ?? []).filter((x) => !(x.date === today && !closed));
    if (b.length >= 111) have += 1;
    complete[t] = b;
  }
  if (have < 30) return { book, note: `only ${have}/${PULLBACK_UNIVERSE.length} tickers had bars — nothing logged` };
  const dates = [...new Set(Object.values(complete).flatMap((b) => b.map((x) => x.date)))].sort();
  const through = dates[dates.length - 1];
  // Which signal days to evaluate: everything after the cursor (max last 10 sessions); first run = latest session only.
  const start = book.processedThrough ? dates.filter((d) => d > (book.processedThrough as string)).slice(-HOLD_SESSIONS) : [through];
  const pm = start.length ? await premoveTickers() : null;
  let newSignals = 0;
  for (const day of start) {
    for (const t of PULLBACK_UNIVERSE) {
      const b = complete[t];
      const i = b.findIndex((x) => x.date === day);
      if (i < 0) continue;
      const ev = evalDay(b, i);
      if (!ev || !ev.uptrend) continue;
      const last = book.lastSignal[t];
      const li = last ? b.findIndex((x) => x.date === last) : -1;
      const dupe = ev.signal && li >= 0 && i - li < MIN_GAP_SESSIONS;
      if (ev.signal && !dupe) {
        book.lastSignal[t] = day;
        book.signals.push({
          key: `${day}|${t}`,
          ticker: t,
          day,
          entry: b[i].c,
          atrPct: ev.atrPct,
          dipPct: Math.round(ev.dip * 1000) / 10,
          // Premove list is the live cached list at logging time: only meaningful for the latest session.
          premove: day === through && pm ? pm.has(t) : null,
          loggedAt: now.toISOString(),
          res: {},
        });
        newSignals += 1;
      } else {
        book.pendingBase.push({ ticker: t, day, entry: b[i].c, atrPct: ev.atrPct });
      }
    }
  }
  // Score pending signals (both variants) and baseline rows against the bars now available.
  for (const s of book.signals) {
    const b = complete[s.ticker];
    const i = b.findIndex((x) => x.date === s.day);
    if (i < 0) continue;
    for (const v of Object.keys(VARIANTS) as VariantId[]) {
      if (s.res[v]) continue;
      const r = simulate(b, i, VARIANTS[v].target(s.atrPct), VARIANTS[v].stop(s.atrPct));
      if (r) {
        s.res[v] = r;
        record(book, v, "sig", s.day, r, s.premove === true);
      }
    }
  }
  const stillPending: PendingBase[] = [];
  for (const p of book.pendingBase) {
    const b = complete[p.ticker];
    const i = b.findIndex((x) => x.date === p.day);
    if (i < 0) { if (p.day >= dates[Math.max(0, dates.length - 30)]) stillPending.push(p); continue; }
    let done = true;
    // Baseline rows resolve both variants together (same bars); fold in once the 10-session window is complete or both exits hit.
    const ra = simulate(b, i, VARIANTS.atr.target(p.atrPct), VARIANTS.atr.stop(p.atrPct));
    const rf = simulate(b, i, VARIANTS.fixed.target(p.atrPct), VARIANTS.fixed.stop(p.atrPct));
    if (ra && rf) {
      record(book, "atr", "base", p.day, ra);
      record(book, "fixed", "base", p.day, rf);
    } else done = false;
    if (!done) stillPending.push(p);
  }
  book.pendingBase = stillPending;
  if (through > (book.processedThrough ?? "")) book.processedThrough = through;
  book.updatedAt = now.toISOString();
  const note = `through ${through}; ${newSignals} new signal(s); ${book.signals.length} total; ${book.pendingBase.length} baseline rows pending`;
  book.runs = [...book.runs, { at: book.updatedAt, through, newSignals, note }].slice(-60);
  await saveDoc(KIND, DAY, book);
  return { book, note };
}

export function pullbackView(book: PullbackBook) {
  const variants: Record<string, unknown> = {};
  for (const v of Object.keys(VARIANTS) as VariantId[]) {
    const a = book.agg[v];
    variants[v] = { label: VARIANTS[v].label, ...summarize(a.sig, a.base, a.hits), premoveTagged: summarize(a.sigPremove, a.base, { w: 0, l: 0, t: 0 }).signalN };
  }
  const resolved = book.signals.filter((s) => s.res.atr && s.res.fixed).length;
  return {
    mode: "test" as const,
    disclaimer: PULLBACK_DISCLAIMER,
    persistence: persistenceMode(),
    lane: "pullback-reclaim",
    universe: PULLBACK_UNIVERSE.length,
    updatedAt: book.updatedAt,
    processedThrough: book.processedThrough,
    signalsLogged: book.signals.length,
    signalsResolved: resolved,
    recheck: PULLBACK_RECHECK,
    recheckDue: resolved >= RECHECK_AFTER_SIGNALS,
    variants,
    signals: book.signals.slice(-60),
    runs: book.runs.slice(-10),
  };
}

/** Compute at most once per completed session (lock) unless forced; otherwise return the stored book. */
export async function loadPullbackReclaim(opts: { force?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const c = etClock(now);
  const stored = (await loadDoc<PullbackBook>(KIND, DAY)) ?? null;
  const today = tradingDateET(now);
  const due = c.weekday && c.minutes >= 16 * 60 + 10 && (stored?.processedThrough ?? "") < today;
  if (opts.force || due || !stored) {
    if (opts.force || (await kvSetNx("flowguard/shadow/pullback-reclaim-lock", now.toISOString(), 600))) {
      const { book, note } = await runPullbackReclaim(now);
      return { ...pullbackView(book), note };
    }
  }
  return pullbackView(stored ?? emptyBook());
}
