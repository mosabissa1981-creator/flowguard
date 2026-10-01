import "server-only";

import { kvGet, kvSet } from "@/lib/kv";

import type { AiPicksResponse } from "@/lib/types";

/**
 * Persistent cost guard for the AI review. One small JSON value shared by every serverless instance
 * via lib/kv (Redis; per-instance memory when no durable store). Tracks the last LLM attempt so the
 * model runs at most once per LLM_MIN_INTERVAL_MS per trading day, and only when candidates change.
 */
export type AiPicksState = {
  day: string;
  /** Candidate fingerprint the stored value was produced for. */
  candKey: string;
  /** Last time an LLM call was started (success or failure), epoch ms. */
  attemptAt: number;
  /** Last successful LLM answer for `day`, if any. */
  value: AiPicksResponse | null;
  valueKey: string;
  valueAt: number;
  lastError?: string;
  /** AI-review LLM spend (USD) accumulated for `day`; capped by AI_PICKS_DAILY_USD (default $1). */
  spendUsd?: number;
};

const KEY = "flowguard/ai-picks-state.json";
const HYDRATE_MS = 30_000;

export async function loadAiPicksState(): Promise<AiPicksState | null> {
  const parsed = await kvGet<AiPicksState>(KEY, { maxAgeMs: HYDRATE_MS, blobFallback: true });
  return parsed && typeof parsed.day === "string" && typeof parsed.attemptAt === "number" ? parsed : null;
}

export async function saveAiPicksState(next: AiPicksState): Promise<void> {
  await kvSet(KEY, next, { tier: "hot", ttlSec: 7 * 86400 });
}
