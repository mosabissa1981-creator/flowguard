import "server-only";

import type { FlowAlert, FlowFilters, FlowResponse, TideSnapshot } from "@/lib/types";
import { toNumber } from "@/lib/numbers";
import { rankAlerts } from "@/lib/scoring";
import { buildMockAlerts, buildMockTide, buildMockTickerTides } from "@/lib/mock";
import {
  fetchFlowAlerts,
  fetchMarketTide,
  fetchTickerTides,
  hasUnusualWhalesKey,
} from "@/lib/uw";

function applyFilters(
  alerts: FlowAlert[],
  filters: FlowFilters,
  context: {
    marketTide?: TideSnapshot | null;
    tickerTides?: Record<string, TideSnapshot | null>;
  },
) {
  const ranked = rankAlerts(alerts, context);
  return ranked.filter((row) => {
    if (row.dte < filters.minDte || row.dte > filters.maxDte) return false;
    if (filters.side !== "all" && row.alert.type !== filters.side) return false;
    if (toNumber(row.alert.total_premium) < filters.minPremium) return false;
    if (row.score < filters.minConviction) return false;
    if (filters.ticker && row.alert.ticker !== filters.ticker) return false;
    if (filters.strictAntiFade && row.fadeProne) return false;
    return true;
  });
}

export async function loadRankedFlow(filters: FlowFilters): Promise<FlowResponse> {
  const live = hasUnusualWhalesKey();

  if (!live) {
    const alerts = buildMockAlerts();
    const tide = buildMockTide();
    const tickerTides = buildMockTickerTides();
    const items = applyFilters(alerts, filters, { marketTide: tide, tickerTides });
    return {
      source: "mock",
      fetchedAt: new Date().toISOString(),
      unusual: filters.unusual,
      tide,
      items,
      rawCount: alerts.length,
    };
  }

  try {
    const alerts = await fetchFlowAlerts({
      unusual: filters.unusual,
      minPremium: filters.minPremium,
      side: filters.side,
      ticker: filters.ticker || undefined,
      limit: 120,
    });

    let tide: TideSnapshot | null = null;
    let tickerTides: Record<string, TideSnapshot | null> = {};
    let warning: string | undefined;

    try {
      tide = await fetchMarketTide();
    } catch (error) {
      warning = error instanceof Error ? error.message : "Market tide unavailable.";
    }

    try {
      tickerTides = await fetchTickerTides(alerts.map((a) => a.ticker), 8);
    } catch {
      // Ticker tide is optional; scoring still works without it.
    }

    const items = applyFilters(alerts, filters, { marketTide: tide, tickerTides });
    return {
      source: "live",
      fetchedAt: new Date().toISOString(),
      unusual: filters.unusual,
      tide,
      items,
      rawCount: alerts.length,
      warning,
    };
  } catch (error) {
    const alerts = buildMockAlerts();
    const tide = buildMockTide();
    const tickerTides = buildMockTickerTides();
    const items = applyFilters(alerts, filters, { marketTide: tide, tickerTides });
    return {
      source: "mock",
      fetchedAt: new Date().toISOString(),
      unusual: filters.unusual,
      tide,
      items,
      rawCount: alerts.length,
      warning:
        error instanceof Error
          ? `Unusual Whales request failed (${error.message}). Showing mock tape.`
          : "Unusual Whales request failed. Showing mock tape.",
    };
  }
}
