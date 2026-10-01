import "server-only";

import { kvGet, kvSet } from "@/lib/kv";

/** One lock-screen ping per watch+status per hour. */
export const NOTIFY_DEDUPE_MS = 60 * 60_000;

const KEY = "flowguard/notify-dedupe.json";

/** Returns true if this key has not fired in the last 60 minutes. */
export async function claimNotifySlot(key: string, now = Date.now()): Promise<boolean> {
  const stored = (await kvGet<{ fired?: Record<string, number> }>(KEY, { maxAgeMs: 15_000 })) ?? {};
  const fired: Record<string, number> = {};
  for (const [k, at] of Object.entries(stored.fired ?? {})) if (typeof at === "number" && now - at < NOTIFY_DEDUPE_MS) fired[k] = at;
  const prev = fired[key];
  if (prev && now - prev < NOTIFY_DEDUPE_MS) return false;
  fired[key] = now;
  await kvSet(KEY, { fired, updatedAt: new Date(now).toISOString() }, { tier: "hot", ttlSec: 2 * 3600 });
  return true;
}
