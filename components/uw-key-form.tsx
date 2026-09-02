"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function UwKeyForm({
  configured,
  onConfigured,
}: {
  configured: boolean;
  onConfigured: () => void;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = configured || saved;

  async function save() {
    setSaving(true);
    setMessage(null);
    setFailed(false);
    try {
      const response = await fetch("/api/uw-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const payload = (await response.json()) as { configured?: boolean; error?: string };
      if (!response.ok) {
        setFailed(true);
        setMessage(payload.error ?? "Could not save key.");
        return;
      }
      setKey("");
      setSaved(true);
      setMessage("Live Unusual Whales connected. Refreshing tape.");
      onConfigured();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not save key.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="rounded-lg border border-border/70 bg-muted/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Unusual Whales API
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Paste your Bearer key. It is sent only to this server, never stored in the browser, and
        never shown again.
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={live ? "Key on file — paste a new one to replace" : "UNUSUAL_WHALES_API_KEY"}
          value={key}
          className="font-mono"
          onChange={(event) => setKey(event.target.value)}
        />
        <Button type="submit" disabled={saving || key.trim().length < 8}>
          {saving ? "Checking…" : live ? "Replace key" : "Connect live"}
        </Button>
      </div>
      {message ? (
        <p className={`mt-2 text-xs ${failed ? "text-rose-300" : "text-emerald-300"}`}>{message}</p>
      ) : null}
    </form>
  );
}
