import "server-only";

import { kvGet, kvSet } from "@/lib/kv";

const KEY = "flowguard/uw-key.json";

export async function loadStoredUwKey(): Promise<string> {
  const parsed = await kvGet<{ key?: unknown }>(KEY, { maxAgeMs: 10 * 60_000 });
  return typeof parsed?.key === "string" ? parsed.key.trim() : "";
}

export async function saveStoredUwKey(key: string): Promise<boolean> {
  const trimmed = key.trim();
  if (trimmed.length < 8) return false;
  return kvSet(KEY, { updatedAt: new Date().toISOString(), key: trimmed }, { tier: "rare" });
}
