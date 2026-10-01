import "server-only";

import { loadRankedFlow } from "@/lib/flow-service";
import { PICKS_FILTERS } from "@/lib/filters";
import { buildPremoveCopy } from "@/lib/thesis";
import { applyPremoveOverlay, hasPremoveAccumulation } from "@/lib/premove-score";
import { fetchStockStates, hasUnusualWhalesKey, type StockState } from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";
import { toNumber } from "@/lib/numbers";
import { applyConcentrationCaps } from "@/lib/issuers";
import { buildExitPlan } from "@/lib/exit-plan";
import { loadRegimeSafe, regimeBrief, regimeCaps, regimeListCap, toActionableRegime } from "@/lib/regime";
import {
  contractKey,
  dtePreference,
  excludedFromActionable,
  hasScoreChip,
  withActionableAdjustments,
} from "@/lib/scoring";
import type { FlowAlert, FlowFilters, FlowResponse, PicksResponse, RankedFlow } from "@/lib/types";

export const PREMOVE_FILTERS: FlowFilters = {
  minPremium: 20_000,
  minDte: 7,
  maxDte: 45,
  side: "all",
  minConviction: 0,
  unusual: false,
  strictAntiFade: false,
  ticker: "",
};

export const MAX_PREMOVE = 8;
const MIN_PREMOVE_SCORE = 50;

export function selectPremoveRows(
  items: RankedFlow[],
  peers: FlowAlert[],
  spots: Record<string, StockState | null | undefined>,
  now = new Date(),
): RankedFlow[] {
  return items
    .filter((row) => row.askShare >= 0.55)
    .filter((row) => !row.stale)
    .filter((row) => !excludedFromActionable(row))
    .filter(
      (row) =>
        !row.chips.some((chip) =>
          ["lottery", "post-fade", "aged", "aged-call", "aged-floor"].includes(chip.id),
        ),
    )
    .filter((row) => hasPremoveAccumulation(row, peers))
    .map((row) =>
      applyPremoveOverlay(row, {
        peers,
        spot: spots[row.alert.ticker] ?? null,
        now,
      }),
    )
    .filter((row) => row.score >= MIN_PREMOVE_SCORE)
    .filter((row) => !row.chips.some((chip) => chip.id === "extended" && chip.delta <= -20))
    .filter((row) => !hasScoreChip(row, "late-whale"))
    .filter((row) => {
      const prem = toNumber(row.alert.total_premium);
      const stacked = hasScoreChip(row, "mid-size") || hasScoreChip(row, "building");
      if (prem >= 1_000_000 && !stacked) return false;
      return true;
    });
}

type PremoveQualifying = {
  ranked: FlowResponse;
  rows: RankedFlow[];
  spots: Record<string, StockState | null>;
};

let qualifyingInflight: { key: string; promise: Promise<PremoveQualifying> } | null = null;

async function computePremoveQualifying(opts?: { forceFresh?: boolean }): Promise<PremoveQualifying> {
  const ranked = await loadRankedFlow(PREMOVE_FILTERS, opts);
  const peers = ranked.items.map((row) => row.alert);
  const spots: Record<string, StockState | null> = {};

  const allowSpot =
    ranked.source === "live" &&
    !ranked.quotaBlocked &&
    (await hasUnusualWhalesKey()) &&
    !(await isUwBlocked());
  if (allowSpot) {
    const tickers = [...new Set(ranked.items.map((row) => row.alert.ticker))].slice(0, 8);
    try {
      Object.assign(spots, await fetchStockStates(tickers, 6));
    } catch {
      // Quiet-underlying boost is optional. Missing spots must not fail the lane.
    }
  } else if (ranked.source === "mock") {
    for (const row of ranked.items) {
      const last = toNumber(row.alert.underlying_price);
      if (!(last > 0) || spots[row.alert.ticker]) continue;
      spots[row.alert.ticker] = {
        ticker: row.alert.ticker,
        last,
        prevClose: last / 1.006,
        pctFromClose: 0.006,
      };
    }
  }

  return {
    ranked,
    rows: selectPremoveRows(ranked.items, peers, spots),
    spots,
  };
}

