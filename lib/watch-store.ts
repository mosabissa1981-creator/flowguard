import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isPriceWatch } from "@/lib/price-watches";
import type { PriceWatch } from "@/lib/types";

function storePaths(): string[] {
  const local = path.join(process.cwd(), "data", "watches.json");
  if (process.env.VERCEL === "1") {
    return ["/tmp/flowguard-watches.json", local];
  }
  return [local, "/tmp/flowguard-watches.json"];
}

async function readFrom(file: string): Promise<PriceWatch[] | null> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { watches?: unknown };
    const list = Array.isArray(parsed.watches) ? parsed.watches.filter(isPriceWatch) : [];
    return list;
  } catch {
    return null;
  }
}

export async function loadStoredWatches(): Promise<PriceWatch[]> {
  for (const file of storePaths()) {
    const list = await readFrom(file);
    if (list) return list;
  }
  return [];
}

export async function saveStoredWatches(watches: PriceWatch[]): Promise<{ persisted: boolean; path: string | null }> {
  const payload = `${JSON.stringify({ watches, updatedAt: new Date().toISOString() }, null, 2)}\n`;
  for (const file of storePaths()) {
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, payload, "utf8");
      return { persisted: true, path: file };
    } catch {
      // Try the next location (Vercel project dir is read-only).
    }
  }
  return { persisted: false, path: null };
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
