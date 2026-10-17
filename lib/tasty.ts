import "server-only";

import { parseTastyItem, type TastyQuote } from "@/lib/tasty-core";

/**
 * TEST MODE ONLY. Read-only Tastytrade market-data client (OAuth2 app scopes: read + openid; this module has no
 * order endpoints and never will). OFF unless FLOWGUARD_TASTY_TEST=1.
 * Env: TASTYTRADE_REFRESH_TOKEN, TASTYTRADE_CLIENT_SECRET (TASTYTRADE_CLIENT_ID optional),
 *      TASTYTRADE_API_BASE (default production https://api.tastyworks.com — the sandbox serves no market data).
 * Access tokens last 15 min; cached per instance and refreshed lazily (refresh tokens do not rotate).
 */
const UA = "flowguard-tasty/1.0";
const DEFAULT_BASE = "https://api.tastyworks.com";
const BATCH = 100;

export function tastyTestEnabled(): boolean {
  return process.env.FLOWGUARD_TASTY_TEST === "1";
}

export function tastyConfigured(): boolean {
  return Boolean(process.env.TASTYTRADE_REFRESH_TOKEN?.trim() && process.env.TASTYTRADE_CLIENT_SECRET?.trim());
}

function base(): string {
  return (process.env.TASTYTRADE_API_BASE?.trim() || DEFAULT_BASE).replace(/\/+$/, "");
}

let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: process.env.TASTYTRADE_REFRESH_TOKEN?.trim() ?? "",
    client_secret: process.env.TASTYTRADE_CLIENT_SECRET?.trim() ?? "",
  };
  const cid = process.env.TASTYTRADE_CLIENT_ID?.trim();
  if (cid) body.client_id = cid;
  const res = await fetch(`${base()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_code?: string };
  if (!res.ok || !data.access_token) throw new Error(`tasty token refresh HTTP ${res.status}${data.error_code ? ` ${data.error_code}` : ""}`);
  cached = { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 900) * 1000 };
  return cached.token;
}

async function tastyGet(path: string, params: Record<string, string>): Promise<unknown> {
  const qs = new URLSearchParams(params).toString();
  const go = async () =>
    fetch(`${base()}${path}${qs ? `?${qs}` : ""}`, {
      headers: { Authorization: `Bearer ${await accessToken()}`, Accept: "application/json", "User-Agent": UA },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  let res = await go();
  if (res.status === 401) {
    cached = null;
    res = await go();
  }
  if (!res.ok) throw new Error(`tasty GET ${path} HTTP ${res.status}`);
  return res.json();
}

/** REST quotes for Tastytrade-OCC option symbols ("AAPL  261120C00150000"), keyed by that symbol. */
export async function fetchTastyOptionQuotes(occs: string[]): Promise<Record<string, TastyQuote>> {
  const out: Record<string, TastyQuote> = {};
  const uniq = [...new Set(occs.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += BATCH) {
    const data = (await tastyGet("/market-data/by-type", { "equity-option": uniq.slice(i, i + BATCH).join(",") })) as {
      data?: { items?: Array<Record<string, unknown>> };
    };
    for (const it of data.data?.items ?? []) if (typeof it.symbol === "string") out[it.symbol] = parseTastyItem(it);
  }
  return out;
}