function loadPremoveQualifying(opts?: { forceFresh?: boolean }): Promise<PremoveQualifying> {
  const key = opts?.forceFresh ? "fresh" : "cached";
  if (qualifyingInflight?.key === key) return qualifyingInflight.promise;
  const promise = computePremoveQualifying(opts).finally(() => {
    if (qualifyingInflight?.promise === promise) qualifyingInflight = null;
  });
  qualifyingInflight = { key, promise };
  return promise;
}

/** Qualifying Premove chains, before the top-N cut. Used to boost Picks overlap. */
export async function loadPremoveContractKeys(opts?: { forceFresh?: boolean }): Promise<Set<string>> {
  const { rows } = await loadPremoveQualifying(opts);
  return new Set(rows.map((row) => contractKey(row)));
}

/** Premove overlap keys + the stock-state spots it already fetched (no extra UW calls). */
export async function loadPremoveContext(
  opts?: { forceFresh?: boolean },
): Promise<{ keys: Set<string>; spots: Record<string, StockState | null> }> {
  const { rows, spots } = await loadPremoveQualifying(opts);
  return { keys: new Set(rows.map((row) => contractKey(row))), spots };
}

async function loadPickContractKeys(opts?: { forceFresh?: boolean }): Promise<Set<string>> {
  const ranked = await loadRankedFlow(PICKS_FILTERS, opts);
  return new Set(
    ranked.items.filter((row) => !excludedFromActionable(row)).map((row) => contractKey(row)),
  );
}

function comparePremove(a: RankedFlow, b: RankedFlow): number {
  const lateA = hasScoreChip(a, "late-print") ? 1 : 0;
  const lateB = hasScoreChip(b, "late-print") ? 1 : 0;
  if (lateA !== lateB) return lateA - lateB;
  if (b.score !== a.score) return b.score - a.score;
  const rawDelta = (b.rawScore ?? b.score) - (a.rawScore ?? a.score);
  if (rawDelta !== 0) return rawDelta;
  const dteDelta = dtePreference(a.dte) - dtePreference(b.dte);
  if (dteDelta !== 0) return dteDelta;
  const buildScore = (row: RankedFlow) =>
    row.chips.filter((chip) => chip.id === "building" || chip.id === "mid-size" || chip.id === "quiet")
      .length;
  const buildDelta = buildScore(b) - buildScore(a);
  if (buildDelta !== 0) return buildDelta;
  const jumbo = (row: RankedFlow) => (toNumber(row.alert.total_premium) >= 750_000 ? 1 : 0);
  if (jumbo(a) !== jumbo(b)) return jumbo(a) - jumbo(b);
  return 0;
}

export async function loadPremoveShortlist(opts?: { forceFresh?: boolean }): Promise<PicksResponse> {
  const [{ ranked, rows, spots }, pickKeys] = await Promise.all([
    loadPremoveQualifying(opts),
    loadPickContractKeys(opts),
  ]);
  const regime = await loadRegimeSafe(ranked.tide);

  const adjusted = withActionableAdjustments(rows, pickKeys, undefined, {
    spots,
    regime: toActionableRegime(regime),
  });
  adjusted.sort(comparePremove);

  // Issuer cap 2 (GOOG+GOOGL = one), sector cap 3, regime list cap.
  const { kept: unique, dropped } = applyConcentrationCaps(
    adjusted,
    regimeListCap(regime, MAX_PREMOVE),
    regimeCaps(regime),
  );

  const picks = unique.map((row, index) => ({
    ...row,
    rank: index + 1,
    ...buildPremoveCopy(row),
    exitPlan: buildExitPlan(row, { riskyRegime: Boolean(regime?.rules.active) }),
  }));

  let warning = ranked.warning;
  if (picks.length === 0 && !warning) {
    warning =
      "No building ask-side setups on a still-quiet underlying in this session. Not filling from late whale floors.";
  }

  return {
    source: ranked.source,
    fetchedAt: ranked.fetchedAt,
    picks,
    tide: ranked.tide,
    warning,
    quotaBlocked: ranked.quotaBlocked,
    authFailed: ranked.authFailed,
    regime: regimeBrief(regime),
    capDrops: dropped,
  };
}
