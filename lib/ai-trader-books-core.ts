import { issuerKey, sectorOf, type ConcentrationCaps } from "@/lib/issuers";
import type { AiTraderSource, PaperBookId } from "@/lib/paper-core";

export type { AiTraderSource };
import { RISK_OFF_PUT_REASON, blockedByRiskOffPuts } from "@/lib/risk-off-core";
import { SINGLE_STOCK_PUT_REASON, blockedByPutsRule } from "@/lib/puts-rule";

/**
 * PAPER / TEST ONLY. Pure selection + Friday scoring for the competing AI-trader books.
 * No I/O and no LLM calls. The books reuse take/pass rows the wide, Claude, and GPT lanes already stored.
 */

/** Hard quality floor, applied before any model book (or the rules book) can fill. */
export const AI_TRADER_SPREAD_MAX = 0.04;
export const AI_TRADER_MIN_ASK = 2;
export const AI_TRADER_MIN_PREMIUM = 100_000;
export const AI_TRADER_MIN_SCORE = 90;
/** Winner needs at least this many scored trades (the "~5" bar). */
export const AI_TRADER_MIN_TRADES = 5;
/** First contest week starts this Monday. Until a Friday score names a winner, main follows rules. */
export const AI_TRADER_WEEK1_MONDAY = "2026-11-16";
/** Score on Friday once the cash session is closed (16:15 ET, after the 15:30 ET time-stop pass). */
export const AI_TRADER_SCORE_AFTER_ET = 16 * 60 + 15;

export const AI_TRADER_FLOOR = {
  spreadMaxPct: AI_TRADER_SPREAD_MAX,
  minAsk: AI_TRADER_MIN_ASK,
  minPremiumUsd: AI_TRADER_MIN_PREMIUM,
  minScore: AI_TRADER_MIN_SCORE,
} as const;

export const AI_TRADER_BOOK_ID: Record<AiTraderSource, PaperBookId> = {
  grok: "ai-grok",
  claude: "ai-claude",
  gpt: "ai-gpt",
  rules: "ai-rules",
};

export const AI_TRADER_SOURCE_LABEL: Record<AiTraderSource, string> = {
  grok: "Grok",
  claude: "Claude",
  gpt: "GPT",
  rules: "Rules only",
};

export const AI_TRADER_POOL_NOTE =
  "Same daily wide-pool rows the Grok, Claude, and GPT lanes already judged. No new LLM calls.";
export const AI_TRADER_EXIT_NOTE =
  "+30% target, −25% stop, 2-session hold, 2:30 PM CT time stop. Same sizing as the main book (2% per trade, skip if 1 contract is over 5%, open cost ≤ 10%).";

export type AiTraderRow = {
  contract: string;
  ticker: string;
  side: "call" | "put";
  strike: number;
  expiry: string;
  /** Ask at the print (the wide-pool entry). */
  ask: number;
  premiumUsd: number;
  score: number;
  /** (ask − bid) / mid. Null when the print had no usable NBBO. */
  spreadPct: number | null;
  etf: boolean;
  firstSeenAt: string;
  grok: "take" | "pass" | null;
  claude: "take" | "pass" | null;
  gpt: "take" | "pass" | null;
  /** Wide-pool grade return as a fraction (0.3 = +30%), when the daily-bar grade is in. */
  gradeRet: number | null;
  graded: boolean;
};

export type AiTraderFill = {
  book: PaperBookId;
  source: AiTraderSource;
  drivenBy: AiTraderSource | null;
  drivenByWhy: string | null;
  contract: string;
  ticker: string;
  side: "call" | "put";
  strike: number;
  expiry: string;
  alertPrice: number;
  alertBid: number | null;
  alertAsk: number;
  issueType: "ETF" | "Common Stock";
  spreadMaxPct: number;
};

export type HeldSlot = { book: string; ticker: string; contract: string };

export type AiTraderCaps = ConcentrationCaps & { listCap: number };

/**
 * Same caps the live lists use: calm 2/issuer, 3/sector, list of 10;
 * risky and report-day 1/issuer, 2/sector, list of 3 (the report-day 3-pick cap).
 */
export function capsForRegime(label: "calm" | "risky" | "report-day" | null | undefined): AiTraderCaps {
  if (label === "risky" || label === "report-day") return { maxPerIssuer: 1, maxPerSector: 2, listCap: 3 };
  return { maxPerIssuer: 2, maxPerSector: 3, listCap: 10 };
}

