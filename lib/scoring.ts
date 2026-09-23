import type { FlowAlert, RankedFlow, ScoreChip, TideSnapshot } from "@/lib/types";
import { buildHoldWindow } from "@/lib/hold-window";
import { askShare, clamp, daysToExpiry, toNumber } from "@/lib/numbers";
import {
  fadeFromLaterPrints,
  hasSessionAskConfirmation,
  isFloorOnlyCandidate,
  type ChainFadeSignal,
} from "@/lib/chain-context";
import { hoursSinceCreated, isLateSessionPrint, printAgeBand } from "@/lib/session";
import { followThroughFromPeers } from "@/lib/follow-through";
import { alertOtmPct, moneynessBand } from "@/lib/moneyness";

const BASE_SCORE = 32;
const STALE_CAP = 32;

function chip(
  id: string,
  label: string,
  kind: ScoreChip["kind"],
  delta: number,
  detail: string,
): ScoreChip {
  return { id, label, kind, delta, detail };
}

export function scoreAlert(
  alert: FlowAlert,
  context: {
    marketTide?: TideSnapshot | null;
    tickerTide?: TideSnapshot | null;
    now?: Date;
    peers?: FlowAlert[];
    chainFade?: ChainFadeSignal | null;
  } = {},
): Omit<RankedFlow, "rank"> {
  const chips: ScoreChip[] = [];
  let score = BASE_SCORE;
  const now = context.now ?? new Date();
  const peers = context.peers ?? [];

  const premium = toNumber(alert.total_premium);
  const volOi = toNumber(alert.volume_oi_ratio);
  const share = askShare(alert);
  const dte = daysToExpiry(alert.expiry, now);
  const isCall = alert.type === "call";
  const aggressive = share >= 0.55;

  if (share >= 0.8) {
    const delta = 12;
    score += delta;
    chips.push(
      chip(
        "ask-dom",
        "Ask-side dominance",
        "boost",
        delta,
        `${Math.round(share * 100)}% of sided premium printed on the ask — aggressive taking.`,
      ),
    );
  } else if (share >= 0.6) {
    const delta = 6;
    score += delta;
    chips.push(
      chip(
        "ask-lean",
        "Ask-side lean",
        "boost",
        delta,
        `${Math.round(share * 100)}% ask-side premium. More likely a bid-for-flow entry than a dump.`,
      ),
    );
  } else if (share < 0.4) {
    const delta = -16;
    score += delta;
    chips.push(
      chip(
        "bid-dom",
        "Bid-dominant",
        "penalty",
        delta,
        `${Math.round((1 - share) * 100)}% bid-side premium. Direction often mismatches the headline call/put.`,
      ),
    );
  }

  if (alert.all_opening_trades) {
    const delta = 4;
    score += delta;
    chips.push(
      chip(
        "opening",
        "All opening",
        "boost",
        delta,
        "Size beat open interest on every print. Mild plus only — Sep 4 winners MU/INTC were not all-opening.",
      ),
    );
  }

  if (volOi >= 3) {
    const delta = 8;
    score += delta;
    chips.push(
      chip(
        "voi-high",
        "High vol/OI",
        "boost",
        delta,
        `Volume/OI ${volOi.toFixed(2)}x. The chain is being used, not just quoted.`,
      ),
    );
  } else if (volOi >= 1) {
    const delta = 5;
    score += delta;
    chips.push(
      chip(
        "voi",
        "Vol > OI",
        "boost",
        delta,
        `Volume/OI ${volOi.toFixed(2)}x — unusual relative to existing inventory.`,
      ),
    );
  }

  if (premium >= 1_000_000) {
    const delta = 10;
    score += delta;
    chips.push(
      chip("whale", "Whale premium", "boost", delta, "Seven-figure notional. Size that tends to mean it."),
    );
  } else if (premium >= 250_000) {
    const delta = 7;
    score += delta;
    chips.push(
      chip(
        "prem-fat",
        "Meaningful premium",
        "boost",
        delta,
        "Premium ≥ $250k. Enough size that a fade is expensive to be wrong.",
      ),
    );
  } else if (premium >= 75_000) {
    const delta = 4;
    score += delta;
    chips.push(
      chip("prem-ok", "Solid premium", "boost", delta, "Premium clears a tradable unusual-flow bar."),
    );
  } else if (premium > 0 && premium < 25_000) {
    const delta = -14;
    score += delta;
    chips.push(
      chip(
        "tiny",
        "Tiny premium",
        "penalty",
        delta,
        "Sub-$25k prints reverse constantly. Noise, not a book.",
      ),
    );
  }

  // Sep 2026 backtest: prefer 11–30. DTE ≤9 is a heavy soft demote, not a hard ban
  // (a quiet tape would otherwise go empty). 0–2 DTE stays the lottery hard-fade.
  if (dte >= 11 && dte <= 30) {
    const delta = 12;
    score += delta;
    chips.push(
      chip(
        "dte-sweet",
        "11–30 DTE",
        "boost",
        delta,
        `${dte} DTE sits in the 11–30 primary window. Theta is real, but it is not a same-week lottery.`,
      ),
    );
  } else if (dte >= 31 && dte <= 45) {
    const delta = 8;
    score += delta;
    chips.push(
      chip(
        "dte-ok",
        "31–45 DTE",
        "boost",
        delta,
        `${dte} DTE is still a multi-session contract. The primary band is 11–30.`,
      ),
    );
  } else if (dte <= 2) {
    const delta = -22;
    score += delta;
    chips.push(
      chip(
        "lottery",
        "0–2 DTE lottery",
        "penalty",
        delta,
        `${dte} DTE. These reverse after a few hours more often than they trend.`,
      ),
    );
  } else if (dte <= 9) {
    const delta = -16;
    score += delta;
    chips.push(
      chip(
        "short-dte",
        "Short DTE",
        "penalty",
        delta,
        `${dte} DTE is inside the ≤9 band. Demoted so it rarely leads the card — not removed, so a quiet day still has a board.`,
      ),
    );
  } else if (dte > 90) {
    const delta = -4;
    score += delta;
    chips.push(
      chip("long-dte", "Long-dated", "penalty", delta, `${dte} DTE. Conviction decays into calendar noise.`),
    );
  }

  if (alert.has_sweep) {
    const delta = 8;
    score += delta;
    chips.push(
      chip("sweep", "Sweep", "boost", delta, "Intermarket sweep — urgency across exchanges, not a resting block."),
    );
  }
  if (alert.has_sweep && aggressive) {
    const delta = 3;
    score += delta;
    chips.push(
      chip(
        "ask-sweep",
        "Ask sweep",
        "boost",
        delta,
        "Ask-side sweep. Necessary, not sufficient — Sep 4 still lost several ask-sweep + tide prints that never confirmed.",
      ),
    );
  }

  const otm = alertOtmPct(alert);
  const money = moneynessBand(otm);
  if (money === "sweet" || money === "near-atm") {
    const delta = 3;
    score += delta;
    const pctLabel = otm == null ? "" : `${otm >= 0 ? "+" : ""}${(otm * 100).toFixed(1)}%`;
    chips.push(
      chip(
        "otm-sweet",
        money === "sweet" ? "Modest OTM" : "Near ATM",
        "boost",
        delta,
        `${pctLabel} vs spot. Sep 4: TSLA 350P (near the money) paid; 360P (further ITM) did not.`,
      ),
    );
  } else if (money === "deep-itm") {
    const delta = -8;
    score += delta;
    chips.push(
      chip(
        "deep-itm",
        "Deep ITM",
        "penalty",
        delta,
        `${otm == null ? "" : `${(otm * 100).toFixed(1)}% vs spot. `}Deep ITM is stock-like and expensive. Docked vs a nearer strike.`,
      ),
    );
  } else if (money === "itm") {
    const delta = -4;
    score += delta;
    chips.push(
      chip(
        "itm",
        "ITM",
        "penalty",
        delta,
        `${otm == null ? "" : `${(otm * 100).toFixed(1)}% vs spot. `}Further ITM than the near-ATM strike that paid on Sep 4 (350P vs 360P).`,
      ),
    );
  } else if (money === "far-otm") {
    const delta = -6;
    score += delta;
    chips.push(
      chip(
        "far-otm",
        "Far OTM",
        "penalty",
        delta,
        `${otm == null ? "" : `+${(otm * 100).toFixed(1)}% OTM. `}Lottery convexity — needs a hero move.`,
      ),
    );
  }
  if (alert.has_floor) {
    const delta = 5;
    score += delta;
    chips.push(
      chip("floor", "Floor", "boost", delta, "Floor print. Often institutional, less likely a retail lottery ticket."),
    );
  }
  if (isFloorOnlyCandidate(alert) && !hasSessionAskConfirmation(alert, peers)) {
    const delta = -12;
    score += delta;
    chips.push(
      chip(
        "floor-only",
        "Floor-only / no sweep",
        "penalty",
        delta,
        "Low-historic / floor print without a same-session sweep or second ask-side hit. Whale floor alone fades.",
      ),
    );
  }

  if (alert.has_singleleg && !alert.has_multileg) {
    const delta = 4;
    score += delta;
    chips.push(
      chip(
        "single",
        "Single-leg",
        "boost",
        delta,
        "Clean directional risk. Multi-leg structures hide hedges and spreads.",
      ),
    );
  } else if (alert.has_multileg) {
    const delta = -6;
    score += delta;
    chips.push(
      chip(
        "multi",
        "Multi-leg",
        "penalty",
        delta,
        "Part of a spread. Headline call/put can be the hedge, not the bet.",
      ),
    );
  }

  const tickerTide = context.tickerTide ?? null;
  const marketTide = context.marketTide ?? null;
  const localBias = tickerTide?.bias ?? null;
  const tapeBias = marketTide?.bias ?? null;
  // Market tide fight is call flow into a bearish tape, or put flow into a bullish tape.
  // Ticker-tide fights still use the existing aggressive-flow chip. Sep 2026: 0W / 3L / 74 flat.
  const marketOpposes =
    !!tapeBias &&
    tapeBias !== "neutral" &&
    ((isCall && tapeBias === "bearish") || (!isCall && tapeBias === "bullish"));
  const tickerOpposes =
    aggressive &&
    !!localBias &&
    localBias !== "neutral" &&
    ((isCall && localBias === "bearish") || (!isCall && localBias === "bullish"));
  const marketAligned =
    !!tapeBias &&
    tapeBias !== "neutral" &&
    ((isCall && tapeBias === "bullish") || (!isCall && tapeBias === "bearish"));
  const tickerAligned =
    !!localBias &&
    localBias !== "neutral" &&
    ((isCall && localBias === "bullish") || (!isCall && localBias === "bearish"));

  if (marketOpposes || tickerOpposes) {
    const delta = -24;
    score += delta;
    chips.push(
      chip(
        "fight-tide",
        "Fighting tide",
        "penalty",
        delta,
        marketOpposes
          ? `${alert.type.toUpperCase()} flow against a ${tapeBias} market tide. Sep 2026 backtest: tide fights did not pay (0W / 3L / 74 flat).`
          : `${alert.type.toUpperCase()} buying against a ${localBias} ticker tide. Fade magnet.`,
      ),
    );
  } else if (aggressive && (tickerAligned || marketAligned)) {
    const delta = 6;
    score += delta;
    const useTicker = tickerAligned;
    chips.push(
      chip(
        "with-tide",
        useTicker ? "With ticker tide" : "With market tide",
        "boost",
        delta,
        `${alert.type.toUpperCase()} buying lines up with a ${useTicker ? localBias : tapeBias} tape.`,
      ),
    );
  }

  const ageBand = printAgeBand(alert.created_at, now);
  const hours = hoursSinceCreated(alert.created_at, now);
  if (ageBand === "fresh") {
    const delta = 3;
    score += delta;
    chips.push(
      chip("fresh", "Fresh session", "boost", delta, "Printed in the last two hours. Sep 4 winners were still fresh."),
    );
  } else if (ageBand === "aging") {
    const delta = -12;
    score += delta;
    chips.push(
      chip(
        "aging",
        "Aging print",
        "penalty",
        delta,
        `Print is ${Math.round(hours)}h old. If it has not followed through, conviction should already be fading.`,
      ),
    );
  } else if (ageBand === "aged") {
    const delta = -18;
    score += delta;
    chips.push(
      chip(
        "aged",
        "Aged print",
        "penalty",
        delta,
        `Print is ${Math.round(hours)}h old. Sep 4 book: aged watches (MMM/AVGO/TRMB/PGEN class) got crushed.`,
      ),
    );
  }

  if ((ageBand === "aged" || ageBand === "stale") && isCall) {
    const delta = -6;
    score += delta;
    chips.push(
      chip(
        "aged-call",
        "Aged call watch",
        "penalty",
        delta,
        "Aged call. Sep 4 study: multi-day call watches faded hardest; do not keep this high on the book.",
      ),
    );
  }

  if (
    (ageBand === "aged" || ageBand === "stale") &&
    isFloorOnlyCandidate(alert) &&
    !hasSessionAskConfirmation(alert, peers)
  ) {
    const delta = -8;
    score += delta;
    chips.push(
      chip(
        "aged-floor",
        "Aged floor",
        "penalty",
        delta,
        "Days-old / late-session floor without a fresh ask-sweep. Cannot dominate Picks or Premove.",
      ),
    );
  }

  const peerFade = fadeFromLaterPrints(alert, peers);
  const remoteFade = context.chainFade?.faded ? context.chainFade : null;
  const fadeHit = peerFade.faded ? peerFade : remoteFade;
  if (fadeHit?.faded) {
    const delta = -15;
    score += delta;
    chips.push(
      chip(
        "post-fade",
        "Post-print fade",
        "penalty",
        delta,
        fadeHit.detail || "Later tape on this contract moved against the alert.",
      ),
    );
  }

  const follow = followThroughFromPeers(alert, peers, now);
  if (follow.confirmed) {
    const delta = 5;
    score += delta;
    chips.push(
      chip(
        "follow-thru",
        "Follow-through",
        "boost",
        delta,
        follow.detail,
      ),
    );
  } else if (follow.fading) {
    const delta = -14;
    score += delta;
    chips.push(
      chip(
        "no-follow",
        "One-and-done",
        "penalty",
        delta,
        follow.detail,
      ),
    );
  }

  const stale = ageBand === "stale";
  if (stale) {
    const capped = Math.min(score, STALE_CAP);
    const delta = Math.round(capped - score);
    chips.push(
      chip(
        "stale",
        "Stale print",
        "penalty",
        delta,
        "Created before the prior session’s 9:30 ET. Cap 32 — not today’s tape. Docked for age.",
      ),
    );
    score = capped;
  }

  const fadeProne = chips.some((c) =>
    [
      "lottery",
      "tiny",
      "bid-dom",
      "fight-tide",
      "post-fade",
      "stale",
      "aged",
      "aged-call",
      "aged-floor",
      "no-follow",
    ].includes(c.id),
  );

  const scored = {
    score: Math.round(clamp(score, 0, 100)),
    chips,
    fadeProne,
    stale,
    dte,
    askShare: share,
    marketTideBias: tapeBias,
    tickerTideBias: localBias,
    alert,
  };

  return {
    ...scored,
    holdWindow: buildHoldWindow(scored),
  };
}

