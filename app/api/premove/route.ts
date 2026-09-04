import { NextRequest } from "next/server";

import { loadPremoveShortlist } from "@/lib/premove";
import { tapeCacheControl, wantFresh } from "@/lib/refresh";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const forceFresh = wantFresh(request.nextUrl.searchParams);
  const payload = await loadPremoveShortlist({ forceFresh });
  return Response.json(payload, { headers: tapeCacheControl(forceFresh) });
}
