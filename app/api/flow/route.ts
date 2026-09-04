import { NextRequest } from "next/server";

import { loadRankedFlow } from "@/lib/flow-service";
import { parseFlowFilters } from "@/lib/filters";

export const dynamic = "force-dynamic";

function tapeJson(payload: unknown) {
  return Response.json(payload, {
    headers: { "Cache-Control": "s-maxage=45, stale-while-revalidate=30" },
  });
}

export async function GET(request: NextRequest) {
  const filters = parseFlowFilters(request.nextUrl.searchParams);
  const payload = await loadRankedFlow(filters);
  return tapeJson(payload);
}
