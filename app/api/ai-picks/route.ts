import { NextRequest } from "next/server";

import { loadAiPicks } from "@/lib/ai-picks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** AI-reviewed picks (3 on risky/report days, up to 5 calm) with exit plans. `?rerun=1` bypasses the 12-min cache. */
export async function GET(request: NextRequest) {
  const rerun = request.nextUrl.searchParams.get("rerun") === "1";
  const payload = await loadAiPicks({ rerun });
  return Response.json(payload, {
    headers: { "Cache-Control": rerun ? "no-store" : "s-maxage=300, stale-while-revalidate=60" },
  });
}
