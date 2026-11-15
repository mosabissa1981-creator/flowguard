import "server-only";

import {
  buildWeekScore,
  hardGuardReason,
  isFridayAfterClose,
  panelFrom,
  parseMainSourceSetting,
  qualityFloorReason,
  renderWeekMd,
  resolveMainSource,
  selectAiTraderFills,
  weekEndingOn,
  type AiTraderPanel,
  type AiTraderRow,
  type AiTraderSource,
  type HeldSlot,
  type PaperTradeInput,
  type WeekScore,
} from "@/lib/ai-trader-books-core";
import { kvGet, kvGetMany, kvSet, kvSetNx } from "@/lib/kv";
import type { PaperClosed, PaperPosition } from "@/lib/paper-core";
import { round2 } from "@/lib/paper-core";
import { tradingDateET } from "@/lib/session";
import { etClock } from "@/lib/shadow/budget";
import { loadDoc } from "@/lib/shadow/store";
import { loadClaudeSecondDay } from "@/lib/shadow/claude-second";
import { loadGptThirdDay } from "@/lib/shadow/gpt-third";
import { loadWideDay } from "@/lib/shadow/wide-pool";
import type { RiskOffSnapshot } from "@/lib/risk-off-core";
import { loadRegimeSafe } from "@/lib/regime";
import { loadRiskOff } from "@/lib/risk-off";

/**
 * PAPER / TEST ONLY. Loads the wide / Claude / GPT decisions that already exist (no new LLM calls),
 * turns the quality-floor takes into paper fills, and writes the Friday score.
 * The score is stored in Redis and, when the disk is writable, under study/ai-trader-books/.
 * Hooked from the paper tick and the existing after-close signals cron. No new Vercel cron.
 */

const LATEST_KEY = "flowguard/ai-trader-books/latest";
const K_POS = "paper:positions";
const K_CLOSED = "paper:closed";
const doneKey = (weekEnd: string) => `flowguard/ai-trader-books/scored-${weekEnd}`;
const lockKey = (weekEnd: string) => `flowguard/ai-trader-books/scoring-${weekEnd}`;
const weekKey = (weekEnd: string) => `flowguard/ai-trader-books/week-${weekEnd}`;

const BOOK_SOURCE: Record<string, AiTraderSource> = {
  "ai-grok": "grok",
  "ai-claude": "claude",
  "ai-gpt": "gpt",
  "ai-rules": "rules",
};

export async function loadAiTraderRows(day: string): Promise<AiTraderRow[]> {
  const [wide, claude, gpt] = await Promise.all([loadWideDay(day), loadClaudeSecondDay(day), loadGptThirdDay(day)]);
  if (!wide) return [];
  return wide.candidates.map((c) => {
    const grade = wide.grades[c.contract];
    return {
      contract: c.contract,
      ticker: c.ticker,
      side: c.side,
      strike: c.strike,
      expiry: c.expiry,
      ask: c.entry,
      premiumUsd: c.premiumUsd,
      score: c.score,
      spreadPct: c.spreadPct,
      etf: c.etf,
      firstSeenAt: c.firstSeenAt,
      grok: wide.judgements[c.contract]?.judge ?? null,
      claude: claude?.judgements[c.contract]?.judge ?? null,
      gpt: gpt?.judgements[c.contract]?.judge ?? null,
      gradeRet: grade?.status === "graded" ? grade.ret : null,
      graded: grade?.status === "graded" && grade.ret != null,
    };
  });
}

export async function loadLatestWeek(): Promise<WeekScore | null> {
  const doc = await kvGet<WeekScore>(LATEST_KEY, { maxAgeMs: 60_000 });
  if (!doc || doc.kind !== "ai-trader-books" || !Array.isArray(doc.books)) return null;
  return doc;
}

export async function loadAiTraderPanel(): Promise<AiTraderPanel> {
  const latest = await loadLatestWeek().catch(() => null);
  return panelFrom(parseMainSourceSetting(process.env.FLOWGUARD_PAPER_MAIN_SOURCE), latest);
}

/** Today's competing-book fills, plus the main-book copy of the selected source. */
export async function gatherAiTraderFills(opts: {
  today: string;
  startedAtMs: number;
  blockEtfPuts: boolean;
  held: HeldSlot[];
}): Promise<ReturnType<typeof selectAiTraderFills>> {
  const rows = await loadAiTraderRows(opts.today);
  if (!rows.length) return [];
  // Regime only when there is a pool to cap. Calm caps if the read fails (same as a missed regime on the live list).
  const [latest, regime] = await Promise.all([loadLatestWeek().catch(() => null), loadRegimeSafe().catch(() => null)]);
  const setting = parseMainSourceSetting(process.env.FLOWGUARD_PAPER_MAIN_SOURCE);
  const resolved = resolveMainSource(setting, latest);
  return selectAiTraderFills(rows, {
    regimeLabel: regime?.label ?? null,
    blockEtfPuts: opts.blockEtfPuts,
    held: opts.held,
    mainSource: resolved.source,
    mainSourceWhy: resolved.why,
    notBeforeMs: opts.startedAtMs,
  });
}

async function blockEtfPutsFor(day: string, today: string): Promise<boolean> {
  if (day === today) {
    const live = await loadRiskOff().catch(() => null);
    return Boolean(live?.blockEtfPuts);
  }
  const snap = await loadDoc<RiskOffSnapshot>("study", `risk-off-${day}`).catch(() => null);
  return Boolean(snap?.blockEtfPuts);
}

