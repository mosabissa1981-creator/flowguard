import { NextRequest } from "next/server";

import { adminOk } from "@/lib/shadow/admin";
import { loadPullbackReclaim } from "@/lib/shadow/pullback-reclaim";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TEST / SHADOW "Pullback reclaim" lane (stocks/ETFs). Daily Vercel cron after the close evaluates the 43-name universe on Yahoo
 * daily bars (no UW calls), logs signals and scores them quietly (ATR + fixed variants, 10-session hold) against the other-uptrend-day baseline.
 * GET → stored study book (computes once per completed session). ?refresh=1&key=<admin> forces a run. Never changes live picks.
 */
export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const force = p.get("refresh") === "1" && adminOk(p.get("key"));
  try {
    return Response.json(await loadPullbackReclaim({ force }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ mode: "test", error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}
