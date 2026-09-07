"use client";

import { useRef, useState } from "react";
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
  const fieldRef = useRef<HTMLInputElement>(null);
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
      setMessage(
        "Paste the Unusual Whales token only (you can include “Bearer ” — we strip it). No email, no quotes.",
      );
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
      setMessage(payload.warning ?? "Key saved on the server. Pulling live tape…");
      if (fieldRef.current) fieldRef.current.value = "";
      onConfigured();
      onClose();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not save key.");
    } finally {
      setSaving(false);
    }
  }

  function readField(): string {
    return fieldRef.current?.value ?? "";
  }

  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Unusual Whales API
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {live
              ? "Paste a new key and tap Save key. Bearer prefix is fine. Nothing stays on the phone."
              : "Paste your Unusual Whales API key, then tap Save key. It is sent only to this server."}
          </p>
        </div>
        {live ? (
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Hide API key" onClick={onClose}>
            <X />
          </Button>
        ) : null}
      </div>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          ref={fieldRef}
          name="uw-key"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="send"
          placeholder={live ? "Paste key, then Save key" : "Paste Unusual Whales API key"}
          className="h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 font-mono text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveFromValue(readField());
            }
          }}
        />
        <button
          type="button"
          disabled={saving}
          onClick={() => void saveFromValue(readField())}
          className="inline-flex h-11 shrink-0 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save key"}
        </button>
      </div>
      {message ? (
        <p className={`mt-2 text-xs ${failed ? "text-rose-300" : "text-emerald-300"}`}>{message}</p>
      ) : null}
    </div>
  );
}
