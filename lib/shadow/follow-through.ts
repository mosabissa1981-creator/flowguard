import "server-only";

import { askShare, toNumber } from "@/lib/numbers";
import { tradingDateET } from "@/lib/session";
import { getSessionTape } from "@/lib/session-tape";
import { loadGapChase } from "@/lib/shadow/gap-chase";
import { loadDoc, persistenceMode, saveDoc } from "@/lib/shadow/store";

/**
 * TEST / SHADOW follow-through confirmation. For each live-list candidate (the same set the gap-chase checker
 * tracks: Picks, Premove, Morning, AI), checks the session tape for a 2nd ask-side print (ask share ≥ 60%) on the
 * same contract, or a ≥ $25k ask-side print on another same-side contract of the ticker, within 15/30/60 min of the
 * first print. Zero extra UW calls (reads the shared session tape). Shadow column only.
 */
const KIND = "follow-through";
const RECOMPUTE_MS = 3 * 60_000;
const WINDOWS = [15, 30, 60] as const;
export const FT_RULE =
  "Confirmed (contract) = another print on the same contract with ask share ≥ 60% within N min of the first print; (ticker) = a ≥ $25k print with ask share ≥ 60% on another same-side contract of the ticker. N = 15 / 30 / 60 min.";
export const FT_BACKTEST =
  "2-year replay (14,942 candidates): no edge. 30 min: confirmed 39.7% win (4,109W/6,249L/925F) vs not 38.9% (1,256W/1,972L/431F); contract-level only 39.5%; 60 min: 39.7% vs 38.3%; baseline 39.5%. Keep as a study column, not a filter.";

export type FtStatus = "contract" | "ticker" | "none" | "pending";
export type FtRow = {
  contract: string;
  ticker: string;
  side: "call" | "put";
  lists: string[];
  firstPrintUtc: string | null;
  byWindow: Record<string, FtStatus>;
  contractConfirmAt: string | null;
  tickerConfirmAt: string | null;
  lastCheckedAt: string;
};
export type FtDoc = { day: string; updatedAt: string; rows: Record<string, FtRow> };

let memo: { at: number; day: string; doc: FtDoc } | null = null;

async function compute(now: Date): Promise<FtDoc> {
  const day = tradingDateET(now);
  const prev = (await loadDoc<FtDoc>(KIND, day, { fresh: true })) ?? { day, updatedAt: "", rows: {} };
  const gap = await loadGapChase({ now });
  const tape = (await getSessionTape({ allowUw: false })).alerts;
  const nowMs = now.getTime();
  for (const g of Object.values(gap.rows)) {
    const t0 = g.firstPrintUtc ? new Date(g.firstPrintUtc).getTime() : NaN;
    if (!Number.isFinite(t0)) continue;
    let cAt: number | null = null;
    let tAt: number | null = null;
    for (const a of tape) {
      if (a.ticker !== g.ticker || a.type !== g.side) continue;
      const t = new Date(a.created_at).getTime();
      if (!(t > t0 + 1000) || t > t0 + 60 * 60_000 || askShare(a) < 0.6) continue;
      if (a.option_chain === g.contract) cAt = cAt == null ? t : Math.min(cAt, t);
      else if (toNumber(a.total_premium) >= 25_000) tAt = tAt == null ? t : Math.min(tAt, t);
    }
    const byWindow: Record<string, FtStatus> = {};
    for (const w of WINDOWS) {
      const end = t0 + w * 60_000;
      byWindow[`${w}m`] = cAt != null && cAt <= end ? "contract" : tAt != null && tAt <= end ? "ticker" : nowMs < end ? "pending" : "none";
    }
    prev.rows[g.key] = {
      contract: g.contract,
      ticker: g.ticker,
      side: g.side,
      lists: g.lists,
      firstPrintUtc: g.firstPrintUtc,
      byWindow,
      contractConfirmAt: cAt != null ? new Date(cAt).toISOString() : null,
      tickerConfirmAt: tAt != null ? new Date(tAt).toISOString() : null,
      lastCheckedAt: now.toISOString(),
    };
  }
  const doc = { ...prev, updatedAt: now.toISOString() };
  if (Object.keys(doc.rows).length) await saveDoc(KIND, day, doc);
  return doc;
}

export async function loadFollowThrough(opts: { day?: string; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const today = tradingDateET(now);
  const wrap = (doc: FtDoc) => ({ mode: "test" as const, persistence: persistenceMode(), rule: FT_RULE, backtest: FT_BACKTEST, uwCalls: 0, ...doc });
  if (opts.day && opts.day !== today) return wrap((await loadDoc<FtDoc>(KIND, opts.day)) ?? { day: opts.day, updatedAt: "", rows: {} });
  if (memo && memo.day === today && now.getTime() - memo.at < RECOMPUTE_MS) return wrap(memo.doc);
  const doc = await compute(now);
  memo = { at: Date.now(), day: today, doc };
  return wrap(doc);
}
