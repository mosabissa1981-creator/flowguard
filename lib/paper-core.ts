import type { SpreadInfo } from "@/lib/spread-core";
/**
 * PAPER / TEST MODE trading book — pure logic (no I/O). Fake money only; never touches live picks,
 * never places orders. Not financial advice.
 *
 * Books: "main" (AI/rules-taken Picks of the Day + Premove) is the headline balance. Test lanes
 * ("lottery", "puts", "lanes", "earnings-calendar") are separate sub-books with their own $10k so they
 * can be compared without polluting the headline.
 *
 * Fills: buy at the live UW ask (sell legs at the bid); no ask → alert price +5% slippage.
 * Exits: sell at the live bid when target / stop / time stop hits; no bid → last −5% (or last mark).
 */

export const PAPER_START_BALANCE = 10_000;
export const PAPER_SLIPPAGE = 0.05;
/** Time stops fire at/after 15:30 ET on the time-stop date. */
export const TIME_STOP_ET_MINUTES = 15 * 60 + 30;
export const MARKET_OPEN_ET_MINUTES = 9 * 60 + 30;
export const MARKET_CLOSE_ET_MINUTES = 16 * 60;

export type PaperBookId = "main" | "lottery" | "puts" | "lanes" | "earnings-calendar";
export const PAPER_BOOKS: PaperBookId[] = ["main", "lottery", "puts", "lanes", "earnings-calendar"];

export const PAPER_BOOK_LABEL: Record<PaperBookId, string> = {
  main: "Main picks (Picks of the Day + Premove)",
  lottery: "Lottery · test",
  puts: "Puts · test",
  lanes: "Setup lanes · test",
  "earnings-calendar": "Earnings calendar · test",
};

export type SizingRule = {
  /** Target cost per trade as a fraction of the book balance. */
  perTradePct: number;
  /** Skip when one contract costs more than this fraction of the balance. */
  maxOneContractPct: number;
  /** Total open cost basis cap as a fraction of the balance. */
  openRiskCapPct: number;
};

export const SIZING: Record<PaperBookId, SizingRule> = {
  main: { perTradePct: 0.02, maxOneContractPct: 0.05, openRiskCapPct: 0.1 },
  puts: { perTradePct: 0.02, maxOneContractPct: 0.05, openRiskCapPct: 0.1 },
  lanes: { perTradePct: 0.02, maxOneContractPct: 0.05, openRiskCapPct: 0.1 },
  "earnings-calendar": { perTradePct: 0.02, maxOneContractPct: 0.05, openRiskCapPct: 0.1 },
  // Lottery tickets: tiny size (most expire worthless).
  lottery: { perTradePct: 0.005, maxOneContractPct: 0.02, openRiskCapPct: 0.05 },
};

export type PaperLeg = {
  option_chain: string;
  ticker: string;
  action: "buy" | "sell";
};

export type PaperMark = {
  /** Exit value per share (bid for long legs; net for spreads). */
  value: number;
  basis: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  at: string;
  quoteAsOf: string | null;
};

export type PaperPosition = {
  id: string;
  book: PaperBookId;
  /** "ai-pick" | "premove" | "lottery" | "puts" | lane id | "earnings-calendar" */
  source: string;
  day: string;
  contract: string;
  ticker: string;
  side: "call" | "put" | "spread";
  strike: number | null;
  expiry: string;
  legs?: PaperLeg[];
  qty: number;
  /** Fill price per share (net debit for spreads). */
  entryPrice: number;
  entryBasis: "uw_ask" | "alert+5%" | "uw_net" | "alert_net+5%";
  alertPrice: number | null;
  enteredAt: string;
  costUsd: number;
  targetPct: number | null;
  stopPct: number | null;
  target: number | null;
  stop: number | null;
  /** ET date for the time stop (exit at/after 15:30 ET), or an exact ISO instant via timeStopAt. */
  timeStopDate: string;
  timeStopAt?: string | null;
  /** Levels from the pick's own exit plan (vs the flow print), for reference. */
  planLevels?: { entry: number; target: number | null; stop: number | null } | null;
  confidence?: number | null;
  /** Bid/ask/spread% at entry (LIVE spread gate for main + lanes; record-only for lottery/puts/earnings calendar). */
  entrySpread?: SpreadInfo | null;
  note?: string;
  lastMark?: PaperMark | null;
};

export type PaperExitReason = "target" | "stop" | "time" | "expiry";

export type PaperClosed = PaperPosition & {
  exitPrice: number;
  exitBasis: string;
  exitedAt: string;
  exitReason: PaperExitReason;
  proceedsUsd: number;
  pnlUsd: number;
  pnlPct: number;
};

export type PaperBookBalance = { start: number; balance: number; realizedUsd: number };

