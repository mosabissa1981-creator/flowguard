import type { FlowAlert } from "@/lib/types";
import { askShare, toNumber } from "@/lib/numbers";

export type ChainFadeSignal = {
  faded: boolean;
  detail: string;
};

export function isFloorOnlyCandidate(alert: FlowAlert): boolean {
  if (alert.has_sweep) return false;
  if (alert.has_floor) return true;
  return /floor/i.test(alert.alert_rule || "");
}

export function hasSessionAskConfirmation(alert: FlowAlert, peers: FlowAlert[]): boolean {
  if (alert.has_sweep) return true;
  const chain = alert.option_chain;
  if (!chain) return false;
  return peers.some((peer) => {
    if (peer.id === alert.id) return false;
    if (peer.option_chain !== chain) return false;
    return askShare(peer) >= 0.55;
  });
}

function isBidSideDump(alert: FlowAlert): boolean {
  return askShare(alert) < 0.4;
}

export function fadeFromLaterPrints(alert: FlowAlert, peers: FlowAlert[]): ChainFadeSignal {
  const chain = alert.option_chain;
  const alertPx = toNumber(alert.price);
  const alertTs = new Date(alert.created_at).getTime();
  if (!chain || !Number.isFinite(alertTs)) {
    return { faded: false, detail: "" };
  }

  const later = peers.filter((peer) => {
    if (peer.option_chain !== chain) return false;
    const ts = new Date(peer.created_at).getTime();
    return Number.isFinite(ts) && ts > alertTs;
  });

  for (const peer of later) {
    const px = toNumber(peer.price);
    if (alertPx > 0 && px > 0 && px <= alertPx * 0.85) {
      const drop = Math.round((1 - px / alertPx) * 100);
      return {
        faded: true,
        detail: `Later print on ${chain} at $${px.toFixed(2)} is ${drop}% below the alert ($${alertPx.toFixed(2)}).`,
      };
    }
    if (isBidSideDump(peer) && toNumber(peer.total_premium) >= 10_000) {
      return {
        faded: true,
        detail: `Later bid-side selling on ${chain} after the alert (${Math.round((1 - askShare(peer)) * 100)}% bid-side premium).`,
      };
    }
  }

  return { faded: false, detail: "" };
}

export function fadeFromQuote(
  alert: FlowAlert,
  live: number | null | undefined,
): ChainFadeSignal {
  const alertPx = toNumber(alert.price);
  if (!(alertPx > 0) || !(live != null && live > 0)) {
    return { faded: false, detail: "" };
  }
  if (live <= alertPx * 0.85) {
    const drop = Math.round((1 - live / alertPx) * 100);
    return {
      faded: true,
      detail: `Live premium $${live.toFixed(2)} is ${drop}% below the alert print ($${alertPx.toFixed(2)}).`,
    };
  }
  return { faded: false, detail: "" };
}

export function groupPeersByChain(alerts: FlowAlert[]): Map<string, FlowAlert[]> {
  const map = new Map<string, FlowAlert[]>();
  for (const alert of alerts) {
    const chain = alert.option_chain;
    if (!chain) continue;
    const list = map.get(chain) ?? [];
    list.push(alert);
    map.set(chain, list);
  }
  return map;
}
