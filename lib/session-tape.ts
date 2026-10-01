import "server-only";

import { after } from "next/server";

import { kvDurable, kvGet, kvSet, kvSetNx } from "@/lib/kv";
import { isInCurrentSession, sessionOpenUtc, tradingDateET } from "@/lib/session";
import type { FlowAlert } from "@/lib/types";
import { fetchFlowAlertsPage } from "@/lib/uw";

/**
 * Session accumulator: every UW flow alert (≥ $10K premium) since 9:30 ET, deduped by id.
 *
 * The old shared tape was only the newest 400 alerts (~3 min at midday), refreshed every 12 min, so lanes,
 * picks and the AI review only saw a few minutes of the session. This module:
 *  - fetches incrementally: newer_than = newest print already held (one page ≈ 1.5 min of flow at midday),
 *    paging down with older_than until it meets what it already has;
 *  - back-fills holes (cold start mid-session, long gaps) toward the open, a few pages per sync;
 *  - syncs at most every 3 min (1 min while back-filling), ≤ 24 UW pages per sync (back-fill in 5-min chunks,
 *    2 in parallel), one instance at a time (Redis NX lock); syncs run after the response (only a cold
 *    instance with nothing held waits for 3 inline pages);
 *  - stores compact rows (tuples) in 10-minute buckets via lib/kv (Redis when configured, else per-instance memory;
 *    never Blob). Closed buckets are immutable, so each instance downloads them once.
 *
 * Expected UW calls/trading day ≈ (session alerts / 200) + 1 per sync ≈ 250–350 (≈ 0.8% of the 40K cap).
 */

const MIN_PREMIUM = 10_000;
const PAGE = 200;
const SYNC_MS = 3 * 60_000;
const FORCE_MIN_MS = 30_000;
/** Pages per sync: the top gap first (usually 1–2 pages), then back-fill. */
const MAX_PAGES_PER_SYNC = 24;
/** Cold request with nothing held: only this many pages inline, the rest back-fills in the background. */
const COLD_INLINE_PAGES = 3;
const BACKFILL_SYNC_MS = 60_000;
const BACKFILL_CHUNK_MS = 5 * 60_000;
const BACKFILL_CONCURRENCY = 2;
const BUCKET_MS = 10 * 60_000;
const META_MAX_AGE_MS = 30_000;
const TTL_SEC = 2 * 86400;

const FIELDS = [
  "id", "created_at", "ticker", "option_chain", "type", "strike", "expiry", "price", "underlying_price",
  "total_premium", "total_ask_side_prem", "total_bid_side_prem", "total_size", "trade_count", "volume",
  "open_interest", "volume_oi_ratio", "has_sweep", "has_floor", "has_multileg", "has_singleleg",
  "all_opening_trades", "alert_rule", "issue_type", "marketcap", "ask", "bid",
] as const satisfies readonly (keyof FlowAlert)[];

type Row = unknown[];
type Hole = [number, number]; // [loMs, hiMs] not yet fetched

export type TapeMeta = {
  day: string;
  newestMs: number;
  holes: Hole[];
  /** bucket index → row count */
  buckets: Record<string, number>;
  syncedAt: number;
  lastError?: string;
  uwCallsToday: number;
  total: number;
};

export type SessionTape = {
  alerts: FlowAlert[];
  meta: TapeMeta;
  coverage: { fromIso: string | null; toIso: string | null; complete: boolean; holes: number };
  durable: boolean;
};

const toRow = (a: FlowAlert): Row => FIELDS.map((f) => a[f]);
const fromRow = (r: Row): FlowAlert => Object.fromEntries(FIELDS.map((f, i) => [f, r[i]])) as unknown as FlowAlert;

const metaKey = (day: string) => `flowguard/tape/${day}/meta.json`;
const bucketKey = (day: string, b: string) => `flowguard/tape/${day}/b${b}.json`;

type State = {
  day: string;
  meta: TapeMeta;
  byId: Map<string, FlowAlert>;
  bucketOf: Map<string, string[]>; // bucket → ids
  localCounts: Record<string, number>;
  sorted: FlowAlert[] | null;
};

let state: State | null = null;
let syncing: Promise<void> | null = null;

