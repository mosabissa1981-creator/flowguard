import "server-only";

import { list, put } from "@vercel/blob";

import type { FlowAlert, TideSnapshot } from "@/lib/types";

import { TAPE_CACHE_MS } from "@/lib/refresh";

const CIRCUIT_PREFIX = "flowguard/uw-circuit-";
const TAPE_PREFIX = "flowguard/uw-tape-";
const MORNING_PREFIX = "flowguard/morning-";

export const FLOW_TTL_MS = TAPE_CACHE_MS;
export const TIDE_TTL_MS = TAPE_CACHE_MS;
export const STOCK_STATE_TTL_MS = TAPE_CACHE_MS;
export const NET_PREM_TTL_MS = 5 * 60_000;
export const QUOTE_TTL_MS = 15 * 60_000;
export const CHAIN_TTL_MS = 10 * 60_000;

export class UwQuotaError extends Error {
  readonly status = 429;
  readonly untilMs: number;
  constructor(message: string, untilMs: number) {
    super(message);
    this.name = "UwQuotaError";
    this.untilMs = untilMs;
  }
}

export function isUwQuotaError(error: unknown): error is UwQuotaError {
  return error instanceof UwQuotaError;
}

export function isQuotaHttp(status: number, body: string): boolean {
  if (status === 429) return true;
  return /daily_request_limit_hit|daily request limit/i.test(body);
}

export function quotaResetUtcMs(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export function quotaBanner(untilMs: number, cachedAt?: string | null): string {
  const reset = new Date(untilMs).toISOString().slice(11, 16);
  const snap = cachedAt
    ? ` Showing last live snapshot (${cachedAt}).`
    : " No last-good live tape — this board is empty.";
  return `LIVE DATA DOWN — Unusual Whales daily request cap (40,000). Do not trade this screen.${snap} Cap resets ~${reset} UTC.`;
}

type Circuit = {
  open: boolean;
  untilMs: number;
  reason: string;
  trippedAt: string;
};

export type CachedTape = {
  savedAt: string;
  alerts: FlowAlert[];
  tide: TideSnapshot | null;
};

type MemEntry = { at: number; ttl: number; value: unknown };

const mem = new Map<string, MemEntry>();
const inflight = new Map<string, Promise<unknown>>();

let memCircuit: Circuit | null = null;
let circuitCheckedAt = 0;
let memTape: CachedTape | null = null;
let lastTapeWrite = 0;

function blobToken(): string {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() ?? "";
}

export async function cachedCall<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  bust = false,
): Promise<T> {
  if (!bust) {
    const hit = mem.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value as T;
  }
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const run = fn()
    .then((value) => {
      if (ttlMs > 0) mem.set(key, { at: Date.now(), ttl: ttlMs, value });
      inflight.delete(key);
      return value;
    })
    .catch((error) => {
      inflight.delete(key);
      throw error;
    });
  inflight.set(key, run);
  return run;
}

async function readLatestJson<T>(prefix: string): Promise<T | null> {
  const token = blobToken();
  if (!token) return null;
  try {
    const { blobs } = await list({ prefix, limit: 3 });
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

async function writeJson(prefix: string, payload: unknown): Promise<void> {
  const token = blobToken();
  if (!token) return;
  const path = `${prefix}${Date.now()}.json`;
  await put(path, JSON.stringify(payload), {
    access: "private",
    contentType: "application/json",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 0,
  });
}

export async function getCircuit(): Promise<Circuit | null> {
  const now = Date.now();
  if (memCircuit?.open && now < memCircuit.untilMs) return memCircuit;
  if (memCircuit?.open && now >= memCircuit.untilMs) {
    memCircuit = { ...memCircuit, open: false };
    return null;
  }
  if (now - circuitCheckedAt < 15_000 && memCircuit) {
    return memCircuit.open && now < memCircuit.untilMs ? memCircuit : null;
  }
  circuitCheckedAt = now;
  const fromBlob = await readLatestJson<Circuit>(CIRCUIT_PREFIX);
  if (fromBlob?.open && now < fromBlob.untilMs) {
    memCircuit = fromBlob;
    return fromBlob;
  }
  memCircuit = fromBlob ?? memCircuit;
  return null;
}

export async function isUwBlocked(): Promise<boolean> {
  return (await getCircuit()) != null;
}

export async function tripUwQuota(detail: string): Promise<number> {
  const untilMs = quotaResetUtcMs();
  memCircuit = {
    open: true,
    untilMs,
    reason: detail.slice(0, 240),
    trippedAt: new Date().toISOString(),
  };
  circuitCheckedAt = Date.now();
  void writeJson(CIRCUIT_PREFIX, memCircuit).catch(() => {});
  return untilMs;
}

export function rememberTape(alerts: FlowAlert[], tide: TideSnapshot | null): CachedTape {
  memTape = { savedAt: new Date().toISOString(), alerts, tide };
  if (Date.now() - lastTapeWrite > 60_000) {
    lastTapeWrite = Date.now();
    void writeJson(TAPE_PREFIX, memTape).catch(() => {});
  }
  return memTape;
}

export async function getFreshTape(ttlMs = FLOW_TTL_MS): Promise<CachedTape | null> {
  const now = Date.now();
  if (memTape && now - Date.parse(memTape.savedAt) < ttlMs) return memTape;
  const blob = await readLatestJson<CachedTape>(TAPE_PREFIX);
  if (blob?.savedAt && now - Date.parse(blob.savedAt) < ttlMs && Array.isArray(blob.alerts)) {
    memTape = blob;
    return blob;
  }
  if (blob?.alerts?.length && !memTape) memTape = blob;
  return null;
}

export async function loadLastGoodTape(): Promise<CachedTape | null> {
  if (memTape?.alerts?.length) return memTape;
  const blob = await readLatestJson<CachedTape>(TAPE_PREFIX);
  if (blob?.alerts?.length) {
    memTape = blob;
    return blob;
  }
  return memTape;
}

export async function loadMorningSnapshot<T>(date: string): Promise<T | null> {
  return readLatestJson<T>(`${MORNING_PREFIX}${date}-`);
}

export async function saveMorningSnapshot(date: string, payload: unknown): Promise<void> {
  await writeJson(`${MORNING_PREFIX}${date}-`, payload).catch(() => {});
}
