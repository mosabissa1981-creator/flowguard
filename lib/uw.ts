import "server-only";

import type { FlowAlert, NetPremTick, TideSnapshot, WatchQuote } from "@/lib/types";
import { tideFromPremiums, toBool, toNumber } from "@/lib/numbers";

const UW_BASE = "https://api.unusualwhales.com";
const CLIENT_ID = "100001";

let runtimeKey = "";

export function setRuntimeUnusualWhalesKey(key: string) {
  runtimeKey = key.trim();
  if (runtimeKey) {
    process.env.UNUSUAL_WHALES_API_KEY = runtimeKey;
  }
}

export function getUnusualWhalesKey(): string {
  return runtimeKey || process.env.UNUSUAL_WHALES_API_KEY?.trim() || "";
}

export function hasUnusualWhalesKey(): boolean {
  return getUnusualWhalesKey().length > 0;
}

function buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>) {
  const url = new URL(path, UW_BASE);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function uwGet<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const key = getUnusualWhalesKey();
  if (!key) {
    throw new Error("UNUSUAL_WHALES_API_KEY is not set");
  }

  const url = buildUrl(path, params);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "UW-CLIENT-API-ID": CLIENT_ID,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Unusual Whales ${path} ${response.status}: ${body.slice(0, 240)}`);
  }

  return (await response.json()) as T;
}

function asString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function normalizeFlowAlert(raw: Record<string, unknown>): FlowAlert {
  const typeRaw = asString(raw.type, "call").toLowerCase();
  return {
    alert_rule: asString(raw.alert_rule),
    all_opening_trades: toBool(raw.all_opening_trades),
    ask: asString(raw.ask),
    bid: asString(raw.bid),
    created_at: asString(raw.created_at),
    expiry: asString(raw.expiry),
    has_floor: toBool(raw.has_floor),
    has_multileg: toBool(raw.has_multileg),
    has_singleleg: toBool(raw.has_singleleg),
    has_sweep: toBool(raw.has_sweep),
    id: asString(raw.id || raw.option_chain || `${raw.ticker}-${raw.created_at}`),
    issue_type: asString(raw.issue_type),
    marketcap: raw.marketcap === null || raw.marketcap === undefined ? null : toNumber(raw.marketcap, 0),
    open_interest: Math.round(toNumber(raw.open_interest)),
    option_chain: asString(raw.option_chain),
    price: asString(raw.price),
    strike: asString(raw.strike),
    ticker: asString(raw.ticker).toUpperCase(),
    total_ask_side_prem: asString(raw.total_ask_side_prem, "0"),
    total_bid_side_prem: asString(raw.total_bid_side_prem, "0"),
    total_premium: asString(raw.total_premium, "0"),
    total_size: Math.round(toNumber(raw.total_size)),
    trade_count: Math.round(toNumber(raw.trade_count)),
    type: typeRaw === "put" ? "put" : "call",
    underlying_price: asString(raw.underlying_price),
    volume: Math.round(toNumber(raw.volume)),
    volume_oi_ratio: asString(raw.volume_oi_ratio, "0"),
  };
}

export async function fetchFlowAlerts(params: {
  unusual?: boolean;
  minPremium?: number;
  side?: "all" | "call" | "put";
  ticker?: string;
  limit?: number;
}): Promise<FlowAlert[]> {
  const query: Record<string, string | number | boolean | undefined> = {
    limit: params.limit ?? 100,
    min_premium: params.minPremium && params.minPremium > 0 ? params.minPremium : undefined,
    ticker_symbol: params.ticker ? params.ticker.toUpperCase() : undefined,
  };

  if (params.unusual) query.unusual = true;
  if (params.side === "call") query.is_call = true;
  if (params.side === "put") query.is_put = true;

  const payload = await uwGet<{ data?: Record<string, unknown>[] }>(
    "/api/option-trades/flow-alerts",
    query,
  );

  return (payload.data ?? []).map(normalizeFlowAlert);
}

export async function fetchMarketTide(): Promise<TideSnapshot | null> {
  const payload = await uwGet<{
    data?: Array<{
      timestamp?: string;
      net_call_premium?: string | number;
      net_put_premium?: string | number;
    }>;
  }>("/api/market/market-tide", { interval_5m: false });

  const rows = payload.data ?? [];
  const last = rows[rows.length - 1];
  if (!last) return null;
  return tideFromPremiums(
    toNumber(last.net_call_premium),
    toNumber(last.net_put_premium),
    last.timestamp ?? null,
  );
}

export async function fetchNetPremTicks(ticker: string): Promise<NetPremTick[]> {
  const payload = await uwGet<{ data?: Array<Record<string, unknown>> }>(
    `/api/stock/${encodeURIComponent(ticker.toUpperCase())}/net-prem-ticks`,
  );

  return (payload.data ?? []).map((row) => ({
    date: asString(row.date),
    tape_time: asString(row.tape_time ?? row.timestamp),
    net_call_premium: asString(row.net_call_premium, "0"),
    net_put_premium: asString(row.net_put_premium, "0"),
    net_call_volume: toNumber(row.net_call_volume),
    net_put_volume: toNumber(row.net_put_volume),
    call_volume: toNumber(row.call_volume),
    put_volume: toNumber(row.put_volume),
  }));
}

export function tideFromTicks(ticks: NetPremTick[]): TideSnapshot | null {
  const last = ticks[ticks.length - 1];
  if (!last) return null;
  return tideFromPremiums(
    toNumber(last.net_call_premium),
    toNumber(last.net_put_premium),
    last.tape_time || null,
  );
}

export async function fetchTickerTides(
  tickers: string[],
  limit = 10,
): Promise<Record<string, TideSnapshot | null>> {
  const unique = [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))].slice(0, limit);
  const entries = await Promise.all(
    unique.map(async (ticker) => {
      try {
        const ticks = await fetchNetPremTicks(ticker);
        return [ticker, tideFromTicks(ticks)] as const;
      } catch {
        return [ticker, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

function firstPositive(...values: unknown[]): number | null {
  for (const value of values) {
    const n = toNumber(value, NaN);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function quoteFromContract(raw: Record<string, unknown>, flowPrint?: number): WatchQuote | null {
  const last = firstPositive(raw.last_price, raw.price, raw.close);
  const bid = firstPositive(raw.nbbo_bid, raw.bid);
  const ask = firstPositive(raw.nbbo_ask, raw.ask);
  const mid = bid != null && ask != null ? (bid + ask) / 2 : null;
  const asOf = asString(raw.last_tape_time || raw.date || raw.executed_at, "") || null;

  if (last != null) {
    return { last, bid, ask, asOf, quality: "uw_last" };
  }
  if (mid != null || ask != null || bid != null) {
    return {
      last: mid ?? ask ?? bid ?? 0,
      bid,
      ask,
      asOf,
      quality: "uw_nbbo",
    };
  }
  if (flowPrint && flowPrint > 0) {
    return { last: flowPrint, bid, ask, asOf, quality: "flow_print" };
  }
  return null;
}

export function quoteFromFlowPrint(price: number | undefined): WatchQuote | null {
  if (!price || price <= 0) return null;
  return { last: price, bid: null, ask: null, asOf: null, quality: "flow_print" };
}

export async function fetchOptionQuote(
  ticker: string,
  optionSymbol: string,
  flowPrint?: number,
): Promise<WatchQuote | null> {
  const symbol = optionSymbol.trim();
  const name = ticker.trim().toUpperCase();
  if (!symbol || !name) return quoteFromFlowPrint(flowPrint);

  try {
    const url = buildUrl(`/api/stock/${encodeURIComponent(name)}/option-contracts`, { limit: 5 });
    url.searchParams.append("option_symbol[]", symbol);
    const key = getUnusualWhalesKey();
    if (!key) return quoteFromFlowPrint(flowPrint);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "UW-CLIENT-API-ID": CLIENT_ID,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (response.ok) {
      const payload = (await response.json()) as { data?: Record<string, unknown>[] };
      const row =
        (payload.data ?? []).find((item) => asString(item.option_symbol) === symbol) ??
        payload.data?.[0];
      if (row) {
        const quote = quoteFromContract(row, flowPrint);
        if (quote) return quote;
      }
    }
  } catch {
    // Fall through to historic / flow print.
  }

  try {
    const historic = await uwGet<{ chains?: Record<string, unknown>[] }>(
      `/api/option-contract/${encodeURIComponent(symbol)}/historic`,
      { limit: 1 },
    );
    const row = historic.chains?.[historic.chains.length - 1];
    if (row) {
      const quote = quoteFromContract(row, flowPrint);
      if (quote) return quote;
    }
  } catch {
    // Flow print is the last resort.
  }

  return quoteFromFlowPrint(flowPrint);
}

export async function fetchOptionQuotes(
  requests: Array<{ ticker: string; option_chain: string; lastFlowPrint?: number }>,
): Promise<Record<string, WatchQuote | null>> {
  const unique = new Map<string, { ticker: string; option_chain: string; lastFlowPrint?: number }>();
  for (const request of requests) {
    if (!request.option_chain || unique.has(request.option_chain)) continue;
    unique.set(request.option_chain, request);
  }

  const entries = await Promise.all(
    [...unique.values()].map(async (request) => {
      try {
        const quote = await fetchOptionQuote(request.ticker, request.option_chain, request.lastFlowPrint);
        return [request.option_chain, quote] as const;
      } catch {
        return [request.option_chain, quoteFromFlowPrint(request.lastFlowPrint)] as const;
      }
    }),
  );

  return Object.fromEntries(entries);
}

