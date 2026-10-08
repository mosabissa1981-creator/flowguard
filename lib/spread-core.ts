/**
 * LIVE spread gate (approved by Mosab 10/8/2026): live candidates whose option bid-ask spread is over
 * SPREAD_MAX_PCT of mid at evaluation time are excluded from live picks (shown as "Skipped: wide spread X%").
 * No bid AND no ask → "spread unknown": kept, but tagged. Pure logic only (no I/O) so it can be tested.
 */

/** The ONE threshold for the live spread rule: (ask − bid) / mid. */
export const SPREAD_MAX_PCT = 0.1;

export type SpreadSource = "uw_nbbo" | "alert" | "none";
export type SpreadStatus = "ok" | "wide" | "unknown";

export type SpreadInfo = {
  bid: number | null;
  ask: number | null;
  mid: number | null;
  /** (ask − bid) / mid as a fraction (0.12 = 12%); null when unknown. */
  pct: number | null;
  source: SpreadSource;
  status: SpreadStatus;
  /** When this spread was evaluated (ISO). */
  at: string;
  /** Threshold applied (so stored rows stay self-describing). */
  maxPct: number;
};

export type SpreadSkip = {
  option_chain: string;
  ticker: string;
  reason: string;
  spread: SpreadInfo;
  /** List the name was evaluated for (picks, premove, morning, lane id, paper book…). */
  list?: string;
};

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Spread from one bid/ask pair. A real two-sided quote needs ask > 0 and bid ≥ 0 with ask ≥ bid
 * (bid 0 with an ask = no bid at all → 200% spread → wide). Anything less is not a usable pair.
 */
export function spreadFromPair(bidRaw: unknown, askRaw: unknown): { bid: number; ask: number; mid: number; pct: number } | null {
  const bid = num(bidRaw);
  const ask = num(askRaw);
  if (bid == null || ask == null || ask <= 0 || ask < bid) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return { bid, ask, mid: Math.round(mid * 1000) / 1000, pct: Math.round(((ask - bid) / mid) * 10_000) / 10_000 };
}

/**
 * Best available spread: fresh UW NBBO first, then the flow alert's bid/ask (NBBO at the print).
 * If neither gives a usable pair → status "unknown" (kept, tagged; never silently dropped).
 */
export function resolveSpread(
  fresh: { bid?: number | null; ask?: number | null } | null | undefined,
  alert: { bid?: unknown; ask?: unknown } | null | undefined,
  at: string = new Date().toISOString(),
  maxPct: number = SPREAD_MAX_PCT,
): SpreadInfo {
  const f = fresh ? spreadFromPair(fresh.bid, fresh.ask) : null;
  const a = !f && alert ? spreadFromPair(alert.bid, alert.ask) : null;
  const hit = f ?? a;
  if (!hit) {
    // Keep whatever one-sided numbers we saw, for the study.
    const bid = num(fresh?.bid) ?? num(alert?.bid);
    const ask = num(fresh?.ask) ?? num(alert?.ask);
    return { bid, ask, mid: null, pct: null, source: "none", status: "unknown", at, maxPct };
  }
  return {
    bid: hit.bid,
    ask: hit.ask,
    mid: hit.mid,
    pct: hit.pct,
    source: f ? "uw_nbbo" : "alert",
    status: hit.pct > maxPct + 1e-9 ? "wide" : "ok",
    at,
    maxPct,
  };
}

export function spreadPctLabel(info: Pick<SpreadInfo, "pct">): string {
  return info.pct == null ? "?" : `${Math.round(info.pct * 100)}%`;
}

/** Short desk reason, e.g. "Skipped: wide spread 18%". */
export function spreadSkipReason(info: Pick<SpreadInfo, "pct">): string {
  return `Skipped: wide spread ${spreadPctLabel(info)}`;
}

/** Split rows by the gate: wide → skipped (with reason); ok / unknown → kept (annotated). Order preserved. */
export function splitBySpread<T>(
  rows: T[],
  spreadOf: (row: T) => SpreadInfo,
  keyOf: (row: T) => { option_chain: string; ticker: string },
  list?: string,
): { kept: Array<T & { spread: SpreadInfo }>; skipped: SpreadSkip[] } {
  const kept: Array<T & { spread: SpreadInfo }> = [];
  const skipped: SpreadSkip[] = [];
  for (const row of rows) {
    const spread = spreadOf(row);
    if (spread.status === "wide") {
      skipped.push({ ...keyOf(row), reason: spreadSkipReason(spread), spread, ...(list ? { list } : {}) });
      continue;
    }
    kept.push({ ...row, spread });
  }
  return { kept, skipped };
}
