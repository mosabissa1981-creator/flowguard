import "server-only";

export type NotifyChannelResult = {
  configured: boolean;
  sent: boolean;
  skipped?: boolean;
  error?: string;
};

export type NotifyResult = {
  pushover: NotifyChannelResult;
  telegram: NotifyChannelResult;
};

const PUSHOVER_URL = "https://api.pushover.net/1/messages.json";

function skipped(reason: string): NotifyChannelResult {
  return { configured: false, sent: false, skipped: true, error: reason };
}

async function sendPushover(title: string, body: string): Promise<NotifyChannelResult> {
  const token = process.env.PUSHOVER_APP_TOKEN?.trim();
  const user = process.env.PUSHOVER_USER_KEY?.trim();
  if (!token || !user) return skipped("Pushover env not set");

  try {
    const response = await fetch(PUSHOVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, user, title, message: body }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return { configured: true, sent: false, error: `Pushover ${response.status}` };
    }
    return { configured: true, sent: true };
  } catch {
    return { configured: true, sent: false, error: "Pushover request failed" };
  }
}

/** Telegram is OFF unless TELEGRAM_ENABLED === "1" (Mosab asked to stop all FlowGuard Telegram messages, Oct 7 2026). */
export function telegramEnabled(): boolean {
  return process.env.TELEGRAM_ENABLED?.trim() === "1";
}

async function sendTelegram(title: string, body: string): Promise<NotifyChannelResult> {
  if (!telegramEnabled()) return skipped("Telegram disabled");
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return skipped("Telegram env not set");

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `${title}\n${body}`,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      return { configured: true, sent: false, error: `Telegram ${response.status}` };
    }
    return { configured: true, sent: true };
  } catch {
    return { configured: true, sent: false, error: "Telegram request failed" };
  }
}

/** Send title + short body to every configured lock-screen channel. Never logs secrets. */
export async function notifyChannels(title: string, body: string): Promise<NotifyResult> {
  const headline = title.trim().slice(0, 80) || "FlowGuard";
  const text = body.trim().slice(0, 400) || headline;
  const [pushover, telegram] = await Promise.all([
    sendPushover(headline, text),
    sendTelegram(headline, text),
  ]);
  return { pushover, telegram };
}

export function notifyConfigured(): { pushover: boolean; telegram: boolean; telegramDisabled: boolean } {
  return {
    pushover: Boolean(process.env.PUSHOVER_APP_TOKEN?.trim() && process.env.PUSHOVER_USER_KEY?.trim()),
    // Reported false while the off switch is set, even if the bot env vars exist.
    telegram: telegramEnabled() && Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim()),
    telegramDisabled: !telegramEnabled(),
  };
}
