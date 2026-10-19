import { after } from "next/server";

import { refreshLaneDebate } from "@/lib/shadow/lane-debate";
import { paperTickQuietly } from "@/lib/paper";
import { retiredBody } from "@/lib/retired-lanes";

export const dynamic = "force-dynamic";

/**
 * Puts lane (TEST mode) — RETIRED 10/18/2026 (lib/retired-lanes.ts). No compute, logging or UW calls; the stored
 * book stays in Blob (flowguard/shadow/puts-book.json) and on /api/puts/track. The shared after-response hooks
 * (other lanes' debate, paper tick) are unchanged.
 */
export async function GET() {
  after(() => refreshLaneDebate().catch(() => undefined));
  after(() => paperTickQuietly());
  return Response.json(retiredBody("puts", { picks: [] }), { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=60" } });
}
