import { NextRequest } from "next/server";

import { loadRankedFlow } from "@/lib/flow-service";
import { parseFlowFilters } from "@/lib/filters";
import { tapeCacheControl, wantFresh } from "@/lib/refresh";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const filters = parseFlowFilters(request.nextUrl.searchParams);
  const forceFresh = wantFresh(request.nextUrl.searchParams);
  const payload = await loadRankedFlow(filters, { forceFresh });
  return Response.json(payload, { headers: tapeCacheControl(forceFresh) });
}
