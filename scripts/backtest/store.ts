/** On-box history datasets under HISTORY_DIR (default /workspace/flowguard/history). Compact, gzip'd, resumable. */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { normalizeFlowAlert } from "@/lib/uw";
import type { FlowAlert } from "@/lib/types";

import { uwJson } from "./uw-budget";

export const ROOT = process.env.HISTORY_DIR || "/workspace/flowguard/history";
export const MIN_PREMIUM = 10_000; // same floor as the live session tape

export const p = (...parts: string[]) => path.join(ROOT, ...parts);
export function ensureDirs() {
  for (const d of ["flow", "tide", "ohlc", "earnings", "contracts", "replay", "datasets", "logs"]) fs.mkdirSync(p(d), { recursive: true });
}

export function readJson<T>(file: string): T | null {
  try {
    const buf = fs.readFileSync(file);
    const text = file.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
export function writeJson(file: string, value: unknown) {
  const text = JSON.stringify(value);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, file.endsWith(".gz") ? zlib.gzipSync(text) : text);
  fs.renameSync(tmp, file);
}

// ---- Flow alerts (same compact field set as lib/session-tape) ----
export const FIELDS = [
  "id", "created_at", "ticker", "option_chain", "type", "strike", "expiry", "price", "underlying_price",
  "total_premium", "total_ask_side_prem", "total_bid_side_prem", "total_size", "trade_count", "volume",
  "open_interest", "volume_oi_ratio", "has_sweep", "has_floor", "has_multileg", "has_singleleg",
  "all_opening_trades", "alert_rule", "issue_type", "marketcap", "ask", "bid",
] as const satisfies readonly (keyof FlowAlert)[];

export type FlowDay = { day: string; v: 1; fields: string[]; rows: unknown[][]; count: number; complete: boolean; uwCalls: number; fetchedAt: string };
export const flowFile = (day: string) => p("flow", `${day}.json.gz`);

export function loadFlowDay(day: string): FlowAlert[] | null {
  const d = readJson<FlowDay>(flowFile(day));
  if (!d?.complete) return null;
  return d.rows.map((r) => Object.fromEntries(d.fields.map((f, i) => [f, r[i]])) as unknown as FlowAlert);
}

/** ET session bounds for a calendar day (handles DST via Intl). */
export function etMs(day: string, hh: number, mm: number): number {
  const guess = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), hh + 5, mm);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" });
  const h = Number(fmt.format(new Date(guess)));
  return guess - (h - hh) * 3600_000;
}

/**
 * Page one window [lo, hi] newest-first with newer_than/older_than (seconds), same same-second stepping as the
 * live tape. Returns the raw alerts.
 */
async function pageWindow(loMs: number, hiMs: number, out: Map<string, FlowAlert>, calls: { n: number }) {
  let older = Math.ceil(hiMs / 1000) + 1;
  for (let guard = 0; guard < 400; guard += 1) {
    calls.n += 1;
    const q = new URLSearchParams({ limit: "200", min_premium: String(MIN_PREMIUM), newer_than: String(Math.floor(loMs / 1000) - 1), older_than: String(older) });
    const j = await uwJson<{ data?: Record<string, unknown>[] }>(`/api/option-trades/flow-alerts?${q}`);
    const batch = (j.data ?? []).map(normalizeFlowAlert);
    let oldest = Infinity;
    let added = 0;
    for (const a of batch) {
      const ms = Date.parse(a.created_at);
      if (Number.isFinite(ms) && ms < oldest) oldest = ms;
      if (a.id && !out.has(a.id)) {
        out.set(a.id, a);
        added += 1;
      }
    }
    if (batch.length < 200 || !Number.isFinite(oldest) || oldest <= loMs) return;
    const next = Math.floor(oldest / 1000) + (added > 0 ? 1 : 0);
    older = next >= older ? older - 1 : next;
  }
}

