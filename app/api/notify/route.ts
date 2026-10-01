import { NextRequest } from "next/server";

import { notifyChannels, notifyConfigured } from "@/lib/notify";
import { notifyAuth } from "@/lib/notify-auth";

export const dynamic = "force-dynamic";

/** Health check stays public. */
export async function GET() {
  return Response.json({ configured: notifyConfigured() });
}

/** Requires NOTIFY_SECRET via header `x-flowguard-key` or `?key=`. */
export async function POST(request: NextRequest) {
  const auth = notifyAuth(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  let body: { title?: unknown; body?: unknown };
  try {
    body = (await request.json()) as { title?: unknown; body?: unknown };
  } catch {
    return Response.json({ error: "Send JSON { title, body }." }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!title || !text) {
    return Response.json({ error: "Both title and body are required." }, { status: 400 });
  }

  const result = await notifyChannels(title, text);
  return Response.json({ ok: true, configured: notifyConfigured(), result });
}
