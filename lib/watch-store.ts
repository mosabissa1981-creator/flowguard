import "server-only";

import { put, list } from "@vercel/blob";

import { isPriceWatch } from "@/lib/price-watches";
import type { PriceWatch } from "@/lib/types";

const BLOB_PATH = "flowguard/watches.json";

function blobToken(): string {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "";
}

export async function loadStoredWatches(): Promise<PriceWatch[]> {
  const token = blobToken();
  if (!token) return [];

  try {
    const { blobs } = await list({ prefix: BLOB_PATH, limit: 1 });
    const url = blobs[0]?.url;
    if (!url) return [];

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) return [];
    const parsed = (await response.json()) as { watches?: unknown };
    return Array.isArray(parsed.watches) ? parsed.watches.filter(isPriceWatch) : [];
  } catch {
    return [];
  }
}

export async function saveStoredWatches(watches: PriceWatch[]): Promise<boolean> {
  const token = blobToken();
  if (!token) return false;

  try {
    const payload = JSON.stringify({ watches, updatedAt: new Date().toISOString() });
    await put(BLOB_PATH, payload, {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
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
