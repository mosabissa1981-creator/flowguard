import "server-only";

import { kvGetMany, kvSet } from "@/lib/kv";
import { contractKey } from "@/lib/scoring";
import { etClock } from "@/lib/shadow/budget";
import { resolveSpread, splitBySpread, type SpreadInfo, type SpreadSkip } from "@/lib/spread-core";
import { fetchTickerOptionQuotes, hasUnusualWhalesKey } from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";
import { runAsUwJob, uwTokenCount, UW_DAY_CEILING } from "@/lib/uw-usage";
import type { RankedFlow } from "@/lib/types";

export { SPREAD_MAX_PCT, resolveSpread, spreadSkipReason, type SpreadInfo, type SpreadSkip } from "@/lib/spread-core";

/**
 * Server side of the LIVE spread gate: fresh UW NBBO for the top of each live list (regular session only;
 * after-hours NBBO is not a real market), else the flow alert's bid/ask at the print.
 * Budget: per-contract memo (4 min, in-instance + shared via KV across instances), one batched call per ticker,
 * ≤ 2 tickers in flight (UW limit is 3 concurrent), ≤ 12 tickers per list, and no fresh quotes once the
 * UW day nears the ceiling (falls back to the alert's bid/ask).
 */
const FRESH_TTL_MS = 4 * 60_000;
const MAX_TICKERS_PER_LIST = 12;
const DEFAULT_FRESH_TOP = 20;
const CONCURRENCY = 2;
/** Stop fresh gate quotes this close to the 37,500 ceiling (leaves the last calls for the desk itself). */
const CEILING_MARGIN = 500;

type Pair = { bid: number | null; ask: number | null };
const memo = new Map<string, { at: number; q: Pair | null }>();
const KV_KEY = (contract: string) => `spread:q:${contract}`;

export function inRegularSession(now = new Date()): boolean {
  const { minutes, weekday } = etClock(now);
  return weekday && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

async function freshOk(): Promise<boolean> {
  try {
    if (!(await hasUnusualWhalesKey()) || (await isUwBlocked())) return false;
    return (await uwTokenCount()) < UW_DAY_CEILING - CEILING_MARGIN;
  } catch {
    return false;
  }
}

/** Fresh NBBO pairs for contracts (memoized). Empty outside the regular session or when UW is unavailable. */
export async function freshSpreadQuotes(
  reqs: Array<{ ticker: string; contract: string }>,
  now = new Date(),
): Promise<Map<string, Pair | null>> {
  const out = new Map<string, Pair | null>();
  if (reqs.length === 0 || !inRegularSession(now)) return out;
  const fresh = (at: number | undefined) => at != null && now.getTime() - at < FRESH_TTL_MS;
  let todo: Array<{ ticker: string; contract: string }> = [];
  for (const r of reqs) {
    if (!r.contract || !r.ticker || out.has(r.contract)) continue;
    const hit = memo.get(r.contract);
    if (hit && fresh(hit.at)) out.set(r.contract, hit.q);
    else todo.push(r);
  }
  // Shared memo across serverless instances (KV), so N instances don't re-quote the same contracts.
  if (todo.length > 0) {
    const shared = await kvGetMany<{ at: number; q: Pair | null }>(todo.map((r) => KV_KEY(r.contract))).catch(() => []);
    todo = todo.filter((r, i) => {
      const hit = shared[i];
      if (hit && fresh(hit.at)) {
        memo.set(r.contract, hit);
        out.set(r.contract, hit.q);
        return false;
      }
      return true;
    });
  }
  const byTicker = new Map<string, Set<string>>();
  for (const r of todo) {
    const t = r.ticker.toUpperCase();
    if (!byTicker.has(t) && byTicker.size >= MAX_TICKERS_PER_LIST) continue;
    (byTicker.get(t) ?? byTicker.set(t, new Set()).get(t)!).add(r.contract);
  }
  if (byTicker.size === 0 || !(await freshOk())) return out;
  const jobs = [...byTicker.entries()];
  const worker = async () => {
    for (let job = jobs.shift(); job; job = jobs.shift()) {
      const [ticker, syms] = job;
      try {
        const { quotes } = await fetchTickerOptionQuotes(ticker, [...syms], {}, { ttlMs: FRESH_TTL_MS });
        for (const s of syms) {
          const q = quotes[s];
          const pair = q && q.quality !== "flow_print" ? { bid: q.bid ?? null, ask: q.ask ?? null } : null;
          const rec = { at: Date.now(), q: pair };
          memo.set(s, rec);
          out.set(s, pair);
          void kvSet(KV_KEY(s), rec, { ttlSec: Math.ceil(FRESH_TTL_MS / 1000) + 60 }).catch(() => undefined);
        }
      } catch {
        // Fall back to the alert's bid/ask for this ticker.
      }
    }
  };
  await runAsUwJob("spread-gate", () => Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => undefined));
  if (memo.size > 2000) for (const [k, v] of memo) if (Date.now() - v.at > FRESH_TTL_MS) memo.delete(k);
  return out;
}

/**
 * Apply the LIVE gate to a ranked, sorted list: wide (> SPREAD_MAX_PCT) → skipped with a desk reason;
 * ok / unknown → kept with `spread` attached. Only the top `freshTop` rows get a fresh quote.
 */
export async function gateRankedRows<T extends RankedFlow>(
  rows: T[],
  list: string,
  opts: { freshTop?: number; now?: Date } = {},
): Promise<{ kept: Array<T & { spread: SpreadInfo }>; skipped: SpreadSkip[] }> {
  const now = opts.now ?? new Date();
  const top = rows.slice(0, opts.freshTop ?? DEFAULT_FRESH_TOP);
  const fresh = await freshSpreadQuotes(top.map((r) => ({ ticker: r.alert.ticker, contract: contractKey(r) })), now).catch(
    () => new Map<string, Pair | null>(),
  );
  const at = now.toISOString();
  const res = splitBySpread(
    rows,
    (r) => resolveSpread(fresh.get(contractKey(r)), { bid: r.alert.bid, ask: r.alert.ask }, at),
    (r) => ({ option_chain: contractKey(r), ticker: r.alert.ticker }),
    list,
  );
  // Desk shows skips near the top of the list (the names that would have made it); deeper rows are
  // still filtered but not listed. Dedupe by contract.
  const topKeys = new Set(top.map((r) => contractKey(r)));
  const seen = new Set<string>();
  res.skipped = res.skipped.filter((s) => topKeys.has(s.option_chain) && !seen.has(s.option_chain) && seen.add(s.option_chain));
  return res;
}

/** Record-only spread (test-mode lanes): same resolution, never filters. */
export async function spreadFor(
  ticker: string,
  contract: string,
  alert: { bid?: unknown; ask?: unknown } | null,
  now = new Date(),
): Promise<SpreadInfo> {
  const fresh = await freshSpreadQuotes([{ ticker, contract }], now).catch(() => new Map<string, Pair | null>());
  return resolveSpread(fresh.get(contract), alert, now.toISOString());
}
