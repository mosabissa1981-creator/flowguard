import { Screener } from "@/components/screener";

export default function Home() {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <Screener />
      <footer className="border-t border-border/70 px-6 py-4 text-center text-xs text-muted-foreground">
        FlowGuard screens options flow only. It does not route orders, place trades, or give
        investment advice. Data from Unusual Whales when an API key is configured; otherwise a
        local mock tape.
      </footer>
    </div>
  );
}
