import "server-only";

import { loadDailyPicks } from "@/lib/picks";
import { loadMorningShortlist } from "@/lib/morning";
import { loadPremoveShortlist } from "@/lib/premove";
import { applyConcentrationCaps, issuerKey, sectorOf } from "@/lib/issuers";
import { lockoutWarning, loadRegimeSafe, regimeBrief, regimeCaps } from "@/lib/regime";
import { compareActionable, contractKey } from "@/lib/scoring";
import { buildExitPlan } from "@/lib/exit-plan";
import { loadStudySummary, studyBrief } from "@/lib/study-summary";
import { askShare, toNumber } from "@/lib/numbers";
import { tradingDateET } from "@/lib/session";
import { loadAiPicksState, saveAiPicksState, type AiPicksState } from "@/lib/ai-picks-state";
import { clamp } from "@/lib/numbers";
import type { AiPick, AiPicksResponse, AiSkip, DailyPick, RegimeSnapshot } from "@/lib/types";

const MAX_CANDIDATES = 8;
/** Reasoning models (e.g. grok-4.x) need ~20–40s on this prompt; route maxDuration is 60s. */
const LLM_TIMEOUT_MS = Math.min(55_000, Math.max(5_000, Number(process.env.LLM_TIMEOUT_MS) || 50_000));
const CACHE_MS = 12 * 60_000;
/** Cost guard: at most one LLM call per 30 min per trading day, and only when candidates change. */
const LLM_MIN_INTERVAL_MS = 30 * 60_000;
/** After a failed LLM call, wait this long before trying again. */
const LLM_ERROR_BACKOFF_MS = 10 * 60_000;
const DISCLAIMER =
  "Options-flow screen, not financial advice. AI picks rank unusual flow; they do not predict prices.";

type Candidate = DailyPick & { lanes: string[] };

type LlmDecision = {
  picks: { contract: string; confidence: number; reason: string }[];
  skips: { contract: string; reason: string }[];
};

let cache: { key: string; at: number; value: AiPicksResponse } | null = null;
let inflight: { key: string; promise: Promise<AiPicksResponse> } | null = null;

function llmConfig() {
  const key = process.env.LLM_API_KEY?.trim() || "";
  if (!key) return null;
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase();
  const provider = explicit || (key.startsWith("sk-ant-") ? "anthropic" : "openai");
  // xAI keys (xai-…) are OpenAI-compatible; default to the xAI endpoint + Grok when not overridden.
  const isXai = provider !== "anthropic" && key.startsWith("xai-");
  const model =
    process.env.LLM_MODEL?.trim() ||
    (provider === "anthropic" ? "claude-sonnet-4-5" : isXai ? "grok-4.7" : "gpt-4.1-mini");
  const baseUrl = (
    process.env.LLM_BASE_URL?.trim() ||
    (provider === "anthropic"
      ? "https://api.anthropic.com/v1"
      : isXai
        ? "https://api.x.ai/v1"
        : "https://api.openai.com/v1")
  ).replace(/\/$/, "");
  // Grok 4.x reasons by default (~170s / ~18k tokens on this prompt); "low" keeps it ~20–30s / ~7k tokens.
  // LLM_REASONING_EFFORT=none disables the field for providers that reject it.
  const effortEnv = process.env.LLM_REASONING_EFFORT?.trim().toLowerCase();
  const reasoningEffort =
    effortEnv === "none" || effortEnv === "off"
      ? undefined
      : effortEnv || (baseUrl.includes("api.x.ai") ? "low" : undefined);
  return { key, provider, model, baseUrl, reasoningEffort };
}

function candidateFacts(c: Candidate) {
  const a = c.alert;
  return {
    contract: contractKey(c),
    ticker: a.ticker,
    issuer: issuerKey(a.ticker),
    sector: sectorOf(a.ticker),
    side: a.type,
    strike: toNumber(a.strike),
    expiry: a.expiry,
    dte: c.dte,
    score: c.score,
    rawScore: c.rawScore ?? c.score,
    lanes: c.lanes,
    printTimeUtc: a.created_at,
    optionPrint: toNumber(a.price),
    underlying: toNumber(a.underlying_price),
    premiumUsd: Math.round(toNumber(a.total_premium)),
    askSharePct: Math.round(askShare(a) * 100),
    volOi: toNumber(a.volume_oi_ratio),
    sweep: a.has_sweep,
    allOpening: a.all_opening_trades,
    rule: a.alert_rule,
    chips: c.chips.map((ch) => `${ch.id}(${ch.delta >= 0 ? "+" : ""}${ch.delta})`),
    tickerTide: c.tickerTideBias,
  };
}

