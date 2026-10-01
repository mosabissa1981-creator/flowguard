import { after } from "next/server";

import { loadMorningShortlist } from "@/lib/morning";
import { triggerShadowQuietly } from "@/lib/shadow";
import { tapeCacheControl } from "@/lib/refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  const payload = await loadMorningShortlist();
  // Shadow pass runs after the response is sent; it only logs verdicts (see /api/shadow).
  after(triggerShadowQuietly);
  return Response.json(payload, { headers: tapeCacheControl(false, payload.quotaBlocked) });
}
