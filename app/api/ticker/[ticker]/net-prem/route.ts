import { NextRequest } from "next/server";

import { buildMockNetPremTicks } from "@/lib/mock";
import { fetchNetPremTicks, hasUnusualWhalesKey, tideFromTicks } from "@/lib/uw";
import { isUwBlocked, isUwQuotaError, quotaBanner, quotaResetUtcMs } from "@/lib/uw-quota";

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

  if (await isUwBlocked()) {
    return Response.json({
      source: "cached",
      ticker: symbol,
      ticks: [],
      tide: null,
      quotaBlocked: true,
      warning: quotaBanner(quotaResetUtcMs(), null),
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
    return Response.json({
      source: "cached",
      ticker: symbol,
      ticks: [],
      tide: null,
      quotaBlocked: isUwQuotaError(error),
      warning: isUwQuotaError(error)
        ? quotaBanner(error.untilMs, null)
        : error instanceof Error
          ? error.message
          : "Net premium unavailable.",
    });
  }
}
