import { issuerKey } from "@/lib/issuers";
import { askShare, toNumber } from "@/lib/numbers";
import { isEtfOrIndex } from "@/lib/puts-rule";
import { excludedFromActionable, hasScoreChip } from "@/lib/scoring";
import { isInCurrentSession, isLateSessionPrint } from "@/lib/session";
import { SPREAD_MAX_PCT, resolveSpread } from "@/lib/spread-core";
import type { FlowAlert, RankedFlow } from "@/lib/types";

/**
 * TEST MODE ONLY (FLOWGUARD_GROK_WIDE=1): pure selection + grading for the Grok "wide pool". Pure logic (no I/O) so
 * scripts/study/grok-wide-check.ts can test it. The wide pool is the session-tape rows the live lists cut before the
 * Grok lessons reviewer ever sees them (the live finalists are ≤ 8/day; the scored pool is 600–1,200 contracts/day):
 *  - tier "pool": passes the Picks filters (DTE 0–60, premium ≥ $10K, unusual, score ≥ 55, anti-fade, actionable, pre-14:00 ET)
 *    but ranked below the list caps — the same population as the history backtest (pool rank 13–80).
 *  - tier "near-miss": same, but score 45–54 (cut only by the score-55 conviction floor). Not in the history backtest:
 *    scored separately so it never muddies the "pool" read.
 * Both tiers need a known spread ≤ 10% of mid (the live spread gate). Single-stock puts are kept (tagged) because this
 * pool is for learning only. Never feeds morning / picks / premove / ai-picks / board / paper / pings / Telegram.
 */

export type WideTier = "pool" | "near-miss";

export type WideCandidate = {
  contract: string;
  ticker: string;
  side: "call" | "put";
  strike: number;
  expiry: string;
  dte: number;
  score: number;
  rawScore: number;
  tier: WideTier;
  printTimeUtc: string;
  /** Ask at the print (entry for grading); falls back to the print price when the alert has no ask. */
  entry: number;
  underlying: number;
  premiumUsd: number;
  askSharePct: number;
  spreadPct: number;
  volOi: number;
  sweep: boolean;
  etf: boolean;
  chips: string[];
  firstSeenAt: string;
};

export type WideJudgement = { judge: "take" | "pass"; confidence: number; why: string; at: string };

export type WideGrade = {
  status: "graded" | "pending" | "no-data";
  ret: number | null;
  how: "target" | "target_gap" | "stop" | "stop_gap" | "time" | null;
  timeStopDate: string;
  checkedAt: string;
  tries: number;
};

export const WIDE_POOL_MIN_SCORE = 55;
export const WIDE_NEAR_MISS_MIN_SCORE = 45;
/** Near-miss rows are at most this share of a run (the history test only covers tier "pool"). */
export const WIDE_NEAR_MISS_SHARE = 1 / 3;
export const WIDE_MAX_PER_ISSUER = 3;

/** Same rule as lib/flow-service looksUnusual (copied: that module is server-only). */
export function looksUnusualAlert(a: FlowAlert): boolean {
  if (a.all_opening_trades || a.has_sweep || a.has_floor) return true;
  if (toNumber(a.volume_oi_ratio) >= 1) return true;
  if (a.total_size > 0 && a.open_interest > 0 && a.total_size > a.open_interest) return true;
  const rule = (a.alert_rule || "").trim();
  return rule.length > 0 && rule.toLowerCase() !== "none";
}

export function wideContractKey(a: FlowAlert): string {
  return a.option_chain || a.id;
}

export function wideTier(row: RankedFlow, now: Date): WideTier | null {
  const a = row.alert;
  if (!isInCurrentSession(a.created_at, now)) return null;
  if (row.dte < 0 || row.dte > 60) return null;
  if (toNumber(a.total_premium) < 10_000) return null;
  if (!looksUnusualAlert(a)) return null;
  if (row.stale || row.fadeProne) return null;
  if (excludedFromActionable(row) || hasScoreChip(row, "late-print") || isLateSessionPrint(a.created_at, now)) return null;
  if (row.score >= WIDE_POOL_MIN_SCORE) return "pool";
  if (row.score >= WIDE_NEAR_MISS_MIN_SCORE) return "near-miss";
  return null;
}

export function toWideCandidate(row: RankedFlow, tier: WideTier, now: Date): WideCandidate | null {
  const a = row.alert;
  const sp = resolveSpread(null, { bid: a.bid, ask: a.ask });
  if (sp.pct == null || sp.pct > SPREAD_MAX_PCT) return null;
  const entry = toNumber(a.ask) || toNumber(a.price);
  if (!(entry > 0)) return null;
  return {
    contract: wideContractKey(a),
    ticker: a.ticker,
    side: a.type,
    strike: toNumber(a.strike),
    expiry: a.expiry.slice(0, 10),
    dte: row.dte,
    score: row.score,
    rawScore: row.rawScore ?? row.score,
    tier,
    printTimeUtc: a.created_at,
    entry,
    underlying: toNumber(a.underlying_price),
    premiumUsd: Math.round(toNumber(a.total_premium)),
    askSharePct: Math.round(askShare(a) * 100),
    spreadPct: sp.pct,
    volOi: Math.round(toNumber(a.volume_oi_ratio) * 10) / 10,
    sweep: Boolean(a.has_sweep),
    etf: isEtfOrIndex(a.ticker, a.issue_type),
    chips: row.chips.map((ch) => `${ch.id}(${ch.delta >= 0 ? "+" : ""}${ch.delta})`),
    firstSeenAt: now.toISOString(),
  };
}

