import "server-only";

import { ledgerSpend, TEST_MODE_GROK_DAY_CAP_USD, testModeGrokBatchFits, testModeGrokSpend } from "@/lib/llm-ledger";
import { tradingDateET } from "@/lib/session";
import { etClock } from "@/lib/shadow/budget";
import { lessonsSystemPrompt } from "@/lib/shadow/lessons-review";
import { anthropicLlmConfig, callShadowLlm, estimateCost } from "@/lib/shadow/llm";
import { loadDoc, saveDoc } from "@/lib/shadow/store";
import type { LlmUsageRecord } from "@/lib/shadow/types";
import { grokWideEnabled, loadWideDay, parseBatch, WIDE_RULE, type WideDoc } from "@/lib/shadow/wide-pool";
import { wideFactLine, type WideGrade, type WideJudgement } from "@/lib/shadow/wide-pool-core";

/**
 * TEST MODE ONLY — Claude second-opinion lane (lane id claude-second).
 * Sees the SAME wide-pool candidates + lessons prompt the current Grok wide reviewer already judged
 * (no GEX/DEX extras — fair provider comparison). Own day doc (kind "claude-second") so the study book /
 * Friday score can compare Claude vs current Grok vs rules on identical rows.
 * Rides /api/shadow/tick after the wide step (no new cron).
 *
 * ON unless FLOWGUARD_CLAUDE_SECOND=0, and only when the wide lane is on (FLOWGUARD_GROK_WIDE=1 +
 * FLOWGUARD_LESSONS_TEST=1) and ANTHROPIC_API_KEY is set. Never touches morning / picks / premove /
 * ai-picks / board / paper / pings / Telegram, the shadow day doc, or the wide doc (read only).
 * Uses ANTHROPIC_API_KEY via anthropicLlmConfig(); LLM_API_KEY / Grok stays primary for all other lanes.
 *
 * Cost guards:
 *  - Claude: own ledger scope "claude-second", daily cap FLOWGUARD_CLAUDE_SECOND_USD (default $0.75, hard max $1);
 *    plus the owner's $3/day total across quiet test-mode ledgers (shadow + grok-wide + grok-gex-dex + claude-second).
 *    ≤ FLOWGUARD_CLAUDE_SECOND_MAX candidates/day (default 300, hard max 500), ≤ 60 per run in batches of 20, ≥ 40 min apart.
 *  - UW: 0 calls (reuses the wide doc's candidates / grades).
 */

const KIND = "claude-second";
const BATCH = 20;
const PER_RUN = 60;
const RUN_FROM_ET = 10 * 60;
const RUN_TO_ET = 15 * 60;
const RUN_MIN_INTERVAL_MS = 40 * 60_000;
/** Do not start in the same few minutes the wide step just billed (keeps one heavy LLM job per tick). */
const WIDE_COOLDOWN_MS = 4 * 60_000;

export type ClaudeSecondDoc = {
  day: string;
  mode: "test";
  lane: "claude-second";
  note: string;
  updatedAt: string;
  /** Contracts (from the wide doc) this lane has sent to Claude. */
  reviewed: string[];
  judgements: Record<string, WideJudgement>;
  llm: { spendUsd: number; usage: LlmUsageRecord[]; lastRunAt: string | null; lastError?: string };
};

export function claudeSecondEnabled(): boolean {
  // Default on when the wide lane is on and an Anthropic key is present. Explicit FLOWGUARD_CLAUDE_SECOND=0 turns it off.
  return process.env.FLOWGUARD_CLAUDE_SECOND?.trim() !== "0" && grokWideEnabled() && Boolean(anthropicLlmConfig());
}

function envNum(name: string, def: number, max: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.min(v, max) : def;
}

export function claudeSecondLimits() {
  return {
    usdCap: envNum("FLOWGUARD_CLAUDE_SECOND_USD", 0.75, 1),
    dailyMax: Math.floor(envNum("FLOWGUARD_CLAUDE_SECOND_MAX", 300, 500)),
  };
}

function blank(day: string): ClaudeSecondDoc {
  return {
    day,
    mode: "test",
    lane: "claude-second",
    note: "TEST MODE Claude second-opinion lane: Claude + lessons take/pass on the wide-pool rows the current Grok wide reviewer judged. Same inputs as Grok (no GEX/DEX). Study book only; never changes live picks, board, pings or Telegram.",
    updatedAt: new Date().toISOString(),
    reviewed: [],
    judgements: {},
    llm: { spendUsd: 0, usage: [], lastRunAt: null },
  };
}

export async function loadClaudeSecondDay(day: string): Promise<ClaudeSecondDoc | null> {
  return loadDoc<ClaudeSecondDoc>(KIND, day, { fresh: true });
}

