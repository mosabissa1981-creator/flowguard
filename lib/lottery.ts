import "server-only";

import { loadRankedFlow } from "@/lib/flow-service";
import { issuerKey, sectorOf } from "@/lib/issuers";
import { askShare, clamp, toNumber } from "@/lib/numbers";
import { loadRegimeSafe, lockoutWarning, regimeBrief } from "@/lib/regime";
import { contractKey } from "@/lib/scoring";
import { isLateSessionPrint, tradingDateET } from "@/lib/session";
import { loadDoc, persistenceMode, saveDoc } from "@/lib/shadow/store";
import { fetchContractHistoric, fetchTickerInfo, hasUnusualWhalesKey } from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";
import type { FlowFilters, RankedFlow, RegimeSnapshot } from "@/lib/types";

/**
 * Lottery lane — TEST / SHADOW mode. Studies cheap OTM contracts with aggressive ask-side buying
 * for 100%–1000% moves. Never feeds picks, premove, morning, or the AI review.
 *
 * UW cost: zero extra flow calls (shared session tape) + ≤ MAX_INFO_CALLS /stock/{t}/info lookups
 * (cached 12h) per compute. Tracking (/api/lottery/track) = one historic call per open contract (≤ MAX_TRACK).
 */

export const LOTTERY_FILTERS: FlowFilters = {
  minPremium: 10_000, // tape floor; lottery tickets below $10K total premium are not on the shared tape
  minDte: 5,
  maxDte: 30,
  side: "all",
  minConviction: 0,
  unusual: false,
  strictAntiFade: false,
  ticker: "",
};

export const LOTTERY_RULES = {
  maxPrice: 1.0,
  minPrice: 0.05,
  sweetLow: 0.1,
  sweetHigh: 0.6,
  minDte: 5,
  maxDte: 30,
  minAskShare: 0.7,
  minVolOi: 2,
  maxOtmPct: 0.3,
  minUnderlying: 5,
  minMarketCap: 2_000_000_000,
  maxPerDay: 3,
  maxPerIssuer: 1,
} as const;

const MAX_INFO_CALLS = 5;
const MAX_TRACK = 30;
const CACHE_MS = 10 * 60_000;
export const LOTTERY_DISCLAIMER =
  "TEST MODE — tiny size, expect most to expire worthless, study only. Not financial advice; FlowGuard never trades.";

export type LotteryCatalyst = { kind: "earnings" | "macro"; date: string; label: string };

export type LotteryCandidate = {
  contract: string;
  ticker: string;
  issuer: string;
  sector: string;
  side: "call" | "put";
  strike: number;
  expiry: string;
  dte: number;
  price: number;
  underlying: number;
  otmPct: number;
  askSharePct: number;
  volOi: number;
  sweep: boolean;
  tradeCount: number;
  rule: string;
  premiumUsd: number;
  printTimeUtc: string;
  flowScore: number;
  lotteryScore: number;
  catalyst: LotteryCatalyst | null;
  reasons: string[];
};

export type LotteryTracking = {
  asOf: string;
  lastBarDate: string | null;
  last: number | null;
  maxHigh: number | null;
  maxHighDate: string | null;
  maxGainPct: number | null;
  hit100: boolean;
  hit300: boolean;
  hit1000: boolean;
  expired: boolean;
  expiredWorthless: boolean | null;
  final: boolean;
};

export type LotteryEntry = LotteryCandidate & {
  day: string;
  loggedAt: string;
  /** Entry reference = the flow print price. */
  entry: number;
  tracking?: LotteryTracking;
};

export type LotteryBook = { updatedAt: string; entries: LotteryEntry[] };

export type LotteryResponse = {
  mode: "test";
  day: string;
  source: string;
  fetchedAt: string;
  generatedAt: string;
  picks: LotteryEntry[];
  candidatesConsidered: number;
  candidates: LotteryCandidate[];
  warning?: string;
  regime: ReturnType<typeof regimeBrief>;
  rules: typeof LOTTERY_RULES;
  persistence: string;
  disclaimer: string;
};

const BOOK_KIND = "lottery";
const BOOK_DAY = "book";

export async function loadLotteryBook(fresh = false): Promise<LotteryBook> {
  return (await loadDoc<LotteryBook>(BOOK_KIND, BOOK_DAY, { fresh })) ?? { updatedAt: "", entries: [] };
}

function otmPct(side: "call" | "put", strike: number, spot: number): number {
  if (!(spot > 0)) return 0;
  return side === "call" ? (strike - spot) / spot : (spot - strike) / spot;
}

