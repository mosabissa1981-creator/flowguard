import "server-only";

import { LANES, loadBook as loadLaneBook } from "@/lib/lanes";
import { loadPutsBook } from "@/lib/puts";
import { loadRegimeSafe } from "@/lib/regime";
import { tradingDateET } from "@/lib/session";
import { budgetLeft, etClock } from "@/lib/shadow/budget";
import { callShadowLlm, parseJsonObject, shadowLlmConfig } from "@/lib/shadow/llm";
import { loadDoc, persistenceMode, saveDoc } from "@/lib/shadow/store";
import type { LlmUsageRecord } from "@/lib/shadow/types";

/**
 * Shadow debate for TEST-lane picks (Puts lane + the six setup lanes). Direction-aware bull/bear/macro + judge
 * → final TAKE / SKIP per logged pick. Shadow only: never changes lane picks or logging.
 *
 * Cost guard: only newly logged picks (not yet judged today) are sent, batched into ONE call per refresh;
 * ≥ 30 min between calls, market hours only, and the shared shadow daily budget (SHADOW_LLM_DAILY_USD, default $1;
 * this module's spend is counted in it via budget.ts).
 * Stored per day at flowguard/shadow/lanedebate-YYYY-MM-DD.json.
 */

const KIND = "lanedebate";
const MIN_INTERVAL_MS = 30 * 60_000;
const ERROR_BACKOFF_MS = 10 * 60_000;
const FROM_ET = 9 * 60 + 30;
const TO_ET = 16 * 60 + 15;
const MAX_BATCH = 12;

export type LaneDebateVerdict = {
  key: string;
  lane: string;
  side: "call" | "put";
  contract: string;
  ticker: string;
  /** Case FOR the trade working (for puts: the case for the drop). */
  bull: string;
  /** Case AGAINST the trade (for puts: why the drop fails / squeeze). */
  bear: string;
  macro: string;
  verdict: "take" | "skip";
  confidence: number;
  why: string;
  at: string;
};

export type LaneDebateDoc = {
  day: string;
  mode: "shadow";
  note: string;
  updatedAt: string;
  llm: {
    status: "idle" | "ok" | "no-key" | "throttled" | "budget" | "off-hours" | "error";
    lastRunAt: string | null;
    nextAllowedAt: string | null;
    spendUsd: number;
    usage: LlmUsageRecord[];
    lastError?: string;
  };
  verdicts: Record<string, LaneDebateVerdict>;
  pending: string[];
};

type LanePick = {
  lane: string;
  side: "call" | "put";
  contract: string;
  ticker: string;
  strike: number;
  expiry: string;
  dte: number;
  entry: number;
  underlying: number;
  otmPct: number;
  askSharePct: number;
  volOi: number;
  premiumUsd: number;
  reasons: string[];
  timeStopSessions: number;
};

function blank(day: string): LaneDebateDoc {
  return {
    day,
    mode: "shadow",
    note: "Shadow debate on TEST-lane picks (Puts + setup lanes). Logged for the study book only; never changes lane picks.",
    updatedAt: new Date().toISOString(),
    llm: { status: "idle", lastRunAt: null, nextAllowedAt: null, spendUsd: 0, usage: [] },
    verdicts: {},
    pending: [],
  };
}

export async function loadLaneDebate(day: string): Promise<LaneDebateDoc | null> {
  return loadDoc<LaneDebateDoc>(KIND, day, { fresh: true });
}

/** Spend for the shared daily budget (budget.ts). */
export async function laneDebateSpend(day: string): Promise<number> {
  return (await loadDoc<LaneDebateDoc>(KIND, day))?.llm.spendUsd ?? 0;
}

