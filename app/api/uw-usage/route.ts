import { NextRequest } from "next/server";

import { uwUsageView } from "@/lib/uw-usage";

export const dynamic = "force-dynamic";

/** UW usage meter: calls by job for a UW day (resets 8 PM ET) + whole-token count from UW's header. */
export async function GET(request: NextRequest) {
  const day = request.nextUrl.searchParams.get("day");
  try {
    const view = await uwUsageView(day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined);
    return Response.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}
