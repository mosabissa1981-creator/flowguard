import "server-only";

import { ledgerSpend, TEST_MODE_GROK_DAY_CAP_USD, testModeGrokBatchFits, testModeGrokSpend } from "@/lib/llm-ledger";
import { tradingDateET } from "@/lib/session";
import { etClock } from "@/lib/shadow/budget";
import { dexView, gexContextLine, gexView, nearestWeeklyExpiry, parseDexStrikes, targetSpotFor, type DexStrike, type GexContext } from "@/lib/shadow/gex-context-core";
import { GROK_GEX_LESSONS } from "@/lib/shadow/grok-gex-lessons";
import { lessonsSystemPrompt } from "@/lib/shadow/lessons-review";
import { callShadowLlm, estimateCost, shadowLlmConfig } from "@/lib/shadow/llm";
import { parseGexStrikes, type GexStrike } from "@/lib/shadow/signals-core";
import { loadDoc, saveDoc } from "@/lib/shadow/store";
import type { LlmUsageRecord } from "@/lib/shadow/types";
import { grokWideEnabled, loadWideDay, parseBatch, WIDE_RULE, type WideDoc } from "@/lib/shadow/wide-pool";
import { wideFactLine, type WideGrade, type WideJudgement } from "@/lib/shadow/wide-pool-core";
import { fetchGexByStrike, fetchGexByStrikeExpiry, hasUnusualWhalesKey } from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";
import { runAsUwJob, uwJobBudgetOk } from "@/lib/uw-usage";

/**
 * TEST MODE ONLY — "GEX/DEX Grok" shadow lane (lane id grok-gex-dex). A second Grok + lessons reviewer that sees the SAME wide-pool candidates the
 * current Grok wide reviewer already judged, plus a GEX context block (flip, walls, red bar, net sign; all-expiry and
 * nearest-weekly), a DEX line (live context only)  and a short GEX lessons section. Same output schema (take/pass + confidence + why), stored in its own
 * day doc (kind "grok-gex-dex") so the Friday report can compare GEX Grok vs current Grok vs rules on identical rows.
 * Rides /api/shadow/tick right after the wide step (no new cron).
 *
 * ON unless FLOWGUARD_GROK_GEX_DEX=0, and only when the wide lane is on (FLOWGUARD_GROK_WIDE=1 + FLOWGUARD_LESSONS_TEST=1). Never touches
 * morning / picks / premove / ai-picks / board / paper / pings / Telegram, the shadow day doc or the wide doc (read only).
 *
 * Cost guards:
 *  - Grok: own ledger scope "grok-gex-dex", daily cap FLOWGUARD_GROK_GEX_DEX_USD (default $0.75, hard max $1);
 *    plus the owner's $3/day total across quiet test-mode ledgers (shadow + grok-wide + grok-gex-dex), checked before each batch.
 *    ≤ FLOWGUARD_GROK_GEX_DEX_MAX candidates/day (default 300, hard max 500), ≤ 60 per run in batches of 20, ≥ 40 min apart.
 *  - UW: ≤ 3 calls per new ticker-day (all-expiry strike incl. DEX, nearest-weekly strike-expiry, prior-day strike for the DEX change; 12h cache) and the computed
 *    rows are kept in the doc, ≤ 40 new tickers per run, under the shared 35,000/day job stop. Grading = 0 calls
 *    (reuses the wide doc's grades).
 */

const KIND = "grok-gex-dex";
const BATCH = 20;
const PER_RUN = 60;
const NEW_TICKERS_PER_RUN = 40;
const RUN_FROM_ET = 10 * 60;
const RUN_TO_ET = 15 * 60;
const RUN_MIN_INTERVAL_MS = 40 * 60_000;
/** Do not start in the same few minutes the wide step just billed (keeps one heavy LLM job per tick). */
const WIDE_COOLDOWN_MS = 4 * 60_000;

export type GexDoc = {
  day: string;
  mode: "test";
  lane: "grok-gex-dex";
  note: string;
  updatedAt: string;
  /** Contracts (from the wide doc) this lane has sent to Grok. */
  reviewed: string[];
  context: Record<string, GexContext | null>;
  judgements: Record<string, WideJudgement>;
  /** ticker → parsed GEX rows ({all, weekly}); kept so later runs reuse them (0 extra UW calls). */
  gexRows: Record<string, { all: GexStrike[]; weekly: GexStrike[]; dex?: DexStrike[]; dexPrior?: DexStrike[] }>;
  llm: { spendUsd: number; usage: LlmUsageRecord[]; lastRunAt: string | null; lastError?: string };
  uwCalls: number;
};

