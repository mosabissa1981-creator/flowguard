/**
 * TEST / SHADOW — "gap-up chase" checker (pure logic, no I/O). Never changes live picks.
 *
 * Lesson (Oct 6 2026): morning calls bought into a gap-up (NVDA 245C/250C, SPCX 170C/190C, SMH 650C)
 * all lost 16–36% once midday flow flipped bearish (net premium tide +$149M → −$111M).
 *
 * Rule (shadow verdicts only):
 *  - Gap-up day: SPY or QQQ regular-session open ≥ +0.3% vs prior close.
 *  - On a gap-up day, a CALL printed 9:30–11:00 ET needs confirmation before it "counts":
 *    a 2nd ask-side print on the same contract, or a pullback (spot ≥0.3% under the print's spot,
 *    or the print came ≥0.3% under the day's open). Otherwise → flag "gap-up chase".
 *  - On a gap-up day, a call whose stock was already up ≥2% at the print is flagged with a
 *    penalty (−6 at 2–3%, −10 at ≥3%) even if confirmed.
 * Backtest (2y replay, 1,802 gap-up-morning call candidates): flagged 40.4% win vs kept 46.5%
 * (baseline 42.0%); it removes ~76% of losers but also ~71% of winners — a soft flag, not a filter.
 *
 * Mirror for PUTS (Oct 7 2026: opening put sweeps bought the low on a gap-down morning):
 *  - Gap-down day: SPY or QQQ open ≤ −0.3% vs prior close.
 *  - On a gap-down day, a PUT printed 9:30–11:00 ET on a stock already down 1–3% at the print → flag
 *    "gap-down put chase" (shadow penalty −6). Puts on stocks down ≥3% are NOT flagged (in the replay they
 *    won more, 42.8%), and the plain "no 2nd ask / no bounce" mirror had no edge, so it is shown as info only.
 * Backtest (2y replay, 1,151 gap-down-morning put candidates): flagged 26.4% win (72W/201L/32F) vs kept
 * 40.4% (308W/455L/83F), baseline 36.7%; cuts 31% of losers and 19% of winners. Held in both years
 * (30.3% vs 44.1%; 23.2% vs 37.8%). The 1–3% band was chosen from the same data — treat as a flag.
 */

export const GAP_DAY_MIN = 0.003;
export const EXTENDED_MIN = 0.02;
export const EXTENDED_HARD = 0.03;
export const PULLBACK_MIN = 0.003;
export const MORNING_START_ET = 9 * 60 + 30;
export const MORNING_END_ET = 11 * 60;
export const PUT_DOWN_MIN = 0.01;
export const PUT_DOWN_MAX = 0.03;

export type GapChaseMarket = {
  spyGapPct: number | null;
  qqqGapPct: number | null;
  gapDay: boolean;
  /** SPY or QQQ open ≤ −0.3% (older stored docs lack it; derived from the gaps). */
  gapDownDay?: boolean;
  capturedAt: string | null;
};

export type GapChaseInput = {
  side: "call" | "put";
  /** ET minutes since midnight of the (first) print. */
  printEtMinutes: number | null;
  market: GapChaseMarket;
  underlyingAtPrint: number | null;
  prevClose: number | null;
  dayOpen: number | null;
  spotNow: number | null;
  /** Time of the 2nd ask-side print on the same contract, if any. */
  secondAskAt: string | null;
  /** Time a pullback was first seen (persisted by the caller), if any. */
  pullbackAt: string | null;
};

export type GapChaseVerdict = {
  verdict: "flag" | "pass" | "n/a";
  /** Shadow-only score penalty (never applied to live picks). */
  penalty: number;
  reasons: string[];
  gapDay: boolean;
  morning: boolean;
  stockPctAtPrint: number | null;
  confirmed: boolean;
  confirmation: "2nd-ask" | "pullback" | null;
  /** True when spot is now ≥0.3% under the print's spot or the print came under the open. */
  pullbackNow: boolean;
};

const pct = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

export function marketFromStates(
  spy: { open?: number | null; prevClose?: number | null } | null | undefined,
  qqq: { open?: number | null; prevClose?: number | null } | null | undefined,
  capturedAt: string,
): GapChaseMarket {
  const g = (s: typeof spy) => (s?.open && s?.prevClose ? s.open / s.prevClose - 1 : null);
  const spyGapPct = g(spy);
  const qqqGapPct = g(qqq);
  const best = Math.max(spyGapPct ?? -1, qqqGapPct ?? -1);
  const worst = Math.min(spyGapPct ?? 1, qqqGapPct ?? 1);
  return { spyGapPct, qqqGapPct, gapDay: best >= GAP_DAY_MIN, gapDownDay: worst <= -GAP_DAY_MIN, capturedAt };
}