async function reviewStep(now: Date): Promise<{ note: string; uwCalls: number }> {
  const c = etClock(now);
  if (!c.weekday || c.minutes < RUN_FROM_ET || c.minutes > RUN_TO_ET) return { note: "review window 10:00–15:00 ET", uwCalls: 0 };
  const cfg = anthropicLlmConfig();
  if (!cfg) return { note: "no ANTHROPIC_API_KEY", uwCalls: 0 };
  const day = tradingDateET(now);
  const wide: WideDoc | null = await loadWideDay(day);
  if (!wide) return { note: "no wide doc yet", uwCalls: 0 };
  const wideLast = wide.llm.lastRunAt ? Date.parse(wide.llm.lastRunAt) : 0;
  if (wideLast && now.getTime() - wideLast < WIDE_COOLDOWN_MS) return { note: "wide step just ran — next tick", uwCalls: 0 };
  const doc = (await loadClaudeSecondDay(day)) ?? blank(day);
  const last = doc.llm.lastRunAt ? Date.parse(doc.llm.lastRunAt) : 0;
  if (last && now.getTime() - last < RUN_MIN_INTERVAL_MS) return { note: "throttled (≥ 40 min between Claude runs)", uwCalls: 0 };
  const { usdCap, dailyMax } = claudeSecondLimits();
  const spent = Math.max(doc.llm.spendUsd, await ledgerSpend("claude-second", day).catch(() => doc.llm.spendUsd));
  if (spent >= usdCap) return { note: `Claude second budget $${usdCap.toFixed(2)} reached`, uwCalls: 0 };
  let quietNow: number;
  try {
    quietNow = await testModeGrokSpend(day, { "claude-second": doc.llm.spendUsd });
  } catch {
    return { note: "test-mode AI total unreadable — batch skipped", uwCalls: 0 };
  }
  if (quietNow >= TEST_MODE_GROK_DAY_CAP_USD) return { note: `test-mode AI total $${TEST_MODE_GROK_DAY_CAP_USD.toFixed(2)} reached`, uwCalls: 0 };
  const room = Math.min(PER_RUN, dailyMax - doc.reviewed.length);
  if (room <= 0) return { note: `daily cap ${dailyMax} candidates reached`, uwCalls: 0 };

  // Same rows the current Grok judged (so the comparison is like for like), oldest first.
  const done = new Set(doc.reviewed);
  const todo = wide.candidates.filter((x) => wide.judgements[x.contract] && !done.has(x.contract)).slice(0, room);
  if (!todo.length) return { note: "no new judged wide rows", uwCalls: 0 };

  doc.reviewed.push(...todo.map((x) => x.contract));
  doc.llm.lastRunAt = now.toISOString();
  doc.llm.lastError = undefined;
  doc.updatedAt = now.toISOString();
  await saveDoc(KIND, day, doc); // claim the slot before billing

  const system = lessonsSystemPrompt(WIDE_RULE);
  let judged = 0;
  let skippedForTotal = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    if (doc.llm.spendUsd >= usdCap) break;
    const batch = todo.slice(i, i + BATCH);
    const lines = batch.map((x) => wideFactLine(x)).join("\n");
    const user = `As of ${now.toISOString()}. Candidates:\n${lines}`;
    const observed = doc.llm.usage.reduce((max, u) => Math.max(max, u.costUsd), 0);
    const ceiling = Math.max(claudeBatchUsdCeiling(system, user, batch.length, cfg.model), observed);
    let quietSpend: number;
    try {
      quietSpend = await testModeGrokSpend(day, { "claude-second": doc.llm.spendUsd });
    } catch {
      doc.llm.lastError = "test-mode AI total unreadable — batch skipped";
      skippedForTotal += todo.length - i;
      break;
    }
    if (!testModeGrokBatchFits(quietSpend, ceiling)) {
      doc.llm.lastError = `test-mode AI total cap $${TEST_MODE_GROK_DAY_CAP_USD.toFixed(2)} (spent $${quietSpend.toFixed(2)}, batch ~$${ceiling.toFixed(4)})`;
      skippedForTotal += batch.length;
      continue;
    }
    try {
      const res = await callShadowLlm(
        { module: "lessons_review_claude_second", system, user, model: cfg.model, cfg },
        "claude-second",
      );
      doc.llm.usage.push(res.usage);
      doc.llm.spendUsd = Math.round((doc.llm.spendUsd + res.usage.costUsd) * 10000) / 10000;
      const got = parseBatch(res.text, batch, new Date().toISOString());
      Object.assign(doc.judgements, got);
      judged += Object.keys(got).length;
    } catch (e) {
      doc.llm.lastError = `claude: ${(e instanceof Error ? e.message : String(e)).slice(0, 180)}`;
      break;
    }
  }
  doc.updatedAt = new Date().toISOString();
  await saveDoc(KIND, day, doc);
  const capBit = skippedForTotal ? `; skipped ${skippedForTotal} under the $${TEST_MODE_GROK_DAY_CAP_USD.toFixed(2)} test-mode total` : "";
  return { note: `Claude-reviewed ${judged}/${todo.length} rows ($${doc.llm.spendUsd.toFixed(4)} today)${capBit}`, uwCalls: 0 };
}