export function grokGexDexEnabled(): boolean {
  // Default on. Explicit FLOWGUARD_GROK_GEX_DEX=0 turns the lane off. The wide lane stays its own switch.
  return process.env.FLOWGUARD_GROK_GEX_DEX?.trim() !== "0" && grokWideEnabled();
}

function envNum(name: string, def: number, max: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.min(v, max) : def;
}

export function grokGexDexLimits() {
  return { usdCap: envNum("FLOWGUARD_GROK_GEX_DEX_USD", 0.75, 1), dailyMax: Math.floor(envNum("FLOWGUARD_GROK_GEX_DEX_MAX", 300, 500)) };
}

function blank(day: string): GexDoc {
  return {
    day,
    mode: "test",
    lane: "grok-gex-dex",
    note: "TEST MODE GEX Grok lane: Grok + lessons + GEX context take/pass on the wide-pool rows the current Grok wide reviewer judged. Study book only; never changes live picks, board, pings or Telegram.",
    updatedAt: new Date().toISOString(),
    reviewed: [],
    context: {},
    judgements: {},
    gexRows: {},
    llm: { spendUsd: 0, usage: [], lastRunAt: null },
    uwCalls: 0,
  };
}

export async function loadGexDexDay(day: string): Promise<GexDoc | null> {
  return loadDoc<GexDoc>(KIND, day, { fresh: true });
}

