import "server-only";

import { kvDurable, kvGet, kvGetMany, kvSet, kvSetNx, kvBackend } from "@/lib/kv";
import { loadAiPicksState } from "@/lib/ai-picks-state";
import { LANES, loadBook } from "@/lib/lanes";
import { loadLotteryBook } from "@/lib/lottery";
import { loadPutsBook } from "@/lib/puts";
import { addSessions, liveTimeStopDate, STOP_PCT_WHOLE, TARGET_PCT_WHOLE, HOLD_SESSIONS } from "@/lib/exit-plan";
import { toNumber } from "@/lib/numbers";
import { tradingDateET } from "@/lib/session";
import { etClock } from "@/lib/shadow/budget";
import { fetchTickerOptionQuotes, hasUnusualWhalesKey } from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";
import {
  MARKET_CLOSE_ET_MINUTES,
  MARKET_OPEN_ET_MINUTES,
  PAPER_BOOKS,
  SIZING,
  bookStats,
  closePosition,
  entryFill,
  exitDecision,
  exitValue,
  levelsFor,
  newBalanceDoc,
  parseOcc,
  round2,
  seenKey,
  sizeTrade,
  spreadNet,
  type BookStats,
  type FillQuote,
  type PaperBalanceDoc,
  type PaperBookId,
  type PaperClosed,
  type PaperLeg,
  type PaperMark,
  type PaperPosition,
} from "@/lib/paper-core";
import { SPREAD_MAX_PCT, resolveSpread, spreadSkipReason, type SpreadInfo } from "@/lib/spread-core";
import { SINGLE_STOCK_PUT_REASON, blockedByPutsRule } from "@/lib/puts-rule";
import type { AiPick, AiPicksResponse, WatchQuote } from "@/lib/types";

/**
 * PAPER / TEST MODE account. Fake money only: never changes live picks, never places orders.
 *
 * Storage (Upstash Redis via lib/kv): paper:positions, paper:closed, paper:balance, paper:main-picks
 * (taken main picks handed over by /api/ai-picks), paper:snapshot:YYYY-MM-DD (daily snapshot; the study
 * routine saves `GET /api/paper?day=YYYY-MM-DD` as study/paper-YYYY-MM-DD.json).
 *
 * Ticks run after responses (`after()`) on /api/ai-picks, /api/lanes, /api/puts, /api/lottery,
 * /api/watches/check and /api/paper, plus a daily Vercel cron after the close. A tick runs at most every
 * PAPER_TICK_GAP_S (default 120 s) and only in market hours (9:30–16:00 ET) unless forced by cron/admin.
 * UW: one option-contracts call per distinct underlying (batched symbols) for new fills, and the same for
 * open positions at most every 15 min — capped by PAPER_UW_DAILY_CAP (default 800).
 */

export const PAPER_DISCLAIMER = "Paper / test mode — not real money, not financial advice. FlowGuard never places orders.";

const K_POS = "paper:positions";
const K_CLOSED = "paper:closed";
const K_BAL = "paper:balance";
/** TRACKING ONLY: picks skipped by the 1-contract > 5% rule, followed at 1 contract. Never touches balances. */
const K_TRACK = "paper:tracking";
const MAX_TRACK_CLOSED = 200;
const K_MAIN = "paper:main-picks";
const K_GAP = "paper:tick-gap";
const snapKey = (day: string) => `paper:snapshot:${day}`;

const EXIT_CHECK_GAP_MS = 15 * 60_000;
const MAX_CLOSED_KEPT = 1000;
const MAX_SKIPS_KEPT = 60;

function tickGapSec(): number {
  const v = Number(process.env.PAPER_TICK_GAP_S);
  return Number.isFinite(v) && v >= 10 ? v : 120;
}
function uwDailyCap(): number {
  const v = Number(process.env.PAPER_UW_DAILY_CAP);
  return Number.isFinite(v) && v >= 0 ? v : 800;
}

type MainPickLite = {
  source: "ai-pick" | "premove";
  contract: string;
  ticker: string;
  side: "call" | "put";
  strike: number;
  expiry: string;
  alertPrice: number;
  confidence: number | null;
  plan: { entry: number; target: number; targetPct: number; stop: number; stopPct: number; timeStopDate: string } | null;
  /** Flow alert NBBO at the print (spread-gate fallback when no live quote). */
  alertBid?: number | null;
  alertAsk?: number | null;
  /** UW issue_type (LIVE puts rule: ETF/index puts only). */
  issueType?: string | null;
};
type MainPicksDoc = { day: string; at: string; engine: string; picks: MainPickLite[] };

export type PaperTracking = { open: PaperPosition[]; closed: PaperClosed[] };
export type PaperState = { positions: PaperPosition[]; closed: PaperClosed[]; bal: PaperBalanceDoc; tracking: PaperTracking; isNew?: boolean };

