import "server-only";

import type { ActionableRegime } from "@/lib/scoring";
import { DEFAULT_CAPS, type ConcentrationCaps } from "@/lib/issuers";
import type {
  EconEvent,
  LockoutWindow,
  RegimeBrief,
  RegimeLabel,
  RegimeLockout,
  RegimeRules,
  RegimeSnapshot,
  TideSnapshot,
  YieldMove,
} from "@/lib/types";
import { seedDay, seedEvents } from "@/lib/macro-seed";
import { fetchEconomicCalendar, fetchMarketTide, hasUnusualWhalesKey } from "@/lib/uw";
import { getFreshTape, isUwBlocked } from "@/lib/uw-quota";
import { sessionOpenUtc, tradingDateET } from "@/lib/session";

/**
 * Macro regime: economic calendar (+ researched seed) + official Treasury 10Y/30Y + UW market tide.
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
type YieldBundle = {
  us10y: YieldMove;
  us30y: YieldMove;
  trend5d: RegimeSnapshot["yields"]["trend5d"];
  source: RegimeSnapshot["sources"]["yields"];
};
let yieldMem: Cached<YieldBundle> | null = null;
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

type TsyRow = { date: string; y2: number | null; y10: number | null; y30: number | null };

/** Official Treasury daily par yield curve (newest first). */
async function fetchTreasuryRows(): Promise<TsyRow[] | null> {
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
  const i2 = header.indexOf("2 Yr");
  const i10 = header.indexOf("10 Yr");
  const i30 = header.indexOf("30 Yr");
  if (i10 < 0 || i30 < 0) return null;
  const num = (v: string | undefined) => {
    const n = Number(v);
    return v != null && v !== "" && Number.isFinite(n) ? n : null;
  };
  return lines.slice(1, 12).map((line) => {
    const c = line.split(",");
    const [mm, dd, yyyy] = c[0].replace(/"/g, "").split("/");
    return { date: `${yyyy}-${mm}-${dd}`, y2: i2 >= 0 ? num(c[i2]) : null, y10: num(c[i10]), y30: num(c[i30]) };
  });
}

const bp = (a: number | null, b: number | null) => (a != null && b != null ? Math.round((a - b) * 1000) / 10 : null);

export function composeYields(
  rows: TsyRow[] | null,
  yahoo: { y10: YieldMove | null; y30: YieldMove | null },
  today: string,
): YieldBundle {
  const empty: YieldBundle = { us10y: emptyYield("US10Y"), us30y: emptyYield("US30Y"), trend5d: null, source: "unavailable" };
  if (!rows || rows.length < 2) {
    if (yahoo.y10 && yahoo.y30) return { ...empty, us10y: yahoo.y10, us30y: yahoo.y30, source: "yahoo" };
    return empty;
  }
  const [r0, r1] = rows;
  // 5-session window inclusive of the latest session.
  const r5 = rows[4] ?? rows[rows.length - 1];
  const officialToday = r0.date === today;
  const mk = (symbol: YieldMove["symbol"], last: number | null, prev: number | null, asOf: string | null, source: YieldMove["source"]): YieldMove => ({
    symbol,
    last,
    prevClose: prev,
    changeBp: bp(last, prev),
    asOf,
    source,
  });
  let us10y: YieldMove;
  let us30y: YieldMove;
  let source: YieldBundle["source"];
  if (officialToday) {
    us10y = mk("US10Y", r0.y10, r1.y10, r0.date, "treasury");
    us30y = mk("US30Y", r0.y30, r1.y30, r0.date, "treasury");
    source = "treasury";
  } else if (yahoo.y10?.last != null && yahoo.y30?.last != null) {
    // Intraday: live last vs the official prior close.
    us10y = mk("US10Y", yahoo.y10.last, r0.y10, yahoo.y10.asOf, "treasury+yahoo");
    us30y = mk("US30Y", yahoo.y30.last, r0.y30, yahoo.y30.asOf, "treasury+yahoo");
    source = "treasury+yahoo";
  } else {
    us10y = mk("US10Y", r0.y10, r1.y10, r0.date, "treasury");
    us30y = mk("US30Y", r0.y30, r1.y30, r0.date, "treasury");
    source = "treasury";
  }
  const base = officialToday ? r5 : (rows[3] ?? r5);
  const t2 = bp(r0.y2, r5.y2);
  const t10 = bp(us10y.last, base.y10);
  const t30 = bp(us30y.last, base.y30);
  return {
    us10y,
    us30y,
    trend5d: {
      us2yBp: t2,
      us10yBp: t10,
      us30yBp: t30,
      bearSteepening: (t30 ?? 0) >= 8 && (t2 ?? 0) <= 3,
    },
    source,
  };
}

async function fetchYields(): Promise<YieldBundle> {
  if (yieldMem && Date.now() - yieldMem.at < YIELD_TTL_MS) return yieldMem.value;
  const [rows, y10, y30] = await Promise.all([
    fetchTreasuryRows().catch(() => null),
    fetchYahooYield("^TNX", "US10Y").catch(() => null),
    fetchYahooYield("^TYX", "US30Y").catch(() => null),
  ]);
  const value = composeYields(rows, { y10, y30 }, tradingDateET());
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
    return {
      active: false,
      maxShortlist: 8,
      minDte: 0,
      rateTechPenalty: yieldsRising ? -6 : 0,
      rateSensitivePenalty: yieldsRising ? -6 : 0,
    };
  }
  return {
    active: true,
    maxShortlist: 3,
    minDte: 14,
    rateTechPenalty: yieldsRising ? -15 : 0,
    rateSensitivePenalty: yieldsRising ? -12 : 0,
  };
}

