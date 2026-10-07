import "server-only";

import type { ArmingPremium, ArmingSource, WatchQuote } from "@/lib/types";
import { toNumber } from "@/lib/numbers";
import { fetchFlowAlerts, fetchOptionQuoteTraced, hasUnusualWhalesKey } from "@/lib/uw";
import { newerThanParam } from "@/lib/session";
import { etClock } from "@/lib/shadow/budget";
import { isUwHardBlocked, uwCircuitInfo } from "@/lib/uw-quota";

const SOURCE_LABEL: Record<ArmingSource, string> = {
  uw_last: "live UW last",
  uw_nbbo: "live UW mid",
  session_print: "last session print",
  alert: "alert print",
};

export function armingLabel(source: ArmingSource, premium: number): string {
  return `$${premium.toFixed(2)} (${SOURCE_LABEL[source]})`;
}

/** US cash session (9:30–16:00 ET, weekdays). Holidays read as "open" but UW then has no fresh NBBO anyway. */
export function cashSessionOpen(now = new Date()): boolean {
  const c = etClock(now);
  return c.weekday && c.minutes >= 9 * 60 + 30 && c.minutes < 16 * 60;
}

/** Spread sanity: the mid is a fair mark only when the NBBO is two-sided and not absurdly wide. */
function usableMid(q: WatchQuote): number | null {
  const bid = q.bid ?? null;
  const ask = q.ask ?? null;
  if (bid == null || ask == null || !(bid > 0) || !(ask >= bid)) return null;
  const mid = q.mid ?? Math.round(((bid + ask) / 2) * 100) / 100;
  return (ask - bid) / mid <= 0.5 ? mid : null;
}

/**
 * Live premium for one contract.
 * - Cash session: NBBO mid (uw_nbbo); last trade (uw_last) when the book is one-sided/too wide.
 * - After the close / pre-market: last trade or close (uw_last) — the after-hours NBBO is stale or empty.
 * - Only when UW truly has nothing: today's session flow print, then the alert print.
 */
export async function resolveArmingPremium(input: {
  ticker: string;
  option_chain: string;
  alertPrice?: number;
  now?: Date;
}): Promise<ArmingPremium> {
  const alertPrice = input.alertPrice != null && input.alertPrice > 0 ? input.alertPrice : 0;
  const open = cashSessionOpen(input.now ?? new Date());
  const steps: string[] = [];
  const out = (source: ArmingSource, premium: number, asOf: string | null = null, q?: WatchQuote | null): ArmingPremium => ({
    premium,
    source,
    label: armingLabel(source, premium),
    asOf,
    ...(q ? { bid: q.bid, ask: q.ask, last: q.quality === "uw_last" ? q.last : null } : {}),
  });
  const withDiag = async (p: ArmingPremium): Promise<ArmingPremium> => {
    let circuit: Awaited<ReturnType<typeof uwCircuitInfo>> | undefined;
    try {
      circuit = await uwCircuitInfo();
    } catch {
      circuit = undefined;
    }
    return { ...p, diag: { session: open ? "open" : "closed", steps, circuit } };
  };

  let hasKey = false;
  let hardBlocked = false;
  try {
    hasKey = await hasUnusualWhalesKey();
    hardBlocked = hasKey ? await isUwHardBlocked() : false;
  } catch (error) {
    steps.push(`key/circuit check failed: ${error instanceof Error ? error.message.slice(0, 120) : "error"}`);
  }
  if (!hasKey) steps.push("no UW key on server");
  if (hardBlocked) steps.push("UW daily cap circuit open");

  if (hasKey && !hardBlocked && input.option_chain && input.ticker) {
    try {
      const { quote, steps: qSteps } = await fetchOptionQuoteTraced(input.ticker, input.option_chain, alertPrice || undefined, {
        allowShortBlock: true,
        lastTradeFallback: true,
      });
      steps.push(...qSteps);
      if (quote && quote.last > 0 && (quote.quality === "uw_last" || quote.quality === "uw_nbbo")) {
        const mid = usableMid(quote);
        if (open && mid != null) return out("uw_nbbo", mid, quote.asOf, quote);
        if (quote.quality === "uw_last") return out("uw_last", quote.last, quote.asOf, quote);
        // No last trade at all: NBBO-only (mid, else one side).
        return out("uw_nbbo", mid ?? quote.last, quote.asOf, quote);
      }
    } catch (error) {
      steps.push(`quote lookup threw: ${error instanceof Error ? error.message.slice(0, 120) : "error"}`);
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
        steps.push("session flow print used");
        return withDiag(out("session_print", px, same[0]?.created_at ?? null));
      }
      steps.push(`session flow: no print on this contract (${session.length} ticker alerts)`);
    } catch (error) {
      steps.push(`session flow error: ${error instanceof Error ? error.message.slice(0, 120) : "error"}`);
    }
  }

  return withDiag(out("alert", alertPrice > 0 ? alertPrice : 0));
}
