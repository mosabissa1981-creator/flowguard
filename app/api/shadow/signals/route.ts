import { NextRequest } from "next/server";

import { adminOk } from "@/lib/shadow/admin";
import { refreshSignals } from "@/lib/shadow/signals";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * SHADOW richer signals (dark pool, dealer GEX, OI follow-through) on TEST-lane logged entries.
 * GET → evaluates newly logged entries (≤ 16 per run, ~2 UW calls each) + pending OI follow-through, then returns
 * the study book with win rates by verdict. Daily Vercel cron after the close; ?refresh=1&key=<admin> bypasses the 10-min memo.
 */
export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const force = p.get("refresh") === "1" && adminOk(p.get("key"));
  try {
    return Response.json(await refreshSignals({ force }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}
