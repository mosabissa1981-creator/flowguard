import type { ExitPlan, RankedFlow } from "@/lib/types";
import { toNumber } from "@/lib/numbers";
import { tradingDateET } from "@/lib/session";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
 * Per-pick exit plan. Target +30% on risky/report days, +40% calm, +50% for high-confidence
 * calm picks; stop −25%; time stop min(3|5 sessions, half the DTE). Entry is the flow print —
 * re-check the live ask before acting. Not financial advice.
 */
export function buildExitPlan(
  row: Pick<RankedFlow, "alert" | "dte">,
  opts: { riskyRegime: boolean; confidence?: number; now?: Date } = { riskyRegime: false },
): ExitPlan {
  const print = toNumber(row.alert.price);
  const askAtPrint = toNumber(row.alert.ask);
  const entry = print > 0 ? print : askAtPrint;
  const entryBasis: ExitPlan["entryBasis"] = print > 0 ? "flow-print" : "ask-at-print";
  const targetPct = opts.riskyRegime ? 0.3 : (opts.confidence ?? 0) >= 75 ? 0.5 : 0.4;
  const stopPct = -0.25;
  const baseSessions = opts.riskyRegime ? 3 : 5;
  const halfDte = Math.max(1, Math.floor((row.dte || 0) / 2));
  const sessions = Math.max(1, Math.min(baseSessions, halfDte));
  const today = tradingDateET(opts.now ?? new Date());
  const timeDate = addSessions(today, sessions);
  const target = round2(entry * (1 + targetPct));
  const stop = round2(entry * (1 + stopPct));
  return {
    entry: round2(entry),
    entryBasis,
    target,
    targetPct: Math.round(targetPct * 100),
    stop,
    stopPct: Math.round(stopPct * 100),
    timeStop: {
      date: timeDate,
      sessions,
      rule: `Exit by 15:30 ET on ${timeDate} (${sessions} session${sessions === 1 ? "" : "s"}) if neither target nor stop hit.`,
    },
    alertLevels: [
      { kind: "target", premium: target, pct: Math.round(targetPct * 100) },
      { kind: "stop", premium: stop, pct: Math.round(stopPct * 100) },
    ],
    note: "Levels are on option premium per share vs the flow print. Re-check the live ask before entry; skip if the ask is >10% above entry.",
  };
}
