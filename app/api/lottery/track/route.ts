import { trackLottery } from "@/lib/lottery";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Multi-day study tracking for logged lottery picks (max gain, +100/+300/+1000% hits, expired-worthless).
 * One UW historic call per open contract (≤30). The study routine saves this daily as study/lottery-YYYY-MM-DD.json.
 */
export async function GET() {
  try {
    return Response.json(await trackLottery(), { headers: { "Cache-Control": "s-maxage=900, stale-while-revalidate=60" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, { status: 500 });
  }
}
