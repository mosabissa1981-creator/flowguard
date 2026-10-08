import "server-only";

import { loadRankedFlow } from "@/lib/flow-service";
import { buildPickCopy } from "@/lib/thesis";
import { PICKS_FILTERS } from "@/lib/filters";
import { MAX_PICKS } from "@/lib/picks";
import { loadPremoveContext } from "@/lib/premove";
import { applyConcentrationCaps } from "@/lib/issuers";
import { buildExitPlan } from "@/lib/exit-plan";
import { loadRegimeSafe, regimeBrief, regimeCaps, regimeListCap, toActionableRegime } from "@/lib/regime";
import { compareActionable, contractKey, withActionableAdjustments } from "@/lib/scoring";
import { resolveSpread } from "@/lib/spread-core";
import { SINGLE_STOCK_PUT_REASON, blockedByPutsRule } from "@/lib/puts-rule";
import { gateRankedRows } from "@/lib/spread-gate";
import type { MorningShortlistResponse } from "@/lib/types";
import {
  isInMorningWindow,
  morningWindowClosed,
  sessionMorningCutoffUtc,
  sessionHasOpened,
  tradingDateET,
} from "@/lib/session";
import { loadMorningSnapshot, saveMorningSnapshot } from "@/lib/uw-quota";

const MAX_MORNING = 8;

/**
 * LIVE puts rule on a frozen snapshot (saved before the rule went live, or by an older build): drop
 * single-stock puts and list them as skipped. No re-ranking: the frozen list stays as it was otherwise.
 */
function applyPutsRuleToFrozen(snap: MorningShortlistResponse): MorningShortlistResponse {
  const blocked = (r: MorningShortlistResponse["picks"][number]) => blockedByPutsRule(r.alert.type, r.alert.ticker, r.alert.issue_type);
  const out = snap.picks.filter(blocked);
  if (out.length === 0) return snap;
  const have = new Set((snap.spreadSkips ?? []).map((s) => s.option_chain));
  const added = out
    .filter((r) => !have.has(contractKey(r)))
    .map((r) => ({
      option_chain: contractKey(r),
      ticker: r.alert.ticker,
      reason: SINGLE_STOCK_PUT_REASON,
      rule: "puts" as const,
      spread: r.spread ?? resolveSpread(null, { bid: r.alert.bid, ask: r.alert.ask }),
      list: "morning",
    }));
  return { ...snap, picks: snap.picks.filter((r) => !blocked(r)), spreadSkips: [...(snap.spreadSkips ?? []), ...added] };
}

export async function loadMorningShortlist(): Promise<MorningShortlistResponse> {
  const today = tradingDateET();
  const label = `Morning shortlist — frozen ${today} 9:30–10:00 ET`;

  const stored = await loadMorningSnapshot<MorningShortlistResponse>(today);
  if (stored?.picks && morningWindowClosed() && stored.source !== "mock") {
    return applyPutsRuleToFrozen({ ...stored, snapshotLabel: stored.snapshotLabel || label, frozen: true });
  }

  if (!sessionHasOpened()) {
    return {
      source: "live",
      fetchedAt: new Date().toISOString(),
      tradingDate: today,
      snapshotLabel: label,
      frozen: true,
      picks: [],
      tide: null,
      warning: `Morning window starts 9:30 ET ${today}.`,
    };
  }

  const ranked = await loadRankedFlow({
    ...PICKS_FILTERS,
    minConviction: 55,
    strictAntiFade: true,
  });

  const [premove, regime] = await Promise.all([loadPremoveContext(), loadRegimeSafe(ranked.tide)]);
  const morningAlerts = withActionableAdjustments(
    ranked.items.filter((row) => isInMorningWindow(row.alert.created_at)),
    premove.keys,
    undefined,
    { spots: premove.spots, regime: toActionableRegime(regime) },
  );
  morningAlerts.sort(compareActionable);

  // LIVE spread gate (> SPREAD_MAX_PCT of mid → excluded, listed as "Skipped: wide spread X%").
  const gate = await gateRankedRows(morningAlerts, "morning");

  const { kept, dropped } = applyConcentrationCaps(
    gate.kept,
    regimeListCap(regime, Math.min(MAX_PICKS, MAX_MORNING)),
    regimeCaps(regime),
  );
  const picks = kept.map((row, index) => {
    const copy = buildPickCopy(row);
    return {
      ...row,
      rank: index + 1,
      ...copy,
      exitPlan: buildExitPlan(row, { riskyRegime: Boolean(regime?.rules.active), ivEvents: regime?.ivEvents }),
    };
  });

  const overlap = regime?.lockout.windows.find((w) => {
    const start = Date.parse(w.start);
    // Morning window is 9:30–10:00 ET; any lockout starting before 10:00 ET overlaps it.
    return start < sessionMorningCutoffUtc().getTime();
  });
  const lockNote = overlap
    ? ` Morning window overlapped the ${overlap.event} lockout — study-only; new picks resume after ${new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(overlap.end))} ET.`
    : "";

  const result: MorningShortlistResponse = {
    source: ranked.source,
    fetchedAt: ranked.fetchedAt,
    tradingDate: today,
    snapshotLabel: label,
    frozen: true,
    picks,
    tide: ranked.tide,
    quotaBlocked: ranked.quotaBlocked,
    authFailed: ranked.authFailed,
    regime: regimeBrief(regime),
    capDrops: dropped,
    spreadSkips: gate.skipped,
    warning:
      ranked.quotaBlocked
        ? ranked.warning
        : ranked.authFailed
          ? ranked.warning
        : morningAlerts.length === 0
          ? `No setups in the 9:30–10:00 ET window on ${today}. Not substituting older whale floors.`
          : ranked.warning
            ? `${ranked.warning}${lockNote}`
            : lockNote.trim() || undefined,
  };

  // Save after the window closes, and also during the window when there is a list, so a
  // hit at ~9:50 ET still freezes something (afternoon re-scoring ages these prints out).
  if (result.source !== "mock" && !result.quotaBlocked && (morningWindowClosed() || (picks.length > 0 && !regime?.lockout.active))) {
    void saveMorningSnapshot(today, result);
  }

  return result;
}
