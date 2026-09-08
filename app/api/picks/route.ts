import { NextRequest } from "next/server";

import { loadDailyPicks } from "@/lib/picks";
import { tapeCacheControl, wantFresh } from "@/lib/refresh";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const forceFresh = wantFresh(request.nextUrl.searchParams);
  const payload = await loadDailyPicks({ forceFresh });
  return Response.json(payload, { headers: tapeCacheControl(forceFresh, payload.quotaBlocked) });
}
