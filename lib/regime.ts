import "server-only";

import type { ActionableRegime } from "@/lib/scoring";
import { DEFAULT_CAPS, type ConcentrationCaps } from "@/lib/issuers";
import type { EconEvent, RegimeBrief, RegimeLabel, RegimeRules, RegimeSnapshot, TideSnapshot, YieldMove } from "@/lib/types";
import { fetchEconomicCalendar, fetchMarketTide, hasUnusualWhalesKey } from "@/lib/uw";
import { getFreshTape, isUwBlocked } from "@/lib/uw-quota";
import { tradingDateET } from "@/lib/session";

/**
 * Macro regime: economic calendar + long-yield move + UW market tide.
 * Free sources only. Calendar is fetched once per ET trading date; yields every 15 min.
 * UW: re-uses the shared session-tape tide when fresh, else one cached market-tide call
 * (same 12-min cache key the board already uses). Never adds a new UW endpoint.
 */

const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const YAHOO_URL = (symbol: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
const TREASURY_URL = (year: number) =>
  `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`;

const UA = "Mozilla/5.0 (compatible; FlowGuard/1.0; +https://flowguard-zeta.vercel.app)";
const YIELD_TTL_MS = 15 * 60_000;
const REGIME_TTL_MS = 5 * 60_000;

/** Yields rising: either long tenor up at least this many bp vs prior close. */
export const YIELDS_RISING_BP = 3;
/** Yields jump on its own makes the day risky. */
const YIELDS_RISKY_BP = 5;
const YIELDS_ABS_RISKY_BP = 8;

const KEY_EVENT = /FOMC|Federal Funds|Fed Chair|Powell|CPI|PPI|Non-Farm|Nonfarm|PCE|GDP|Retail Sales|Unemployment Rate|ISM|JOLTS|Treasury.*Auction|Payroll/i;

type Cached<T> = { at: number; key: string; value: T };
let calendarMem: Cached<EconEvent[] | null> | null = null;
let calendarSource: "forexfactory" | "uw" | "unavailable" = "unavailable";

const UW_HIGH = /\bCPI\b|Consumer Price|\bPPI\b|Producer Price|\bPCE\b|\bGDP\b|Employment Report|Non-?farm|Unemployment Rate|FOMC|Federal Funds|Rate Decision|Retail Sales|Powell/i;
const UW_MEDIUM = /ISM|JOLTS|Jobless Claims|Consumer Confidence|Michigan|ADP|Fed speech|speaks|Treasury.*Auction|Durable/i;

async function fetchUwCalendar(): Promise<EconEvent[] | null> {
  if (!(await hasUnusualWhalesKey()) || (await isUwBlocked())) return null;
  const rows = await fetchEconomicCalendar();
  return rows.map((row) => ({
    title: row.event,
    country: "USD",
    date: row.time,
    impact:
      UW_HIGH.test(row.event) && !/speech|speaks|ADP/i.test(row.event)
        ? "High"
        : UW_MEDIUM.test(row.event)
          ? "Medium"
          : "Low",
    forecast: row.forecast ?? "",
    previous: row.prev ?? "",
  }));
}
let yieldMem: Cached<{ us10y: YieldMove; us30y: YieldMove; source: "yahoo" | "treasury" | "unavailable" }> | null = null;
let regimeMem: Cached<RegimeSnapshot> | null = null;
let regimeInflight: Promise<RegimeSnapshot> | null = null;

function emptyYield(symbol: YieldMove["symbol"]): YieldMove {
  return { symbol, last: null, prevClose: null, changeBp: null, asOf: null, source: "none" };
}

function etDateOf(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return tradingDateET(d);
}

async function fetchCalendar(today: string): Promise<EconEvent[] | null> {
  if (calendarMem && calendarMem.key === today) return calendarMem.value;
  if (calendarMem && calendarMem.key === `fail-${today}` && Date.now() - calendarMem.at < 30 * 60_000) {
    return null;
  }
  try {
    // Date-keyed URL + persistent fetch cache => one upstream hit per ET day per region.
    const response = await fetch(`${CALENDAR_URL}?d=${today}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      cache: "force-cache",
      next: { revalidate: 86_400 },
    });
    if (!response.ok) throw new Error(`calendar ${response.status}`);
    const raw = (await response.json()) as Array<Record<string, unknown>>;
    const events: EconEvent[] = raw
      .filter((row) => String(row.country ?? "") === "USD")
      .map((row) => ({
        title: String(row.title ?? ""),
        country: "USD",
        date: String(row.date ?? ""),
        impact: String(row.impact ?? ""),
        forecast: String(row.forecast ?? ""),
        previous: String(row.previous ?? ""),
      }));
    calendarMem = { at: Date.now(), key: today, value: events };
    calendarSource = "forexfactory";
    return events;
  } catch {
    // Forex Factory rate-limits shared IPs. Fall back to UW's calendar (24h cache).
    try {
      const uw = await fetchUwCalendar();
      if (uw && uw.length > 0) {
        calendarMem = { at: Date.now(), key: today, value: uw };
        calendarSource = "uw";
        return uw;
      }
    } catch {
      // fall through
    }
    // Do not cache failures for the whole day — retry in 30 min.
    if (calendarMem?.value && Date.now() - calendarMem.at < 30 * 60_000) return calendarMem.value;
    calendarMem = { at: Date.now(), key: `fail-${today}`, value: null };
    return null;
  }
}

async function fetchYahooYield(symbol: "^TNX" | "^TYX", label: YieldMove["symbol"]): Promise<YieldMove | null> {
  const response = await fetch(YAHOO_URL(symbol), {
    headers: { "User-Agent": UA, Accept: "application/json" },
    cache: "force-cache",
    next: { revalidate: YIELD_TTL_MS / 1000 },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    chart?: { result?: Array<{ meta?: Record<string, unknown> }> };
  };
  const meta = payload.chart?.result?.[0]?.meta ?? {};
  const last = Number(meta.regularMarketPrice);
  const prev = Number(meta.chartPreviousClose ?? meta.previousClose);
  if (!(last > 0) || !(prev > 0)) return null;
  const t = Number(meta.regularMarketTime);
  return {
    symbol: label,
    last: Math.round(last * 1000) / 1000,
    prevClose: Math.round(prev * 1000) / 1000,
    changeBp: Math.round((last - prev) * 1000) / 10,
    asOf: Number.isFinite(t) ? new Date(t * 1000).toISOString() : null,
    source: "yahoo",
  };
}

async function fetchTreasuryYields(): Promise<{ us10y: YieldMove; us30y: YieldMove } | null> {
  const year = Number(tradingDateET().slice(0, 4));
  const response = await fetch(TREASURY_URL(year), {
    headers: { "User-Agent": UA },
    cache: "force-cache",
    next: { revalidate: 3600 },
  });
  if (!response.ok) return null;
  const text = await response.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 3) return null;
  const header = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
  const i10 = header.indexOf("10 Yr");
  const i30 = header.indexOf("30 Yr");
  if (i10 < 0 || i30 < 0) return null;
  const [a, b] = [lines[1].split(","), lines[2].split(",")];
  const [mm, dd, yyyy] = a[0].split("/");
  const asOf = `${yyyy}-${mm}-${dd}`;
  const mk = (symbol: YieldMove["symbol"], idx: number): YieldMove => {
    const last = Number(a[idx]);
    const prev = Number(b[idx]);
    return {
      symbol,
      last: Number.isFinite(last) ? last : null,
      prevClose: Number.isFinite(prev) ? prev : null,
      changeBp: Number.isFinite(last) && Number.isFinite(prev) ? Math.round((last - prev) * 1000) / 10 : null,
      asOf,
      source: "treasury",
    };
  };
  return { us10y: mk("US10Y", i10), us30y: mk("US30Y", i30) };
}

async function fetchYields() {
  if (yieldMem && Date.now() - yieldMem.at < YIELD_TTL_MS) return yieldMem.value;
  let value: { us10y: YieldMove; us30y: YieldMove; source: "yahoo" | "treasury" | "unavailable" } = {
    us10y: emptyYield("US10Y"),
    us30y: emptyYield("US30Y"),
    source: "unavailable",
  };
  try {
    const [y10, y30] = await Promise.all([
      fetchYahooYield("^TNX", "US10Y").catch(() => null),
      fetchYahooYield("^TYX", "US30Y").catch(() => null),
    ]);
    if (y10 && y30) {
      value = { us10y: y10, us30y: y30, source: "yahoo" };
    } else {
      const tsy = await fetchTreasuryYields().catch(() => null);
      if (tsy) value = { ...tsy, source: "treasury" };
    }
  } catch {
    // fall through to unavailable
  }
  yieldMem = { at: Date.now(), key: "y", value };
  return value;
}

async function resolveTide(passed?: TideSnapshot | null): Promise<{
  tide: TideSnapshot | null;
  source: RegimeSnapshot["sources"]["tide"];
}> {
  if (passed) return { tide: passed, source: "uw-cache" };
  try {
    const fresh = await getFreshTape();
    if (fresh?.tide) return { tide: fresh.tide, source: "uw-cache" };
    if (!(await hasUnusualWhalesKey()) || (await isUwBlocked())) return { tide: null, source: "unavailable" };
    // Same URL + 12-min TTL as the board's tide pull, so this dedupes with flow-service.
    const tide = await fetchMarketTide(false);
    return { tide, source: tide ? "uw" : "unavailable" };
  } catch {
    return { tide: null, source: "unavailable" };
  }
}

export function rulesFor(label: RegimeLabel, yieldsRising: boolean): RegimeRules {
  if (label === "calm") {
    return { active: false, maxShortlist: 8, minDte: 0, rateTechPenalty: yieldsRising ? -6 : 0 };
  }
  return { active: true, maxShortlist: 3, minDte: 14, rateTechPenalty: yieldsRising ? -15 : 0 };
}

export function classifyRegime(input: {
  today: string;
  events: EconEvent[] | null;
  us10y: YieldMove;
  us30y: YieldMove;
  tide: TideSnapshot | null;
}): { label: RegimeLabel; reasons: string[]; todayEvents: EconEvent[]; upcoming: EconEvent[]; rising: boolean } {
  const reasons: string[] = [];
  const seen = new Set<string>();
  const events = (input.events ?? [])
    .filter((e) => {
      const k = `${e.title}|${e.date}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const isKey = (e: EconEvent) => e.impact === "High" || (e.impact === "Medium" && KEY_EVENT.test(e.title) && !/Speaks/i.test(e.title));
  const todayEvents = events.filter((e) => etDateOf(e.date) === input.today && (isKey(e) || e.impact === "Medium"));
  const todayHigh = todayEvents.filter(
    (e) => !/Speaks|speech/i.test(e.title) && (e.impact === "High" || /FOMC Statement|Federal Funds|Rate Decision/i.test(e.title)),
  );
  const upcoming = events
    .filter((e) => etDateOf(e.date) > input.today && e.impact === "High")
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 6);

  const d10 = input.us10y.changeBp ?? 0;
  const d30 = input.us30y.changeBp ?? 0;
  const up = Math.max(d10, d30);
  const absMax = Math.max(Math.abs(d10), Math.abs(d30));
  const rising = up >= YIELDS_RISING_BP;

  let label: RegimeLabel = "calm";
  if (todayHigh.length > 0) {
    label = "report-day";
    reasons.push(`US high-impact report today: ${todayHigh.map((e) => e.title).slice(0, 4).join(", ")}.`);
  }

  if (up >= YIELDS_RISKY_BP || absMax >= YIELDS_ABS_RISKY_BP) {
    if (label === "calm") label = "risky";
    reasons.push(`Long yields moving hard: 10Y ${fmtBp(d10)}, 30Y ${fmtBp(d30)} vs prior close.`);
  } else if (rising) {
    reasons.push(`Long yields rising: 10Y ${fmtBp(d10)}, 30Y ${fmtBp(d30)}.`);
  }

  const nextHigh = upcoming[0];
  const nextDay = nextHigh ? etDateOf(nextHigh.date) : "";
  const daysAhead = nextDay ? (Date.parse(`${nextDay}T12:00:00Z`) - Date.parse(`${input.today}T12:00:00Z`)) / 86_400_000 : 99;
  if (nextHigh && daysAhead <= 2 && rising) {
    if (label === "calm") label = "risky";
    reasons.push(`Yields rising into ${nextHigh.title} (${nextDay}). Pre-report positioning risk.`);
  }

  if (input.tide?.bias === "bearish" && rising) {
    if (label === "calm") label = "risky";
    reasons.push("Bearish UW market tide with rising yields.");
  }

  if (input.events == null) reasons.push("Economic calendar unavailable — regime uses yields + tide only.");
  if (input.us10y.changeBp == null && input.us30y.changeBp == null) reasons.push("Yield feed unavailable.");
  if (label === "calm" && reasons.length === 0) reasons.push("No US high-impact report today and long yields steady.");

  return { label, reasons, todayEvents, upcoming, rising };
}

function fmtBp(bp: number): string {
  return `${bp >= 0 ? "+" : ""}${bp.toFixed(1)}bp`;
}

async function computeRegime(passedTide?: TideSnapshot | null): Promise<RegimeSnapshot> {
  const today = tradingDateET();
  const [events, yields, tideRes] = await Promise.all([fetchCalendar(today), fetchYields(), resolveTide(passedTide)]);
  const c = classifyRegime({ today, events, us10y: yields.us10y, us30y: yields.us30y, tide: tideRes.tide });
  const warnings: string[] = [];
  if (!events) warnings.push("Calendar sources (Forex Factory weekly JSON, UW economic-calendar) unavailable.");
  if (yields.source === "unavailable") warnings.push("Yahoo and Treasury yield feeds unavailable.");
  if (yields.source === "treasury") warnings.push("Yahoo yields unavailable — using Treasury daily close (lags intraday).");
  return {
    label: c.label,
    tradingDate: today,
    fetchedAt: new Date().toISOString(),
    reasons: c.reasons,
    rules: rulesFor(c.label, c.rising),
    events: { today: c.todayEvents, upcoming: c.upcoming },
    yields: { us10y: yields.us10y, us30y: yields.us30y, rising: c.rising },
    tide: tideRes.tide,
    sources: {
      calendar: events ? calendarSource : "unavailable",
      yields: yields.source,
      tide: tideRes.source,
    },
    warnings,
  };
}

/** Cached 5 min in memory; inner sources have their own longer caches. */
export async function loadRegime(opts?: { tide?: TideSnapshot | null; fresh?: boolean }): Promise<RegimeSnapshot> {
  const today = tradingDateET();
  if (!opts?.fresh && regimeMem && regimeMem.key === today && Date.now() - regimeMem.at < REGIME_TTL_MS) {
    if (opts?.tide && !regimeMem.value.tide) {
      // cheap upgrade: re-classify with the passed tide, no network
      const v = regimeMem.value;
      const c = classifyRegime({ today, events: calendarMem?.value ?? null, us10y: v.yields.us10y, us30y: v.yields.us30y, tide: opts.tide });
      return { ...v, label: c.label, reasons: c.reasons, rules: rulesFor(c.label, c.rising), tide: opts.tide, sources: { ...v.sources, tide: "uw-cache" } };
    }
    return regimeMem.value;
  }
  if (regimeInflight) return regimeInflight;
  regimeInflight = computeRegime(opts?.tide)
    .then((value) => {
      regimeMem = { at: Date.now(), key: today, value };
      return value;
    })
    .finally(() => {
      regimeInflight = null;
    });
  return regimeInflight;
}

/** Safe wrapper for list builders — a regime failure must never empty a lane. */
export async function loadRegimeSafe(tide?: TideSnapshot | null): Promise<RegimeSnapshot | null> {
  try {
    return await loadRegime({ tide });
  } catch {
    return null;
  }
}

export function toActionableRegime(regime: RegimeSnapshot | null): ActionableRegime | null {
  if (!regime) return null;
  return {
    label: regime.label,
    minDte: regime.rules.minDte,
    rateTechPenalty: regime.rules.rateTechPenalty,
    yieldsRising: regime.yields.rising,
  };
}

export function regimeBrief(regime: RegimeSnapshot | null): RegimeBrief | null {
  if (!regime) return null;
  return { label: regime.label, reasons: regime.reasons, rules: regime.rules };
}

/** List length for an actionable lane under the current regime. */
export function regimeListCap(regime: RegimeSnapshot | null, normal: number): number {
  if (regime?.rules.active) return Math.min(normal, regime.rules.maxShortlist);
  return normal;
}

/**
 * Calm: 2 per issuer (GOOG+GOOGL = one), 3 per sector.
 * Risky / report-day: the list is only 3 long, so 1 per issuer and 2 per sector —
 * Sep 30 GOOG/GOOGL and the earlier APP double-loss were one correlated bet.
 */
export function regimeCaps(regime: RegimeSnapshot | null): ConcentrationCaps {
  if (regime?.rules.active) return { maxPerIssuer: 1, maxPerSector: 2 };
  return DEFAULT_CAPS;
}