export function rankAlerts(
  alerts: FlowAlert[],
  context: {
    marketTide?: TideSnapshot | null;
    tickerTides?: Record<string, TideSnapshot | null>;
    now?: Date;
    chainFades?: Record<string, ChainFadeSignal>;
  } = {},
): RankedFlow[] {
  const scored = alerts.map((alert) =>
    scoreAlert(alert, {
      marketTide: context.marketTide,
      tickerTide: context.tickerTides?.[alert.ticker] ?? null,
      now: context.now,
      peers: alerts,
      chainFade: context.chainFades?.[alert.id] ?? null,
    }),
  );

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return toNumber(b.alert.total_premium) - toNumber(a.alert.total_premium);
  });

  return scored.map((row, index) => ({ ...row, rank: index + 1 }));
}

/** Same contract across Picks and Premove. Chain id when UW sent one, else the alert id. */
export function contractKey(row: Pick<RankedFlow, "alert">): string {
  return row.alert.option_chain || row.alert.id;
}

export function hasScoreChip(row: Pick<RankedFlow, "chips">, id: string): boolean {
  return row.chips.some((chip) => chip.id === id);
}

/**
 * Hard exclude from Picks, Premove, and the morning shortlist.
 * Sep 2026: no follow-through was 6/6 losers; tide fight was 0W / 3L / 74 flat.
 * The live board still ranks these rows (tide fight is only docked there).
 */
