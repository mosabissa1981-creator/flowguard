import "server-only";

import { loadRankedFlow } from "@/lib/flow-service";
import { buildPremoveCopy } from "@/lib/thesis";
import { applyPremoveOverlay, hasPremoveAccumulation } from "@/lib/premove-score";
import { fetchStockStates, hasUnusualWhalesKey } from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";
import { toNumber } from "@/lib/numbers";
import type { FlowFilters, PicksResponse, RankedFlow } from "@/lib/types";

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

export async function loadPremoveShortlist(opts?: { forceFresh?: boolean }): Promise<PicksResponse> {
  const ranked = await loadRankedFlow(PREMOVE_FILTERS, opts);
  const peers = ranked.items.map((row) => row.alert);

  let spots: Awaited<ReturnType<typeof fetchStockStates>> = {};
  const allowSpot =
    ranked.source === "live" &&
    !ranked.quotaBlocked &&
    (await hasUnusualWhalesKey()) &&
    !(await isUwBlocked());
  if (allowSpot) {
    const tickers = [...new Set(ranked.items.map((row) => row.alert.ticker))].slice(0, 8);
    try {
      spots = await fetchStockStates(tickers, 6);
    } catch {
      spots = {};
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

  const overlaid: RankedFlow[] = ranked.items
    .filter((row) => row.askShare >= 0.55)
    .filter((row) => !row.stale)
    .filter(
      (row) =>
        !row.chips.some((chip) =>
          ["lottery", "post-fade", "aged", "aged-call", "aged-floor", "no-follow"].includes(chip.id),
        ),
    )
    .filter((row) => hasPremoveAccumulation(row, peers))
    .map((row) =>
      applyPremoveOverlay(row, {
        peers,
        spot: spots[row.alert.ticker] ?? null,
      }),
    )
    .filter((row) => row.score >= MIN_PREMOVE_SCORE)
    .filter((row) => !row.chips.some((chip) => chip.id === "extended" && chip.delta <= -20))
    .filter((row) => !row.chips.some((chip) => chip.id === "late-whale"))
    .filter((row) => {
      const prem = toNumber(row.alert.total_premium);
      const stacked = row.chips.some((chip) => chip.id === "mid-size" || chip.id === "building");
      if (prem >= 1_000_000 && !stacked) return false;
      return true;
    });

  overlaid.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const buildScore = (row: RankedFlow) =>
      row.chips.filter((chip) => chip.id === "building" || chip.id === "mid-size" || chip.id === "quiet")
        .length;
    const buildDelta = buildScore(b) - buildScore(a);
    if (buildDelta !== 0) return buildDelta;
    const jumbo = (row: RankedFlow) => (toNumber(row.alert.total_premium) >= 750_000 ? 1 : 0);
    if (jumbo(a) !== jumbo(b)) return jumbo(a) - jumbo(b);
    return 0;
  });

  const seenChains = new Set<string>();
  const seenTickerCount = new Map<string, number>();
  const unique: RankedFlow[] = [];
  for (const row of overlaid) {
    const chain = row.alert.option_chain || row.alert.id;
    if (seenChains.has(chain)) continue;
    const tickerN = seenTickerCount.get(row.alert.ticker) ?? 0;
    if (tickerN >= 2) continue;
    seenChains.add(chain);
    seenTickerCount.set(row.alert.ticker, tickerN + 1);
    unique.push(row);
    if (unique.length >= MAX_PREMOVE) break;
  }

  const picks = unique.map((row, index) => ({
    ...row,
    rank: index + 1,
    ...buildPremoveCopy(row),
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
  };
}
