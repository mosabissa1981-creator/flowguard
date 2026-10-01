import { NextRequest } from "next/server";

import { tradingDateET } from "@/lib/session";
import { adminOk } from "@/lib/shadow/admin";
import { loadLaneDebate, refreshLaneDebate } from "@/lib/shadow/lane-debate";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Shadow debate verdicts (TAKE/SKIP) on TEST-lane picks (Puts + setup lanes). Never changes lane picks.
 *  - GET /api/shadow/lanes               → today; lazily judges newly logged picks (one batched call, ≥30 min apart, budgeted).
 *  - GET /api/shadow/lanes?day=YYYY-MM-DD → stored day (read-only). Study routine saves it as study/lane-debate-<day>.json.
 *  - ?refresh=1&key=<AI_PICKS_ADMIN_SECRET> → bypass throttle / hours (budget still applies).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const today = tradingDateET();
  const day = params.get("day");
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return Response.json({ error: "day must be YYYY-MM-DD" }, { status: 400 });
  try {
    if (day && day !== today) {
      const doc = await loadLaneDebate(day);
      if (!doc) return Response.json({ error: `no lane debate stored for ${day}` }, { status: 404 });
      return Response.json(doc, { headers: { "Cache-Control": "s-maxage=600" } });
    }
    const force = params.get("refresh") === "1" && adminOk(params.get("key"));
    return Response.json(await refreshLaneDebate({ force }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}
