import { buildMockTide } from "@/lib/mock";
import { fetchMarketTide, hasUnusualWhalesKey } from "@/lib/uw";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await hasUnusualWhalesKey())) {
    return Response.json({ source: "mock", tide: buildMockTide() });
  }

  try {
    const tide = await fetchMarketTide();
    return Response.json({ source: "live", tide });
  } catch (error) {
    return Response.json(
      {
        source: "mock",
        tide: buildMockTide(),
        warning: error instanceof Error ? error.message : "Market tide unavailable.",
      },
      { status: 200 },
    );
  }
}
