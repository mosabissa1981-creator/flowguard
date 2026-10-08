/**
 * LIVE risk-off morning flag (approved by Mosab 3:19 PM CT 10/8/2026 after study/risk-off-playbook.json).
 * Entry-time only: prior closes + open gaps from Yahoo daily bars (free; no UW). PRIMARY = ≥2 of
 * {oil_shock, yield_shock, qqq_weak} → hold back ETF/index puts on live boards and show a desk banner.
 * Soft (1 signal) is logged but does not block. Missing inputs → "unknown" (never blocks).
 * Computed once after ~9:35 ET (8:35 CT) and cached for the day; before that, provisional.
 */
import { isEtfOrIndex } from "@/lib/puts-rule";
import { sessionHasOpened, tradingDateET } from "@/lib/session";
import { saveDoc } from "@/lib/shadow/store";

/** The ONE switch: when true, PRIMARY risk-off mornings exclude ETF/index puts from live boards. */
export const RISK_OFF_BLOCK_ETF_PUTS = true;

export const RISK_OFF_PUT_REASON = "Skipped: risk-off morning (ETF puts held back)";
export const RISK_OFF_BANNER =
  "Risk-off morning (oil/yields/QQQ): stay light or sit out";

/** ~9:35 ET = 8:35 CT — opens have printed; flag becomes firm for the day. */
const FIRM_AFTER_ET_MINUTES = 9 * 60 + 35;
const UA = "Mozilla/5.0 (compatible; FlowGuard/1.0)";
const CHART = (sym: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10d&interval=1d`;

export type RiskOffLevel = "primary" | "soft" | "none" | "unknown";

export type RiskOffInputs = {
  usoYdayPct: number | null;
  usoGapPct: number | null;
  tnxYdayBp: number | null;
  tltYdayPct: number | null;
  tltGapPct: number | null;
  qqqGapPct: number | null;
  spyGapPct: number | null;
  qqqVsSpyGapPct: number | null;
};

export type RiskOffSnapshot = {
  day: string;
  level: RiskOffLevel;
  provisional: boolean;
  oil: boolean;
  yield: boolean;
  qqqWeak: boolean;
  nSignals: number;
  inputs: RiskOffInputs;
  /** Desk / morning banner when level === "primary"; null otherwise. */
  banner: string | null;
  /** LIVE block of ETF/index puts is active. */
  blockEtfPuts: boolean;
  source: "yahoo" | "unavailable";
  computedAt: string;
  note: string;
};

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

/** Pure evaluator (testable). Uses rounded pct compares like the study. */
export function evaluateRiskOff(inputs: RiskOffInputs, opts: { day: string; provisional: boolean; nowIso?: string } ): RiskOffSnapshot {
  const oil =
    (inputs.usoYdayPct != null && inputs.usoYdayPct >= 2.0) ||
    (inputs.usoGapPct != null && inputs.usoGapPct >= 2.0);
  const yld =
    (inputs.tnxYdayBp != null && inputs.tnxYdayBp >= 5) ||
    (inputs.tltYdayPct != null && inputs.tltYdayPct <= -0.8) ||
    (inputs.tltGapPct != null && inputs.tltGapPct <= -0.5);
  const qqqWeak =
    (inputs.qqqGapPct != null && inputs.qqqGapPct <= -0.5) ||
    (inputs.qqqVsSpyGapPct != null && inputs.qqqVsSpyGapPct <= -0.3);
  const n = Number(oil) + Number(yld) + Number(qqqWeak);
  // Unknown only when we could not score any family (all key inputs null).
  const scorable =
    inputs.usoYdayPct != null ||
    inputs.usoGapPct != null ||
    inputs.tnxYdayBp != null ||
    inputs.tltYdayPct != null ||
    inputs.tltGapPct != null ||
    inputs.qqqGapPct != null;
  const level: RiskOffLevel = !scorable ? "unknown" : n >= 2 ? "primary" : n === 1 ? "soft" : "none";
  const block = RISK_OFF_BLOCK_ETF_PUTS && level === "primary";
  return {
    day: opts.day,
    level,
    provisional: opts.provisional,
    oil,
    yield: yld,
    qqqWeak,
    nSignals: n,
    inputs,
    banner: level === "primary" ? RISK_OFF_BANNER : null,
    blockEtfPuts: block,
    source: scorable ? "yahoo" : "unavailable",
    computedAt: opts.nowIso ?? new Date().toISOString(),
    note:
      level === "unknown"
        ? "Risk-off inputs unavailable — not blocking ETF puts."
        : level === "primary"
          ? opts.provisional
            ? "PRIMARY risk-off (provisional, pre-open) — ETF/index puts held back on live boards."
            : "PRIMARY risk-off — ETF/index puts held back on live boards; stay light or sit out."
          : level === "soft"
            ? "Soft risk-off (1 signal) — logged only, does not block."
            : "Not a risk-off morning by the study rule.",
  };
}

/** True when LIVE risk-off holds back this ETF/index put. Calls and single-stock puts → false (single-stock already blocked elsewhere). */
export function blockedByRiskOffPuts(
  side: string | null | undefined,
  ticker: string | null | undefined,
  issueType: string | null | undefined,
  flag: Pick<RiskOffSnapshot, "blockEtfPuts"> | null | undefined,
): boolean {
  if (!flag?.blockEtfPuts || !RISK_OFF_BLOCK_ETF_PUTS) return false;
  if ((side ?? "").toLowerCase() !== "put") return false;
  return isEtfOrIndex(ticker, issueType);
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
  // day may be today and not yet in the bar list — use last bar as prior
  if (i < 0 && days.length) {
    const last = days[days.length - 1];
    return last < day ? last : days.length >= 2 ? days[days.length - 2] : null;
  }
  return null;
}

function buildInputs(
  day: string,
  bars: Record<string, DayBar[]>,
  provisional: boolean,
): RiskOffInputs {
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

  // Gaps: today's open vs prior close. Before the open (provisional), prefer today's bar if Yahoo
  // already published a premarket/open proxy; else leave gap null and rely on prior-day shocks.
  const gap = (prior: DayBar | undefined, today: DayBar | undefined) =>
    prior && today ? round2(pct(prior.c, today.o)) : null;

  let usoGap = gap(usoP, usoD);
  let tltGap = gap(tltP, tltD);
  let spyGap = gap(spyP, spyD);
  let qqqGap = gap(qqqP, qqqD);
  if (provisional && !usoD && !qqqD) {
    // No today bar yet — gaps unknown; prior-day shocks still count.
    usoGap = null; tltGap = null; spyGap = null; qqqGap = null;
  }
  const qqqVsSpy = qqqGap != null && spyGap != null ? round2(qqqGap - spyGap) : null;

  return {
    usoYdayPct: usoYday,
    usoGapPct: usoGap,
    tnxYdayBp: tnxYdayBp,
    tltYdayPct: tltYday,
    tltGapPct: tltGap,
    qqqGapPct: qqqGap,
    spyGapPct: spyGap,
    qqqVsSpyGapPct: qqqVsSpy,
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
  // Firm cache lasts the whole day once set.
  if (mem && mem.day === day && mem.firm) return mem.value;

  let snap: RiskOffSnapshot;
  try {
    const [USO, TLT, SPY, QQQ, TNX] = await Promise.all([
      fetchDaily("USO"),
      fetchDaily("TLT"),
      fetchDaily("SPY"),
      fetchDaily("QQQ"),
      fetchDaily("^TNX"),
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
  // Study book: log once per day when firm (or once provisional if that's all we have by end of day).
  const logKey = `${day}:${firm ? "firm" : "prov"}`;
  if (!logged.has(logKey)) {
    logged.add(logKey);
    void saveDoc("study", `risk-off-${day}`, snap).catch(() => undefined);
  }
  return snap;
}

/** Load today's risk-off flag (cached). Safe to call on every board build. */
export async function loadRiskOff(opts: { now?: Date; fresh?: boolean } = {}): Promise<RiskOffSnapshot> {
  const now = opts.now ?? new Date();
  if (opts.fresh) mem = null;
  if (inflight) return inflight;
  inflight = compute(now).finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Sync fallback when the async load failed — never blocks. */
export function unknownRiskOff(day = tradingDateET()): RiskOffSnapshot {
  return evaluateRiskOff(
    { usoYdayPct: null, usoGapPct: null, tnxYdayBp: null, tltYdayPct: null, tltGapPct: null, qqqGapPct: null, spyGapPct: null, qqqVsSpyGapPct: null },
    { day, provisional: true },
  );
}