async function loadState(): Promise<PaperState> {
  const [positions, closed, bal, track] = await kvGetMany<unknown>([K_POS, K_CLOSED, K_BAL, K_TRACK]);
  const b = bal as PaperBalanceDoc | null;
  const t = track as PaperTracking | null;
  return {
    tracking: { open: Array.isArray(t?.open) ? t.open : [], closed: Array.isArray(t?.closed) ? t.closed : [] },
    positions: Array.isArray(positions) ? (positions as PaperPosition[]) : [],
    closed: Array.isArray(closed) ? (closed as PaperClosed[]) : [],
    bal: b && b.version === 1 && b.books ? { ...newBalanceDoc(new Date(b.startedAt)), ...b, books: { ...newBalanceDoc(new Date()).books, ...b.books } } : newBalanceDoc(new Date()),
    isNew: !(b && b.version === 1),
  };
}

async function saveState(s: PaperState, prev: { positions: string; closed: string; bal: string; tracking?: string }) {
  const writes: Promise<boolean>[] = [];
  if (prev.tracking !== undefined && JSON.stringify(s.tracking) !== prev.tracking) {
    writes.push(kvSet(K_TRACK, { open: s.tracking.open, closed: s.tracking.closed.slice(-MAX_TRACK_CLOSED) }, { tier: "rare" }));
  }
  if (JSON.stringify(s.positions) !== prev.positions) writes.push(kvSet(K_POS, s.positions, { tier: "rare" }));
  if (JSON.stringify(s.closed) !== prev.closed) writes.push(kvSet(K_CLOSED, s.closed.slice(-MAX_CLOSED_KEPT), { tier: "rare" }));
  if (JSON.stringify(s.bal) !== prev.bal) writes.push(kvSet(K_BAL, s.bal, { tier: "rare" }));
  await Promise.all(writes);
}

function etNow(now: Date) {
  const c = etClock(now);
  return { day: tradingDateET(now), minutes: c.minutes, weekday: c.weekday };
}

function inMarketHours(now: Date): boolean {
  const e = etNow(now);
  return e.weekday && e.minutes >= MARKET_OPEN_ET_MINUTES && e.minutes < MARKET_CLOSE_ET_MINUTES;
}

/**
 * Live UW quote → fill inputs. After the close the NBBO is often stale/one-sided/very wide (e.g. bid 0.45
 * / ask 1.05), so outside market hours a wide or one-sided book is dropped and exits mark off the UW
 * last trade (last −5%) instead of a junk bid that could fake a stop.
 */
function toFill(q: WatchQuote | null | undefined, now?: Date): FillQuote | null {
  if (!q) return null;
  const live = q.quality === "uw_last" || q.quality === "uw_nbbo";
  let bid = live ? q.bid : null;
  let ask = live ? q.ask : null;
  const last = live ? q.last : null;
  if (live && now && !inMarketHours(now) && q.quality === "uw_last" && q.last > 0) {
    const wide = bid == null || ask == null || !(bid > 0) || !(ask >= bid) || (ask - bid) / ((ask + bid) / 2) > 0.5;
    if (wide) {
      bid = null;
      ask = null;
    }
  }
  return { bid, ask, last, asOf: q.asOf };
}

// ---------------------------------------------------------------------------
// Main picks hand-over from /api/ai-picks (taken picks only).
// ---------------------------------------------------------------------------
function liteFromAi(p: AiPick, source: MainPickLite["source"]): MainPickLite {
  const a = p.alert;
  const plan = p.exitPlan;
  return {
    source,
    contract: a.option_chain || a.id,
    ticker: a.ticker,
    side: a.type,
    strike: toNumber(a.strike),
    expiry: a.expiry.slice(0, 10),
    alertPrice: toNumber(a.price) || toNumber(a.ask),
    confidence: Number.isFinite(p.confidence) ? p.confidence : null,
    alertBid: a.bid ? toNumber(a.bid) : null,
    alertAsk: a.ask ? toNumber(a.ask) : null,
    issueType: a.issue_type || null,
    plan: plan
      ? { entry: plan.entry, target: plan.target, targetPct: plan.targetPct, stop: plan.stop, stopPct: plan.stopPct, timeStopDate: plan.timeStop.date }
      : null,
  };
}

function mainPicksFrom(payload: AiPicksResponse | null | undefined, today: string): MainPicksDoc | null {
  if (!payload || payload.source === "mock") return null;
  if (tradingDateET(new Date(payload.generatedAt)) !== today) return null;
  const picks = [
    ...(payload.picks ?? []).map((p) => liteFromAi(p, "ai-pick")),
    ...(payload.premove?.picks ?? []).map((p) => liteFromAi(p, "premove")),
  ];
  return { day: today, at: payload.generatedAt, engine: payload.engine, picks };
}

