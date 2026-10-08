import type { ExitPlan, RankedFlow } from "@/lib/types";
import { toNumber } from "@/lib/numbers";
import { tradingDateET } from "@/lib/session";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * LIVE exit rule (approved 10/8/2026 after the 2-year exit-rules backtest): flat +30% target, −25% stop, time stop
 * 2:30 PM CT (15:30 ET) on the 2nd trading session after entry. Applies to every live board (Picks, Premove, morning
 * shortlist, setup/earnings run-up lanes, AI-picks finalists) and to NEW paper entries from those lanes.
 * Test lanes (lottery, puts book, earnings calendar) keep their own rules.
 */
export const TARGET_PCT = 0.3;
export const STOP_PCT = 0.25;
export const HOLD_SESSIONS = 2;
/** Same numbers in whole percent (lanes / paper store percents). */
export const TARGET_PCT_WHOLE = Math.round(TARGET_PCT * 100);
export const STOP_PCT_WHOLE = -Math.round(STOP_PCT * 100);
export const LIVE_EXIT_RULE_TEXT = `+${TARGET_PCT_WHOLE}% target / −${Math.round(STOP_PCT * 100)}% stop / exit by 2:30 PM CT on the ${HOLD_SESSIONS === 2 ? "2nd" : `${HOLD_SESSIONS}th`} session after entry`;
/** Hold window shown on live board cards (replaces the old 2–7 session / 1–2 week guidance). */
export const LIVE_HOLD_WINDOW = {
  label: `${HOLD_SESSIONS} sessions`,
  line: `Hold window: ${HOLD_SESSIONS} sessions`,
  exit: `Target +${TARGET_PCT_WHOLE}%, stop −${Math.round(STOP_PCT * 100)}%; otherwise exit by 2:30 PM CT on the ${HOLD_SESSIONS === 2 ? "2nd" : `${HOLD_SESSIONS}th`} session after entry.`,
} as const;

/** NYSE full-day closures (the time stop skips them). */
const MARKET_HOLIDAYS = new Set([
  "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

/** Add N trading sessions (weekdays, skipping NYSE holidays) to an ET date string. */
export function addTradingSessions(date: string, sessions: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  let left = sessions;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && !MARKET_HOLIDAYS.has(d.toISOString().slice(0, 10))) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

/** LIVE time-stop date for an entry on `entryDay` (2nd session after), never after the option's expiry. */
export function liveTimeStopDate(entryDay: string, expiry?: string | null, sessions: number = HOLD_SESSIONS): string {
  const d = addTradingSessions(entryDay, sessions);
  const exp = expiry ? expiry.slice(0, 10) : null;
  return exp && exp < d ? exp : d;
}

function timeStopRule(date: string, sessions: number): string {
  return `Exit by 2:30 PM CT (15:30 ET) on ${date} (${sessions} session${sessions === 1 ? "" : "s"} after entry) if neither target nor stop hit.`;
}

/** Add N weekdays (no holiday calendar) to an ET trading date string. */
export function addSessions(date: string, sessions: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  let left = sessions;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Per-pick LIVE exit plan: flat +30% target, −25% stop, time stop 2:30 PM CT on the 2nd session after entry (capped
 * at expiry). The regime/confidence variants (+30/+40/+50, 3|5 sessions) were retired 10/8/2026; the options are
 * kept in the signature so callers do not change. Entry is the flow print — re-check the live ask before acting.
 * Not financial advice.
 */
export function buildExitPlan(
  row: Pick<RankedFlow, "alert" | "dte">,
  opts: {
    riskyRegime: boolean;
    confidence?: number;
    now?: Date;
    ivEvents?: { date: string; title: string }[];
  } = { riskyRegime: false },
): ExitPlan {
  const print = toNumber(row.alert.price);
  const askAtPrint = toNumber(row.alert.ask);
  const entry = print > 0 ? print : askAtPrint;
  const entryBasis: ExitPlan["entryBasis"] = print > 0 ? "flow-print" : "ask-at-print";
  const today = tradingDateET(opts.now ?? new Date());
  const plan = levelsPlan(round2(entry), entryBasis, today, row.alert.expiry);
  return {
    ...plan,
    eventRisk: (opts.ivEvents ?? [])
      .filter((e) => e.date >= today && e.date <= row.alert.expiry.slice(0, 10))
      .map((e) => `${e.title} ${e.date} — elevated IV; time stop before it unless the trade is the event.`),
  };
}

function levelsPlan(entry: number, entryBasis: ExitPlan["entryBasis"], entryDay: string, expiry?: string | null): ExitPlan {
  const timeDate = liveTimeStopDate(entryDay, expiry);
  const target = round2(entry * (1 + TARGET_PCT));
  const stop = round2(entry * (1 - STOP_PCT));
  return {
    entry,
    entryBasis,
    target,
    targetPct: TARGET_PCT_WHOLE,
    stop,
    stopPct: STOP_PCT_WHOLE,
    timeStop: { date: timeDate, sessions: HOLD_SESSIONS, rule: timeStopRule(timeDate, HOLD_SESSIONS) },
    eventRisk: [],
    alertLevels: [
      { kind: "target", premium: target, pct: TARGET_PCT_WHOLE },
      { kind: "stop", premium: stop, pct: STOP_PCT_WHOLE },
    ],
    note: "Levels are on option premium per share vs the flow print. Re-check the live ask before entry; skip if the ask is >10% above entry.",
  };
}

/**
 * Re-apply the LIVE exit rule to a stored plan (frozen morning snapshot / stored AI answer saved by an older build).
 * Keeps entry, entry basis and event-risk notes; rewrites target, stop and time stop. `entryDay` = the list's day.
 */
export function withLiveExitRule(plan: ExitPlan | undefined, entryDay: string, expiry?: string | null): ExitPlan | undefined {
  if (!plan || !(plan.entry > 0)) return plan;
  if (plan.targetPct === TARGET_PCT_WHOLE && plan.stopPct === STOP_PCT_WHOLE && plan.timeStop?.sessions === HOLD_SESSIONS) return plan;
  return { ...levelsPlan(plan.entry, plan.entryBasis, entryDay, expiry), eventRisk: plan.eventRisk ?? [], note: plan.note };
}