function buildPrompt(cands: Candidate[], regime: RegimeSnapshot | null, maxPicks: number, brief?: string | null) {
  const study = loadStudySummary(15);
  const system = [
    "You are the risk-aware desk reviewer for FlowGuard, an unusual-options-flow screener.",
    "You do NOT predict prices. You choose which flagged option contracts are worth a small, defined-risk",
    "paper trade today and which to skip, using the regime, the flow facts, and the desk's recent outcomes.",
    "Rules: pick between 0 and " + maxPicks + " contracts ONLY from the candidate list (use the exact contract id).",
    "Never pick two contracts from the same issuer on a risky/report day; treat GOOG and GOOGL as one issuer.",
    "Prefer: morning ask-side prints, quiet underlying, 11–30 DTE, single-leg sweeps. Distrust: late prints,",
    "same-issuer clusters, long-duration tech calls when long yields rise, rate-sensitive calls (utilities, REITs,",
    "homebuilders, IWM small caps, KRE regional banks, TLT) when the long end rises, Treasury auction afternoons,",
    "and score ties at 100 (not an edge). Expiries spanning CPI/PPI/NFP/FOMC carry elevated IV — mention it.",
    "Every candidate you do not pick must appear in skips with a short concrete reason.",
    'Respond with JSON only: {"picks":[{"contract":"...","confidence":0-100,"reason":"<=200 chars"}],"skips":[{"contract":"...","reason":"<=160 chars"}]}',
  ].join(" ");
  const user = {
    regime: regime
      ? {
          label: regime.label,
          reasons: regime.reasons,
          us10yChangeBp: regime.yields.us10y.changeBp,
          us30yChangeBp: regime.yields.us30y.changeBp,
          tide: regime.tide?.bias ?? null,
          eventsToday: regime.events.today.filter((e) => e.impact === "High").map((e) => `${e.date} ${e.title}`),
          nextHighImpact: regime.events.upcoming.slice(0, 3).map((e) => `${e.date} ${e.title}`),
          rules: regime.rules,
          yieldTrend5d: regime.yields.trend5d,
          deskDayRating: regime.dayRating,
          auctionToday: regime.auctionToday,
          lockoutWindows: regime.lockout.windows,
          ivEvents: regime.ivEvents,
        }
      : "unavailable",
    maxPicks,
    ...(brief ? { premarketBrief: brief } : {}),
    studyOutcomes: {
      since: study.since,
      through: study.through,
      definition: study.definition,
      totals: study.totals,
      buckets: study.buckets,
      correlatedLossClusters: study.correlatedLossClusters,
      lessons: study.lessons,
      recentDecided: study.recentDecided.map(
        (r) => `${r.day} ${r.contract} ${r.outcome} ${r.pct ?? ""}% score=${r.score ?? "?"} lane=${r.lane ?? "?"} ${r.bucket}`,
      ),
    },
    candidates: cands.map(candidateFacts),
  };
  return { system, user: JSON.stringify(user) };
}

type LlmUsage = { promptTokens?: number; completionTokens?: number; totalTokens?: number };