function isLiquid(row: RankedFlow): boolean {
  const a = row.alert;
  if (toNumber(a.underlying_price) < LOTTERY_RULES.minUnderlying) return false;
  if (/etf|index/i.test(a.issue_type || "")) return true;
  return a.marketcap != null && a.marketcap >= LOTTERY_RULES.minMarketCap;
}

/** Hard filters for a lottery candidate (pure; exported for tests). */
export function lotteryEligible(row: RankedFlow, now = new Date()): boolean {
  const a = row.alert;
  const price = toNumber(a.price);
  if (!(price >= LOTTERY_RULES.minPrice && price <= LOTTERY_RULES.maxPrice)) return false;
  if (row.dte < LOTTERY_RULES.minDte || row.dte > LOTTERY_RULES.maxDte) return false;
  const otm = otmPct(a.type, toNumber(a.strike), toNumber(a.underlying_price));
  if (!(otm > 0 && otm <= LOTTERY_RULES.maxOtmPct)) return false;
  if (askShare(a) < LOTTERY_RULES.minAskShare) return false;
  const volOi = toNumber(a.volume_oi_ratio);
  if (volOi < LOTTERY_RULES.minVolOi) return false;
  const repeated = a.has_sweep || a.trade_count >= 3 || /repeat/i.test(a.alert_rule || "");
  if (!repeated) return false;
  if (a.has_multileg && !a.has_singleleg) return false;
  if (row.stale) return false;
  if (isLateSessionPrint(a.created_at, now)) return false;
  return isLiquid(row);
}

function baseScore(row: RankedFlow): { score: number; reasons: string[] } {
  const a = row.alert;
  const price = toNumber(a.price);
  const volOi = toNumber(a.volume_oi_ratio);
  const reasons: string[] = [];
  let s = row.score * 0.3;
  const ask = askShare(a);
  s += (ask - 0.7) * 60;
  reasons.push(`${Math.round(ask * 100)}% ask-side`);
  s += Math.min(20, Math.log2(Math.max(1, volOi)) * 5);
  reasons.push(`vol/OI ${volOi.toFixed(1)}×`);
  if (a.has_sweep) {
    s += 8;
    reasons.push("sweep");
  }
  if (a.trade_count >= 3) {
    s += Math.min(8, a.trade_count);
    reasons.push(`${a.trade_count} prints`);
  }
  if (price >= LOTTERY_RULES.sweetLow && price <= LOTTERY_RULES.sweetHigh) {
    s += 8;
    reasons.push(`$${price.toFixed(2)} in the $0.10–0.60 sweet spot`);
  } else {
    reasons.push(`$${price.toFixed(2)} print`);
  }
  if (a.all_opening_trades) {
    s += 5;
    reasons.push("all opening");
  }
  if (row.dte >= 7 && row.dte <= 21) s += 4;
  return { score: s, reasons };
}

function macroCatalyst(regime: RegimeSnapshot | null, expiry: string, today: string): LotteryCatalyst | null {
  if (!regime) return null;
  const events = [...regime.events.today, ...regime.events.upcoming].filter((e) => e.impact === "High");
  for (const e of events) {
    const d = e.date.slice(0, 10);
    if (d >= today && d <= expiry) return { kind: "macro", date: d, label: e.title };
  }
  return null;
}

function toCandidate(row: RankedFlow, score: number, reasons: string[], catalyst: LotteryCatalyst | null): LotteryCandidate {
  const a = row.alert;
  return {
    contract: contractKey(row),
    ticker: a.ticker,
    issuer: issuerKey(a.ticker),
    sector: sectorOf(a.ticker),
    side: a.type,
    strike: toNumber(a.strike),
    expiry: a.expiry,
    dte: row.dte,
    price: toNumber(a.price),
    underlying: toNumber(a.underlying_price),
    otmPct: Math.round(otmPct(a.type, toNumber(a.strike), toNumber(a.underlying_price)) * 1000) / 10,
    askSharePct: Math.round(askShare(a) * 100),
    volOi: Math.round(toNumber(a.volume_oi_ratio) * 10) / 10,
    sweep: a.has_sweep,
    tradeCount: a.trade_count,
    rule: a.alert_rule,
    premiumUsd: Math.round(toNumber(a.total_premium)),
    printTimeUtc: a.created_at,
    flowScore: row.score,
    lotteryScore: Math.round(clamp(score, 0, 100)),
    catalyst,
    reasons: catalyst ? [...reasons, `${catalyst.kind === "earnings" ? "Earnings" : "Macro"} ${catalyst.date} before expiry`] : reasons,
  };
}

