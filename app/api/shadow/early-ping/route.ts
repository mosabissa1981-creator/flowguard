import { storedEarlyPingView } from "@/lib/shadow/early-ping";
import { retiredBody } from "@/lib/retired-lanes";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * TEST / SHADOW "Early ping" lane — RETIRED 10/18/2026 (lib/retired-lanes.ts). Its 10 Vercel crons were removed and
 * this route no longer runs the lane (no tape read, no logging, no UW scoring calls; `?refresh=1` is ignored).
 * GET -> `{ retired: true }` plus the stored book, read-only.
 */
export async function GET() {
  try {
    return Response.json(retiredBody("early-ping", { book: await storedEarlyPingView() }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(retiredBody("early-ping", { error: error instanceof Error ? error.message.slice(0, 200) : "failed" }), { headers: { "Cache-Control": "no-store" } });
  }
}
