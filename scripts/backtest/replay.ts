/**
 * Replays the CURRENT live rules (lanes, puts, lottery, picks, premove) on a past session:
 * fake clock at intraday checkpoints + a fetch shim that serves UW/Yahoo from the on-box history.
 * No notifications/LLM: those hosts are refused and the wrapper strips their env vars.
 */
import type { FlowAlert } from "@/lib/types";

import { BudgetStop, rawFetch } from "./uw-budget";
import { addDays, barsBetween, earningsFor, etMs, type TideRow } from "./store";

// ---------------------------------------------------------------------------
// Fake clock (only `new Date()` / Date.now() are shifted; explicit dates are untouched)
// ---------------------------------------------------------------------------
const RealDate = Date;
let fakeMs: number | null = null;
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0 && fakeMs != null) super(fakeMs);
    // @ts-expect-error variadic Date ctor
    else super(...args);
  }
  static now() {
    return fakeMs ?? RealDate.now();
  }
}
globalThis.Date = FakeDate as unknown as DateConstructor;
export const setClock = (ms: number | null) => {
  fakeMs = ms;
};

// ---------------------------------------------------------------------------
// Replay context + fetch shim
// ---------------------------------------------------------------------------
type Ctx = { day: string; alerts: FlowAlert[]; visible: FlowAlert[]; tide: TideRow[] };
let ctx: Ctx | null = null;
export const unhandled = new Map<string, number>();

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

function lastUnderlying(ticker: string): number | null {
  for (const a of ctx?.visible ?? []) if (a.ticker === ticker && Number(a.underlying_price) > 0) return Number(a.underlying_price);
  return null;
}

async function yahoo(url: URL): Promise<Response> {
  const sym = decodeURIComponent(url.pathname.split("/").pop() || "");
  if (!ctx || sym.startsWith("^") || url.searchParams.get("range") !== "3mo") return json({ chart: { result: null } }, 404);
  const prior = (await barsBetween(sym, addDays(ctx.day, -110), addDays(ctx.day, -1))).slice(-70);
  if (!prior.length) return json({ chart: { result: null } }, 404);
  const px = lastUnderlying(sym) ?? prior[prior.length - 1].c;
  const bars = [...prior.map((b) => ({ t: Math.floor(etMs(b.date, 9, 30) / 1000), c: b.c, h: b.h, l: b.l })), { t: Math.floor(etMs(ctx.day, 9, 30) / 1000), c: px, h: px, l: px }];
  return json({
    chart: {
      result: [{ meta: { regularMarketPrice: px }, timestamp: bars.map((b) => b.t), indicators: { quote: [{ close: bars.map((b) => b.c), high: bars.map((b) => b.h), low: bars.map((b) => b.l) }] } }],
    },
  });
}

async function uw(url: URL): Promise<Response> {
  const path = url.pathname;
  const now = Date.now();
  if (path === "/api/option-trades/flow-alerts") {
    const older = Number(url.searchParams.get("older_than") || 0) * 1000 || Infinity;
    const newer = Number(url.searchParams.get("newer_than") || 0) * 1000;
    const limit = Math.min(200, Number(url.searchParams.get("limit") || 200));
    const rows = (ctx?.visible ?? []).filter((a) => {
      const ms = Date.parse(a.created_at);
      return ms < older && ms > newer;
    });
    return json({ data: rows.slice(0, limit) });
  }
  if (path === "/api/market/market-tide") {
    return json({ data: (ctx?.tide ?? []).filter((r) => Date.parse(r.timestamp) <= now) });
  }
  const info = /^\/api\/stock\/([^/]+)\/info$/.exec(path);
  if (info && ctx) {
    const t = decodeURIComponent(info[1]);
    const e = (await earningsFor(t)).filter((r) => r.date >= ctx!.day).sort((a, b) => a.date.localeCompare(b.date))[0];
    return json({ data: { symbol: t, next_earnings_date: e?.date ?? null, announce_time: e?.time ?? null, sector: null, beta: null } });
  }
  const earn = /^\/api\/earnings\/([^/]+)$/.exec(path);
  if (earn && ctx) {
    // As-of view: the next scheduled report plus past reports (no post-report data leaks into the replay).
    const rows = await earningsFor(decodeURIComponent(earn[1]));
    const next = rows.filter((r) => r.date >= ctx!.day).sort((a, b) => a.date.localeCompare(b.date))[0];
    const past = rows.filter((r) => r.date < ctx!.day).sort((a, b) => b.date.localeCompare(a.date));
    return json({ data: [...(next ? [next] : []), ...past].map((r) => ({ report_date: r.date, report_time: r.time, source: "history" })) });
  }
  const st = /^\/api\/stock\/([^/]+)\/stock-state$/.exec(path);
  if (st && ctx) {
    const t = decodeURIComponent(st[1]);
    const prior = await barsBetween(t, addDays(ctx.day, -10), addDays(ctx.day, -1));
    const prev = prior[prior.length - 1]?.c ?? null;
    return json({ data: { close: lastUnderlying(t) ?? prev, prev_close: prev } });
  }
  const k = path.replace(/^(\/api\/[a-z-]+\/)[^/]+/, "$1{T}");
  unhandled.set(k, (unhandled.get(k) ?? 0) + 1);
  return json({ data: [] });
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "api.unusualwhales.com") return uw(url);
  if (url.hostname === "query1.finance.yahoo.com") return yahoo(url);
  if (!ctx) return rawFetch(input, init);
  // Calendar / treasury / LLM / Telegram / Vercel: never reached from a replay.
  unhandled.set(url.hostname, (unhandled.get(url.hostname) ?? 0) + 1);
  return new Response("replay: offline", { status: 503 });
}) as typeof fetch;

