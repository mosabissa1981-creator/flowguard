import "server-only";

import type { FlowAlert, FlowFilters, FlowResponse, SessionInfo, TideSnapshot } from "@/lib/types";
import { tideFromPremiums, toNumber } from "@/lib/numbers";
import { rankAlerts } from "@/lib/scoring";
import { buildMockAlerts, buildMockTide, buildMockTickerTides } from "@/lib/mock";
import { fetchMarketTide, hasUnusualWhalesKey } from "@/lib/uw";
import { getSessionTape } from "@/lib/session-tape";
import { fadeFromLaterPrints, type ChainFadeSignal } from "@/lib/chain-context";
import {
  isExpiredContract,
  isInCurrentSession,
  sessionHasOpened,
  tradingDateET,
} from "@/lib/session";
import {
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

/**
 * Direction-aware ticker tide (same convention as the Puts lane): ask-side calls and bid-side puts
 * are bullish premium; ask-side puts and bid-side calls are bearish. Previously ask/bid were summed
 * regardless of type, so heavy put BUYING read as a "bullish" ticker tide and penalised put setups.
 */
function tickerTidesFromAlerts(alerts: FlowAlert[]): Record<string, TideSnapshot | null> {
  const byTicker = new Map<string, { bull: number; bear: number }>();
  for (const alert of alerts) {
    const cur = byTicker.get(alert.ticker) ?? { bull: 0, bear: 0 };
    const ask = toNumber(alert.total_ask_side_prem);
    const bid = toNumber(alert.total_bid_side_prem);
    if (String(alert.type).toLowerCase() === "put") {
      cur.bear += ask;
      cur.bull += bid;
    } else {
      cur.bull += ask;
      cur.bear += bid;
    }
    byTicker.set(alert.ticker, cur);
  }
  const out: Record<string, TideSnapshot | null> = {};
  for (const [ticker, prem] of byTicker) {
    out[ticker] = tideFromPremiums(prem.bull, prem.bear, null);
  }
  return out;
}

function peerFades(alerts: FlowAlert[]): Record<string, ChainFadeSignal> {
  const out: Record<string, ChainFadeSignal> = {};
  const byChain = new Map<string, FlowAlert[]>();
  for (const a of alerts) {
    if (!a.option_chain) continue;
    const list = byChain.get(a.option_chain);
    if (list) list.push(a);
    else byChain.set(a.option_chain, [a]);
  }
  for (const alert of alerts) {
    const fade = fadeFromLaterPrints(alert, byChain.get(alert.option_chain) ?? []);
    if (fade.faded) out[alert.id] = fade;
  }
  return out;
}

/** Ranking is filter-independent: memoize it per tape array + tide for 60 s (every lane shares one ranking). */
const RANK_MEMO_MS = 60_000;
let rankCache: { alerts: FlowAlert[]; tide: TideSnapshot | null | undefined; at: number; ranked: ReturnType<typeof rankAlerts> } | null = null;

function rankMemo(alerts: FlowAlert[], context: Parameters<typeof rankAlerts>[1] & object): ReturnType<typeof rankAlerts> {
  if (context.now) return rankAlerts(alerts, context);
  const hit = rankCache;
  if (hit && hit.alerts === alerts && hit.tide === context.marketTide && Date.now() - hit.at < RANK_MEMO_MS) return hit.ranked;
  const ranked = rankAlerts(alerts, context);
  rankCache = { alerts, tide: context.marketTide, at: Date.now(), ranked };
  return ranked;
}

const derivedCache = new WeakMap<FlowAlert[], { tickerTides: Record<string, TideSnapshot | null>; chainFades: Record<string, ChainFadeSignal> }>();
function derived(alerts: FlowAlert[]) {
  let d = derivedCache.get(alerts);
  if (!d) {
    d = { tickerTides: tickerTidesFromAlerts(alerts), chainFades: peerFades(alerts) };
    derivedCache.set(alerts, d);
  }
  return d;
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
  const ranked = rankMemo(alerts, context);
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
  extra: Pick<FlowResponse, "source" | "fetchedAt" | "warning" | "quotaBlocked" | "authFailed" | "session"> & { coverageNote?: string },
): FlowResponse {
  const { tickerTides, chainFades } = derived(alerts);
  const items = applyFilters(alerts, filters, { marketTide: tide, tickerTides, chainFades });
  let warning = extra.warning;
  if (items.length === 0 && !warning && extra.source === "live") {
    // Distinguish "no prints at all" from "prints exist but none pass this view's filters".
    warning =
      alerts.length === 0
        ? `No prints in the current US cash session since 9:30 ET ${tradingDateET()}. Not filling from older Unusual Whales floor alerts.`
        : `${alerts.length} session print${alerts.length === 1 ? "" : "s"} on the tape since 9:30 ET${extra.coverageNote ?? ""}; none pass this view's filters right now.`;
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
    session: extra.session,
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
/** Board views keep the familiar "latest prints" window; lanes/picks/AI review evaluate the whole session. */
const WINDOW_ALERTS = 400;
function windowSlice(alerts: FlowAlert[]): FlowAlert[] {
  return alerts.slice(0, WINDOW_ALERTS);
}

export async function loadRankedFlow(
  filters: FlowFilters,
  opts?: { forceFresh?: boolean; scope?: "session" | "window" },
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

  const scope = opts?.scope ?? "session";
  const blocked = await isUwBlocked();

  try {
    const forceFresh = Boolean(opts?.forceFresh);
    // Full-session accumulator (incremental UW paging, deduped, kv-backed). Never Blob list().
    const tape = await getSessionTape({ force: forceFresh, allowUw: !blocked });
    if (tape.alerts.length === 0) {
      if (blocked) return fromLastGoodOrEmpty(filters, quotaResetUtcMs());
      if (tape.meta.lastError) throw new Error(tape.meta.lastError);
    }
    let tide: TideSnapshot | null = null;
    if (!blocked) {
      tide = await fetchMarketTide(forceFresh).catch((error) => {
        if (isUwQuotaError(error)) return null;
        throw error;
      });
    }
    const all = tape.alerts.filter((alert) => !isExpiredContract(alert.expiry));
    const sessionAlerts = scope === "window" ? windowSlice(all) : all;
    // Small last-good snapshot (newest 400) for the quota-down fallback.
    rememberTape(all.slice(0, WINDOW_ALERTS), tide);
    const session: SessionInfo = {
      prints: all.length,
      fromIso: tape.coverage.fromIso,
      toIso: tape.coverage.toIso,
      complete: tape.coverage.complete,
      holes: tape.coverage.holes,
      syncedAt: tape.meta.syncedAt ? new Date(tape.meta.syncedAt).toISOString() : null,
      uwCallsToday: tape.meta.uwCallsToday,
      durable: tape.durable,
      scope,
    };
    const coverageNote = tape.coverage.complete ? "" : " (back-filling earlier prints)";
    return pack(filters, sessionAlerts, tide, {
      source: "live",
      fetchedAt: session.syncedAt ?? new Date().toISOString(),
      warning: blocked ? quotaBanner(quotaResetUtcMs(), session.syncedAt) : undefined,
      quotaBlocked: blocked || undefined,
      session,
      coverageNote,
    });
  } catch (error) {
    if (isUwQuotaError(error)) {
      return fromLastGoodOrEmpty(filters, error.untilMs);
    }
    const last = await loadLastGoodTape();
    const authFailed = isAuthFailure(error);
    const detail = error instanceof Error ? error.message : "error";
    const warning = authFailed
      ? `Unusual Whales rejected the API key (${detail}). Tap the key icon, copy a fresh token, and tap Paste and save. Not a daily cap.`
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
