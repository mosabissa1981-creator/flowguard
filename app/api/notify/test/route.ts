import { notifyChannels, notifyConfigured } from "@/lib/notify";

export const dynamic = "force-dynamic";

export async function POST() {
  const configured = notifyConfigured();
  if (!configured.pushover && !configured.telegram) {
    return Response.json(
      { ok: false, error: "No notify channels configured. Set Pushover and/or Telegram env vars.", configured },
      { status: 400 },
    );
  }

  const result = await notifyChannels(
    "FlowGuard test",
    "Lock-screen test from FlowGuard. Chat pings stay as backup.",
  );
  return Response.json({ ok: true, configured, result });
}
