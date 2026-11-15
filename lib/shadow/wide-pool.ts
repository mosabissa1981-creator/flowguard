import "server-only";

import { grokWidePace, byScoreThenEarlier, studyBoostEnabled } from "@/lib/ai-trader-study-boost";
import { kvSetNx } from "@/lib/kv";
import { ledgerSpend, quietTestBatchGate } from "@/lib/llm-ledger";
import { liveTimeStopDate } from "@/lib/exit-plan";
import { issuerKey } from "@/lib/issuers";
import { rankAlerts } from "@/lib/scoring";
import { tradingDateET } from "@/lib/session";
import { getSessionTape } from "@/lib/session-tape";
import { etClock } from "@/lib/shadow/budget";
import { lessonsSystemPrompt, lessonsTestEnabled } from "@/lib/shadow/lessons-review";
import { callShadowLlm, parseJsonObject, reviewBatchCeiling, shadowLlmConfig } from "@/lib/shadow/llm";
import { loadDoc, saveDoc } from "@/lib/shadow/store";
import type { LlmUsageRecord, ShadowDay } from "@/lib/shadow/types";
import { fetchContractHistoric, hasUnusualWhalesKey } from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";
import { runAsUwJob, uwJobBudgetOk } from "@/lib/uw-usage";
import { gradeWide, selectWide, wideFactLine, type WideCandidate, type WideGrade, type WideJudgement } from "@/lib/shadow/wide-pool-core";

/**
 * TEST MODE ONLY — Grok "wide pool". Sends Grok + lessons the session-tape setups the live lists cut before the lessons
 * reviewer sees them (tiers in lib/shadow/wide-pool-core.ts), tagged "wide-pool" and stored in their OWN day doc
 * (kind "grok-wide"), so they are scored separately from the live finalists. Rides /api/shadow/tick (no new cron).
 *
 * OFF unless FLOWGUARD_GROK_WIDE=1 AND FLOWGUARD_LESSONS_TEST=1. Never touches the morning board, picks, premove,
 * ai-picks, pings, or Telegram, and never writes the shadow day doc (it only reads it to skip today's finalists).
 * The study boost may paper-fill this lane's takes. It still does not change live picks.
 *
 * Cost guards:
 *  - Grok: own ledger scope "grok-wide" with its own daily cap FLOWGUARD_GROK_WIDE_USD (default $1, hard max $3); never uses
 *    the shared shadow budget. ≤ FLOWGUARD_GROK_WIDE_MAX candidates/day (default 200, hard max 1000) in batches of 20;
 *    runs 10:00–14:30 ET, ≥ 45 min apart, ≤ 100 candidates per run (≤ 7 runs → ≤ 700/day).
 *  - Study boost (FLOWGUARD_AI_TRADER_STUDY_BOOST, default on through 2026-12-11): same window extended to 15:00 ET,
 *    ≥ 20 min apart, ≤ 80/run, default 600/day. Each batch also stops at the $3 quiet-test total. Higher-score, earlier
 *    rows go first. Set the flag to 0 to restore the pace above.
 *  - UW: the candidates come from the already-synced session tape with allowUw:false (0 flow calls). Grading costs one
 *    /option-contract/{id}/historic per candidate once its 2-session time stop has passed (≤ 60 per tick run, ≥ 20 min
 *    apart, ≤ 3 tries each), under the shared 35,000/day job stop (uwJobBudgetOk).
 */

const KIND = "grok-wide";
const BATCH = 20;
const GRADE_FROM_ET = 9 * 60 + 45;
const GRADE_PER_RUN = 60;
const GRADE_LOCK_SEC = 20 * 60;
const GRADE_LOOKBACK_DAYS = 10;
const GRADE_MAX_TRIES = 3;

export type WideDoc = {
  day: string;
  mode: "test";
  note: string;
  updatedAt: string;
  candidates: WideCandidate[];
  judgements: Record<string, WideJudgement>;
  grades: Record<string, WideGrade>;
  llm: { spendUsd: number; usage: LlmUsageRecord[]; lastRunAt: string | null; lastError?: string };
  uwGradeCalls: number;
};

