import type { FlowAlert } from "@/lib/types";
import { askShare, toNumber } from "@/lib/numbers";
import { hoursSinceCreated, printAgeBand } from "@/lib/session";

/** Hours after a print before missing confirmation counts as one-and-done. */
export const FOLLOW_THROUGH_GRACE_HOURS = 2;

/** Premium must be at least this far above the print / arm to count as confirmation. */
export const FOLLOW_THROUGH_UP_PCT = 0.05;

/** Live last this far below arm → hard-expire and delete (Sep 8 book, MMM class). */
export const HARD_EXPIRE_DOWN_PCT = 0.4;

export type FollowThroughStatus = "confirmed" | "fading" | "pending" | "unknown";

export type FollowThroughSignal = {
  status: FollowThroughStatus;
  detail: string;
  confirmed: boolean;
  fading: boolean;
};

export type HistoricBar = {
  date: string;
  last: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  askVolume: number;
  bidVolume: number;
  sweepVolume: number;
  impliedVolatility: number | null;
  ivHigh: number | null;
  ivLow: number | null;
  openInterest: number | null;
  totalPremium: number | null;
  volume: number | null;
  lastTapeTime: string | null;
  nbboBid: number | null;
  nbboAsk: number | null;
};

function signal(
  status: FollowThroughStatus,
  detail: string,
): FollowThroughSignal {
  return {
    status,
    detail,
    confirmed: status === "confirmed",
    fading: status === "fading",
  };
}

function laterPeers(alert: FlowAlert, peers: FlowAlert[]): FlowAlert[] {
  const alertTs = new Date(alert.created_at).getTime();
  if (!Number.isFinite(alertTs)) return [];
  return peers.filter((peer) => {
    if (peer.id === alert.id) return false;
    const ts = new Date(peer.created_at).getTime();
    return Number.isFinite(ts) && ts > alertTs;
  });
}

/** Confirming ask-side flow after the print, from the shared session tape. No UW. */
export function followThroughFromPeers(
  alert: FlowAlert,
  peers: FlowAlert[],
  now = new Date(),
): FollowThroughSignal {
  const hours = hoursSinceCreated(alert.created_at, now);
  const later = laterPeers(alert, peers);
  const alertPx = toNumber(alert.price);

  const laterAsk = later.filter((peer) => {
    const sameChain = Boolean(alert.option_chain) && peer.option_chain === alert.option_chain;
    const sameSide = peer.ticker === alert.ticker && peer.type === alert.type;
    if (!sameChain && !sameSide) return false;
    return askShare(peer) >= 0.55 && toNumber(peer.total_premium) >= 10_000;
  });

  const laterUp = later.find((peer) => {
    if (!alert.option_chain || peer.option_chain !== alert.option_chain) return false;
    const px = toNumber(peer.price);
    return alertPx > 0 && px > 0 && px >= alertPx * (1 + FOLLOW_THROUGH_UP_PCT);
  });

  if (laterAsk.length > 0 || laterUp) {
    const chainHits = laterAsk.filter((peer) => peer.option_chain === alert.option_chain).length;
    const detail = laterUp
      ? `Later print on ${alert.option_chain} at $${toNumber(laterUp.price).toFixed(2)} is up vs the alert.`
      : chainHits > 0
        ? `${chainHits} later ask-side hit${chainHits === 1 ? "" : "s"} on ${alert.option_chain}.`
        : `Later ask-side ${alert.type} flow on ${alert.ticker} after the print.`;
    return signal("confirmed", detail);
  }

  if (hours < FOLLOW_THROUGH_GRACE_HOURS) {
    return signal("pending", "Inside the 2h grace window — follow-through not required yet.");
  }

  return signal(
    "fading",
    `No confirming ask-side print or rising premium in ${Math.round(hours)}h. Ask-sweep + tide is not enough alone.`,
  );
}