let cache: { at: number; value: LotteryResponse } | null = null;
let inflight: Promise<LotteryResponse> | null = null;

async function compute(): Promise<LotteryResponse> {
  const day = tradingDateET();
  const ranked = await loadRankedFlow(LOTTERY_FILTERS);
  const regime = await loadRegimeSafe(ranked.tide);
  const live = ranked.source !== "mock";

  // Best contract per chain, eligible only.
  const byChain = new Map<string, { row: RankedFlow; score: number; reasons: string[] }>();
  for (const row of ranked.items) {
    if (!lotteryEligible(row)) continue;
    const { score, reasons } = baseScore(row);
    const k = contractKey(row);
    const cur = byChain.get(k);
    if (!cur || score > cur.score) byChain.set(k, { row, score, reasons });
  }
  const pre = [...byChain.values()].sort((a, b) => b.score - a.score);

  // Catalyst lookup for the top few issuers only (stock info cached 12h).
  const earnings = new Map<string, string | null>();
  const allowUw = live && (await hasUnusualWhalesKey()) && !(await isUwBlocked());
  if (allowUw) {
    const tickers = [...new Set(pre.map((p) => p.row.alert.ticker))].slice(0, MAX_INFO_CALLS);
    await Promise.all(
      tickers.map(async (t) => {
        const info = await fetchTickerInfo(t).catch(() => null);
        earnings.set(t, info?.nextEarningsDate ?? null);
      }),
    );
  }

  const candidates = pre
    .map(({ row, score, reasons }) => {
      const ed = earnings.get(row.alert.ticker);
      let catalyst: LotteryCatalyst | null = null;
      let s = score;
      if (ed && ed >= day && ed <= row.alert.expiry) {
        catalyst = { kind: "earnings", date: ed, label: `${row.alert.ticker} earnings` };
        s += 15;
      } else {
        catalyst = macroCatalyst(regime, row.alert.expiry, day);
        if (catalyst) s += 4;
      }
      return toCandidate(row, s, reasons, catalyst);
    })
    .sort((a, b) => b.lotteryScore - a.lotteryScore);

  // Daily log: first qualifying contracts of the day are frozen (max 3/day, 1 per issuer).
  const locked = lockoutWarning(regime);
  const book = live ? await loadLotteryBook(true) : { updatedAt: "", entries: [] };
  const todays = book.entries.filter((e) => e.day === day);
  let added = false;
  if (live && !locked && ranked.source === "live") {
    for (const c of candidates) {
      if (todays.length >= LOTTERY_RULES.maxPerDay) break;
      if (todays.some((e) => e.contract === c.contract || e.issuer === c.issuer)) continue;
      const entry: LotteryEntry = { ...c, day, loggedAt: new Date().toISOString(), entry: c.price };
      todays.push(entry);
      book.entries.push(entry);
      added = true;
    }
  }
  if (added) {
    // Keep ~60 days of entries.
    const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    book.entries = book.entries.filter((e) => e.day >= cutoff);
    book.updatedAt = new Date().toISOString();
    await saveDoc(BOOK_KIND, BOOK_DAY, book);
  }

  let warning = locked ?? ranked.warning;
  if (!warning && todays.length === 0) {
    warning = "No cheap OTM ask-side sweeps with vol ≫ OI on a liquid name this session. Not forcing a ticket.";
  }
  return {
    mode: "test",
    day,
    source: ranked.source,
    fetchedAt: ranked.fetchedAt,
    generatedAt: new Date().toISOString(),
    picks: todays,
    candidatesConsidered: candidates.length,
    candidates: candidates.slice(0, 8),
    warning,
    regime: regimeBrief(regime),
    rules: LOTTERY_RULES,
    persistence: persistenceMode(),
    disclaimer: LOTTERY_DISCLAIMER,
  };
}