// ---------------------------------------------------------------------------
// One day
// ---------------------------------------------------------------------------
export const CHECKPOINTS: [number, number][] = [[10, 0], [10, 30], [11, 0], [12, 0], [13, 0], [13, 55], [15, 45]];
const PICKS_AT = "13:55";
const PREMOVE_AT = "15:45";

import type { ReplayDay, ReplayEntry } from "./replay-types";
export type { ReplayDay, ReplayEntry };

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);

export async function replayDay(day: string, alerts: FlowAlert[], tide: TideRow[]): Promise<ReplayDay> {
  const t0 = RealDate.now();
  const [{ primeSessionTape }, lanes, puts, lottery, picks, premove] = await Promise.all([
    import("@/lib/session-tape"),
    import("@/lib/lanes"),
    import("@/lib/puts"),
    import("@/lib/lottery"),
    import("@/lib/picks"),
    import("@/lib/premove"),
  ]);
  ctx = { day, alerts, visible: [], tide };
  unhandled.clear();
  const entries: ReplayEntry[] = [];
  const seen = new Set<string>();
  const push = (e: ReplayEntry) => {
    const k = `${e.lane}|${e.kind}|${e.contract}`;
    if (seen.has(k) || !(e.entry > 0)) return;
    seen.add(k);
    entries.push(e);
  };
  const sideOf = (c: string): "call" | "put" => (/\d{6}P\d{8}$/.test(c) ? "put" : "call");
  let lastLanes: Awaited<ReturnType<typeof lanes.loadLanes>> | null = null;
  let lastPuts: Awaited<ReturnType<typeof puts.loadPuts>> | null = null;
  let lastLottery: Awaited<ReturnType<typeof lottery.loadLottery>> | null = null;
  try {
    for (const [hh, mm] of CHECKPOINTS) {
      const now = etMs(day, hh, mm);
      setClock(now);
      ctx.visible = alerts.filter((a) => Date.parse(a.created_at) <= now); // newest first already
      primeSessionTape(ctx.visible, new Date(now));
      const label = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
      lastLanes = await lanes.loadLanes().catch((e) => (console.error(`[replay ${day} ${label}] lanes`, e?.message), lastLanes));
      lastPuts = await puts.loadPuts().catch((e) => (console.error(`[replay ${day} ${label}] puts`, e?.message), lastPuts));
      lastLottery = await lottery.loadLottery({ fresh: true }).catch((e) => (console.error(`[replay ${day} ${label}] lottery`, e?.message), lastLottery));
      if (label === PICKS_AT) {
        const r = await picks.loadDailyPicks({ forceFresh: true }).catch(() => null);
        for (const pk of (r?.picks ?? []).slice(0, 3)) {
          const a = pk.alert;
          push({
            lane: "picks", kind: "logged", contract: a.option_chain, ticker: a.ticker, side: a.type === "put" ? "put" : "call", expiry: a.expiry, day,
            entry: Number(a.price), printTimeUtc: a.created_at, underlying: num(a.underlying_price), timeStopSessions: 3,
            features: { score: pk.score, dte: pk.dte, askShare: pk.askShare, marketTide: pk.marketTideBias, tickerTide: pk.tickerTideBias, fadeProne: pk.fadeProne, premium: num(a.total_premium), volOi: num(a.volume_oi_ratio), sweep: Boolean(a.has_sweep) },
          });
        }
        // Candidate pools for the ML dataset: top 5 per lane at the picks checkpoint.
        for (const l of lastLanes?.lanes ?? []) for (const c of l.candidates.slice(0, 5)) push({ lane: `cand:${l.lane.id}`, kind: "candidate", contract: c.contract, ticker: c.ticker, side: c.side, expiry: c.expiry, day, entry: c.price, printTimeUtc: c.printTimeUtc, underlying: c.underlying, timeStopSessions: c.exitPlan.timeStopSessions, features: { laneScore: c.laneScore, flowScore: c.flowScore, dte: c.dte, otmPct: c.otmPct, askSharePct: c.askSharePct, volOi: c.volOi, premium: c.premiumUsd, tickerTide: c.tickerTide, marketTide: c.marketTide, sweep: c.sweep } });
        for (const c of (lastPuts?.candidates ?? []).slice(0, 5)) push({ lane: "cand:puts", kind: "candidate", contract: c.contract, ticker: c.ticker, side: "put", expiry: c.expiry, day, entry: c.price, printTimeUtc: c.printTimeUtc, underlying: c.underlying, timeStopSessions: c.exitPlan.timeStopSessions, features: { putsScore: c.putsScore, flowScore: c.flowScore, dte: c.dte, moneynessPct: c.moneynessPct, askSharePct: c.askSharePct, volOi: c.volOi, premium: c.premiumUsd, tickerTide: c.tickerTide, marketTide: c.marketTide, confirmations: c.confirmations.length } });
      }
      if (label === PREMOVE_AT) {
        const r = await premove.loadPremoveShortlist({ forceFresh: true }).catch(() => null);
        for (const pk of (r?.picks ?? []).slice(0, 3)) {
          const a = pk.alert;
          push({
            lane: "premove", kind: "logged", contract: a.option_chain, ticker: a.ticker, side: a.type === "put" ? "put" : "call", expiry: a.expiry, day,
            entry: Number(a.price), printTimeUtc: a.created_at, underlying: num(a.underlying_price), timeStopSessions: 3,
            features: { score: pk.score, dte: pk.dte, askShare: pk.askShare, marketTide: pk.marketTideBias, tickerTide: pk.tickerTideBias, fadeProne: pk.fadeProne, premium: num(a.total_premium), volOi: num(a.volume_oi_ratio), sweep: Boolean(a.has_sweep) },
          });
        }
      }
    }
  } catch (e) {
    if (e instanceof BudgetStop || (e as Error)?.name === "BudgetStop") throw e;
    throw e;
  } finally {
    setClock(null);
  }
  // Logged books (frozen, earliest qualifying print) as of the end of the day.
  for (const l of lastLanes?.lanes ?? []) for (const e of l.picks) push({ lane: l.lane.id, kind: "logged", contract: e.contract, ticker: e.ticker, side: e.side, expiry: e.expiry, day, entry: e.entry, printTimeUtc: e.printTimeUtc, underlying: e.underlying, timeStopSessions: e.exitPlan.timeStopSessions, features: { laneScore: e.laneScore, flowScore: e.flowScore, dte: e.dte, otmPct: e.otmPct, askSharePct: e.askSharePct, volOi: e.volOi, premium: e.premiumUsd, tickerTide: e.tickerTide, marketTide: e.marketTide, sweep: e.sweep, regime: e.regimeLabel } });
  for (const e of lastPuts?.picks ?? []) push({ lane: "puts", kind: "logged", contract: e.contract, ticker: e.ticker, side: "put", expiry: e.expiry, day, entry: e.entry, printTimeUtc: e.printTimeUtc, underlying: e.underlying, timeStopSessions: e.exitPlan.timeStopSessions, features: { putsScore: e.putsScore, flowScore: e.flowScore, dte: e.dte, moneynessPct: e.moneynessPct, askSharePct: e.askSharePct, volOi: e.volOi, premium: e.premiumUsd, tickerTide: e.tickerTide, marketTide: e.marketTide, confirmations: e.confirmations.length } });
  for (const e of lastLottery?.picks ?? []) push({ lane: "lottery", kind: "logged", contract: e.contract, ticker: e.ticker, side: e.side ?? sideOf(e.contract), expiry: e.expiry, day, entry: e.entry, printTimeUtc: e.printTimeUtc ?? null, underlying: e.underlying, timeStopSessions: 0, features: { lotteryScore: e.lotteryScore, flowScore: e.flowScore, dte: e.dte, otmPct: e.otmPct, askSharePct: e.askSharePct, volOi: e.volOi, premium: e.premiumUsd, catalyst: e.catalyst?.kind ?? null } });
  ctx = null;
  return { v: 1, day, prints: alerts.length, entries, unhandled: Object.fromEntries(unhandled), ms: RealDate.now() - t0 };
}
