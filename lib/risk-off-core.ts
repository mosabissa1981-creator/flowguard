/**
 * LIVE risk-off pure helpers (no I/O). Safe for client bundles via spread-core.
 * Loader + Yahoo fetch live in lib/risk-off.ts.
 */
import { isEtfOrIndex } from "@/lib/puts-rule";

/** The ONE switch: when true, PRIMARY risk-off mornings exclude ETF/index puts from live boards. */
export const RISK_OFF_BLOCK_ETF_PUTS = true;

export const RISK_OFF_PUT_REASON = "Skipped: risk-off morning (ETF puts held back)";
export const RISK_OFF_BANNER =
  "Risk-off morning (oil/yields/QQQ): stay light or sit out";

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
  banner: string | null;
  blockEtfPuts: boolean;
  source: "yahoo" | "unavailable";
  computedAt: string;
  note: string;
};

/** Pure evaluator (testable). Uses rounded pct compares like the study. */
export function evaluateRiskOff(
  inputs: RiskOffInputs,
  opts: { day: string; provisional: boolean; nowIso?: string },
): RiskOffSnapshot {
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

/** True when LIVE risk-off holds back this ETF/index put. Calls → false. */
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
