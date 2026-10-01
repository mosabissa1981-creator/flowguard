import type { FlowAlert } from "@/lib/types";
import { askShare, toNumber } from "@/lib/numbers";
import { alertMs, alertNums } from "@/lib/alert-time";

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


export function fadeFromLaterPrints(alert: FlowAlert, peers: FlowAlert[]): ChainFadeSignal {
  const chain = alert.option_chain;
  const alertPx = toNumber(alert.price);
  const alertTs = alertMs(alert);
  if (!chain || !Number.isFinite(alertTs)) {
    return { faded: false, detail: "" };
  }

  // Single pass in input order (same first-match semantics as before), no allocation.
  for (const peer of peers) {
    if (peer.option_chain !== chain) continue;
    const ts = alertMs(peer);
    if (!(Number.isFinite(ts) && ts > alertTs)) continue;
    const n = alertNums(peer, askShare, toNumber);
    const px = n.price;
    if (alertPx > 0 && px > 0 && px <= alertPx * 0.85) {
      const drop = Math.round((1 - px / alertPx) * 100);
      return {
        faded: true,
        detail: `Later print on ${chain} at $${px.toFixed(2)} is ${drop}% below the alert ($${alertPx.toFixed(2)}).`,
      };
    }
    if (n.askShare < 0.4 && n.premium >= 10_000) {
      return {
        faded: true,
        detail: `Later bid-side selling on ${chain} after the alert (${Math.round((1 - n.askShare) * 100)}% bid-side premium).`,
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