/** Pre-call ceiling for one batch. Provider cost is known only after the call, so the $3 total is checked against this upper bound. */
function claudeBatchUsdCeiling(system: string, user: string, rows: number, model: string): number {
  const inTok = Math.ceil((system.length + user.length) / 3);
  const outTok = 1500 + Math.max(rows, 1) * 250;
  return Math.round(estimateCost(model, inTok, 0, outTok, 0, 0) * 10000) / 10000;
}

/** One Claude-lane pass for /api/shadow/tick. Never throws into the tick (the step wrapper catches). */
export async function runClaudeSecond(opts: { now?: Date } = {}): Promise<{ note: string; uwCalls: number }> {
  const now = opts.now ?? new Date();
  if (!claudeSecondEnabled()) return { note: "off (wide lane off, no ANTHROPIC_API_KEY, or FLOWGUARD_CLAUDE_SECOND=0)", uwCalls: 0 };
  return reviewStep(now);
}

type LaneStats = {
  takes: number;
  passes: number;
  takeW: number;
  takeL: number;
  takeF: number;
  takeAvgRet: number | null;
  passAvgRet: number | null;
  graded: number;
};

function laneStats(rows: string[], judge: (k: string) => "take" | "pass" | null, grades: Record<string, WideGrade>): LaneStats {
  const s: LaneStats = { takes: 0, passes: 0, takeW: 0, takeL: 0, takeF: 0, takeAvgRet: null, passAvgRet: null, graded: 0 };
  const tr: number[] = [];
  const pr: number[] = [];
  for (const k of rows) {
    const j = judge(k);
    if (!j) continue;
    if (j === "take") s.takes += 1;
    else s.passes += 1;
    const g = grades[k];
    if (g?.status !== "graded" || g.ret == null) continue;
    s.graded += 1;
    if (j === "take") {
      tr.push(g.ret);
      if (g.how === "target" || g.how === "target_gap") s.takeW += 1;
      else if (g.how === "stop" || g.how === "stop_gap") s.takeL += 1;
      else s.takeF += 1;
    } else pr.push(g.ret);
  }
  const avg = (a: number[]) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
  s.takeAvgRet = avg(tr);
  s.passAvgRet = avg(pr);
  return s;
}

/**
 * Study-book view for one day: Claude vs current Grok vs rules on the SAME rows (the ones this lane reviewed).
 * Grades come from the wide doc (+30/-25/2-session plan).
 */
export async function claudeSecondStudyView(day: string) {
  const [doc, wide] = await Promise.all([loadClaudeSecondDay(day), loadWideDay(day)]);
  if (!doc) return null;
  const grades = wide?.grades ?? {};
  const rows = doc.reviewed.filter((k) => doc.judgements[k]);
  const byContract = new Map((wide?.candidates ?? []).map((x) => [x.contract, x]));
  return {
    day,
    mode: "test",
    lane: "claude-second",
    note: doc.note,
    updatedAt: doc.updatedAt,
    limits: claudeSecondLimits(),
    llm: {
      spendUsd: doc.llm.spendUsd,
      calls: doc.llm.usage.length,
      lastRunAt: doc.llm.lastRunAt,
      lastError: doc.llm.lastError ?? null,
      model: anthropicLlmConfig()?.model ?? null,
    },
    uwCalls: 0,
    compare: {
      rows: rows.length,
      claude: laneStats(rows, (k) => doc.judgements[k]?.judge ?? null, grades),
      grok: laneStats(rows, (k) => wide?.judgements[k]?.judge ?? null, grades),
      rules: laneStats(rows, () => "take", grades),
      agree: rows.filter((k) => wide?.judgements[k] && wide.judgements[k].judge === doc.judgements[k].judge).length,
    },
    rows: rows.map((k) => ({
      contract: k,
      candidate: byContract.get(k) ?? null,
      claude: doc.judgements[k],
      grok: wide?.judgements[k] ?? null,
      rules: "take" as const,
      grade: grades[k] ?? null,
    })),
  };
}
