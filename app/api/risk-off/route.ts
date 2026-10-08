import { NextRequest } from "next/server";

import { loadRiskOff } from "@/lib/risk-off";
import { wantFresh } from "@/lib/refresh";

export const dynamic = "force-dynamic";

/**
 * LIVE risk-off morning flag (study/risk-off-playbook.json definition).
 * Morning ping / desk routines can poll this without pulling the full regime payload.
 */
export async function GET(request: NextRequest) {
  const fresh = wantFresh(request.nextUrl.searchParams);
  const flag = await loadRiskOff({ fresh });
  return Response.json(flag, {
    headers: { "Cache-Control": fresh || flag.provisional ? "no-store" : "s-maxage=120, stale-while-revalidate=60" },
  });
}
