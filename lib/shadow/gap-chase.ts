import "server-only";

import { loadAiPicksState } from "@/lib/ai-picks-state";
import { askShare, toNumber } from "@/lib/numbers";
import { loadMorningShortlist } from "@/lib/morning";
import { loadDailyPicks } from "@/lib/picks";
import { loadPremoveShortlist } from "@/lib/premove";
import { tradingDateET } from "@/lib/session";
import { getSessionTape } from "@/lib/session-tape";
import { etClock } from "@/lib/shadow/budget";
import { evaluateGapChase, marketFromStates, type GapChaseMarket, type GapChaseVerdict } from "@/lib/shadow/gap-chase-core";
import { loadDoc, persistenceMode, saveDoc } from "@/lib/shadow/store";
import { fetchStockStates, hasUnusualWhalesKey, type StockState } from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";
import type { FlowAlert, RankedFlow } from "@/lib/types";

/**
 * TEST / SHADOW "gap-up chase" checker. Reads the live Picks / Premove / Morning / AI lists, computes a
 * verdict per call contract and LOGS it (flowguard/shadow/gap-chase-<day>.json) so the study book can
 * score it. Display-only flags — never filters, re-ranks or changes live picks, the AI review or paper.
 * UW: SPY/QQQ + pick tickers stock-state (12-min cache) per recompute; recompute ≤ every 3 min.
 */
export const GAP_CHASE_DISCLAIMER =
  "TEST / SHADOW — gap-up chase checker. Flags only; never changes live picks, the AI review or paper fills. Not financial advice.";

const KIND = "gap-chase";
const RECOMPUTE_MS = 3 * 60_000;
const MAX_TICKERS = 16;

export type GapChaseRow = GapChaseVerdict & {
  key: string;
  contract: string;
  ticker: string;
  side: "call" | "put";
  lists: string[];
  firstPrintUtc: string | null;
  alertPrice: number | null;
  underlyingAtPrint: number | null;
  prevClose: number | null;
  secondAskAt: string | null;
  pullbackAt: string | null;
  firstSeenAt: string;
  lastCheckedAt: string;
  /** Verdict the first time the contract was seen on a list (what a morning chaser would have seen). */
  firstVerdict: GapChaseVerdict["verdict"];
  firstReasons: string[];
  flipCount: number;
};

export type GapChaseDoc = {
  day: string;
  updatedAt: string;
  market: GapChaseMarket;
  rows: Record<string, GapChaseRow>;
  uwCalls: number;
  log: Array<{ at: string; contract: string; from: string | null; to: string; why: string }>;
};

export type GapChaseView = GapChaseDoc & {
  mode: "test";
  disclaimer: string;
  persistence: string;
  rule: string;
  backtest: string;
};

const RULE =
  "Gap-up day = SPY or QQQ open ≥ +0.3% vs prior close. Calls printed 9:30–11:00 ET on a gap-up need a 2nd ask-side print on the same contract or a ≥0.3% pullback before they count; calls on stocks already ≥ +2% at the print get a shadow penalty (−6, −10 at ≥ +3%).";
const BACKTEST =
  "2-year replay (499 sessions, 8,388 scored call candidates; 131 gap-up days): on gap-up mornings flagged calls won 40.4% (495W/729L/111F) vs kept 46.5% (198W/228L/41F), baseline 42.0%. Cuts ~76% of losers but ~71% of winners → flag/penalty, not a filter.";

let memo: { at: number; day: string; doc: GapChaseDoc } | null = null;
let inflight: Promise<GapChaseDoc> | null = null;

function etMinutesOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return etClock(d).minutes;
}

function inRegularHours(now: Date): boolean {
  const c = etClock(now);
  return c.weekday && c.minutes >= 9 * 60 + 30 && c.minutes < 16 * 60;
}

type Seen = { row: RankedFlow; lists: Set<string> };

async function gatherLists(): Promise<Map<string, Seen>> {
  const out = new Map<string, Seen>();
  const add = (list: string, rows: RankedFlow[] | undefined | null) => {
    for (const row of rows ?? []) {
      const chain = row?.alert?.option_chain;
      if (!chain) continue;
      const hit = out.get(chain);
      if (hit) hit.lists.add(list);
      else out.set(chain, { row, lists: new Set([list]) });
    }
  };
  const today = tradingDateET();
  const [picks, premove, morning, ai] = await Promise.allSettled([
    loadDailyPicks(),
    loadPremoveShortlist(),
    loadMorningShortlist(),
    loadAiPicksState(),
  ]);
  if (morning.status === "fulfilled") add("morning", morning.value.picks);
  if (picks.status === "fulfilled") add("picks", picks.value.picks);
  if (premove.status === "fulfilled") add("premove", premove.value.picks);
  if (ai.status === "fulfilled" && ai.value?.day === today && ai.value.value) {
    add("ai-picks", ai.value.value.picks);
    add("ai-premove", ai.value.value.premove?.picks);
  }
  return out;
}

/** First print time on the chain + time of the 2nd ask-side (≥60% ask premium) print on the session tape. */
function chainPrints(alerts: FlowAlert[], chain: string): { firstAt: string | null; secondAskAt: string | null } {
  const same = alerts
    .filter((a) => a.option_chain === chain)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const asks = same.filter((a) => askShare(a) >= 0.6);
  return { firstAt: same[0]?.created_at ?? null, secondAskAt: asks[1]?.created_at ?? null };
}

