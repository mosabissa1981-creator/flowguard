import "server-only";

import { kvGet, kvSet } from "@/lib/kv";

import type { FlowAlert, TideSnapshot } from "@/lib/types";

import { TAPE_CACHE_MS } from "@/lib/refresh";

const CIRCUIT_KEY = "flowguard/uw-circuit.json";
const TAPE_KEY = "flowguard/uw-tape.json";
const MORNING_PREFIX = "flowguard/morning-";
/** Shared tape is written at most every 5 min and re-read from the store at most every 2 min per instance. */
const TAPE_WRITE_GAP_MS = 5 * 60_000;
const TAPE_READ_GAP_MS = 2 * 60_000;
const CIRCUIT_READ_GAP_MS = 60_000;

export const FLOW_TTL_MS = TAPE_CACHE_MS;
export const TIDE_TTL_MS = TAPE_CACHE_MS;
export const STOCK_STATE_TTL_MS = TAPE_CACHE_MS;
export const NET_PREM_TTL_MS = 5 * 60_000;
export const QUOTE_TTL_MS = 15 * 60_000;
/** Same 15-min bucket as quotes — historic rides the watch-check path, not the board poll. */
export const HISTORIC_TTL_MS = QUOTE_TTL_MS;
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

export async function getCircuit(): Promise<Circuit | null> {
  const now = Date.now();
  if (memCircuit?.open && now < memCircuit.untilMs) return memCircuit;
  if (memCircuit?.open && now >= memCircuit.untilMs) {
    memCircuit = { ...memCircuit, open: false };
    return null;
  }
  if (now - circuitCheckedAt < CIRCUIT_READ_GAP_MS) {
    return memCircuit?.open && now < memCircuit.untilMs ? memCircuit : null;
  }
  circuitCheckedAt = now;
  const fromBlob = await kvGet<Circuit>(CIRCUIT_KEY, { maxAgeMs: CIRCUIT_READ_GAP_MS });
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

export async function tripUwQuota(detail: string, untilMs = quotaResetUtcMs()): Promise<number> {
  memCircuit = {
    open: true,
    untilMs,
    reason: detail.slice(0, 240),
    trippedAt: new Date().toISOString(),
  };
  circuitCheckedAt = Date.now();
  void kvSet(CIRCUIT_KEY, memCircuit, { tier: "hot", ttlSec: Math.max(60, Math.round((untilMs - Date.now()) / 1000) + 3600) }).catch(() => {});
  return untilMs;
}

export function rememberTape(alerts: FlowAlert[], tide: TideSnapshot | null): CachedTape {
  memTape = { savedAt: new Date().toISOString(), alerts, tide };
  if (Date.now() - lastTapeWrite > TAPE_WRITE_GAP_MS) {
    lastTapeWrite = Date.now();
    void kvSet(TAPE_KEY, memTape, { tier: "hot", ttlSec: 3 * 86400 }).catch(() => {});
  }
  return memTape;
}

export async function getFreshTape(ttlMs = FLOW_TTL_MS): Promise<CachedTape | null> {
  const now = Date.now();
  if (memTape && now - Date.parse(memTape.savedAt) < ttlMs) return memTape;
  const blob = await kvGet<CachedTape>(TAPE_KEY, { maxAgeMs: TAPE_READ_GAP_MS });
  if (blob?.savedAt && now - Date.parse(blob.savedAt) < ttlMs && Array.isArray(blob.alerts)) {
    memTape = blob;
    return blob;
  }
  if (blob?.alerts?.length && !memTape) memTape = blob;
  return null;
}

export async function loadLastGoodTape(): Promise<CachedTape | null> {
  if (memTape?.alerts?.length) return memTape;
  const blob = await kvGet<CachedTape>(TAPE_KEY, { maxAgeMs: TAPE_READ_GAP_MS });
  if (blob?.alerts?.length) {
    memTape = blob;
    return blob;
  }
  return memTape;
}

export async function loadMorningSnapshot<T>(date: string): Promise<T | null> {
  return kvGet<T>(`${MORNING_PREFIX}${date}.json`, { maxAgeMs: 5 * 60_000 });
}

export async function saveMorningSnapshot(date: string, payload: unknown): Promise<void> {
  await kvSet(`${MORNING_PREFIX}${date}.json`, payload, { tier: "rare", ttlSec: 4 * 86400, minGapMs: 10 * 60_000 }).catch(() => false);
}
