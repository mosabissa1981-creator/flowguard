import "server-only";

import { toNumber } from "@/lib/numbers";
import { tradingDateET } from "@/lib/session";
import { getSessionTape } from "@/lib/session-tape";
import { etClock } from "@/lib/shadow/budget";
import { loadDoc, persistenceMode, saveDoc } from "@/lib/shadow/store";
import { fetchChainSnapshot, hasUnusualWhalesKey } from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";
import { runAsUwJob, uwJobBudgetOk } from "@/lib/uw-usage";

/**
 * TEST / SHADOW whole-chain scan. Top 30 tickers by session-tape premium (list frozen at 10:00 ET) get a full
 * option-contracts snapshot every ~20 min. Between scans it flags contracts where ask-side volume is building:
 * Δask ≥ max(200, 10% of OI), ≥ 65% of the new ask+bid volume, DTE 3–45, |delta| 0.15–0.60. Each hit is self-scored
 * on later scans (max mid vs mid at detection). Logged only — never feeds live picks.
 */
const KIND = "chain-scan";
const PREV_KIND = "chain-scan-prev";
const SCAN_EVERY_MS = 20 * 60_000;
const TOP_N = 30;
const MAX_HITS = 600;
export const CHAIN_RULE =
  "Every ~20 min in market hours: full chain (top 500 non-zero-volume contracts) for the top 30 tickers by morning flow premium. Building = Δask volume since last scan ≥ max(200, 10% of OI) and ≥ 65% of new ask+bid volume, DTE 3–45, |delta| 0.15–0.60.";

type Snap = Record<string, [number, number, number, number]>; // ask_vol, bid_vol, oi, mid
export type ChainHit = {
  key: string;
  at: string;
  ticker: string;
  contract: string;
  deltaAsk: number;
  askShareOfDelta: number;
  oi: number;
  midAtHit: number;
  lastMid: number | null;
  maxMid: number | null;
  maxGainPct: number | null;
  lastPct: number | null;
};
export type ChainDoc = {
  day: string;
  updatedAt: string;
  lastScanAt: string | null;
  tickers: string[];
  frozen: boolean;
  scans: number;
  uwCalls: number;
  hits: ChainHit[];
  note: string | null;
};

const empty = (day: string): ChainDoc => ({ day, updatedAt: "", lastScanAt: null, tickers: [], frozen: false, scans: 0, uwCalls: 0, hits: [], note: null });
let inflight: Promise<ChainDoc> | null = null;

