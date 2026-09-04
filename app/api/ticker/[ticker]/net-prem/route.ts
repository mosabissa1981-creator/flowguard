import { NextRequest } from "next/server";

import { buildMockNetPremTicks } from "@/lib/mock";
import { fetchNetPremTicks, hasUnusualWhalesKey, tideFromTicks } from "@/lib/uw";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  const { ticker } = await params;
  const symbol = ticker.trim().toUpperCase();

  if (!symbol) {
    return Response.json({ error: "Ticker required" }, { status: 400 });
  }

  if (!(await hasUnusualWhalesKey())) {
    const ticks = buildMockNetPremTicks(symbol);
    return Response.json({
      source: "mock",
      ticker: symbol,
      ticks,
      tide: tideFromTicks(ticks),
    });
  }

  try {
    const ticks = await fetchNetPremTicks(symbol);
    return Response.json({
      source: "live",
      ticker: symbol,
      ticks,
      tide: tideFromTicks(ticks),
    });
  } catch (error) {
    const ticks = buildMockNetPremTicks(symbol);
    return Response.json({
      source: "mock",
      ticker: symbol,
      ticks,
      tide: tideFromTicks(ticks),
      warning: error instanceof Error ? error.message : "Net premium unavailable.",
    });
  }
}
