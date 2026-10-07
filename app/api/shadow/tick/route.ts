import { runShadowTick } from "@/lib/shadow/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Drives the TEST / SHADOW intraday jobs (fade-watch, follow-through, chain scan). Self-throttled; safe to hit often. */
export async function GET() {
  try {
    return Response.json(await runShadowTick(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ ran: false, error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}
