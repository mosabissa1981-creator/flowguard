import { NextRequest } from "next/server";

import { adminOk } from "@/lib/shadow/admin";
import { loadTastyQuotes, runTastyCompare } from "@/lib/shadow/tasty-compare";
import { tastyTestEnabled } from "@/lib/tasty";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TEST MODE ONLY (FLOWGUARD_TASTY_TEST=1). Tastytrade-vs-UW quote comparison log, written by /api/shadow/tick (no own cron).
 * GET -> today's log (or ?day=YYYY-MM-DD). ?refresh=1&key=<admin> forces one run. Never touches picks, pings or Telegram.
 */
export async function GET(request: NextRequest) {
  if (!tastyTestEnabled()) return Response.json({ mode: "test", enabled: false }, { headers: { "Cache-Control": "no-store" } });
  const p = request.nextUrl.searchParams;
  try {
    const run = p.get("refresh") === "1" && adminOk(p.get("key")) ? await runTastyCompare({ force: true }) : null;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(p.get("day") ?? "") ? p.get("day")! : undefined;
    return Response.json({ mode: "test", enabled: true, run, log: await loadTastyQuotes(day) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ mode: "test", error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}