function blankMeta(day: string): TapeMeta {
  return { day, newestMs: 0, holes: [], buckets: {}, syncedAt: 0, uwCallsToday: 0, total: 0 };
}

function fresh(day: string): State {
  return { day, meta: blankMeta(day), byId: new Map(), bucketOf: new Map(), localCounts: {}, sorted: null };
}

function bucketFor(ms: number, openMs: number): string {
  return String(Math.max(0, Math.floor((ms - openMs) / BUCKET_MS))).padStart(2, "0");
}

function add(st: State, a: FlowAlert, openMs: number, changed?: Set<string>): boolean {
  if (!a?.id || st.byId.has(a.id)) return false;
  const ms = Date.parse(a.created_at);
  if (!Number.isFinite(ms) || ms < openMs) return false;
  st.byId.set(a.id, a);
  const b = bucketFor(ms, openMs);
  const ids = st.bucketOf.get(b) ?? [];
  ids.push(a.id);
  st.bucketOf.set(b, ids);
  st.localCounts[b] = ids.length;
  changed?.add(b);
  st.sorted = null;
  return true;
}

async function hydrate(st: State, openMs: number): Promise<void> {
  const stored = await kvGet<TapeMeta>(metaKey(st.day), { maxAgeMs: META_MAX_AGE_MS });
  if (!stored || stored.day !== st.day) return;
  const want = Object.entries(stored.buckets).filter(([b, n]) => n > (st.localCounts[b] ?? 0));
  await Promise.all(
    want.map(async ([b]) => {
      const rows = await kvGet<Row[]>(bucketKey(st.day, b), { fresh: true });
      for (const r of rows ?? []) add(st, fromRow(r), openMs);
    }),
  );
  // Adopt the more advanced shared coverage.
  if (stored.syncedAt >= st.meta.syncedAt) {
    st.meta = { ...stored, buckets: { ...stored.buckets }, total: st.byId.size };
  }
}

/**
 * Fetch newest-first pages inside one hole [lo, hi], shrinking hole[1] as pages arrive, so partial progress
 * survives errors/budget exhaustion. Sets hole[1] = hole[0] when the hole is closed.
 */
async function fillHole(st: State, openMs: number, hole: Hole, top: boolean, budget: { pages: number }, changed: Set<string>): Promise<void> {
  let older: number | null = top ? null : Math.ceil(hole[1] / 1000) + 1;
  while (budget.pages > 0 && hole[1] > hole[0]) {
    budget.pages -= 1;
    st.meta.uwCallsToday += 1;
    const batch = await fetchFlowAlertsPage({
      minPremium: MIN_PREMIUM,
      newerThan: String(Math.floor(hole[0] / 1000) - 1),
      olderThan: older != null ? String(older) : undefined,
      limit: PAGE,
    });
    let oldest = Number.POSITIVE_INFINITY;
    let added = 0;
    for (const a of batch) {
      const ms = Date.parse(a.created_at);
      if (Number.isFinite(ms) && ms < oldest) oldest = ms;
      if (add(st, a, openMs, changed)) added += 1;
      if (Number.isFinite(ms) && ms > st.meta.newestMs) st.meta.newestMs = ms;
    }
    if (batch.length < PAGE || !Number.isFinite(oldest) || oldest <= hole[0]) {
      hole[1] = hole[0];
      return;
    }
    hole[1] = Math.min(hole[1], oldest);
    // Step below the oldest second seen; if a full page added nothing (same-second burst), step one more second.
    const next = Math.floor(oldest / 1000) + (added > 0 ? 1 : 0);
    older = older != null && next >= older ? older - 1 : next;
  }
}

function mergeHoles(hs: Hole[]): Hole[] {
  const sorted = [...hs].sort((a, b) => a[0] - b[0]);
  const out: Hole[] = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && h[0] <= last[1] + 1000) last[1] = Math.max(last[1], h[1]);
    else out.push([h[0], h[1]]);
  }
  return out;
}

