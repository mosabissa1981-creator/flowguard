/**
 * LIVE exit rule checks (10/8/2026): flat +30% target, −25% stop, time stop 2:30 PM CT on the 2nd session after
 * entry (holidays skipped, capped at expiry), 2-session hold window, stored older plans rewritten.
 * Run: npx tsx --conditions=react-server scripts/exit-plan-check.ts
 */
import assert from "node:assert/strict";
import {
  HOLD_SESSIONS, LIVE_HOLD_WINDOW, STOP_PCT, TARGET_PCT, addTradingSessions, buildExitPlan, liveTimeStopDate, withLiveExitRule,
} from "@/lib/exit-plan";
import { buildHoldWindow } from "@/lib/hold-window";
import { LANES, LANE_COMMON_RULES, trackFromBars } from "@/lib/lanes";
import type { RankedFlow } from "@/lib/types";

assert.equal(TARGET_PCT, 0.3);
assert.equal(STOP_PCT, 0.25);
assert.equal(HOLD_SESSIONS, 2);

const row = (price: string, expiry: string, dte: number) =>
  ({ alert: { price, ask: price, expiry, option_chain: "X", ticker: "X" }, dte }) as unknown as Pick<RankedFlow, "alert" | "dte">;
// Thursday 10/8/2026 (ET midday) → 2 sessions later = Monday 10/12.
const now = new Date("2026-10-08T16:00:00Z");
for (const opts of [{ riskyRegime: false }, { riskyRegime: true }, { riskyRegime: false, confidence: 90 }]) {
  const p = buildExitPlan(row("2.00", "2026-10-30", 22), { ...opts, now });
  assert.equal(p.targetPct, 30, "flat +30% regardless of regime/confidence");
  assert.equal(p.target, 2.6);
  assert.equal(p.stopPct, -25);
  assert.equal(p.stop, 1.5);
  assert.equal(p.timeStop.sessions, 2);
  assert.equal(p.timeStop.date, "2026-10-12");
  assert.match(p.timeStop.rule, /2:30 PM CT/);
  assert.deepEqual(p.alertLevels.map((l) => l.pct), [30, -25]);
}
// Expiry before the 2nd session caps the time stop.
assert.equal(buildExitPlan(row("1.00", "2026-10-09", 1), { riskyRegime: false, now }).timeStop.date, "2026-10-09");
// Holidays skipped: Tue 11/24/2026 → Wed 11/25, (Thu 11/26 Thanksgiving closed) → Fri 11/27.
assert.equal(addTradingSessions("2026-11-24", 2), "2026-11-27");
assert.equal(liveTimeStopDate("2026-10-08", null), "2026-10-12");
assert.equal(liveTimeStopDate("2026-10-08", "2026-10-30", 1), "2026-10-09");
// Stored older plan (+40%, 3 sessions) is rewritten; entry + event notes kept.
const old = { ...buildExitPlan(row("2.00", "2026-10-30", 22), { riskyRegime: false, now }), targetPct: 40, target: 2.8, timeStop: { date: "2026-10-13", sessions: 3, rule: "old" }, eventRisk: ["CPI 2026-10-14"] };
const fixed = withLiveExitRule(old, "2026-10-08", "2026-10-30")!;
assert.equal(fixed.targetPct, 30);
assert.equal(fixed.target, 2.6);
assert.equal(fixed.timeStop.date, "2026-10-12");
assert.deepEqual(fixed.eventRisk, ["CPI 2026-10-14"]);
assert.equal(fixed.entry, 2);
// Hold window on every card: 2 sessions.
const hw = buildHoldWindow({ dte: 40, askShare: 0.9, alert: { has_sweep: true }, chips: [] } as unknown as RankedFlow);
assert.equal(hw.label, "2 sessions");
assert.deepEqual(hw, { ...LIVE_HOLD_WINDOW });
// Live lanes: +30% / −25% / 2 sessions.
assert.equal(LANE_COMMON_RULES.exit.targetPct, 30);
assert.equal(LANE_COMMON_RULES.exit.stopPct, -25);
for (const l of LANES) assert.equal(l.timeStopSessions, 2, l.id);
// Lane grading uses each entry's own plan: +35% high = winner under +30%, but not for an old +40% entry.
const bars = [{ date: "2026-10-09", high: 2.7, low: 1.9, last: 2.1 }, { date: "2026-10-12", high: 2.2, low: 1.9, last: 2.0 }];
const base = { day: "2026-10-08", entry: 2, expiry: "2026-10-30" };
const newE = { ...base, exitPlan: { entry: 2, target: 2.6, targetPct: 30, stop: 1.5, stopPct: -25, timeStopSessions: 2 } };
const oldE = { ...base, exitPlan: { entry: 2, target: 2.8, targetPct: 40, stop: 1.5, stopPct: -25, timeStopSessions: 3 } };
assert.equal(trackFromBars(newE as never, bars as never, "2026-10-13").outcome, "winner");
assert.equal(trackFromBars(oldE as never, bars as never, "2026-10-13").outcome, "open");
console.log("exit-plan-check: all assertions passed");
