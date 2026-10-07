import "server-only";

import type { FlowAlert, NetPremTick, TideSnapshot, WatchQuote } from "@/lib/types";
import type { HistoricBar } from "@/lib/follow-through";
import { tideFromPremiums, toBool, toNumber } from "@/lib/numbers";
import { loadStoredUwKey, saveStoredUwKey } from "@/lib/uw-key-store";
import {
  CHAIN_TTL_MS,
  FLOW_TTL_MS,
  HISTORIC_TTL_MS,
  NET_PREM_TTL_MS,
  QUOTE_TTL_MS,
  STOCK_STATE_TTL_MS,
  TIDE_TTL_MS,
  UwQuotaError,
  cachedCall,
  isConcurrencyHttp,
  isQuotaHttp,
  isUwBlocked,
  isUwHardBlocked,
  quotaResetUtcMs,
  tripUwQuota,
} from "@/lib/uw-quota";

const UW_BASE = "https://api.unusualwhales.com";
const CLIENT_ID = "100001";

let runtimeKey = "";
let blobChecked = false;

export function setRuntimeUnusualWhalesKey(key: string) {
  runtimeKey = key.trim();
  if (runtimeKey) {
    process.env.UNUSUAL_WHALES_API_KEY = runtimeKey;
  }
}

export async function persistUnusualWhalesKey(key: string): Promise<void> {
  setRuntimeUnusualWhalesKey(key);
  blobChecked = true;
  try {
    await saveStoredUwKey(key);
  } catch {
    // Vercel Blob can be suspended. The process env / runtime key still applies.
  }
}

/** Runtime override, then the last key saved from the phone, then the Vercel env. */
export async function resolveUnusualWhalesKey(): Promise<string> {
  if (runtimeKey) return runtimeKey;
  if (!blobChecked) {
    blobChecked = true;
    try {
      const stored = await loadStoredUwKey();
      if (stored) {
        runtimeKey = stored;
        return runtimeKey;
      }
    } catch {
      // Env fallback still works.
    }
  }
  return process.env.UNUSUAL_WHALES_API_KEY?.trim() || "";
}

export function getUnusualWhalesKey(): string {
  return runtimeKey || process.env.UNUSUAL_WHALES_API_KEY?.trim() || "";
}