export function qualityFloorReason(row: Pick<AiTraderRow, "spreadPct" | "ask" | "premiumUsd" | "score">): string | null {
  if (row.spreadPct == null || !(row.spreadPct <= AI_TRADER_SPREAD_MAX + 1e-9)) {
    const shown = row.spreadPct == null ? "unknown" : `${(row.spreadPct * 100).toFixed(1)}%`;
    return `Quality floor: spread ${shown} is over 4% of mid.`;
  }
  if (!(row.ask >= AI_TRADER_MIN_ASK)) return `Quality floor: ask $${row.ask} is under $${AI_TRADER_MIN_ASK}.`;
  if (!(row.premiumUsd >= AI_TRADER_MIN_PREMIUM)) return `Quality floor: premium $${Math.round(row.premiumUsd)} is under $100k.`;
  if (!(row.score >= AI_TRADER_MIN_SCORE)) return `Quality floor: score ${row.score} is under 90.`;
  return null;
}

export function hardGuardReason(row: Pick<AiTraderRow, "side" | "ticker" | "etf">, blockEtfPuts: boolean): string | null {
  const issue = row.etf ? "ETF" : "Common Stock";
  if (blockedByPutsRule(row.side, row.ticker, issue)) return `${SINGLE_STOCK_PUT_REASON} (live rule)`;
  if (blockedByRiskOffPuts(row.side, row.ticker, issue, { blockEtfPuts })) return `${RISK_OFF_PUT_REASON} (live rule)`;
  return null;
}

/** Live ask when the quote has one, otherwise the print ask. Both must clear $2. */
export function askClearsFloor(liveAsk: number | null | undefined, alertAsk: number | null | undefined, min = AI_TRADER_MIN_ASK): boolean {
  const ask = liveAsk != null && liveAsk > 0 ? liveAsk : alertAsk;
  return ask != null && ask + 1e-9 >= min;
}

/** Reconstruct the print bid from ask and (ask − bid) / mid, so the fill can re-check the 4% floor without a live quote. */
export function bidFromAskSpread(ask: number, spreadPct: number): number | null {
  if (!(ask > 0) || !(spreadPct >= 0) || spreadPct >= 2) return null;
  return Math.round((ask * (2 - spreadPct)) / (2 + spreadPct) * 100) / 100;
}

export function parseMainSourceSetting(raw: string | undefined | null): "auto" | AiTraderSource {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "rules" || v === "grok" || v === "claude" || v === "gpt") return v;
  return "auto";
}

export function resolveMainSource(
  setting: "auto" | AiTraderSource,
  latest: { winner: string | null; weekEnd: string } | null | undefined,
): { source: AiTraderSource; why: string } {
  if (setting !== "auto") return { source: setting, why: `FLOWGUARD_PAPER_MAIN_SOURCE=${setting}` };
  const w = latest?.winner;
  if ((w === "grok" || w === "claude" || w === "gpt") && latest?.weekEnd) {
    return { source: w, why: `weekly winner ${w} (week ending ${latest.weekEnd})` };
  }
  return {
    source: "rules",
    why: `no weekly winner yet — rules-only quality book (week 1 starts ${AI_TRADER_WEEK1_MONDAY})`,
  };
}

function eligibleRows(rows: AiTraderRow[], blockEtfPuts: boolean, notBeforeMs: number | null): AiTraderRow[] {
  return rows.filter((row) => {
    if (qualityFloorReason(row) || hardGuardReason(row, blockEtfPuts)) return false;
    if (notBeforeMs != null && row.firstSeenAt && Date.parse(row.firstSeenAt) < notBeforeMs) return false;
    return true;
  });
}

function judged(rows: AiTraderRow[], source: AiTraderSource): AiTraderRow[] {
  if (source === "rules") return rows;
  return rows.filter((row) => row[source] === "take");
}

/**
 * Walk score order. `held` already used a slot today (open or closed) and counts toward the caps,
 * so a later name cannot push the book over the issuer, sector, or list cap.
 * Same rules as applyConcentrationCaps: GOOG and GOOGL share an issuer, and the list stops at listCap.
 */