export type PaperSkip = { at: string; book: PaperBookId; source: string; contract: string; reason: string };

export type PaperBalanceDoc = {
  version: 1;
  mode: "paper-test";
  startedAt: string;
  books: Record<PaperBookId, PaperBookBalance>;
  /** `${book}:${day}:${contract}` keys already processed (opened or skipped). */
  seen: string[];
  skips: PaperSkip[];
  lastTickAt: string | null;
  lastExitCheckAt: string | null;
  uw: { day: string; quoteCalls: number };
  /** Equity per book at the first tick of the ET day (for "P&L today"). */
  dayOpen?: { day: string; equity: Partial<Record<PaperBookId, number>> } | null;
};

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function newBalanceDoc(now: Date): PaperBalanceDoc {
  const books = Object.fromEntries(
    PAPER_BOOKS.map((b) => [b, { start: PAPER_START_BALANCE, balance: PAPER_START_BALANCE, realizedUsd: 0 }]),
  ) as Record<PaperBookId, PaperBookBalance>;
  return {
    version: 1,
    mode: "paper-test",
    startedAt: now.toISOString(),
    books,
    seen: [],
    skips: [],
    lastTickAt: null,
    lastExitCheckAt: null,
    uw: { day: "", quoteCalls: 0 },
  };
}

export function seenKey(book: PaperBookId, day: string, contract: string): string {
  return `${book}:${day}:${contract}`;
}

export type SizeResult = { ok: true; qty: number; costUsd: number } | { ok: false; reason: string };

/**
 * Contracts for one trade: floor(perTradePct × balance / (price × 100)), at least 1.
 * Skip if one contract > maxOneContractPct of the balance, or the open-risk cap would be exceeded.
 */
export function sizeTrade(price: number, balance: number, openCostUsd: number, rule: SizingRule): SizeResult {
  if (!(price > 0)) return { ok: false, reason: "No usable price." };
  if (!(balance > 0)) return { ok: false, reason: "Paper balance is zero." };
  const one = price * 100;
  if (one > rule.maxOneContractPct * balance) {
    return {
      ok: false,
      reason: `1 contract ($${one.toFixed(0)}) is over ${Math.round(rule.maxOneContractPct * 100)}% of the $${balance.toFixed(0)} balance.`,
    };
  }
  const qty = Math.max(1, Math.floor((rule.perTradePct * balance) / one));
  const cap = rule.openRiskCapPct * balance;
  let n = qty;
  while (n >= 1 && openCostUsd + n * one > cap + 1e-6) n -= 1;
  if (n < 1) {
    return {
      ok: false,
      reason: `Open-risk cap: $${openCostUsd.toFixed(0)} already open + $${one.toFixed(0)} would exceed ${Math.round(rule.openRiskCapPct * 100)}% ($${cap.toFixed(0)}).`,
    };
  }
  return { ok: true, qty: n, costUsd: round2(n * one) };
}

export type FillQuote = { bid: number | null; ask: number | null; last: number | null; asOf: string | null };

/** Buy fill: live ask, else alert price +5%. */
export function entryFill(q: FillQuote | null, alertPrice: number | null): { price: number; basis: "uw_ask" | "alert+5%" } | null {
  if (q?.ask != null && q.ask > 0) return { price: round2(q.ask), basis: "uw_ask" };
  if (alertPrice != null && alertPrice > 0) return { price: round2(alertPrice * (1 + PAPER_SLIPPAGE)), basis: "alert+5%" };
  return null;
}

/** Sell value: live bid, else last −5%. Null when nothing live is available. */
export function exitValue(q: FillQuote | null): { value: number; basis: string } | null {
  if (q?.bid != null && q.bid > 0) return { value: round2(q.bid), basis: "uw_bid" };
  if (q?.last != null && q.last > 0) return { value: round2(q.last * (1 - PAPER_SLIPPAGE)), basis: "last-5%" };
  return null;
}

/** Spread net: entry = Σ buy ask − Σ sell bid; exit = Σ buy bid − Σ sell ask. */
export function spreadNet(legs: PaperLeg[], quotes: Record<string, FillQuote | null>, kind: "entry" | "exit"): number | null {
  let net = 0;
  for (const leg of legs) {
    const q = quotes[leg.option_chain];
    // Entry: buy legs pay the ask, sell legs receive the bid. Exit: the reverse.
    const px = (leg.action === "buy") === (kind === "entry") ? q?.ask : q?.bid;
    if (px == null || !(px > 0)) return null;
    net += leg.action === "buy" ? px : -px;
  }
  return round2(net);
}

export function levelsFor(entry: number, targetPct: number | null, stopPct: number | null) {
  return {
    target: targetPct != null ? round2(entry * (1 + targetPct / 100)) : null,
    stop: stopPct != null ? round2(entry * (1 + stopPct / 100)) : null,
  };
}

