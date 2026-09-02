import type { FlowFilters } from "@/lib/types";

export const DEFAULT_FILTERS: FlowFilters = {
  minPremium: 10_000,
  minDte: 0,
  maxDte: 60,
  side: "all",
  minConviction: 0,
  unusual: true,
  strictAntiFade: false,
  ticker: "",
};

export function parseFlowFilters(searchParams: URLSearchParams): FlowFilters {
  const sideRaw = searchParams.get("side") ?? "all";
  const side = sideRaw === "call" || sideRaw === "put" ? sideRaw : "all";

  return {
    minPremium: Math.max(0, Number(searchParams.get("minPremium") ?? DEFAULT_FILTERS.minPremium) || 0),
    minDte: Math.max(0, Number(searchParams.get("minDte") ?? DEFAULT_FILTERS.minDte) || 0),
    maxDte: Math.max(0, Number(searchParams.get("maxDte") ?? DEFAULT_FILTERS.maxDte) || 180),
    side,
    minConviction: Math.max(0, Number(searchParams.get("minConviction") ?? 0) || 0),
    unusual: (searchParams.get("unusual") ?? "true") !== "false",
    strictAntiFade: searchParams.get("strictAntiFade") === "true",
    ticker: (searchParams.get("ticker") ?? "").trim().toUpperCase(),
  };
}
