import "server-only";

import { loadRankedFlow } from "@/lib/flow-service";
import { issuerKey, sectorOf } from "@/lib/issuers";
import { askShare, tideFromPremiums, toNumber } from "@/lib/numbers";
import { loadRegimeSafe, lockoutWarning, regimeBrief } from "@/lib/regime";
import { contractKey } from "@/lib/scoring";
import { isLateSessionPrint, tradingDateET } from "@/lib/session";
import { loadDoc, persistenceMode, saveDoc } from "@/lib/shadow/store";
import {
  fetchContractHistoric,
  fetchEarningsHistory,
  fetchStockStates,
  hasUnusualWhalesKey,
  type StockState,
} from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";
import type { FlowFilters, RankedFlow, RegimeSnapshot, TideBias } from "@/lib/types";

/**
 * Puts lane — TEST / SHADOW mode. Catches drops on risk-off days.
 * Differs from the main engine (puts 0-0-22 flat under same-day ±15%): puts here need an explicit
 * risk-off CONFIRMATION (bearish tide, risky regime + rising long yields, or relative weakness vs SPY/QQQ),
 * are near-the-money, and are scored on a 3-session horizon with +40% target / −25% stop.
 * Never feeds picks, premove, morning, or the AI review.
 *
 * UW cost: zero extra flow calls (shared tape) + ≤ 6 stock-state calls (SPY, QQQ + top 4 tickers, cached ~12 min)
 * + ≤ 3 earnings-history calls (cached 12h) per compute. Tracking = one historic call per open contract (≤ 30).
 */

export const PUTS_FILTERS: FlowFilters = {
  minPremium: 25_000,
  minDte: 7,
  maxDte: 30,
  side: "put",
  minConviction: 0,
  unusual: false,
  strictAntiFade: false,
  ticker: "",
};

export const PUTS_RULES = {
  minPremiumUsd: 25_000,
  minDte: 7,
  maxDte: 30,
  minAskShare: 0.65,
  minVolOi: 1,
  /** Moneyness: strike between 3% ITM and 8% OTM. */
  maxItmPct: 0.03,
  maxOtmPct: 0.08,
  minUnderlying: 10,
  minMarketCap: 5_000_000_000,
  relWeaknessPct: -0.75,
  maxPerDay: 3,
  maxPerIssuer: 1,
  maxPerSector: 2,
  exit: { targetPct: 40, targetRange: "30–50%", stopPct: -25, timeStopSessions: 3 },
} as const;

const MAX_SPOT_TICKERS = 4;
const MAX_EARNINGS_CALLS = 3;
const MAX_TRACK = 30;
const CACHE_MS = 10 * 60_000;
export const PUTS_DISCLAIMER =
  "TEST MODE — study only, small size. Puts lane is logged separately and never feeds picks or the AI review. Not financial advice; FlowGuard never trades.";

export type PutsConfirmation = "market-tide-bearish" | "ticker-tide-bearish" | "risky-yields-rising" | "relative-weakness";

export type PutsCandidate = {
  contract: string;
  ticker: string;
  issuer: string;
  sector: string;
  strike: number;
  expiry: string;
  dte: number;
  price: number;
  underlying: number;
  moneynessPct: number;
  askSharePct: number;
  volOi: number;
  sweep: boolean;
  tradeCount: number;
  rule: string;
  premiumUsd: number;
  printTimeUtc: string;
  flowScore: number;
  putsScore: number;
  confirmations: PutsConfirmation[];
  penalties: string[];
  tickerTide: TideBias | null;
  marketTide: TideBias | null;
  underlyingPct: number | null;
  spyPct: number | null;
  qqqPct: number | null;
  reasons: string[];
  exitPlan: { entry: number; target: number; targetPct: number; stop: number; stopPct: number; timeStopSessions: number };
};

