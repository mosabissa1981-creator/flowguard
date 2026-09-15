import "server-only";

import { put, list } from "@vercel/blob";

/** One lock-screen ping per watch+status per hour. */
export const NOTIFY_DEDUPE_MS = 60 * 60_000;

const BLOB_PREFIX = "flowguard/notify-dedupe-";
const mem = new Map<string, number>();
let blobLoadedAt = 0;

function blobToken(): string {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "";
}

async function hydrate(): Promise<void> {
  if (Date.now() - blobLoadedAt < 15_000) return;
  blobLoadedAt = Date.now();
  const token = blobToken();
  if (!token) return;
  try {
    const { blobs } = await list({ prefix: BLOB_PREFIX, limit: 3 });
    if (blobs.length === 0) return;
    const latest = [...blobs].sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    )[0];
    const response = await fetch(latest.url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) return;
    const parsed = (await response.json()) as { fired?: Record<string, number> };
    if (!parsed.fired) return;
    const now = Date.now();
    for (const [key, at] of Object.entries(parsed.fired)) {
      if (typeof at === "number" && now - at < NOTIFY_DEDUPE_MS) mem.set(key, at);
    }
  } catch {
    // Memory map still dedupes on this instance.
  }
}

async function persist(): Promise<void> {
  const token = blobToken();
  if (!token) return;
  const now = Date.now();
  const fired: Record<string, number> = {};
  for (const [key, at] of mem) {
    if (now - at < NOTIFY_DEDUPE_MS) fired[key] = at;
  }
  try {
    await put(`${BLOB_PREFIX}${Date.now()}.json`, JSON.stringify({ fired, updatedAt: new Date().toISOString() }), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
  } catch {
    // Dedupe still holds in memory for warm instances.
  }
}

/** Returns true if this key has not fired in the last 60 minutes. */
export async function claimNotifySlot(key: string, now = Date.now()): Promise<boolean> {
  await hydrate();
  const prev = mem.get(key);
  if (prev && now - prev < NOTIFY_DEDUPE_MS) return false;
  mem.set(key, now);
  void persist();
  return true;
}
