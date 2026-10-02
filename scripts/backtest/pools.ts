/**
 * Full scored candidate pools for Picks and Premove at their replay checkpoints (study only).
 * Mirrors lib/picks.ts loadDailyPicks and lib/premove.ts loadPremoveShortlist step by step, but keeps EVERY
 * ranked row (with chips, raw score and the pre-overlay score) instead of only the top-N. Live code is untouched;
 * the replay checks that the pool's top 3 equals what the live functions returned.
 */
import type { RankedFlow } from "@/lib/types";

export type PoolRow = {
  poolRank: number; // 1-based position after the live sort (before concentration caps)
  capRank: number | null; // 1-based rank after issuer/sector/list caps (null = cut by caps or below the list cap)
  contract: string;
  ticker: string;
  side: "call" | "put";
  expiry: string;
  entry: number;
  printTimeUtc: string | null;
  underlying: number | null;
  score: number;
  rawScore: number;
  /** Raw score entering the actionable overlay (drives the score-90 chip) and the chips present at that point. */
  preActRaw: number;
  preActChips: string[];
  dte: number;
  askShare: number;
  premium: number | null;
  volOi: number | null;
  sweep: boolean;
  chips: { id: string; delta: number }[];
};
export type Pool = { list: "picks" | "premove"; locked: boolean; listCap: number; caps: { maxPerIssuer: number; maxPerSector: number }; rows: PoolRow[] };

export const POOL_MAX_ROWS = 80;

const num = (v: unknown) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);

function toRows(sorted: RankedFlow[], kept: RankedFlow[], pre: Map<string, RankedFlow>): PoolRow[] {
  const capRank = new Map(kept.map((r, i) => [r.alert.id, i + 1]));
  return sorted.slice(0, POOL_MAX_ROWS).map((r, i) => {
    const a = r.alert;
    const p = pre.get(a.id);
    return {
      poolRank: i + 1,
      capRank: capRank.get(a.id) ?? null,
      contract: a.option_chain || a.id,
      ticker: a.ticker,
      side: a.type === "put" ? "put" : "call",
      expiry: a.expiry,
      entry: Number(a.price),
      printTimeUtc: a.created_at ?? null,
      underlying: num(a.underlying_price),
      score: r.score,
      rawScore: r.rawScore ?? r.score,
      preActRaw: p ? (p.rawScore ?? p.score) : (r.rawScore ?? r.score),
      preActChips: (p?.chips ?? []).map((c) => c.id),
      dte: r.dte,
      askShare: Math.round(r.askShare * 1000) / 1000,
      premium: num(a.total_premium),
      volOi: num(a.volume_oi_ratio),
      sweep: Boolean(a.has_sweep),
      chips: r.chips.map((c) => ({ id: c.id, delta: c.delta })),
    };
  });
}

/** Picks pool: same inputs/order as loadDailyPicks (call right after it so the flow caches are warm). */
export async function picksPool(): Promise<Pool> {
  const [{ loadRankedFlow }, { PICKS_FILTERS }, { loadPremoveContext }, scoring, { applyConcentrationCaps }, regimeLib] = await Promise.all([
    import("@/lib/flow-service"), import("@/lib/filters"), import("@/lib/premove"), import("@/lib/scoring"), import("@/lib/issuers"), import("@/lib/regime"),
  ]);
  const { MAX_PICKS } = await import("@/lib/picks");
  const [ranked, premove] = await Promise.all([loadRankedFlow(PICKS_FILTERS), loadPremoveContext()]);
  const regime = await regimeLib.loadRegimeSafe(ranked.tide);
  const adjusted = scoring.withActionableAdjustments(ranked.items, premove.keys, undefined, { spots: premove.spots, regime: regimeLib.toActionableRegime(regime) });
  adjusted.sort(scoring.compareActionable);
  const listCap = regimeLib.regimeListCap(regime, MAX_PICKS);
  const caps = regimeLib.regimeCaps(regime);
  const { kept } = applyConcentrationCaps(adjusted, listCap, caps);
  const pre = new Map(ranked.items.map((r) => [r.alert.id, r]));
  return { list: "picks", locked: Boolean(regimeLib.lockoutWarning(regime)), listCap, caps, rows: toRows(adjusted, kept, pre) };
}

/** Same tie-breaks as lib/premove.ts comparePremove (not exported there). */
function comparePremove(a: RankedFlow, b: RankedFlow, s: typeof import("@/lib/scoring")): number {
  const late = (r: RankedFlow) => (s.hasScoreChip(r, "late-print") ? 1 : 0);
  if (late(a) !== late(b)) return late(a) - late(b);
  if (b.score !== a.score) return b.score - a.score;
  const rawDelta = (b.rawScore ?? b.score) - (a.rawScore ?? a.score);
  if (rawDelta !== 0) return rawDelta;
  const dteDelta = s.dtePreference(a.dte) - s.dtePreference(b.dte);
  if (dteDelta !== 0) return dteDelta;
  const build = (r: RankedFlow) => r.chips.filter((c) => c.id === "building" || c.id === "mid-size" || c.id === "quiet").length;
  if (build(b) !== build(a)) return build(b) - build(a);
  const jumbo = (r: RankedFlow) => (Number(r.alert.total_premium) >= 750_000 ? 1 : 0);
  return jumbo(a) - jumbo(b);
}

/** Premove pool: same inputs/order as loadPremoveShortlist. */
export async function premovePool(): Promise<Pool> {
  const [{ loadRankedFlow }, { PICKS_FILTERS }, premoveLib, scoring, { applyConcentrationCaps }, regimeLib, uw] = await Promise.all([
    import("@/lib/flow-service"), import("@/lib/filters"), import("@/lib/premove"), import("@/lib/scoring"), import("@/lib/issuers"), import("@/lib/regime"), import("@/lib/uw"),
  ]);
  const ranked = await loadRankedFlow(premoveLib.PREMOVE_FILTERS);
  const peers = ranked.items.map((r) => r.alert);
  const spots: Record<string, Awaited<ReturnType<typeof uw.fetchStockStates>>[string]> = {};
  if (ranked.source === "live" && !ranked.quotaBlocked) {
    const tickers = [...new Set(ranked.items.map((r) => r.alert.ticker))].slice(0, 8);
    try {
      Object.assign(spots, await uw.fetchStockStates(tickers, 6));
    } catch {
      /* optional, as live */
    }
  }
  const rows = premoveLib.selectPremoveRows(ranked.items, peers, spots);
  const picksRanked = await loadRankedFlow(PICKS_FILTERS);
  const pickKeys = new Set(picksRanked.items.filter((r) => !scoring.excludedFromActionable(r)).map((r) => scoring.contractKey(r)));
  const regime = await regimeLib.loadRegimeSafe(ranked.tide);
  const adjusted = scoring.withActionableAdjustments(rows, pickKeys, undefined, { spots, regime: regimeLib.toActionableRegime(regime) });
  adjusted.sort((a, b) => comparePremove(a, b, scoring));
  const listCap = regimeLib.regimeListCap(regime, premoveLib.MAX_PREMOVE);
  const caps = regimeLib.regimeCaps(regime);
  const { kept } = applyConcentrationCaps(adjusted, listCap, caps);
  const pre = new Map(rows.map((r) => [r.alert.id, r]));
  return { list: "premove", locked: Boolean(regimeLib.lockoutWarning(regime)), listCap, caps, rows: toRows(adjusted, kept, pre) };
}
