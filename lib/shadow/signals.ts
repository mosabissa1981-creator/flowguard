import "server-only";

import { LANES, loadBook } from "@/lib/lanes";
import { loadLotteryBook } from "@/lib/lottery";
import { loadPutsBook } from "@/lib/puts";
import { tradingDateET } from "@/lib/session";
import { loadDoc, saveDoc } from "@/lib/shadow/store";
import {
  darkPoolSignal,
  DP_WINDOW_MS,
  type DarkPoolSignal,
  gexSignal,
  type GexSignal,
  oiSignal,
  type OiSignal,
  parseDarkPool,
  parseGexStrikes,
} from "@/lib/shadow/signals-core";
import { fetchContractHistoric, fetchDarkPoolWindow, fetchGexByStrike, hasUnusualWhalesKey } from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";

/**
 * SHADOW signals on TEST-lane logged entries (lanes, puts, lottery): dark-pool confirmation, dealer GEX levels,
 * next-session open-interest follow-through. Stored in the study book and scored against the lanes' own tracking.
 * Never changes picks. Not financial advice.
 */
export const SIGNALS_DISCLAIMER =
  "SHADOW / TEST — study signals only. They never change live picks or lanes. Not financial advice; FlowGuard never trades.";

const KIND = "shadow-signals";
const MAX_NEW_PER_RUN = 16; // dark pool + GEX lookups per run (≤ 2 UW calls each, GEX shared per ticker)
const MAX_OI_PER_RUN = 20;
const MEMO_MS = 10 * 60_000;

type EntryRef = {
  key: string;
  lane: string;
  contract: string;
  ticker: string;
  side: "call" | "put";
  strike: number;
  day: string;
  printTimeUtc: string | null;
  underlying: number;
  outcome: string | null;
};

export type SignalRow = EntryRef & {
  dp?: DarkPoolSignal | null;
  gex?: GexSignal | null;
  oi?: OiSignal | null;
  computedAt: string;
};

type Book = { updatedAt: string; rows: Record<string, SignalRow> };

let memo: { at: number; value: unknown } | null = null;

async function loggedEntries(): Promise<EntryRef[]> {
  const out: EntryRef[] = [];
  const add = (lane: string, e: { contract: string; ticker: string; side?: "call" | "put"; strike: number; day: string; printTimeUtc?: string | null; underlying?: number; tracking?: { outcome?: string } | null }) =>
    out.push({
      key: `${e.day}|${lane}|${e.contract}`,
      lane,
      contract: e.contract,
      ticker: e.ticker,
      side: e.side ?? (/\d{6}P\d{8}$/.test(e.contract) ? "put" : "call"),
      strike: e.strike,
      day: e.day,
      printTimeUtc: e.printTimeUtc ?? null,
      underlying: e.underlying ?? 0,
      outcome: (e.tracking as { outcome?: string } | undefined)?.outcome ?? null,
    });
  for (const l of LANES) for (const e of (await loadBook(l.id)).entries) add(l.id, e);
  for (const e of (await loadPutsBook()).entries) add("puts", { ...e, side: "put" });
  for (const e of (await loadLotteryBook()).entries) {
    const t = e.tracking;
    add("lottery", { ...e, tracking: t ? { outcome: t.hit100 ? "winner" : t.final ? "loser" : "open" } : null });
  }
  return out;
}

function stats(rows: SignalRow[]) {
  const decided = rows.filter((r) => r.outcome === "winner" || r.outcome === "loser" || r.outcome === "flat");
  const out: Record<string, Record<string, { n: number; winners: number; losers: number; winRate: number | null }>> = {};
  for (const k of ["dp", "gex", "oi"] as const) {
    out[k] = {};
    for (const r of decided) {
      const v = (r[k] as { verdict?: string } | null | undefined)?.verdict ?? "n/a";
      const b = (out[k][v] ??= { n: 0, winners: 0, losers: 0, winRate: null });
      b.n += 1;
      if (r.outcome === "winner") b.winners += 1;
      if (r.outcome === "loser") b.losers += 1;
    }
    for (const b of Object.values(out[k])) b.winRate = b.n ? Math.round((b.winners / b.n) * 1000) / 10 : null;
  }
  return out;
}