/** Is the time stop due at `now`? (`etDay`/`etMinutes` = ET wall clock of now.) */
export function timeStopDue(p: Pick<PaperPosition, "timeStopDate" | "timeStopAt" | "expiry">, now: Date, etDay: string, etMinutes: number): PaperExitReason | null {
  const exp = p.expiry.slice(0, 10);
  if (exp && (etDay > exp || (etDay === exp && etMinutes >= TIME_STOP_ET_MINUTES))) return "expiry";
  if (p.timeStopAt) return now.getTime() >= Date.parse(p.timeStopAt) ? "time" : null;
  if (etDay > p.timeStopDate) return "time";
  if (etDay === p.timeStopDate && etMinutes >= TIME_STOP_ET_MINUTES) return "time";
  return null;
}

/**
 * Exit decision for one position given its current sell value. Target/stop compare the sell value
 * (bid) to the levels; same-tick target+stop cannot happen (one value). Time/expiry exit at the value.
 */
export function exitDecision(
  p: PaperPosition,
  mark: { value: number } | null,
  now: Date,
  etDay: string,
  etMinutes: number,
): PaperExitReason | null {
  if (mark) {
    if (p.target != null && mark.value >= p.target) return "target";
    if (p.stop != null && mark.value <= p.stop) return "stop";
  }
  return timeStopDue(p, now, etDay, etMinutes);
}

export function closePosition(p: PaperPosition, price: number, basis: string, reason: PaperExitReason, now: Date): PaperClosed {
  const px = Math.max(0, round2(price));
  const proceedsUsd = round2(px * 100 * p.qty);
  const pnlUsd = round2(proceedsUsd - p.costUsd);
  return {
    ...p,
    exitPrice: px,
    exitBasis: basis,
    exitedAt: now.toISOString(),
    exitReason: reason,
    proceedsUsd,
    pnlUsd,
    pnlPct: p.costUsd > 0 ? round2((pnlUsd / p.costUsd) * 100) : 0,
  };
}

export type BookStats = {
  book: PaperBookId;
  label: string;
  start: number;
  /** Cash (start + realized − open cost). */
  balance: number;
  equity: number;
  realizedUsd: number;
  unrealizedUsd: number;
  pnlTodayUsd: number;
  pnlTotalUsd: number;
  pnlTotalPct: number;
  open: number;
  openCostUsd: number;
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
};

/** Unrealized P&L uses the last mark (bid) when present, else 0 (valued at cost). */
export function unrealized(p: PaperPosition): number {
  if (!p.lastMark || !(p.lastMark.value >= 0)) return 0;
  return round2(p.lastMark.value * 100 * p.qty - p.costUsd);
}

export function bookStats(
  book: PaperBookId,
  bal: PaperBookBalance,
  open: PaperPosition[],
  closed: PaperClosed[],
  dayOpenEquity?: number | null,
): BookStats {
  const o = open.filter((p) => p.book === book);
  const c = closed.filter((p) => p.book === book);
  const unrealizedUsd = round2(o.reduce((s, p) => s + unrealized(p), 0));
  const openCostUsd = round2(o.reduce((s, p) => s + p.costUsd, 0));
  const wins = c.filter((p) => p.pnlUsd > 0).length;
  const losses = c.filter((p) => p.pnlUsd <= 0).length;
  // Equity = cash + open positions at their last mark (cost when not marked yet).
  const equity = round2(bal.balance + openCostUsd + unrealizedUsd);
  const pnlTotalUsd = round2(equity - bal.start);
  return {
    book,
    label: PAPER_BOOK_LABEL[book],
    start: bal.start,
    balance: round2(bal.balance),
    equity,
    realizedUsd: round2(bal.realizedUsd),
    unrealizedUsd,
    // Today = equity now vs equity at the first tick of the ET day.
    pnlTodayUsd: round2(equity - (dayOpenEquity ?? bal.start)),
    pnlTotalUsd,
    pnlTotalPct: bal.start > 0 ? round2((pnlTotalUsd / bal.start) * 100) : 0,
    open: o.length,
    openCostUsd,
    closed: c.length,
    wins,
    losses,
    winRatePct: c.length > 0 ? Math.round((wins / c.length) * 100) : null,
  };
}

/** Parse an OCC symbol like NFLX261023C00070000. */
export function parseOcc(sym: string): { ticker: string; expiry: string; side: "call" | "put"; strike: number } | null {
  const m = /^([A-Z.]{1,6}?)\d?(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym.trim().toUpperCase());
  if (!m) return null;
  return {
    ticker: m[1],
    expiry: `20${m[2]}-${m[3]}-${m[4]}`,
    side: m[5] === "C" ? "call" : "put",
    strike: Number(m[6]) / 1000,
  };
}
