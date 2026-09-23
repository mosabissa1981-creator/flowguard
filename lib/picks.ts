import { loadRankedFlow } from "@/lib/flow-service";
import { PICKS_FILTERS } from "@/lib/filters";
import { buildPickCopy } from "@/lib/thesis";
import { loadPremoveContractKeys } from "@/lib/premove";
import { compareActionable, withActionableAdjustments } from "@/lib/scoring";
import type { PicksResponse } from "@/lib/types";

export { PICKS_FILTERS };

export const MAX_PICKS = 10;

export async function loadDailyPicks(opts?: { forceFresh?: boolean }): Promise<PicksResponse> {
  const [ranked, premoveKeys] = await Promise.all([
    loadRankedFlow(PICKS_FILTERS, opts),
    loadPremoveContractKeys(opts),
  ]);

  const adjusted = withActionableAdjustments(ranked.items, premoveKeys);
  adjusted.sort(compareActionable);

  const picks = adjusted.slice(0, MAX_PICKS).map((row, index) => {
    const copy = buildPickCopy(row);
    return { ...row, rank: index + 1, ...copy };
  });

  return {
    source: ranked.source,
    fetchedAt: ranked.fetchedAt,
    picks,
    tide: ranked.tide,
    warning: ranked.warning,
    quotaBlocked: ranked.quotaBlocked,
    authFailed: ranked.authFailed,
  };
}
