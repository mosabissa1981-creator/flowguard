/**
 * LIVE risk-off morning flag (approved by Mosab 3:19 PM CT 10/8/2026).
 * Pure helpers: lib/risk-off-core.ts (safe for client). This file: Yahoo fetch + day cache + study log.
 */
import "server-only";

import {
  evaluateRiskOff,
  type RiskOffInputs,
  type RiskOffSnapshot,
} from "@/lib/risk-off-core";
import { sessionHasOpened, tradingDateET } from "@/lib/session";

export {
  RISK_OFF_BANNER,
  RISK_OFF_BLOCK_ETF_PUTS,
  RISK_OFF_PUT_REASON,
  blockedByRiskOffPuts,
  evaluateRiskOff,
  type RiskOffInputs,
  type RiskOffLevel,
  type RiskOffSnapshot,
} from "@/lib/risk-off-core";

/** ~9:35 ET = 8:35 CT — opens have printed; flag becomes firm for the day. */
const FIRM_AFTER_ET_MINUTES = 9 * 60 + 35;
const UA = "Mozilla/5.0 (compatible; FlowGuard/1.0)";
const CHART = (sym: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10d&interval=1d`;

type DayBar = { date: string; o: number; h: number; l: number; c: number };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function pct(a: number, b: number): number {
  return ((b - a) / a) * 100;
}

function etMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export function isRiskOffFirm(now = new Date()): boolean {
  return sessionHasOpened(now) && etMinutes(now) >= FIRM_AFTER_ET_MINUTES;
}

async function fetchDaily(sym: string): Promise<DayBar[]> {
  const res = await fetch(CHART(sym), {
    headers: { "User-Agent": UA, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const j = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[] }> };
      }>;
    };
  };
  const r = j.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0] ?? {};
  const out: DayBar[] = [];
  for (let i = 0; i < ts.length; i += 1) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (o == null || h == null || l == null || c == null || !(c > 0) || !(o > 0)) continue;
    out.push({ date: tradingDateET(new Date(ts[i] * 1000)), o, h, l, c });
  }
  return out;
}

function byDate(bars: DayBar[]): Map<string, DayBar> {
  return new Map(bars.map((b) => [b.date, b]));
}

function priorDate(day: string, days: string[]): string | null {
  const i = days.indexOf(day);
  if (i > 0) return days[i - 1];
  if (i < 0 && days.length) {
    const last = days[days.length - 1];
    return last < day ? last : days.length >= 2 ? days[days.length - 2] : null;
  }
  return null;
}

function buildInputs(day: string, bars: Record<string, DayBar[]>, provisional: boolean): RiskOffInputs {
  const empty: RiskOffInputs = {
    usoYdayPct: null, usoGapPct: null, tnxYdayBp: null, tltYdayPct: null, tltGapPct: null,
    qqqGapPct: null, spyGapPct: null, qqqVsSpyGapPct: null,
  };
  const uso = byDate(bars.USO ?? []);
  const tlt = byDate(bars.TLT ?? []);
  const spy = byDate(bars.SPY ?? []);
  const qqq = byDate(bars.QQQ ?? []);
  const tnx = byDate(bars.TNX ?? []);
  const days = [...new Set([...(bars.SPY ?? []).map((b) => b.date), ...(bars.USO ?? []).map((b) => b.date)])].sort();
  const p = priorDate(day, days);
  if (!p) return empty;
  const pp = priorDate(p, days);
  const usoP = uso.get(p);
  const usoD = uso.get(day);
  const tltP = tlt.get(p);
  const tltD = tlt.get(day);
  const spyP = spy.get(p);
  const spyD = spy.get(day);
  const qqqP = qqq.get(p);
  const qqqD = qqq.get(day);
  const tnxP = tnx.get(p);
  const tnxPP = pp ? tnx.get(pp) : null;
  const usoPP = pp ? uso.get(pp) : null;
  const tltPP = pp ? tlt.get(pp) : null;

  const usoYday = usoPP && usoP ? round2(pct(usoPP.c, usoP.c)) : null;
  const tltYday = tltPP && tltP ? round2(pct(tltPP.c, tltP.c)) : null;
  const tnxYdayBp = tnxPP && tnxP ? round1((tnxP.c - tnxPP.c) * 100) : null;
  const gap = (prior: DayBar | undefined, today: DayBar | undefined) =>
    prior && today ? round2(pct(prior.c, today.o)) : null;

  let usoGap = gap(usoP, usoD);
  let tltGap = gap(tltP, tltD);
  let spyGap = gap(spyP, spyD);
  let qqqGap = gap(qqqP, qqqD);
  if (provisional && !usoD && !qqqD) {
    usoGap = null; tltGap = null; spyGap = null; qqqGap = null;
  }
  const qqqVsSpy = qqqGap != null && spyGap != null ? round2(qqqGap - spyGap) : null;

  return {
    usoYdayPct: usoYday, usoGapPct: usoGap, tnxYdayBp: tnxYdayBp, tltYdayPct: tltYday, tltGapPct: tltGap,
    qqqGapPct: qqqGap, spyGapPct: spyGap, qqqVsSpyGapPct: qqqVsSpy,
  };
}

type Cache = { day: string; firm: boolean; at: number; value: RiskOffSnapshot };
let mem: Cache | null = null;
let inflight: Promise<RiskOffSnapshot> | null = null;
const logged = new Set<string>();

async function compute(now: Date): Promise<RiskOffSnapshot> {
  const day = tradingDateET(now);
  const firm = isRiskOffFirm(now);
  if (mem && mem.day === day && mem.firm === firm && (firm || Date.now() - mem.at < 5 * 60_000)) return mem.value;
  if (mem && mem.day === day && mem.firm) return mem.value;

  let snap: RiskOffSnapshot;
  try {
    const [USO, TLT, SPY, QQQ, TNX] = await Promise.all([
      fetchDaily("USO"), fetchDaily("TLT"), fetchDaily("SPY"), fetchDaily("QQQ"), fetchDaily("^TNX"),
    ]);
    const inputs = buildInputs(day, { USO, TLT, SPY, QQQ, TNX }, !firm);
    snap = evaluateRiskOff(inputs, { day, provisional: !firm, nowIso: now.toISOString() });
  } catch {
    snap = evaluateRiskOff(
      { usoYdayPct: null, usoGapPct: null, tnxYdayBp: null, tltYdayPct: null, tltGapPct: null, qqqGapPct: null, spyGapPct: null, qqqVsSpyGapPct: null },
      { day, provisional: !firm, nowIso: now.toISOString() },
    );
  }

  mem = { day, firm, at: Date.now(), value: snap };
  const logKey = `${day}:${firm ? "firm" : "prov"}`;
  if (!logged.has(logKey)) {
    logged.add(logKey);
    void import("@/lib/shadow/store")
      .then(({ saveDoc }) => saveDoc("study", `risk-off-${day}`, snap))
      .catch(() => undefined);
  }
  return snap;
}

/** Load today's risk-off flag (cached). Safe to call on every board build. */
export async function loadRiskOff(opts: { now?: Date; fresh?: boolean } = {}): Promise<RiskOffSnapshot> {
  const now = opts.now ?? new Date();
  if (opts.fresh) mem = null;
  if (inflight) return inflight;
  inflight = compute(now).finally(() => { inflight = null; });
  return inflight;
}

/** Sync fallback when the async load failed — never blocks. */
export function unknownRiskOff(day = tradingDateET()): RiskOffSnapshot {
  return evaluateRiskOff(
    { usoYdayPct: null, usoGapPct: null, tnxYdayBp: null, tltYdayPct: null, tltGapPct: null, qqqGapPct: null, spyGapPct: null, qqqVsSpyGapPct: null },
    { day, provisional: true },
  );
}
