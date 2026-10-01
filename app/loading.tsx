/**
 * Streamed immediately while the desk's server data loads (5–10s on a cold start).
 * WebKit (iOS Safari / home-screen apps) suppresses the first paint until a page is
 * "visually non-empty" (~200 characters of text), so this shell deliberately carries
 * enough text to paint right away instead of leaving a black screen.
 */
export default function Loading() {
  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-[1400px] flex-1 flex-col gap-4 px-4 py-4 sm:px-6">
      <header className="flex flex-col gap-3 rounded-xl border border-border/80 bg-card/80 p-4">
        <div className="flex items-center gap-3">
          <div className="size-6 animate-spin rounded-full border-2 border-amber-300/30 border-t-amber-300" />
          <h1 className="font-mono text-xl font-semibold tracking-[0.14em]">FLOWGUARD</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Loading the desk — pulling the live options tape from Unusual Whales, then ranking the morning
          shortlist, premove lane, daily picks, macro regime, and AI review. This usually takes a few seconds
          on a cold start. Options-flow context only, not financial advice.
        </p>
      </header>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-28 animate-pulse rounded-xl border border-border/60 bg-card/50" />
      ))}
    </div>
  );
}
