import "server-only";

import { loadRankedFlow } from "@/lib/flow-service";
import { issuerKey, sectorOf } from "@/lib/issuers";
import { askShare, tideFromPremiums, toNumber } from "@/lib/numbers";
import { loadRegimeSafe, lockoutWarning } from "@/lib/regime";
import { contractKey } from "@/lib/scoring";
import { isLateSessionPrint, tradingDateET } from "@/lib/session";
import { loadDoc, persistenceMode, saveDoc } from "@/lib/shadow/store";
import { fetchContractHistoric, fetchTickerInfo, hasUnusualWhalesKey } from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";
import type { FlowFilters, RankedFlow, TideBias } from "@/lib/types";

/**
 * Setup lanes — TEST / SHADOW mode. Six rule-based lanes sharing one pass over the cached session tape.
 * Logged separately (Blob flowguard/shadow/lane-<id>-book.json); never feed picks, premove, morning, or the AI review.
 *
 * Extra data per compute (all cached):
 *  - UW /stock/{t}/info (next earnings date) for ≤ MAX_EARNINGS_LOOKUPS tickers, 12h cache.
 *  - Yahoo daily chart (3 months) for ≤ MAX_CHARTS tickers + SPY/QQQ, 10 min cache — free, not UW.
 * Tracking: one UW historic call per open entry across all lanes (≤ MAX_TRACK per call).
 */

export type LaneId =
  | "calls-earnings-runup"
  | "calls-breakout"
  | "calls-sector-wave"
  | "puts-earnings-rundown"
  | "puts-breakdown"
  | "puts-sector-selloff";

export type LaneDef = {
  id: LaneId;
  title: string;
  side: "call" | "put";
  maxPerDay: number;
  timeStopSessions: number;
  rules: string;
};

export const LANES: LaneDef[] = [
  {
    id: "calls-earnings-runup",
    title: "Calls · Earnings run-up",
    side: "call",
    maxPerDay: 3,
    timeStopSessions: 5,
    rules:
      "Call buying 5–15 trading days before the next earnings date, expiry after earnings; not extended (5-day ≤ +8%, ≤ 10% above 20-day average, today ≤ +3%). Time stop 5 sessions, always exit the session before the report.",
  },
  {
    id: "calls-breakout",
    title: "Calls · Breakout",
    side: "call",
    maxPerDay: 3,
    timeStopSessions: 3,
    rules:
      "Underlying at the print within 2% below (or ≤ 1% above) the prior 20- or 50-day high, heavy ask-side call buying (≥ 70% ask), bullish directional ticker tide required.",
  },
  {
    id: "calls-sector-wave",
    title: "Calls · Sector wave",
    side: "call",
    maxPerDay: 2,
    timeStopSessions: 3,
    rules: "3+ distinct issuers in the same sector with qualifying ask-side call buying today; log the strongest 1–2.",
  },
  {
    id: "puts-earnings-rundown",
    title: "Puts · Earnings run-down",
    side: "put",
    maxPerDay: 3,
    timeStopSessions: 5,
    rules:
      "Put buying 5–15 trading days before earnings, expiry after earnings, on weak relative strength (today ≤ −0.5% vs the stronger of SPY/QQQ, or 5-day ≤ −2% vs SPY). Time stop 5 sessions, exit before the report.",
  },
  {
    id: "puts-breakdown",
    title: "Puts · Breakdown",
    side: "put",
    maxPerDay: 3,
    timeStopSessions: 3,
    rules:
      "Underlying at the print within 2% above (or ≤ 2% below) the prior 20- or 50-day low, heavy ask-side put buying (≥ 70% ask); bullish directional ticker tide blocks.",
  },
  {
    id: "puts-sector-selloff",
    title: "Puts · Sector selloff",
    side: "put",
    maxPerDay: 2,
    timeStopSessions: 3,
    rules: "3+ distinct issuers in the same sector with qualifying ask-side put buying today; log the strongest 1–2.",
  },
];

