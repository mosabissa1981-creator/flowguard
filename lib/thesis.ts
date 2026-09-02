import type { RankedFlow, ScoreChip } from "@/lib/types";
import { formatDte, formatExpiry, formatPremium, formatStrike } from "@/lib/format";

export type PickCopy = {
  thesis: string;
  fadeRisks: string[];
};

function hasChip(chips: ScoreChip[], id: string) {
  return chips.some((chip) => chip.id === id);
}

function contractLabel(row: RankedFlow): string {
  const { alert, dte } = row;
  return `${alert.ticker} ${formatStrike(alert.strike)}${alert.type === "call" ? "C" : "P"} ${formatExpiry(alert.expiry)} (${formatDte(dte)})`;
}

export function buildPickCopy(row: RankedFlow): PickCopy {
  const { alert, chips, askShare, tickerTideBias, marketTideBias } = row;
  const side = alert.type === "call" ? "calls" : "puts";
  const lean = alert.type === "call" ? "bullish" : "bearish";
  const reasons: string[] = [];

  reasons.push(
    `${contractLabel(row)} is a ${lean} options setup, not a stock pick — the tape is buying ${side} with ${formatPremium(alert.total_premium)} in premium.`,
  );

  const mechanics: string[] = [];
  if (hasChip(chips, "ask-dom") || hasChip(chips, "ask-lean")) {
    mechanics.push(
      `${Math.round(askShare * 100)}% of sided premium hit the ask, so this looks like taking, not a dump into bids`,
    );
  }
  if (hasChip(chips, "opening")) {
    mechanics.push("size cleared open interest (all opening)");
  }
  if (hasChip(chips, "voi-high") || hasChip(chips, "voi")) {
    mechanics.push(`volume/OI ${Number(alert.volume_oi_ratio).toFixed(2)}x`);
  }
  if (hasChip(chips, "dte-sweet")) {
    mechanics.push("DTE sits in the 7–45 hold window instead of a same-day lottery");
  }
  if (hasChip(chips, "sweep")) mechanics.push("intermarket sweep");
  if (hasChip(chips, "floor")) mechanics.push("floor print");
  if (hasChip(chips, "single")) mechanics.push("single-leg, so the headline call/put is the bet");
  if (hasChip(chips, "with-tide")) {
    const bias = tickerTideBias && tickerTideBias !== "neutral" ? tickerTideBias : marketTideBias;
    mechanics.push(`aligned with a ${bias ?? "supportive"} ${tickerTideBias ? "ticker" : "market"} tide`);
  }

  if (mechanics.length > 0) {
    reasons.push(`Favored because ${mechanics.join("; ")}.`);
  }

  const fadeRisks: string[] = [];
  for (const chip of chips.filter((item) => item.kind === "penalty")) {
    fadeRisks.push(chip.detail);
  }

  if (row.dte <= 10 && !hasChip(chips, "lottery")) {
    fadeRisks.push(
      `${row.dte} DTE still bleeds if the move does not follow through within a session or two.`,
    );
  }
  if (!hasChip(chips, "opening")) {
    fadeRisks.push("Not tagged all-opening — some of this size could be closing or rolling.");
  }
  if (alert.has_multileg) {
    fadeRisks.push("Multi-leg flow can be a hedge; the listed call/put may not be the residual risk.");
  }

  fadeRisks.push(
    "High-conviction flow still fades when the name mean-reverts after the print. This is a screener, not an entry ticket.",
  );

  const unique = [...new Set(fadeRisks)].slice(0, 4);
  return { thesis: reasons.join(" "), fadeRisks: unique };
}
