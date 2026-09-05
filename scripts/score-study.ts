import { scoreStudyFixtures } from "@/lib/ypf-case";

const {
  agedSameSession,
  staleYpf,
  freshSweep,
  muClassFresh,
  oneAndDone,
  oneAndDoneConfirmed,
  tsla350,
  tsla360,
  tsla360sep9,
  mmmWatch,
  ghWatch,
} = scoreStudyFixtures();

function line(
  name: string,
  row: { score: number; fadeProne?: boolean; stale?: boolean; chips?: { id: string; delta: number }[] },
) {
  const chips = (row.chips ?? []).map((c) => `${c.id}${c.delta >= 0 ? "+" : ""}${c.delta}`).join(", ");
  console.log(`${name}: score=${row.score} fadeProne=${row.fadeProne} stale=${row.stale}`);
  if (chips) console.log(`  ${chips}`);
}

line("MMM-class aged call floor (10h)", agedSameSession);
line("YPF Aug 17 stale floor", staleYpf);
line("Fresh ask-sweep + tide (control)", freshSweep);
line("MU-class fresh sweep, not all-opening", muClassFresh);
line("Same-day ask-sweep+tide, 5h, no confirm", oneAndDone);
line("Same-day ask-sweep+tide, 5h, later ask", oneAndDoneConfirmed);
line("TSLA 350P Sep11 (spot 348)", tsla350);
line("TSLA 360P Sep11 (spot 348)", tsla360);
line("TSLA 360P Sep9 (spot 348)", tsla360sep9);

console.log(
  `MMM watch: status=${mmmWatch.status} hint=${mmmWatch.hint} expired=${mmmWatch.expired} pct=${mmmWatch.pctMove}`,
);
console.log(
  `GH watch: status=${ghWatch.status} hint=${ghWatch.hint} expired=${ghWatch.expired} pct=${ghWatch.pctMove}`,
);
