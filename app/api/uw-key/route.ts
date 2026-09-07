import { NextRequest } from "next/server";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { persistUnusualWhalesKey, resolveUnusualWhalesKey } from "@/lib/uw";
import { looksLikeUwKey, normalizeUwKey } from "@/lib/uw-key";

export const dynamic = "force-dynamic";

export async function GET() {
  const key = await resolveUnusualWhalesKey();
  return Response.json({
    configured: key.length > 0,
    locked: false,
  });
}

export async function POST(request: NextRequest) {
  let body: { key?: string };
  try {
    body = (await request.json()) as { key?: string };
  } catch {
    return Response.json({ error: "Send JSON { key }." }, { status: 400 });
  }

  const key = normalizeUwKey(body.key);
  if (!looksLikeUwKey(key)) {
    return Response.json(
      { error: "That does not look like an Unusual Whales API token. Paste the token only." },
      { status: 400 },
    );
  }

  const probe = await fetch("https://api.unusualwhales.com/api/market/market-tide?interval_5m=false", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "UW-CLIENT-API-ID": "100001",
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (probe.status === 401 || probe.status === 403) {
    return Response.json(
      {
        error:
          "Unusual Whales rejected this token (unauthorized). It may be revoked, regenerated, or from another account. Copy a fresh key from unusualwhales.com → API.",
      },
      { status: 401 },
    );
  }

  if (probe.status === 429) {
    const { tripUwQuota } = await import("@/lib/uw-quota");
    await tripUwQuota("key-probe 429");
    await persistUnusualWhalesKey(key);
    return Response.json({
      configured: true,
      replaced: true,
      quotaBlocked: true,
      warning: "Key saved. Unusual Whales is at the daily cap — live tape waits until UTC midnight.",
    });
  }

  if (!probe.ok) {
    const detail = await probe.text();
    return Response.json(
      {
        error: `Unusual Whales returned ${probe.status}. ${detail.slice(0, 160)}`.trim(),
      },
      { status: 400 },
    );
  }

  await persistUnusualWhalesKey(key);

  try {
    const envPath = path.join(process.cwd(), ".env.local");
    await writeFile(envPath, `UNUSUAL_WHALES_API_KEY=${key}\n`, { encoding: "utf8" });
  } catch {
    // Runtime + blob still work if the local env file is not writable (Vercel).
  }

  return Response.json({ configured: true, replaced: true });
}
