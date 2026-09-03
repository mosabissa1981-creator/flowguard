import "server-only";

import { put, list, del } from "@vercel/blob";

import { isPriceWatch } from "@/lib/price-watches";
import type { PriceWatch } from "@/lib/types";

const BLOB_PREFIX = "flowguard/watches-";

function blobToken(): string {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "";
}

export async function loadStoredWatches(): Promise<PriceWatch[]> {
  const token = blobToken();
  if (!token) return [];

  const { blobs } = await list({ prefix: BLOB_PREFIX, limit: 5 });
  if (blobs.length === 0) return [];

  const sorted = [...blobs].sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
  );
  const latest = sorted[0];

  const response = await fetch(latest.url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) return [];
  const parsed = (await response.json()) as { watches?: unknown };
  return Array.isArray(parsed.watches) ? parsed.watches.filter(isPriceWatch) : [];
}

export async function saveStoredWatches(watches: PriceWatch[]): Promise<boolean> {
  const token = blobToken();
  if (!token) return false;

  const payload = JSON.stringify({ watches, updatedAt: new Date().toISOString() });
  const path = `${BLOB_PREFIX}${Date.now()}.json`;

  await put(path, payload, {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });

  const { blobs } = await list({ prefix: BLOB_PREFIX, limit: 20 });
  const sorted = [...blobs].sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
  );
  const stale = sorted.slice(2);
  if (stale.length > 0) {
    await Promise.all(stale.map((b) => del(b.url).catch(() => {}))).catch(() => {});
  }

  return true;
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
