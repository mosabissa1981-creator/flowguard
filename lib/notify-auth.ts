import { timingSafeEqual } from "node:crypto";

/**
 * Shared-secret gate for POST /api/notify and /api/notify/test (anyone could otherwise make the bot message the user).
 * Send the secret as header `x-flowguard-key` or `?key=`. Fails closed when NOTIFY_SECRET is not set.
 */
export function notifyAuth(request: Request): { ok: true } | { ok: false; status: number; error: string } {
  const secret = process.env.NOTIFY_SECRET?.trim() ?? "";
  if (!secret) return { ok: false, status: 503, error: "NOTIFY_SECRET is not configured on the server." };
  const provided = request.headers.get("x-flowguard-key") ?? new URL(request.url).searchParams.get("key") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401, error: "Missing or invalid notify key." };
  return { ok: true };
}
