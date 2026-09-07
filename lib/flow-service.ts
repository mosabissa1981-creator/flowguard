import "server-only";

import type { FlowAlert, FlowFilters, FlowResponse, TideSnapshot } from "@/lib/types";
import { tideFromPremiums, toNumber } from "@/lib/numbers";
import { rankAlerts } from "@/lib/scoring";
import { buildMockAlerts, buildMockTide, buildMockTickerTides } from "@/lib/mock";
import { fetchFlowAlerts, fetchMarketTide, hasUnusualWhalesKey } from "@/lib/uw";
import { fadeFromLaterPrints, type ChainFadeSignal } from "@/lib/chain-context";
import {
  isExpiredContract,
  isInCurrentSession,
  newerThanParam,
  sessionHasOpened,
  tradingDateET,
} from "@/lib/session";
import {
  getFreshTape,
  isUwBlocked,
  isUwQuotaError,
  loadLastGoodTape,
  quotaBanner,
  quotaResetUtcMs,
  rememberTape,
} from "@/lib/uw-quota";

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

function tickerTidesFromAlerts(alerts: FlowAlert[]): Record<string, TideSnapshot | null> {
  const byTicker = new Map<string, { ask: number; bid: number }>();
  for (const alert of alerts) {
    const cur = byTicker.get(alert.ticker) ?? { ask: 0, bid: 0 };
    cur.ask += toNumber(alert.total_ask_side_prem);
    cur.bid += toNumber(alert.total_bid_side_prem);
    byTicker.set(alert.ticker, cur);
  }
  const out: Record<string, TideSnapshot | null> = {};
  for (const [ticker, prem] of byTicker) {
    out[ticker] = tideFromPremiums(prem.ask, prem.bid, null);
  }
  return out;
}

function peerFades(alerts: FlowAlert[]): Record<string, ChainFadeSignal> {
  const out: Record<string, ChainFadeSignal> = {};
  for (const alert of alerts) {
    const fade = fadeFromLaterPrints(alert, alerts);
    if (fade.faded) out[alert.id] = fade;
  }
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

function mockResponse(filters: FlowFilters): FlowResponse {
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

function isAuthFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /401|403|authentication_required|unauthorized|not recognized/i.test(text);
}

function pack(
  filters: FlowFilters,
  alerts: FlowAlert[],
  tide: TideSnapshot | null,
  extra: Pick<FlowResponse, "source" | "fetchedAt" | "warning" | "quotaBlocked" | "authFailed">,
): FlowResponse {
  const tickerTides = tickerTidesFromAlerts(alerts);
  const chainFades = peerFades(alerts);
  const items = applyFilters(alerts, filters, { marketTide: tide, tickerTides, chainFades });
  let warning = extra.warning;
  if (items.length === 0 && !warning && extra.source === "live") {
    warning = `No prints in the current US cash session since 9:30 ET ${tradingDateET()}. Not filling from older Unusual Whales floor alerts.`;
  }
  return {
    source: extra.source,
    fetchedAt: extra.fetchedAt,
    unusual: filters.unusual,
    tide,
    items,
    rawCount: alerts.length,
    warning,
    quotaBlocked: extra.quotaBlocked,
    authFailed: extra.authFailed,
  };
}

async function fromLastGoodOrEmpty(filters: FlowFilters, untilMs: number): Promise<FlowResponse> {
  const last = await loadLastGoodTape();
  if (last?.alerts?.length) {
    const sessionAlerts = last.alerts.filter(
      (alert) => isInCurrentSession(alert.created_at) && !isExpiredContract(alert.expiry),
    );
    return pack(filters, sessionAlerts, last.tide, {
      source: "cached",
      fetchedAt: last.savedAt,
      warning: quotaBanner(untilMs, last.savedAt),
      quotaBlocked: true,
    });
  }
  return {
    source: "cached",
    fetchedAt: new Date().toISOString(),
    unusual: filters.unusual,
    tide: null,
    items: [],
    rawCount: 0,
    warning: quotaBanner(untilMs, null),
    quotaBlocked: true,
  };
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

/** Shared session tape: one UW flow-alerts pull, scored locally for flow / picks / premove / morning. */
export async function loadRankedFlow(
  filters: FlowFilters,
  opts?: { forceFresh?: boolean },
): Promise<FlowResponse> {
  const live = await hasUnusualWhalesKey();

  if (!live) {
    return mockResponse(filters);
  }

  if (!sessionHasOpened()) {
    return emptyLive(
      filters,
      `US cash session has not opened yet (9:30 ET ${tradingDateET()}).`,
    );
  }

  if (await isUwBlocked()) {
    return fromLastGoodOrEmpty(filters, quotaResetUtcMs());
  }

  try {
    let alerts: FlowAlert[] = [];
    let tide: TideSnapshot | null = null;
    let fetchedAt = new Date().toISOString();
    let source: FlowResponse["source"] = "live";

    const forceFresh = Boolean(opts?.forceFresh);
    const fresh = forceFresh ? null : await getFreshTape();
    if (fresh) {
      alerts = fresh.alerts;
      tide = fresh.tide;
      fetchedAt = fresh.savedAt;
      source = "live";
    } else {
      alerts = await fetchFlowAlerts({
        minPremium: 10_000,
        side: "all",
        limit: 200,
        newerThan: newerThanParam(),
        maxPages: 2,
        skipCache: forceFresh,
      });
      try {
        tide = await fetchMarketTide(forceFresh);
      } catch (error) {
        if (isUwQuotaError(error)) {
          const sessionAlerts = alerts.filter(
            (alert) => isInCurrentSession(alert.created_at) && !isExpiredContract(alert.expiry),
          );
          rememberTape(sessionAlerts, null);
          return pack(filters, sessionAlerts, null, {
            source: "cached",
            fetchedAt,
            warning: quotaBanner(error.untilMs, fetchedAt),
            quotaBlocked: true,
          });
        }
      }
      const sessionAlerts = alerts.filter(
        (alert) => isInCurrentSession(alert.created_at) && !isExpiredContract(alert.expiry),
      );
      rememberTape(sessionAlerts, tide);
      alerts = sessionAlerts;
    }

    const sessionAlerts = alerts.filter(
      (alert) => isInCurrentSession(alert.created_at) && !isExpiredContract(alert.expiry),
    );

    return pack(filters, sessionAlerts, tide, {
      source,
      fetchedAt,
    });
  } catch (error) {
    if (isUwQuotaError(error)) {
      return fromLastGoodOrEmpty(filters, error.untilMs);
    }
    const last = await loadLastGoodTape();
    const authFailed = isAuthFailure(error);
    const detail = error instanceof Error ? error.message : "error";
    const warning = authFailed
      ? `Unusual Whales rejected the API key (${detail}). Tap the key icon, paste a fresh token, and tap Save key. Not a daily cap.`
      : `Unusual Whales request failed (${detail}). Live board is empty — not substituting mock names. Do not trade this screen.`;
    if (last?.alerts?.length && !authFailed) {
      const sessionAlerts = last.alerts.filter(
        (alert) => isInCurrentSession(alert.created_at) && !isExpiredContract(alert.expiry),
      );
      return pack(filters, sessionAlerts, last.tide, {
        source: "cached",
        fetchedAt: last.savedAt,
        warning: `Unusual Whales request failed (${detail}). Showing last live snapshot — not mock tape. Do not trade this screen as live.`,
      });
    }
    return {
      source: "cached",
      fetchedAt: new Date().toISOString(),
      unusual: filters.unusual,
      tide: null,
      items: [],
      rawCount: 0,
      warning,
      authFailed,
    };
  }
}
