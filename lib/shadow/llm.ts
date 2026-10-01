import "server-only";

import { ledgerAdd, llmPersistenceGate } from "@/lib/llm-ledger";
import { tradingDateET } from "@/lib/session";

import type { LlmUsageRecord } from "@/lib/shadow/types";

/**
 * Shared LLM client for shadow modules. xAI keys (xai-…) use the Responses API, which also hosts the
 * server-side web_search / x_search tools. Other providers get plain JSON chat (no search modules).
 * The key is read from LLM_API_KEY and never logged.
 */

const DEFAULT_TIMEOUT_MS = 55_000;

/** List prices per 1M tokens (Sep 2026 xAI pricing page) — used only when the provider omits cost. */
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  "grok-4.7": { input: 2, cached: 0.5, output: 6 },
  "grok-4.6": { input: 2, cached: 0.5, output: 6 },
  "grok-4.5": { input: 2, cached: 0.3, output: 6 },
  "grok-4.3": { input: 1.25, cached: 0.2, output: 2.5 },
  "grok-4.20-0309-reasoning": { input: 1.25, cached: 0.2, output: 2.5 },
  "grok-4.20-0309-non-reasoning": { input: 1.25, cached: 0.2, output: 2.5 },
};
const WEB_SEARCH_USD = 0.005;
const X_POST_USD = 0.005;

export type ShadowLlmConfig = {
  key: string;
  provider: "xai" | "openai" | "anthropic";
  baseUrl: string;
  /** Model for judgement calls (debate). */
  model: string;
  /** Cheaper model for search-tool calls (news/X, brief, release reads). */
  searchModel: string;
  reasoningEffort?: string;
  searchEnabled: boolean;
};

export function shadowLlmConfig(): ShadowLlmConfig | null {
  const key = process.env.LLM_API_KEY?.trim() || "";
  if (!key) return null;
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase();
  const provider: ShadowLlmConfig["provider"] =
    explicit === "anthropic" || key.startsWith("sk-ant-")
      ? "anthropic"
      : key.startsWith("xai-") || explicit === "xai"
        ? "xai"
        : "openai";
  const baseUrl = (
    process.env.LLM_BASE_URL?.trim() ||
    (provider === "anthropic" ? "https://api.anthropic.com/v1" : provider === "xai" ? "https://api.x.ai/v1" : "https://api.openai.com/v1")
  ).replace(/\/$/, "");
  const model =
    process.env.SHADOW_LLM_MODEL?.trim() ||
    process.env.LLM_MODEL?.trim() ||
    (provider === "anthropic" ? "claude-sonnet-4-5" : provider === "xai" ? "grok-4.7" : "gpt-4.1-mini");
  const searchModel = process.env.SHADOW_SEARCH_MODEL?.trim() || (provider === "xai" ? "grok-4.3" : model);
  const effortEnv = process.env.LLM_REASONING_EFFORT?.trim().toLowerCase();
  const reasoningEffort =
    effortEnv === "none" || effortEnv === "off" ? undefined : effortEnv || (provider === "xai" ? "low" : undefined);
  return {
    key,
    provider,
    baseUrl,
    model,
    searchModel,
    reasoningEffort,
    searchEnabled: provider === "xai" && process.env.SHADOW_SEARCH !== "off",
  };
}

export type LlmResult = { text: string; sources: string[]; usage: LlmUsageRecord };

export function estimateCost(model: string, inTok: number, cached: number, outTok: number, web: number, posts: number): number {
  const p = PRICES[model] ?? PRICES["grok-4.7"];
  return ((inTok - cached) * p.input + cached * p.cached + outTok * p.output) / 1e6 + web * WEB_SEARCH_USD + posts * X_POST_USD;
}

type ResponsesBody = {
  output?: Array<{ type: string; content?: Array<{ type: string; text?: string; annotations?: Array<{ type: string; url?: string }> }> }>;
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
    cost_in_usd_ticks?: number;
    server_side_tool_usage_details?: { web_search_calls?: number; x_search_calls?: number; x_posts_fetched?: number };
  };
  error?: unknown;
};

/**
 * One JSON-only call. `search` adds xAI server-side web + X search (needs an xAI key).
 * `maxTurns` caps the agentic search loop (cost control).
 */
/**
 * Gated entry point for every shadow-module LLM call: refuses when persistence is down (global $ cap
 * cannot be enforced) and records the spend in the global ledger.
 */
export async function callShadowLlm(opts: Parameters<typeof callShadowLlmRaw>[0]): Promise<LlmResult> {
  const day = tradingDateET();
  const gate = llmPersistenceGate("shadow", day);
  if (!gate.ok) throw new Error(gate.reason);
  const res = await callShadowLlmRaw(opts);
  await ledgerAdd("shadow", day, res.usage.costUsd).catch(() => 0);
  return res;
}

