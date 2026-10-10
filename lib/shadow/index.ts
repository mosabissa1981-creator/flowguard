import "server-only";

import { buildExitPlan } from "@/lib/exit-plan";
import { issuerKey } from "@/lib/issuers";
import { askShare, toNumber } from "@/lib/numbers";
import { contractKey } from "@/lib/scoring";
import { resolveSpread } from "@/lib/spread-core";
import { tradingDateET } from "@/lib/session";
import { fetchContractHistoric, fetchEarningsHistory, fetchTickerInfo, fetchVolStats } from "@/lib/uw";
import { budgetLeft, etClock } from "@/lib/shadow/budget";
import { shadowLlmConfig } from "@/lib/shadow/llm";
import { debateVerdict, issuerGroups, newsVerdict, runDebate, runNewsX, xSentimentVerdict } from "@/lib/shadow/llm-modules";
import {
  adaptiveExits,
  calendarTypeOf,
  earningsCheck,
  priorAppearances,
  qualityFilter,
  regimeAnalogs,
  regimeAnalogVerdict,
  sameBuyerTracking,
  worthThePrice,
} from "@/lib/shadow/modules";
import { lessonsTestEnabled, lessonsVerdict, runLessonsReview, type LessonsJudgement } from "@/lib/shadow/lessons-review";
import { loadDoc, persistenceMode, saveDoc } from "@/lib/shadow/store";
import type { ContractBar, ShadowCandidate, ShadowDay, ShadowModuleId, ShadowRegimeFeatures, ShadowVerdict } from "@/lib/shadow/types";
import type { DailyPick, RegimeSnapshot } from "@/lib/types";

/**
 * Shadow orchestrator. Annotates today's AI-review finalists (top ≤8 across morning / picks / premove)
 * with per-module verdicts and persists them per day. NEVER feeds back into the live lists.
 *
 * Cost guards:
 *  - LLM: only on trading days 9:00–16:15 ET, ≥30 min between LLM runs, only for issuers/contracts not yet
 *    covered today, ≤ SHADOW_MAX_LLM_RUNS runs/day (default 6), and a hard daily $ budget (SHADOW_LLM_DAILY_USD, default 1).
 *  - UW: per ticker /info + /volatility/stats (+ /earnings only when earnings fall before expiry), per contract
 *    /historic — each fetched at most once per day (cached in the day doc). Set SHADOW_UW=off to disable.
 */

const LLM_MIN_INTERVAL_MS = 30 * 60_000;
const LLM_ERROR_BACKOFF_MS = 10 * 60_000;
const RUN_MIN_INTERVAL_MS = 5 * 60_000;
const MAX_FINALISTS = 8;
const LLM_FROM_ET = 9 * 60;
const LLM_TO_ET = 16 * 60 + 15;

type Candidate = DailyPick & { lanes: string[] };

let inflight: Promise<ShadowDay> | null = null;
let lastRunMem = 0;

