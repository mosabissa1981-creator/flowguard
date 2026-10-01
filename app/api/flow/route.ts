import { NextRequest } from "next/server";

import { loadRankedFlow } from "@/lib/flow-service";
import { parseFlowFilters } from "@/lib/filters";
import { tapeCacheControl, wantFresh } from "@/lib/refresh";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const filters = parseFlowFilters(request.nextUrl.searchParams);
  const forceFresh = wantFresh(request.nextUrl.searchParams);
  // Board default = latest-prints window. `?scope=session` (requires `ticker=`) returns that ticker's full session.
  const scope = request.nextUrl.searchParams.get("scope") === "session" && filters.ticker ? "session" : "window";
  const payload = await loadRankedFlow(filters, { forceFresh, scope });
  return Response.json(payload, { headers: tapeCacheControl(forceFresh, payload.quotaBlocked) });
}
