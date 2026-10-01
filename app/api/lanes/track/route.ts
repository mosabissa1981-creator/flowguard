import { NextRequest } from "next/server";

import { isLaneId, trackLanes } from "@/lib/lanes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** T+1..T+5 tracking for all setup lanes (or `?lane=<id>`). Study routine saves it daily as study/lanes-YYYY-MM-DD.json. */
export async function GET(request: NextRequest) {
  const lane = request.nextUrl.searchParams.get("lane");
  try {
    return Response.json(await trackLanes(isLaneId(lane) ? lane : undefined), {
      headers: { "Cache-Control": "s-maxage=900, stale-while-revalidate=60" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}
