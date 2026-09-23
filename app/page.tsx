import { Screener } from "@/components/screener";
import { DEFAULT_FILTERS } from "@/lib/filters";
import { loadRankedFlow } from "@/lib/flow-service";
import { loadMorningShortlist } from "@/lib/morning";
import { loadDailyPicks } from "@/lib/picks";
import { loadPremoveShortlist } from "@/lib/premove";
import { hasUnusualWhalesKey } from "@/lib/uw";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [initialFlow, initialPicks, initialMorning, initialPremove] = await Promise.all([
    loadRankedFlow(DEFAULT_FILTERS),
    loadDailyPicks(),
    loadMorningShortlist(),
    loadPremoveShortlist(),
  ]);

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Screener
        initialFlow={initialFlow}
        initialPicks={initialPicks}
        initialMorning={initialMorning}
        initialPremove={initialPremove}
        initialUwConfigured={await hasUnusualWhalesKey()}
      />
      <footer className="border-t border-border/70 px-6 py-4 text-center text-xs text-muted-foreground">
        FlowGuard screens options flow only. It does not route orders, place trades, or give
        investment advice. Watchlist, notes, and dismissed alerts stay in this browser.
        Data from Unusual Whales when an API key is configured; otherwise a local mock tape.
      </footer>
    </div>
  );
}
