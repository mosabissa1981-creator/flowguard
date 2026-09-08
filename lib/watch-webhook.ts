import "server-only";

import type { PriceWatch } from "@/lib/types";
import { contractLabel } from "@/lib/price-watches";

export async function fireWebhook(
  watch: PriceWatch,
  action: "armed" | "removed" | "expired",
): Promise<{ sent: boolean; error?: string }> {
  const url = process.env.WATCH_WEBHOOK_URL?.trim();
  const secret = process.env.WATCH_WEBHOOK_SECRET?.trim();
  if (!url) return { sent: false, error: "WATCH_WEBHOOK_URL not set" };

  const payload = {
    action,
    watchId: watch.id,
    kind: watch.kind,
    ticker: watch.ticker,
    contract: contractLabel(watch),
    option_chain: watch.option_chain,
    strike: watch.strike,
    expiry: watch.expiry,
    type: watch.type,
    referencePremium: watch.referencePremium,
    adversePct: watch.adversePct,
    approachPct: watch.approachPct,
    stopPremium: watch.stopPremium ?? null,
    createdAt: watch.createdAt,
    firedAt: new Date().toISOString(),
  };

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (secret) headers["X-FlowGuard-Secret"] = secret;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return { sent: false, error: `Webhook returned ${response.status}` };
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, error: error instanceof Error ? error.message : "Webhook failed" };
  }
}
