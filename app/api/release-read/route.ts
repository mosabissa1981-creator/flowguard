import { NextRequest } from "next/server";

import { loadReleaseReads } from "@/lib/shadow/release-read";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

/**
 * Post-release reads (shadow module post_release_read) for today's NFP / CPI / PPI / ISM / FOMC statement / minutes.
 * Each release gets one xAI search call ≥3 min after its scheduled time (generated on request; cached in Blob).
 * The study/desk routine relays it — this endpoint never sends messages.
 */
export async function GET(request: NextRequest) {
  const doc = await loadReleaseReads({ generate: request.nextUrl.searchParams.get("readonly") !== "1" });
  return Response.json(doc, { headers: { "Cache-Control": "no-store" } });
}
