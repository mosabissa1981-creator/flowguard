import "server-only";

import { loadRankedFlow } from "@/lib/flow-service";
import { buildPickCopy } from "@/lib/thesis";
import { PICKS_FILTERS, MAX_PICKS } from "@/lib/picks";
import type { MorningShortlistResponse } from "@/lib/types";
import {
  isInMorningWindow,
  morningOlderThanParam,
  morningWindowClosed,
  sessionHasOpened,
  tradingDateET,
} from "@/lib/session";

const MAX_MORNING = 8;

let cache: { date: string; data: MorningShortlistResponse } | null = null;

export async function loadMorningShortlist(): Promise<MorningShortlistResponse> {
  const today = tradingDateET();

  if (cache && cache.date === today && morningWindowClosed()) {
    return cache.data;
  }

  const label = `Morning shortlist — frozen ${today} 9:30–10:00 ET`;

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

  const ranked = await loadRankedFlow(
    {
      ...PICKS_FILTERS,
      minConviction: 55,
      strictAntiFade: true,
    },
    { olderThan: morningOlderThanParam(), maxPages: 6 },
  );

  const morningAlerts = ranked.items.filter((row) => isInMorningWindow(row.alert.created_at));

  const picks = morningAlerts.slice(0, Math.min(MAX_PICKS, MAX_MORNING)).map((row) => {
    const copy = buildPickCopy(row);
    return { ...row, ...copy };
  });

  const result: MorningShortlistResponse = {
    source: ranked.source,
    fetchedAt: ranked.fetchedAt,
    tradingDate: today,
    snapshotLabel: label,
    frozen: true,
    picks,
    tide: ranked.tide,
    warning:
      morningAlerts.length === 0
        ? `No setups in the 9:30–10:00 ET window on ${today}. Not substituting older whale floors.`
        : ranked.warning,
  };

  if (morningWindowClosed()) {
    cache = { date: today, data: result };
  }

  return result;
}
