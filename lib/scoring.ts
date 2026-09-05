import type { FlowAlert, RankedFlow, ScoreChip, TideSnapshot } from "@/lib/types";
import { buildHoldWindow } from "@/lib/hold-window";
import { askShare, clamp, daysToExpiry, toNumber } from "@/lib/numbers";
import {
  fadeFromLaterPrints,
  hasSessionAskConfirmation,
  isFloorOnlyCandidate,
  type ChainFadeSignal,
} from "@/lib/chain-context";
import { hoursSinceCreated, printAgeBand } from "@/lib/session";
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

  if (dte >= 7 && dte <= 45) {
    const delta = 8;
    score += delta;
    chips.push(
      chip(
        "dte-sweet",
        "Sweet-spot DTE",
        "boost",
        delta,
        `${dte} DTE sits in the 7–45 window where theta is real but not a same-day coin flip.`,
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
  } else if (dte < 7) {
    const delta = -6;
    score += delta;
    chips.push(
      chip("short-dte", "Short DTE", "penalty", delta, `${dte} DTE is still lottery-adjacent for swing entries.`),
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
  const fightBias = localBias && localBias !== "neutral" ? localBias : tapeBias;

  if (aggressive && fightBias && fightBias !== "neutral") {
    const aligned =
      (isCall && fightBias === "bullish") || (!isCall && fightBias === "bearish");
    if (aligned) {
      const delta = 6;
      score += delta;
      chips.push(
        chip(
          "with-tide",
          localBias ? "With ticker tide" : "With market tide",
          "boost",
          delta,
          `${alert.type.toUpperCase()} buying lines up with a ${fightBias} tape.`,
        ),
      );
    } else {
      const delta = -10;
      score += delta;
      chips.push(
        chip(
          "fight-tide",
          "Fighting tide",
          "penalty",
          delta,
          `${alert.type.toUpperCase()} buying against a ${fightBias} ${localBias ? "ticker" : "market"} tide. Fade magnet.`,
        ),
      );
    }
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