export const LANE_COMMON_RULES = {
  minPremiumUsd: 25_000,
  minDte: 7,
  maxDte: 30,
  maxDteEarnings: 45,
  minAskShare: 0.65,
  heavyAskShare: 0.7,
  minVolOi: 1,
  maxItmPct: 0.03,
  maxOtmPct: 0.08,
  minUnderlying: 10,
  minMarketCap: 5_000_000_000,
  maxPerIssuer: 1,
  exit: { targetPct: 40, stopPct: -25 },
  notes:
    "Single-leg, ask-side ≥ 65%, opening (vol/OI ≥ 1 or all-opening), repeated/sweep, liquid (≥ $10 and ≥ $5B or ETF), no late (≥ 14:00 ET) or stale prints, no logging in pre-release lockouts, directional ticker tide against the trade blocks.",
} as const;

const MAX_EARNINGS_LOOKUPS = 8;
const MAX_CHARTS = 14;
const MAX_TRACK = 40;
const CACHE_MS = 10 * 60_000;
const CHART_TTL_MS = 10 * 60_000;
export const LANES_DISCLAIMER =
  "TEST MODE — study only, small size. Setup lanes are logged separately and never feed picks or the AI review. Not financial advice; FlowGuard never trades.";

export type LaneCandidate = {
  lane: LaneId;
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
  premiumUsd: number;
  printTimeUtc: string;
  flowScore: number;
  laneScore: number;
  tickerTide: TideBias | null;
  marketTide: TideBias | null;
  reasons: string[];
  earningsDate?: string | null;
  exitPlan: { entry: number; target: number; targetPct: number; stop: number; stopPct: number; timeStopSessions: number };
};

export type LaneTracking = {
  asOf: string;
  sessionsAfter: number;
  returns: Record<"t1" | "t2" | "t3" | "t4" | "t5", number | null>;
  maxGainPct: number | null;
  maxDrawdownPct: number | null;
  hitTarget: boolean;
  hitStop: boolean;
  outcome: "winner" | "loser" | "flat" | "open";
  outcomeSession: number | null;
  final: boolean;
};

export type LaneEntry = LaneCandidate & {
  day: string;
  loggedAt: string;
  entry: number;
  regimeLabel: string | null;
  tracking?: LaneTracking;
};

export type LaneBook = { updatedAt: string; entries: LaneEntry[] };

export type LaneResult = {
  lane: LaneDef;
  picks: LaneEntry[];
  candidates: LaneCandidate[];
  candidatesConsidered: number;
  warning?: string;
  sectorCounts?: Record<string, number>;
};