/** Fetch one session's flow alerts (09:30–16:15 ET) in parallel 30-min windows. Resumable per day. */
export async function fetchFlowDay(day: string): Promise<{ count: number; uwCalls: number; cached: boolean }> {
  const existing = readJson<FlowDay>(flowFile(day));
  if (existing?.complete) return { count: existing.count, uwCalls: 0, cached: true };
  const open = etMs(day, 9, 30);
  const end = etMs(day, 16, 15);
  const windows: [number, number][] = [];
  for (let lo = open; lo < end; lo += 30 * 60_000) windows.push([lo, Math.min(end, lo + 30 * 60_000) - 1]);
  const out = new Map<string, FlowAlert>();
  const calls = { n: 0 };
  let next = 0;
  const worker = async () => {
    while (next < windows.length) {
      const [lo, hi] = windows[next++];
      await pageWindow(lo, hi, out, calls);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker)); // BudgetStop propagates: nothing written for a partial day
  const alerts = [...out.values()].filter((a) => {
    const ms = Date.parse(a.created_at);
    return ms >= open && ms <= end;
  });
  alerts.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const doc: FlowDay = {
    day, v: 1, fields: [...FIELDS], rows: alerts.map((a) => FIELDS.map((f) => a[f])), count: alerts.length,
    complete: true, uwCalls: calls.n, fetchedAt: new Date().toISOString(),
  };
  writeJson(flowFile(day), doc);
  return { count: alerts.length, uwCalls: calls.n, cached: false };
}

// ---- Market tide per day ----
export type TideRow = { timestamp: string; net_call_premium: string; net_put_premium: string };
export async function fetchTideDay(day: string): Promise<TideRow[]> {
  const f = p("tide", `${day}.json`);
  const hit = readJson<TideRow[]>(f);
  if (hit) return hit;
  const j = await uwJson<{ data?: TideRow[] }>(`/api/market/market-tide?date=${day}`);
  const rows = (j.data ?? []).map((r) => ({ timestamp: r.timestamp, net_call_premium: r.net_call_premium, net_put_premium: r.net_put_premium }));
  writeJson(f, rows);
  return rows;
}