function maxLlmRuns(): number {
  const n = Number(process.env.SHADOW_MAX_LLM_RUNS);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

export function blankDay(day: string): ShadowDay {
  const now = new Date().toISOString();
  return {
    day,
    mode: "shadow",
    note: "Shadow mode: verdicts are logged for the study book only; they do not change morning/picks/premove/ai-picks.",
    generatedAt: now,
    updatedAt: now,
    regime: null,
    candidates: [],
    verdicts: {},
    dayNotes: {},
    llm: { status: "idle", lastRunAt: null, nextAllowedAt: null, spendUsd: 0, usage: [] },
    uwCalls: 0,
    cache: { news: {}, debate: {}, info: {}, vol: {}, earnings: {}, historic: {} },
  };
}

export function toShadowCandidate(c: Candidate, regime: RegimeSnapshot | null, now: Date): ShadowCandidate {
  const a = c.alert;
  const plan = c.exitPlan ?? buildExitPlan(c, { riskyRegime: Boolean(regime?.rules.active), now, ivEvents: regime?.ivEvents });
  return {
    contract: contractKey(c),
    ticker: a.ticker,
    side: a.type,
    strike: toNumber(a.strike),
    expiry: a.expiry.slice(0, 10),
    dte: c.dte,
    score: c.score,
    rawScore: c.rawScore ?? c.score,
    lanes: c.lanes,
    printTimeUtc: a.created_at,
    optionPrint: toNumber(a.price) || toNumber(a.ask),
    underlying: toNumber(a.underlying_price),
    premiumUsd: Math.round(toNumber(a.total_premium)),
    askSharePct: Math.round(askShare(a) * 100),
    spreadPct: (c.spread ?? resolveSpread(null, { bid: a.bid, ask: a.ask })).pct,
    chips: c.chips.map((ch) => `${ch.id}(${ch.delta >= 0 ? "+" : ""}${ch.delta})`),
    firstSeenAt: now.toISOString(),
    exitPlan: {
      entry: plan.entry,
      target: plan.target,
      targetPct: plan.targetPct,
      stop: plan.stop,
      stopPct: plan.stopPct,
      sessions: plan.timeStop.sessions,
      timeStopDate: plan.timeStop.date,
    },
  };
}

export function regimeFeatures(regime: RegimeSnapshot | null): ShadowRegimeFeatures | null {
  if (!regime) return null;
  const eventsToday = regime.events.today.filter((e) => e.impact === "High" || e.impact === "Medium").map((e) => e.title);
  return {
    label: regime.label,
    us10yChangeBp: regime.yields.us10y.changeBp,
    us30yChangeBp: regime.yields.us30y.changeBp,
    tide: regime.tide?.bias ?? null,
    calendarType: calendarTypeOf(eventsToday),
    eventsToday,
    dayRating: regime.dayRating?.rating ?? null,
  };
}

function setVerdict(doc: ShadowDay, contract: string, v: ShadowVerdict) {
  const list = (doc.verdicts[contract] ||= []);
  const i = list.findIndex((x) => x.module === v.module);
  // Keep the first non-skip verdict of the day (what the desk would have seen); replace skips.
  if (i >= 0) {
    if (list[i].verdict === "skip" || v.module === "regime_analogs") list[i] = v;
  } else list.push(v);
}

async function uwPhase(doc: ShadowDay, cands: ShadowCandidate[], day: string) {
  if (process.env.SHADOW_UW === "off") return;
  const at = new Date().toISOString();
  const tickers = [...new Set(cands.map((c) => c.ticker))];
  // Sequential on purpose: UW rate-limits bursts (a 429 trips the shared circuit and blanks every lane).
  // Failed (null) lookups are not cached so the next run retries them.
  const pause = () => new Promise((r) => setTimeout(r, 250));
  for (const t of tickers) {
    if (!doc.cache.info[t]?.data) {
      const data = await fetchTickerInfo(t);
      doc.uwCalls += 1;
      if (data) doc.cache.info[t] = { at, data };
      await pause();
    }
    if (!doc.cache.vol[t]?.data) {
      const data = await fetchVolStats(t);
      doc.uwCalls += 1;
      if (data) doc.cache.vol[t] = { at, data };
      await pause();
    }
    const next = doc.cache.info[t]?.data?.nextEarningsDate;
    const maxExpiry = cands.filter((c) => c.ticker === t).map((c) => c.expiry).sort().pop() ?? day;
    if (next && next >= day && next <= maxExpiry && !doc.cache.earnings[t]?.data) {
      const data = await fetchEarningsHistory(t);
      doc.uwCalls += 1;
      if (data) doc.cache.earnings[t] = { at, data };
      await pause();
    }
  }
  for (const c of cands) {
    if (doc.cache.historic[c.contract]?.data) continue;
    const bars = await fetchContractHistoric(c.contract, 10);
    doc.uwCalls += 1;
    await pause();
    const data: ContractBar[] = bars.map((b) => ({
      date: b.date.slice(0, 10),
      volume: b.volume ?? 0,
      openInterest: b.openInterest ?? 0,
      askVolume: b.askVolume,
      bidVolume: b.bidVolume,
      lastPrice: b.last,
      iv: b.impliedVolatility,
    }));
    if (data.length) doc.cache.historic[c.contract] = { at, data };
  }
}

export type RunShadowInput = {
  cands: Candidate[];
  regime: RegimeSnapshot | null;
  now?: Date;
  force?: boolean;
  allowLlm?: boolean;
  briefLine?: string | null;
  priorShadow?: Record<string, string[]>;
};

/** Core run (also used by the local test script with injected candidates/regime/time). */
export async function runShadow(input: RunShadowInput): Promise<ShadowDay> {
  const now = input.now ?? new Date();
  const day = tradingDateET(now);
  const doc = (await loadDoc<ShadowDay>("day", day, { fresh: true })) ?? blankDay(day);
  const risky = Boolean(input.regime?.rules.active);
  doc.regime = regimeFeatures(input.regime) ?? doc.regime;

  // 1) merge candidates (frozen at first sight)
  const current = input.cands.slice(0, MAX_FINALISTS).map((c) => toShadowCandidate(c, input.regime, now));
  for (const c of current) {
    const existing = doc.candidates.find((x) => x.contract === c.contract);
    if (existing) existing.lanes = [...new Set([...existing.lanes, ...c.lanes])];
    else doc.candidates.push(c);
  }
  const frozen = current.map((c) => doc.candidates.find((x) => x.contract === c.contract) ?? c);

  // 2) deterministic modules (cached UW data)
  await uwPhase(doc, frozen, day);
  const analog = regimeAnalogs(doc.regime, day);
  doc.dayNotes.regime_analogs = analog;
  for (const c of frozen) {
    setVerdict(doc, c.contract, earningsCheck(c, day, doc.cache.info[c.ticker]?.data ?? null, doc.cache.earnings[c.ticker]?.data ?? null));
    setVerdict(doc, c.contract, sameBuyerTracking(c, day, doc.cache.historic[c.contract]?.data ?? null, priorAppearances(c.contract, day, input.priorShadow)));
    setVerdict(doc, c.contract, worthThePrice(c, doc.cache.vol[c.ticker]?.data ?? null, risky));
    setVerdict(doc, c.contract, adaptiveExits(c, doc.cache.vol[c.ticker]?.data ?? null, risky));
    setVerdict(doc, c.contract, regimeAnalogVerdict(c, analog));
    setVerdict(doc, c.contract, qualityFilter(c)); // study only: log, never gates live picks
  }

  // 3) LLM modules (throttled, incremental, budgeted)
  const cfg = shadowLlmConfig();
  const newsTodo = issuerGroups(frozen).filter((g) => !(g.issuer in doc.cache.news));
  const debateTodo = frozen.filter((c) => !(c.contract in doc.cache.debate));
  const runsToday = new Set(doc.llm.usage.map((u) => u.at.slice(0, 16))).size;
  const clock = etClock(now);
  const lastAt = doc.llm.lastRunAt ? Date.parse(doc.llm.lastRunAt) : 0;
  const wait = doc.llm.status === "error" ? LLM_ERROR_BACKOFF_MS : LLM_MIN_INTERVAL_MS;
  let gate: ShadowDay["llm"]["status"] | null = null;
  if (input.allowLlm === false) gate = doc.llm.status === "ok" ? "ok" : "idle";
  else if (!cfg) gate = "no-key";
  else if (!newsTodo.length && !debateTodo.length) gate = doc.llm.lastRunAt ? "ok" : "idle";
  else if (!input.force && (!clock.weekday || clock.minutes < LLM_FROM_ET || clock.minutes > LLM_TO_ET)) gate = "off-hours";
  else if (!input.force && lastAt && now.getTime() - lastAt < wait) gate = "throttled";
  else if (!input.force && runsToday >= maxLlmRuns()) gate = "throttled";
  else if ((await budgetLeft(day)) <= 0) gate = "budget";
  if (gate) {
    doc.llm.status = gate;
    doc.llm.nextAllowedAt = gate === "throttled" && lastAt ? new Date(lastAt + wait).toISOString() : doc.llm.nextAllowedAt;
  } else if (cfg) {
    doc.llm.lastRunAt = now.toISOString();
    doc.llm.nextAllowedAt = new Date(now.getTime() + LLM_MIN_INTERVAL_MS).toISOString();
    doc.llm.status = "ok";
    doc.llm.lastError = undefined;
    await saveDoc("day", day, doc); // claim the slot before billing
    const at = new Date().toISOString();
    if (newsTodo.length && cfg.searchEnabled) {
      try {
        const { results, usage } = await runNewsX(newsTodo, now);
        doc.llm.usage.push(usage);
        doc.llm.spendUsd += usage.costUsd;
        for (const g of newsTodo) if (results[g.issuer]) doc.cache.news[g.issuer] = { at, data: results[g.issuer] };
      } catch (e) {
        doc.llm.status = "error";
        doc.llm.lastError = `news: ${(e instanceof Error ? e.message : String(e)).slice(0, 180)}`;
      }
    }
    if (debateTodo.length) {
      const context: Record<string, string[]> = {};
      for (const c of debateTodo) {
        const n = doc.cache.news[issuerKey(c.ticker)]?.data;
        context[c.contract] = [
          ...(doc.verdicts[c.contract] ?? []).filter((v) => v.verdict !== "skip").map((v) => `${v.module}: ${v.verdict} — ${v.reason}`),
          ...(n ? [`news: ${n.freshNews} (fade ${n.fadeRisk}); X ${n.xChatter}/${n.xTone}`] : []),
        ];
      }
      try {
        const { results, usage } = await runDebate(debateTodo, doc.regime, context, { brief: input.briefLine ?? null, now });
        doc.llm.usage.push(usage);
        doc.llm.spendUsd += usage.costUsd;
        for (const c of debateTodo) if (results[c.contract]) doc.cache.debate[c.contract] = { at, data: results[c.contract] };
      } catch (e) {
        doc.llm.status = "error";
        doc.llm.lastError = `${doc.llm.lastError ? doc.llm.lastError + " | " : ""}debate: ${(e instanceof Error ? e.message : String(e)).slice(0, 180)}`;
      }
    }
    // TEST MODE (FLOWGUARD_LESSONS_TEST=1, default off): Grok + lessons sheet second opinion, shadow-scored only.
    if (lessonsTestEnabled()) {
      const seen = ((doc.dayNotes.lessons_review as Record<string, LessonsJudgement> | undefined) ??= {});
      const todo = frozen.filter((c) => !(c.contract in seen));
      if (todo.length) {
        try {
          const { results, usage } = await runLessonsReview(todo, now);
          doc.llm.usage.push(usage);
          doc.llm.spendUsd += usage.costUsd;
          Object.assign(seen, results);
        } catch (e) {
          doc.llm.lastError = `${doc.llm.lastError ? doc.llm.lastError + " | " : ""}lessons_review: ${(e instanceof Error ? e.message : String(e)).slice(0, 180)}`;
        }
      }
    }
    doc.llm.spendUsd = Math.round(doc.llm.spendUsd * 10000) / 10000;
  }
  for (const c of frozen) {
    const n = doc.cache.news[issuerKey(c.ticker)]?.data;
    setVerdict(doc, c.contract, newsVerdict(c, n));
    setVerdict(doc, c.contract, xSentimentVerdict(c, n));
    setVerdict(doc, c.contract, debateVerdict(doc.cache.debate[c.contract]?.data));
    if (lessonsTestEnabled()) {
      setVerdict(doc, c.contract, lessonsVerdict((doc.dayNotes.lessons_review as Record<string, LessonsJudgement> | undefined)?.[c.contract]));
    }
  }
  doc.updatedAt = new Date().toISOString();
  await saveDoc("day", day, doc);
  return doc;
}

/** Public view: drop raw caches unless asked. */
export function publicView(doc: ShadowDay, full = false) {
  const { cache, ...rest } = doc;
  const order: ShadowModuleId[] = ["news_x_check", "x_sentiment_shift", "earnings_check", "same_buyer_tracking", "worth_the_price", "regime_analogs", "adaptive_exits", "debate", "quality_filter", ...(lessonsTestEnabled() ? (["lessons_review"] as ShadowModuleId[]) : [])];
  const tally: Record<string, { pass: number; flag: number; boost: number; skip: number }> = {};
  for (const list of Object.values(doc.verdicts)) {
    for (const v of list) {
      const t = (tally[v.module] ||= { pass: 0, flag: 0, boost: 0, skip: 0 });
      t[v.verdict] += 1;
    }
  }
  return {
    ...rest,
    persistence: persistenceMode(),
    moduleOrder: order,
    tally,
    ...(full ? { cache } : {}),
  };
}

export async function loadShadowDay(day: string): Promise<ShadowDay | null> {
  return loadDoc<ShadowDay>("day", day, { fresh: true });
}

/** Lazily run the shadow pass for the live tape (re-uses the AI-review candidate gather: zero extra flow calls). */
export async function refreshShadow(opts: { force?: boolean } = {}): Promise<ShadowDay> {
  if (!opts.force && Date.now() - lastRunMem < RUN_MIN_INTERVAL_MS) {
    const day = tradingDateET();
    const stored = await loadDoc<ShadowDay>("day", day);
    if (stored) return stored;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    lastRunMem = Date.now();
    const [{ gatherCandidates }, { loadRegimeSafe }, { loadBrief, briefLine }] = await Promise.all([
      import("@/lib/ai-picks"),
      import("@/lib/regime"),
      import("@/lib/shadow/brief"),
    ]);
    const [gathered, regime] = await Promise.all([gatherCandidates(), loadRegimeSafe()]);
    const brief = await loadBrief({ generate: false }).catch(() => null);
    if (gathered.source === "mock" || !gathered.cands.length) {
      const day = tradingDateET();
      const doc = (await loadDoc<ShadowDay>("day", day)) ?? blankDay(day);
      return doc;
    }
    return runShadow({ cands: gathered.cands, regime, force: opts.force, briefLine: briefLine(brief) });
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Fire-and-forget hook for live routes (via next/server `after`). Never throws. */
export async function triggerShadowQuietly(): Promise<void> {
  if (process.env.SHADOW_MODE === "off") return;
  try {
    await refreshShadow();
  } catch {
    // shadow must never affect live routes
  }
}
