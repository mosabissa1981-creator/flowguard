import { timingSafeEqual } from "node:crypto";

/** Same admin secret as /api/ai-picks rerun. Needed to bypass the shadow LLM throttle. */
export function adminOk(provided: string | null): boolean {
  const secret = process.env.AI_PICKS_ADMIN_SECRET?.trim() ?? "";
  if (!secret || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
