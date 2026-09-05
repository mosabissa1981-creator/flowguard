import type { FlowAlert, RankedFlow, ScoreChip } from "@/lib/types";
import { askShare, clamp, toNumber } from "@/lib/numbers";
import { hoursSinceCreated } from "@/lib/session";
import { isFloorOnlyCandidate } from "@/lib/chain-context";
import type { StockState } from "@/lib/uw";

function chip(
  id: string,
  label: string,
  kind: ScoreChip["kind"],
  delta: number,
  detail: string,
): ScoreChip {
  return { id, label, kind, delta, detail };
}

export function tickerAskHits(alert: FlowAlert, peers: FlowAlert[]): FlowAlert[] {
  return peers.filter(
    (peer) => peer.ticker === alert.ticker && askShare(peer) >= 0.55,
  );
}

export function isRepeatedHitsRule(alert: FlowAlert): boolean {
  return /repeatedhits/i.test(alert.alert_rule || "");
}

export function applyPremoveOverlay(
  row: RankedFlow,
  context: {
    peers: FlowAlert[];
    spot?: StockState | null;
    now?: Date;
  },
): RankedFlow {
  const chips = [...row.chips];
  let score = row.score;
  const now = context.now ?? new Date();
  const askHits = tickerAskHits(row.alert, context.peers);
  const chainHits = askHits.filter((peer) => peer.option_chain === row.alert.option_chain);
  const midHits = askHits.filter((peer) => {
    const prem = toNumber(peer.total_premium);
    return prem >= 25_000 && prem <= 150_000;
  });

  if (askHits.length >= 3) {
    const delta = 10;
    score += delta;
    chips.push(
      chip(
        "building",
        "Building ask hits",
        "boost",
        delta,
        `${askHits.length} ask-side prints on ${row.alert.ticker} this session — interest stacking, not a one-off floor.`,
      ),
    );
  } else if (askHits.length === 2 || (isRepeatedHitsRule(row.alert) && row.alert.trade_count >= 8)) {
    const delta = 6;
    score += delta;
    chips.push(
      chip(
        "building",
        "Building ask hits",
        "boost",
        delta,
        askHits.length === 2
          ? `Second ask-side print on ${row.alert.ticker} this session.`
          : `RepeatedHits (${row.alert.trade_count} fills) — tape is working this contract.`,
      ),
    );
  }

  if (chainHits.length >= 2) {
    const delta = 5;
    score += delta;
    chips.push(
      chip(
        "chain-repeat",
        "Same-chain repeats",
        "boost",
        delta,
        `${chainHits.length} ask-side alerts on ${row.alert.option_chain} today.`,
      ),
    );
  }

  if (midHits.length >= 2) {
    const delta = 6;
    score += delta;
    chips.push(
      chip(
        "mid-size",
        "Mid-size stack",
        "boost",
        delta,
        `${midHits.length} hits in the $25k–$150k band. That often shows up before a late whale floor.`,
      ),
    );
  }

  const jumboSolo =
    toNumber(row.alert.total_premium) >= 750_000 && askHits.length <= 1;
  const whaleFloor =
    jumboSolo ||
    (isFloorOnlyCandidate(row.alert) &&
      toNumber(row.alert.total_premium) >= 1_000_000 &&
      askHits.length <= 1);
  if (whaleFloor) {
    const delta = -14;
    score += delta;
    chips.push(
      chip(
        "late-whale",
        "Late whale floor",
        "penalty",
        delta,
        "Single jumbo print. Premove prefers stacked mid-size ask hits, not one late $750k+ floor.",
      ),
    );
  }

  const hours = hoursSinceCreated(row.alert.created_at, now);
  if (hours < 2 && !chips.some((c) => c.id === "fresh")) {
    const delta = 4;
    score += delta;
    chips.push(
      chip("fresh", "Fresh", "boost", delta, "Printed in the last two hours of this cash session."),
    );
  } else if (hours >= 8 || row.stale) {
    const delta = -16;
    score += delta;
    chips.push(
      chip(
        "aged-premove",
        "Too old for Premove",
        "penalty",
        delta,
        "Days-old or late-session print. Premove is for building flow before the move, not an aged whale floor.",
      ),
    );
  }

  const pct = context.spot?.pctFromClose ?? null;
  let extended = false;
  if (pct != null) {
    const alignedUp = row.alert.type === "call" && pct > 0;
    const alignedDown = row.alert.type === "put" && pct < 0;
    const abs = Math.abs(pct);
    if ((row.alert.type === "call" && pct >= 0.05) || (row.alert.type === "put" && pct <= -0.05)) {
      extended = true;
      const delta = -20;
      score += delta;
      chips.push(
        chip(
          "extended",
          "Underlying already extended",
          "penalty",
          delta,
          `Stock is ${Math.round(pct * 1000) / 10}% vs prior close. The move is already underway — not premove.`,
        ),
      );
    } else if ((alignedUp || alignedDown) && abs >= 0.03) {
      const delta = -10;
      score += delta;
      chips.push(
        chip(
          "extended",
          "Underlying already extended",
          "penalty",
          delta,
          `Stock is ${Math.round(pct * 1000) / 10}% vs prior close. Docked — chase risk.`,
        ),
      );
    } else if (abs < 0.02) {
      const delta = 8;
      score += delta;
      chips.push(
        chip(
          "quiet",
          "Quiet underlying",
          "boost",
          delta,
          `Spot ${Math.round(pct * 1000) / 10}% vs prior close (UW stock-state). Flow is building while the stock is still quiet.`,
        ),
      );
    }
  }

  const fadeProne = row.fadeProne || extended || chips.some((c) => c.id === "late-whale");
  return {
    ...row,
    score: Math.round(clamp(score, 0, 100)),
    chips,
    fadeProne,
    holdWindow:
      row.dte >= 30
        ? {
            label: "up to ~1–2 weeks",
            line: "Hold window: up to ~1–2 weeks; cut by ~half DTE if thesis stalls",
            exit: "Exit if thesis fails or by two weeks. Do not hold this option to expiry.",
          }
        : {
            label: "2–7 sessions",
            line: "Hold window: 2–7 sessions",
            exit: "Exit if thesis fails or by seven sessions.",
          },
  };
}

export function isJumboSoloFloor(row: RankedFlow, peers: FlowAlert[]): boolean {
  const askHits = tickerAskHits(row.alert, peers);
  const prem = toNumber(row.alert.total_premium);
  const floorRule = /lowhistoricvolumefloor/i.test(row.alert.alert_rule || "");
  if (askHits.length >= 2) return false;
  if (prem >= 750_000) return true;
  if (floorRule && prem >= 250_000) return true;
  return false;
}

export function hasPremoveAccumulation(row: RankedFlow, peers: FlowAlert[]): boolean {
  if (isJumboSoloFloor(row, peers)) return false;
  const askHits = tickerAskHits(row.alert, peers);
  if (askHits.length >= 2) return true;
  const prem = toNumber(row.alert.total_premium);
  if (prem >= 750_000) return false;
  return isRepeatedHitsRule(row.alert) && row.alert.trade_count >= 8 && row.askShare >= 0.55;
}
