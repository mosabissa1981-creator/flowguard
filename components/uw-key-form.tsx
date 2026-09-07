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

function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  if (/expected pattern|requested format|pattern mismatch|validat/i.test(raw)) {
    return "iPhone blocked the old paste box. Copy the token, tap Paste and save, then tap Allow.";
  }
  return raw || "Could not save key.";
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
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState("");
  const live = configured || saved;

  if (live && !open) return null;

  async function saveFromValue(raw: string) {
    const trimmed = normalizeUwKey(raw);
    if (!looksLikeUwKey(trimmed)) {
      setFailed(true);
      setMessage("Copy the token first, then tap Paste and save.");
      return;
    }

    setPreview(`${trimmed.slice(0, 8)}…${trimmed.slice(-4)}`);
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
      onConfigured();
      onClose();
    } catch (error) {
      setFailed(true);
      setMessage(friendlyError(error));
    } finally {
      setSaving(false);
    }
  }

  async function pasteAndSave() {
    try {
      const text = await navigator.clipboard.readText();
      await saveFromValue(text);
    } catch {
      setFailed(true);
      setMessage("Allow Paste when iPhone asks, or long-press the box below and tap Paste.");
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
            Copy the token in unusualwhales.com, tap Paste and save, then tap Allow. There is no
            type-in box — iPhone was blocking UUID tokens there.
          </p>
        </div>
        {live ? (
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Hide API key" onClick={onClose}>
            <X />
          </Button>
        ) : null}
      </div>
      <div className="mt-2 flex flex-col gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => void pasteAndSave()}
          className="inline-flex h-12 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {saving ? "Saving…" : "Paste and save"}
        </button>
        <div
          role="textbox"
          tabIndex={0}
          contentEditable
          suppressContentEditableWarning
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="min-h-16 rounded-lg border border-dashed border-border px-2.5 py-3 text-sm text-muted-foreground outline-none focus-visible:border-ring"
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text/plain");
            event.currentTarget.textContent = "";
            void saveFromValue(text);
          }}
        >
          If Allow Paste is missing: long-press here and tap Paste
        </div>
        {preview ? (
          <p className="font-mono text-[11px] text-muted-foreground">Read token {preview}</p>
        ) : null}
      </div>
      {message ? (
        <p className={`mt-2 text-xs ${failed ? "text-rose-300" : "text-emerald-300"}`}>{message}</p>
      ) : null}
    </div>
  );
}
