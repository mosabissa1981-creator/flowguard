import { NextRequest } from "next/server";

import { loadFadeWatch } from "@/lib/shadow/fade-watch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** TEST / SHADOW. GET → today's log (updated by /api/shadow/tick). GET ?day=YYYY-MM-DD → stored log for that day. */
export async function GET(request: NextRequest) {
  const day = request.nextUrl.searchParams.get("day");
  try {
    const view = await loadFadeWatch({ day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined });
    return Response.json(view, { headers: { "Cache-Control": "s-maxage=30, stale-while-revalidate=60" } });
  } catch (error) {
    return Response.json({ mode: "test", error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}
