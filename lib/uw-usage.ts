import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { kvGet, kvHgetAll, kvHincrMany, kvSet } from "@/lib/kv";
import { tradingDateET } from "@/lib/session";

/**
 * UW usage meter + budget guard.
 * - Every UW request is attributed to a job (AsyncLocalStorage; default "site") and counted per UW day.
 * - The UW day resets 8 PM ET (= 7 PM CT): day key = ET date of (now + 4h).
 * - UW's own `x-uw-daily-req-count` (whole token: site + box backfill + jobs) is tracked as the truth.
 * - Shadow/test jobs stop at UW_JOBS_STOP_AT (default 35,000) so ~2,500 stay in reserve for the live
 *   site under the 37,500/day ceiling.
 */
export const UW_DAY_CEILING = 37_500;
export const UW_JOBS_STOP_AT = (() => {
  const v = Number(process.env.UW_JOBS_STOP_AT);
  return Number.isFinite(v) && v > 0 ? Math.min(v, UW_DAY_CEILING) : 35_000;
})();

export type UwJob = "site" | "fade-watch" | "chain-scan" | "follow-through" | "gap-chase" | "paper" | "shadow-signals" | string;

const als = new AsyncLocalStorage<{ job: UwJob }>();
export function runAsUwJob<T>(job: UwJob, fn: () => Promise<T>): Promise<T> {
  return als.run({ job }, fn);
}
export function currentUwJob(): UwJob {
  return als.getStore()?.job ?? "site";
}

export function uwDayKey(now = new Date()): string {
  return tradingDateET(new Date(now.getTime() + 4 * 3600_000));
}

const HASH = (day: string) => `flowguard/uw-usage/${day}`;
const COUNT_KEY = "flowguard/uw-count.json";
const FLUSH_MS = 20_000;

let pending: { day: string; deltas: Record<string, number> } = { day: "", deltas: {} };
let lastFlush = 0;
let latest: { day: string; count: number; at: string } | null = null;
let latestReadAt = 0;
let lastCountWrite = 0;

export class UwBudgetError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "UwBudgetError";
  }
}

/** Called after every UW response (any status). `tokenCount` = x-uw-daily-req-count when present. */
export function recordUwCall(tokenCount: number | null): void {
  const day = uwDayKey();
  if (pending.day !== day) pending = { day, deltas: {} };
  const job = currentUwJob();
  pending.deltas[job] = (pending.deltas[job] ?? 0) + 1;
  if (tokenCount != null && Number.isFinite(tokenCount)) {
    if (!latest || latest.day !== day || tokenCount >= latest.count) latest = { day, count: tokenCount, at: new Date().toISOString() };
  }
  if (Date.now() - lastFlush >= FLUSH_MS) void flushUwUsage();
}

export async function flushUwUsage(): Promise<void> {
  lastFlush = Date.now();
  const batch = pending;
  pending = { day: batch.day, deltas: {} };
  if (batch.day && Object.keys(batch.deltas).length) {
    const ok = await kvHincrMany(HASH(batch.day), batch.deltas, 10 * 86400).catch(() => false);
    if (!ok) for (const [k, n] of Object.entries(batch.deltas)) pending.deltas[k] = (pending.deltas[k] ?? 0) + n;
  }
  if (latest && Date.now() - lastCountWrite >= FLUSH_MS) {
    lastCountWrite = Date.now();
    await kvSet(COUNT_KEY, latest, { tier: "hot", ttlSec: 3 * 86400 }).catch(() => false);
  }
}

let ownCounted: { day: string; sum: number } | null = null;

/**
 * Best known whole-token UW count for the current UW day (refreshed from Redis at most every 30 s).
 * UW stopped sending `x-uw-daily-req-count` on Oct 7 2026 (only per-minute headers), so this is the larger of
 * the last header value and our own per-job counter (all Vercel-side calls) plus unflushed local calls.
 */
export async function uwTokenCount(): Promise<number> {
  const day = uwDayKey();
  if (Date.now() - latestReadAt > 30_000) {
    latestReadAt = Date.now();
    const [stored, byJob] = await Promise.all([
      kvGet<{ day: string; count: number; at: string }>(COUNT_KEY, { maxAgeMs: 30_000 }),
      kvHgetAll(HASH(day)).catch((): Record<string, number> => ({})),
    ]);
    if (stored?.day === day && (!latest || latest.day !== day || stored.count > latest.count)) latest = stored;
    ownCounted = { day, sum: Object.values(byJob).reduce((a, b) => a + b, 0) };
  }
  const header = latest?.day === day ? latest.count : 0;
  const local = pending.day === day ? Object.values(pending.deltas).reduce((a, b) => a + b, 0) : 0;
  const own = (ownCounted?.day === day ? ownCounted.sum : 0) + local;
  return Math.max(header, own);
}

/** True when shadow/test jobs may still spend UW calls (whole-token count under UW_JOBS_STOP_AT). */
export async function uwJobBudgetOk(reserveCalls = 0): Promise<boolean> {
  return (await uwTokenCount()) + reserveCalls < UW_JOBS_STOP_AT;
}

export async function uwUsageView(day = uwDayKey()) {
  await flushUwUsage().catch(() => undefined);
  const byJob = await kvHgetAll(HASH(day));
  const counted = Object.values(byJob).reduce((s, n) => s + n, 0);
  const token = day === uwDayKey() ? Math.max(await uwTokenCount(), counted) : null;
  const headerCount = day === uwDayKey() && latest?.day === day ? latest.count : null;
  return {
    day,
    resetsAt: "8:00 PM ET (7:00 PM CT)",
    tokenCount: token,
    /** Last x-uw-daily-req-count seen (UW stopped sending it Oct 7 2026; tokenCount then falls back to our own count). */
    headerCount,
    ceiling: UW_DAY_CEILING,
    jobsStopAt: UW_JOBS_STOP_AT,
    siteReserve: UW_DAY_CEILING - UW_JOBS_STOP_AT,
    countedBySite: counted,
    /** Calls on the token not made by the Vercel app (box history backfill, study routine, manual). */
    otherOrBox: token != null ? Math.max(0, token - counted) : null,
    byJob,
    note: "byJob counts Vercel-side UW requests (cache hits excluded). tokenCount = max(UW's x-uw-daily-req-count header when sent, our own count). Box backfill calls are only included via the header.",
  };
}