export function applyDayCaps(rows: AiTraderRow[], held: HeldSlot[], caps: AiTraderCaps): AiTraderRow[] {
  const perIssuer = new Map<string, number>();
  const perSector = new Map<string, number>();
  const seen = new Set<string>();
  let used = 0;
  for (const h of held) {
    if (seen.has(h.contract)) continue;
    seen.add(h.contract);
    const issuer = issuerKey(h.ticker);
    const sector = sectorOf(h.ticker);
    perIssuer.set(issuer, (perIssuer.get(issuer) ?? 0) + 1);
    perSector.set(sector, (perSector.get(sector) ?? 0) + 1);
    used += 1;
  }
  const out: AiTraderRow[] = [];
  const sorted = [...rows].sort((a, b) => b.score - a.score || b.premiumUsd - a.premiumUsd || a.contract.localeCompare(b.contract));
  for (const row of sorted) {
    if (seen.has(row.contract)) continue;
    if (used >= caps.listCap) break;
    const issuer = issuerKey(row.ticker);
    const sector = sectorOf(row.ticker);
    if ((perIssuer.get(issuer) ?? 0) >= caps.maxPerIssuer) continue;
    if ((perSector.get(sector) ?? 0) >= caps.maxPerSector) continue;
    seen.add(row.contract);
    perIssuer.set(issuer, (perIssuer.get(issuer) ?? 0) + 1);
    perSector.set(sector, (perSector.get(sector) ?? 0) + 1);
    used += 1;
    out.push(row);
  }
  return out;
}

function toFill(row: AiTraderRow, book: PaperBookId, source: AiTraderSource, drivenBy: AiTraderSource | null, why: string | null): AiTraderFill {
  return {
    book,
    source,
    drivenBy,
    drivenByWhy: drivenBy ? why : null,
    contract: row.contract,
    ticker: row.ticker,
    side: row.side,
    strike: row.strike,
    expiry: row.expiry,
    alertPrice: row.ask,
    alertBid: row.spreadPct == null ? null : bidFromAskSpread(row.ask, row.spreadPct),
    alertAsk: row.ask,
    issueType: row.etf ? "ETF" : "Common Stock",
    spreadMaxPct: AI_TRADER_SPREAD_MAX,
  };
}

/**
 * One day's fills. Quality floor and the puts / risk-off guards run first.
 * Each book then keeps only its takes (rules keeps every surviving row) inside the issuer, sector, and list caps.
 * Main receives a second capped copy of the selected source, counting today's main holds (including Premove).
 */
export function selectAiTraderFills(
  rows: AiTraderRow[],
  opts: {
    regimeLabel: "calm" | "risky" | "report-day" | null;
    blockEtfPuts: boolean;
    held: HeldSlot[];
    mainSource: AiTraderSource;
    mainSourceWhy: string;
    notBeforeMs?: number | null;
  },
): AiTraderFill[] {
  const caps = capsForRegime(opts.regimeLabel);
  const eligible = eligibleRows(rows, opts.blockEtfPuts, opts.notBeforeMs ?? null);
  const out: AiTraderFill[] = [];
  const picked = new Map<AiTraderSource, AiTraderRow[]>();
  const sources: AiTraderSource[] = ["grok", "claude", "gpt", "rules"];
  for (const source of sources) {
    const held = opts.held.filter((h) => h.book === AI_TRADER_BOOK_ID[source]);
    const rowsForBook = applyDayCaps(judged(eligible, source), held, caps);
    picked.set(source, rowsForBook);
    for (const row of rowsForBook) out.push(toFill(row, AI_TRADER_BOOK_ID[source], source, null, null));
  }
  const mainHeld = opts.held.filter((h) => h.book === "main");
  for (const row of applyDayCaps(picked.get(opts.mainSource) ?? [], mainHeld, caps)) {
    out.push(toFill(row, "main", opts.mainSource, opts.mainSource, opts.mainSourceWhy));
  }
  return out;
}

export type PaperTradeInput = {
  book: AiTraderSource;
  day: string;
  contract: string;
  ticker: string;
  returnPct: number;
  pnlUsd: number;
  closed: boolean;
};

export type BookWeekStats = {
  book: AiTraderSource;
  label: string;
  trades: number;
  pending: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  /** Average return of this book's paper fills (its takes). Winner key. */
  avgReturnPct: number | null;
  totalPnlUsd: number;
  /** Average graded return of this model's TAKE rows on the quality floor. */
  takeAvgPct: number | null;
  /** Average graded return of this model's PASS rows on the quality floor. Rules has none. */
  passAvgPct: number | null;
  takeGraded: number;
  passGraded: number;
  takePending: number;
  passPending: number;
  vsRulesPct: number | null;
};

export type WeekScore = {
  kind: "ai-trader-books";
  weekStart: string;
  weekEnd: string;
  days: string[];
  generatedAt: string;
  floor: typeof AI_TRADER_FLOOR;
  minTrades: number;
  exits: string;
  pool: string;
  winner: "grok" | "claude" | "gpt" | null;
  winnerReason: string;
  books: BookWeekStats[];
  trades: PaperTradeInput[];
  studyJson: string;
  studyMd: string;
  /** True when this run wrote the study files. False on a read-only host (the card still has the score). */
  studyWritten: boolean;
};