async function sync(st: State, openMs: number, maxPages = MAX_PAGES_PER_SYNC): Promise<void> {
  const changed = new Set<string>();
  const budget = { pages: maxPages };
  const now = Date.now();
  st.meta.syncedAt = now;
  // Top gap = everything newer than what we hold (whole session on a cold start).
  const topHole: Hole = [st.meta.newestMs || openMs, now + 60_000];
  const holes: Hole[] = [topHole, ...st.meta.holes.map((h) => [h[0], h[1]] as Hole)];
  try {
    await fillHole(st, openMs, topHole, true, budget, changed);
    // Back-fill: split holes into 5-min chunks (newest first) and page them in parallel (bounded).
    const chunks: Hole[] = [];
    for (const h of holes) {
      if (h === topHole || h[1] <= h[0]) continue;
      for (let hi = h[1]; hi > h[0]; hi -= BACKFILL_CHUNK_MS) chunks.push([Math.max(h[0], hi - BACKFILL_CHUNK_MS), hi]);
    }
    chunks.sort((a, b) => b[1] - a[1]);
    holes.splice(1, holes.length - 1, ...chunks);
    let next = 0;
    const worker = async () => {
      while (budget.pages > 0 && next < chunks.length) {
        const c = chunks[next++];
        await fillHole(st, openMs, c, false, budget, changed);
      }
    };
    await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, worker));
    st.meta.lastError = undefined;
  } catch (e) {
    st.meta.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  st.meta.holes = mergeHoles(holes.filter((h) => h[1] > h[0] && !(h === topHole && h[1] > now)));
  // An untouched top hole (error before the first page) is simply retried next sync from newestMs.
  if (topHole[1] > topHole[0] && topHole[1] <= now) st.meta.holes = st.meta.holes.includes(topHole) ? st.meta.holes : [...st.meta.holes, topHole];
  st.meta.total = st.byId.size;
  for (const b of changed) {
    const rows = (st.bucketOf.get(b) ?? []).map((id) => toRow(st.byId.get(id) as FlowAlert));
    st.meta.buckets[b] = rows.length;
    await kvSet(bucketKey(st.day, b), rows, { tier: "hot", ttlSec: TTL_SEC });
  }
  await kvSet(metaKey(st.day), st.meta, { tier: "hot", ttlSec: TTL_SEC });
}

/**
 * Full-session tape (newest first). Syncs with UW at most every 3 min (force: 30 s). Never throws on UW errors:
 * returns what is held and reports `meta.lastError` (quota errors are re-thrown so callers can show the banner
 * only when nothing is held).
 */
export async function getSessionTape(opts: { force?: boolean; allowUw?: boolean } = {}): Promise<SessionTape> {
  const now = new Date();
  const day = tradingDateET(now);
  const openMs = sessionOpenUtc(now).getTime();
  if (!state || state.day !== day) state = fresh(day);
  const st = state;
  await hydrate(st, openMs);
  const since = Date.now() - st.meta.syncedAt;
  const interval = st.meta.holes.length ? BACKFILL_SYNC_MS : SYNC_MS;
  const due = since >= interval || (opts.force && since >= FORCE_MIN_MS);
  if (due && opts.allowUw !== false && Date.now() >= openMs && !syncing) {
    const cold = st.byId.size === 0;
    const run = (pages: number) =>
      (async () => {
        if (!(await kvSetNx(`flowguard/tape/${day}/lock`, String(Date.now()), 90))) return;
        await sync(st, openMs, pages);
      })().finally(() => {
        syncing = null;
      });
    if (cold) {
      // Nothing held: a few pages inline so the request has the latest prints; back-fill continues next calls.
      syncing = run(COLD_INLINE_PAGES);
      await syncing;
    } else {
      // Already holding the session: never block the request on UW; finish after the response.
      syncing = run(MAX_PAGES_PER_SYNC);
      const p = syncing;
      try {
        after(() => p);
      } catch {
        await p; // outside a request scope (scripts/tests)
      }
    }
  } else if (syncing && st.byId.size === 0) {
    await syncing;
  }
  if (!st.sorted) {
    st.sorted = [...st.byId.values()]
      .filter((a) => isInCurrentSession(a.created_at, now))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }
  const alerts = st.sorted;
  const holes = st.meta.holes.length;
  return {
    alerts,
    meta: st.meta,
    coverage: {
      fromIso: alerts.length ? alerts[alerts.length - 1].created_at : null,
      toIso: alerts.length ? alerts[0].created_at : null,
      complete: holes === 0 && st.meta.syncedAt > 0,
      holes,
    },
    durable: kvDurable(),
  };
}