function priorWeekday(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

const GEX_RULE =
  "Each candidate also has a GEX block (dealer gamma: flip, call/put walls, biggest negative bar, net sign; all expiries and nearest weekly) and a DEX line (dealer delta exposure: net sign/size, biggest +/- strikes, change vs prior day). " +
  "GEX was weak in the 2-year test and DEX is untested (no history): context only, never take or pass on GEX/DEX alone.";

function systemPrompt(): string {
  return `${lessonsSystemPrompt(`${WIDE_RULE} ${GEX_RULE}`)}\n\n${GROK_GEX_LESSONS}`;
}

async function reviewStep(now: Date): Promise<{ note: string; uwCalls: number }> {
  const c = etClock(now);
  if (!c.weekday || c.minutes < RUN_FROM_ET || c.minutes > RUN_TO_ET) return { note: "review window 10:00–15:00 ET", uwCalls: 0 };
  if (!shadowLlmConfig()) return { note: "no LLM key", uwCalls: 0 };
  const day = tradingDateET(now);
  const wide: WideDoc | null = await loadWideDay(day);
  if (!wide) return { note: "no wide doc yet", uwCalls: 0 };
  const wideLast = wide.llm.lastRunAt ? Date.parse(wide.llm.lastRunAt) : 0;
  if (wideLast && now.getTime() - wideLast < WIDE_COOLDOWN_MS) return { note: "wide step just ran — next tick", uwCalls: 0 };
  const doc = (await loadGexDexDay(day)) ?? blank(day);
  const last = doc.llm.lastRunAt ? Date.parse(doc.llm.lastRunAt) : 0;
  if (last && now.getTime() - last < RUN_MIN_INTERVAL_MS) return { note: "throttled (≥ 40 min between GEX/DEX runs)", uwCalls: 0 };
  const { usdCap, dailyMax } = grokGexDexLimits();
  const spent = Math.max(doc.llm.spendUsd, await ledgerSpend("grok-gex-dex", day).catch(() => doc.llm.spendUsd));
  if (spent >= usdCap) return { note: `GEX Grok budget $${usdCap.toFixed(2)} reached`, uwCalls: 0 };
  let quietNow: number;
  try {
    quietNow = await testModeGrokSpend(day, doc.llm.spendUsd);
  } catch {
    return { note: "test-mode Grok total unreadable — batch skipped", uwCalls: 0 };
  }
  if (quietNow >= TEST_MODE_GROK_DAY_CAP_USD) return { note: `test-mode Grok total $${TEST_MODE_GROK_DAY_CAP_USD.toFixed(2)} reached`, uwCalls: 0 };
  const room = Math.min(PER_RUN, dailyMax - doc.reviewed.length);
  if (room <= 0) return { note: `daily cap ${dailyMax} candidates reached`, uwCalls: 0 };

  // Same rows the current Grok judged (so the comparison is like for like), oldest first.
  const done = new Set(doc.reviewed);
  let todo = wide.candidates.filter((x) => wide.judgements[x.contract] && !done.has(x.contract));
  if (!todo.length) return { note: "no new judged wide rows", uwCalls: 0 };

  // GEX rows per ticker (reuse stored rows; ≤ NEW_TICKERS_PER_RUN new tickers, 2 UW calls each).
  const uwOk = (await hasUnusualWhalesKey()) && !(await isUwBlocked());
  const newTickers = [...new Set(todo.map((x) => x.ticker))].filter((t) => !doc.gexRows[t]).slice(0, NEW_TICKERS_PER_RUN);
  let uwCalls = 0;
  if (uwOk && newTickers.length && (await uwJobBudgetOk(newTickers.length * 3))) {
    const weekly = nearestWeeklyExpiry(day);
    for (const t of newTickers) {
      try {
        // DEX rides the same greek-exposure rows (call_delta / put_delta): 0 extra calls. Prior day = 1 cached call.
        const raw = await fetchGexByStrike(t, day);
        const wk = parseGexStrikes(await fetchGexByStrikeExpiry(t, day, weekly));
        const prior = parseDexStrikes(await fetchGexByStrike(t, priorWeekday(day)).catch(() => []));
        uwCalls += 3;
        doc.gexRows[t] = { all: parseGexStrikes(raw), weekly: wk, dex: parseDexStrikes(raw), dexPrior: prior };
      } catch {
        uwCalls += 1;
      }
    }
  }
  // Only rows whose ticker now has GEX (or UW is unavailable: send with "GEX: unavailable" rather than stall).
  todo = todo.filter((x) => doc.gexRows[x.ticker] || !uwOk).slice(0, room);
  if (!todo.length) {
    doc.uwCalls += uwCalls;
    await saveDoc(KIND, day, doc);
    return { note: "waiting for GEX rows", uwCalls };
  }

  const weeklyExpiry = nearestWeeklyExpiry(day);
  for (const x of todo) {
    const rows = doc.gexRows[x.ticker];
    const targetSpot = targetSpotFor(x);
    doc.context[x.contract] = rows
      ? {
          targetSpot,
          targetMovePct: targetSpot == null ? null : Math.round((targetSpot / x.underlying - 1) * 1000) / 10,
          all: gexView(rows.all, x.underlying, x.side, targetSpot),
          weekly: gexView(rows.weekly, x.underlying, x.side, targetSpot),
          weeklyExpiry,
          dex: rows.dex ? dexView(rows.dex, x.underlying, rows.dexPrior ?? null) : null,
        }
      : null;
  }
  doc.reviewed.push(...todo.map((x) => x.contract));
  doc.uwCalls += uwCalls;
  doc.llm.lastRunAt = now.toISOString();
  doc.llm.lastError = undefined;
  doc.updatedAt = now.toISOString();
  await saveDoc(KIND, day, doc); // claim the slot before billing

  const system = systemPrompt();
  let judged = 0;
  let skippedForTotal = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    if (doc.llm.spendUsd >= usdCap) break;
    const batch = todo.slice(i, i + BATCH);
    const lines = batch.map((x) => `${wideFactLine(x)}\n${gexContextLine(doc.context[x.contract], x.side)}`).join("\n");
    const user = `As of ${now.toISOString()}. Candidates:\n${lines}`;
    const observed = doc.llm.usage.reduce((max, u) => Math.max(max, u.costUsd), 0);
    const ceiling = Math.max(gexDexBatchUsdCeiling(system, user, batch.length), observed);
    let quietSpend: number;
    try {
      quietSpend = await testModeGrokSpend(day, doc.llm.spendUsd);
    } catch {
      doc.llm.lastError = "test-mode Grok total unreadable — batch skipped";
      skippedForTotal += todo.length - i;
      break;
    }
    if (!testModeGrokBatchFits(quietSpend, ceiling)) {
      doc.llm.lastError = `test-mode Grok total cap $${TEST_MODE_GROK_DAY_CAP_USD.toFixed(2)} (spent $${quietSpend.toFixed(2)}, batch ~$${ceiling.toFixed(4)})`;
      skippedForTotal += batch.length;
      continue;
    }
    try {
      const res = await callShadowLlm({ module: "lessons_review_gex_dex", system, user }, "grok-gex-dex");
      doc.llm.usage.push(res.usage);
      doc.llm.spendUsd = Math.round((doc.llm.spendUsd + res.usage.costUsd) * 10000) / 10000;
      const got = parseBatch(res.text, batch, new Date().toISOString());
      Object.assign(doc.judgements, got);
      judged += Object.keys(got).length;
    } catch (e) {
      doc.llm.lastError = `gex: ${(e instanceof Error ? e.message : String(e)).slice(0, 180)}`;
      break;
    }
  }
  doc.updatedAt = new Date().toISOString();
  await saveDoc(KIND, day, doc);
  const capBit = skippedForTotal ? `; skipped ${skippedForTotal} under the $${TEST_MODE_GROK_DAY_CAP_USD.toFixed(2)} test-mode total` : "";
  return { note: `GEX/DEX-reviewed ${judged}/${todo.length} rows ($${doc.llm.spendUsd.toFixed(4)} today, ${uwCalls} UW)${capBit}`, uwCalls };
}