function dte(sym: string, now: Date): number | null {
  const m = /^[A-Z.]+?(\d{2})(\d{2})(\d{2})[CP]\d+$/.exec(sym);
  if (!m) return null;
  const exp = Date.UTC(2000 + Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((exp - now.getTime()) / 86400_000);
}

async function topTickers(): Promise<string[]> {
  const tape = (await getSessionTape({ allowUw: false })).alerts;
  const prem = new Map<string, number>();
  for (const a of tape) {
    if (!a.ticker || /^(SPX|SPXW|NDX|VIX|XSP|RUT)$/.test(a.ticker)) continue;
    prem.set(a.ticker, (prem.get(a.ticker) ?? 0) + toNumber(a.total_premium));
  }
  return [...prem.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N).map(([t]) => t);
}

async function scan(now: Date): Promise<ChainDoc> {
  const day = tradingDateET(now);
  const doc = (await loadDoc<ChainDoc>(KIND, day, { fresh: true })) ?? empty(day);
  const c = etClock(now);
  if (!c.weekday || c.minutes < 9 * 60 + 40 || c.minutes >= 16 * 60) return { ...doc, note: "scans run 9:40–16:00 ET" };
  if (doc.lastScanAt && now.getTime() - new Date(doc.lastScanAt).getTime() < SCAN_EVERY_MS) return doc;
  if (!(await hasUnusualWhalesKey()) || (await isUwBlocked())) return { ...doc, note: "UW unavailable — skipped" };
  if (!(await uwJobBudgetOk(TOP_N + 50))) return { ...doc, note: "UW daily budget near 35,000 — paused until 8 PM ET reset" };

  if (!doc.frozen) {
    const t = await topTickers();
    if (t.length) doc.tickers = t;
    doc.frozen = c.minutes >= 10 * 60 && doc.tickers.length > 0;
  }
  const prev = (await loadDoc<Record<string, Snap>>(PREV_KIND, day, { fresh: true })) ?? {};
  const next: Record<string, Snap> = {};
  const at = now.toISOString();
  let calls = 0;
  const mids: Record<string, number> = {};
  await runAsUwJob(KIND, async () => {
    // Two at a time keeps us under the plan's 3-concurrent limit (the shared UW queue also caps it).
    const queue = [...doc.tickers];
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        let rows: Record<string, unknown>[] = [];
        try {
          calls += 1;
          rows = await fetchChainSnapshot(t);
        } catch {
          continue;
        }
        const snap: Snap = {};
        for (const r of rows) {
          const sym = String(r.option_symbol ?? "");
          const d = dte(sym, now);
          const delta = Math.abs(toNumber(r.delta as string));
          const bid = toNumber(r.nbbo_bid as string);
          const ask = toNumber(r.nbbo_ask as string);
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : toNumber(r.last_price as string);
          if (mid > 0) mids[sym] = mid;
          if (d == null || d < 3 || d > 45 || delta < 0.15 || delta > 0.6) continue;
          snap[sym] = [toNumber(r.ask_volume as string), toNumber(r.bid_volume as string), toNumber(r.open_interest as string), +mid.toFixed(3)];
          const p = prev[t]?.[sym];
          if (!p) continue;
          const dAsk = snap[sym][0] - p[0];
          const dBid = Math.max(0, snap[sym][1] - p[1]);
          const share = dAsk + dBid > 0 ? dAsk / (dAsk + dBid) : 0;
          if (dAsk >= Math.max(200, 0.1 * snap[sym][2]) && share >= 0.65 && mid > 0) {
            const key = `${sym}@${doc.scans}`;
            if (!doc.hits.some((h) => h.contract === sym && now.getTime() - new Date(h.at).getTime() < 60 * 60_000)) {
              doc.hits.push({ key, at, ticker: t, contract: sym, deltaAsk: dAsk, askShareOfDelta: +share.toFixed(2), oi: snap[sym][2], midAtHit: +mid.toFixed(3), lastMid: null, maxMid: null, maxGainPct: null, lastPct: null });
            }
          }
        }
        next[t] = snap;
      }
    };
    await Promise.all([worker(), worker()]);
  });
  for (const h of doc.hits) {
    const m = mids[h.contract];
    if (m == null || h.at === at) continue;
    h.lastMid = m;
    h.maxMid = Math.max(h.maxMid ?? m, m);
    h.maxGainPct = +((h.maxMid / h.midAtHit - 1) * 100).toFixed(1);
    h.lastPct = +((m / h.midAtHit - 1) * 100).toFixed(1);
  }
  const out: ChainDoc = { ...doc, updatedAt: at, lastScanAt: at, scans: doc.scans + 1, uwCalls: doc.uwCalls + calls, hits: doc.hits.slice(-MAX_HITS), note: null };
  await saveDoc(PREV_KIND, day, { ...prev, ...next });
  await saveDoc(KIND, day, out);
  return out;
}

export async function loadChainScan(opts: { day?: string; now?: Date; refresh?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const today = tradingDateET(now);
  const day = opts.day ?? today;
  const wrap = (doc: ChainDoc) => {
    const scored = doc.hits.filter((h) => h.maxGainPct != null);
    return {
      mode: "test" as const,
      disclaimer: "TEST / SHADOW lane — logged only, never feeds live picks. Not financial advice.",
      persistence: persistenceMode(),
      rule: CHAIN_RULE,
      summary: { hits: doc.hits.length, scored: scored.length, reached20: scored.filter((h) => (h.maxGainPct ?? 0) >= 20).length, reached40: scored.filter((h) => (h.maxGainPct ?? 0) >= 40).length },
      ...doc,
    };
  };
  if (day !== today || !opts.refresh) return wrap((await loadDoc<ChainDoc>(KIND, day)) ?? empty(day));
  if (!inflight) inflight = scan(now).finally(() => (inflight = null));
  return wrap(await inflight);
}
