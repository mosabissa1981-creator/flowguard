import { NextRequest } from "next/server";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { persistUnusualWhalesKey, resolveUnusualWhalesKey } from "@/lib/uw";

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

  const key = body.key?.trim() ?? "";
  if (key.length < 8) {
    return Response.json({ error: "That does not look like an API key." }, { status: 400 });
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
      { error: "Unusual Whales rejected this key (unauthorized)." },
      { status: 401 },
    );
  }

  if (!probe.ok && probe.status !== 429) {
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
