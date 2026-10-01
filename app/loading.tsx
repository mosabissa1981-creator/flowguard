export default function Loading() {
  return (
    <div className="flex min-h-[100dvh] flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="font-mono text-xl font-semibold tracking-[0.14em]">FLOWGUARD</div>
      <div className="size-6 animate-spin rounded-full border-2 border-amber-300/30 border-t-amber-300" />
      <p className="text-sm text-muted-foreground">Loading the desk — pulling flow, picks, and premove…</p>
    </div>
  );
}