async function callLlm(
  system: string,
  user: string,
): Promise<{ text: string; provider: string; model: string; usage?: LlmUsage }> {
  const cfg = llmConfig();
  if (!cfg) throw new Error("no-key");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    if (cfg.provider === "anthropic") {
      const response = await fetch(`${cfg.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": cfg.key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 1500,
          temperature: 0.2,
          system,
          messages: [{ role: "user", content: user }],
        }),
        signal: controller.signal,
        cache: "no-store",
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`anthropic ${response.status}: ${body.slice(0, 200)}`);
      const json = JSON.parse(body) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const usage = json.usage
        ? {
            promptTokens: json.usage.input_tokens,
            completionTokens: json.usage.output_tokens,
            totalTokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
          }
        : undefined;
      return { text: (json.content ?? []).map((c) => c.text ?? "").join(""), provider: cfg.provider, model: cfg.model, usage };
    }
    // OpenAI and OpenAI-compatible (xAI, Groq, OpenRouter, Together…) via LLM_BASE_URL.
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`${cfg.provider} ${response.status}: ${body.slice(0, 200)}`);
    const json = JSON.parse(body) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const usage = json.usage
      ? {
          promptTokens: json.usage.prompt_tokens,
          completionTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
        }
      : undefined;
    return { text: json.choices?.[0]?.message?.content ?? "", provider: cfg.provider, model: cfg.model, usage };
  } finally {
    clearTimeout(timer);
  }
}

function parseDecision(text: string): LlmDecision | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Partial<LlmDecision>;
    if (!Array.isArray(raw.picks)) return null;
    return {
      picks: raw.picks
        .filter((p) => p && typeof p.contract === "string")
        .map((p) => ({
          contract: String(p.contract).trim(),
          confidence: clamp(Number(p.confidence) || 0, 0, 100),
          reason: String(p.reason ?? "").slice(0, 280),
        })),
      skips: (Array.isArray(raw.skips) ? raw.skips : [])
        .filter((s) => s && typeof s.contract === "string")
        .map((s) => ({ contract: String(s.contract).trim(), reason: String(s.reason ?? "").slice(0, 240) })),
    };
  } catch {
    return null;
  }
}

function deterministicConfidence(c: Candidate, risky: boolean): number {
  const raw = c.rawScore ?? c.score;
  let conf = 40 + Math.min(30, Math.max(0, (raw - 60) / 2));
  if (c.lanes.includes("morning")) conf += 5;
  if (c.chips.some((ch) => ch.id === "quiet")) conf += 5;
  if (c.chips.some((ch) => ch.id === "rate-pressure")) conf -= 10;
  if (risky) conf -= 5;
  return Math.round(clamp(conf, 5, 85));
}

function shortReason(c: Candidate): string {
  const boosts = c.chips
    .filter((ch) => ch.kind === "boost" && ch.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 4)
    .map((ch) => ch.label.toLowerCase());
  const pens = c.chips.filter((ch) => ch.kind === "penalty" && ch.delta < 0).slice(0, 2).map((ch) => ch.label.toLowerCase());
  return `Rules pick: ${boosts.join(", ") || "top actionable score"}${pens.length ? `; watch: ${pens.join(", ")}` : ""}.`;
}

export async function gatherCandidates(): Promise<{
  cands: Candidate[];
  source: AiPicksResponse["source"];
  fetchedAt: string;
  quotaBlocked?: boolean;
  warning?: string;
}> {
  const [morning, picks, premove] = await Promise.all([
    loadMorningShortlist(),
    loadDailyPicks(),
    loadPremoveShortlist(),
  ]);
  const byKey = new Map<string, Candidate>();
  const addAll = (rows: DailyPick[], lane: string) => {
    for (const row of rows) {
      const k = contractKey(row);
      const cur = byKey.get(k);
      if (cur) {
        if (!cur.lanes.includes(lane)) cur.lanes.push(lane);
        if ((row.rawScore ?? row.score) > (cur.rawScore ?? cur.score)) byKey.set(k, { ...row, lanes: cur.lanes });
      } else {
        byKey.set(k, { ...row, lanes: [lane] });
      }
    }
  };
  // Morning first: every decided trade since Sep 23 came from the morning list.
  addAll(morning.source === "mock" ? [] : morning.picks, "morning");
  addAll(picks.source === "mock" ? [] : picks.picks, "picks");
  addAll(premove.source === "mock" ? [] : premove.picks, "premove");
  const sorted = [...byKey.values()].sort((a, b) => {
    const ma = a.lanes.includes("morning") ? 0 : 1;
    const mb = b.lanes.includes("morning") ? 0 : 1;
    if (ma !== mb) return ma - mb;
    return compareActionable(a, b);
  });
  const { kept } = applyConcentrationCaps(sorted, MAX_CANDIDATES);
  return {
    cands: kept,
    source: picks.source,
    fetchedAt: picks.fetchedAt,
    quotaBlocked: picks.quotaBlocked,
    warning: picks.warning ?? morning.warning,
  };
}

async function compute(opts: { force?: boolean }): Promise<AiPicksResponse> {
  const gathered = await gatherCandidates();
  const regime = await loadRegimeSafe();
  // Pre-market brief as extra LLM context is opt-in (SHADOW_BRIEF_IN_AI_PICKS=1) so shadow mode leaves AI picks unchanged by default.
  let brief: string | null = null;
  if (process.env.SHADOW_BRIEF_IN_AI_PICKS === "1") {
    const { loadBrief, briefLine } = await import("@/lib/shadow/brief");
    brief = briefLine(await loadBrief({ generate: false }).catch(() => null));
  }
  return reviewCandidates(gathered, regime, { ...opts, brief });
}

/**
 * Core review: regime + candidates -> LLM (throttled) or deterministic fallback.
 * `force` bypasses the throttle (admin-only, see route). `persist: false` skips the shared state (tests).
 */
export async function reviewCandidates(
  gathered: Awaited<ReturnType<typeof gatherCandidates>>,
  regime: RegimeSnapshot | null,
  opts: { force?: boolean; persist?: boolean; brief?: string | null } = {},
): Promise<AiPicksResponse> {
  const { cands, source, fetchedAt, quotaBlocked, warning } = gathered;
  const persistState = opts.persist !== false;
  const risky = Boolean(regime?.rules.active);
  const maxPicks = risky ? 3 : 5;
  const caps = regimeCaps(regime);
  const day = tradingDateET();
  // Fingerprint ignores fetchedAt: a tape refresh with the same candidates must not re-bill the LLM.
  const key = `${day}|${regime?.label ?? "na"}|${cands.map((c) => contractKey(c)).sort().join(",")}`;
  if (!opts.force && persistState && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;

  const base = {
    source,
    fetchedAt,
    generatedAt: new Date().toISOString(),
    regime: regimeBrief(regime),
    candidatesConsidered: cands.length,
    study: studyBrief(),
    quotaBlocked,
    disclaimer: DISCLAIMER,
  };

  const toPick = (c: Candidate, confidence: number, reason: string): AiPick => ({
    ...c,
    confidence,
    aiReason: reason,
    exitPlan: buildExitPlan(c, { riskyRegime: risky, confidence, ivEvents: regime?.ivEvents }),
  });

  const locked = lockoutWarning(regime);
  if (locked) {
    // No LLM call and no picks inside a pre-release window.
    return {
      ...base,
      engine: "deterministic",
      llmStatus: "skipped",
      picks: [],
      skips: cands.map((c) => ({ option_chain: contractKey(c), ticker: c.alert.ticker, reason: locked })),
      warning: locked,
    };
  }

  if (cands.length === 0) {
    const value: AiPicksResponse = {
      ...base,
      engine: "deterministic",
      llmStatus: "skipped",
      picks: [],
      skips: [],
      warning: warning ?? "No actionable candidates on the tape right now.",
    };
    cache = { key, at: Date.now(), value };
    return value;
  }

  const fallback = (llmStatus: AiPicksResponse["llmStatus"], llmError?: string): AiPicksResponse => {
    const { kept, dropped } = applyConcentrationCaps(cands, maxPicks, caps);
    const keptKeys = new Set(kept.map((c) => contractKey(c)));
    const skips: AiSkip[] = [
      ...dropped.map((d) => ({ option_chain: d.option_chain, ticker: d.ticker, reason: `Skip: ${d.reason}.` })),
      ...cands
        .filter((c) => !keptKeys.has(contractKey(c)) && !dropped.some((d) => d.option_chain === contractKey(c)))
        .map((c) => ({
          option_chain: contractKey(c),
          ticker: c.alert.ticker,
          reason: `Skip: outside top ${maxPicks} on a ${regime?.label ?? "unknown"} day (score ${c.score}).`,
        })),
    ];
    return {
      ...base,
      engine: "deterministic",
      llmStatus,
      llmError,
      picks: kept.map((c) => toPick(c, deterministicConfidence(c, risky), shortReason(c))),
      skips,
      warning,
    };
  };

  const cfg = llmConfig();
  if (!cfg) {
    const value = fallback("no-key");
    cache = { key, at: Date.now(), value };
    return value;
  }

  // ---- Cost guard (shared across instances via Blob) ----
  const now = Date.now();
  const state: AiPicksState | null = persistState ? await loadAiPicksState() : null;
  const sameDay = state?.day === day;
  if (!opts.force && persistState && sameDay && state) {
    if (state.value && state.valueKey === key) {
      // Same candidates as the last LLM answer today: never re-bill.
      const value = { ...state.value, llmCachedAt: new Date(state.valueAt).toISOString() };
      cache = { key, at: now, value };
      return value;
    }
    const lastFailed = Boolean(state.lastError) && (!state.value || state.attemptAt > state.valueAt);
    const wait = lastFailed ? LLM_ERROR_BACKOFF_MS : LLM_MIN_INTERVAL_MS;
    if (now - state.attemptAt < wait) {
      const nextLlmAt = new Date(state.attemptAt + wait).toISOString();
      if (state.value) {
        // Candidates changed but the model ran recently: serve the last AI answer, flagged.
        const value: AiPicksResponse = {
          ...state.value,
          llmCachedAt: new Date(state.valueAt).toISOString(),
          nextLlmAt,
          candidatesChanged: true,
        };
        cache = { key, at: now, value };
        return value;
      }
      const value = { ...fallback("throttled", state.lastError), llmProvider: cfg.provider, llmModel: cfg.model, nextLlmAt };
      cache = { key, at: now, value };
      return value;
    }
  }
  // Claim the slot before calling so concurrent instances back off.
  const base0: AiPicksState = sameDay && state
    ? { ...state, candKey: key, attemptAt: now }
    : { day, candKey: key, attemptAt: now, value: null, valueKey: "", valueAt: 0 };
  if (persistState) await saveAiPicksState(base0);

  try {
    const { system, user } = buildPrompt(cands, regime, maxPicks, opts.brief);
    const { text, provider, model, usage } = await callLlm(system, user);
    const decision = parseDecision(text);
    if (!decision) {
      const value = { ...fallback("invalid-output", "LLM returned non-JSON output"), llmProvider: provider, llmModel: model, llmUsage: usage };
      cache = { key, at: Date.now(), value };
      if (persistState) await saveAiPicksState({ ...base0, lastError: "invalid-output" });
      return value;
    }
    const byKey = new Map(cands.map((c) => [contractKey(c), c]));
    const chosen = decision.picks
      .filter((p) => byKey.has(p.contract))
      .sort((a, b) => b.confidence - a.confidence)
      .map((p) => ({ cand: byKey.get(p.contract)!, p }));
    // Hard guardrails after the model: regime list cap + issuer/sector caps.
    const { kept, dropped } = applyConcentrationCaps(
      chosen.map((x) => ({ ...x.cand, _p: x.p })),
      maxPicks,
      caps,
    );
    const picks = kept.map((c) => toPick(c, Math.round(c._p.confidence), c._p.reason || shortReason(c)));
    const pickedKeys = new Set(picks.map((p) => contractKey(p)));
    const skipReasons = new Map(decision.skips.map((s) => [s.contract, s.reason]));
    for (const d of dropped) skipReasons.set(d.option_chain, `Guardrail: ${d.reason}.`);
    const skips: AiSkip[] = cands
      .filter((c) => !pickedKeys.has(contractKey(c)))
      .map((c) => ({
        option_chain: contractKey(c),
        ticker: c.alert.ticker,
        reason: skipReasons.get(contractKey(c)) || "Skipped by AI review (no reason returned).",
      }));
    for (const p of picks) delete (p as { _p?: unknown })._p;
    const value: AiPicksResponse = {
      ...base,
      engine: "llm",
      llmStatus: "ok",
      llmProvider: provider,
      llmModel: model,
      llmUsage: usage,
      picks,
      skips,
      warning,
    };
    cache = { key, at: Date.now(), value };
    if (persistState) {
      await saveAiPicksState({ ...base0, value, valueKey: key, valueAt: Date.now(), lastError: undefined });
    }
    return value;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Error backoff is enforced by the shared state (LLM_ERROR_BACKOFF_MS); short local cache only.
    const value = { ...fallback("error", msg.slice(0, 200)), llmProvider: cfg.provider, llmModel: cfg.model };
    cache = { key, at: Date.now() - CACHE_MS + 2 * 60_000, value };
    if (persistState) await saveAiPicksState({ ...base0, lastError: msg.slice(0, 200) });
    return value;
  }
}

/** AI review of the top actionable candidates. Zero extra UW calls: re-uses the shared tape lists. */
export async function loadAiPicks(opts: { force?: boolean } = {}): Promise<AiPicksResponse> {
  const k = opts.force ? "force" : "normal";
  if (inflight?.key === k) return inflight.promise;
  const promise = compute(opts).finally(() => {
    if (inflight?.promise === promise) inflight = null;
  });
  inflight = { key: k, promise };
  return promise;
}
