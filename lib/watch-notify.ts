import "server-only";

import { formatPrice, formatSignedPct } from "@/lib/format";
import { notifyChannels, type NotifyResult } from "@/lib/notify";
import { claimNotifySlot } from "@/lib/notify-dedupe";
import type { WatchAlert } from "@/lib/types";

function isActionableFire(alert: WatchAlert): boolean {
  if (alert.type === "adverse" && (alert.status === "adverse" || alert.status === "approaching")) {
    return true;
  }
  return alert.type === "entry_approach" && alert.status === "approaching";
}

function titleFor(alert: WatchAlert): string {
  if (alert.type === "entry_approach") return `FlowGuard · ${alert.ticker} entry`;
  if (alert.status === "adverse") return `FlowGuard · ${alert.ticker} cut`;
  return `FlowGuard · ${alert.ticker} watch`;
}

function bodyFor(alert: WatchAlert): string {
  return `${alert.contract}  last ${formatPrice(alert.last)} vs ${formatPrice(alert.reference)} (${formatSignedPct(alert.pctMove)}). ${alert.hint}. Not a trade.`;
}

export async function notifyWatchAlerts(alerts: WatchAlert[]): Promise<NotifyResult[]> {
  const results: NotifyResult[] = [];
  for (const alert of alerts) {
    if (!isActionableFire(alert)) continue;
    const key = `${alert.watchId}:${alert.status}`;
    if (!(await claimNotifySlot(key))) continue;
    results.push(await notifyChannels(titleFor(alert), bodyFor(alert)));
  }
  return results;
}