// ---- Daily OHLC per ticker (UW returns ≤ 1 year per call; cached in year chunks ending on fixed anchors) ----
export type Bar = { date: string; o: number; h: number; l: number; c: number };
const ANCHOR = "2026-10-01"; // chunk k covers (ANCHOR - 365(k+1), ANCHOR - 365k]
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export { addDays };
async function ohlcChunk(ticker: string, k: number): Promise<Bar[]> {
  const f = p("ohlc", `${ticker.replace(/[^A-Z0-9._-]/gi, "_")}.${k}.json`);
  const hit = readJson<Bar[]>(f);
  if (hit) return hit;
  const end = addDays(ANCHOR, -365 * k);
  const j = await uwJson<{ data?: Array<Record<string, string>> }>(`/api/stock/${encodeURIComponent(ticker)}/ohlc/1d?end_date=${end}&limit=2500`);
  const byDate = new Map<string, Bar>();
  for (const r of j.data ?? []) {
    if (r.market_time && r.market_time !== "r") continue;
    byDate.set(r.date, { date: r.date, o: +r.open, h: +r.high, l: +r.low, c: +r.close });
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  writeJson(f, bars);
  return bars;
}
/** Regular-session daily bars covering [from, to]. */
export async function barsBetween(ticker: string, from: string, to: string): Promise<Bar[]> {
  const kOf = (d: string) => Math.max(0, Math.floor((Date.parse(`${ANCHOR}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / (365 * 86400_000)));
  const ks = [...new Set([kOf(to), kOf(from)])];
  const all: Bar[] = [];
  for (const k of ks) all.push(...(await ohlcChunk(ticker, k)));
  const m = new Map(all.map((b) => [b.date, b]));
  return [...m.values()].filter((b) => b.date >= from && b.date <= to).sort((a, b) => a.date.localeCompare(b.date));
}

// ---- Earnings history per ticker (one call ever; refreshed after 30 days) ----
export type Earn = { date: string; time: string | null };
export async function earningsFor(ticker: string): Promise<Earn[]> {
  const f = p("earnings", `${ticker.replace(/[^A-Z0-9._-]/gi, "_")}.json`);
  const hit = readJson<{ at: number; rows: Earn[] }>(f);
  if (hit && Date.now() - hit.at < 30 * 86400_000) return hit.rows;
  let rows: Earn[] = [];
  try {
    const j = await uwJson<{ data?: Array<Record<string, string | null>> }>(`/api/earnings/${encodeURIComponent(ticker)}`);
    rows = (j.data ?? []).map((r) => ({ date: String(r.report_date ?? ""), time: r.report_time ?? null })).filter((r) => r.date >= "2023-01-01");
  } catch (e) {
    if ((e as Error).name === "BudgetStop") throw e;
    rows = []; // ETFs etc. 404
  }
  writeJson(f, { at: Date.now(), rows });
  return rows;
}

// ---- Contract daily history (one call per contract: full life incl. open interest) ----
export type ContractDoc = { at: number; fetchedDay: string; chains: Record<string, unknown>[] };
export async function contractHistory(symbol: string, needThrough: string, today: string): Promise<Record<string, unknown>[] | null> {
  const f = p("contracts", `${symbol}.json.gz`);
  const hit = readJson<ContractDoc>(f);
  const expiry = `20${symbol.slice(-15, -13)}-${symbol.slice(-13, -11)}-${symbol.slice(-11, -9)}`;
  if (hit && (hit.fetchedDay > needThrough || hit.fetchedDay > expiry || hit.fetchedDay === today)) return hit.chains;
  try {
    const j = await uwJson<{ chains?: Record<string, unknown>[] }>(`/api/option-contract/${encodeURIComponent(symbol)}/historic`);
    const doc: ContractDoc = { at: Date.now(), fetchedDay: today, chains: j.chains ?? [] };
    writeJson(f, doc);
    return doc.chains;
  } catch (e) {
    if ((e as Error).name === "BudgetStop") throw e;
    return hit?.chains ?? null;
  }
}

// ---- Shadow-signal history (dark pool window per entry, GEX by strike per ticker-day) ----
export async function darkPoolWindow(ticker: string, day: string, printMs: number): Promise<Record<string, unknown>[]> {
  const f = p("signals", "dp", `${ticker.replace(/[^A-Z0-9._-]/gi, "_")}.${day}.${Math.floor(printMs / 60_000)}.json`);
  const hit = readJson<Record<string, unknown>[]>(f);
  if (hit) return hit;
  const q = new URLSearchParams({ date: day, limit: "500", min_premium: "1000000", newer_than: String(Math.floor((printMs - 15 * 60_000) / 1000)), older_than: String(Math.ceil((printMs + 15 * 60_000) / 1000)) });
  const j = await uwJson<{ data?: Record<string, unknown>[] }>(`/api/darkpool/${encodeURIComponent(ticker)}?${q}`);
  const rows = (j.data ?? []).map((r) => ({ price: r.price, premium: r.premium, nbbo_bid: r.nbbo_bid, nbbo_ask: r.nbbo_ask, executed_at: r.executed_at, canceled: r.canceled }));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  writeJson(f, rows);
  return rows;
}
export async function gexStrikes(ticker: string, day: string): Promise<Record<string, unknown>[]> {
  const f = p("signals", "gex", `${ticker.replace(/[^A-Z0-9._-]/gi, "_")}.${day}.json`);
  const hit = readJson<Record<string, unknown>[]>(f);
  if (hit) return hit;
  const j = await uwJson<{ data?: Record<string, unknown>[] }>(`/api/stock/${encodeURIComponent(ticker)}/greek-exposure/strike?date=${day}`);
  const rows = (j.data ?? []).map((r) => ({ strike: r.strike, call_gex: r.call_gex, put_gex: r.put_gex }));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  writeJson(f, rows);
  return rows;
}
export async function netPremTicks(ticker: string, day: string): Promise<Record<string, unknown>[]> {
  const f = p("signals", "netprem", `${ticker.replace(/[^A-Z0-9._-]/gi, "_")}.${day}.json.gz`);
  const hit = readJson<Record<string, unknown>[]>(f);
  if (hit) return hit;
  const j = await uwJson<{ data?: Record<string, unknown>[] }>(`/api/stock/${encodeURIComponent(ticker)}/net-prem-ticks?date=${day}`);
  const rows = (j.data ?? []).map((r) => ({ tape_time: r.tape_time, net_call_premium: r.net_call_premium, net_put_premium: r.net_put_premium }));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  writeJson(f, rows);
  return rows;
}
/** Insider transactions per ticker (newest 500; as-of filtering by filing date happens in the signal). Refreshed after 7 days. */
export async function insiderRows(ticker: string): Promise<Record<string, unknown>[]> {
  const f = p("signals", "insider", `${ticker.replace(/[^A-Z0-9._-]/gi, "_")}.json.gz`);
  const hit = readJson<{ at: number; rows: Record<string, unknown>[] }>(f);
  if (hit && Date.now() - hit.at < 7 * 86400_000) return hit.rows;
  let rows: Record<string, unknown>[] = [];
  try {
    const j = await uwJson<{ data?: Record<string, unknown>[] }>(`/api/insider/transactions?ticker_symbol=${encodeURIComponent(ticker)}&limit=500`);
    rows = (j.data ?? []).map((r) => ({ filing_date: r.filing_date, transaction_date: r.transaction_date, transaction_code: r.transaction_code, amount: r.amount, price: r.price, stock_price: r.stock_price, is_10b5_1: r.is_10b5_1 }));
  } catch (e) {
    if ((e as Error).name === "BudgetStop") throw e;
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  writeJson(f, { at: Date.now(), rows });
  return rows;
}
