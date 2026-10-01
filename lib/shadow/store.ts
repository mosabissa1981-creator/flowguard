import "server-only";

import { blobProbe, kvBackend, kvDurable, kvGet, kvHealth, kvSet } from "@/lib/kv";

/**
 * Tiny JSON document store for shadow / test-lane output, on top of lib/kv (Upstash Redis when configured,
 * Blob-lite or memory otherwise). Keys: flowguard/shadow/<kind>-<day>.json (same paths as the legacy Blob docs,
 * which are copied in once on a Redis miss).
 * Lane books (day = "book") are tier "rare" (written once per logged pick / tracking update); the rest are "hot".
 */

const PREFIX = "flowguard/shadow/";
const HYDRATE_MS = 60_000;

export function docPath(kind: string, day: string): string {
  return `${PREFIX}${kind}-${day}.json`;
}

export async function loadDoc<T>(kind: string, day: string, opts: { fresh?: boolean } = {}): Promise<T | null> {
  return kvGet<T>(docPath(kind, day), { maxAgeMs: opts.fresh ? 3_000 : HYDRATE_MS, blobFallback: day === "book" });
}

export async function saveDoc(kind: string, day: string, value: unknown): Promise<void> {
  const rare = day === "book";
  await kvSet(docPath(kind, day), value, { tier: rare ? "rare" : "hot", ttlSec: rare ? undefined : 45 * 86400 });
}

export function persistenceMode(): string {
  const b = kvBackend();
  return kvDurable() ? b : `${b} (not durable)`;
}

/** Admin diagnostic: active backend round trip + legacy Blob probe (one GET; optional one put). */
export async function storeHealth(opts: { blobWrite?: boolean } = {}) {
  return { kv: await kvHealth(), legacyBlob: await blobProbe({ write: opts.blobWrite }) };
}
