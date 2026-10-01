import { NextRequest } from "next/server";

import { adminOk } from "@/lib/shadow/admin";
import { loadBrief } from "@/lib/shadow/brief";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

/**
 * Pre-market brief (shadow module premarket_brief). Generated once per trading day on the first request
 * after 8:25 CT (one xAI search call), then served from Blob. `?refresh=1&key=<AI_PICKS_ADMIN_SECRET>` regenerates.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const force = params.get("refresh") === "1" && adminOk(params.get("key"));
  const doc = await loadBrief({ generate: params.get("readonly") !== "1", force });
  return Response.json(doc, { headers: { "Cache-Control": doc.status === "ok" ? "s-maxage=300" : "no-store" } });
}