/** Releases that trigger the pre-release lockout. */
const MAJOR_RELEASE = /Non-?Farm|Employment Report|Unemployment Rate|Average Hourly|\bCPI\b|Consumer Price|\bPPI\b|Producer Price|ISM (Manufacturing|Services)|ISM Report On Business|FOMC Statement|Federal Funds|Rate Decision|FOMC (Meeting )?Minutes|\bPCE\b|\bGDP\b|Retail Sales/i;
const LONG_AUCTION = /(10|20|30)[- ]?(Year|Yr|y)\b.*Auction/i;
const IV_EVENT = /\bCPI\b|Consumer Price|\bPPI\b|Producer Price|Non-?Farm|Employment Report|FOMC Statement|Federal Funds/i;

function etWall(date: string, hhmm: string): Date {
  // DST-safe: anchor on the session open offset for that date.
  const open = sessionOpenUtc(new Date(`${date}T16:00:00Z`));
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(open.getTime() + ((h - 9) * 60 + (m - 30)) * 60_000);
}

function fmtEt(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(d) + " ET";
}

/**
 * Pre-release lockout. Pre-market releases (8:30 ET NFP/CPI/PPI): no new picks from the open
 * until max(release + 60 min, open + 30 min). Intraday releases (10:00 ISM, 14:00 minutes/FOMC):
 * release − 30 min → release + 45 min. Long-bond auctions (13:00 ET): 12:45 → 13:45 ET.
 */
