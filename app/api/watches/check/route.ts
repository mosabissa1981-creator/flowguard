import { NextRequest } from "next/server";

import { buildCheckResponse, evaluateWatch, isPriceWatch } from "@/lib/price-watches";
import { fetchOptionQuotes, hasUnusualWhalesKey, quoteFromFlowPrint } from "@/lib/uw";
import { loadStoredWatches } from "@/lib/watch-store";
import type { PriceWatch } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: { watches?: unknown };
  try {
    body = (await request.json()) as { watches?: unknown };
  } catch {
    return Response.json({ error: "Send JSON { watches }." }, { status: 400 });
  }

  const incoming = Array.isArray(body.watches) ? body.watches.filter(isPriceWatch) : [];
  const watches: PriceWatch[] = incoming.length > 0 ? incoming : await loadStoredWatches();

  const quotes = hasUnusualWhalesKey()
    ? await fetchOptionQuotes(
        watches.map((watch) => ({
          ticker: watch.ticker,
          option_chain: watch.option_chain,
          lastFlowPrint: watch.lastFlowPrint,
        })),
      )
    : Object.fromEntries(
        watches.map((watch) => [watch.option_chain, quoteFromFlowPrint(watch.lastFlowPrint)]),
      );

  const evaluations = watches.map((watch) => {
    const quote = quotes[watch.option_chain] ?? quoteFromFlowPrint(watch.lastFlowPrint);
    return evaluateWatch(watch, quote);
  });

  return Response.json(buildCheckResponse(evaluations));
}
