import "server-only";

import { put, list, del } from "@vercel/blob";

import { isPriceWatch } from "@/lib/price-watches";
import type { PriceWatch } from "@/lib/types";

const BLOB_PATH = "flowguard/watches.json";

async function blobUrl(): Promise<string | null> {
  try {
    const { blobs } = await list({ prefix: BLOB_PATH, limit: 1 });
    return blobs[0]?.url ?? null;
  } catch {
    return null;
  }
}

export async function loadStoredWatches(): Promise<PriceWatch[]> {
  try {
    const url = await blobUrl();
    if (!url) return [];
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return [];
    const parsed = (await response.json()) as { watches?: unknown };
    return Array.isArray(parsed.watches) ? parsed.watches.filter(isPriceWatch) : [];
  } catch {
    return [];
  }
}

export async function saveStoredWatches(watches: PriceWatch[]): Promise<boolean> {
  try {
    const payload = JSON.stringify({ watches, updatedAt: new Date().toISOString() });
    await put(BLOB_PATH, payload, {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
    });
    return true;
  } catch {
    return false;
  }
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
