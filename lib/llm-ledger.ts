import "server-only";

import { kvBackend, kvDurable, kvGetNumber, kvIncrFloat } from "@/lib/kv";

/**
 * Global LLM spend ledger (Redis INCRBYFLOAT) so the $/day caps hold across every serverless instance.
 * Without a durable store, LLM calls are refused (the caps could not be enforced globally), unless
 * LLM_ALLOW_WITHOUT_STORE=1, which allows a conservative per-instance cap (LLM_INSTANCE_CAP_USD, default $0.25).
 */

/** "grok-wide" = TEST-mode Grok wide pool (own $ cap, FLOWGUARD_GROK_WIDE_USD); never shares the shadow budget. */
/** "grok-gex-dex" = TEST-mode GEX/DEX Grok shadow lane (own $ cap, FLOWGUARD_GROK_GEX_DEX_USD, hard max $1). */
export type LedgerScope = "shadow" | "ai-picks" | "grok-wide" | "grok-gex-dex";

/**
 * Quiet test-mode Grok ledgers that share the owner's $3/day total.
 * Live "ai-picks" is not included. "grok-wide" is the wide-pool lane.
 */
export const TEST_MODE_GROK_SCOPES = ["shadow", "grok-wide", "grok-gex-dex"] as const satisfies readonly LedgerScope[];

/** Owner cap on today's quiet test-mode Grok spend (shadow + wide-pool + gex-dex). */
export const TEST_MODE_GROK_DAY_CAP_USD = 3;

const instanceSpend = new Map<string, number>();

function instanceCap(): number {
  const v = Number(process.env.LLM_INSTANCE_CAP_USD);
  return Number.isFinite(v) && v > 0 ? v : 0.25;
}

const key = (scope: LedgerScope, day: string) => `flowguard/llm-spend/${scope}-${day}`;

export function llmPersistenceGate(scope: LedgerScope, day: string): { ok: true } | { ok: false; reason: string } {
  if (kvDurable()) return { ok: true };
  if (process.env.LLM_ALLOW_WITHOUT_STORE?.trim() === "1") {
    const spent = instanceSpend.get(`${scope}|${day}`) ?? 0;
    return spent < instanceCap() ? { ok: true } : { ok: false, reason: `per-instance LLM cap $${instanceCap().toFixed(2)} reached (no durable store)` };
  }
  return {
    ok: false,
    reason: `persistence down (backend: ${kvBackend()}): LLM calls paused so the daily $ cap cannot be exceeded across instances`,
  };
}

export async function ledgerSpend(scope: LedgerScope, day: string): Promise<number> {
  if (!kvDurable()) return instanceSpend.get(`${scope}|${day}`) ?? 0;
  return kvGetNumber(key(scope, day), 5_000);
}

export async function ledgerAdd(scope: LedgerScope, day: string, usd: number): Promise<number> {
  if (!(usd > 0)) return ledgerSpend(scope, day);
  const k = `${scope}|${day}`;
  instanceSpend.set(k, (instanceSpend.get(k) ?? 0) + usd);
  return kvIncrFloat(key(scope, day), usd, 4 * 86400);
}

/**
 * Sum of today's spend across the quiet test-mode Grok scopes.
 * `gexDexFloor` is the gex-dex lane's own counter, used when it is ahead of the ledger.
 */
export async function testModeGrokSpend(day: string, gexDexFloor = 0): Promise<number> {
  const parts = await Promise.all(
    TEST_MODE_GROK_SCOPES.map(async (scope) => {
      const n = await ledgerSpend(scope, day);
      return scope === "grok-gex-dex" ? Math.max(n, gexDexFloor) : n;
    }),
  );
  return Math.round(parts.reduce((sum, n) => sum + n, 0) * 10000) / 10000;
}

/**
 * False when `spentUsd` is already at or above the $3 quiet-test total, or when adding `batchUsd` would go over it.
 * A non-positive batch estimate does not fit — the caller passes a pre-call ceiling, since provider cost lands after the call.
 */
export function testModeGrokBatchFits(spentUsd: number, batchUsd: number): boolean {
  if (!Number.isFinite(spentUsd) || !Number.isFinite(batchUsd) || !(batchUsd > 0)) return false;
  const spent = Math.round(spentUsd * 10000) / 10000;
  if (spent >= TEST_MODE_GROK_DAY_CAP_USD) return false;
  return Math.round((spent + batchUsd) * 10000) / 10000 <= TEST_MODE_GROK_DAY_CAP_USD;
}
