import { NextRequest } from "next/server";

import { parseCongressQuery } from "@/lib/congress";
import { loadCongressFeed } from "@/lib/congress-feed";
import { wantFresh } from "@/lib/refresh";
import { CONGRESS_TTL_MS } from "@/lib/uw-quota";

export const dynamic = "force-dynamic";

/**
 * Research context only. This route is not read by /api/picks, /api/premove,
 * /api/morning, or conviction scoring.
 *
 * Query: limit (1–200, default 40), side=buy|sell|all (default buy),
 * ticker, days (1–7, default 7) or window=week|day, date=YYYY-MM-DD.
 * Window field is filed_at_date. See lib/congress-feed.ts.
 */
export async function GET(request: NextRequest) {
  const forceFresh = wantFresh(request.nextUrl.searchParams);
  const payload = await loadCongressFeed(parseCongressQuery(request.nextUrl.searchParams), forceFresh);
  const cacheable = payload.status === "ok" && !forceFresh;
  const seconds = Math.round(CONGRESS_TTL_MS / 1000);
  return Response.json(payload, {
    headers: cacheable
      ? { "Cache-Control": `s-maxage=${seconds}, stale-while-revalidate=120` }
      : { "Cache-Control": "no-store" },
  });
}