/** Pre-call ceiling for one batch. Provider cost is known only after the call, so the $3 total is checked against this upper bound. */
function gexDexBatchUsdCeiling(system: string, user: string, rows: number): number {
  const model = shadowLlmConfig()?.model ?? "grok-4.7";
  const inTok = Math.ceil((system.length + user.length) / 3);
  const outTok = 1500 + Math.max(rows, 1) * 250;
  return Math.round(estimateCost(model, inTok, 0, outTok, 0, 0) * 10000) / 10000;
}

/** One GEX-lane pass for /api/shadow/tick. Never throws into the tick (the step wrapper catches). */
export async function runGrokGexDex(opts: { now?: Date } = {}): Promise<{ note: string; uwCalls: number }> {
  const now = opts.now ?? new Date();
  if (!grokGexDexEnabled()) return { note: "off (wide lane off, or FLOWGUARD_GROK_GEX_DEX=0)", uwCalls: 0 };
  return runAsUwJob("grok-gex-dex", () => reviewStep(now));
}

type LaneStats = { takes: number; passes: number; takeW: number; takeL: number; takeF: number; takeAvgRet: number | null; passAvgRet: number | null; graded: number };

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
 * Study-book view for one day: GEX Grok vs current Grok vs rules on the SAME rows (the ones this lane reviewed).
 * "rules" = take every row (all wide rows already pass the plain rules). Grades come from the wide doc (+30/-25/2-session plan).
 */
export async function gexDexStudyView(day: string) {
  const [doc, wide] = await Promise.all([loadGexDexDay(day), loadWideDay(day)]);
  if (!doc) return null;
  const grades = wide?.grades ?? {};
  const rows = doc.reviewed.filter((k) => doc.judgements[k]);
  const byContract = new Map((wide?.candidates ?? []).map((x) => [x.contract, x]));
  return {
    day,
    mode: "test",
    lane: "grok-gex-dex",
    note: doc.note,
    updatedAt: doc.updatedAt,
    limits: grokGexDexLimits(),
    llm: { spendUsd: doc.llm.spendUsd, calls: doc.llm.usage.length, lastRunAt: doc.llm.lastRunAt, lastError: doc.llm.lastError ?? null },
    uwCalls: doc.uwCalls,
    compare: {
      rows: rows.length,
      gexDexGrok: laneStats(rows, (k) => doc.judgements[k]?.judge ?? null, grades),
      grok: laneStats(rows, (k) => wide?.judgements[k]?.judge ?? null, grades),
      rules: laneStats(rows, () => "take", grades),
      agree: rows.filter((k) => wide?.judgements[k] && wide.judgements[k].judge === doc.judgements[k].judge).length,
    },
    rows: rows.map((k) => ({
      contract: k,
      candidate: byContract.get(k) ?? null,
      gex: doc.context[k] ?? null,
      gexDexGrok: doc.judgements[k],
      grok: wide?.judgements[k] ?? null,
      rules: "take" as const,
      grade: grades[k] ?? null,
    })),
  };
}
