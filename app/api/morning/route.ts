import { loadMorningShortlist } from "@/lib/morning";
import { tapeCacheControl } from "@/lib/refresh";

export const dynamic = "force-dynamic";

export async function GET() {
  const payload = await loadMorningShortlist();
  return Response.json(payload, { headers: tapeCacheControl(false, payload.quotaBlocked) });
}