export type LanesResponse = {
  mode: "test";
  day: string;
  source: string;
  fetchedAt: string;
  generatedAt: string;
  lanes: LaneResult[];
  context: { marketTide: TideBias | null; spyPct: number | null; qqqPct: number | null; regimeLabel: string | null };
  warning?: string;
  rules: typeof LANE_COMMON_RULES;
  lookups: { earnings: number; charts: number };
  persistence: string;
  disclaimer: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_FILTERS: FlowFilters = {
  minPremium: 10_000,
  minDte: 0,
  maxDte: 3650,
  side: "all",
  minConviction: 0,
  unusual: false,
  strictAntiFade: false,
  ticker: "",
};

function otmPct(side: "call" | "put", strike: number, spot: number): number {
  if (!(spot > 0)) return 0;
  return side === "call" ? (strike - spot) / spot : (spot - strike) / spot;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Weekdays d with from < d ≤ to (holidays ignored). */
export function tradingDaysBetween(from: string, to: string): number {
  let n = 0;
  const end = Date.parse(to);
  for (let t = Date.parse(from) + 86_400_000; t <= end; t += 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) n += 1;
  }
  return n;
}

/** Common hard filters (pure). */
export function laneEligible(row: RankedFlow, maxDte: number, now = new Date()): boolean {
  const a = row.alert;
  const r = LANE_COMMON_RULES;
  if (a.has_multileg || !a.has_singleleg) return false;
  if (toNumber(a.total_premium) < r.minPremiumUsd) return false;
  if (row.dte < r.minDte || row.dte > maxDte) return false;
  const m = otmPct(a.type, toNumber(a.strike), toNumber(a.underlying_price));
  if (m < -r.maxItmPct || m > r.maxOtmPct) return false;
  if (askShare(a) < r.minAskShare) return false;
  if (!(toNumber(a.volume_oi_ratio) >= r.minVolOi || a.all_opening_trades)) return false;
  if (!(a.has_sweep || a.trade_count >= 2 || /repeat/i.test(a.alert_rule || ""))) return false;
  if (row.stale) return false;
  if (isLateSessionPrint(a.created_at, now)) return false;
  if (toNumber(a.underlying_price) < r.minUnderlying) return false;
  if (/etf|index/i.test(a.issue_type || "")) return true;
  return a.marketcap != null && a.marketcap >= r.minMarketCap;
}

function baseScore(row: RankedFlow, tide: TideBias | null): { s: number; reasons: string[] } {
  const a = row.alert;
  const reasons: string[] = [];
  const ask = askShare(a);
  let s = 30 + (ask - 0.65) * 60;
  reasons.push(`${Math.round(ask * 100)}% ask`);
  const volOi = toNumber(a.volume_oi_ratio);
  s += Math.min(12, Math.log2(Math.max(1, volOi)) * 4);
  reasons.push(`vol/OI ${volOi.toFixed(1)}×`);
  if (a.has_sweep) {
    s += 6;
    reasons.push("sweep");
  }
  if (a.trade_count >= 3) s += Math.min(6, a.trade_count);
  s += Math.min(10, Math.log10(Math.max(1, toNumber(a.total_premium) / 25_000)) * 8);
  const want: TideBias = a.type === "call" ? "bullish" : "bearish";
  if (tide === want) {
    s += 10;
    reasons.push(`ticker tide ${want}`);
  }
  const mkt = row.marketTideBias;
  if (mkt === want) {
    s += 5;
    reasons.push(`market tide ${want}`);
  }
  return { s, reasons };
}

type Chart = {
  price: number | null;
  prevClose: number | null;
  todayPct: number | null;
  change5dPct: number | null;
  sma20: number | null;
  high20: number | null;
  high50: number | null;
  low20: number | null;
  low50: number | null;
};

const chartMem = new Map<string, { at: number; value: Chart | null }>();

/** Yahoo daily chart (free). Highs/lows exclude today's bar. */
async function fetchChart(ticker: string, today: string): Promise<Chart | null> {
  const hit = chartMem.get(ticker);
  if (hit && Date.now() - hit.at < CHART_TTL_MS) return hit.value;
  let value: Chart | null = null;
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; FlowGuard/1.0)" }, cache: "no-store", signal: AbortSignal.timeout(6000) },
    );
    if (res.ok) {
      const j = (await res.json()) as {
        chart?: { result?: Array<{ meta?: { regularMarketPrice?: number }; timestamp?: number[]; indicators?: { quote?: Array<{ close?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[] }> } }> };
      };
      const r = j.chart?.result?.[0];
      const ts = r?.timestamp ?? [];
      const q = r?.indicators?.quote?.[0] ?? {};
      const bars = ts
        .map((t, i) => ({
          date: tradingDateET(new Date(t * 1000)),
          close: q.close?.[i] ?? null,
          high: q.high?.[i] ?? null,
          low: q.low?.[i] ?? null,
        }))
        .filter((b) => b.close != null);
      const prior = bars.filter((b) => b.date < today);
      const price = r?.meta?.regularMarketPrice ?? bars[bars.length - 1]?.close ?? null;
      const prevClose = prior[prior.length - 1]?.close ?? null;
      const last = (n: number) => prior.slice(-n);
      const max = (xs: (number | null)[]) => (xs.length ? Math.max(...xs.map((x) => x ?? -Infinity)) : null);
      const min = (xs: (number | null)[]) => (xs.length ? Math.min(...xs.map((x) => x ?? Infinity)) : null);
      const c5 = prior.length >= 5 ? prior[prior.length - 5].close : null;
      const closes20 = last(20).map((b) => b.close as number);
      value = {
        price,
        prevClose,
        todayPct: price != null && prevClose ? ((price - prevClose) / prevClose) * 100 : null,
        change5dPct: price != null && c5 ? ((price - c5) / c5) * 100 : null,
        sma20: closes20.length >= 15 ? closes20.reduce((a, b) => a + b, 0) / closes20.length : null,
        high20: max(last(20).map((b) => b.high)),
        high50: max(last(50).map((b) => b.high)),
        low20: min(last(20).map((b) => b.low)),
        low50: min(last(50).map((b) => b.low)),
      };
    }
  } catch {
    value = null;
  }
  chartMem.set(ticker, { at: Date.now(), value });
  return value;
}

