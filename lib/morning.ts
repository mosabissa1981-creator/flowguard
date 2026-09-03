import "server-only";

import { loadRankedFlow } from "@/lib/flow-service";
import { buildPickCopy } from "@/lib/thesis";
import { PICKS_FILTERS, MAX_PICKS } from "@/lib/picks";
import type { MorningShortlistResponse } from "@/lib/types";

const MORNING_WINDOW_MINUTES = 30;

function etNow(): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
}

function tradingDateET(): string {
  const et = etNow();
  const y = et.getFullYear();
  const m = String(et.getMonth() + 1).padStart(2, "0");
  const d = String(et.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function morningCutoffET(): Date {
  const et = etNow();
  et.setHours(9, 30 + MORNING_WINDOW_MINUTES, 0, 0);
  return et;
}

function marketOpenET(): Date {
  const et = etNow();
  et.setHours(9, 30, 0, 0);
  return et;
}

let cache: { date: string; data: MorningShortlistResponse } | null = null;

export async function loadMorningShortlist(): Promise<MorningShortlistResponse> {
  const today = tradingDateET();

  if (cache && cache.date === today) {
    return cache.data;
  }

  const ranked = await loadRankedFlow({
    ...PICKS_FILTERS,
    minConviction: 55,
    strictAntiFade: true,
  });

  const openET = marketOpenET();
  const cutoff = morningCutoffET();

  const morningAlerts = ranked.items.filter((row) => {
    const created = new Date(row.alert.created_at);
    if (!Number.isFinite(created.getTime())) return true;
    const createdET = new Date(
      created.toLocaleString("en-US", { timeZone: "America/New_York" }),
    );
    return createdET >= openET && createdET <= cutoff;
  });

  const pool = morningAlerts.length >= 3 ? morningAlerts : ranked.items;

  const picks = pool.slice(0, Math.min(MAX_PICKS, 8)).map((row) => {
    const copy = buildPickCopy(row);
    return { ...row, ...copy };
  });

  const label = `Morning shortlist — frozen ${today} 9:30–10:00 ET`;

  const result: MorningShortlistResponse = {
    source: ranked.source,
    fetchedAt: ranked.fetchedAt,
    tradingDate: today,
    snapshotLabel: label,
    frozen: true,
    picks,
    tide: ranked.tide,
    warning:
      morningAlerts.length < 3
        ? "Pre-open window had fewer than 3 setups. Showing the top of the full tape instead."
        : ranked.warning,
  };

  cache = { date: today, data: result };
  return result;
}
