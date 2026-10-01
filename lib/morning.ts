import "server-only";

import { loadRankedFlow } from "@/lib/flow-service";
import { buildPickCopy } from "@/lib/thesis";
import { PICKS_FILTERS } from "@/lib/filters";
import { MAX_PICKS } from "@/lib/picks";
import { loadPremoveContext } from "@/lib/premove";
import { applyConcentrationCaps } from "@/lib/issuers";
import { loadRegimeSafe, regimeBrief, regimeCaps, regimeListCap, toActionableRegime } from "@/lib/regime";
import { compareActionable, withActionableAdjustments } from "@/lib/scoring";
import type { MorningShortlistResponse } from "@/lib/types";
import {
  isInMorningWindow,
  morningWindowClosed,
  sessionHasOpened,
  tradingDateET,
} from "@/lib/session";
import { loadMorningSnapshot, saveMorningSnapshot } from "@/lib/uw-quota";

const MAX_MORNING = 8;

export async function loadMorningShortlist(): Promise<MorningShortlistResponse> {
  const today = tradingDateET();
  const label = `Morning shortlist — frozen ${today} 9:30–10:00 ET`;

  const stored = await loadMorningSnapshot<MorningShortlistResponse>(today);
  if (stored?.picks && morningWindowClosed() && stored.source !== "mock") {
    return { ...stored, snapshotLabel: stored.snapshotLabel || label, frozen: true };
  }

  if (!sessionHasOpened()) {
    return {
      source: "live",
      fetchedAt: new Date().toISOString(),
      tradingDate: today,
      snapshotLabel: label,
      frozen: true,
      picks: [],
      tide: null,
      warning: `Morning window starts 9:30 ET ${today}.`,
    };
  }

  const ranked = await loadRankedFlow({
    ...PICKS_FILTERS,
    minConviction: 55,
    strictAntiFade: true,
  });

  const [premove, regime] = await Promise.all([loadPremoveContext(), loadRegimeSafe(ranked.tide)]);
  const morningAlerts = withActionableAdjustments(
    ranked.items.filter((row) => isInMorningWindow(row.alert.created_at)),
    premove.keys,
    undefined,
    { spots: premove.spots, regime: toActionableRegime(regime) },
  );
  morningAlerts.sort(compareActionable);

  const { kept, dropped } = applyConcentrationCaps(
    morningAlerts,
    regimeListCap(regime, Math.min(MAX_PICKS, MAX_MORNING)),
    regimeCaps(regime),
  );
  const picks = kept.map((row, index) => {
    const copy = buildPickCopy(row);
    return { ...row, rank: index + 1, ...copy };
  });

  const result: MorningShortlistResponse = {
    source: ranked.source,
    fetchedAt: ranked.fetchedAt,
    tradingDate: today,
    snapshotLabel: label,
    frozen: true,
    picks,
    tide: ranked.tide,
    quotaBlocked: ranked.quotaBlocked,
    authFailed: ranked.authFailed,
    regime: regimeBrief(regime),
    capDrops: dropped,
    warning:
      ranked.quotaBlocked
        ? ranked.warning
        : ranked.authFailed
          ? ranked.warning
        : morningAlerts.length === 0
          ? `No setups in the 9:30–10:00 ET window on ${today}. Not substituting older whale floors.`
          : ranked.warning,
  };

  // Save after the window closes, and also during the window when there is a list, so a
  // hit at ~9:50 ET still freezes something (afternoon re-scoring ages these prints out).
  if (result.source !== "mock" && !result.quotaBlocked && (morningWindowClosed() || picks.length > 0)) {
    void saveMorningSnapshot(today, result);
  }

  return result;
}
