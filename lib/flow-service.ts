import "server-only";

import type { FlowAlert, FlowFilters, FlowResponse, TideSnapshot } from "@/lib/types";
import { toNumber } from "@/lib/numbers";
import { rankAlerts } from "@/lib/scoring";
import { buildMockAlerts, buildMockTide, buildMockTickerTides } from "@/lib/mock";
import {
  fetchChainTrades,
  fetchFlowAlerts,
  fetchMarketTide,
  fetchOptionQuote,
  fetchTickerTides,
  hasUnusualWhalesKey,
} from "@/lib/uw";
import {
  fadeFromLaterPrints,
  fadeFromQuote,
  isFloorOnlyCandidate,
  type ChainFadeSignal,
} from "@/lib/chain-context";
import {
  isExpiredContract,
  isInCurrentSession,
  newerThanParam,
  sessionHasOpened,
  tradingDateET,
} from "@/lib/session";

function looksUnusual(alert: FlowAlert): boolean {
  if (alert.all_opening_trades) return true;
  if (alert.has_sweep || alert.has_floor) return true;
  if (toNumber(alert.volume_oi_ratio) >= 1) return true;
  if (alert.total_size > 0 && alert.open_interest > 0 && alert.total_size > alert.open_interest) {
    return true;
  }
  const rule = (alert.alert_rule || "").trim();
  return rule.length > 0 && rule.toLowerCase() !== "none";
}

async function enrichChainFades(alerts: FlowAlert[]): Promise<Record<string, ChainFadeSignal>> {
  const out: Record<string, ChainFadeSignal> = {};
  if (!hasUnusualWhalesKey()) return out;

  const candidates = alerts
    .filter((alert) => isFloorOnlyCandidate(alert) || toNumber(alert.total_premium) >= 250_000)
    .slice(0, 8);

  await Promise.all(
    candidates.map(async (alert) => {
      if (!alert.option_chain) return;
      try {
        const quote = await fetchOptionQuote(
          alert.ticker,
          alert.option_chain,
          toNumber(alert.price) || undefined,
        );
        const fromQuote = fadeFromQuote(alert, quote?.quality === "flow_print" ? null : quote?.last);
        if (fromQuote.faded) {
          out[alert.id] = fromQuote;
          return;
        }
        const later = await fetchChainTrades(alert.option_chain, alert.created_at);
        const fromTape = fadeFromLaterPrints(alert, later);
        if (fromTape.faded) out[alert.id] = fromTape;
      } catch {
        // Best-effort; scoring still works without chain history.
      }
    }),
  );
  return out;
}

function applyFilters(
  alerts: FlowAlert[],
  filters: FlowFilters,
  context: {
    marketTide?: TideSnapshot | null;
    tickerTides?: Record<string, TideSnapshot | null>;
    chainFades?: Record<string, ChainFadeSignal>;
    now?: Date;
  },
) {
  const ranked = rankAlerts(alerts, context);
  return ranked.filter((row) => {
    if (!isInCurrentSession(row.alert.created_at, context.now)) return false;
    if (isExpiredContract(row.alert.expiry, context.now)) return false;
    if (row.stale && filters.strictAntiFade) return false;
    if (row.dte < filters.minDte || row.dte > filters.maxDte) return false;
    if (filters.side !== "all" && row.alert.type !== filters.side) return false;
    if (toNumber(row.alert.total_premium) < filters.minPremium) return false;
    if (row.score < filters.minConviction) return false;
    if (filters.ticker && row.alert.ticker !== filters.ticker) return false;
    if (filters.strictAntiFade && row.fadeProne) return false;
    if (filters.unusual && !looksUnusual(row.alert)) return false;
    return true;
  });
}

function emptyLive(filters: FlowFilters, warning: string): FlowResponse {
  return {
    source: "live",
    fetchedAt: new Date().toISOString(),
    unusual: filters.unusual,
    tide: null,
    items: [],
    rawCount: 0,
    warning,
  };
}

export async function loadRankedFlow(
  filters: FlowFilters,
  opts?: { olderThan?: string; maxPages?: number },
): Promise<FlowResponse> {
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

  if (!sessionHasOpened()) {
    return emptyLive(
      filters,
      `US cash session has not opened yet (9:30 ET ${tradingDateET()}).`,
    );
  }

  try {
    const alerts = await fetchFlowAlerts({
      minPremium: filters.minPremium,
      side: filters.side,
      ticker: filters.ticker || undefined,
      limit: 200,
      newerThan: newerThanParam(),
      olderThan: opts?.olderThan,
      maxPages: opts?.maxPages ?? 2,
    });

    const sessionAlerts = alerts.filter(
      (alert) => isInCurrentSession(alert.created_at) && !isExpiredContract(alert.expiry),
    );

    let tide: TideSnapshot | null = null;
    let tickerTides: Record<string, TideSnapshot | null> = {};
    let warning: string | undefined;

    try {
      tide = await fetchMarketTide();
    } catch (error) {
      warning = error instanceof Error ? error.message : "Market tide unavailable.";
    }

    try {
      tickerTides = await fetchTickerTides(sessionAlerts.map((a) => a.ticker), 8);
    } catch {
      // Ticker tide is optional; scoring still works without it.
    }

    let chainFades: Record<string, ChainFadeSignal> = {};
    try {
      chainFades = await enrichChainFades(sessionAlerts);
    } catch {
      chainFades = {};
    }

    const items = applyFilters(sessionAlerts, filters, { marketTide: tide, tickerTides, chainFades });
    if (items.length === 0 && !warning) {
      warning = `No prints in the current US cash session since 9:30 ET ${tradingDateET()}. Not filling from older Unusual Whales floor alerts.`;
    }
    return {
      source: "live",
      fetchedAt: new Date().toISOString(),
      unusual: filters.unusual,
      tide,
      items,
      rawCount: sessionAlerts.length,
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