export type PutsTracking = {
  asOf: string;
  sessionsAfter: number;
  /** Close-to-entry return per session after the entry day (T+1..T+5), % */
  returns: Record<"t1" | "t2" | "t3" | "t4" | "t5", number | null>;
  maxGainPct: number | null;
  maxDrawdownPct: number | null;
  hitTarget: boolean;
  hitStop: boolean;
  /** Within the 3-session time stop. Same-day target+stop counts as loser (conservative). */
  outcome: "winner" | "loser" | "flat" | "open";
  outcomeSession: number | null;
  final: boolean;
};

export type PutsEntry = PutsCandidate & {
  day: string;
  loggedAt: string;
  entry: number;
  regimeLabel: string | null;
  yieldsRising: boolean | null;
  us30yChangeBp: number | null;
  tracking?: PutsTracking;
};

export type PutsBook = { updatedAt: string; entries: PutsEntry[] };

const BOOK_KIND = "puts";
const BOOK_DAY = "book";

export async function loadPutsBook(fresh = false): Promise<PutsBook> {
  return (await loadDoc<PutsBook>(BOOK_KIND, BOOK_DAY, { fresh })) ?? { updatedAt: "", entries: [] };
}

function moneyness(strike: number, spot: number): number {
  // Positive = OTM for a put (strike below spot), negative = ITM.
  return spot > 0 ? (spot - strike) / spot : 0;
}

function isLiquid(row: RankedFlow): boolean {
  const a = row.alert;
  if (toNumber(a.underlying_price) < PUTS_RULES.minUnderlying) return false;
  if (/etf|index/i.test(a.issue_type || "")) return true;
  return a.marketcap != null && a.marketcap >= PUTS_RULES.minMarketCap;
}

/** Hard filters (pure). */
export function putsEligible(row: RankedFlow, now = new Date()): boolean {
  const a = row.alert;
  if (a.type !== "put") return false;
  if (a.has_multileg || !a.has_singleleg) return false;
  if (toNumber(a.total_premium) < PUTS_RULES.minPremiumUsd) return false;
  if (row.dte < PUTS_RULES.minDte || row.dte > PUTS_RULES.maxDte) return false;
  const m = moneyness(toNumber(a.strike), toNumber(a.underlying_price));
  if (m < -PUTS_RULES.maxItmPct || m > PUTS_RULES.maxOtmPct) return false;
  if (askShare(a) < PUTS_RULES.minAskShare) return false;
  const opening = toNumber(a.volume_oi_ratio) >= PUTS_RULES.minVolOi || a.all_opening_trades;
  if (!opening) return false;
  const repeated = a.has_sweep || a.trade_count >= 2 || /repeat/i.test(a.alert_rule || "");
  if (!repeated) return false;
  if (row.stale) return false;
  if (isLateSessionPrint(a.created_at, now)) return false;
  return isLiquid(row);
}

