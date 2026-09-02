import { NextRequest } from "next/server";

import { loadRankedFlow } from "@/lib/flow-service";
import { parseFlowFilters } from "@/lib/filters";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const filters = parseFlowFilters(request.nextUrl.searchParams);
  const payload = await loadRankedFlow(filters);
  return Response.json(payload);
}