async function todaysPicks(day: string): Promise<LanePick[]> {
  const out: LanePick[] = [];
  const puts = await loadPutsBook(true).catch(() => null);
  for (const e of puts?.entries ?? []) {
    if (e.day !== day) continue;
    out.push({
      lane: "puts",
      side: "put",
      contract: e.contract,
      ticker: e.ticker,
      strike: e.strike,
      expiry: e.expiry,
      dte: e.dte,
      entry: e.entry,
      underlying: e.underlying,
      otmPct: e.moneynessPct,
      askSharePct: e.askSharePct,
      volOi: e.volOi,
      premiumUsd: e.premiumUsd,
      reasons: [...e.reasons, ...e.confirmations.map((c) => `confirm: ${c}`)],
      timeStopSessions: e.exitPlan.timeStopSessions,
    });
  }
  for (const lane of LANES) {
    const book = await loadLaneBook(lane.id).catch(() => null);
    for (const e of book?.entries ?? []) {
      if (e.day !== day) continue;
      out.push({
        lane: lane.id,
        side: e.side,
        contract: e.contract,
        ticker: e.ticker,
        strike: e.strike,
        expiry: e.expiry,
        dte: e.dte,
        entry: e.entry,
        underlying: e.underlying,
        otmPct: e.otmPct,
        askSharePct: e.askSharePct,
        volOi: e.volOi,
        premiumUsd: e.premiumUsd,
        reasons: e.reasons,
        timeStopSessions: e.exitPlan.timeStopSessions,
      });
    }
  }
  return out;
}

const keyOf = (p: { lane: string; contract: string }) => `${p.lane}|${p.contract}`;

async function runLaneDebate(picks: LanePick[], regimeCtx: unknown, now: Date) {
  const system = [
    "You run a fast three-voice debate for each option-flow pick from a TEST study lane, then give a final verdict.",
    "Be DIRECTION-AWARE: side=call means the trade wins if the stock rises; side=put means the trade wins if the stock FALLS.",
    "BULL = the best case for THIS TRADE working (for a put: the case for the drop). BEAR = why this trade fails",
    "(for a put: support holds, squeeze, bullish catalyst, crowded hedge, IV crush; for a call: fade, extended, bad timing).",
    "MACRO = regime, long yields, scheduled events, sector rotation as they affect THIS direction. Each voice <=140 chars,",
    "concrete to the facts. Exit plan is +40% target / -25% stop on option premium within the stated time stop.",
    "Then VERDICT: take | skip with confidence 0-100 and a <=140 char why. Shadow study, not advice; be calibrated.",
    'Return JSON only: {"debates":[{"key":"","bull":"","bear":"","macro":"","verdict":"take|skip","confidence":0,"why":""}]}',
  ].join(" ");
  const user = JSON.stringify({
    asOf: etClock(now),
    regime: regimeCtx,
    picks: picks.map((p) => ({
      key: keyOf(p),
      lane: p.lane,
      side: p.side,
      ticker: p.ticker,
      strike: p.strike,
      expiry: p.expiry,
      dte: p.dte,
      optionPrint: p.entry,
      underlying: p.underlying,
      otmPct: p.otmPct,
      askSharePct: p.askSharePct,
      volOi: p.volOi,
      premiumUsd: p.premiumUsd,
      timeStopSessions: p.timeStopSessions,
      laneReasons: p.reasons.slice(0, 8),
    })),
  });
  const res = await callShadowLlm({ module: "lane_debate", system, user });
  const parsed = parseJsonObject<{ debates?: Array<Record<string, unknown>> }>(res.text);
  const byKey = new Map(picks.map((p) => [keyOf(p), p]));
  const at = new Date().toISOString();
  const results: LaneDebateVerdict[] = [];
  for (const d of parsed?.debates ?? []) {
    const p = byKey.get(String(d.key ?? "").trim());
    if (!p) continue;
    results.push({
      key: keyOf(p),
      lane: p.lane,
      side: p.side,
      contract: p.contract,
      ticker: p.ticker,
      bull: String(d.bull ?? "").slice(0, 200),
      bear: String(d.bear ?? "").slice(0, 200),
      macro: String(d.macro ?? "").slice(0, 200),
      verdict: String(d.verdict) === "take" ? "take" : "skip",
      confidence: Math.max(0, Math.min(100, Number(d.confidence) || 0)),
      why: String(d.why ?? "").slice(0, 200),
      at,
    });
  }
  return { results, usage: res.usage };
}