export async function hasUnusualWhalesKey(): Promise<boolean> {
  return (await resolveUnusualWhalesKey()).length > 0;
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

const UW_TIMEOUT_MS = 15_000;

/**
 * UW plan cap: 3 concurrent requests per key (429 "exceeded 3 concurrent requests" beyond that). The box
 * study/history jobs share the key, so each server instance keeps at most UW_MAX_CONCURRENCY (default 2)
 * UW requests in flight and queues the rest; a concurrency 429 that still slips through is retried with
 * a short jittered backoff instead of tripping the quota circuit.
 */
const UW_MAX_INFLIGHT = (() => {
  const v = Number(process.env.UW_MAX_CONCURRENCY);
  return Number.isFinite(v) && v >= 1 ? Math.min(3, Math.floor(v)) : 2;
})();
const UW_CONCURRENCY_RETRIES = 4;
let uwInflight = 0;
const uwWaiters: Array<() => void> = [];

async function acquireUwSlot(): Promise<void> {
  if (uwInflight < UW_MAX_INFLIGHT) {
    uwInflight += 1;
    return;
  }
  // The releasing request hands its slot straight to the next waiter (uwInflight unchanged).
  await new Promise<void>((resolve) => uwWaiters.push(resolve));
}

function releaseUwSlot(): void {
  const next = uwWaiters.shift();
  if (next) next();
  else uwInflight = Math.max(0, uwInflight - 1);
}

/** Diagnostics: UW requests queued/in flight on this instance. */
export function uwConcurrencyStats() {
  return { max: UW_MAX_INFLIGHT, inflight: uwInflight, queued: uwWaiters.length };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type UwRequestOpts<T> = {
  /** Only memoize payloads this accepts (empty quote payloads are retried instead of pinned for the TTL). */
  keep?: (value: T) => boolean;
  /** Single-contract quote lookups: try through a short (~90 s burst) circuit; still honor a daily-cap block. */
  allowShortBlock?: boolean;
};

async function uwRequest<T>(url: URL, ttlMs = 0, bust = false, opts: UwRequestOpts<T> = {}): Promise<T> {
  const blocked = () => (opts.allowShortBlock ? isUwHardBlocked() : isUwBlocked());
  if (await blocked()) {
    throw new UwQuotaError(
      "Unusual Whales daily request cap is in effect. Not calling UW.",
      quotaResetUtcMs(),
    );
  }

  return cachedCall(
    url.toString(),
    ttlMs,
    async () => {
      if (await blocked()) {
        throw new UwQuotaError(
          "Unusual Whales daily request cap is in effect. Not calling UW.",
          quotaResetUtcMs(),
        );
      }
      const key = await resolveUnusualWhalesKey();
      if (!key) {
        throw new Error("UNUSUAL_WHALES_API_KEY is not set");
      }
      for (let attempt = 0; ; attempt += 1) {
        await acquireUwSlot();
        let response: Response;
        let body = "";
        let json: T | undefined;
        try {
          response = await fetch(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${key}`,
              "UW-CLIENT-API-ID": CLIENT_ID,
              Accept: "application/json",
            },
            cache: "no-store",
            // Never let one slow UW request hang a route (or the session back-fill) indefinitely.
            signal: AbortSignal.timeout(UW_TIMEOUT_MS),
          });
          if (response.ok) json = (await response.json()) as T;
          else body = await response.text();
        } finally {
          releaseUwSlot();
        }
        if (response.ok) return json as T;
        if (isConcurrencyHttp(response.status, body)) {
          if (attempt < UW_CONCURRENCY_RETRIES) {
            await pause(250 * (attempt + 1) + Math.floor(Math.random() * 250));
            continue;
          }
          throw new Error(`Unusual Whales ${url.pathname} 429 (concurrency, after ${attempt + 1} tries): ${body.slice(0, 120)}`);
        }
        if (isQuotaHttp(response.status, body)) {
          const daily = /daily_request_limit_hit|daily request limit/i.test(body);
          const retryAfter = Number(response.headers.get("retry-after"));
          const until = daily
            ? quotaResetUtcMs()
            : Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 90_000);
          await tripUwQuota(body, until);
          throw new UwQuotaError(`Unusual Whales ${url.pathname} 429: ${body.slice(0, 180)}`, until);
        }
        throw new Error(`Unusual Whales ${url.pathname} ${response.status}: ${body.slice(0, 240)}`);
      }
    },
    bust,
    opts.keep,
  );
}

async function uwGet<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  ttlMs = 0,
  bust = false,
): Promise<T> {
  return uwRequest<T>(buildUrl(path, params), ttlMs, bust);
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
  minPremium?: number;
  side?: "all" | "call" | "put";
  ticker?: string;
  limit?: number;
  newerThan?: string;
  olderThan?: string;
  maxPages?: number;
  skipCache?: boolean;
}): Promise<FlowAlert[]> {
  // Official flow-alerts params (OpenAPI PublicApi.OptionTradeController.flow_alerts):
  // newer_than / older_than (unix seconds or ISO date YYYY-MM-DD). There is no
  // `intraday_only` and no `hide_expired` on this endpoint (hide_expired exists on
  // /api/option-trades). `unusual=true` is a live-options-flow *criteria* preset
  // (vol>OI, size>OI, all-opening, OTM, …) — not a session filter — and without
  // newer_than the feed is a rolling multi-week unusual-alert log (floor/historic).
  const pageSize = Math.min(params.limit ?? 200, 200);
  const maxPages = Math.min(Math.max(params.maxPages ?? 2, 1), 2);
  const cacheKey = JSON.stringify({
    minPremium: params.minPremium ?? 0,
    side: params.side ?? "all",
    ticker: params.ticker ?? "",
    newerThan: params.newerThan ?? "",
    olderThan: params.olderThan ?? "",
    pageSize,
    maxPages,
  });

  return cachedCall(
    cacheKey,
    FLOW_TTL_MS,
    async () => {
  const collected: FlowAlert[] = [];
  const seen = new Set<string>();
  let olderThan = params.olderThan;

  for (let page = 0; page < maxPages; page += 1) {
    const query: Record<string, string | number | boolean | undefined> = {
      limit: pageSize,
      min_premium: params.minPremium && params.minPremium > 0 ? params.minPremium : undefined,
      ticker_symbol: params.ticker ? params.ticker.toUpperCase() : undefined,
      newer_than: params.newerThan,
      older_than: olderThan,
    };
    // Never send unusual=true — that is a criteria preset, not a session filter.
    if (params.side === "call") query.is_call = true;
    if (params.side === "put") query.is_put = true;

    try {
      const payload = await uwGet<{ data?: Record<string, unknown>[] }>(
        "/api/option-trades/flow-alerts",
        query,
        0,
      );
      const batch = (payload.data ?? []).map(normalizeFlowAlert);
      if (batch.length === 0) break;

      let oldestMs = Number.POSITIVE_INFINITY;
      let added = 0;
      for (const alert of batch) {
        const createdMs = new Date(alert.created_at).getTime();
        if (Number.isFinite(createdMs) && createdMs < oldestMs) oldestMs = createdMs;
        if (seen.has(alert.id)) continue;
        seen.add(alert.id);
        collected.push(alert);
        added += 1;
      }

      if (batch.length < pageSize || added === 0 || !Number.isFinite(oldestMs)) break;
      const nextOlder = String(Math.floor(oldestMs / 1000));
      if (nextOlder === olderThan) break;
      olderThan = nextOlder;
    } catch (error) {
      if (collected.length > 0) return collected;
      throw error;
    }
  }

  return collected;
  }, Boolean(params.skipCache));
}

/**
 * One uncached flow-alerts page (newest first). Used by the session accumulator (lib/session-tape.ts),
 * which does its own incremental paging and dedupe.
 */
export async function fetchFlowAlertsPage(params: {
  minPremium: number;
  newerThan?: string;
  olderThan?: string;
  limit?: number;
}): Promise<FlowAlert[]> {
  const payload = await uwGet<{ data?: Record<string, unknown>[] }>(
    "/api/option-trades/flow-alerts",
    {
      limit: Math.min(params.limit ?? 200, 200),
      min_premium: params.minPremium > 0 ? params.minPremium : undefined,
      newer_than: params.newerThan,
      older_than: params.olderThan,
    },
    0,
    true,
  );
  return (payload.data ?? []).map(normalizeFlowAlert);
}

export async function fetchMarketTide(skipCache = false): Promise<TideSnapshot | null> {
  const payload = await uwGet<{
    data?: Array<{
      timestamp?: string;
      net_call_premium?: string | number;
      net_put_premium?: string | number;
    }>;
  }>("/api/market/market-tide", { interval_5m: false }, TIDE_TTL_MS, skipCache);

  const rows = payload.data ?? [];
  const last = rows[rows.length - 1];
  if (!last) return null;
  return tideFromPremiums(
    toNumber(last.net_call_premium),
    toNumber(last.net_put_premium),
    last.timestamp ?? null,
  );
}

export async function fetchNetPremTicks(ticker: string, date?: string): Promise<NetPremTick[]> {
  const payload = await uwGet<{ data?: Array<Record<string, unknown>> }>(
    `/api/stock/${encodeURIComponent(ticker.toUpperCase())}/net-prem-ticks`,
    date ? { date } : undefined,
    NET_PREM_TTL_MS,
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

function tradeAsAlert(raw: Record<string, unknown>, chain: string): FlowAlert {
  const typeRaw = asString(raw.type ?? raw.option_type, "call").toLowerCase();
  return {
    alert_rule: asString(raw.tags ?? raw.alert_rule),
    all_opening_trades: toBool(raw.opening),
    ask: asString(raw.ask),
    bid: asString(raw.bid),
    created_at: asString(raw.executed_at ?? raw.created_at ?? raw.tape_time),
    expiry: asString(raw.expiry),
    has_floor: toBool(raw.floor ?? raw.has_floor),
    has_multileg: toBool(raw.multi_leg ?? raw.has_multileg),
    has_singleleg: !toBool(raw.multi_leg ?? raw.has_multileg),
    has_sweep: toBool(raw.sweep ?? raw.has_sweep),
    id: asString(raw.id || `${chain}-${raw.executed_at}`),
    issue_type: asString(raw.issue_type),
    marketcap: null,
    open_interest: Math.round(toNumber(raw.open_interest)),
    option_chain: asString(raw.option_chain ?? chain),
    price: asString(raw.price),
    strike: asString(raw.strike),
    ticker: asString(raw.underlying_symbol ?? raw.ticker).toUpperCase(),
    total_ask_side_prem: asString(raw.ask_side_prem ?? raw.total_ask_side_prem, "0"),
    total_bid_side_prem: asString(raw.bid_side_prem ?? raw.total_bid_side_prem, "0"),
    total_premium: asString(raw.premium ?? raw.total_premium, "0"),
    total_size: Math.round(toNumber(raw.size ?? raw.total_size)),
    trade_count: 1,
    type: typeRaw === "put" ? "put" : "call",
    underlying_price: asString(raw.underlying_price),
    volume: Math.round(toNumber(raw.volume)),
    volume_oi_ratio: asString(raw.volume_oi_ratio, "0"),
  };
}

/** Best-effort later prints on one chain. Failures return []. Option-trades lookback is short. */
export async function fetchChainTrades(optionChain: string, newerThanIso: string): Promise<FlowAlert[]> {
  const chain = optionChain.trim();
  const created = new Date(newerThanIso);
  if (!chain || !Number.isFinite(created.getTime())) return [];
  if (await isUwBlocked()) return [];
  try {
    const url = buildUrl("/api/option-trades", {
      limit: 50,
      newer_than: Math.floor(created.getTime() / 1000),
    });
    url.searchParams.append("option_contracts[]", chain);
    const payload = await uwRequest<{ data?: Record<string, unknown>[] }>(url, CHAIN_TTL_MS);
    return (payload.data ?? []).map((row) => tradeAsAlert(row, chain));
  } catch {
    return [];
  }
}

export async function fetchTickerTides(
  tickers: string[],
  limit = 3,
): Promise<Record<string, TideSnapshot | null>> {
  if (await isUwBlocked()) return {};
  const unique = [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))].slice(0, limit);
  const out: Record<string, TideSnapshot | null> = {};
  for (const ticker of unique) {
    if (await isUwBlocked()) break;
    try {
      const ticks = await fetchNetPremTicks(ticker);
      out[ticker] = tideFromTicks(ticks);
    } catch {
      out[ticker] = null;
    }
  }
  return out;
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
  const mid = bid != null && ask != null && ask >= bid ? Math.round(((bid + ask) / 2) * 100) / 100 : null;
  const asOf = asString(raw.last_tape_time || raw.executed_at || raw.date, "") || null;

  if (last != null) {
    return { last, bid, ask, mid, asOf, quality: "uw_last" };
  }
  if (mid != null || ask != null || bid != null) {
    return {
      last: mid ?? ask ?? bid ?? 0,
      bid,
      ask,
      mid,
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

function isLiveQuote(q: WatchQuote | null | undefined): q is WatchQuote {
  return q != null && q.last > 0 && (q.quality === "uw_last" || q.quality === "uw_nbbo");
}

function errText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/gi, "Bearer ***").slice(0, 160);
}

/** One retry (after a short pause) on transient failures; never retries a quota error. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UwQuotaError) throw error;
    await pause(350);
    return fn();
  }
}

/**
 * Live quote for ONE contract with a step trace (for /api/quote diagnostics). Order:
 *  1. GET /api/stock/{t}/option-contracts?option_symbol[]=X  (NBBO + last_price; works after the close)
 *  2. GET /api/option-contract/{X}/historic                   (latest daily bar: last_price + NBBO)
 *  3. GET /api/option-trades?option_contracts[]=X&limit=1     (true last trade print) — opt-in
 * Only the exact symbol row is used (never another contract's row). Empty payloads are cached
 * for 60 s instead of 15 min so a transient blank answer can't pin the alert fallback.
 */
export async function fetchOptionQuoteTraced(
  ticker: string,
  optionSymbol: string,
  flowPrint?: number,
  opts: { allowShortBlock?: boolean; lastTradeFallback?: boolean } = {},
): Promise<{ quote: WatchQuote | null; steps: string[] }> {
  const symbol = optionSymbol.trim().toUpperCase();
  const name = ticker.trim().toUpperCase();
  const steps: string[] = [];
  const blocked = () => (opts.allowShortBlock ? isUwHardBlocked() : isUwBlocked());
  if (!symbol || !name) return { quote: quoteFromFlowPrint(flowPrint), steps: ["missing ticker/symbol"] };
  if (await blocked()) return { quote: quoteFromFlowPrint(flowPrint), steps: ["uw circuit open (quota)"] };
  const reqOpts = { allowShortBlock: opts.allowShortBlock };

  // 1) option-contracts (exact symbol)
  try {
    const url = buildUrl(`/api/stock/${encodeURIComponent(name)}/option-contracts`, { limit: 5 });
    url.searchParams.append("option_symbol[]", symbol);
    const rowOf = (p: { data?: Record<string, unknown>[] }) => (p.data ?? []).find((item) => asString(item.option_symbol).toUpperCase() === symbol);
    const payload = await withRetry(() =>
      uwRequest<{ data?: Record<string, unknown>[] }>(url, QUOTE_TTL_MS, false, {
        ...reqOpts,
        keep: (p) => isLiveQuote(rowOf(p) ? quoteFromContract(rowOf(p)!) : null),
      }),
    );
    const row = rowOf(payload);
    const quote = row ? quoteFromContract(row) : null;
    if (isLiveQuote(quote)) {
      steps.push(`option-contracts ok (${quote.quality})`);
      return { quote, steps };
    }
    steps.push(row ? "option-contracts: row has no last/bid/ask" : `option-contracts: symbol not in ${payload.data?.length ?? 0} rows`);
  } catch (error) {
    steps.push(`option-contracts error: ${errText(error)}`);
    if (error instanceof UwQuotaError) return { quote: quoteFromFlowPrint(flowPrint), steps };
  }

  // 2) historic daily bars (latest)
  try {
    const payload = await withRetry(() =>
      uwRequest<{ chains?: Record<string, unknown>[] }>(
        buildUrl(`/api/option-contract/${encodeURIComponent(symbol)}/historic`, { limit: 5 }),
        HISTORIC_TTL_MS,
        false,
        { ...reqOpts, keep: (p) => (p.chains ?? []).length > 0 },
      ),
    );
    const bars = (payload.chains ?? []).map(parseHistoricBar).sort((a, b) => a.date.localeCompare(b.date));
    const latest = bars[bars.length - 1];
    const quote = latest ? quoteFromHistoricBar(latest) : null;
    if (isLiveQuote(quote)) {
      steps.push(`historic ok (${latest!.date}, ${quote.quality})`);
      return { quote, steps };
    }
    steps.push(latest ? `historic: ${latest.date} bar has no price` : "historic: no bars");
  } catch (error) {
    steps.push(`historic error: ${errText(error)}`);
    if (error instanceof UwQuotaError) return { quote: quoteFromFlowPrint(flowPrint), steps };
  }

  // 3) last trade print on the contract
  if (opts.lastTradeFallback) {
    try {
      const url = buildUrl("/api/option-trades", { limit: 1 });
      url.searchParams.append("option_contracts[]", symbol);
      const payload = await uwRequest<{ data?: Record<string, unknown>[] }>(url, 60_000, false, {
        ...reqOpts,
        keep: (p) => (p.data ?? []).length > 0,
      });
      const row = (payload.data ?? []).find((r) => asString(r.option_chain_id || r.option_symbol).toUpperCase() === symbol);
      const price = row ? firstPositive(row.price) : null;
      if (row && price != null) {
        const bid = firstPositive(row.nbbo_bid);
        const ask = firstPositive(row.nbbo_ask);
        steps.push("option-trades last print ok");
        return {
          quote: { last: price, bid, ask, mid: bid != null && ask != null ? Math.round(((bid + ask) / 2) * 100) / 100 : null, asOf: asString(row.executed_at) || null, quality: "uw_last" },
          steps,
        };
      }
      steps.push("option-trades: no prints");
    } catch (error) {
      steps.push(`option-trades error: ${errText(error)}`);
    }
  }

  return { quote: quoteFromFlowPrint(flowPrint), steps };
}

export async function fetchOptionQuote(
  ticker: string,
  optionSymbol: string,
  flowPrint?: number,
): Promise<WatchQuote | null> {
  return (await fetchOptionQuoteTraced(ticker, optionSymbol, flowPrint)).quote;
}

/**
 * Live quotes (NBBO bid/ask + last) for several contracts on ONE underlying in a single
 * option-contracts call (`option_symbol[]` repeated). Same 15-min cache as fetchOptionQuote, so
 * paper-account checks reuse quotes other routes already pulled. Symbols missing from the batch
 * fall back to fetchOptionQuote (historic bar → flow print). `calls` counts UW requests attempted
 * (cache hits included, so it is an upper bound).
 */
export async function fetchTickerOptionQuotes(
  ticker: string,
  symbols: string[],
  flowPrints: Record<string, number | undefined> = {},
): Promise<{ quotes: Record<string, WatchQuote | null>; calls: number }> {
  const name = ticker.trim().toUpperCase();
  const wanted = [...new Set(symbols.map((s) => s.trim()).filter(Boolean))].sort();
  const quotes: Record<string, WatchQuote | null> = {};
  let calls = 0;
  if (!name || wanted.length === 0) return { quotes, calls };
  if (await isUwBlocked()) {
    for (const s of wanted) quotes[s] = quoteFromFlowPrint(flowPrints[s]);
    return { quotes, calls };
  }
  try {
    const url = buildUrl(`/api/stock/${encodeURIComponent(name)}/option-contracts`, { limit: Math.min(500, Math.max(5, wanted.length * 2)) });
    for (const s of wanted) url.searchParams.append("option_symbol[]", s);
    calls += 1;
    const payload = await uwRequest<{ data?: Record<string, unknown>[] }>(url, QUOTE_TTL_MS, false, {
      keep: (p) => (p.data ?? []).some((row) => wanted.includes(asString(row.option_symbol))),
    });
    for (const row of payload.data ?? []) {
      const sym = asString(row.option_symbol);
      if (!wanted.includes(sym) || quotes[sym]) continue;
      const q = quoteFromContract(row, flowPrints[sym]);
      if (q) quotes[sym] = q;
    }
  } catch (error) {
    if (error instanceof UwQuotaError) {
      for (const s of wanted) quotes[s] = quoteFromFlowPrint(flowPrints[s]);
      return { quotes, calls };
    }
  }
  for (const s of wanted) {
    if (quotes[s]) continue;
    calls += 1;
    try {
      quotes[s] = await fetchOptionQuote(name, s, flowPrints[s]);
    } catch {
      quotes[s] = quoteFromFlowPrint(flowPrints[s]);
    }
  }
  return { quotes, calls };
}

export function parseHistoricBar(raw: Record<string, unknown>): HistoricBar {
  return {
    date: asString(raw.date),
    last: firstPositive(raw.last_price, raw.close, raw.price),
    open: firstPositive(raw.open_price, raw.open),
    high: firstPositive(raw.high_price, raw.high),
    low: firstPositive(raw.low_price, raw.low),
    askVolume: Math.round(toNumber(raw.ask_volume)),
    bidVolume: Math.round(toNumber(raw.bid_volume)),
    sweepVolume: Math.round(toNumber(raw.sweep_volume)),
    impliedVolatility: firstPositive(raw.implied_volatility),
    ivHigh: firstPositive(raw.iv_high),
    ivLow: firstPositive(raw.iv_low),
    openInterest: Math.round(toNumber(raw.open_interest)) || null,
    totalPremium: firstPositive(raw.total_premium),
    volume: Math.round(toNumber(raw.volume)) || null,
    lastTapeTime: asString(raw.last_tape_time) || null,
    nbboBid: firstPositive(raw.nbbo_bid, raw.bid),
    nbboAsk: firstPositive(raw.nbbo_ask, raw.ask),
    flexOiTransfer: Math.round(toNumber(raw.flex_oi_transfer)) || null,
  };
}

function quoteFromHistoricBar(bar: HistoricBar, flowPrint?: number): WatchQuote | null {
  const barMid = bar.nbboBid != null && bar.nbboAsk != null && bar.nbboAsk >= bar.nbboBid ? Math.round(((bar.nbboBid + bar.nbboAsk) / 2) * 100) / 100 : null;
  if (bar.last != null && bar.last > 0) {
    return {
      last: bar.last,
      bid: bar.nbboBid,
      ask: bar.nbboAsk,
      mid: barMid,
      asOf: bar.lastTapeTime || bar.date || null,
      quality: "uw_last",
    };
  }
  const mid =
    bar.nbboBid != null && bar.nbboAsk != null ? (bar.nbboBid + bar.nbboAsk) / 2 : null;
  if (mid != null || bar.nbboAsk != null || bar.nbboBid != null) {
    return {
      last: mid ?? bar.nbboAsk ?? bar.nbboBid ?? 0,
      bid: bar.nbboBid,
      ask: bar.nbboAsk,
      asOf: bar.lastTapeTime || bar.date || null,
      quality: "uw_nbbo",
    };
  }
  return quoteFromFlowPrint(flowPrint);
}

/** One historic pull per contract. Cached 15 min. Used on the watch-check path, not the board poll. */
export async function fetchContractHistoric(optionSymbol: string, limit = 5): Promise<HistoricBar[]> {
  const symbol = optionSymbol.trim();
  if (!symbol) return [];
  if (await isUwBlocked()) return [];
  try {
    const payload = await uwGet<{ chains?: Record<string, unknown>[] }>(
      `/api/option-contract/${encodeURIComponent(symbol)}/historic`,
      { limit },
      HISTORIC_TTL_MS,
    );
    const bars = (payload.chains ?? []).map(parseHistoricBar);
    return bars.sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

export type WatchSnapshot = {
  quote: WatchQuote | null;
  historic: HistoricBar[];
};

/**
 * 15-minute watch path: one historic (limit 5) per unique chain.
 * Quote comes from the latest bar. No option-contracts fan-out.
 */
export async function fetchWatchSnapshots(
  requests: Array<{ ticker: string; option_chain: string; lastFlowPrint?: number }>,
): Promise<Record<string, WatchSnapshot>> {
  const unique = new Map<string, { ticker: string; option_chain: string; lastFlowPrint?: number }>();
  for (const request of requests) {
    if (!request.option_chain || unique.has(request.option_chain)) continue;
    unique.set(request.option_chain, request);
  }

  const out: Record<string, WatchSnapshot> = {};
  if (await isUwBlocked()) {
    for (const request of unique.values()) {
      out[request.option_chain] = {
        quote: quoteFromFlowPrint(request.lastFlowPrint),
        historic: [],
      };
    }
    return out;
  }

  for (const request of unique.values()) {
    if (await isUwBlocked()) {
      out[request.option_chain] = {
        quote: quoteFromFlowPrint(request.lastFlowPrint),
        historic: [],
      };
      continue;
    }
    try {
      const historic = await fetchContractHistoric(request.option_chain, 5);
      const latest = historic[historic.length - 1];
      const quote =
        (latest ? quoteFromHistoricBar(latest, request.lastFlowPrint) : null) ??
        quoteFromFlowPrint(request.lastFlowPrint);
      out[request.option_chain] = { quote, historic };
    } catch {
      out[request.option_chain] = {
        quote: quoteFromFlowPrint(request.lastFlowPrint),
        historic: [],
      };
    }
  }
  return out;
}

export async function fetchOptionQuotes(
  requests: Array<{ ticker: string; option_chain: string; lastFlowPrint?: number }>,
): Promise<Record<string, WatchQuote | null>> {
  const unique = new Map<string, { ticker: string; option_chain: string; lastFlowPrint?: number }>();
  for (const request of requests) {
    if (!request.option_chain || unique.has(request.option_chain)) continue;
    unique.set(request.option_chain, request);
  }

  if (await isUwBlocked()) {
    return Object.fromEntries(
      [...unique.values()].map((request) => [
        request.option_chain,
        quoteFromFlowPrint(request.lastFlowPrint),
      ]),
    );
  }

  const out: Record<string, WatchQuote | null> = {};
  for (const request of unique.values()) {
    if (await isUwBlocked()) {
      out[request.option_chain] = quoteFromFlowPrint(request.lastFlowPrint);
      continue;
    }
    try {
      out[request.option_chain] = await fetchOptionQuote(
        request.ticker,
        request.option_chain,
        request.lastFlowPrint,
      );
    } catch {
      out[request.option_chain] = quoteFromFlowPrint(request.lastFlowPrint);
    }
  }
  return out;
}

/** Intraday last vs prior close. OpenAPI: GET /api/stock/{ticker}/stock-state (`close`, `prev_close`). */
export type StockState = {
  ticker: string;
  last: number | null;
  prevClose: number | null;
  pctFromClose: number | null;
};

export async function fetchStockStates(tickers: string[], limit = 6): Promise<Record<string, StockState>> {
  const unique = [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))].slice(0, limit);
  const out: Record<string, StockState> = {};
  if (await isUwBlocked()) {
    for (const ticker of unique) {
      out[ticker] = { ticker, last: null, prevClose: null, pctFromClose: null };
    }
    return out;
  }

  for (const ticker of unique) {
    if (await isUwBlocked()) {
      out[ticker] = { ticker, last: null, prevClose: null, pctFromClose: null };
      continue;
    }
    try {
      const payload = await uwGet<{ data?: Record<string, unknown> }>(
        `/api/stock/${encodeURIComponent(ticker)}/stock-state`,
        undefined,
        STOCK_STATE_TTL_MS,
      );
      const row = payload.data ?? {};
      const last = firstPositive(row.close, row.last, row.price);
      const prevClose = firstPositive(row.prev_close, row.prev_close_price);
      const pctFromClose =
        last != null && prevClose != null && prevClose > 0 ? (last - prevClose) / prevClose : null;
      out[ticker] = { ticker, last, prevClose, pctFromClose };
    } catch {
      out[ticker] = { ticker, last: null, prevClose: null, pctFromClose: null };
    }
  }
  return out;
}


export type UwEconEvent = {
  type: string;
  time: string;
  event: string;
  prev: string | null;
  forecast: string | null;
  reported_period: string | null;
};

/** Economic calendar fallback for the regime. 24h in-process cache — ~1 UW call per instance per day. */
export async function fetchEconomicCalendar(): Promise<UwEconEvent[]> {
  const payload = await uwGet<{ data?: Array<Record<string, unknown>> }>(
    "/api/market/economic-calendar",
    undefined,
    24 * 3600_000,
  );
  return (payload.data ?? []).map((row) => ({
    type: asString(row.type),
    time: asString(row.time),
    event: asString(row.event),
    prev: row.prev == null ? null : asString(row.prev),
    forecast: row.forecast == null ? null : asString(row.forecast),
    reported_period: row.reported_period == null ? null : asString(row.reported_period),
  }));
}

const DAY_TTL_MS = 12 * 3600_000;

/** Shadow earnings_check. GET /api/stock/{ticker}/info (next_earnings_date). Cached 12h; null on error. */
export async function fetchTickerInfo(
  ticker: string,
): Promise<{ nextEarningsDate: string | null; announceTime: string | null; sector: string | null; beta: number | null } | null> {
  if (await isUwBlocked()) return null;
  try {
    const payload = await uwGet<{ data?: Record<string, unknown> }>(
      `/api/stock/${encodeURIComponent(ticker.toUpperCase())}/info`,
      undefined,
      DAY_TTL_MS,
    );
    const d = payload.data ?? {};
    const beta = toNumber(d.beta);
    return {
      nextEarningsDate: asString(d.next_earnings_date).slice(0, 10) || null,
      announceTime: asString(d.announce_time) || null,
      sector: asString(d.sector) || null,
      beta: Number.isFinite(beta) && beta !== 0 ? beta : null,
    };
  } catch {
    return null;
  }
}

/** Shadow worth_the_price. GET /api/stock/{ticker}/volatility/stats (iv, iv_rank 0–100, rv). Cached 12h. */
export async function fetchVolStats(
  ticker: string,
): Promise<{ iv: number | null; ivRank: number | null; rv: number | null; ivLow: number | null; ivHigh: number | null } | null> {
  if (await isUwBlocked()) return null;
  try {
    const payload = await uwGet<{ data?: Record<string, unknown> }>(
      `/api/stock/${encodeURIComponent(ticker.toUpperCase())}/volatility/stats`,
      undefined,
      DAY_TTL_MS,
    );
    const d = payload.data ?? {};
    const num = (v: unknown) => {
      const n = toNumber(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    return { iv: num(d.iv), ivRank: num(d.iv_rank), rv: num(d.rv), ivLow: num(d.iv_low), ivHigh: num(d.iv_high) };
  } catch {
    return null;
  }
}

/** Shadow earnings_check. GET /api/earnings/{ticker} — upcoming estimate row + past reactions. Cached 12h. */
export async function fetchEarningsHistory(
  ticker: string,
): Promise<Array<{ reportDate: string; reportTime: string | null; source: string | null; expectedMovePct: number | null; postMove1dPct: number | null }> | null> {
  if (await isUwBlocked()) return null;
  try {
    const payload = await uwGet<{ data?: Array<Record<string, unknown>> }>(
      `/api/earnings/${encodeURIComponent(ticker.toUpperCase())}`,
      undefined,
      DAY_TTL_MS,
    );
    const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
    return (payload.data ?? []).slice(0, 12).map((r) => ({
      reportDate: asString(r.report_date).slice(0, 10),
      reportTime: r.report_time == null ? null : asString(r.report_time),
      source: r.source == null ? null : asString(r.source),
      expectedMovePct: num(r.expected_move_perc),
      postMove1dPct: num(r.post_earnings_move_1d),
    }));
  } catch {
    return null;
  }
}

/** Shadow signals: large dark-pool prints for one ticker in [fromMs, toMs]. GET /api/darkpool/{ticker}. Cached 12h. */
export async function fetchDarkPoolWindow(ticker: string, day: string, fromMs: number, toMs: number): Promise<Record<string, unknown>[]> {
  if (await isUwBlocked()) return [];
  const payload = await uwGet<{ data?: Record<string, unknown>[] }>(
    `/api/darkpool/${encodeURIComponent(ticker.toUpperCase())}`,
    { date: day, limit: 500, min_premium: 1_000_000, newer_than: Math.floor(fromMs / 1000), older_than: Math.ceil(toMs / 1000) },
    DAY_TTL_MS,
  );
  return payload.data ?? [];
}

/** Shadow signals: dealer gamma by strike for one day. GET /api/stock/{ticker}/greek-exposure/strike. Cached 12h. */
export async function fetchGexByStrike(ticker: string, day: string): Promise<Record<string, unknown>[]> {
  if (await isUwBlocked()) return [];
  const payload = await uwGet<{ data?: Record<string, unknown>[] }>(
    `/api/stock/${encodeURIComponent(ticker.toUpperCase())}/greek-exposure/strike`,
    { date: day },
    DAY_TTL_MS,
  );
  return payload.data ?? [];
}

/** Shadow signals: insider (Form 4) transactions for one ticker, newest first. GET /api/insider/transactions. Cached 12h. */
export async function fetchInsiderTransactions(ticker: string): Promise<Record<string, unknown>[]> {
  if (await isUwBlocked()) return [];
  const payload = await uwGet<{ data?: Record<string, unknown>[] }>(
    "/api/insider/transactions",
    { ticker_symbol: ticker.toUpperCase(), limit: 500 },
    DAY_TTL_MS,
  );
  return payload.data ?? [];
}
