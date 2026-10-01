import "server-only";

import { list, put } from "@vercel/blob";

import type { AiPicksResponse } from "@/lib/types";

/**
 * Persistent cost guard for the AI review. One small JSON blob shared by every serverless instance
 * (falls back to per-instance memory when Blob is unavailable). Tracks the last LLM attempt so the
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
};

const BLOB_PATH = "flowguard/ai-picks-state.json";
const BLOB_PREFIX = "flowguard/ai-picks-state";
const HYDRATE_MS = 30_000;

let mem: AiPicksState | null = null;
let hydratedAt = 0;

function blobToken(): string {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "";
}

export async function loadAiPicksState(): Promise<AiPicksState | null> {
  if (Date.now() - hydratedAt < HYDRATE_MS) return mem;
  hydratedAt = Date.now();
  const token = blobToken();
  if (!token) return mem;
  try {
    const { blobs } = await list({ prefix: BLOB_PREFIX, limit: 3 });
    const blob = blobs.find((b) => b.pathname === BLOB_PATH) ?? blobs[0];
    if (!blob) return mem;
    const response = await fetch(blob.url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!response.ok) return mem;
    const parsed = (await response.json()) as AiPicksState;
    if (parsed && typeof parsed.day === "string" && typeof parsed.attemptAt === "number") {
      // Keep whichever copy is newer (this instance may have just written).
      if (!mem || parsed.attemptAt >= mem.attemptAt) mem = parsed;
    }
  } catch {
    // Memory copy still guards this instance.
  }
  return mem;
}

export async function saveAiPicksState(next: AiPicksState): Promise<void> {
  mem = next;
  hydratedAt = Date.now();
  if (!blobToken()) return;
  try {
    await put(BLOB_PATH, JSON.stringify(next), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
  } catch {
    // Store suspended/over quota — memory still throttles warm instances.
  }
}
