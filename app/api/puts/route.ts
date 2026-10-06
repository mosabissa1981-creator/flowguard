import { after } from "next/server";

import { loadPuts } from "@/lib/puts";
import { refreshLaneDebate } from "@/lib/shadow/lane-debate";
import { paperTickQuietly } from "@/lib/paper";

export const dynamic = "force-dynamic";

/** Puts lane (TEST mode). Cached 10 min in memory + 5 min at the edge; zero extra flow calls. */
export async function GET() {
  // Shadow debate on newly logged picks runs after the response (throttled, budgeted; never changes picks).
  after(() => refreshLaneDebate().catch(() => undefined));
  after(() => paperTickQuietly());
  try {
    return Response.json(await loadPuts(), { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=60" } });
  } catch (error) {
    return Response.json(
      { mode: "test", error: error instanceof Error ? error.message.slice(0, 200) : "failed", picks: [] },
      { status: 500 },
    );
  }
}