function toCandidate(lane: LaneDef, row: RankedFlow, s: number, reasons: string[], tide: TideBias | null, timeStop: number, earningsDate?: string | null): LaneCandidate {
  const a = row.alert;
  const price = toNumber(a.price);
  const { targetPct, stopPct } = LANE_COMMON_RULES.exit;
  return {
    lane: lane.id,
    contract: contractKey(row),
    ticker: a.ticker,
    issuer: issuerKey(a.ticker),
    sector: sectorOf(a.ticker),
    side: a.type,
    strike: toNumber(a.strike),
    expiry: a.expiry,
    dte: row.dte,
    price,
    underlying: toNumber(a.underlying_price),
    otmPct: Math.round(otmPct(a.type, toNumber(a.strike), toNumber(a.underlying_price)) * 1000) / 10,
    askSharePct: Math.round(askShare(a) * 100),
    volOi: Math.round(toNumber(a.volume_oi_ratio) * 10) / 10,
    sweep: a.has_sweep,
    premiumUsd: Math.round(toNumber(a.total_premium)),
    printTimeUtc: a.created_at,
    flowScore: row.score,
    laneScore: Math.round(Math.max(0, Math.min(100, s))),
    tickerTide: tide,
    marketTide: row.marketTideBias,
    reasons,
    ...(earningsDate !== undefined ? { earningsDate } : {}),
    exitPlan: {
      entry: price,
      target: round2(price * (1 + targetPct / 100)),
      targetPct,
      stop: round2(price * (1 + stopPct / 100)),
      stopPct,
      timeStopSessions: timeStop,
    },
  };
}

function bookDocKind(id: LaneId): string {
  return `lane-${id}`;
}

export async function loadBook(id: LaneId): Promise<LaneBook> {
  return (await loadDoc<LaneBook>(bookDocKind(id), "book", { fresh: true })) ?? { updatedAt: "", entries: [] };
}

// ---------------------------------------------------------------------------
// Compute all lanes in one pass.
// ---------------------------------------------------------------------------

let cache: { at: number; value: LanesResponse } | null = null;
let inflight: Promise<LanesResponse> | null = null;

