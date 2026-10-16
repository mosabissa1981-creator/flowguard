import { NextRequest } from "next/server";

import { adminOk } from "@/lib/shadow/admin";
import { loadEarlyPing } from "@/lib/shadow/early-ping";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TEST / SHADOW "Early ping" lane. Vercel crons on weekdays: ~9:35-10:35 ET virtual ping + first-60-min fill checks, ~15:55 ET
 * prior-afternoon carry, after-close scoring (+30%/-25%, 2 sessions; max price = print +5% / +10%). Never changes the live board,
 * pings or Telegram. GET -> stored book (runs at most every 10 min). ?refresh=1&key=<admin> forces a run.
 */
export async function GET(request: NextRequest) {
  const p = request.nextUrl.searchParams;
  const force = p.get("refresh") === "1" && adminOk(p.get("key"));
  try {
    return Response.json(await loadEarlyPing({ force }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ mode: "test", error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}