const SOURCES: AiTraderSource[] = ["grok", "claude", "gpt", "rules"];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function avg(xs: number[]): number | null {
  if (!xs.length) return null;
  return round1(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function sideOf(rows: Array<number | null>): { avg: number | null; graded: number; pending: number } {
  const nums = rows.filter((x): x is number => x != null && Number.isFinite(x));
  return { avg: avg(nums), graded: nums.length, pending: rows.length - nums.length };
}

export function isFridayAfterClose(day: string, etMinutes: number): boolean {
  if (!(etMinutes >= AI_TRADER_SCORE_AFTER_ET)) return false;
  const d = new Date(`${day}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.getUTCDay() === 5;
}

/** Monday–Friday ending on `friday` (YYYY-MM-DD). Null unless that date is a Friday. */
export function weekEndingOn(friday: string): { weekStart: string; weekEnd: string; days: string[] } | null {
  const end = new Date(`${friday}T12:00:00Z`);
  if (Number.isNaN(end.getTime()) || end.getUTCDay() !== 5) return null;
  const days: string[] = [];
  for (let i = 4; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return { weekStart: days[0], weekEnd: friday, days };
}

export function pickWinner(books: BookWeekStats[]): { winner: "grok" | "claude" | "gpt" | null; reason: string } {
  const rules = books.find((b) => b.book === "rules");
  const models = books.filter((b) => b.book !== "rules");
  const describe = (m: BookWeekStats) => {
    if (m.trades < AI_TRADER_MIN_TRADES) return `${m.label} ${m.trades} trades (under ${AI_TRADER_MIN_TRADES})`;
    if (m.avgReturnPct == null) return `${m.label} has no average return`;
    if (!rules || rules.avgReturnPct == null) return `${m.label} ${m.avgReturnPct}% avg on ${m.trades} trades`;
    const beat = m.avgReturnPct > rules.avgReturnPct ? "beats rules" : "does not beat rules";
    return `${m.label} ${m.avgReturnPct}% avg on ${m.trades} trades (${beat})`;
  };
  if (!rules || rules.avgReturnPct == null || rules.trades < 1) {
    return {
      winner: null,
      reason: `No winner: the rules-only book has no scored trades to beat. ${models.map(describe).join("; ")}.`,
    };
  }
  const eligible = models.filter((m) => m.trades >= AI_TRADER_MIN_TRADES && m.avgReturnPct != null && m.avgReturnPct > rules.avgReturnPct!);
  const summary = `Rules ${rules.avgReturnPct}% avg on ${rules.trades} trades. ${models.map(describe).join("; ")}.`;
  if (!eligible.length) return { winner: null, reason: `No winner. ${summary}` };
  eligible.sort((a, b) => b.avgReturnPct! - a.avgReturnPct! || b.trades - a.trades);
  if (eligible.length > 1 && eligible[0].avgReturnPct === eligible[1].avgReturnPct) {
    return {
      winner: null,
      reason: `No winner: ${eligible[0].label} and ${eligible[1].label} tie at ${eligible[0].avgReturnPct}% avg take return. ${summary}`,
    };
  }
  const w = eligible[0];
  return {
    winner: w.book as "grok" | "claude" | "gpt",
    reason: `${w.label} wins at ${w.avgReturnPct}% avg take return on ${w.trades} trades, ahead of rules ${rules.avgReturnPct}% (${rules.trades} trades).`,
  };
}

export function buildWeekScore(args: {
  week: { weekStart: string; weekEnd: string; days: string[] };
  generatedAt: string;
  trades: PaperTradeInput[];
  pending: Partial<Record<AiTraderSource, number>>;
  decisions: Record<AiTraderSource, { takes: Array<number | null>; passes: Array<number | null> }>;
}): WeekScore {
  const rulesAvg = avg(args.trades.filter((t) => t.book === "rules").map((t) => t.returnPct));
  const books: BookWeekStats[] = SOURCES.map((book) => {
    const mine = args.trades.filter((t) => t.book === book);
    const wins = mine.filter((t) => t.returnPct > 0).length;
    const losses = mine.length - wins;
    const avgReturnPct = avg(mine.map((t) => t.returnPct));
    const takes = sideOf(args.decisions[book]?.takes ?? []);
    const passes = sideOf(args.decisions[book]?.passes ?? []);
    return {
      book,
      label: AI_TRADER_SOURCE_LABEL[book],
      trades: mine.length,
      pending: args.pending[book] ?? 0,
      wins,
      losses,
      winRatePct: mine.length ? Math.round((wins / mine.length) * 100) : null,
      avgReturnPct,
      totalPnlUsd: round2(mine.reduce((s, t) => s + t.pnlUsd, 0)),
      takeAvgPct: takes.avg,
      passAvgPct: book === "rules" ? null : passes.avg,
      takeGraded: takes.graded,
      passGraded: book === "rules" ? 0 : passes.graded,
      takePending: takes.pending,
      passPending: book === "rules" ? 0 : passes.pending,
      vsRulesPct: book === "rules" || avgReturnPct == null || rulesAvg == null ? null : round1(avgReturnPct - rulesAvg),
    };
  });
  const picked = pickWinner(books);
  const score: WeekScore = {
    kind: "ai-trader-books",
    weekStart: args.week.weekStart,
    weekEnd: args.week.weekEnd,
    days: args.week.days,
    generatedAt: args.generatedAt,
    floor: AI_TRADER_FLOOR,
    minTrades: AI_TRADER_MIN_TRADES,
    exits: AI_TRADER_EXIT_NOTE,
    pool: AI_TRADER_POOL_NOTE,
    winner: picked.winner,
    winnerReason: picked.reason,
    books,
    trades: [...args.trades].sort((a, b) => a.day.localeCompare(b.day) || a.book.localeCompare(b.book) || a.contract.localeCompare(b.contract)),
    studyJson: `study/ai-trader-books/week-${args.week.weekEnd}.json`,
    studyMd: `study/ai-trader-books/week-${args.week.weekEnd}.md`,
    studyWritten: false,
  };
  return score;
}

function pct(n: number | null): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function money(n: number): string {
  const sign = n < 0 ? "−" : n > 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toFixed(0)}`;
}

export function renderWeekMd(score: WeekScore): string {
  const lines = [
    `# AI trader books — week ending ${score.weekEnd}`,
    "",
    "Paper / test mode. Not real money. Not financial advice. FlowGuard never places orders.",
    "",
    `Window: ${score.weekStart} through ${score.weekEnd} (ET).`,
    "Quality floor, before any fill: bid-ask spread ≤ 4% of mid, ask ≥ $2, premium ≥ $100,000, score ≥ 90.",
    `Exits: ${score.exits}`,
    `Pool: ${score.pool}`,
    "Take avg / pass avg use the wide-pool daily-bar grade (+30/−25/2-session) on quality-floor rows that also clear the puts and risk-off guards, before the day's list caps. Pending grades are left out of the average.",
    "",
    `**Winner:** ${score.winner ? AI_TRADER_SOURCE_LABEL[score.winner] : "none"}. ${score.winnerReason}`,
    "",
    "| Book | Trades | Win rate | Avg return | Total P&L | Take avg | Pass avg | vs rules |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const b of score.books) {
    const wr = b.winRatePct == null ? "—" : `${b.winRatePct}% (${b.wins}–${b.losses})`;
    lines.push(`| ${b.label} | ${b.trades} | ${wr} | ${pct(b.avgReturnPct)} | ${money(b.totalPnlUsd)} | ${pct(b.takeAvgPct)} | ${pct(b.passAvgPct)} | ${pct(b.vsRulesPct)} |`);
  }
  if (score.trades.length) {
    lines.push("", "## Trades", "");
    for (const t of score.trades) {
      lines.push(`- ${t.day} ${AI_TRADER_SOURCE_LABEL[t.book]} ${t.contract} ${pct(t.returnPct)} (${money(t.pnlUsd)})${t.closed ? "" : " open"}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export type AiTraderPanel = {
  setting: "auto" | AiTraderSource;
  mainSource: AiTraderSource;
  mainSourceWhy: string;
  week: WeekScore | null;
  floor: typeof AI_TRADER_FLOOR;
  week1Monday: string;
  minTrades: number;
};

export function panelFrom(setting: "auto" | AiTraderSource, latest: WeekScore | null): AiTraderPanel {
  const resolved = resolveMainSource(setting, latest);
  return {
    setting,
    mainSource: resolved.source,
    mainSourceWhy: resolved.why,
    week: latest,
    floor: AI_TRADER_FLOOR,
    week1Monday: AI_TRADER_WEEK1_MONDAY,
    minTrades: AI_TRADER_MIN_TRADES,
  };
}
