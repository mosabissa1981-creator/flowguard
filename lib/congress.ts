import type { CongressQuery, CongressSide, CongressTrade, CongressTxnSide } from "@/lib/types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseCongressQuery(params: URLSearchParams): CongressQuery {
  const limitParam = params.get("limit");
  const limitRaw = limitParam == null || limitParam.trim() === "" ? Number.NaN : Number(limitParam);
  const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.trunc(limitRaw))) : 40;

  const sideRaw = (params.get("side") ?? "buy").trim().toLowerCase();
  const side: CongressSide = sideRaw === "sell" || sideRaw === "all" ? sideRaw : "buy";

  const tickerRaw = (params.get("ticker") ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/g, "");
  const ticker = tickerRaw ? tickerRaw.slice(0, 12) : null;

  const dateRaw = (params.get("date") ?? "").trim();
  const date = DATE_RE.test(dateRaw) ? dateRaw : null;

  const windowRaw = (params.get("window") ?? "").trim().toLowerCase();
  let days = windowRaw === "day" ? 1 : 7;
  const daysRaw = Number(params.get("days"));
  if (Number.isFinite(daysRaw) && daysRaw > 0) {
    days = Math.min(7, Math.max(1, Math.trunc(daysRaw)));
  }

  return { limit, side, ticker, days, date };
}

export function etYmd(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function etWeekday(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(date);
}

/** Shift a YYYY-MM-DD by calendar days, then read it back in America/New_York. */
export function shiftEtYmd(ymd: string, deltaDays: number): string {
  const match = DATE_RE.exec(ymd);
  if (!match) return ymd;
  const [year, month, day] = ymd.split("-").map(Number);
  const cursor = new Date(Date.UTC(year, month - 1, day + deltaDays, 17, 0, 0));
  return etYmd(cursor);
}

/**
 * Weekday market dates inside the last `spanDays` ET calendar days, newest first.
 * UW `date` is a trading date, so Saturday and Sunday are not requested.
 */
export function congressMarketDates(now = new Date(), spanDays = 7): string[] {
  const today = etYmd(now);
  const dates: string[] = [];
  const span = Math.min(7, Math.max(1, spanDays));
  for (let i = 0; i < span; i += 1) {
    const ymd = shiftEtYmd(today, -i);
    const [year, month, day] = ymd.split("-").map(Number);
    const noon = new Date(Date.UTC(year, month - 1, day, 17, 0, 0));
    const weekday = etWeekday(noon);
    if (weekday === "Sat" || weekday === "Sun") continue;
    dates.push(ymd);
  }
  if (dates.length > 0) return dates;
  for (let i = span; i < span + 4; i += 1) {
    const ymd = shiftEtYmd(today, -i);
    const [year, month, day] = ymd.split("-").map(Number);
    const noon = new Date(Date.UTC(year, month - 1, day, 17, 0, 0));
    const weekday = etWeekday(noon);
    if (weekday === "Sat" || weekday === "Sun") continue;
    dates.push(ymd);
    break;
  }
  return dates;
}

export function filedWindow(now = new Date(), spanDays = 7): { start: string; end: string } {
  const end = etYmd(now);
  const start = shiftEtYmd(end, -(Math.min(7, Math.max(1, spanDays)) - 1));
  return { start, end };
}

export function congressTxnSide(txnType: string): CongressTxnSide {
  const value = txnType.trim().toLowerCase();
  if (!value || value === "—") return "other";
  if (value.startsWith("buy") || value.includes("purchase")) return "buy";
  if (value.startsWith("sell") || value.startsWith("sale")) return "sell";
  return "other";
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function isoDate(value: unknown): string {
  const text = asText(value);
  const match = DATE_RE.exec(text);
  return match ? match[0] : "";
}

function normalizeMemberType(value: unknown): string | null {
  if (typeof value === "boolean") return value ? "member" : null;
  const text = asText(value).toLowerCase();
  if (!text || text === "false" || text === "null") return null;
  if (text === "true") return "member";
  return text;
}

function normalizeIssuer(value: unknown): string | null {
  const text = asText(value).toLowerCase();
  if (!text || text === "self" || text === "not-disclosed" || text === "not disclosed" || text === "undisclosed") {
    return null;
  }
  return text;
}

/** Map one UW congress row. Blank rows are dropped — never invent a politician. */
export function normalizeCongressTrade(raw: Record<string, unknown>): CongressTrade | null {
  const ticker = asText(raw.ticker)
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/g, "");
  const name = asText(raw.name) || asText(raw.reporter);
  const txnType = asText(raw.txn_type);
  const transactionDate = isoDate(raw.transaction_date);
  const filedAtDate = isoDate(raw.filed_at_date);
  if (!name && !ticker && !txnType) return null;

  const politicianId = asText(raw.politician_id) || null;
  const amounts = asText(raw.amounts) || "—";
  const id = [politicianId ?? name, ticker, txnType, transactionDate, filedAtDate, amounts].join("|");

  return {
    id,
    name: name || "Undisclosed name",
    ticker: ticker || "—",
    txnType: txnType || "—",
    side: congressTxnSide(txnType),
    amounts,
    transactionDate,
    filedAtDate,
    memberType: normalizeMemberType(raw.member_type),
    issuer: normalizeIssuer(raw.issuer),
    politicianId,
  };
}

export function inFilingWindow(trade: CongressTrade, start: string, end: string): boolean {
  if (trade.filedAtDate) return trade.filedAtDate >= start && trade.filedAtDate <= end;
  if (trade.transactionDate) return trade.transactionDate >= start && trade.transactionDate <= end;
  return false;
}

function sideRank(side: CongressTxnSide): number {
  if (side === "buy") return 0;
  if (side === "sell") return 1;
  return 2;
}

export function selectCongressTrades(
  trades: CongressTrade[],
  query: { side: CongressSide; limit: number },
): CongressTrade[] {
  const filtered = query.side === "all" ? trades : trades.filter((trade) => trade.side === query.side);
  const sorted = [...filtered].sort((a, b) => {
    const filed = (b.filedAtDate || b.transactionDate).localeCompare(a.filedAtDate || a.transactionDate);
    if (filed !== 0) return filed;
    const side = sideRank(a.side) - sideRank(b.side);
    if (side !== 0) return side;
    const transaction = b.transactionDate.localeCompare(a.transactionDate);
    if (transaction !== 0) return transaction;
    return a.name.localeCompare(b.name) || a.ticker.localeCompare(b.ticker);
  });
  return sorted.slice(0, query.limit);
}

export function dedupeCongressTrades(trades: CongressTrade[]): CongressTrade[] {
  const seen = new Set<string>();
  const out: CongressTrade[] = [];
  for (const trade of trades) {
    if (seen.has(trade.id)) continue;
    seen.add(trade.id);
    out.push(trade);
  }
  return out;
}
