"use client";

import { useState } from "react";

export function UwKeyForm({
  configured,
  onConfigured,
}: {
  configured: boolean;
  locked?: boolean;
  onConfigured: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = configured || saved;

  async function save(key: string) {
    const trimmed = key.trim();
    if (trimmed.length < 8) {
      setFailed(true);
      setMessage("Paste the full Unusual Whales key, then tap Connect live.");
      return;
    }

    setSaving(true);
    setMessage(null);
    setFailed(false);
    try {
      const response = await fetch("/api/uw-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: trimmed }),
      });
      const payload = (await response.json()) as { configured?: boolean; error?: string };
      if (!response.ok) {
        setFailed(true);
        setMessage(payload.error ?? "Could not save key.");
        return;
      }
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
        const form = event.currentTarget;
        const value = String(new FormData(form).get("key") ?? "");
        void save(value);
        const field = form.elements.namedItem("key");
        if (field instanceof HTMLInputElement) field.value = "";
      }}
    >
      <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        Unusual Whales API
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {live
          ? "Live data is on. Paste a new Unusual Whales Bearer key and tap Replace key — it stays on the server, not on the phone."
          : "Paste your Bearer key, then tap Connect live. It is sent only to this server and never stored on the phone."}
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          name="key"
          type="password"
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={live ? "Key on file — paste a new one to replace" : "Paste Unusual Whales API key"}
          className="h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 font-mono text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
        <button
          type="submit"
          disabled={saving}
          className="inline-flex h-11 shrink-0 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {saving ? "Checking…" : live ? "Replace key" : "Connect live"}
        </button>
      </div>
      {message ? (
        <p className={`mt-2 text-xs ${failed ? "text-rose-300" : "text-emerald-300"}`}>{message}</p>
      ) : null}
    </form>
  );
}
