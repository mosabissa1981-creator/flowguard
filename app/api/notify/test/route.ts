import { notifyChannels, notifyConfigured } from "@/lib/notify";
import { notifyAuth } from "@/lib/notify-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = notifyAuth(request);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  const configured = notifyConfigured();
  if (!configured.pushover && !configured.telegram) {
    return Response.json(
      { ok: false, error: configured.telegramDisabled
          ? "No notify channels configured (Pushover env not set; Telegram is disabled — set TELEGRAM_ENABLED=1 to re-enable)."
          : "No notify channels configured. Set Pushover and/or Telegram env vars.", configured },
      { status: 400 },
    );
  }

  const result = await notifyChannels(
    "FlowGuard test",
    "Lock-screen test from FlowGuard. Chat pings stay as backup.",
  );
  return Response.json({ ok: true, configured, result });
}
