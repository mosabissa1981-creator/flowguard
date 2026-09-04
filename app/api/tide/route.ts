import { buildMockTide } from "@/lib/mock";
import { fetchMarketTide, hasUnusualWhalesKey } from "@/lib/uw";
import { isUwBlocked, isUwQuotaError, quotaBanner, quotaResetUtcMs } from "@/lib/uw-quota";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await hasUnusualWhalesKey())) {
    return Response.json({ source: "mock", tide: buildMockTide() });
  }

  if (await isUwBlocked()) {
    return Response.json({
      source: "cached",
      tide: null,
      quotaBlocked: true,
      warning: quotaBanner(quotaResetUtcMs(), null),
    });
  }

  try {
    const tide = await fetchMarketTide();
    return Response.json({ source: "live", tide });
  } catch (error) {
    return Response.json({
      source: "cached",
      tide: null,
      quotaBlocked: isUwQuotaError(error),
      warning: isUwQuotaError(error)
        ? quotaBanner(error.untilMs, null)
        : error instanceof Error
          ? error.message
          : "Market tide unavailable.",
    });
  }
}
