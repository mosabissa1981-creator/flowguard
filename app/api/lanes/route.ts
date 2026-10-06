import { NextRequest, after } from "next/server";

import { isLaneId, loadLanes } from "@/lib/lanes";
import { refreshLaneDebate } from "@/lib/shadow/lane-debate";
import { paperTickQuietly } from "@/lib/paper";

export const dynamic = "force-dynamic";

/** Setup lanes (TEST mode). All six lanes in one cached pass; `?lane=<id>` returns just that lane. */
export async function GET(request: NextRequest) {
  const lane = request.nextUrl.searchParams.get("lane");
  // Shadow debate on newly logged picks runs after the response (throttled, budgeted; never changes picks).
  after(() => refreshLaneDebate().catch(() => undefined));
  after(() => paperTickQuietly());
  try {
    const payload = await loadLanes();
    const body = isLaneId(lane) ? { ...payload, lanes: payload.lanes.filter((l) => l.lane.id === lane) } : payload;
    return Response.json(body, { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=60" } });
  } catch (error) {
    return Response.json({ mode: "test", error: error instanceof Error ? error.message.slice(0, 200) : "failed", lanes: [] }, { status: 500 });
  }
}
