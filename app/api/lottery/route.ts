import { after } from "next/server";

import { loadLottery } from "@/lib/lottery";
import { paperTickQuietly } from "@/lib/paper";

export const dynamic = "force-dynamic";

/** Lottery lane (TEST mode). Cached 10 min in memory + 5 min at the edge; zero extra flow calls. */
export async function GET() {
  // Paper/test sub-book picks up newly logged tickets (throttled).
  after(() => paperTickQuietly());
  try {
    const payload = await loadLottery();
    return Response.json(payload, { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=60" } });
  } catch (error) {
    return Response.json(
      { mode: "test", error: error instanceof Error ? error.message.slice(0, 200) : "failed", picks: [] },
      { status: 500 },
    );
  }
}
