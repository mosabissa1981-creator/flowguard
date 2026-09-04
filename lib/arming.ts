import "server-only";

import type { ArmingPremium, ArmingSource } from "@/lib/types";
import { toNumber } from "@/lib/numbers";
import { fetchFlowAlerts, fetchOptionQuote, hasUnusualWhalesKey } from "@/lib/uw";
import { newerThanParam } from "@/lib/session";
import { isUwBlocked } from "@/lib/uw-quota";

const SOURCE_LABEL: Record<ArmingSource, string> = {
  uw_last: "live UW last",
  uw_nbbo: "live UW mid",
  session_print: "last session print",
  alert: "alert print",
};

export function armingLabel(source: ArmingSource, premium: number): string {
  return `$${premium.toFixed(2)} (${SOURCE_LABEL[source]})`;
}

export async function resolveArmingPremium(input: {
  ticker: string;
  option_chain: string;
  alertPrice?: number;
}): Promise<ArmingPremium> {
  const alertPrice = input.alertPrice != null && input.alertPrice > 0 ? input.alertPrice : 0;
  const fallback = (source: ArmingSource, premium: number, asOf: string | null = null): ArmingPremium => ({
    premium,
    source,
    label: armingLabel(source, premium),
    asOf,
  });

  if ((await hasUnusualWhalesKey()) && input.option_chain && input.ticker && !(await isUwBlocked())) {
    try {
      const quote = await fetchOptionQuote(input.ticker, input.option_chain, alertPrice || undefined);
      if (quote && quote.last > 0 && (quote.quality === "uw_last" || quote.quality === "uw_nbbo")) {
        return fallback(quote.quality === "uw_nbbo" ? "uw_nbbo" : "uw_last", quote.last, quote.asOf);
      }
    } catch {
      // Last session print / alert price still work.
    }

    try {
      const session = await fetchFlowAlerts({
        ticker: input.ticker,
        newerThan: newerThanParam(),
        limit: 50,
        maxPages: 1,
      });
      const same = session
        .filter((row) => row.option_chain === input.option_chain)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const px = toNumber(same[0]?.price);
      if (px > 0) {
        return fallback("session_print", px, same[0]?.created_at ?? null);
      }
    } catch {
      // Alert price is the last resort.
    }
  }

  if (alertPrice > 0) return fallback("alert", alertPrice);
  return fallback("alert", 0);
}