export function grokWideEnabled(): boolean {
  return process.env.FLOWGUARD_GROK_WIDE === "1" && lessonsTestEnabled();
}

function envNum(name: string, def: number, max: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.min(v, max) : def;
}

export function grokWideLimits(now = new Date()) {
  const boost = studyBoostEnabled(process.env.FLOWGUARD_AI_TRADER_STUDY_BOOST, tradingDateET(now));
  const pace = grokWidePace(boost);
  return {
    usdCap: envNum("FLOWGUARD_GROK_WIDE_USD", pace.usdDefault, pace.usdHard),
    dailyMax: Math.floor(envNum("FLOWGUARD_GROK_WIDE_MAX", pace.dailyMaxDefault, pace.dailyMaxHard)),
    boost,
    perRun: pace.perRun,
    intervalMs: pace.intervalMs,
    fromEt: pace.fromEt,
    toEt: pace.toEt,
  };
}

function blank(day: string): WideDoc {
  return {
    day,
    mode: "test",
    note: "TEST MODE wide pool: Grok + lessons take/pass on setups the live lists cut. Study book only; never changes live picks, board, pings or Telegram.",
    updatedAt: new Date().toISOString(),
    candidates: [],
    judgements: {},
    grades: {},
    llm: { spendUsd: 0, usage: [], lastRunAt: null },
    uwGradeCalls: 0,
  };
}

export async function loadWideDay(day: string): Promise<WideDoc | null> {
  return loadDoc<WideDoc>(KIND, day, { fresh: true });
}

export const WIDE_RULE =
  "These candidates are a WIDE study pool: setups the live lists ranked below their cut (lanes=wide-pool+pool) or just under the score floor (wide-pool+near-miss), judged only so the desk learns.";

/** Parse one batch reply; enforce the module contract (≤ 3 takes, one per issuer, by confidence). Unreturned rows stay unjudged. */
export function parseBatch(text: string, batch: WideCandidate[], at: string): Record<string, WideJudgement> {
  const parsed = parseJsonObject<{ reviews?: Array<Record<string, unknown>> }>(text);
  const byKey = new Map(batch.map((c) => [c.contract, c]));
  const out: Record<string, WideJudgement> = {};
  for (const r of parsed?.reviews ?? []) {
    const contract = String(r.contract ?? "").trim();
    if (!byKey.has(contract)) continue;
    out[contract] = {
      judge: String(r.judge) === "take" ? "take" : "pass",
      confidence: Math.max(0, Math.min(100, Number(r.confidence) || 0)),
      why: String(r.why ?? "").slice(0, 200),
      at,
    };
  }
  const takes = Object.entries(out).filter(([, j]) => j.judge === "take").sort((a, b) => b[1].confidence - a[1].confidence);
  const issuers = new Set<string>();
  let kept = 0;
  for (const [k, j] of takes) {
    const iss = issuerKey(byKey.get(k)!.ticker);
    if (kept >= 3 || issuers.has(iss)) out[k] = { ...j, judge: "pass", why: `(over take cap) ${j.why}`.slice(0, 200) };
    else {
      kept += 1;
      issuers.add(iss);
    }
  }
  return out;
}

