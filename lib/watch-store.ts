import "server-only";

import { put, list, del } from "@vercel/blob";

import { isPriceWatch } from "@/lib/price-watches";
import type { PriceWatch } from "@/lib/types";

const BLOB_PREFIX = "flowguard/watches-";
const EXPIRED_PREFIX = "flowguard/watches-expired-";

type RuntimeBook = { at: number; watches: PriceWatch[] };

let runtimeBook: RuntimeBook | null = null;

function blobToken(): string {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "";
}

async function readLatestJson<T>(prefix: string): Promise<T | null> {
  const token = blobToken();
  if (!token) return null;
  try {
    const { blobs } = await list({ prefix, limit: 5 });
    if (blobs.length === 0) return null;
    const latest = [...blobs].sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    )[0];
    const response = await fetch(latest.url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export async function loadStoredWatches(): Promise<PriceWatch[]> {
  if (runtimeBook) return runtimeBook.watches;
  const parsed = await readLatestJson<{ watches?: unknown }>(BLOB_PREFIX);
  const watches = Array.isArray(parsed?.watches) ? parsed.watches.filter(isPriceWatch) : [];
  runtimeBook = { at: Date.now(), watches };
  return watches;
}

export async function saveStoredWatches(watches: PriceWatch[]): Promise<boolean> {
  runtimeBook = { at: Date.now(), watches };
  const token = blobToken();
  if (!token) return true;

  const payload = JSON.stringify({ watches, updatedAt: new Date().toISOString() });
  const path = `${BLOB_PREFIX}${Date.now()}.json`;

  try {
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
  } catch {
    // Blob can be suspended. Runtime book still drops expired rows this instance.
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
  const token = blobToken();
  if (!token) return;
  try {
    await put(
      `${EXPIRED_PREFIX}${Date.now()}.json`,
      JSON.stringify({
        archivedAt: new Date().toISOString(),
        watches: rows.map((row) => ({
          ...row.watch,
          expireReason: row.reason,
          pctMove: row.pctMove,
        })),
      }),
      {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
        cacheControlMaxAge: 0,
      },
    );
  } catch {
    // Archive is best-effort. The armed book prune is what stops study losers.
  }
}