export async function loadLottery(opts: { fresh?: boolean } = {}): Promise<LotteryResponse> {
  if (!opts.fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (inflight) return inflight;
  inflight = compute()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// ---------------------------------------------------------------------------
// Multi-day tracking for the study book.
// ---------------------------------------------------------------------------

const WORTHLESS_PRICE = 0.05;

/** Pure: tracking from daily bars. Entry-day high is excluded (it may predate the print); entry-day close counts. */
export function trackFromBars(
  entry: LotteryEntry,
  bars: { date: string; last: number | null; high: number | null }[],
  today: string,
): LotteryTracking {
  const after = bars.filter((b) => b.date >= entry.day).sort((a, b) => a.date.localeCompare(b.date));
  let maxHigh: number | null = null;
  let maxHighDate: string | null = null;
  for (const b of after) {
    const v = b.date === entry.day ? b.last : Math.max(b.high ?? 0, b.last ?? 0) || null;
    if (v != null && v > 0 && (maxHigh == null || v > maxHigh)) {
      maxHigh = v;
      maxHighDate = b.date;
    }
  }
  const lastBar = after[after.length - 1] ?? null;
  const gain = maxHigh != null && entry.entry > 0 ? ((maxHigh - entry.entry) / entry.entry) * 100 : null;
  const expired = today > entry.expiry;
  const lastPrice = lastBar?.last ?? null;
  const expiredWorthless = expired ? lastPrice == null || lastPrice <= Math.max(WORTHLESS_PRICE, entry.entry * 0.1) : null;
  return {
    asOf: new Date().toISOString(),
    lastBarDate: lastBar?.date ?? null,
    last: lastPrice,
    maxHigh,
    maxHighDate,
    maxGainPct: gain == null ? null : Math.round(gain),
    hit100: gain != null && gain >= 100,
    hit300: gain != null && gain >= 300,
    hit1000: gain != null && gain >= 1000,
    expired,
    expiredWorthless,
    // Final once expired and we have a bar on/after expiry (or 3+ days past expiry).
    final: expired && ((lastBar != null && lastBar.date >= entry.expiry) || today > addDays(entry.expiry, 3)),
  };
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
}

export type LotteryTrackSummary = {
  n: number;
  open: number;
  final: number;
  hit100: number;
  hit300: number;
  hit1000: number;
  expiredWorthless: number;
  hit100Rate: number | null;
  hit300Rate: number | null;
  hit1000Rate: number | null;
  expiredWorthlessRate: number | null;
  medianMaxGainPct: number | null;
};

export function summarizeLottery(entries: LotteryEntry[]): LotteryTrackSummary {
  const tracked = entries.filter((e) => e.tracking);
  const finals = tracked.filter((e) => e.tracking!.final);
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
  const gains = tracked.map((e) => e.tracking!.maxGainPct).filter((g): g is number => g != null).sort((a, b) => a - b);
  const hit = (k: "hit100" | "hit300" | "hit1000") => tracked.filter((e) => e.tracking![k]).length;
  const worthless = finals.filter((e) => e.tracking!.expiredWorthless).length;
  return {
    n: entries.length,
    open: entries.length - finals.length,
    final: finals.length,
    hit100: hit("hit100"),
    hit300: hit("hit300"),
    hit1000: hit("hit1000"),
    expiredWorthless: worthless,
    hit100Rate: pct(hit("hit100"), tracked.length),
    hit300Rate: pct(hit("hit300"), tracked.length),
    hit1000Rate: pct(hit("hit1000"), tracked.length),
    expiredWorthlessRate: pct(worthless, finals.length),
    medianMaxGainPct: gains.length ? gains[Math.floor(gains.length / 2)] : null,
  };
}

/** Refresh tracking for open entries (one historic call each, ≤ MAX_TRACK), persist, return the whole book. */
export async function trackLottery(): Promise<{
  generatedAt: string;
  today: string;
  definition: string;
  summary: LotteryTrackSummary;
  entries: LotteryEntry[];
  uwCalls: number;
  persistence: string;
  disclaimer: string;
}> {
  const today = tradingDateET();
  const book = await loadLotteryBook(true);
  const allowUw = (await hasUnusualWhalesKey()) && !(await isUwBlocked());
  let calls = 0;
  if (allowUw) {
    const open = book.entries.filter((e) => !e.tracking?.final).slice(-MAX_TRACK);
    await Promise.all(
      open.map(async (e) => {
        const limit = Math.min(40, Math.max(5, Math.round((Date.parse(today) - Date.parse(e.day)) / 86_400_000) + 3));
        const bars = await fetchContractHistoric(e.contract, limit).catch(() => []);
        calls += 1;
        if (bars.length) e.tracking = trackFromBars(e, bars, today);
      }),
    );
    if (calls) {
      book.updatedAt = new Date().toISOString();
      await saveDoc(BOOK_KIND, BOOK_DAY, book);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    today,
    definition:
      "Entry = flow print price. maxGainPct = best daily high after the entry day (entry-day close counts, entry-day high excluded) vs entry. hit100/300/1000 = maxGainPct ≥ +100/+300/+1000%. expiredWorthless = expired with last ≤ max($0.05, 10% of entry).",
    summary: summarizeLottery(book.entries),
    entries: book.entries,
    uwCalls: calls,
    persistence: persistenceMode(),
    disclaimer: LOTTERY_DISCLAIMER,
  };
}
