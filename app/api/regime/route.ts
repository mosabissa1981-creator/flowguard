import { NextRequest } from "next/server";

import { loadRegime } from "@/lib/regime";
import { wantFresh } from "@/lib/refresh";
import { loadBrief } from "@/lib/shadow/brief";

export const dynamic = "force-dynamic";

/**
 * Macro regime for the desk: calm / risky / report-day + the rules it applies.
 * `brief` = today's stored pre-market brief (context only; never generated here, never changes the label).
 */
export async function GET(request: NextRequest) {
  const fresh = wantFresh(request.nextUrl.searchParams);
  const [regime, brief] = await Promise.all([
    loadRegime({ fresh }),
    loadBrief({ generate: false }).catch(() => null),
  ]);
  return Response.json(
    { ...regime, brief: brief?.status === "ok" ? { generatedAt: brief.generatedAt, ...brief.brief } : null },
    { headers: { "Cache-Control": fresh ? "no-store" : "s-maxage=300, stale-while-revalidate=60" } },
  );
}