export async function refreshSignals(opts: { force?: boolean } = {}) {
  if (!opts.force && memo && Date.now() - memo.at < MEMO_MS) return memo.value;
  const today = tradingDateET();
  const book = (await loadDoc<Book>(KIND, "book", { fresh: true })) ?? { updatedAt: "", rows: {} };
  const entries = await loggedEntries();
  const allowUw = (await hasUnusualWhalesKey()) && !(await isUwBlocked());
  let uwCalls = 0;
  let changed = false;
  if (allowUw) {
    // 1) Dark pool + GEX on entries not yet evaluated (print-day data; UW serves past dates too).
    const gexCache = new Map<string, ReturnType<typeof parseGexStrikes>>();
    const fresh = entries.filter((e) => !book.rows[e.key]?.computedAt && e.printTimeUtc).slice(-MAX_NEW_PER_RUN);
    for (const e of fresh) {
      const printMs = Date.parse(e.printTimeUtc as string);
      let dp: DarkPoolSignal | null = null;
      let gex: GexSignal | null = null;
      try {
        uwCalls += 1;
        dp = darkPoolSignal(parseDarkPool(await fetchDarkPoolWindow(e.ticker, e.day, printMs - DP_WINDOW_MS, printMs + DP_WINDOW_MS)), e.side, printMs);
      } catch {
        dp = null;
      }
      try {
        const gk = `${e.ticker}|${e.day}`;
        if (!gexCache.has(gk)) {
          uwCalls += 1;
          gexCache.set(gk, parseGexStrikes(await fetchGexByStrike(e.ticker, e.day)));
        }
        gex = gexSignal(gexCache.get(gk) ?? [], e.underlying, e.side, e.strike);
      } catch {
        gex = null;
      }
      book.rows[e.key] = { ...e, dp, gex, oi: oiSignal(null, null), computedAt: new Date().toISOString() };
      changed = true;
    }
    // 2) OI follow-through once the next session's OI is published.
    const pending = entries.filter((e) => e.day < today && book.rows[e.key] && (!book.rows[e.key].oi || book.rows[e.key].oi?.verdict === "pending")).slice(-MAX_OI_PER_RUN);
    for (const e of pending) {
      uwCalls += 1;
      const bars = await fetchContractHistoric(e.contract, 12).catch(() => []);
      const dayBar = bars.find((b) => b.date === e.day);
      const next = bars.find((b) => b.date > e.day);
      book.rows[e.key].oi = oiSignal(dayBar?.openInterest ?? null, next?.openInterest ?? null);
      changed = true;
    }
  }
  // Refresh outcomes from the lanes' own tracking.
  for (const e of entries) {
    const r = book.rows[e.key];
    if (r && r.outcome !== e.outcome) {
      r.outcome = e.outcome;
      changed = true;
    }
  }
  if (changed) {
    book.updatedAt = new Date().toISOString();
    await saveDoc(KIND, "book", book);
  }
  const rows = Object.values(book.rows).sort((a, b) => (b.day + b.key).localeCompare(a.day + a.key));
  const value = {
    mode: "shadow",
    generatedAt: new Date().toISOString(),
    today,
    definitions: {
      dp: "Dark-pool prints ≥ $1M within ±15 min of the flow print; buyer- vs seller-initiated by price vs NBBO mid. confirm = ≥ $5M with bias ≥ 0.2 in the trade's direction.",
      gex: "UW greek-exposure by strike on the print day. confirm = negative net dealer gamma (trend-friendly) with the strike inside the call wall (calls) / put wall (puts) and ≥ 2% room; conflict = positive gamma with the strike beyond the wall or < 1% room.",
      oi: "Next-session open interest vs print-day OI on the same contract. confirm = OI up ≥ 10% (positions opened); conflict = OI down ≥ 5%.",
    },
    stats: stats(rows),
    today_rows: rows.filter((r) => r.day === today),
    recent: rows.slice(0, 60),
    uwCalls,
    disclaimer: SIGNALS_DISCLAIMER,
  };
  memo = { at: Date.now(), value };
  return value;
}
