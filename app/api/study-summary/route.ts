import { NextRequest } from "next/server";

import { loadStudySummary } from "@/lib/study-summary";

export const dynamic = "force-dynamic";

/** Compact study-book outcomes fed to the AI review. `?n=40` for more recent decided rows. */
export async function GET(request: NextRequest) {
  const n = Math.max(0, Math.min(200, Number(request.nextUrl.searchParams.get("n") ?? 20) || 20));
  return Response.json(loadStudySummary(n), { headers: { "Cache-Control": "s-maxage=3600" } });
}
