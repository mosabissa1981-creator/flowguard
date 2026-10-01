import "server-only";

import { kvBackend, kvDurable, kvGetNumber, kvIncrFloat } from "@/lib/kv";

/**
 * Global LLM spend ledger (Redis INCRBYFLOAT) so the $/day caps hold across every serverless instance.
 * Without a durable store, LLM calls are refused (the caps could not be enforced globally), unless
 * LLM_ALLOW_WITHOUT_STORE=1, which allows a conservative per-instance cap (LLM_INSTANCE_CAP_USD, default $0.25).
 */

export type LedgerScope = "shadow" | "ai-picks";

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