/** Evaluate + merge verdict rows into the day doc (exported for the smoke test). */
export function applyGapChaseRows(
  doc: GapChaseDoc,
  seen: Map<string, { row: RankedFlow; lists: Set<string> }>,
  states: Record<string, StockState>,
  tape: FlowAlert[],
  at: string,
): void {
  for (const { row, lists } of seen.values()) {
    const a = row.alert;
    const side = a.type === "put" ? "put" : "call";
    const key = a.option_chain;
    const old = doc.rows[key];
    const { firstAt, secondAskAt } = chainPrints(tape, key);
    const st = states[a.ticker.toUpperCase()];
    const underlyingAtPrint = old?.underlyingAtPrint ?? (toNumber(a.underlying_price) || null);
    // Freeze the print-time context on first sight.
    const prevClose = old?.prevClose ?? st?.prevClose ?? null;
    const firstPrintUtc = old?.firstPrintUtc ?? firstAt ?? a.created_at ?? null;
    const v = evaluateGapChase({
      side,
      printEtMinutes: etMinutesOf(firstPrintUtc),
      market: doc.market,
      underlyingAtPrint,
      prevClose,
      dayOpen: st?.open ?? null,
      spotNow: st?.last ?? null,
      secondAskAt: old?.secondAskAt ?? secondAskAt,
      pullbackAt: old?.pullbackAt ?? null,
    });
    const pullbackAt = old?.pullbackAt ?? (v.pullbackNow ? at : null);
    const next: GapChaseRow = {
      ...v,
      key,
      contract: key,
      ticker: a.ticker,
      side,
      lists: [...new Set([...(old?.lists ?? []), ...lists])],
      firstPrintUtc,
      alertPrice: old?.alertPrice ?? (toNumber(a.price) || null),
      underlyingAtPrint,
      prevClose,
      secondAskAt: old?.secondAskAt ?? secondAskAt,
      pullbackAt,
      firstSeenAt: old?.firstSeenAt ?? at,
      lastCheckedAt: at,
      firstVerdict: old?.firstVerdict ?? v.verdict,
      firstReasons: old?.firstReasons ?? v.reasons,
      flipCount: (old?.flipCount ?? 0) + (old && old.verdict !== v.verdict ? 1 : 0),
    };
    if (!old || old.verdict !== v.verdict) {
      doc.log.push({ at, contract: key, from: old?.verdict ?? null, to: v.verdict, why: v.reasons[v.reasons.length - 1] ?? "" });
    }
    doc.rows[key] = next;
  }
}

async function compute(now: Date): Promise<GapChaseDoc> {
  const day = tradingDateET(now);
  const prev = (await loadDoc<GapChaseDoc>(KIND, day)) ?? null;
  const doc: GapChaseDoc = prev?.day === day
    ? { ...prev, rows: { ...prev.rows }, log: [...(prev.log ?? [])] }
    : { day, updatedAt: now.toISOString(), market: { spyGapPct: null, qqqGapPct: null, gapDay: false, capturedAt: null }, rows: {}, uwCalls: 0, log: [] };

  // Only evaluate during the regular session: after the close UW prev_close/open roll to the new session.
  if (!inRegularHours(now)) return doc;

  const seen = await gatherLists();
  const calls = [...seen.values()].filter((s) => s.row.alert.type === "call");
  const live = (await hasUnusualWhalesKey()) && !(await isUwBlocked());

  // Market gap: frozen once per day (first capture in regular hours).
  let states: Record<string, StockState> = {};
  if (live) {
    const tickers = ["SPY", "QQQ", ...new Set(calls.map((c) => c.row.alert.ticker.toUpperCase()))].slice(0, MAX_TICKERS + 2);
    try {
      states = await fetchStockStates(tickers, tickers.length);
      doc.uwCalls += tickers.length; // upper bound (12-min cache hits included)
    } catch {
      states = {};
    }
  }
  const regular = (s?: StockState) => !s?.marketTime || !/^(pr|po|pre|post|closed)/i.test(s.marketTime);
  if (!doc.market.capturedAt && states.SPY?.open && states.QQQ?.open && regular(states.SPY) && regular(states.QQQ)) {
    doc.market = marketFromStates(states.SPY, states.QQQ, now.toISOString());
  }

  let tape: FlowAlert[] = [];
  try {
    tape = (await getSessionTape({ allowUw: false })).alerts;
  } catch {
    tape = [];
  }

  applyGapChaseRows(doc, seen, states, tape, now.toISOString());
  doc.log = doc.log.slice(-300);
  doc.updatedAt = now.toISOString();
  await saveDoc(KIND, day, doc).catch(() => undefined);
  return doc;
}

export async function loadGapChase(opts: { day?: string; now?: Date } = {}): Promise<GapChaseView> {
  const now = opts.now ?? new Date();
  const today = tradingDateET(now);
  const wrap = (doc: GapChaseDoc): GapChaseView => ({
    mode: "test",
    disclaimer: GAP_CHASE_DISCLAIMER,
    persistence: persistenceMode(),
    rule: RULE,
    backtest: BACKTEST,
    ...doc,
  });
  if (opts.day && opts.day !== today) {
    const doc = await loadDoc<GapChaseDoc>(KIND, opts.day);
    return wrap(doc ?? { day: opts.day, updatedAt: "", market: { spyGapPct: null, qqqGapPct: null, gapDay: false, capturedAt: null }, rows: {}, uwCalls: 0, log: [] });
  }
  if (memo && memo.day === today && now.getTime() - memo.at < RECOMPUTE_MS) return wrap(memo.doc);
  if (!inflight) {
    inflight = compute(now)
      .then((doc) => {
        memo = { at: Date.now(), day: today, doc };
        return doc;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return wrap(await inflight);
}