async function compute(): Promise<LanesResponse> {
  const day = tradingDateET();
  const tape = await loadRankedFlow(ALL_FILTERS);
  const regime = await loadRegimeSafe(tape.tide);
  const live = tape.source === "live";

  // Directional ticker tide (call-ask + put-bid = bullish; put-ask + call-bid = bearish) with per-chain contributions.
  const dir = new Map<string, { bull: number; bear: number }>();
  const ownChain = new Map<string, { bull: number; bear: number }>();
  for (const row of tape.items) {
    const a = row.alert;
    const ask = Math.max(0, toNumber(a.total_ask_side_prem));
    const bid = Math.max(0, toNumber(a.total_bid_side_prem));
    const bull = a.type === "call" ? ask : bid;
    const bear = a.type === "call" ? bid : ask;
    const cur = dir.get(a.ticker) ?? { bull: 0, bear: 0 };
    cur.bull += bull;
    cur.bear += bear;
    dir.set(a.ticker, cur);
    const k = contractKey(row);
    const oc = ownChain.get(k) ?? { bull: 0, bear: 0 };
    oc.bull += bull;
    oc.bear += bear;
    ownChain.set(k, oc);
  }
  /** Excludes the candidate chain's own flow so a print cannot confirm itself. */
  const tideFor = (row: RankedFlow): TideBias | null => {
    const d = dir.get(row.alert.ticker);
    if (!d) return null;
    const own = ownChain.get(contractKey(row)) ?? { bull: 0, bear: 0 };
    const bull = Math.max(0, d.bull - own.bull);
    const bear = Math.max(0, d.bear - own.bear);
    if (bull + bear < 25_000) return null;
    return tideFromPremiums(bull, bear, null).bias;
  };

  // Best row per chain across both eligibility windows.
  const best = (maxDte: number) => {
    const m = new Map<string, RankedFlow>();
    for (const row of tape.items) {
      if (!laneEligible(row, maxDte)) continue;
      const k = contractKey(row);
      const cur = m.get(k);
      if (!cur || toNumber(row.alert.total_premium) > toNumber(cur.alert.total_premium)) m.set(k, row);
    }
    return [...m.values()];
  };
  const elig30 = best(LANE_COMMON_RULES.maxDte);
  const elig45 = best(LANE_COMMON_RULES.maxDteEarnings);
  const against = (row: RankedFlow) => {
    const t = tideFor(row);
    return (row.alert.type === "call" && t === "bearish") || (row.alert.type === "put" && t === "bullish");
  };

  // ---- Lookups (capped, cached) ----
  const allowUw = live && (await hasUnusualWhalesKey()) && !(await isUwBlocked());
  const ranked45 = [...elig45].filter((r) => !against(r)).sort((a, b) => baseScore(b, tideFor(b)).s - baseScore(a, tideFor(a)).s);
  const isEtf = (r: RankedFlow) => /etf|index/i.test(r.alert.issue_type || "");
  const earnTickers = [...new Set(ranked45.filter((r) => !isEtf(r)).map((r) => r.alert.ticker))].slice(0, MAX_EARNINGS_LOOKUPS);
  const earnings = new Map<string, string | null>();
  if (allowUw) {
    await Promise.all(
      earnTickers.map(async (t) => earnings.set(t, (await fetchTickerInfo(t).catch(() => null))?.nextEarningsDate ?? null)),
    );
  }
  // Charts: earnings-window names first (both earnings lanes need them), then the strongest other names.
  const inWindow = earnTickers.filter((t) => {
    const ed = earnings.get(t);
    if (!ed) return false;
    const td = tradingDaysBetween(day, ed);
    return td >= 5 && td <= 15;
  });
  const byScore = [...elig30, ...elig45].filter((r) => !against(r)).sort((a, b) => b.score - a.score).map((r) => r.alert.ticker);
  const chartTickers = [
    "SPY",
    "QQQ",
    ...[...new Set([...inWindow, ...byScore])].filter((t) => t !== "SPY" && t !== "QQQ").slice(0, MAX_CHARTS),
  ];
  const charts = new Map<string, Chart | null>();
  if (live) await Promise.all(chartTickers.map(async (t) => charts.set(t, await fetchChart(t, day))));
  const spy = charts.get("SPY") ?? null;
  const qqq = charts.get("QQQ") ?? null;
  const benchToday = [spy?.todayPct, qqq?.todayPct].filter((x): x is number => x != null);

  const results: LaneResult[] = [];
  for (const lane of LANES) {
    const out: LaneCandidate[] = [];
    let sectorCounts: Record<string, number> | undefined;
    if (lane.id === "calls-earnings-runup" || lane.id === "puts-earnings-rundown") {
      for (const row of elig45) {
        const a = row.alert;
        if (a.type !== lane.side || against(row) || isEtf(row)) continue;
        const ed = earnings.get(a.ticker);
        if (!ed) continue;
        const td = tradingDaysBetween(day, ed);
        if (td < 5 || td > 15 || a.expiry <= ed) continue;
        const ch = charts.get(a.ticker) ?? null;
        const tide = tideFor(row);
        const { s, reasons } = baseScore(row, tide);
        let score = s;
        if (lane.side === "call") {
          if (!ch || ch.change5dPct == null) continue;
          const extended =
            ch.change5dPct > 8 || (ch.todayPct ?? 0) > 3 || (ch.sma20 != null && ch.price != null && ch.price > ch.sma20 * 1.1);
          if (extended) continue;
          reasons.push(`earnings ${ed} (${td} sessions)`, `5d ${ch.change5dPct.toFixed(1)}%`);
        } else {
          if (!ch) continue;
          const relToday = ch.todayPct != null && benchToday.length ? ch.todayPct - Math.max(...benchToday) : null;
          const rel5 = ch.change5dPct != null && spy?.change5dPct != null ? ch.change5dPct - spy.change5dPct : null;
          const weak = (relToday != null && relToday <= -0.5) || (rel5 != null && rel5 <= -2);
          if (!weak) continue;
          reasons.push(`earnings ${ed} (${td} sessions)`, `rel. strength today ${relToday?.toFixed(1) ?? "?"}% / 5d ${rel5?.toFixed(1) ?? "?"}%`);
          score += 5;
        }
        // Exit the session before the report.
        const timeStop = Math.max(1, Math.min(lane.timeStopSessions, td - 1));
        out.push(toCandidate(lane, row, score, reasons, tide, timeStop, ed));
      }
    } else if (lane.id === "calls-breakout" || lane.id === "puts-breakdown") {
      for (const row of elig30) {
        const a = row.alert;
        if (a.type !== lane.side || against(row) || askShare(a) < LANE_COMMON_RULES.heavyAskShare) continue;
        const ch = charts.get(a.ticker);
        const u = toNumber(a.underlying_price);
        if (!ch || !(u > 0)) continue;
        const tide = tideFor(row);
        const { s, reasons } = baseScore(row, tide);
        if (lane.side === "call") {
          if (tide !== "bullish") continue;
          const near = (
            [
              ["20", ch.high20],
              ["50", ch.high50],
            ] as const
          )
            .filter(([, h]) => h != null && h > 0)
            .map(([n, h]) => ({ n, d: (u / (h as number) - 1) * 100 }))
            .filter(({ d }) => d >= -2 && d <= 1);
          if (!near.length) continue;
          reasons.push(near.map(({ n, d }) => `${d >= 0 ? "+" : ""}${d.toFixed(1)}% vs ${n}-day high`).join(", "));
        } else {
          const near = (
            [
              ["20", ch.low20],
              ["50", ch.low50],
            ] as const
          )
            .filter(([, l]) => l != null && l > 0)
            .map(([n, l]) => ({ n, d: (u / (l as number) - 1) * 100 }))
            .filter(({ d }) => d >= -2 && d <= 2);
          if (!near.length) continue;
          reasons.push(near.map(({ n, d }) => `${d >= 0 ? "+" : ""}${d.toFixed(1)}% vs ${n}-day low`).join(", "));
        }
        out.push(toCandidate(lane, row, s, reasons, tide, lane.timeStopSessions));
      }
    } else {
      // Sector wave / selloff: ≥ 3 distinct issuers in a known sector with qualifying ask-side flow on this side.
      const bySector = new Map<string, RankedFlow[]>();
      for (const row of elig30) {
        if (row.alert.type !== lane.side || against(row)) continue;
        const sec = sectorOf(row.alert.ticker);
        if (sec.startsWith("Other:")) continue;
        (bySector.get(sec) ?? bySector.set(sec, []).get(sec)!).push(row);
      }
      sectorCounts = {};
      for (const [sec, rows] of bySector) {
        const issuers = new Set(rows.map((r) => issuerKey(r.alert.ticker)));
        sectorCounts[sec] = issuers.size;
        if (issuers.size < 3) continue;
        for (const row of rows) {
          const tide = tideFor(row);
          const { s, reasons } = baseScore(row, tide);
          reasons.push(`${sec}: ${issuers.size} names with ask-side ${lane.side}s`);
          out.push(toCandidate(lane, row, s + Math.min(10, (issuers.size - 2) * 3), reasons, tide, lane.timeStopSessions));
        }
      }
    }
    out.sort((a, b) => b.laneScore - a.laneScore);
    results.push({ lane, picks: [], candidates: out.slice(0, 6), candidatesConsidered: out.length, sectorCounts });
  }

  // ---- Daily logging per lane (frozen once logged) ----
  const locked = lockoutWarning(regime);
  for (const res of results) {
    const book = live ? await loadBook(res.lane.id) : { updatedAt: "", entries: [] };
    const todays = book.entries.filter((e) => e.day === day);
    let added = false;
    if (live && !locked) {
      const pool = [...res.candidates];
      for (const c of pool) {
        if (todays.length >= res.lane.maxPerDay) break;
        if (todays.some((e) => e.contract === c.contract || e.issuer === c.issuer)) continue;
        const entry: LaneEntry = { ...c, day, loggedAt: new Date().toISOString(), entry: c.price, regimeLabel: regime?.label ?? null };
        todays.push(entry);
        book.entries.push(entry);
        added = true;
      }
    }
    if (added) {
      const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
      book.entries = book.entries.filter((e) => e.day >= cutoff);
      book.updatedAt = new Date().toISOString();
      await saveDoc(bookDocKind(res.lane.id), "book", book);
    }
    res.picks = todays;
    if (todays.length === 0) res.warning = locked ?? tape.warning ?? "No qualifying setups this session.";
  }

  return {
    mode: "test",
    day,
    source: tape.source,
    fetchedAt: tape.fetchedAt,
    generatedAt: new Date().toISOString(),
    lanes: results,
    context: {
      marketTide: tape.tide?.bias ?? null,
      spyPct: spy?.todayPct != null ? round2(spy.todayPct) : null,
      qqqPct: qqq?.todayPct != null ? round2(qqq.todayPct) : null,
      regimeLabel: regime?.label ?? null,
    },
    warning: locked ?? tape.warning,
    rules: LANE_COMMON_RULES,
    lookups: { earnings: allowUw ? earnTickers.length : 0, charts: live ? chartTickers.length : 0 },
    persistence: persistenceMode(),
    disclaimer: LANES_DISCLAIMER,
  };
}