async function reviewStep(now: Date): Promise<string> {
  const limits = grokWideLimits(now);
  const c = etClock(now);
  if (!c.weekday || c.minutes < limits.fromEt || c.minutes > limits.toEt) {
    return limits.boost ? "review window 10:00–15:00 ET" : "review window 10:00–14:30 ET";
  }
  const cfg = shadowLlmConfig();
  if (!cfg) return "no LLM key";
  const day = tradingDateET(now);
  const doc = (await loadWideDay(day)) ?? blank(day);
  const last = doc.llm.lastRunAt ? Date.parse(doc.llm.lastRunAt) : 0;
  const gapMin = Math.round(limits.intervalMs / 60_000);
  if (last && now.getTime() - last < limits.intervalMs) return `throttled (≥ ${gapMin} min between wide runs)`;
  const { usdCap, dailyMax, boost, perRun } = limits;
  const spent = Math.max(doc.llm.spendUsd, await ledgerSpend("grok-wide", day).catch(() => doc.llm.spendUsd));
  if (spent >= usdCap) return `Grok wide budget $${usdCap.toFixed(2)} reached`;
  if (boost) {
    const gate = await quietTestBatchGate(day, "grok-wide", doc.llm.spendUsd, 0.01);
    if (!gate.ok) return gate.reason;
  }
  const room = Math.min(perRun, dailyMax - doc.candidates.length);
  if (room <= 0) return `daily cap ${dailyMax} candidates reached`;

  const tape = (await getSessionTape({ allowUw: false })).alerts;
  if (!tape.length) return "session tape empty";
  const shadow = await loadDoc<ShadowDay>("day", day);
  const exclude = new Set<string>([...(shadow?.candidates ?? []).map((x) => x.contract), ...doc.candidates.map((x) => x.contract)]);
  const issuerCounts: Record<string, number> = {};
  for (const x of doc.candidates) issuerCounts[issuerKey(x.ticker)] = (issuerCounts[issuerKey(x.ticker)] ?? 0) + 1;
  const picked = selectWide(rankAlerts(tape, { now }), { now, exclude, limit: room, issuerCounts });
  if (!picked.length) return "no new wide-pool candidates";
  if (boost) picked.sort((a, b) => byScoreThenEarlier({ score: a.score, at: a.printTimeUtc, contract: a.contract }, { score: b.score, at: b.printTimeUtc, contract: b.contract }));

  doc.candidates.push(...picked);
  doc.llm.lastRunAt = now.toISOString();
  doc.llm.lastError = undefined;
  doc.updatedAt = now.toISOString();
  await saveDoc(KIND, day, doc); // claim the slot before billing
  const system = lessonsSystemPrompt(WIDE_RULE);
  let judged = 0;
  let skippedForTotal = 0;
  const attempted = new Set<string>();
  for (let i = 0; i < picked.length; i += BATCH) {
    if (doc.llm.spendUsd >= usdCap) break;
    const batch = picked.slice(i, i + BATCH);
    const user = `As of ${now.toISOString()}. Candidates:\n${batch.map(wideFactLine).join("\n")}`;
    if (boost) {
      const observed = doc.llm.usage.reduce((max, u) => Math.max(max, u.costUsd), 0);
      const ceiling = reviewBatchCeiling(cfg.model, system, user, batch.length, observed, true);
      const gate = await quietTestBatchGate(day, "grok-wide", doc.llm.spendUsd, ceiling);
      if (!gate.ok) {
        doc.llm.lastError = gate.reason;
        skippedForTotal += picked.length - i;
        break;
      }
    }
    for (const row of batch) attempted.add(row.contract);
    try {
      const res = await callShadowLlm({ module: "lessons_review_wide", system, user }, "grok-wide");
      doc.llm.usage.push(res.usage);
      doc.llm.spendUsd = Math.round((doc.llm.spendUsd + res.usage.costUsd) * 10000) / 10000;
      const got = parseBatch(res.text, batch, new Date().toISOString());
      Object.assign(doc.judgements, got);
      judged += Object.keys(got).length;
    } catch (e) {
      doc.llm.lastError = `wide: ${(e instanceof Error ? e.message : String(e)).slice(0, 180)}`;
      break;
    }
  }
  if (boost) {
    const drop = new Set(picked.map((c) => c.contract).filter((k) => !attempted.has(k)));
    if (drop.size) doc.candidates = doc.candidates.filter((c) => !drop.has(c.contract));
  }
  doc.updatedAt = new Date().toISOString();
  await saveDoc(KIND, day, doc);
  const capBit = skippedForTotal ? `; skipped ${skippedForTotal} under the $3 test-mode total` : "";
  return `reviewed ${judged}/${picked.length} new wide-pool candidates ($${doc.llm.spendUsd.toFixed(4)} today)${capBit}`;
}

