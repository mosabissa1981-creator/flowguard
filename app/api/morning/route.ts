import { loadMorningShortlist } from "@/lib/morning";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await loadMorningShortlist();
  return Response.json(payload);
}
