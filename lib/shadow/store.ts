import "server-only";

import { list, put } from "@vercel/blob";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Tiny JSON document store for shadow output: Vercel Blob (private) when BLOB_READ_WRITE_TOKEN is set,
 * a local directory when SHADOW_LOCAL_DIR is set (local tests), else per-instance memory.
 * Paths: flowguard/shadow/<kind>-YYYY-MM-DD.json
 */

const PREFIX = "flowguard/shadow/";
const HYDRATE_MS = 20_000;

const mem = new Map<string, { at: number; value: unknown }>();

function blobToken(): string {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "";
}

function localDir(): string {
  return process.env.SHADOW_LOCAL_DIR?.trim() ?? "";
}

export function docPath(kind: string, day: string): string {
  return `${PREFIX}${kind}-${day}.json`;
}

export async function loadDoc<T>(kind: string, day: string, opts: { fresh?: boolean } = {}): Promise<T | null> {
  const p = docPath(kind, day);
  const hit = mem.get(p);
  if (hit && !opts.fresh && Date.now() - hit.at < HYDRATE_MS) return hit.value as T;
  const dir = localDir();
  if (dir) {
    try {
      const text = await fs.readFile(path.join(dir, `${kind}-${day}.json`), "utf8");
      const value = JSON.parse(text) as T;
      mem.set(p, { at: Date.now(), value });
      return value;
    } catch {
      return (hit?.value as T) ?? null;
    }
  }
  const token = blobToken();
  if (!token) return (hit?.value as T) ?? null;
  try {
    const { blobs } = await list({ prefix: p, limit: 2 });
    const blob = blobs.find((b) => b.pathname === p);
    if (!blob) return (hit?.value as T) ?? null;
    const response = await fetch(blob.url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!response.ok) return (hit?.value as T) ?? null;
    const value = (await response.json()) as T;
    mem.set(p, { at: Date.now(), value });
    return value;
  } catch {
    return (hit?.value as T) ?? null;
  }
}

export async function saveDoc(kind: string, day: string, value: unknown): Promise<void> {
  const p = docPath(kind, day);
  mem.set(p, { at: Date.now(), value });
  const dir = localDir();
  if (dir) {
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${kind}-${day}.json`), JSON.stringify(value, null, 2));
    } catch {
      // memory copy still serves this process
    }
    return;
  }
  if (!blobToken()) return;
  try {
    await put(p, JSON.stringify(value), {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
  } catch {
    // Blob suspended / over quota — memory still guards warm instances.
  }
}

export function persistenceMode(): "local" | "blob" | "memory" {
  if (localDir()) return "local";
  if (blobToken()) return "blob";
  return "memory";
}