export function excludedFromActionable(row: Pick<RankedFlow, "chips">): boolean {
  return hasScoreChip(row, "no-follow") || hasScoreChip(row, "fight-tide");
}

/** Lower sorts first. 11–30 leads; ≤9 trails when scores tie (including the 100 clamp). */
export function dtePreference(dte: number): number {
  if (dte >= 11 && dte <= 30) return 0;
  if (dte >= 31 && dte <= 45) return 1;
  if (dte <= 9) return 3;
  return 2;
}

const BOTH_LANE_DELTA = 8;
const HIGH_SCORE_DELTA = 6;
const HIGH_SCORE_MIN = 90;
const LATE_PRINT_DELTA = -18;

/**
 * Picks / Premove / morning only. Does not change the live-board score from `scoreAlert`.
 * Overlap and ≥90 are boosts. Late-afternoon prints are docked and sorted behind earlier tape.
 */
export function applyActionableOverlay(
  row: RankedFlow,
  opts: { onBoth: boolean; now?: Date },
): RankedFlow {
  const chips = [...row.chips];
  let score = row.score;
  const base = row.score;

  if (opts.onBoth && !hasScoreChip(row, "both")) {
    score += BOTH_LANE_DELTA;
    chips.push(
      chip(
        "both",
        "Both lanes",
        "boost",
        BOTH_LANE_DELTA,
        "Qualifies for Picks and Premove. Sep 2026 backtest: the overlap was the set worth acting on.",
      ),
    );
  }

  if (base >= HIGH_SCORE_MIN && !hasScoreChip(row, "score-90")) {
    score += HIGH_SCORE_DELTA;
    chips.push(
      chip(
        "score-90",
        "Score 90+",
        "boost",
        HIGH_SCORE_DELTA,
        `Base conviction ${base} is at least 90. Preferred on the actionable shortlist.`,
      ),
    );
  }

  if (isLateSessionPrint(row.alert.created_at, opts.now) && !hasScoreChip(row, "late-print")) {
    score += LATE_PRINT_DELTA;
    chips.push(
      chip(
        "late-print",
        "Late print",
        "penalty",
        LATE_PRINT_DELTA,
        "Printed at or after 14:00 ET. Late live-board tape was ~97% flat — still on the board, not the lead of this card.",
      ),
    );
  }

  return {
    ...row,
    score: Math.round(clamp(score, 0, 100)),
    chips,
  };
}

export function withActionableAdjustments(
  rows: RankedFlow[],
  otherKeys: Set<string>,
  now?: Date,
): RankedFlow[] {
  return rows
    .filter((row) => !excludedFromActionable(row))
    .map((row) =>
      applyActionableOverlay(row, {
        onBoth: otherKeys.has(contractKey(row)),
        now,
      }),
    );
}

/** Late prints sort after any earlier-session name, then score, then the 11–30 DTE preference. */
export function compareActionable(a: RankedFlow, b: RankedFlow): number {
  const lateA = hasScoreChip(a, "late-print") ? 1 : 0;
  const lateB = hasScoreChip(b, "late-print") ? 1 : 0;
  if (lateA !== lateB) return lateA - lateB;
  if (b.score !== a.score) return b.score - a.score;
  const dteDelta = dtePreference(a.dte) - dtePreference(b.dte);
  if (dteDelta !== 0) return dteDelta;
  return toNumber(b.alert.total_premium) - toNumber(a.alert.total_premium);
}
