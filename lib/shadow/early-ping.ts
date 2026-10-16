import "server-only";

import { kvSetNx } from "@/lib/kv";
import { askShare, toNumber } from "@/lib/numbers";
import { loadRiskOff } from "@/lib/risk-off";
import { tradingDateET } from "@/lib/session";
import { getSessionTape } from "@/lib/session-tape";
import { etClock } from "@/lib/shadow/budget";
import { CAPS, type CapId, EARLY_UNTIL_ET_MIN, type EpPrint, FILL_UNTIL_ET_MIN, PING_ET_MIN, PRIOR_AFTER_ET_MIN, maxPrice, rankCandidates } from "@/lib/shadow/early-ping-core";
import { type OptBar, type PutResult, scorePut } from "@/lib/shadow/risk-off-continuation-core";
import { loadDoc, persistenceMode, saveDoc } from "@/lib/shadow/store";
import { fetchContractHistoric, hasUnusualWhalesKey } from "@/lib/uw";
import { isUwBlocked } from "@/lib/uw-quota";
import { runAsUwJob, uwJobBudgetOk } from "@/lib/uw-usage";

/**
 * TEST MODE ONLY — "Early ping" shadow lane. Approved by Mosab 10/16/2026 for testing.
 * Log + quiet study-book scoring only: never changes the live board / morning ping / picks / paper, never Telegram, never pings.
 * UW use (job "early-ping", stops at UW_JOBS_STOP_AT = 35,000/day): flow from the shared session tape with allowUw:false
 * (no extra flow calls); scoring = one historic call per candidate (≤5/day) after session 2 closes.
 */
export const EP_DISCLAIMER =
  "TEST / SHADOW — Early ping lane. Logged and scored quietly in the study book; never affects the live board, pings or Telegram. Not financial advice; FlowGuard never trades.";

const KIND = "early-ping";
const DAY = "book";
const JOB = "early-ping";

type Fill = { filled: boolean; entry: number | null; how: "tape" | "daily-low" | "open" | null };
export type EpCand = {
  key: string; day: string; contract: string; ticker: string; side: string; expiry: string; printUtc: string;
  source: "prior-afternoon" | "first-15m"; print: number; premium: number; askShare: number;
  heldBack: boolean; maxPrice: Record<CapId, number>; fill: Record<CapId, Fill>; res: Partial<Record<CapId, PutResult>>; done: boolean; loggedAt: string;
};
export type EpBook = {
  updatedAt: string; carry: Record<string, EpPrint[]>; cands: EpCand[]; pinged: Record<string, string>;
  uwCalls: Record<string, number>; runs: Array<{ at: string; note: string }>;
};
const emptyBook = (): EpBook => ({ updatedAt: "", carry: {}, cands: [], pinged: {}, uwCalls: {}, runs: [] });
const noFill = (): Record<CapId, Fill> => ({ p5: { filled: false, entry: null, how: null }, p10: { filled: false, entry: null, how: null } });

async function tapePrints(): Promise<EpPrint[]> {
  const tape = await getSessionTape({ allowUw: false }).catch(() => null);
  return (tape?.alerts ?? []).map((a) => ({
    contract: a.option_chain, ticker: a.ticker.toUpperCase(), issueType: a.issue_type ?? null, side: a.type, printUtc: a.created_at,
    price: toNumber(a.price), bid: toNumber(a.bid) || null, ask: toNumber(a.ask) || null, askShare: askShare(a),
    premium: toNumber(a.total_premium), expiry: a.expiry, day: tradingDateET(new Date(a.created_at)), etMin: etClock(new Date(a.created_at)).minutes,
  }));
}

async function step(book: EpBook, now: Date): Promise<string> {
  const day = tradingDateET(now);
  const c = etClock(now);
  if (!c.weekday) return "weekend";
  const notes: string[] = [];
  const prints = c.minutes >= 9 * 60 + 30 ? await tapePrints() : [];
  // 1) Virtual ping at ~9:35–9:45 ET: prior-afternoon carry + first-15m prints → candidates with max prices.
  if (!book.pinged[day] && c.minutes >= PING_ET_MIN && c.minutes <= FILL_UNTIL_ET_MIN) {
    const prevKey = Object.keys(book.carry).filter((d) => d < day).sort().pop();
    const prior = prevKey ? book.carry[prevKey] : [];
    const early = prints.filter((p) => p.day === day && p.etMin < EARLY_UNTIL_ET_MIN);
    const ro = await loadRiskOff({ now }).catch(() => null);
    const primary = ro?.level === "primary";
    for (const p of rankCandidates([...prior.map((x) => ({ ...x, day })), ...early])) {
      book.cands.push({
        key: `${day}|${p.contract}`, day, contract: p.contract, ticker: p.ticker, side: p.side, expiry: p.expiry, printUtc: p.printUtc,
        source: tradingDateET(new Date(p.printUtc)) === day ? "first-15m" : "prior-afternoon",
        print: p.price, premium: p.premium, askShare: Math.round(p.askShare * 100) / 100,
        heldBack: primary && p.side === "put", // risk-off hold-back mirrors live RISK_OFF_BLOCK_ETF_PUTS
        maxPrice: { p5: maxPrice(p.price, "p5"), p10: maxPrice(p.price, "p10") }, fill: noFill(), res: {}, done: false, loggedAt: now.toISOString(),
      });
    }
    book.pinged[day] = now.toISOString();
    notes.push(`virtual ping: ${book.cands.filter((x) => x.day === day).length} candidate(s) (prior ${prior.length} carried, ${early.length} early prints)`);
  }
  // 2) Fill check from tape prints within the first 60 min (intraday evidence; daily low used at scoring if no tape print).
  for (const k of book.cands.filter((x) => x.day === day)) {
    const px = prints.filter((p) => p.contract === k.contract && p.day === day && p.etMin <= FILL_UNTIL_ET_MIN && p.price > 0).map((p) => p.price);
    for (const cap of Object.keys(CAPS) as CapId[]) {
      const lo = px.length ? Math.min(...px) : null;
      if (!k.fill[cap].filled && lo != null && lo <= k.maxPrice[cap]) k.fill[cap] = { filled: true, entry: k.maxPrice[cap], how: "tape" };
    }
  }
  // 3) Late session: stash prior-afternoon prints (≥13:00 ET) for tomorrow's virtual ping.
  if (c.minutes >= 15 * 60 + 50) {
    book.carry[day] = rankCandidates(prints.filter((p) => p.day === day && p.etMin >= PRIOR_AFTER_ET_MIN), 15);
    for (const d of Object.keys(book.carry).sort().slice(0, -3)) delete book.carry[d];
    notes.push(`carry ${book.carry[day].length} prior-afternoon print(s)`);
  }
  return notes.join("; ") || "nothing due";
}