function score(
  row: RankedFlow,
  ctx: {
    regime: RegimeSnapshot | null;
    spot: StockState | null;
    spy: number | null;
    qqq: number | null;
    postBeat: boolean;
    tickerTide: TideBias | null;
  },
): { score: number; confirmations: PutsConfirmation[]; penalties: string[]; reasons: string[]; underlyingPct: number | null } {
  const a = row.alert;
  const reasons: string[] = [];
  const confirmations: PutsConfirmation[] = [];
  const penalties: string[] = [];
  const ask = askShare(a);
  let s = 30 + (ask - 0.65) * 60;
  reasons.push(`${Math.round(ask * 100)}% ask-side`);
  const volOi = toNumber(a.volume_oi_ratio);
  s += Math.min(12, Math.log2(Math.max(1, volOi)) * 4);
  reasons.push(`vol/OI ${volOi.toFixed(1)}×`);
  if (a.has_sweep) {
    s += 6;
    reasons.push("sweep");
  }
  if (a.trade_count >= 3) s += Math.min(6, a.trade_count);
  const prem = toNumber(a.total_premium);
  s += Math.min(10, Math.log10(Math.max(1, prem / 25_000)) * 8);
  const m = moneyness(toNumber(a.strike), toNumber(a.underlying_price));
  if (m >= -0.01 && m <= 0.04) s += 5;

  if (row.marketTideBias === "bearish") {
    confirmations.push("market-tide-bearish");
    s += 10;
    reasons.push("market tide bearish");
  }
  if (ctx.tickerTide === "bearish") {
    confirmations.push("ticker-tide-bearish");
    s += 10;
    reasons.push("ticker tide bearish");
  }
  const r = ctx.regime;
  if (r && r.label !== "calm" && r.yields.rising) {
    confirmations.push("risky-yields-rising");
    s += 10;
    reasons.push(`${r.label} day, 30Y ${r.yields.us30y.changeBp ?? "?"}bp`);
  }
  const up = ctx.spot?.pctFromClose != null ? ctx.spot.pctFromClose * 100 : null;
  const bench = [ctx.spy, ctx.qqq].filter((x): x is number => x != null);
  if (up != null && bench.length) {
    const rel = up - Math.max(...bench);
    if (rel <= PUTS_RULES.relWeaknessPct) {
      confirmations.push("relative-weakness");
      s += 10;
      reasons.push(`${up.toFixed(1)}% vs SPY/QQQ ${bench.map((b) => b.toFixed(1)).join("/")}%`);
    }
  }
  if (ctx.tickerTide === "bullish") {
    penalties.push("bullish ticker tide");
    s -= 15;
  }
  if (ctx.postBeat) {
    penalties.push("right after a beat (positive post-earnings move)");
    s -= 12;
  }
  if (confirmations.length >= 2) s += 5;
  return { score: s, confirmations, penalties, reasons, underlyingPct: up == null ? null : Math.round(up * 100) / 100 };
}

let cache: { at: number; value: PutsResponse } | null = null;
let inflight: Promise<PutsResponse> | null = null;

