import "server-only";

import {
  congressMarketDates,
  dedupeCongressTrades,
  filedWindow,
  inFilingWindow,
  normalizeCongressTrade,
  selectCongressTrades,
} from "@/lib/congress";
import type { CongressQuery, CongressResponse, CongressStatus, CongressTrade } from "@/lib/types";
import { fetchCongressRecentTrades, hasUnusualWhalesKey } from "@/lib/uw";
import { isUwBlocked, isUwQuotaError, quotaResetUtcMs } from "@/lib/uw-quota";

/**
 * Congressional disclosure feed for the research panel only.
 * Do not import this from picks, premove, morning, or scoring.
 *
 * Date field: `filed_at_date` (STOCK Act filing / disclosure date).
 * UW `GET /api/congress/recent-trades` takes one trading `date` per call.
 * The default week asks for each weekday in the last 7 America/New_York
 * calendar days, then keeps rows whose `filed_at_date` falls in that window.
 * `transaction_date` is returned for display and is often weeks older.
 * It is used as the window key only when `filed_at_date` is missing.
 */

const EMPTY_NOTE = "Congress list is empty — no sample politicians.";

function isAuthFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /401|403|authentication_required|unauthorized|not recognized/i.test(text);
}

function isUnprocessable(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /\b422\b|unprocessable/i.test(text);
}

function publicError(error: unknown): string {
  const text = error instanceof Error ? error.message : "Congress disclosures are unavailable.";
  const clean = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 180);
  return `${clean} ${EMPTY_NOTE}`;
}

function quotaMessage(): string {
  const reset = new Date(quotaResetUtcMs()).toISOString().slice(11, 16);
  return `Unusual Whales rate limit. ${EMPTY_NOTE} Cap resets ~${reset} UTC.`;
}

function emptyResponse(
  query: CongressQuery,
  datesQueried: string[],
  windowStart: string | null,
  windowEnd: string | null,
  status: Exclude<CongressStatus, "ok">,
  message: string,
): CongressResponse {
  return {
    source: "empty",
    status,
    message,
    fetchedAt: new Date().toISOString(),
    dateField: "filed_at_date",
    endpoint: "/api/congress/recent-trades",
    windowDays: query.date ? 1 : query.days,
    windowStart,
    windowEnd,
    datesQueried,
    side: query.side,
    ticker: query.ticker,
    limit: query.limit,
    contextOnly: true,
    scoring: "excluded",
    trades: [],
  };
}

function sideLabel(side: CongressQuery["side"]): string {
  if (side === "buy") return "buys";
  if (side === "sell") return "sells";
  return "trades";
}

export async function loadCongressFeed(query: CongressQuery, skipCache = false): Promise<CongressResponse> {
  const window = query.date ? { start: query.date, end: query.date } : filedWindow(new Date(), query.days);
  const dates = query.date ? [query.date] : congressMarketDates(new Date(), query.days);

  if (!(await hasUnusualWhalesKey())) {
    return emptyResponse(
      query,
      dates,
      window.start,
      window.end,
      "missing_key",
      `UNUSUAL_WHALES_API_KEY is not set. ${EMPTY_NOTE}`,
    );
  }

  if (await isUwBlocked()) {
    return emptyResponse(query, dates, window.start, window.end, "quota", quotaMessage());
  }

  const collected: CongressTrade[] = [];
  let hardError: unknown = null;
  let skippedDates = 0;

  const results = await Promise.allSettled(
    dates.map((date) =>
      fetchCongressRecentTrades({
        date,
        ticker: query.ticker ?? undefined,
        limit: 200,
        skipCache,
      }),
    ),
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const row of result.value) {
        const trade = normalizeCongressTrade(row);
        if (trade) collected.push(trade);
      }
      continue;
    }
    if (isUwQuotaError(result.reason) || (await isUwBlocked())) {
      return emptyResponse(query, dates, window.start, window.end, "quota", quotaMessage());
    }
    if (isAuthFailure(result.reason)) {
      return emptyResponse(
        query,
        dates,
        window.start,
        window.end,
        "auth",
        `Unusual Whales rejected the API key. ${EMPTY_NOTE}`,
      );
    }
    if (isUnprocessable(result.reason)) {
      skippedDates += 1;
      continue;
    }
    hardError = result.reason;
  }

  if (collected.length === 0 && hardError && skippedDates < dates.length) {
    return emptyResponse(query, dates, window.start, window.end, "error", publicError(hardError));
  }

  const inWindow = query.date
    ? collected
    : collected.filter((trade) => inFilingWindow(trade, window.start, window.end));
  const trades = selectCongressTrades(dedupeCongressTrades(inWindow), query);
  const label = sideLabel(query.side);
  const span = query.date ? `on ${query.date}` : `filed ${window.start} through ${window.end} ET`;

  return {
    source: "live",
    status: "ok",
    message:
      trades.length === 0
        ? `No congressional ${label} with filed_at_date ${span}. Transaction dates can be older and are not the window. Not used in pick scoring.`
        : `${trades.length} congressional ${label}. Window is filed_at_date ${span}. transaction_date is the disclosed trade date and can be older. Not used in pick scoring.`,
    fetchedAt: new Date().toISOString(),
    dateField: "filed_at_date",
    endpoint: "/api/congress/recent-trades",
    windowDays: query.date ? 1 : query.days,
    windowStart: window.start,
    windowEnd: window.end,
    datesQueried: dates,
    side: query.side,
    ticker: query.ticker,
    limit: query.limit,
    contextOnly: true,
    scoring: "excluded",
    trades,
    warning: hardError ? "Some filing dates could not be loaded." : undefined,
  };
}
