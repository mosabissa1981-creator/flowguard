import "server-only";

import { kvGetMany, kvSetNx } from "@/lib/kv";
import { loadPaperView } from "@/lib/paper";
import { tradingDateET } from "@/lib/session";
import { loadDoc, saveDoc } from "@/lib/shadow/store";
import type { ShadowDay } from "@/lib/shadow/types";
import { SPREAD_MAX_PCT } from "@/lib/spread-core";
import { fetchTastyOptionQuotes, tastyConfigured, tastyTestEnabled } from "@/lib/tasty";
import { compareRow, fromTastyOcc, summarize, toTastyOcc, type QuotePair, type TastyCompareRow } from "@/lib/tasty-core";

/**
 * TEST MODE ONLY (FLOWGUARD_TASTY_TEST=1, default off). Shadow comparison log: Tastytrade REST bid/ask next to the quote
 * FlowGuard already has (Unusual Whales) for (a) open paper positions — their last UW mark — and (b) spread-check
 * candidates — today's shadow/AI-review candidates, compared with the LIVE spread gate's UW NBBO memo in KV.
 * Rides the existing /api/shadow/tick (no new cron), ≤ 1 run / 10 min, ≤ 100 contracts = 1 Tastytrade call, 0 UW calls.
 * Writes only flowguard/shadow/tasty-quotes-<day>.json. Never changes picks, the board, the spread gate, paper fills,
 * pings or Telegram, and places no orders (the Tastytrade app is read + openid only).
 */
const LOCK_KEY = "flowguard/shadow/tasty-compare-lock";
const MIN_GAP_SEC = 600;
const MAX_CONTRACTS = 100;
const MAX_ROWS = 3000;
/** Same key as lib/spread-gate.ts (read-only here; duplicated so the live gate file stays untouched). */
const SPREAD_MEMO_KEY = (contract: string) => `spread:q:${contract}`;

export type TastyQuotesDoc = {
  day: string;
  mode: "test";
  note: string;
  updatedAt: string;
  runs: number;
  lastError?: string;
  summary: ReturnType<typeof summarize>;
  rows: TastyCompareRow[];
};

type Want = { contract: string; ticker: string; from: string; ref: QuotePair; refSource: TastyCompareRow["refSource"]; refAt: string | null };

export async function loadTastyQuotes(day = tradingDateET()): Promise<TastyQuotesDoc | null> {
  return loadDoc<TastyQuotesDoc>("tasty-quotes", day, { fresh: true });
}

export async function runTastyCompare(opts: { now?: Date; force?: boolean } = {}): Promise<{ note: string; uwCalls: number }> {
  const now = opts.now ?? new Date();
  if (!tastyTestEnabled()) return { note: "off (FLOWGUARD_TASTY_TEST!=1)", uwCalls: 0 };
  if (!tastyConfigured()) return { note: "not configured (TASTYTRADE_REFRESH_TOKEN / TASTYTRADE_CLIENT_SECRET)", uwCalls: 0 };
  if (!opts.force && !(await kvSetNx(LOCK_KEY, now.toISOString(), MIN_GAP_SEC))) return { note: "throttled (≤ 1 run / 10 min)", uwCalls: 0 };

  const day = tradingDateET(now);
  const wants = new Map<string, Want>();
  const add = (w: Want) => {
    if (!wants.has(w.contract) && wants.size < MAX_CONTRACTS && toTastyOcc(w.contract)) wants.set(w.contract, w);
  };

  // (a) open paper positions (all books + tracking), single legs vs their last UW mark; spread legs vs the memo below.
  const paper = await loadPaperView(now).catch(() => null);
  for (const p of [...(paper?.open ?? []), ...(paper?.tracking.open ?? [])]) {
    if (p.legs?.length) {
      for (const l of p.legs) add({ contract: l.option_chain, ticker: l.ticker, from: `open:${p.book}:leg`, ref: { bid: null, ask: null }, refSource: "none", refAt: null });
    } else {
      const m = p.lastMark;
      add({ contract: p.contract, ticker: p.ticker, from: `open:${p.book}`, ref: { bid: m?.bid ?? null, ask: m?.ask ?? null }, refSource: m ? "paper_mark" : "none", refAt: m?.quoteAsOf ?? m?.at ?? null });
    }
  }
  // (b) spread-check candidates: today's shadow candidates (same gather the AI review / live lists use).
  const shadow = await loadDoc<ShadowDay>("day", day).catch(() => null);
  for (const c of shadow?.candidates ?? []) add({ contract: c.contract, ticker: c.ticker, from: "spread-check", ref: { bid: null, ask: null }, refSource: "none", refAt: null });

  // UW NBBO from the live spread gate's KV memo (no UW call) where no paper mark is available.
  const memoTodo = [...wants.values()].filter((w) => w.refSource === "none");
  const memo = await kvGetMany<{ at: number; q: QuotePair | null }>(memoTodo.map((w) => SPREAD_MEMO_KEY(w.contract))).catch(() => []);
  memoTodo.forEach((w, i) => {
    const hit = memo[i];
    if (hit?.q) Object.assign(w, { ref: { bid: hit.q.bid, ask: hit.q.ask }, refSource: "spread_memo", refAt: new Date(hit.at).toISOString() });
  });

  const doc: TastyQuotesDoc = (await loadTastyQuotes(day).catch(() => null)) ?? {
    day,
    mode: "test",
    note: "TEST MODE: Tastytrade bid/ask vs FlowGuard's UW quote. Comparison log only — never used for picks, gates, fills or pings.",
    updatedAt: now.toISOString(),
    runs: 0,
    summary: summarize([]),
    rows: [],
  };
  if (wants.size === 0) return { note: "no open positions or candidates", uwCalls: 0 };

  let tasty: Awaited<ReturnType<typeof fetchTastyOptionQuotes>> = {};
  try {
    tasty = await fetchTastyOptionQuotes([...wants.keys()].map((c) => toTastyOcc(c)!));
    doc.lastError = undefined;
  } catch (e) {
    doc.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  }
  const byKey = new Map(Object.entries(tasty).map(([k, v]) => [fromTastyOcc(k), v]));
  const at = now.toISOString();
  const rows = [...wants.values()].map((w) =>
    compareRow({ at, contract: w.contract, ticker: w.ticker, from: w.from, refSource: w.refSource, refAt: w.refAt, ref: w.ref, tasty: byKey.get(fromTastyOcc(w.contract)) ?? null }, SPREAD_MAX_PCT),
  );
  doc.rows = [...doc.rows, ...rows].slice(-MAX_ROWS);
  doc.runs += 1;
  doc.updatedAt = at;
  doc.summary = summarize(doc.rows);
  await saveDoc("tasty-quotes", day, doc);
  const got = rows.filter((r) => r.tasty).length;
  return { note: doc.lastError ? `tasty error: ${doc.lastError}` : `logged ${rows.length} (tasty quotes ${got})`, uwCalls: 0 };
}
