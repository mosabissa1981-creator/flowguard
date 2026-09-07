"use client";

import { useState } from "react";
import { KeyRound, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { looksLikeUwKey, normalizeUwKey } from "@/lib/uw-key";

export function UwKeyIcon({
  live,
  open,
  onClick,
}: {
  live: boolean;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={open ? "Hide API key" : "Unusual Whales API key"}
      aria-expanded={open}
      title="API key"
      onClick={onClick}
    >
      <KeyRound className={live ? "text-emerald-300" : "text-amber-200"} />
    </Button>
  );
}

export function UwKeyForm({
  configured,
  open,
  onClose,
  onConfigured,
}: {
  configured: boolean;
  open: boolean;
  onClose: () => void;
  locked?: boolean;
  onConfigured: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = configured || saved;

  if (live && !open) return null;

  async function saveFromValue(raw: string) {
    const trimmed = normalizeUwKey(raw);
    if (!looksLikeUwKey(trimmed)) {
      setFailed(true);
      setMessage("Paste the Unusual Whales token (Bearer prefix is fine). Then tap Paste and save.");
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
      const payload = (await response.json()) as {
        configured?: boolean;
        error?: string;
        warning?: string;
      };
      if (!response.ok) {
        setFailed(true);
        setMessage(payload.error ?? "Could not save key.");
        return;
      }
      setSaved(true);
      setDraft("");
      setMessage(payload.warning ?? "Key saved on the server. Pulling live tape…");
      onConfigured();
      onClose();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not save key.");
    } finally {
      setSaving(false);
    }
  }

  async function pasteAndSave() {
    try {
      const text = await navigator.clipboard.readText();
      setDraft(text);
      await saveFromValue(text);
    } catch {
      if (draft.trim()) {
        await saveFromValue(draft);
        return;
      }
      setFailed(true);
      setMessage("iPhone blocked clipboard. Paste into the box, then tap Save key.");
    }
  }

  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Unusual Whales API
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Copy the token in unusualwhales.com, then tap Paste and save. UUID and Bearer
            tokens both work. Nothing stays on the phone.
          </p>
        </div>
        {live ? (
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Hide API key" onClick={onClose}>
            <X />
          </Button>
        ) : null}
      </div>
      <div className="mt-2 flex flex-col gap-2">
        <textarea
          value={draft}
          rows={3}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          data-form-type="other"
          placeholder="Optional: paste here if clipboard is blocked"
          className="min-h-20 w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-2.5 py-2 font-mono text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          onChange={(event) => setDraft(event.target.value)}
          onInvalid={(event) => event.preventDefault()}
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            disabled={saving}
            onClick={() => void pasteAndSave()}
            className="inline-flex h-11 flex-1 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {saving ? "Saving…" : "Paste and save"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void saveFromValue(draft)}
            className="inline-flex h-11 items-center justify-center rounded-lg border border-border bg-background px-4 text-sm font-medium disabled:opacity-50"
          >
            Save key
          </button>
        </div>
      </div>
      {message ? (
        <p className={`mt-2 text-xs ${failed ? "text-rose-300" : "text-emerald-300"}`}>{message}</p>
      ) : null}
    </div>
  );
}
