import "server-only";

import { kvGet, kvSet } from "@/lib/kv";

import { isPriceWatch } from "@/lib/price-watches";
import type { PriceWatch } from "@/lib/types";

const KEY = "flowguard/watches.json";
const EXPIRED_KEY = "flowguard/watches-expired.json";

export async function loadStoredWatches(): Promise<PriceWatch[]> {
  const parsed = await kvGet<{ watches?: unknown }>(KEY, { maxAgeMs: 30_000 });
  return Array.isArray(parsed?.watches) ? parsed.watches.filter(isPriceWatch) : [];
}

export async function saveStoredWatches(watches: PriceWatch[]): Promise<boolean> {
  return kvSet(KEY, { watches, updatedAt: new Date().toISOString() }, { tier: "rare" });
}

export async function upsertStoredWatch(watch: PriceWatch): Promise<PriceWatch[]> {
  const current = await loadStoredWatches();
  const next = [...current.filter((item) => item.id !== watch.id), watch];
  await saveStoredWatches(next);
  return next;
}

export async function removeStoredWatch(id: string): Promise<PriceWatch[]> {
  const next = (await loadStoredWatches()).filter((item) => item.id !== id);
  await saveStoredWatches(next);
  return next;
}

export async function removeStoredWatches(ids: string[]): Promise<PriceWatch[]> {
  if (ids.length === 0) return loadStoredWatches();
  const drop = new Set(ids);
  const next = (await loadStoredWatches()).filter((item) => !drop.has(item.id));
  await saveStoredWatches(next);
  return next;
}

export async function archiveExpiredWatches(
  rows: { watch: PriceWatch; reason: string; pctMove: number | null }[],
): Promise<void> {
  if (rows.length === 0) return;
  const prev = (await kvGet<{ watches?: unknown[] }>(EXPIRED_KEY, { maxAgeMs: 60_000 }))?.watches ?? [];
  const archivedAt = new Date().toISOString();
  const added = rows.map((row) => ({ ...row.watch, expireReason: row.reason, pctMove: row.pctMove, archivedAt }));
  // Best-effort archive (last 200). The armed book prune is what stops study losers.
  await kvSet(EXPIRED_KEY, { updatedAt: archivedAt, watches: [...prev, ...added].slice(-200) }, { tier: "rare" });
}
