import { loadRankedFlow } from "@/lib/flow-service";
import { PICKS_FILTERS } from "@/lib/filters";
import { buildPickCopy } from "@/lib/thesis";
import { loadPremoveContext } from "@/lib/premove";
import { compareActionable, withActionableAdjustments } from "@/lib/scoring";
import { applyConcentrationCaps } from "@/lib/issuers";
import { buildExitPlan } from "@/lib/exit-plan";
import { lockoutWarning, loadRegimeSafe, regimeBrief, regimeCaps, regimeListCap, toActionableRegime } from "@/lib/regime";
import type { PicksResponse } from "@/lib/types";

export { PICKS_FILTERS };

export const MAX_PICKS = 10;

export async function loadDailyPicks(opts?: { forceFresh?: boolean }): Promise<PicksResponse> {
  const [ranked, premove] = await Promise.all([
    loadRankedFlow(PICKS_FILTERS, opts),
    loadPremoveContext(opts),
  ]);
  const regime = await loadRegimeSafe(ranked.tide);

  const adjusted = withActionableAdjustments(ranked.items, premove.keys, undefined, {
    spots: premove.spots,
    regime: toActionableRegime(regime),
  });
  adjusted.sort(compareActionable);

  const { kept, dropped } = applyConcentrationCaps(
    adjusted,
    regimeListCap(regime, MAX_PICKS),
    regimeCaps(regime),
  );
  // Pre-release lockout: no new picks until the window closes.
  const locked = lockoutWarning(regime);
  const picks = (locked ? [] : kept).map((row, index) => {
    const copy = buildPickCopy(row);
    return {
      ...row,
      rank: index + 1,
      ...copy,
      exitPlan: buildExitPlan(row, { riskyRegime: Boolean(regime?.rules.active), ivEvents: regime?.ivEvents }),
    };
  });

  return {
    source: ranked.source,
    fetchedAt: ranked.fetchedAt,
    picks,
    tide: ranked.tide,
    warning: locked ?? ranked.warning,
    quotaBlocked: ranked.quotaBlocked,
    authFailed: ranked.authFailed,
    regime: regimeBrief(regime),
    capDrops: dropped,
  };
}
