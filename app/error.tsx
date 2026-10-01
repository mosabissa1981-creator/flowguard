"use client";

export default function DeskError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[100dvh] flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="font-mono text-xl font-semibold tracking-[0.14em]">FLOWGUARD</div>
      <p className="text-sm text-rose-200">The desk hit an error while loading.</p>
      <p className="max-w-sm font-mono text-[11px] text-muted-foreground">{error.digest ?? error.message}</p>
      <div className="flex gap-2">
        <button type="button" onClick={() => reset()} className="rounded-lg border border-border px-3 py-1.5 text-sm">
          Try again
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-lg border border-border px-3 py-1.5 text-sm"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
