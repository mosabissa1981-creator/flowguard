import { loadDailyPicks } from "@/lib/picks";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await loadDailyPicks();
  return Response.json(payload);
}