let inflight: Promise<LaneDebateDoc> | null = null;

/** Judge newly logged lane picks (batched, throttled, budgeted). Safe to call often. */
export function refreshLaneDebate(opts: { force?: boolean } = {}): Promise<LaneDebateDoc> {
  if (inflight) return inflight;
  inflight = doRefresh(opts).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doRefresh(opts: { force?: boolean }): Promise<LaneDebateDoc> {
  const now = new Date();
  const day = tradingDateET(now);
  const doc = (await loadLaneDebate(day)) ?? blank(day);
  const picks = await todaysPicks(day);
  const todo = picks.filter((p) => !doc.verdicts[keyOf(p)]);
  doc.pending = todo.map(keyOf);
  const cfg = shadowLlmConfig();
  const clock = etClock(now);
  const lastAt = doc.llm.lastRunAt ? Date.parse(doc.llm.lastRunAt) : 0;
  const wait = doc.llm.status === "error" ? ERROR_BACKOFF_MS : MIN_INTERVAL_MS;
  let gate: LaneDebateDoc["llm"]["status"] | null = null;
  if (!todo.length) gate = doc.llm.lastRunAt ? doc.llm.status : "idle";
  else if (!cfg) gate = "no-key";
  else if (!opts.force && (!clock.weekday || clock.minutes < FROM_ET || clock.minutes > TO_ET)) gate = "off-hours";
  else if (!opts.force && lastAt && now.getTime() - lastAt < wait) gate = "throttled";
  else if ((await budgetLeft(day)) <= 0) gate = "budget";
  if (gate) {
    const changed = doc.llm.status !== gate;
    doc.llm.status = gate;
    if (gate === "throttled") doc.llm.nextAllowedAt = new Date(lastAt + wait).toISOString();
    if (changed) {
      doc.updatedAt = now.toISOString();
      await saveDoc(KIND, day, doc);
    }
    return doc;
  }
  doc.llm.lastRunAt = now.toISOString();
  doc.llm.nextAllowedAt = new Date(now.getTime() + MIN_INTERVAL_MS).toISOString();
  doc.llm.status = "ok";
  doc.llm.lastError = undefined;
  await saveDoc(KIND, day, doc); // claim the slot before billing
  try {
    const regime = await loadRegimeSafe();
    const regimeCtx = regime
      ? {
          label: regime.label,
          reasons: regime.reasons.slice(0, 5),
          us10yChangeBp: regime.yields.us10y.changeBp,
          us30yChangeBp: regime.yields.us30y.changeBp,
          yieldsRising: regime.yields.rising,
          marketTide: regime.tide?.bias ?? null,
          eventsToday: regime.events.today.filter((e) => e.impact === "High").map((e) => e.title),
          upcoming: regime.events.upcoming.slice(0, 4).map((e) => `${e.date.slice(0, 10)} ${e.title}`),
        }
      : "unavailable";
    const { results, usage } = await runLaneDebate(todo.slice(0, MAX_BATCH), regimeCtx, now);
    doc.llm.usage.push(usage);
    doc.llm.spendUsd = Math.round((doc.llm.spendUsd + usage.costUsd) * 10000) / 10000;
    for (const r of results) doc.verdicts[r.key] = r;
    doc.pending = picks.filter((p) => !doc.verdicts[keyOf(p)]).map(keyOf);
  } catch (e) {
    doc.llm.status = "error";
    doc.llm.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  doc.updatedAt = new Date().toISOString();
  await saveDoc(KIND, day, doc);
  return doc;
}

export function laneDebatePersistence(): string {
  return persistenceMode();
}
