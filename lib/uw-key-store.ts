import "server-only";

import { put, list, del } from "@vercel/blob";

const BLOB_PREFIX = "flowguard/uw-key-";

function blobToken(): string {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "";
}

export async function loadStoredUwKey(): Promise<string> {
  const token = blobToken();
  if (!token) return "";

  try {
    const { blobs } = await list({ prefix: BLOB_PREFIX, limit: 5 });
    if (blobs.length === 0) return "";
    const latest = [...blobs].sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    )[0];
    const response = await fetch(latest.url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) return "";
    const parsed = (await response.json()) as { key?: unknown };
    return typeof parsed.key === "string" ? parsed.key.trim() : "";
  } catch {
    return "";
  }
}

export async function saveStoredUwKey(key: string): Promise<boolean> {
  const token = blobToken();
  const trimmed = key.trim();
  if (!token || trimmed.length < 8) return false;

  const path = `${BLOB_PREFIX}${Date.now()}.json`;
  await put(path, JSON.stringify({ updatedAt: new Date().toISOString(), key: trimmed }), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });

  try {
    const { blobs } = await list({ prefix: BLOB_PREFIX, limit: 20 });
    const sorted = [...blobs].sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    );
    const stale = sorted.slice(2);
    if (stale.length > 0) {
      await Promise.all(stale.map((b) => del(b.url).catch(() => {}))).catch(() => {});
    }
  } catch {
    // Keep the new key even if old blobs cannot be pruned.
  }

  return true;
}