async function score(book: EpBook, now: Date): Promise<string> {
  const today = tradingDateET(now);
  const c = etClock(now);
  const closed = c.minutes >= 16 * 60 + 10 || !c.weekday;
  const open = book.cands.filter((k) => !k.heldBack && !k.done && k.day < today);
  let scored = 0;
  for (const k of open) {
    if (!(await hasUnusualWhalesKey().catch(() => false)) || (await isUwBlocked().catch(() => true)) || !(await uwJobBudgetOk(1).catch(() => false))) break;
    const bars = await runAsUwJob(JOB, () => fetchContractHistoric(k.contract, 10)).catch(() => []);
    book.uwCalls[today] = (book.uwCalls[today] ?? 0) + 1;
    const ob: OptBar[] = bars.filter((b) => b.date && (b.date < today || closed)).map((b) => ({ date: b.date, o: b.open, h: b.high, l: b.low, c: b.last, bid: b.nbboBid, ask: b.nbboAsk }));
    const d0 = ob.find((b) => b.date === k.day);
    for (const cap of Object.keys(CAPS) as CapId[]) {
      if (!k.fill[cap].filled && d0?.l != null && d0.l <= k.maxPrice[cap]) {
        const e = k.source === "prior-afternoon" && d0.o != null ? Math.min(d0.o, k.maxPrice[cap]) : k.maxPrice[cap];
        k.fill[cap] = { filled: true, entry: e, how: "daily-low" }; // proxy: full-day low, may overstate first-60-min fills
      }
      const f = k.fill[cap];
      if (f.filled && f.entry) {
        const r = scorePut(f.entry, k.day, ob);
        if (r) k.res[cap] = r;
      }
    }
    if (ob.filter((b) => b.date >= k.day).length >= 2) {
      k.done = true; // both sessions closed: scored, or skipped (never traded at/below max price)
      scored += 1;
    }
  }
  return `${scored}/${open.length} candidate(s) scored`;
}

export async function runEarlyPing(now = new Date()) {
  const book = (await loadDoc<EpBook>(KIND, DAY, { fresh: true })) ?? emptyBook();
  const a = await step(book, now).catch((e) => `step error: ${e instanceof Error ? e.message.slice(0, 120) : "failed"}`);
  const b = await score(book, now).catch((e) => `score error: ${e instanceof Error ? e.message.slice(0, 120) : "failed"}`);
  const note = `${a} | ${b}`;
  book.updatedAt = now.toISOString();
  book.runs = [...book.runs, { at: book.updatedAt, note }].slice(-80);
  book.cands = book.cands.slice(-600);
  await saveDoc(KIND, DAY, book);
  return { book, note };
}

export function earlyPingView(book: EpBook) {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const variant = (cap: CapId) => {
    const live = book.cands.filter((k) => !k.heldBack && k.day < tradingDateET(new Date()));
    const rs = live.map((k) => k.res[cap]).filter((r): r is PutResult => !!r).map((r) => r.ret * 100).sort((a, b) => a - b);
    return {
      candidates: live.length, filled: live.filter((k) => k.fill[cap].filled).length, scored: rs.length,
      winPct: rs.length ? r2((100 * rs.filter((x) => x > 0).length) / rs.length) : null,
      meanPct: rs.length ? r2(rs.reduce((s, x) => s + x, 0) / rs.length) : null,
      medianPct: rs.length ? r2(rs[Math.floor(rs.length / 2)]) : null,
    };
  };
  return {
    mode: "test" as const, disclaimer: EP_DISCLAIMER, persistence: persistenceMode(), lane: "early-ping", updatedAt: book.updatedAt,
    p5: variant("p5"), p10: variant("p10"), cands: book.cands.slice(-60), uwCalls: book.uwCalls, runs: book.runs.slice(-10),
  };
}

export async function loadEarlyPing(opts: { force?: boolean; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const c = etClock(now);
  const stored = await loadDoc<EpBook>(KIND, DAY);
  const due = c.weekday && c.minutes >= PING_ET_MIN;
  if (opts.force || (due && (!stored || Date.now() - Date.parse(stored.updatedAt || "0") > 10 * 60_000))) {
    if (opts.force || (await kvSetNx("flowguard/shadow/early-ping-lock", now.toISOString(), 300))) {
      const { book, note } = await runEarlyPing(now);
      return { ...earlyPingView(book), note };
    }
  }
  return earlyPingView(stored ?? emptyBook());
}