/** Called by /api/ai-picks after the response: remember today's TAKEN picks (cheap; write on change only). */
export async function notePaperPicks(payload: AiPicksResponse): Promise<void> {
  const today = tradingDateET();
  const doc = mainPicksFrom(payload, today);
  if (!doc || doc.picks.length === 0) return;
  const prev = await kvGet<MainPicksDoc>(K_MAIN, { maxAgeMs: 60_000 });
  const merged = new Map<string, MainPickLite>();
  if (prev?.day === today) for (const p of prev.picks) merged.set(`${p.source}:${p.contract}`, p);
  for (const p of doc.picks) if (!merged.has(`${p.source}:${p.contract}`)) merged.set(`${p.source}:${p.contract}`, p);
  if (prev?.day === today && merged.size === prev.picks.length) return;
  await kvSet(K_MAIN, { ...doc, picks: [...merged.values()] }, { tier: "hot", ttlSec: 4 * 86400 });
}

// ---------------------------------------------------------------------------
// Candidate gathering
// ---------------------------------------------------------------------------
type Candidate = {
  book: PaperBookId;
  source: string;
  day: string;
  contract: string;
  ticker: string;
  side: "call" | "put";
  strike: number;
  expiry: string;
  alertPrice: number;
  targetPct: number | null;
  stopPct: number | null;
  timeStopDate: string;
  planLevels: PaperPosition["planLevels"];
  confidence?: number | null;
  /** UW issue_type of the underlying (LIVE puts rule; missing on older rows → ETF/index ticker list). */
  issueType?: string | null;
  loggedAt?: string;
  alertBid?: number | null;
  alertAsk?: number | null;
};

