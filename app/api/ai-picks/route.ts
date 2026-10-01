import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";

import { loadAiPicks } from "@/lib/ai-picks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function adminOk(provided: string | null): boolean {
  const secret = process.env.AI_PICKS_ADMIN_SECRET?.trim() ?? "";
  if (!secret || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * AI-reviewed picks (3 on risky/report days, up to 5 calm) with exit plans.
 * Cost guard: the LLM runs at most once per 30 min per trading day and only when candidates change.
 * `?rerun=1` refreshes the tape lists but still respects the guard; bypassing it needs
 * `?rerun=1&key=<AI_PICKS_ADMIN_SECRET>` so the public cannot burn tokens.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const rerun = params.get("rerun") === "1";
  const force = rerun && adminOk(params.get("key"));
  const payload = await loadAiPicks({ force });
  return Response.json(payload, {
    headers: { "Cache-Control": rerun ? "no-store" : "s-maxage=300, stale-while-revalidate=60" },
  });
}