export type PutsResponse = {
  mode: "test";
  day: string;
  source: string;
  fetchedAt: string;
  generatedAt: string;
  picks: PutsEntry[];
  candidatesConsidered: number;
  candidates: PutsCandidate[];
  context: { marketTide: TideBias | null; spyPct: number | null; qqqPct: number | null; regimeLabel: string | null; yieldsRising: boolean | null; us30yChangeBp: number | null };
  warning?: string;
  regime: ReturnType<typeof regimeBrief>;
  rules: typeof PUTS_RULES;
  uwCalls: { stockState: number; earnings: number };
  persistence: string;
  disclaimer: string;
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function compute(): Promise<PutsResponse> {
  const day = tradingDateET();
  const ranked = await loadRankedFlow(PUTS_FILTERS);
  const regime = await loadRegimeSafe(ranked.tide);
  // Directional ticker tide from the same cached session tape (no UW call). The main engine's ticker tide is
  // ask-vs-bid regardless of side, so heavy put buying reads "bullish" there; here put-ask + call-bid = bearish.
  const tape = await loadRankedFlow({ ...PUTS_FILTERS, side: "all", minPremium: 10_000, minDte: 0, maxDte: 3650 });
  const dir = new Map<string, { bull: number; bear: number }>();
  const own = new Map<string, number>(); // put ask-side premium per chain, excluded from that chain's own confirmation
  for (const row of tape.items) {
    const a = row.alert;
    if (a.type === "put") own.set(contractKey(row), (own.get(contractKey(row)) ?? 0) + Math.max(0, toNumber(a.total_ask_side_prem)));
    const cur = dir.get(a.ticker) ?? { bull: 0, bear: 0 };
    const ask = Math.max(0, toNumber(a.total_ask_side_prem));
    const bid = Math.max(0, toNumber(a.total_bid_side_prem));
    if (a.type === "call") {
      cur.bull += ask;
      cur.bear += bid;
    } else {
      cur.bear += ask;
      cur.bull += bid;
    }
    dir.set(a.ticker, cur);
  }
  /** Ticker tide excluding the candidate chain's own put buying, so a print cannot confirm itself. */
  const tickerTide = (t: string, chain?: string): TideBias | null => {
    const d = dir.get(t);
    if (!d) return null;
    const bear = Math.max(0, d.bear - (chain ? own.get(chain) ?? 0 : 0));
    if (d.bull + bear < 25_000) return null;
    return tideFromPremiums(d.bull, bear, null).bias;
  };
  const live = ranked.source === "live";

  const byChain = new Map<string, RankedFlow>();
  for (const row of ranked.items) {
    if (!putsEligible(row)) continue;
    const k = contractKey(row);
    const cur = byChain.get(k);
    // Earliest qualifying print per chain (full-session tape) is the entry; later re-prints never move it.
    if (!cur || (Date.parse(row.alert.created_at) < Date.parse(cur.alert.created_at))) byChain.set(k, row);
  }
  const eligible = [...byChain.values()];
  // Pre-rank without spot data to decide which tickers get stock-state / earnings lookups.
  const prelim = eligible
    .map((row) => ({ row, s: score(row, { regime, spot: null, spy: null, qqq: null, postBeat: false, tickerTide: tickerTide(row.alert.ticker, contractKey(row)) }).score }))
    .sort((a, b) => b.s - a.s);

  const allowUw = live && (await hasUnusualWhalesKey()) && !(await isUwBlocked());
  let spots: Record<string, StockState> = {};
  const postBeat = new Set<string>();
  let stockStateCalls = 0;
  let earningsCalls = 0;
  if (allowUw && prelim.length) {
    const top = [...new Set(prelim.map((p) => p.row.alert.ticker))].slice(0, MAX_SPOT_TICKERS);
    const tickers = ["SPY", "QQQ", ...top.filter((t) => t !== "SPY" && t !== "QQQ")];
    stockStateCalls = tickers.length;
    spots = await fetchStockStates(tickers, MAX_SPOT_TICKERS + 2).catch(() => ({}));
    const etf = (t: string) => prelim.find((p) => p.row.alert.ticker === t && /etf|index/i.test(p.row.alert.issue_type || ""));
    const earnTickers = top.filter((t) => !etf(t)).slice(0, MAX_EARNINGS_CALLS);
    earningsCalls = earnTickers.length;
    const cutoff = new Date(Date.parse(day) - 5 * 86_400_000).toISOString().slice(0, 10);
    await Promise.all(
      earnTickers.map(async (t) => {
        const hist = await fetchEarningsHistory(t).catch(() => null);
        const recent = (hist ?? []).find((h) => h.reportDate && h.reportDate >= cutoff && h.reportDate <= day);
        if (recent && recent.postMove1dPct != null && recent.postMove1dPct > 0) postBeat.add(t);
      }),
    );
  }
  const pct = (t: string) => (spots[t]?.pctFromClose != null ? (spots[t].pctFromClose as number) * 100 : null);
  const spy = pct("SPY");
  const qqq = pct("QQQ");

  const candidates: PutsCandidate[] = eligible
    .map((row) => {
      const a = row.alert;
      const sc = score(row, {
        regime,
        spot: spots[a.ticker] ?? null,
        spy,
        qqq,
        postBeat: postBeat.has(a.ticker),
        tickerTide: tickerTide(a.ticker, contractKey(row)),
      });
      const price = toNumber(a.price);
      return {
        contract: contractKey(row),
        ticker: a.ticker,
        issuer: issuerKey(a.ticker),
        sector: sectorOf(a.ticker),
        strike: toNumber(a.strike),
        expiry: a.expiry,
        dte: row.dte,
        price,
        underlying: toNumber(a.underlying_price),
        moneynessPct: Math.round(moneyness(toNumber(a.strike), toNumber(a.underlying_price)) * 1000) / 10,
        askSharePct: Math.round(askShare(a) * 100),
        volOi: Math.round(toNumber(a.volume_oi_ratio) * 10) / 10,
        sweep: a.has_sweep,
        tradeCount: a.trade_count,
        rule: a.alert_rule,
        premiumUsd: Math.round(toNumber(a.total_premium)),
        printTimeUtc: a.created_at,
        flowScore: row.score,
        putsScore: Math.round(Math.max(0, Math.min(100, sc.score))),
        confirmations: sc.confirmations,
        penalties: sc.penalties,
        tickerTide: tickerTide(a.ticker, contractKey(row)),
        marketTide: row.marketTideBias,
        underlyingPct: sc.underlyingPct,
        spyPct: spy == null ? null : round2(spy),
        qqqPct: qqq == null ? null : round2(qqq),
        reasons: [...sc.reasons, ...sc.penalties.map((p) => `penalty: ${p}`)],
        exitPlan: {
          entry: price,
          target: round2(price * (1 + PUTS_RULES.exit.targetPct / 100)),
          targetPct: PUTS_RULES.exit.targetPct,
          stop: round2(price * (1 + PUTS_RULES.exit.stopPct / 100)),
          stopPct: PUTS_RULES.exit.stopPct,
          timeStopSessions: PUTS_RULES.exit.timeStopSessions,
        },
      };
    })
    .sort((a, b) => b.putsScore - a.putsScore);

  // Daily log: needs ≥1 confirmation, no bullish ticker tide; max 3/day, 1 per issuer, 2 per sector. Frozen once logged.
  const locked = lockoutWarning(regime);
  const book = live ? await loadPutsBook(true) : { updatedAt: "", entries: [] };
  const todays = book.entries.filter((e) => e.day === day);
  let added = false;
  if (live && !locked) {
    for (const c of candidates) {
      if (todays.length >= PUTS_RULES.maxPerDay) break;
      if (c.confirmations.length === 0 || c.tickerTide === "bullish") continue;
      if (todays.some((e) => e.contract === c.contract || e.issuer === c.issuer)) continue;
      if (todays.filter((e) => e.sector === c.sector).length >= PUTS_RULES.maxPerSector) continue;
      const entry: PutsEntry = {
        ...c,
        day,
        loggedAt: new Date().toISOString(),
        entry: c.price,
        regimeLabel: regime?.label ?? null,
        yieldsRising: regime?.yields.rising ?? null,
        us30yChangeBp: regime?.yields.us30y.changeBp ?? null,
      };
      todays.push(entry);
      book.entries.push(entry);
      added = true;
    }
  }
  if (added) {
    const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    book.entries = book.entries.filter((e) => e.day >= cutoff);
    book.updatedAt = new Date().toISOString();
    await saveDoc(BOOK_KIND, BOOK_DAY, book);
  }

  let warning = locked ?? ranked.warning;
  if (!warning && todays.length === 0) {
    warning =
      candidates.length === 0
        ? "No near-the-money ask-side opening put sweeps on liquid names this session."
        : "Put flow on the tape, but none with a risk-off confirmation (bearish tide, risky regime + rising yields, or relative weakness). Not logging.";
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
    context: {
      marketTide: ranked.tide?.bias ?? null,
      spyPct: spy == null ? null : round2(spy),
      qqqPct: qqq == null ? null : round2(qqq),
      regimeLabel: regime?.label ?? null,
      yieldsRising: regime?.yields.rising ?? null,
      us30yChangeBp: regime?.yields.us30y.changeBp ?? null,
    },
    warning,
    regime: regimeBrief(regime),
    rules: PUTS_RULES,
    uwCalls: { stockState: stockStateCalls, earnings: earningsCalls },
    persistence: persistenceMode(),
    disclaimer: PUTS_DISCLAIMER,
  };
}

export async function loadPuts(): Promise<PutsResponse> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
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
// Multi-day tracking (T+1..T+5) for the study book.
// ---------------------------------------------------------------------------

/** Pure: tracking from daily bars after the entry day. */
export function trackPutFromBars(
  entry: PutsEntry,
  bars: { date: string; last: number | null; high: number | null; low: number | null }[],
  today: string,
): PutsTracking {
  const after = bars.filter((b) => b.date > entry.day).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
  const ret = (p: number | null | undefined) => (p != null && p > 0 && entry.entry > 0 ? Math.round(((p - entry.entry) / entry.entry) * 1000) / 10 : null);
  const keys = ["t1", "t2", "t3", "t4", "t5"] as const;
  const returns = Object.fromEntries(keys.map((k, i) => [k, ret(after[i]?.last)])) as PutsTracking["returns"];
  let maxGain: number | null = null;
  let maxDd: number | null = null;
  for (const b of after) {
    const hi = ret(Math.max(b.high ?? 0, b.last ?? 0) || null);
    const lo = ret(b.low ?? b.last);
    if (hi != null && (maxGain == null || hi > maxGain)) maxGain = hi;
    if (lo != null && (maxDd == null || lo < maxDd)) maxDd = lo;
  }
  const { targetPct, stopPct, timeStopSessions } = PUTS_RULES.exit;
  let outcome: PutsTracking["outcome"] = "open";
  let outcomeSession: number | null = null;
  let hitTarget = false;
  let hitStop = false;
  for (let i = 0; i < Math.min(timeStopSessions, after.length); i += 1) {
    const b = after[i];
    const hi = ret(Math.max(b.high ?? 0, b.last ?? 0) || null);
    const lo = ret(b.low ?? b.last);
    const t = hi != null && hi >= targetPct;
    const s = lo != null && lo <= stopPct;
    if (t) hitTarget = true;
    if (s) hitStop = true;
    if (s) {
      outcome = "loser";
      outcomeSession = i + 1;
      break;
    }
    if (t) {
      outcome = "winner";
      outcomeSession = i + 1;
      break;
    }
  }
  const expired = today > entry.expiry;
  if (outcome === "open" && (after.length >= timeStopSessions || expired)) {
    outcome = "flat";
    outcomeSession = Math.min(timeStopSessions, after.length) || null;
  }
  return {
    asOf: new Date().toISOString(),
    sessionsAfter: after.length,
    returns,
    maxGainPct: maxGain,
    maxDrawdownPct: maxDd,
    hitTarget,
    hitStop,
    outcome,
    outcomeSession,
    final: after.length >= 5 || expired,
  };
}

export type PutsTrackSummary = {
  n: number;
  decided: number;
  winners: number;
  losers: number;
  flat: number;
  open: number;
  winRate: number | null;
  avgT1: number | null;
  avgT3: number | null;
  avgT5: number | null;
};

export function summarizePuts(entries: PutsEntry[]): PutsTrackSummary {
  const t = entries.map((e) => e.tracking).filter((x): x is PutsTracking => Boolean(x));
  const count = (o: PutsTracking["outcome"]) => t.filter((x) => x.outcome === o).length;
  const avg = (k: "t1" | "t3" | "t5") => {
    const v = t.map((x) => x.returns[k]).filter((n): n is number => n != null);
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
  };
  const w = count("winner");
  const l = count("loser");
  const f = count("flat");
  return {
    n: entries.length,
    decided: w + l + f,
    winners: w,
    losers: l,
    flat: f,
    open: entries.length - (w + l + f),
    winRate: w + l + f ? Math.round((w / (w + l + f)) * 1000) / 10 : null,
    avgT1: avg("t1"),
    avgT3: avg("t3"),
    avgT5: avg("t5"),
  };
}

export async function trackPuts() {
  const today = tradingDateET();
  const book = await loadPutsBook(true);
  const allowUw = (await hasUnusualWhalesKey()) && !(await isUwBlocked());
  let calls = 0;
  if (allowUw) {
    const open = book.entries.filter((e) => !e.tracking?.final && e.day < today).slice(-MAX_TRACK);
    await Promise.all(
      open.map(async (e) => {
        const bars = await fetchContractHistoric(e.contract, 12).catch(() => []);
        calls += 1;
        if (bars.length) e.tracking = trackPutFromBars(e, bars, today);
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
      "Entry = flow print price. T+1..T+5 = option close vs entry on each session after the entry day. Outcome within the 3-session time stop: winner = high ≥ +40% first, loser = low ≤ −25% first (same-session both = loser), flat = neither by session 3 or expiry. maxGainPct/maxDrawdownPct over 5 sessions.",
    summary: summarizePuts(book.entries),
    entries: book.entries,
    uwCalls: calls,
    persistence: persistenceMode(),
    disclaimer: PUTS_DISCLAIMER,
  };
}