export function lockoutWindows(today: string, events: EconEvent[]): LockoutWindow[] {
  const open = etWall(today, "09:30");
  const out: LockoutWindow[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (etDateOf(e.date) !== today) continue;
    const t = new Date(e.date);
    if (!Number.isFinite(t.getTime())) continue;
    const key = `${t.getTime()}`;
    let start: Date;
    let end: Date;
    if (MAJOR_RELEASE.test(e.title) && !/speaks|speech|ADP/i.test(e.title)) {
      if (t.getTime() < open.getTime()) {
        start = open;
        end = new Date(Math.max(t.getTime() + 60 * 60_000, open.getTime() + 30 * 60_000));
      } else {
        start = new Date(Math.max(open.getTime(), t.getTime() - 30 * 60_000));
        end = new Date(t.getTime() + 45 * 60_000);
      }
    } else if (LONG_AUCTION.test(e.title)) {
      start = new Date(t.getTime() - 15 * 60_000);
      end = new Date(t.getTime() + 45 * 60_000);
    } else {
      continue;
    }
    const existing = out.find((w) => w.start === start.toISOString());
    if (existing) {
      if (!existing.event.includes(e.title)) existing.event += ` + ${e.title}`;
      if (end.toISOString() > existing.end) existing.end = end.toISOString();
      continue;
    }
    if (seen.has(key + e.title)) continue;
    seen.add(key + e.title);
    out.push({ start: start.toISOString(), end: end.toISOString(), event: e.title });
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

export function activeLockout(windows: LockoutWindow[], now: Date): RegimeLockout {
  const t = now.getTime();
  const hit = windows.find((w) => t >= Date.parse(w.start) && t < Date.parse(w.end));
  return { active: Boolean(hit), until: hit?.end ?? null, event: hit?.event ?? null, windows };
}

function mergeEvents(live: EconEvent[] | null): EconEvent[] {
  const all = [...(live ?? []), ...seedEvents()];
  const seen = new Set<string>();
  const out: EconEvent[] = [];
  for (const e of all) {
    const t = new Date(e.date).getTime();
    const k = `${e.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 14)}|${Number.isFinite(t) ? Math.round(t / 60_000) : e.date}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

export type RegimeClassification = {
  label: RegimeLabel;
  reasons: string[];
  todayEvents: EconEvent[];
  upcoming: EconEvent[];
  rising: boolean;
  dayRating: RegimeSnapshot["dayRating"];
  lockout: RegimeLockout;
  auctionToday: string | null;
  ivEvents: { date: string; title: string }[];
};

export function classifyRegime(input: {
  today: string;
  now?: Date;
  events: EconEvent[] | null;
  us10y: YieldMove;
  us30y: YieldMove;
  trend5d?: RegimeSnapshot["yields"]["trend5d"];
  tide: TideSnapshot | null;
}): RegimeClassification {
  const now = input.now ?? new Date();
  const reasons: string[] = [];
  const events = mergeEvents(input.events);
  const isKey = (e: EconEvent) => e.impact === "High" || (e.impact === "Medium" && KEY_EVENT.test(e.title) && !/Speaks/i.test(e.title));
  const todayEvents = events.filter((e) => etDateOf(e.date) === input.today && (isKey(e) || e.impact === "Medium"));
  const todayHigh = todayEvents.filter(
    (e) =>
      !/Speaks|speech/i.test(e.title) &&
      !LONG_AUCTION.test(e.title) &&
      !/Minutes/i.test(e.title) &&
      (e.impact === "High" || /FOMC Statement|Federal Funds|Rate Decision/i.test(e.title)),
  );
  const upcoming = events
    .filter(
      (e) =>
        etDateOf(e.date) > input.today &&
        e.impact === "High" &&
        !LONG_AUCTION.test(e.title) &&
        !/Minutes|Speaks|speech/i.test(e.title),
    )
    .slice(0, 6);

  const d10 = input.us10y.changeBp ?? 0;
  const d30 = input.us30y.changeBp ?? 0;
  const up = Math.max(d10, d30);
  const absMax = Math.max(Math.abs(d10), Math.abs(d30));
  const t30 = input.trend5d?.us30yBp ?? 0;
  const t10 = input.trend5d?.us10yBp ?? 0;
  const trendRising = Math.max(t10, t30) >= 10;
  const rising = up >= YIELDS_RISING_BP || trendRising;

  let label: RegimeLabel = "calm";
  const bump = (to: RegimeLabel) => {
    if (to === "report-day") label = "report-day";
    else if (label === "calm") label = to;
  };

  if (todayHigh.length > 0) {
    bump("report-day");
    reasons.push(`US high-impact release today: ${[...new Set(todayHigh.map((e) => e.title))].slice(0, 4).join(", ")}.`);
  }

  if (up >= YIELDS_RISKY_BP || absMax >= YIELDS_ABS_RISKY_BP) {
    bump("risky");
    reasons.push(`Long yields moving hard: 10Y ${fmtBp(d10)}, 30Y ${fmtBp(d30)} vs prior close.`);
  } else if (up >= YIELDS_RISING_BP) {
    reasons.push(`Long yields rising: 10Y ${fmtBp(d10)}, 30Y ${fmtBp(d30)} vs prior close.`);
  }
  if (trendRising) {
    reasons.push(
      `Long-end trend: 10Y ${fmtBp(t10)}, 30Y ${fmtBp(t30)} over 5 sessions${input.trend5d?.bearSteepening ? " (bear-steepening — supply/term premium, not Fed)" : ""}.`,
    );
  }

  const nextHigh = upcoming[0];
  const nextDay = nextHigh ? etDateOf(nextHigh.date) : "";
  const daysAhead = nextDay ? (Date.parse(`${nextDay}T12:00:00Z`) - Date.parse(`${input.today}T12:00:00Z`)) / 86_400_000 : 99;
  if (nextHigh && daysAhead <= 2 && rising) {
    bump("risky");
    reasons.push(`Yields rising into ${nextHigh.title} (${nextDay}). Pre-report positioning risk.`);
  }

  if (input.tide?.bias === "bearish" && rising) {
    bump("risky");
    reasons.push("Bearish UW market tide with rising yields.");
  }

  // Long-bond auctions: afternoon = careful.
  const auction = events.find((e) => etDateOf(e.date) === input.today && LONG_AUCTION.test(e.title)) ?? null;
  if (auction) {
    const noon = etWall(input.today, "12:00");
    if (now.getTime() >= noon.getTime()) {
      bump("risky");
      reasons.push(`${auction.title} at ${fmtEt(new Date(auction.date))} — auction afternoon, careful.`);
    } else {
      reasons.push(`${auction.title} at ${fmtEt(new Date(auction.date))} this afternoon — careful after 12:00 ET.`);
    }
  }

  // Researched day rating (seed).
  const seed = seedDay(input.today);
  const dayRating = seed ? { rating: seed.rating, note: seed.note } : null;
  if (seed) {
    if (seed.rating === "sit-out") bump("report-day");
    else if (seed.rating === "careful") bump(todayHigh.length > 0 ? "report-day" : "risky");
    else if (seed.rating === "careful-afternoon" && now.getTime() >= etWall(input.today, "12:00").getTime()) bump("risky");
    reasons.push(`Desk rating ${seed.rating}: ${seed.note}`);
  }

  const lockout = activeLockout(lockoutWindows(input.today, events), now);
  if (lockout.active && lockout.until) {
    reasons.unshift(`PRE-RELEASE LOCKOUT (${lockout.event}) — no new picks until ${fmtEt(new Date(lockout.until))}.`);
  } else {
    const next = lockout.windows.find((w) => Date.parse(w.start) > now.getTime());
    if (next) reasons.push(`Lockout ${fmtEt(new Date(next.start))}–${fmtEt(new Date(next.end))} for ${next.event}.`);
  }

  // Vol events within ~45 days: expiries spanning these carry elevated IV (crush after).
  const horizon = Date.parse(`${input.today}T12:00:00Z`) + 45 * 86_400_000;
  const ivSeen = new Set<string>();
  const ivEvents = events
    .filter((e) => IV_EVENT.test(e.title) && !/ADP|speaks|speech|Minutes/i.test(e.title) && etDateOf(e.date) >= input.today && new Date(e.date).getTime() <= horizon)
    .map((e) => {
      const family = /CPI|Consumer Price/i.test(e.title)
        ? "CPI"
        : /PPI|Producer Price/i.test(e.title)
          ? "PPI"
          : /FOMC|Federal Funds/i.test(e.title)
            ? "FOMC"
            : "NFP";
      return { date: etDateOf(e.date), title: family };
    })
    .filter((e) => {
      const k = `${e.date}|${e.title}`;
      if (ivSeen.has(k)) return false;
      ivSeen.add(k);
      return true;
    });
  if (ivEvents.some((e) => /CPI|PPI|Consumer Price|Producer Price/i.test(e.title))) {
    const cp = ivEvents.filter((e) => /CPI|PPI|Consumer Price|Producer Price/i.test(e.title));
    reasons.push(`Expiries spanning ${cp.map((e) => `${e.title} ${e.date.slice(5)}`).join(" / ")} carry elevated IV — expect a crush after the print.`);
  }

  if (input.events == null) reasons.push("Live economic calendar unavailable — using the researched seed + yields + tide.");
  if (input.us10y.changeBp == null && input.us30y.changeBp == null) reasons.push("Yield feed unavailable.");
  if (label === "calm" && reasons.length === 0) reasons.push("No US high-impact report today and long yields steady.");

  return { label, reasons, todayEvents, upcoming, rising, dayRating, lockout, auctionToday: auction?.title ?? null, ivEvents };
}

function fmtBp(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}bp`;
}

function snapshotFrom(
  today: string,
  c: RegimeClassification,
  yields: YieldBundle,
  tide: TideSnapshot | null,
  sources: RegimeSnapshot["sources"],
  warnings: string[],
): RegimeSnapshot {
  return {
    label: c.label,
    tradingDate: today,
    fetchedAt: new Date().toISOString(),
    reasons: c.reasons,
    rules: rulesFor(c.label, c.rising),
    events: { today: c.todayEvents, upcoming: c.upcoming },
    yields: { us10y: yields.us10y, us30y: yields.us30y, rising: c.rising, trend5d: yields.trend5d },
    dayRating: c.dayRating,
    lockout: c.lockout,
    auctionToday: c.auctionToday,
    ivEvents: c.ivEvents,
    tide,
    sources,
    warnings,
  };
}

async function computeRegime(passedTide?: TideSnapshot | null): Promise<RegimeSnapshot> {
  const today = tradingDateET();
  const [events, yields, tideRes] = await Promise.all([fetchCalendar(today), fetchYields(), resolveTide(passedTide)]);
  const c = classifyRegime({
    today,
    events,
    us10y: yields.us10y,
    us30y: yields.us30y,
    trend5d: yields.trend5d,
    tide: tideRes.tide,
  });
  const warnings: string[] = [];
  if (!events) warnings.push("Live calendar sources (Forex Factory weekly JSON, UW economic-calendar) unavailable — seed only.");
  if (yields.source === "unavailable") warnings.push("Treasury and Yahoo yield feeds unavailable.");
  if (yields.source === "yahoo") warnings.push("Treasury CSV unavailable — yields from Yahoo only.");
  if (yields.source === "treasury" && yields.us10y.asOf !== today) warnings.push("Intraday yields unavailable — showing last official Treasury close vs prior close.");
  return snapshotFrom(
    today,
    c,
    yields,
    tideRes.tide,
    { calendar: events ? calendarSource : "unavailable", yields: yields.source, tide: tideRes.source },
    warnings,
  );
}

/** Cached 5 min in memory (lockout re-evaluated on every read); inner sources cache longer. */
export async function loadRegime(opts?: { tide?: TideSnapshot | null; fresh?: boolean }): Promise<RegimeSnapshot> {
  const today = tradingDateET();
  if (!opts?.fresh && regimeMem && regimeMem.key === today && Date.now() - regimeMem.at < REGIME_TTL_MS) {
    const v = regimeMem.value;
    const lockout = activeLockout(v.lockout.windows, new Date());
    if (opts?.tide && !v.tide) {
      const c = classifyRegime({
        today,
        events: calendarMem?.value ?? null,
        us10y: v.yields.us10y,
        us30y: v.yields.us30y,
        trend5d: v.yields.trend5d,
        tide: opts.tide,
      });
      return snapshotFrom(
        today,
        c,
        { us10y: v.yields.us10y, us30y: v.yields.us30y, trend5d: v.yields.trend5d, source: v.sources.yields },
        opts.tide,
        { ...v.sources, tide: "uw-cache" },
        v.warnings,
      );
    }
    return { ...v, lockout };
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
    rateSensitivePenalty: regime.rules.rateSensitivePenalty,
    yieldsRising: regime.yields.rising,
    ivEvents: regime.ivEvents,
  };
}

export function regimeBrief(regime: RegimeSnapshot | null): RegimeBrief | null {
  if (!regime) return null;
  return {
    label: regime.label,
    reasons: regime.reasons,
    rules: regime.rules,
    lockout: regime.lockout,
    dayRating: regime.dayRating,
  };
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

export function lockoutWarning(regime: RegimeSnapshot | null): string | null {
  if (!regime?.lockout.active || !regime.lockout.until) return null;
  return `Pre-release lockout for ${regime.lockout.event}: no new picks until ${fmtEt(new Date(regime.lockout.until))}.`;
}