async function callShadowLlmRaw(opts: {
  module: string;
  system: string;
  user: string;
  search?: { web?: boolean; x?: boolean; fromDate?: string; maxTurns?: number };
  model?: string;
  timeoutMs?: number;
}): Promise<LlmResult> {
  const cfg = shadowLlmConfig();
  if (!cfg) throw new Error("no-key");
  if (opts.search && !cfg.searchEnabled) throw new Error("search-unavailable");
  const model = opts.model ?? (opts.search ? cfg.searchModel : cfg.model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  try {
    if (cfg.provider === "xai") {
      const tools: Record<string, unknown>[] = [];
      if (opts.search?.web !== false && opts.search) tools.push({ type: "web_search" });
      if (opts.search?.x) tools.push({ type: "x_search", ...(opts.search.fromDate ? { from_date: opts.search.fromDate } : {}) });
      const body: Record<string, unknown> = {
        model,
        store: false,
        input: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        text: { format: { type: "json_object" } },
      };
      if (!/non-reasoning/.test(model) && cfg.reasoningEffort) body.reasoning = { effort: cfg.reasoningEffort };
      if (tools.length) {
        body.tools = tools;
        body.max_turns = opts.search?.maxTurns ?? 2;
        // Force at least one search — otherwise the model may answer from stale training data.
        body.tool_choice = "required";
      }
      const response = await fetch(`${cfg.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`xai ${response.status}: ${raw.slice(0, 200)}`);
      const json = JSON.parse(raw) as ResponsesBody;
      let text = "";
      const sources = new Set<string>();
      for (const item of json.output ?? []) {
        if (item.type !== "message") continue;
        for (const c of item.content ?? []) {
          if (c.text) text += c.text;
          for (const a of c.annotations ?? []) if (a.type === "url_citation" && a.url) sources.add(a.url);
        }
      }
      const u = json.usage ?? {};
      const inTok = u.input_tokens ?? 0;
      const cached = u.input_tokens_details?.cached_tokens ?? 0;
      const outTok = u.output_tokens ?? 0;
      const tools2 = u.server_side_tool_usage_details ?? {};
      const web = tools2.web_search_calls ?? 0;
      const posts = tools2.x_posts_fetched ?? 0;
      const provided = typeof u.cost_in_usd_ticks === "number" && u.cost_in_usd_ticks > 0;
      return {
        text,
        sources: [...sources].slice(0, 12),
        usage: {
          module: opts.module,
          at: new Date().toISOString(),
          model,
          inputTokens: inTok,
          cachedTokens: cached,
          outputTokens: outTok,
          reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
          webSearchCalls: web,
          xSearchCalls: tools2.x_search_calls ?? 0,
          xPostsFetched: posts,
          // xAI reports cost in 1e-10 USD ticks.
          costUsd: provided ? (u.cost_in_usd_ticks as number) / 1e10 : estimateCost(model, inTok, cached, outTok, web, posts),
          costSource: provided ? "provider" : "estimate",
          ms: Date.now() - started,
        },
      };
    }
    if (cfg.provider === "anthropic") {
      const response = await fetch(`${cfg.baseUrl}/messages`, {
        method: "POST",
        headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 2500, temperature: 0.2, system: opts.system, messages: [{ role: "user", content: opts.user }] }),
        signal: controller.signal,
        cache: "no-store",
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`anthropic ${response.status}: ${raw.slice(0, 200)}`);
      const json = JSON.parse(raw) as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      const inTok = json.usage?.input_tokens ?? 0;
      const outTok = json.usage?.output_tokens ?? 0;
      return {
        text: (json.content ?? []).map((c) => c.text ?? "").join(""),
        sources: [],
        usage: blankUsage(opts.module, model, inTok, outTok, (inTok * 3 + outTok * 15) / 1e6, Date.now() - started),
      };
    }
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${cfg.provider} ${response.status}: ${raw.slice(0, 200)}`);
    const json = JSON.parse(raw) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const inTok = json.usage?.prompt_tokens ?? 0;
    const outTok = json.usage?.completion_tokens ?? 0;
    return {
      text: json.choices?.[0]?.message?.content ?? "",
      sources: [],
      usage: blankUsage(opts.module, model, inTok, outTok, (inTok * 0.4 + outTok * 1.6) / 1e6, Date.now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}

function blankUsage(module: string, model: string, inTok: number, outTok: number, cost: number, ms: number): LlmUsageRecord {
  return {
    module,
    at: new Date().toISOString(),
    model,
    inputTokens: inTok,
    cachedTokens: 0,
    outputTokens: outTok,
    reasoningTokens: 0,
    webSearchCalls: 0,
    xSearchCalls: 0,
    xPostsFetched: 0,
    costUsd: cost,
    costSource: "estimate",
    ms,
  };
}

export function parseJsonObject<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Daily LLM budget for all shadow modules combined (brief + release reads + per-candidate). */
export function dailyBudgetUsd(): number {
  const v = Number(process.env.SHADOW_LLM_DAILY_USD);
  return Number.isFinite(v) && v > 0 ? v : 1;
}
