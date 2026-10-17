import { spreadFromPair } from "@/lib/spread-core";

/**
 * TEST MODE ONLY (FLOWGUARD_TASTY_TEST=1). Pure helpers for the Tastytrade quote comparison log:
 * symbol conversion and the UW-vs-Tastytrade row math. No I/O, so scripts/tasty-quotes-check.ts can test it.
 */

/** UW / FlowGuard OCC (NFLX261023C00070000) → Tastytrade OCC (root padded to 6: "NFLX  261023C00070000"). */
export function toTastyOcc(sym: string): string | null {
  const s = (sym ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const m = /^([A-Z.]{1,5}\d?)(\d{6}[CP]\d{8})$/.exec(s);
  if (!m) return null;
  const root = m[1].replace(/\./g, "");
  if (root.length > 6) return null;
  return `${root.padEnd(6, " ")}${m[2]}`;
}

/** Tastytrade OCC → FlowGuard key (spaces removed). */
export function fromTastyOcc(sym: string): string {
  return (sym ?? "").replace(/\s+/g, "").toUpperCase();
}

export type QuotePair = { bid: number | null; ask: number | null };
export type TastyQuote = QuotePair & { mid: number | null; mark: number | null; last: number | null; updatedAt: string | null };

export type TastyCompareRow = {
  at: string;
  contract: string;
  ticker: string;
  /** Where the contract came from: "open:<book>" (open paper position) or "spread-check" (shadow/AI-review candidate). */
  from: string;
  /** Existing quote it is compared with: paper lastMark (UW) or the spread-gate memo (UW NBBO). */
  refSource: "paper_mark" | "spread_memo" | "none";
  refAt: string | null;
  ref: QuotePair;
  tasty: TastyQuote | null;
  /** Spread % of mid on each side (fractions; 0.08 = 8%). */
  refSpreadPct: number | null;
  tastySpreadPct: number | null;
  /** Tastytrade minus reference, per share (null when either side is missing). */
  bidDiff: number | null;
  askDiff: number | null;
  /** Would the LIVE 10% spread rule reach a different status on Tastytrade's quote? (study only, never applied) */
  gateDisagrees: boolean | null;
};

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One Tastytrade REST /market-data/by-type item → TastyQuote (dasherized keys, decimal strings). */
export function parseTastyItem(it: Record<string, unknown>): TastyQuote {
  const bid = num(it.bid);
  const ask = num(it.ask);
  let mid = num(it.mid);
  if (mid == null && bid != null && ask != null) mid = Math.round(((bid + ask) / 2) * 1000) / 1000;
  return { bid, ask, mid, mark: num(it.mark), last: num(it.last), updatedAt: typeof it["updated-at"] === "string" ? (it["updated-at"] as string) : null };
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function compareRow(
  base: Omit<TastyCompareRow, "refSpreadPct" | "tastySpreadPct" | "bidDiff" | "askDiff" | "gateDisagrees">,
  maxPct: number,
): TastyCompareRow {
  const rs = spreadFromPair(base.ref.bid, base.ref.ask);
  const ts = base.tasty ? spreadFromPair(base.tasty.bid, base.tasty.ask) : null;
  const d = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null ? r4(a - b) : null);
  return {
    ...base,
    refSpreadPct: rs?.pct ?? null,
    tastySpreadPct: ts?.pct ?? null,
    bidDiff: d(base.tasty?.bid, base.ref.bid),
    askDiff: d(base.tasty?.ask, base.ref.ask),
    gateDisagrees: rs && ts ? rs.pct > maxPct !== ts.pct > maxPct : null,
  };
}

/** Day summary for the log header. */
export function summarize(rows: TastyCompareRow[]) {
  const both = rows.filter((r) => r.bidDiff != null && r.askDiff != null);
  const avg = (xs: number[]) => (xs.length ? r4(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    rows: rows.length,
    withBoth: both.length,
    tastyMissing: rows.filter((r) => !r.tasty || (r.tasty.bid == null && r.tasty.ask == null)).length,
    avgAbsBidDiff: avg(both.map((r) => Math.abs(r.bidDiff!))),
    avgAbsAskDiff: avg(both.map((r) => Math.abs(r.askDiff!))),
    gateDisagreements: rows.filter((r) => r.gateDisagrees === true).length,
  };
}
