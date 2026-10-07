import { NextRequest, after } from "next/server";

import { loadGapChase } from "@/lib/shadow/gap-chase";
import { runShadowTick } from "@/lib/shadow/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TEST / SHADOW gap-up chase checker.
 * GET                 → today's verdicts (recomputed ≤ every 3 min in market hours) + change log.
 * GET ?day=YYYY-MM-DD → stored log for that day (study routine: save as study/gap-chase-YYYY-MM-DD.json).
 * Flags only — never changes live picks.
 */
export async function GET(request: NextRequest) {
  const day = request.nextUrl.searchParams.get("day");
  // The UI polls this every ~3 min: piggy-back the throttled intraday shadow tick (fade-watch, chain scan…).
  if (!day) after(() => runShadowTick().catch(() => undefined));
  try {
    const view = await loadGapChase({ day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined });
    return Response.json(view, { headers: { "Cache-Control": "s-maxage=60, stale-while-revalidate=60" } });
  } catch (error) {
    return Response.json({ mode: "test", error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}