export async function loadLanes(): Promise<LanesResponse> {
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
// Tracking (T+1..T+5) — generic long-option tracker with per-entry time stop.
// ---------------------------------------------------------------------------

export function trackFromBars(
  entry: LaneEntry,
  bars: { date: string; last: number | null; high: number | null; low: number | null }[],
  today: string,
): LaneTracking {
  const after = bars.filter((b) => b.date > entry.day).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
  const ret = (p: number | null | undefined) =>
    p != null && p > 0 && entry.entry > 0 ? Math.round(((p - entry.entry) / entry.entry) * 1000) / 10 : null;
  const keys = ["t1", "t2", "t3", "t4", "t5"] as const;
  const returns = Object.fromEntries(keys.map((k, i) => [k, ret(after[i]?.last)])) as LaneTracking["returns"];
  let maxGain: number | null = null;
  let maxDd: number | null = null;
  for (const b of after) {
    const hi = ret(Math.max(b.high ?? 0, b.last ?? 0) || null);
    const lo = ret(b.low ?? b.last);
    if (hi != null && (maxGain == null || hi > maxGain)) maxGain = hi;
    if (lo != null && (maxDd == null || lo < maxDd)) maxDd = lo;
  }
  const { targetPct, stopPct } = LANE_COMMON_RULES.exit;
  const ts = entry.exitPlan?.timeStopSessions ?? 3;
  let outcome: LaneTracking["outcome"] = "open";
  let outcomeSession: number | null = null;
  let hitTarget = false;
  let hitStop = false;
  for (let i = 0; i < Math.min(ts, after.length); i += 1) {
    const b = after[i];
    const hi = ret(Math.max(b.high ?? 0, b.last ?? 0) || null);
    const lo = ret(b.low ?? b.last);
    if (hi != null && hi >= targetPct) hitTarget = true;
    if (lo != null && lo <= stopPct) hitStop = true;
    if (lo != null && lo <= stopPct) {
      outcome = "loser";
      outcomeSession = i + 1;
      break;
    }
    if (hi != null && hi >= targetPct) {
      outcome = "winner";
      outcomeSession = i + 1;
      break;
    }
  }
  const expired = today > entry.expiry;
  if (outcome === "open" && (after.length >= ts || expired)) {
    outcome = "flat";
    outcomeSession = Math.min(ts, after.length) || null;
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

export function summarizeLane(entries: LaneEntry[]) {
  const t = entries.map((e) => e.tracking).filter((x): x is LaneTracking => Boolean(x));
  const c = (o: LaneTracking["outcome"]) => t.filter((x) => x.outcome === o).length;
  const avg = (k: "t1" | "t3" | "t5") => {
    const v = t.map((x) => x.returns[k]).filter((n): n is number => n != null);
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
  };
  const w = c("winner");
  const l = c("loser");
  const f = c("flat");
  const n = w + l + f;
  return { n: entries.length, w, l, flat: f, open: entries.length - n, winRate: n ? Math.round((w / n) * 1000) / 10 : null, avgT1: avg("t1"), avgT3: avg("t3"), avgT5: avg("t5") };
}

export async function trackLanes(only?: LaneId) {
  const today = tradingDateET();
  const ids = only ? [only] : LANES.map((l) => l.id);
  const books = await Promise.all(ids.map(async (id) => ({ id, book: await loadBook(id) })));
  const allowUw = (await hasUnusualWhalesKey()) && !(await isUwBlocked());
  let calls = 0;
  if (allowUw) {
    // Oldest-checked first so a cap rotates fairly across lanes.
    const open = books
      .flatMap(({ id, book }) => book.entries.filter((e) => !e.tracking?.final && e.day < today).map((e) => ({ id, e })))
      .sort((a, b) => String(a.e.tracking?.asOf ?? "").localeCompare(String(b.e.tracking?.asOf ?? "")))
      .slice(0, MAX_TRACK);
    const touched = new Set<LaneId>();
    await Promise.all(
      open.map(async ({ id, e }) => {
        const bars = await fetchContractHistoric(e.contract, 12).catch(() => []);
        calls += 1;
        if (bars.length) {
          e.tracking = trackFromBars(e, bars, today);
          touched.add(id);
        }
      }),
    );
    for (const { id, book } of books) {
      if (!touched.has(id)) continue;
      book.updatedAt = new Date().toISOString();
      await saveDoc(bookDocKind(id), "book", book);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    today,
    definition:
      "Entry = flow print price. T+1..T+5 = option close vs entry each session after the entry day. Within the lane time stop (5 sessions for earnings lanes, capped to exit before the report; 3 otherwise): winner = high ≥ +40% first, loser = low ≤ −25% first (same session both = loser), flat = neither.",
    lanes: books.map(({ id, book }) => ({
      lane: id,
      title: LANES.find((l) => l.id === id)?.title ?? id,
      summary: summarizeLane(book.entries),
      entries: book.entries,
    })),
    uwCalls: calls,
    persistence: persistenceMode(),
    disclaimer: LANES_DISCLAIMER,
  };
}

export function isLaneId(v: string | null): v is LaneId {
  return LANES.some((l) => l.id === v);
}