export function evaluateGapChase(input: GapChaseInput): GapChaseVerdict {
  const { market } = input;
  const morning = input.printEtMinutes != null && input.printEtMinutes >= MORNING_START_ET && input.printEtMinutes < MORNING_END_ET;
  const stockPctAtPrint =
    input.underlyingAtPrint && input.prevClose && input.prevClose > 0 ? input.underlyingAtPrint / input.prevClose - 1 : null;
  const pullbackNow = Boolean(
    (input.spotNow && input.underlyingAtPrint && input.spotNow <= input.underlyingAtPrint * (1 - PULLBACK_MIN)) ||
      (input.dayOpen && input.underlyingAtPrint && input.underlyingAtPrint <= input.dayOpen * (1 - PULLBACK_MIN)),
  );
  const confirmation: GapChaseVerdict["confirmation"] = input.secondAskAt ? "2nd-ask" : input.pullbackAt || pullbackNow ? "pullback" : null;
  const base = { gapDay: market.gapDay, morning, stockPctAtPrint, confirmed: confirmation != null, confirmation, pullbackNow };

  if (input.side === "put") return evaluatePut(input, base, morning, stockPctAtPrint);
  const gapText = `SPY ${market.spyGapPct != null ? pct(market.spyGapPct) : "?"} / QQQ ${market.qqqGapPct != null ? pct(market.qqqGapPct) : "?"} at the open`;
  if (!market.gapDay) {
    return { ...base, verdict: "pass", penalty: 0, reasons: [`No gap-up (${gapText}).`] };
  }

  const reasons: string[] = [`Gap-up day (${gapText}).`];
  let penalty = 0;
  let flag = false;
  if (stockPctAtPrint != null && stockPctAtPrint >= EXTENDED_MIN) {
    penalty += stockPctAtPrint >= EXTENDED_HARD ? -10 : -6;
    flag = true;
    reasons.push(`Stock already ${pct(stockPctAtPrint)} vs prior close at the print — chase risk.`);
  }
  if (morning) {
    if (confirmation === "2nd-ask") reasons.push(`Confirmed: 2nd ask-side print on the contract (${input.secondAskAt}).`);
    else if (confirmation === "pullback") reasons.push(`Confirmed: pullback seen${input.pullbackAt ? ` (${input.pullbackAt})` : ""}.`);
    else {
      flag = true;
      reasons.push("Morning call on a gap-up with no 2nd ask-side print and no pullback yet — wait before it counts.");
    }
  } else {
    reasons.push("Printed after 11:00 ET — confirmation rule not required.");
  }
  return { ...base, verdict: flag ? "flag" : "pass", penalty, reasons };
}

function evaluatePut(
  input: GapChaseInput,
  base: Omit<GapChaseVerdict, "verdict" | "penalty" | "reasons">,
  morning: boolean,
  stockPctAtPrint: number | null,
): GapChaseVerdict {
  const m = input.market;
  const gapDown =
    m.gapDownDay ?? Math.min(m.spyGapPct ?? 1, m.qqqGapPct ?? 1) <= -GAP_DAY_MIN;
  const gapText = `SPY ${m.spyGapPct != null ? pct(m.spyGapPct) : "?"} / QQQ ${m.qqqGapPct != null ? pct(m.qqqGapPct) : "?"} at the open`;
  // For puts the "pullback" confirmation is a bounce: spot ≥0.3% above the print, or the print ≥0.3% over the open.
  const bounceNow = Boolean(
    (input.spotNow && input.underlyingAtPrint && input.spotNow >= input.underlyingAtPrint * (1 + PULLBACK_MIN)) ||
      (input.dayOpen && input.underlyingAtPrint && input.underlyingAtPrint >= input.dayOpen * (1 + PULLBACK_MIN)),
  );
  const confirmation: GapChaseVerdict["confirmation"] = input.secondAskAt ? "2nd-ask" : input.pullbackAt || bounceNow ? "pullback" : null;
  const b = { ...base, confirmed: confirmation != null, confirmation, pullbackNow: bounceNow };
  if (!gapDown) return { ...b, verdict: "pass", penalty: 0, reasons: [`No gap-down (${gapText}).`] };
  const reasons = [`Gap-down day (${gapText}).`];
  if (!morning) {
    reasons.push("Printed after 11:00 ET — gap-down put rule not applied.");
    return { ...b, verdict: "pass", penalty: 0, reasons };
  }
  const down = stockPctAtPrint != null ? -stockPctAtPrint : null;
  if (down != null && down >= PUT_DOWN_MIN && down < PUT_DOWN_MAX) {
    reasons.push(`Stock already ${pct(stockPctAtPrint!)} vs prior close at the print — gap-down put chase (replay: 26% win vs 40%).`);
    if (confirmation) reasons.push(`(Confirmation seen: ${confirmation} — the replay showed no edge from it for puts.)`);
    return { ...b, verdict: "flag", penalty: -6, reasons };
  }
  if (down != null && down >= PUT_DOWN_MAX) reasons.push(`Stock ${pct(stockPctAtPrint!)} at the print — ≥3% down is not flagged (replay: these won more).`);
  else reasons.push(`Stock ${stockPctAtPrint != null ? pct(stockPctAtPrint) : "?"} at the print — outside the 1–3% chase zone.`);
  if (!confirmation) reasons.push("No 2nd ask print or bounce yet (info only; no edge in the replay).");
  return { ...b, verdict: "pass", penalty: 0, reasons };
}
