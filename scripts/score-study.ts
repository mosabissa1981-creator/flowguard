import { scoreStudyFixtures } from "@/lib/ypf-case";

const { agedSameSession, staleYpf, freshSweep } = scoreStudyFixtures();
for (const [name, row] of Object.entries({ agedSameSession, staleYpf, freshSweep })) {
  const chips = row.chips.map((c) => `${c.id}${c.delta >= 0 ? "+" : ""}${c.delta}`).join(", ");
  console.log(`${name}: score=${row.score} fadeProne=${row.fadeProne} stale=${row.stale}`);
  console.log(`  ${chips}`);
}