/** Last vs arm / prior bar / open, plus ask vs bid volume and IV crush — from one historic payload. */
export function followThroughFromHistoric(
  bars: HistoricBar[] | null | undefined,
  referencePremium: number,
): FollowThroughSignal {
  if (!bars || bars.length === 0 || !(referencePremium > 0)) {
    return signal("unknown", "No historic path.");
  }

  const latest = bars[bars.length - 1];
  const prior = bars.length >= 2 ? bars[bars.length - 2] : null;
  const last = latest.last;
  if (!(last != null && last > 0)) {
    return signal("unknown", "Historic bar has no last.");
  }

  const ask = latest.askVolume;
  const bid = latest.bidVolume;
  const sided = ask + bid;
  const askHeavy = sided > 0 && ask / sided >= 0.58;
  const bidHeavy = sided > 0 && bid / sided >= 0.58;

  if (last >= referencePremium * (1 + FOLLOW_THROUGH_UP_PCT)) {
    return signal(
      "confirmed",
      `Historic last $${last.toFixed(2)} is up vs arm $${referencePremium.toFixed(2)}.`,
    );
  }
  if (prior?.last && prior.last > 0 && last >= prior.last * 1.03) {
    return signal(
      "confirmed",
      `Historic last $${last.toFixed(2)} is up vs prior session $${prior.last.toFixed(2)}.`,
    );
  }
  if (latest.open && latest.open > 0 && last >= latest.open * 1.04 && askHeavy) {
    return signal(
      "confirmed",
      `Last $${last.toFixed(2)} is up vs open $${latest.open.toFixed(2)} with ask-side volume.`,
    );
  }

  const downVsArm = last <= referencePremium * 0.85;
  const downVsPrior = Boolean(prior?.last && prior.last > 0 && last <= prior.last * 0.85);
  const ivCrush =
    prior?.impliedVolatility != null &&
    latest.impliedVolatility != null &&
    prior.impliedVolatility > 0 &&
    latest.impliedVolatility < prior.impliedVolatility * 0.85 &&
    last < referencePremium;

  if (downVsArm || downVsPrior || (bidHeavy && last < referencePremium * 0.95) || ivCrush) {
    const drop = Math.round((1 - last / referencePremium) * 100);
    return signal(
      "fading",
      ivCrush
        ? `IV crushed and last $${last.toFixed(2)} is below arm.`
        : `Historic last $${last.toFixed(2)} is ${drop}% below arm $${referencePremium.toFixed(2)}.`,
    );
  }

  return signal("pending", "Historic path is flat — not yet confirmed.");
}

export function followThroughFromQuote(
  referencePremium: number,
  live: number | null | undefined,
): FollowThroughSignal {
  if (!(referencePremium > 0) || !(live != null && live > 0)) {
    return signal("unknown", "No live premium.");
  }
  if (live >= referencePremium * (1 + FOLLOW_THROUGH_UP_PCT)) {
    return signal(
      "confirmed",
      `Live $${live.toFixed(2)} is up vs arm $${referencePremium.toFixed(2)}.`,
    );
  }
  if (live <= referencePremium * 0.85) {
    const drop = Math.round((1 - live / referencePremium) * 100);
    return signal("fading", `Live $${live.toFixed(2)} is ${drop}% below arm.`);
  }
  return signal("pending", "Live premium has not confirmed the print.");
}

/** Confirmed wins; fading if any input faded and none confirmed; else pending/unknown. */
export function mergeFollowThrough(parts: FollowThroughSignal[]): FollowThroughSignal {
  const confirmed = parts.find((part) => part.confirmed);
  if (confirmed) return confirmed;
  const fading = parts.find((part) => part.fading);
  if (fading) return fading;
  const pending = parts.find((part) => part.status === "pending");
  if (pending) return pending;
  return parts[0] ?? signal("unknown", "No follow-through signal.");
}

export type WatchLifecycle = {
  expired: boolean;
  fading: boolean;
  hint: string | null;
};

/**
 * One session without premium follow-through → expire.
 * Aged call watches without follow-through → hard expire (MMM class).
 * GH-class (last still ≥+5% or historic confirmed) stays armed.
 */
export function watchLifecycle(
  watch: {
    createdAt?: string;
    type: "call" | "put";
    referencePremium: number;
  },
  quoteLast: number | null | undefined,
  historic: HistoricBar[] | null | undefined,
  now = new Date(),
): WatchLifecycle {
  if (!watch.createdAt) {
    return { expired: false, fading: false, hint: null };
  }

  const band = printAgeBand(watch.createdAt, now);
  const quoteFt = followThroughFromQuote(watch.referencePremium, quoteLast);
  const histFt = followThroughFromHistoric(historic, watch.referencePremium);
  const merged = mergeFollowThrough([quoteFt, histFt]);
  const followed = merged.confirmed;
  const histLast = historic?.length ? historic[historic.length - 1]?.last : null;
  const last = quoteLast != null && quoteLast > 0 ? quoteLast : histLast;
  if (
    last != null &&
    last > 0 &&
    watch.referencePremium > 0 &&
    last <= watch.referencePremium * (1 - HARD_EXPIRE_DOWN_PCT)
  ) {
    const drop = Math.round((1 - last / watch.referencePremium) * 100);
    return {
      expired: true,
      fading: true,
      hint: `watch expired — premium −${drop}% vs arm (≤−40%)`,
    };
  }

  if ((band === "stale" || band === "aged") && watch.type === "call" && !followed) {
    return {
      expired: true,
      fading: true,
      hint: "aged call watch expired — no premium follow-through",
    };
  }

  if (band === "stale" && !followed) {
    return {
      expired: true,
      fading: true,
      hint: "watch expired — no premium follow-through after 1 session",
    };
  }

  if (merged.fading && !followed && band === "stale") {
    return {
      expired: true,
      fading: true,
      hint: "watch expired — thesis fading after 1 session",
    };
  }

  if (merged.fading && !followed) {
    return { expired: false, fading: true, hint: "thesis fading" };
  }

  if ((band === "aged" || band === "stale") && !followed) {
    return { expired: false, fading: true, hint: "thesis fading" };
  }

  return { expired: false, fading: false, hint: null };
}