async function gatherCandidates(today: string, startedAt: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const startMs = Date.parse(startedAt);
  const after = (iso?: string) => !iso || Date.parse(iso) >= startMs;

  // Main: taken AI/rules picks + premove picks (hand-over doc, else the stored LLM answer).
  let main = await kvGet<MainPicksDoc>(K_MAIN, { maxAgeMs: 30_000 });
  if (main?.day !== today) {
    const st = await loadAiPicksState();
    main = mainPicksFrom(st?.day === today ? st.value : null, today);
  }
  // LIVE exit rule for NEW entries (10/8/2026): +30% / −25% / time stop 2:30 PM CT on the 2nd session, whatever plan
  // the hand-over doc carried (older builds stored +40/+50% and 3–5 sessions). Already-open positions keep their levels.
  const lvl = (entry: number | undefined | null) =>
    entry && entry > 0
      ? { entry, target: Math.round(entry * (1 + TARGET_PCT_WHOLE / 100) * 100) / 100, stop: Math.round(entry * (1 + STOP_PCT_WHOLE / 100) * 100) / 100 }
      : null;
  for (const p of main?.picks ?? []) {
    const targetPct = TARGET_PCT_WHOLE;
    const stopPct = STOP_PCT_WHOLE;
    out.push({
      book: "main",
      source: p.source,
      day: today,
      contract: p.contract,
      ticker: p.ticker,
      side: p.side,
      strike: p.strike,
      expiry: p.expiry,
      alertPrice: p.alertPrice,
      targetPct,
      stopPct,
      timeStopDate: liveTimeStopDate(today, p.expiry),
      planLevels: lvl(p.plan?.entry),
      confidence: p.confidence,
      alertBid: p.alertBid ?? null,
      alertAsk: p.alertAsk ?? null,
      issueType: p.issueType ?? null,
    });
  }

  const [lottery, puts, ...lanes] = await Promise.all([
    loadLotteryBook(true).catch(() => null),
    loadPutsBook(true).catch(() => null),
    ...LANES.map((l) => loadBook(l.id).catch(() => null)),
  ]);

  // Lottery: tiny size, +100% take-profit, no stop, hold to the expiry-day time stop.
  for (const e of lottery?.entries ?? []) {
    if (e.day !== today || !after(e.loggedAt)) continue;
    out.push({
      book: "lottery", source: "lottery", day: e.day, contract: e.contract, ticker: e.ticker, side: e.side,
      strike: e.strike, expiry: e.expiry.slice(0, 10), alertPrice: e.entry || e.price,
      targetPct: 100, stopPct: null, timeStopDate: e.expiry.slice(0, 10), planLevels: null, loggedAt: e.loggedAt,
      alertBid: e.alertBid ?? null, alertAsk: e.alertAsk ?? null,
    });
  }
  for (const e of puts?.entries ?? []) {
    if (e.day !== today || !after(e.loggedAt)) continue;
    out.push({
      book: "puts", source: "puts", day: e.day, contract: e.contract, ticker: e.ticker, side: "put",
      strike: e.strike, expiry: e.expiry.slice(0, 10), alertPrice: e.entry || e.price,
      targetPct: e.exitPlan?.targetPct ?? 40, stopPct: e.exitPlan?.stopPct ?? -25,
      timeStopDate: addSessions(e.day, e.exitPlan?.timeStopSessions ?? 3),
      planLevels: e.exitPlan ? { entry: e.exitPlan.entry, target: e.exitPlan.target, stop: e.exitPlan.stop } : null,
      loggedAt: e.loggedAt,
      alertBid: e.alertBid ?? null, alertAsk: e.alertAsk ?? null,
    });
  }
  lanes.forEach((book, i) => {
    const lane = LANES[i];
    for (const e of book?.entries ?? []) {
      if (e.day !== today || !after(e.loggedAt)) continue;
      out.push({
        book: "lanes", source: lane.id, day: e.day, contract: e.contract, ticker: e.ticker, side: e.side,
        strike: e.strike, expiry: e.expiry.slice(0, 10), alertPrice: e.entry || e.price,
        // LIVE exit rule for new entries; an earnings lane's shorter cap (exit before the report) still wins.
        targetPct: TARGET_PCT_WHOLE, stopPct: STOP_PCT_WHOLE,
        timeStopDate: liveTimeStopDate(e.day, e.expiry, Math.min(HOLD_SESSIONS, e.exitPlan?.timeStopSessions ?? lane.timeStopSessions)),
        planLevels: lvl(e.exitPlan?.entry),
        loggedAt: e.loggedAt,
        alertBid: e.alertBid ?? null, alertAsk: e.alertAsk ?? null,
        issueType: e.issueType ?? null,
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Quotes (budgeted)
// ---------------------------------------------------------------------------
async function quotesFor(
  bal: PaperBalanceDoc,
  today: string,
  reqs: Array<{ ticker: string; contract: string; alertPrice?: number | null }>,
): Promise<Record<string, WatchQuote | null>> {
  const out: Record<string, WatchQuote | null> = {};
  if (reqs.length === 0) return out;
  if (bal.uw.day !== today) bal.uw = { day: today, quoteCalls: 0 };
  if (!(await hasUnusualWhalesKey()) || (await isUwBlocked())) return out;
  const byTicker = new Map<string, Map<string, number | undefined>>();
  for (const r of reqs) {
    const t = r.ticker.toUpperCase();
    if (!byTicker.has(t)) byTicker.set(t, new Map());
    byTicker.get(t)!.set(r.contract, r.alertPrice ?? undefined);
  }
  for (const [ticker, syms] of byTicker) {
    if (bal.uw.quoteCalls >= uwDailyCap()) break;
    try {
      const { quotes, calls } = await fetchTickerOptionQuotes(ticker, [...syms.keys()], Object.fromEntries(syms));
      bal.uw.quoteCalls += calls;
      Object.assign(out, quotes);
    } catch {
      // No quote → alert +5% for entries; exits wait for the next tick.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------
export type TickResult = {
  ran: boolean;
  reason: string;
  opened: number;
  closed: number;
  skipped: number;
  exitCheck: boolean;
};

let localInflight: Promise<TickResult> | null = null;

/**
 * One paper tick: open new taken picks, then (≤ every 15 min) check exits. Safe to call often:
 * throttled by a shared Redis gap key and a per-instance in-flight guard. `force` (cron/admin) ignores
 * the gap and the market-hours gate (time stops after the close use the last quote).
 */
export async function paperTick(opts: { force?: boolean; ai?: AiPicksResponse | null; now?: Date } = {}): Promise<TickResult> {
  if (localInflight) return localInflight;
  localInflight = runTick(opts).finally(() => {
    localInflight = null;
  });
  return localInflight;
}

async function runTick(opts: { force?: boolean; ai?: AiPicksResponse | null; now?: Date }): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const none = (reason: string): TickResult => ({ ran: false, reason, opened: 0, closed: 0, skipped: 0, exitCheck: false });
  if (!opts.force && !inMarketHours(now)) return none("outside market hours");
  if (opts.ai) await notePaperPicks(opts.ai).catch(() => undefined);
  if (!opts.force && !(await kvSetNx(K_GAP, now.toISOString(), tickGapSec()))) return none("throttled");

  const state = await loadState();
  const prev = {
    positions: JSON.stringify(state.positions),
    closed: JSON.stringify(state.closed),
    bal: JSON.stringify(state.bal),
    tracking: JSON.stringify(state.tracking),
  };
  const { bal } = state;
  const et = etNow(now);
  const today = et.day;
  const res: TickResult = { ran: true, reason: opts.force ? "forced" : "tick", opened: 0, closed: 0, skipped: 0, exitCheck: false };

  // Equity at the first tick of the day (for "P&L today").
  if (bal.dayOpen?.day !== today) {
    const equity: Partial<Record<PaperBookId, number>> = {};
    for (const b of PAPER_BOOKS) equity[b] = bookStats(b, bal.books[b], state.positions, state.closed).equity;
    bal.dayOpen = { day: today, equity };
  }

  // 1) Entries (market hours only; never after the close).
  if (inMarketHours(now)) {
    const seen = new Set(bal.seen);
    const fresh = (await gatherCandidates(today, bal.startedAt)).filter((c) => !seen.has(seenKey(c.book, c.day, c.contract)));
    const quotes = await quotesFor(bal, today, fresh.map((c) => ({ ticker: c.ticker, contract: c.contract, alertPrice: c.alertPrice })));
    for (const c of fresh) {
      seen.add(seenKey(c.book, c.day, c.contract));
      const skip = (reason: string) => {
        bal.skips.push({ at: now.toISOString(), book: c.book, source: c.source, contract: c.contract, reason });
        res.skipped += 1;
      };
      if (state.positions.some((p) => p.book === c.book && p.contract === c.contract)) {
        skip("Already holding this contract in this book.");
        continue;
      }
      if (c.expiry && c.expiry < today) {
        skip("Contract already expired.");
        continue;
      }
      // LIVE puts rule for main + lanes: ETF/index puts only (lottery / puts test books unchanged).
      if ((c.book === "main" || c.book === "lanes") && blockedByPutsRule(c.side, c.ticker, c.issueType)) {
        skip(`${SINGLE_STOCK_PUT_REASON} (live rule)`);
        continue;
      }
      // Spread at entry: live UW NBBO, else the alert's bid/ask. LIVE rule for main + lanes (> SPREAD_MAX_PCT
      // of mid → skipped); lottery / puts only record it (test mode).
      const lq = quotes[c.contract];
      const entrySpread: SpreadInfo = resolveSpread(
        lq && lq.quality !== "flow_print" ? { bid: lq.bid, ask: lq.ask } : null,
        { bid: c.alertBid, ask: c.alertAsk },
        now.toISOString(),
      );
      if ((c.book === "main" || c.book === "lanes") && entrySpread.status === "wide") {
        skip(`${spreadSkipReason(entrySpread)} (live rule: over ${Math.round(SPREAD_MAX_PCT * 100)}% of mid)`);
        continue;
      }
      const fill = entryFill(toFill(quotes[c.contract]), c.alertPrice);
      if (!fill) {
        skip("No live ask and no alert price.");
        continue;
      }
      const book = bal.books[c.book];
      const openCost = state.positions.filter((p) => p.book === c.book).reduce((s, p) => s + p.costUsd, 0);
      // Size off book value at cost (cash + open cost), so open trades don't shrink the next size.
      const size = sizeTrade(fill.price, book.balance + openCost, openCost, SIZING[c.book]);
      if (!size.ok) {
        skip(size.reason);
        // TRACKING ONLY: the 1-contract > 5% rule hides expensive picks from the study, so follow them at
        // 1 contract in a separate list (no balance, no book stats, sizing unchanged).
        if (/^1 contract .* is over/.test(size.reason) && !state.tracking.open.some((t) => t.book === c.book && t.contract === c.contract)) {
          const tl = levelsFor(fill.price, c.targetPct, c.stopPct);
          state.tracking.open.push({
            id: `track:${c.book}:${c.day}:${c.contract}`,
            book: c.book,
            source: c.source,
            day: c.day,
            contract: c.contract,
            ticker: c.ticker,
            side: c.side,
            strike: c.strike,
            expiry: c.expiry,
            qty: 1,
            entryPrice: fill.price,
            entryBasis: fill.basis,
            alertPrice: c.alertPrice || null,
            enteredAt: now.toISOString(),
            costUsd: round2(fill.price * 100),
            targetPct: c.targetPct,
            stopPct: c.stopPct,
            target: tl.target,
            stop: tl.stop,
            timeStopDate: c.expiry && c.expiry < c.timeStopDate ? c.expiry : c.timeStopDate,
            planLevels: c.planLevels,
            confidence: c.confidence ?? null,
            entrySpread,
            note: "TRACKING ONLY — skipped by the 5% one-contract rule; would-be P&L at 1 contract.",
            lastMark: null,
          });
        }
        continue;
      }
      const lv = levelsFor(fill.price, c.targetPct, c.stopPct);
      const timeStopDate = c.expiry && c.expiry < c.timeStopDate ? c.expiry : c.timeStopDate;
      state.positions.push({
        id: `${c.book}:${c.day}:${c.contract}`,
        book: c.book,
        source: c.source,
        day: c.day,
        contract: c.contract,
        ticker: c.ticker,
        side: c.side,
        strike: c.strike,
        expiry: c.expiry,
        qty: size.qty,
        entryPrice: fill.price,
        entryBasis: fill.basis,
        alertPrice: c.alertPrice || null,
        enteredAt: now.toISOString(),
        costUsd: size.costUsd,
        targetPct: c.targetPct,
        stopPct: c.stopPct,
        target: lv.target,
        stop: lv.stop,
        timeStopDate,
        planLevels: c.planLevels,
        confidence: c.confidence ?? null,
        entrySpread,
        note: c.loggedAt ? `Logged ${c.loggedAt}` : undefined,
        lastMark: null,
      });
      book.balance = round2(book.balance - size.costUsd);
      res.opened += 1;
    }
    bal.seen = [...seen].filter((k) => k.split(":")[1] >= addSessionsBack(today, 10));
  }

  // 2) Exits (≤ every 15 min; forced runs always check).
  const lastCheck = bal.lastExitCheckAt ? Date.parse(bal.lastExitCheckAt) : 0;
  if (state.positions.length + state.tracking.open.length > 0 && (opts.force || now.getTime() - lastCheck >= EXIT_CHECK_GAP_MS)) {
    res.exitCheck = true;
    bal.lastExitCheckAt = now.toISOString();
    const reqs = [...state.positions, ...state.tracking.open].flatMap((p) =>
      p.legs?.length ? p.legs.map((l) => ({ ticker: l.ticker, contract: l.option_chain })) : [{ ticker: p.ticker, contract: p.contract, alertPrice: null }],
    );
    const quotes = await quotesFor(bal, today, reqs);
    const keep: PaperPosition[] = [];
    for (const p of state.positions) {
      let mark: PaperMark | null = null;
      if (p.legs?.length) {
        const fq: Record<string, FillQuote | null> = {};
        for (const l of p.legs) fq[l.option_chain] = toFill(quotes[l.option_chain], now);
        const net = spreadNet(p.legs, fq, "exit");
        if (net != null) mark = { value: Math.max(0, net), basis: "uw_net", bid: null, ask: null, last: null, at: now.toISOString(), quoteAsOf: null };
      } else {
        const q = toFill(quotes[p.contract], now);
        const v = exitValue(q);
        if (v) mark = { value: v.value, basis: v.basis, bid: q?.bid ?? null, ask: q?.ask ?? null, last: q?.last ?? null, at: now.toISOString(), quoteAsOf: q?.asOf ?? null };
      }
      if (mark) p.lastMark = mark;
      const why = exitDecision(p, mark, now, et.day, et.minutes);
      if (!why) {
        keep.push(p);
        continue;
      }
      // Time/expiry without a live quote: last mark, else alert −5%... else entry (flat) as a last resort.
      const px = mark?.value ?? p.lastMark?.value ?? (why === "expiry" ? 0 : p.entryPrice);
      const basis = mark?.basis ?? (p.lastMark ? `last mark ${p.lastMark.at}` : why === "expiry" ? "expired (no quote)" : "no quote (flat)");
      const closed = closePosition(p, px, basis, why, now);
      state.closed.push(closed);
      const book = bal.books[p.book];
      book.balance = round2(book.balance + closed.proceedsUsd);
      book.realizedUsd = round2(book.realizedUsd + closed.pnlUsd);
      res.closed += 1;
    }
    state.positions = keep;
    // TRACKING ONLY exits: same rules, no balance changes.
    const keepT: PaperPosition[] = [];
    for (const p of state.tracking.open) {
      const q = toFill(quotes[p.contract], now);
      const v = exitValue(q);
      const mark: PaperMark | null = v
        ? { value: v.value, basis: v.basis, bid: q?.bid ?? null, ask: q?.ask ?? null, last: q?.last ?? null, at: now.toISOString(), quoteAsOf: q?.asOf ?? null }
        : null;
      if (mark) p.lastMark = mark;
      const why = exitDecision(p, mark, now, et.day, et.minutes);
      if (!why) {
        keepT.push(p);
        continue;
      }
      const px = mark?.value ?? p.lastMark?.value ?? (why === "expiry" ? 0 : p.entryPrice);
      const basis = mark?.basis ?? (p.lastMark ? `last mark ${p.lastMark.at}` : why === "expiry" ? "expired (no quote)" : "no quote (flat)");
      state.tracking.closed.push(closePosition(p, px, basis, why, now));
    }
    state.tracking.open = keepT;
  }

  bal.skips = bal.skips.slice(-MAX_SKIPS_KEPT);
  bal.lastTickAt = now.toISOString();
  await saveState(state, prev);
  if (res.opened || res.closed || res.exitCheck || opts.force) {
    await kvSet(snapKey(today), buildView(state, now), { tier: "rare", ttlSec: 120 * 86400 }).catch(() => false);
  }
  return res;
}

function addSessionsBack(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Math.ceil(n * 1.5));
  return d.toISOString().slice(0, 10);
}

/** Quietly tick (for `after()` hooks). Never throws. */
export async function paperTickQuietly(ai?: AiPicksResponse | null): Promise<void> {
  try {
    await paperTick({ ai });
  } catch (e) {
    console.warn(`[paper] tick failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// External test-lane trade (earnings calendar spread), admin only.
// ---------------------------------------------------------------------------
export type ExternalTradeInput = {
  book?: string;
  source?: string;
  ticker?: string;
  legs?: Array<{ option_chain?: string; action?: string }>;
  /** Reference net debit per spread (e.g. the routine's estimate) — used +5% when quotes are missing. */
  alertDebit?: number;
  targetPct?: number | null;
  stopPct?: number | null;
  /** ISO instant to exit (e.g. next session ~9:00 CT). Defaults to next session 10:00 ET. */
  exitBy?: string;
};

export async function logExternalPaperTrade(input: ExternalTradeInput, now = new Date()) {
  const book: PaperBookId = "earnings-calendar";
  if (input.book && input.book !== book) return { ok: false as const, error: "Only book=earnings-calendar is accepted." };
  const legs: PaperLeg[] = (input.legs ?? [])
    .map((l) => ({ option_chain: String(l.option_chain ?? "").trim().toUpperCase(), action: l.action === "sell" ? ("sell" as const) : ("buy" as const) }))
    .filter((l) => parseOcc(l.option_chain))
    .map((l) => ({ ...l, ticker: parseOcc(l.option_chain)!.ticker }));
  if (legs.length < 1 || legs.length > 4) return { ok: false as const, error: "Pass 1–4 legs with OCC option_chain and action buy|sell." };
  const ticker = (input.ticker || legs[0].ticker).toUpperCase();
  const state = await loadState();
  const prev = { positions: JSON.stringify(state.positions), closed: JSON.stringify(state.closed), bal: JSON.stringify(state.bal) };
  const today = tradingDateET(now);
  const contract = legs.map((l) => `${l.action === "buy" ? "+" : "-"}${l.option_chain}`).join(" ");
  const key = seenKey(book, today, contract);
  if (state.bal.seen.includes(key)) return { ok: false as const, error: "Already logged today." };
  const quotes = await quotesFor(state.bal, today, legs.map((l) => ({ ticker: l.ticker, contract: l.option_chain })));
  const fq: Record<string, FillQuote | null> = {};
  for (const l of legs) fq[l.option_chain] = toFill(quotes[l.option_chain]);
  const net = spreadNet(legs, fq, "entry");
  // TEST MODE record only: widest leg's bid-ask spread at entry (never filters this book).
  const legSpreads = legs.map((l) => {
    const q = quotes[l.option_chain];
    return resolveSpread(q && q.quality !== "flow_print" ? { bid: q.bid, ask: q.ask } : null, null, now.toISOString());
  });
  const entrySpread: SpreadInfo | null =
    legSpreads.filter((x) => x.pct != null).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0] ?? legSpreads[0] ?? null;
  const alertDebit = toNumber(input.alertDebit);
  const price = net != null && net > 0 ? net : alertDebit > 0 ? round2(alertDebit * 1.05) : 0;
  const basis: PaperPosition["entryBasis"] = net != null && net > 0 ? "uw_net" : "alert_net+5%";
  state.bal.seen.push(key);
  const openCost = state.positions.filter((p) => p.book === book).reduce((s, p) => s + p.costUsd, 0);
  const size = sizeTrade(price, state.bal.books[book].balance + openCost, openCost, SIZING[book]);
  if (!size.ok) {
    state.bal.skips.push({ at: now.toISOString(), book, source: input.source || book, contract, reason: size.reason });
    await saveState(state, prev);
    return { ok: false as const, error: size.reason };
  }
  const targetPct = input.targetPct === undefined ? null : input.targetPct;
  const stopPct = input.stopPct === undefined ? null : input.stopPct;
  const lv = levelsFor(price, targetPct, stopPct);
  const nextDay = addSessions(today, 1);
  const exitBy = input.exitBy && Number.isFinite(Date.parse(input.exitBy)) ? new Date(input.exitBy).toISOString() : `${nextDay}T14:00:00.000Z`;
  const expiries = legs.map((l) => parseOcc(l.option_chain)!.expiry).sort();
  const pos: PaperPosition = {
    id: `${book}:${today}:${contract}`,
    book,
    source: input.source || "earnings-calendar",
    day: today,
    contract,
    ticker,
    side: "spread",
    strike: parseOcc(legs[0].option_chain)!.strike,
    expiry: expiries[0],
    legs,
    qty: size.qty,
    entryPrice: price,
    entryBasis: basis,
    alertPrice: alertDebit || null,
    enteredAt: now.toISOString(),
    costUsd: size.costUsd,
    targetPct,
    stopPct,
    target: lv.target,
    stop: lv.stop,
    timeStopDate: exitBy.slice(0, 10),
    timeStopAt: exitBy,
    planLevels: null,
    entrySpread,
    lastMark: null,
  };
  state.positions.push(pos);
  state.bal.books[book].balance = round2(state.bal.books[book].balance - size.costUsd);
  await saveState(state, prev);
  return { ok: true as const, position: pos };
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------
export type PaperView = {
  mode: "paper-test";
  disclaimer: string;
  asOf: string;
  day: string;
  startedAt: string;
  lastTickAt: string | null;
  lastExitCheckAt: string | null;
  persistence: string;
  headline: BookStats;
  books: BookStats[];
  open: PaperPosition[];
  closed: PaperClosed[];
  closedTest: PaperClosed[];
  closedToday: PaperClosed[];
  skips: PaperBalanceDoc["skips"];
  uw: { day: string; quoteCalls: number; cap: number };
  rules: string[];
  /** TRACKING ONLY — picks the 5% one-contract rule skipped, followed at 1 contract. Not in balances or stats. */
  tracking: {
    label: string;
    open: PaperPosition[];
    closed: PaperClosed[];
    stats: { closed: number; wins: number; losses: number; pnlUsd: number; openMarkUsd: number };
  };
};

function buildView(s: PaperState, now: Date): PaperView {
  const day = tradingDateET(now);
  const dayOpen = s.bal.dayOpen?.day === day ? s.bal.dayOpen.equity : null;
  const books = PAPER_BOOKS.map((b) => {
    const st = bookStats(b, s.bal.books[b], s.positions, s.closed);
    return dayOpen?.[b] != null ? bookStats(b, s.bal.books[b], s.positions, s.closed, dayOpen[b]) : { ...st, pnlTodayUsd: 0 };
  });
  const byExit = (a: PaperClosed, b: PaperClosed) => b.exitedAt.localeCompare(a.exitedAt);
  return {
    mode: "paper-test",
    disclaimer: PAPER_DISCLAIMER,
    asOf: now.toISOString(),
    day,
    startedAt: s.bal.startedAt,
    lastTickAt: s.bal.lastTickAt,
    lastExitCheckAt: s.bal.lastExitCheckAt,
    persistence: kvDurable() ? kvBackend() : `${kvBackend()} (not durable)`,
    headline: books[0],
    books,
    open: [...s.positions].sort((a, b) => (a.book === b.book ? b.enteredAt.localeCompare(a.enteredAt) : a.book === "main" ? -1 : b.book === "main" ? 1 : a.book.localeCompare(b.book))),
    closed: s.closed.filter((c) => c.book === "main").sort(byExit).slice(0, 10),
    closedTest: s.closed.filter((c) => c.book !== "main").sort(byExit).slice(0, 10),
    closedToday: s.closed.filter((c) => tradingDateET(new Date(c.exitedAt)) === day).sort(byExit),
    skips: s.bal.skips.slice(-10).reverse(),
    tracking: {
      label: "TRACKING ONLY — picks skipped by the 5% one-contract rule, would-be P&L at 1 contract. Not part of any balance; sizing unchanged.",
      open: s.tracking.open,
      closed: [...s.tracking.closed].sort(byExit).slice(0, 30),
      stats: {
        closed: s.tracking.closed.length,
        wins: s.tracking.closed.filter((c) => c.pnlUsd > 0).length,
        losses: s.tracking.closed.filter((c) => c.pnlUsd < 0).length,
        pnlUsd: round2(s.tracking.closed.reduce((a, c) => a + c.pnlUsd, 0)),
        openMarkUsd: round2(s.tracking.open.reduce((a, p) => a + ((p.lastMark?.value ?? p.entryPrice) - p.entryPrice) * 100, 0)),
      },
    },
    uw: { day: s.bal.uw.day, quoteCalls: s.bal.uw.day === day ? s.bal.uw.quoteCalls : 0, cap: uwDailyCap() },
    rules: [
      "Start $10,000 per book. Headline = main picks only (AI/rules-taken Picks of the Day + Premove). Test lanes are separate sub-books.",
      "Size: 2% of the book balance per trade (min 1 contract); skip if 1 contract > 5% of balance; total open cost ≤ 10%. Lottery: 0.5% per trade, open ≤ 5%.",
      "Fill: buy at the live UW ask when the pick is taken; no ask → alert price +5%.",
      "Exit: sell at the live bid when it reaches the pick's target or stop (same % as its exit plan, applied to the fill), or at the time stop (15:30 ET on its date). No bid → last −5%.",
      "Lottery: +100% take-profit, no stop, out by 15:30 ET on expiry day. Earnings calendar: net debit, exits at the given time.",
      "Never places orders or changes live picks.",
    ],
  };
}

export async function loadPaperView(now = new Date()): Promise<PaperView> {
  const state = await loadState();
  // First look at the account opens it ($10k per book, startedAt = now); later picks only.
  if (state.isNew && kvDurable()) await kvSet(K_BAL, state.bal, { tier: "rare" });
  return buildView(state, now);
}

export async function loadPaperSnapshot(day: string): Promise<PaperView | null> {
  return kvGet<PaperView>(snapKey(day), { maxAgeMs: 60_000 });
}
