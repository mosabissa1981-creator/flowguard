import type { OptionType } from "@/lib/types";

export const WATCHLIST_KEY = "flowguard.watchlist";
export const NOTES_KEY = "flowguard.notes";
export const DISMISSED_KEY = "flowguard.dismissed";

export type WatchTarget = {
  id: string;
  kind: "ticker" | "contract";
  ticker: string;
  option_chain?: string;
  strike?: string;
  expiry?: string;
  type?: OptionType;
  addedAt: string;
};

export type ManagerNoteMap = Record<string, string>;

export type DismissedAlert = {
  id: string;
  ticker: string;
  option_chain: string;
  dismissedAt: string;
};

export const EMPTY_WATCHLIST: WatchTarget[] = [];
export const EMPTY_NOTES: ManagerNoteMap = {};
export const EMPTY_DISMISSED: DismissedAlert[] = [];


export function watchTickerId(ticker: string): string {
  return `ticker:${ticker.toUpperCase()}`;
}

export function watchContractId(optionChain: string): string {
  return `contract:${optionChain}`;
}

export function makeTickerTarget(ticker: string): WatchTarget {
  const symbol = ticker.trim().toUpperCase();
  return {
    id: watchTickerId(symbol),
    kind: "ticker",
    ticker: symbol,
    addedAt: new Date().toISOString(),
  };
}

export function makeContractTarget(input: {
  ticker: string;
  option_chain: string;
  strike?: string;
  expiry?: string;
  type?: OptionType;
}): WatchTarget {
  return {
    id: watchContractId(input.option_chain),
    kind: "contract",
    ticker: input.ticker.toUpperCase(),
    option_chain: input.option_chain,
    strike: input.strike,
    expiry: input.expiry,
    type: input.type,
    addedAt: new Date().toISOString(),
  };
}

export function isWatched(
  targets: WatchTarget[],
  ticker: string,
  optionChain?: string,
): boolean {
  return targets.some((target) => {
    if (target.kind === "ticker") return target.ticker === ticker;
    return Boolean(optionChain) && target.option_chain === optionChain;
  });
}

export function tickerWatched(targets: WatchTarget[], ticker: string): boolean {
  return targets.some((target) => target.kind === "ticker" && target.ticker === ticker);
}

export function contractWatched(targets: WatchTarget[], optionChain: string): boolean {
  return targets.some((target) => target.kind === "contract" && target.option_chain === optionChain);
}

export function parseTickerInput(raw: string): string | null {
  const symbol = raw.trim().toUpperCase().replace(/[^A-Z.]/g, "");
  if (symbol.length < 1 || symbol.length > 8) return null;
  return symbol;
}