/**
 * Pick up to `limit` new wide-pool candidates from ranked tape rows. `exclude` = today's live shadow finalists and
 * contracts already in today's wide doc. `issuerCounts` carries today's per-issuer count so the 2/issuer cap holds all day.
 * Order: tier "pool" by score then premium; near-miss fills at most WIDE_NEAR_MISS_SHARE of the run.
 */
export function selectWide(
  rows: RankedFlow[],
  opts: { now: Date; exclude: Set<string>; limit: number; issuerCounts?: Record<string, number> },
): WideCandidate[] {
  const best = new Map<string, { row: RankedFlow; tier: WideTier }>();
  for (const row of rows) {
    const tier = wideTier(row, opts.now);
    if (!tier) continue;
    const k = wideContractKey(row.alert);
    if (opts.exclude.has(k)) continue;
    const cur = best.get(k);
    if (!cur || row.score > cur.row.score || (row.score === cur.row.score && toNumber(row.alert.total_premium) > toNumber(cur.row.alert.total_premium))) {
      best.set(k, { row, tier });
    }
  }
  const order = (x: { row: RankedFlow }, y: { row: RankedFlow }) =>
    y.row.score - x.row.score || (y.row.rawScore ?? y.row.score) - (x.row.rawScore ?? x.row.score) || toNumber(y.row.alert.total_premium) - toNumber(x.row.alert.total_premium);
  const all = [...best.values()].sort(order);
  const counts: Record<string, number> = { ...(opts.issuerCounts ?? {}) };
  const out: WideCandidate[] = [];
  const nearCap = Math.floor(opts.limit * WIDE_NEAR_MISS_SHARE);
  let near = 0;
  const take = (tier: WideTier, cap: number) => {
    for (const { row, tier: t } of all) {
      if (out.length >= cap) return;
      if (t !== tier) continue;
      if (tier === "near-miss" && near >= nearCap) return;
      const iss = issuerKey(row.alert.ticker);
      if ((counts[iss] ?? 0) >= WIDE_MAX_PER_ISSUER) continue;
      const c = toWideCandidate(row, t, opts.now);
      if (!c || out.some((o) => o.contract === c.contract)) continue;
      counts[iss] = (counts[iss] ?? 0) + 1;
      if (tier === "near-miss") near += 1;
      out.push(c);
    }
  };
  // Reserve the near-miss share first so a deep "pool" tier cannot crowd it out; unused near-miss slots go back to "pool".
  take("pool", opts.limit - nearCap);
  take("near-miss", opts.limit);
  take("pool", opts.limit);
  return out;
}

/** One fact line per candidate (same fields as scripts/study/grok-wide-backtest.py, so live and history prompts match). */
export function wideFactLine(c: WideCandidate): string {
  const ct = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(c.printTimeUtc));
  return (
    `${c.contract} | ${c.ticker} ${c.side} K${c.strike} dte${c.dte} px${c.underlying} ask$${c.entry} spread${(c.spreadPct * 100).toFixed(1)}% ` +
    `${c.etf ? "ETF/index" : "stock"} askShare${c.askSharePct}% prem$${Math.round(c.premiumUsd / 1000)}k vol/OI${c.volOi} ${c.sweep ? "sweep" : "no-sweep"} ` +
    `score${Math.round(c.score)} lanes=wide-pool+${c.tier} t=${ct}CT`
  );
}

export type GradeBar = { date: string; open: number | null; high: number | null; low: number | null; close: number | null };

/**
 * LIVE exit rules on daily bars after the entry day (same as scripts/study/exit-rules-backtest.py simulate(), headline
 * order): buy at the print ask, sell at price × (1 − spread/2); open gap through stop/target first, then stop before target
 * inside a session, else the close of the time-stop session. Pending until a bar for the time-stop day exists.
 */
export function gradeWide(c: Pick<WideCandidate, "entry" | "spreadPct">, entryDay: string, timeStopDate: string, bars: GradeBar[]): Pick<WideGrade, "status" | "ret" | "how"> {
  const entry = c.entry;
  const f = 1 - Math.max(0, c.spreadPct) / 2;
  const stop = entry * 0.75;
  const target = entry * 1.3;
  const sess = bars.filter((b) => b.date > entryDay && b.date <= timeStopDate).sort((a, b) => a.date.localeCompare(b.date));
  for (const b of sess) {
    const o = b.open || b.close;
    const cl = b.close || o;
    if (!o && !b.high && !b.low) continue;
    const hs = [b.high, o, cl].filter((x): x is number => Boolean(x));
    const h = Math.max(...hs);
    const l = Math.min(...[b.low, o, cl].filter((x): x is number => Boolean(x)));
    if (o && o <= stop) return { status: "graded", ret: (o * f) / entry - 1, how: "stop_gap" };
    if (o && o >= target) return { status: "graded", ret: (o * f) / entry - 1, how: "target_gap" };
    if (l <= stop) return { status: "graded", ret: (stop * f) / entry - 1, how: "stop" };
    if (h >= target) return { status: "graded", ret: (target * f) / entry - 1, how: "target" };
  }
  const last = sess[sess.length - 1];
  if (!last || last.date < timeStopDate) return { status: "pending", ret: null, how: null };
  const px = last.close || last.open;
  if (!px) return { status: "no-data", ret: null, how: null };
  return { status: "graded", ret: (px * f) / entry - 1, how: "time" };
}
