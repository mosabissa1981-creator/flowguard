import { loadRankedFlow } from "@/lib/flow-service";
import { buildPickCopy } from "@/lib/thesis";
import type { FlowFilters, PicksResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const PICKS_FILTERS: FlowFilters = {
  minPremium: 10_000,
  minDte: 0,
  maxDte: 60,
  side: "all",
  minConviction: 55,
  unusual: true,
  strictAntiFade: true,
  ticker: "",
};

const MAX_PICKS = 10;

export async function GET() {
  const ranked = await loadRankedFlow(PICKS_FILTERS);
  const picks = ranked.items.slice(0, MAX_PICKS).map((row) => {
    const copy = buildPickCopy(row);
    return { ...row, ...copy };
  });

  const payload: PicksResponse = {
    source: ranked.source,
    fetchedAt: ranked.fetchedAt,
    picks,
    tide: ranked.tide,
    warning: ranked.warning,
  };

  return Response.json(payload);
}