function blankDecisions(): Record<AiTraderSource, { takes: Array<number | null>; passes: Array<number | null> }> {
  const side = () => ({ takes: [] as Array<number | null>, passes: [] as Array<number | null> });
  return { grok: side(), claude: side(), gpt: side(), rules: side() };
}

async function decisionBuckets(days: string[], today: string) {
  const decisions = blankDecisions();
  for (const day of days) {
    const [rows, block] = await Promise.all([loadAiTraderRows(day), blockEtfPutsFor(day, today)]);
    for (const row of rows) {
      if (qualityFloorReason(row) || hardGuardReason(row, block)) continue;
      const ret = row.graded && row.gradeRet != null ? row.gradeRet * 100 : null;
      decisions.rules.takes.push(ret);
      for (const source of ["grok", "claude", "gpt"] as const) {
        if (row[source] === "take") decisions[source].takes.push(ret);
        else if (row[source] === "pass") decisions[source].passes.push(ret);
      }
    }
  }
  return decisions;
}

function tradesFromLedger(open: PaperPosition[], closed: PaperClosed[], days: Set<string>): { trades: PaperTradeInput[]; pending: Record<AiTraderSource, number> } {
  const trades: PaperTradeInput[] = [];
  const pending: Record<AiTraderSource, number> = { grok: 0, claude: 0, gpt: 0, rules: 0 };
  const push = (p: { book: string; day: string; contract: string; ticker: string; qty: number; costUsd: number }, closedTrade: { pnlUsd: number; pnlPct: number } | null, mark: number | null) => {
    const source = BOOK_SOURCE[p.book];
    if (!source || !days.has(p.day)) return;
    if (closedTrade) {
      trades.push({ book: source, day: p.day, contract: p.contract, ticker: p.ticker, returnPct: closedTrade.pnlPct, pnlUsd: closedTrade.pnlUsd, closed: true });
      return;
    }
    if (mark != null && mark >= 0 && p.costUsd > 0) {
      const pnlUsd = round2(mark * 100 * p.qty - p.costUsd);
      trades.push({ book: source, day: p.day, contract: p.contract, ticker: p.ticker, returnPct: round2((pnlUsd / p.costUsd) * 100), pnlUsd, closed: false });
      return;
    }
    pending[source] += 1;
  };
  for (const p of open) push(p, null, p.lastMark?.value ?? null);
  for (const c of closed) push(c, { pnlUsd: c.pnlUsd, pnlPct: c.pnlPct }, null);
  return { trades, pending };
}

async function loadLedger(): Promise<{ positions: PaperPosition[]; closed: PaperClosed[] }> {
  const [positions, closed] = await kvGetMany<unknown>([K_POS, K_CLOSED]);
  return {
    positions: Array.isArray(positions) ? (positions as PaperPosition[]) : [],
    closed: Array.isArray(closed) ? (closed as PaperClosed[]) : [],
  };
}

async function writeStudyWeek(score: WeekScore): Promise<boolean> {
  try {
    const { mkdir, writeFile } = await import("fs/promises");
    const { join } = await import("path");
    const dir = join(process.cwd(), "study", "ai-trader-books");
    await mkdir(dir, { recursive: true });
    const payload = { ...score, studyWritten: true };
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    const md = renderWeekMd(payload);
    await writeFile(join(dir, `week-${score.weekEnd}.json`), json);
    await writeFile(join(dir, `week-${score.weekEnd}.md`), md);
    return true;
  } catch {
    return false;
  }
}

export type ScoreResult = { ran: boolean; reason: string; weekEnd?: string; winner?: WeekScore["winner"] };

/**
 * Friday after the close: score the week once. Safe to call from every paper tick;
 * it returns immediately except on Friday at or after 16:15 ET.
 */
export async function maybeScoreAiTraderWeek(
  now = new Date(),
  ledger?: { positions: PaperPosition[]; closed: PaperClosed[] },
): Promise<ScoreResult> {
  const day = tradingDateET(now);
  if (!isFridayAfterClose(day, etClock(now).minutes)) return { ran: false, reason: "not Friday after the close" };
  const week = weekEndingOn(day);
  if (!week) return { ran: false, reason: "not a Friday" };
  if (await kvGet(doneKey(week.weekEnd), { maxAgeMs: 5_000 })) return { ran: false, reason: `already scored week ${week.weekEnd}` };
  if (!(await kvSetNx(lockKey(week.weekEnd), now.toISOString(), 10 * 60))) return { ran: false, reason: "score already running" };
  try {
    const books = ledger ?? (await loadLedger());
    const { trades, pending } = tradesFromLedger(books.positions, books.closed, new Set(week.days));
    const decisions = await decisionBuckets(week.days, day);
    const score = buildWeekScore({ week, generatedAt: now.toISOString(), trades, pending, decisions });
    score.studyWritten = await writeStudyWeek(score);
    await kvSet(weekKey(week.weekEnd), score, { tier: "rare", ttlSec: 400 * 86400 });
    await kvSet(LATEST_KEY, score, { tier: "rare" });
    await kvSet(doneKey(week.weekEnd), { at: now.toISOString() }, { tier: "rare", ttlSec: 400 * 86400 });
    return { ran: true, reason: score.winnerReason, weekEnd: week.weekEnd, winner: score.winner };
  } catch (e) {
    return { ran: false, reason: e instanceof Error ? e.message.slice(0, 200) : "score failed" };
  }
}
