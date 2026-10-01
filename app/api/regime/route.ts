import { NextRequest } from "next/server";

import { loadRegime } from "@/lib/regime";
import { wantFresh } from "@/lib/refresh";

export const dynamic = "force-dynamic";

/** Macro regime for the desk: calm / risky / report-day + the rules it applies. */
export async function GET(request: NextRequest) {
  const fresh = wantFresh(request.nextUrl.searchParams);
  const regime = await loadRegime({ fresh });
  return Response.json(regime, {
    headers: { "Cache-Control": fresh ? "no-store" : "s-maxage=300, stale-while-revalidate=60" },
  });
}
