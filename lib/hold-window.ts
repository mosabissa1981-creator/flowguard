import type { HoldWindow, RankedFlow, ScoreChip } from "@/lib/types";

export type { HoldWindow };

function hasChip(chips: ScoreChip[], id: string) {
  return chips.some((chip) => chip.id === id);
}

/**
 * Options hold window — never a stock hold, never "hold to expiry".
 *
 * - Same-day / chase-rip ask sweep: intraday–2 sessions
 * - Typical 7–29 DTE ask-side unusual: 2–7 sessions
 * - 30+ DTE still-working thesis: up to ~1–2 weeks (cut earlier if it stalls)
 */
export function buildHoldWindow(row: Pick<RankedFlow, "dte" | "askShare" | "alert" | "chips">): HoldWindow {
  const sweep = row.alert.has_sweep || hasChip(row.chips, "sweep");
  const askTaking = row.askShare >= 0.55;
  const sameDay = row.dte <= 2;
  const chaseRip = sweep && askTaking && row.dte < 7;
  const extendedRip =
    sweep &&
    askTaking &&
    row.dte <= 10 &&
    (hasChip(row.chips, "voi-high") || hasChip(row.chips, "voi"));

  if (sameDay || chaseRip || extendedRip) {
    return {
      label: "intraday–2 sessions",
      line: "Hold window: intraday–2 sessions",
      exit: "Exit if thesis fails or by two sessions.",
    };
  }

  if (row.dte >= 30) {
    return {
      label: "up to ~1–2 weeks",
      line: "Hold window: up to ~1–2 weeks; cut by ~half DTE if thesis stalls",
      exit: "Exit if thesis fails or by two weeks. Do not hold this option to expiry.",
    };
  }

  if (row.dte >= 7) {
    return {
      label: "2–7 sessions",
      line: "Hold window: 2–7 sessions",
      exit: "Exit if thesis fails or by seven sessions.",
    };
  }

  return {
    label: "intraday–2 sessions",
    line: "Hold window: intraday–2 sessions",
    exit: "Exit if thesis fails or by two sessions.",
  };
}
