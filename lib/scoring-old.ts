/**
 * Frozen Friday-afternoon scorer (commit ea89664), before the Sep 4 study
 * haircuts and follow-through layer. Used only for local book reviews.
 */
import type { FlowAlert, RankedFlow, ScoreChip, TideSnapshot } from "@/lib/types";
import { buildHoldWindow } from "@/lib/hold-window";
import { askShare, clamp, daysToExpiry, toNumber } from "@/lib/numbers";
import {
  fadeFromLaterPrints,
  hasSessionAskConfirmation,
  isFloorOnlyCandidate,
  type ChainFadeSignal,
} from "@/lib/chain-context";
import { hoursSinceCreated, isStalePrint } from "@/lib/session";

const BASE_SCORE = 32;
const STALE_CAP = 40;

function chip(
  id: string,
  label: string,
  kind: ScoreChip["kind"],
  delta: number,
  detail: string,
): ScoreChip {
  return { id, label, kind, delta, detail };
}

/** OLD aging: 4–24h, not the later 4–8h band. */
function isOldAgingPrint(createdAt: string, now: Date): boolean {
  if (isStalePrint(createdAt, now)) return false;
  const hours = hoursSinceCreated(createdAt, now);
  return hours >= 4 && hours < 24;
}

export function scoreAlertOld(
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
    score += 12;
    chips.push(chip("ask-dom", "Ask-side dominance", "boost", 12, "OLD +12"));
  } else if (share >= 0.6) {
    score += 6;
    chips.push(chip("ask-lean", "Ask-side lean", "boost", 6, "OLD +6"));
  } else if (share < 0.4) {
    score += -16;
    chips.push(chip("bid-dom", "Bid-dominant", "penalty", -16, "OLD −16"));
  }

  if (alert.all_opening_trades) {
    score += 10;
    chips.push(chip("opening", "All opening", "boost", 10, "OLD +10"));
  }

  if (volOi >= 3) {
    score += 8;
    chips.push(chip("voi-high", "High vol/OI", "boost", 8, "OLD +8"));
  } else if (volOi >= 1) {
    score += 5;
    chips.push(chip("voi", "Vol > OI", "boost", 5, "OLD +5"));
  }

  if (premium >= 1_000_000) {
    score += 10;
    chips.push(chip("whale", "Whale premium", "boost", 10, "OLD +10"));
  } else if (premium >= 250_000) {
    score += 7;
    chips.push(chip("prem-fat", "Meaningful premium", "boost", 7, "OLD +7"));
  } else if (premium >= 75_000) {
    score += 4;
    chips.push(chip("prem-ok", "Solid premium", "boost", 4, "OLD +4"));
  } else if (premium > 0 && premium < 25_000) {
    score += -14;
    chips.push(chip("tiny", "Tiny premium", "penalty", -14, "OLD −14"));
  }

  if (dte >= 7 && dte <= 45) {
    score += 8;
    chips.push(chip("dte-sweet", "Sweet-spot DTE", "boost", 8, "OLD +8"));
  } else if (dte <= 2) {
    score += -22;
    chips.push(chip("lottery", "0–2 DTE lottery", "penalty", -22, "OLD −22"));
  } else if (dte < 7) {
    score += -6;
    chips.push(chip("short-dte", "Short DTE", "penalty", -6, "OLD −6"));
  } else if (dte > 90) {
    score += -4;
    chips.push(chip("long-dte", "Long-dated", "penalty", -4, "OLD −4"));
  }

  if (alert.has_sweep) {
    score += 6;
    chips.push(chip("sweep", "Sweep", "boost", 6, "OLD +6 — no ask-sweep chip yet"));
  }
  if (alert.has_floor) {
    score += 5;
    chips.push(chip("floor", "Floor", "boost", 5, "OLD +5"));
  }
  if (isFloorOnlyCandidate(alert) && !hasSessionAskConfirmation(alert, peers)) {
    score += -8;
    chips.push(chip("floor-only", "Floor-only / no sweep", "penalty", -8, "OLD −8"));
  }

  if (alert.has_singleleg && !alert.has_multileg) {
    score += 4;
    chips.push(chip("single", "Single-leg", "boost", 4, "OLD +4"));
  } else if (alert.has_multileg) {
    score += -6;
    chips.push(chip("multi", "Multi-leg", "penalty", -6, "OLD −6"));
  }

  const tickerTide = context.tickerTide ?? null;
  const marketTide = context.marketTide ?? null;
  const localBias = tickerTide?.bias ?? null;
  const tapeBias = marketTide?.bias ?? null;
  const fightBias = localBias && localBias !== "neutral" ? localBias : tapeBias;

  if (aggressive && fightBias && fightBias !== "neutral") {
    const aligned =
      (isCall && fightBias === "bullish") || (!isCall && fightBias === "bearish");
    if (aligned) {
      score += 4;
      chips.push(chip("with-tide", "With tide", "boost", 4, "OLD +4"));
    } else {
      score += -10;
      chips.push(chip("fight-tide", "Fighting tide", "penalty", -10, "OLD −10"));
    }
  }

  if (isOldAgingPrint(alert.created_at, now)) {
    score += -12;
    chips.push(chip("aging", "Aging print", "penalty", -12, "OLD −12 for any 4–24h print"));
  }

  const peerFade = fadeFromLaterPrints(alert, peers);
  const remoteFade = context.chainFade?.faded ? context.chainFade : null;
  const fadeHit = peerFade.faded ? peerFade : remoteFade;
  if (fadeHit?.faded) {
    score += -15;
    chips.push(chip("post-fade", "Post-print fade", "penalty", -15, fadeHit.detail));
  }

  const stale = isStalePrint(alert.created_at, now);
  if (stale) {
    const capped = Math.min(score, STALE_CAP);
    chips.push(chip("stale", "Stale print", "penalty", Math.round(capped - score), "OLD cap 40"));
    score = capped;
  }

  const fadeProne = chips.some((c) =>
    ["lottery", "tiny", "bid-dom", "fight-tide", "post-fade", "stale"].includes(c.id),
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