function priorDays(today: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${today}T12:00:00Z`);
  for (let i = 0; i < n; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function gradeStep(now: Date): Promise<{ note: string; calls: number }> {
  const c = etClock(now);
  if (!c.weekday || c.minutes < GRADE_FROM_ET) return { note: "grading after 9:45 ET", calls: 0 };
  const today = tradingDateET(now);
  const todo: Array<{ doc: WideDoc; cand: WideCandidate; stopDay: string }> = [];
  const docs: WideDoc[] = [];
  for (const day of priorDays(today, GRADE_LOOKBACK_DAYS)) {
    const doc = await loadWideDay(day);
    if (!doc) continue;
    docs.push(doc);
    for (const cand of doc.candidates) {
      if (!doc.judgements[cand.contract]) continue;
      const g = doc.grades[cand.contract];
      if (g && (g.status !== "pending" || g.tries >= GRADE_MAX_TRIES)) continue;
      const stopDay = liveTimeStopDate(day, cand.expiry);
      if (stopDay >= today) continue; // the time-stop session's daily bar must be final
      todo.push({ doc, cand, stopDay });
    }
  }
  if (!todo.length) return { note: "nothing to grade", calls: 0 };
  if (!(await kvSetNx("flowguard/grok-wide/grade-lock", now.toISOString(), GRADE_LOCK_SEC))) return { note: "grading throttled (≤ 1 run / 20 min)", calls: 0 };
  if (!(await hasUnusualWhalesKey()) || (await isUwBlocked())) return { note: "UW unavailable — grading skipped", calls: 0 };
  const batch = todo.slice(0, GRADE_PER_RUN);
  if (!(await uwJobBudgetOk(batch.length))) return { note: "UW daily budget near 35,000 — grading paused", calls: 0 };
  const pause = () => new Promise((r) => setTimeout(r, 250));
  let calls = 0;
  let graded = 0;
  for (const { doc, cand, stopDay } of batch) {
    const bars = await fetchContractHistoric(cand.contract, 10);
    calls += 1;
    doc.uwGradeCalls += 1;
    await pause();
    const r = gradeWide(
      cand,
      doc.day,
      stopDay,
      bars.map((b) => ({ date: b.date.slice(0, 10), open: b.open, high: b.high, low: b.low, close: b.last })),
    );
    const tries = (doc.grades[cand.contract]?.tries ?? 0) + 1;
    const status = r.status === "pending" && tries >= GRADE_MAX_TRIES ? "no-data" : r.status;
    doc.grades[cand.contract] = { ...r, status, timeStopDate: stopDay, checkedAt: now.toISOString(), tries };
    if (status === "graded") graded += 1;
  }
  for (const doc of docs) {
    doc.updatedAt = new Date().toISOString();
    await saveDoc(KIND, doc.day, doc);
  }
  return { note: `graded ${graded}/${batch.length} (${todo.length - batch.length} left)`, calls };
}

/** One wide-pool pass for /api/shadow/tick. Never throws into the tick (the step wrapper catches). */
export async function runGrokWide(opts: { now?: Date } = {}): Promise<{ note: string; uwCalls: number }> {
  const now = opts.now ?? new Date();
  if (!grokWideEnabled()) return { note: "off (FLOWGUARD_GROK_WIDE=1 + FLOWGUARD_LESSONS_TEST=1 needed)", uwCalls: 0 };
  const g = await runAsUwJob("grok-wide", () => gradeStep(now));
  // One heavy job per tick (keeps the shared tick well under its 300 s limit): a grading run defers the review to the next tick.
  const r = g.calls > 0 ? "review deferred to next tick (graded this tick)" : await reviewStep(now);
  return { note: `${r}; ${g.note}`, uwCalls: g.calls };
}
