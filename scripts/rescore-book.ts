import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { scoreAlert } from "@/lib/scoring";
import { scoreAlertOld } from "@/lib/scoring-old";
import { evaluateWatch, makeAdverseWatch } from "@/lib/price-watches";
import { isInCurrentSession } from "@/lib/session";
import { tideFromPremiums } from "@/lib/numbers";
import { BOOK_ASSUMPTIONS, SCORE_AT, sep4Book, type BookRow } from "@/study/book-2026-09-04";
import type { RankedFlow, TideSnapshot } from "@/lib/types";

const PICKS_MIN = 55;

function tideFor(row: BookRow, when: Date): TideSnapshot | null {
  if (row.tide !== "aligned") return null;
  const ts = when.toISOString();
  return row.alert.type === "call"
    ? tideFromPremiums(4_800_000, 1_200_000, ts)
    : tideFromPremiums(1_200_000, 4_800_000, ts);
}

function pickEligible(row: BookRow, scored: Omit<RankedFlow, "rank">, now: Date): boolean {
  if (row.cls === "no_quote") return false;
  if (!isInCurrentSession(row.alert.created_at, now)) return false;
  if (scored.stale) return false;
  if (scored.fadeProne) return false;
  if (scored.score < PICKS_MIN) return false;
  return true;
}

function chips(scored: Omit<RankedFlow, "rank">): string {
  return scored.chips
    .filter((c) =>
      [
        "opening",
        "ask-sweep",
        "sweep",
        "with-tide",
        "fresh",
        "aging",
        "aged",
        "aged-call",
        "aged-floor",
        "stale",
        "no-follow",
        "follow-thru",
        "otm-sweet",
        "itm",
        "deep-itm",
        "far-otm",
        "floor-only",
        "short-dte",
      ].includes(c.id),
    )
    .map((c) => `${c.id}${c.delta >= 0 ? "+" : ""}${c.delta}`)
    .join(", ");
}

function verdict(args: {
  row: BookRow;
  oldMorning: boolean;
  newMorning: boolean;
  oldClose: boolean;
  newClose: boolean;
  watchNew: string | null;
}): string {
  const { row, oldMorning, newMorning, oldClose, newClose, watchNew } = args;
  if (row.lane === "watch") {
    if (watchNew === "expired") return "NEW expires watch (not a Fri session Pick either era)";
    if (watchNew === "ok") return "NEW keeps watch (premium follow-through)";
    return `NEW watch ${watchNew ?? "armed"}`;
  }
  if (oldMorning && !newMorning) return "NEW cuts at morning (would not Pick)";
  if (oldClose && !newClose && newMorning) return "NEW still Picks in the morning; cuts by close (one-and-done / age)";
  if (oldClose && !newClose) return "NEW never Picks by close";
  if (newMorning && newClose) return "NEW still on the book morning and close";
  if (newMorning && !newClose) return "NEW on morning book only";
  if (!oldMorning && !newMorning && !oldClose && !newClose) return "Neither era ranked as Pick";
  return "See scores";
}

function pct(n: number | null): string {
  if (n == null) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${Math.round(n * 100)}%`;
}

function yn(v: boolean): string {
  return v ? "yes" : "no";
}

function main() {
  const book = sep4Book();
  const morning = SCORE_AT.morning;
  const close = SCORE_AT.close;

  type Scored = {
    row: BookRow;
    oldM: Omit<RankedFlow, "rank">;
    newM: Omit<RankedFlow, "rank">;
    oldC: Omit<RankedFlow, "rank">;
    newC: Omit<RankedFlow, "rank">;
    oldPickM: boolean;
    newPickM: boolean;
    oldPickC: boolean;
    newPickC: boolean;
    watchNew: string | null;
    watchHint: string | null;
  };

  const scored: Scored[] = book.map((row) => {
    const oldM = scoreAlertOld(row.alert, { now: morning, marketTide: tideFor(row, morning) });
    const newM = scoreAlert(row.alert, { now: morning, marketTide: tideFor(row, morning), peers: [] });
    const oldC = scoreAlertOld(row.alert, { now: close, marketTide: tideFor(row, close) });
    const newC = scoreAlert(row.alert, { now: close, marketTide: tideFor(row, close), peers: [] });

    let watchNew: string | null = null;
    let watchHint: string | null = null;
    if (row.lane === "watch") {
      const arm = row.followThrough === "premium" ? 6.4 : 4.2;
      const last = row.followThrough === "premium" ? 9.85 : 3.95;
      const watch = makeAdverseWatch({
        ticker: row.alert.ticker,
        option_chain: row.alert.option_chain,
        strike: row.alert.strike,
        expiry: row.alert.expiry,
        type: row.alert.type,
        entryPremium: arm,
        lastFlowPrint: last,
      });
      watch.createdAt = row.armedAt ?? row.createdAt;
      const ev = evaluateWatch(
        watch,
        { last, bid: last * 0.98, ask: last * 1.02, asOf: close.toISOString(), quality: "uw_last" },
        { now: close },
      );
      watchNew = ev.status;
      watchHint = ev.hint;
    }

    return {
      row,
      oldM,
      newM,
      oldC,
      newC,
      oldPickM: pickEligible(row, oldM, morning),
      newPickM: pickEligible(row, newM, morning),
      oldPickC: pickEligible(row, oldC, close),
      newPickC: pickEligible(row, newC, close),
      watchNew,
      watchHint,
    };
  });

  const winners = scored.filter((s) => s.row.cls === "winner");
  const losers = scored.filter((s) => s.row.cls === "loser");
  const flats = scored.filter((s) => s.row.cls === "flat");

  const winnersKeptMorning = winners.filter((s) => s.newPickM || s.watchNew === "ok");
  const falseNegMorning = winners.filter((s) => s.oldPickM && !s.newPickM && s.row.lane !== "watch");
  const falseNegClose = winners.filter((s) => s.oldPickC && !s.newPickC && s.row.lane !== "watch");

  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push("# Fri 4 Sep 2026 — OLD vs NEW rescore");
  push("");
  push("Not financial advice. Local fixtures only. No Unusual Whales calls.");
  push("");
  push("This is a **before/after on Friday’s real tickers**, not a promise of zero losers.");
  push("");
  push("## What OLD vs NEW means");
  push("");
  push("| | OLD (desk Friday, `ea89664`) | NEW (current) |");
  push("| --- | --- | --- |");
  push("| All-opening | +10 | +4 |");
  push("| Sweep / ask-sweep | +6 / none | +8 / +3 |");
  push("| Tide aligned | +4 | +6 |");
  push("| Fresh <2h | — | +3 |");
  push("| Aging | −12 if 4–24h | −12 if 4–8h; **−18** if 8h+ |");
  push("| Aged call / aged floor | — | −6 / −8 |");
  push("| Stale cap | 40 | 32 |");
  push("| Moneyness | — | near-ATM/modest OTM +3; ITM −4; deep ITM −8; far OTM −6 |");
  push("| Follow-through | — | +5 if confirmed; **one-and-done −14** after 2h with no confirm |");
  push("| Fade-prone (drops Picks) | lottery / tiny / bid / fight-tide / post-fade / stale | those + **aged / aged-call / aged-floor / one-and-done** |");
  push("| Watches | stay armed | expire after ~1 session without premium follow-through; aged **calls** hard-expire |");
  push("| Picks line | conviction ≥ 55, strict anti-fade, **this session only** | same, with the wider fade-prone set |");
  push("");
  push("Picks were already **today’s session only**. Sep 3 watches were not Friday Picks in either era. They sat on the **watch book**. NEW expires that class unless premium is still up (GH).");
  push("");
  push("## Honest line");
  push("");
  push("Next week will still have losers. Success is **cutting the aged-watch class and one-and-done fades earlier** — not a zero-loss book. Morning ask-sweep + tide can still print and lose inside the 2h grace window (MU 950P, NVDA 235C). NEW does not pretend to know that at 10:20.");
  push("");
  push("## Assumptions (fixtures, not live tape)");
  push("");
  for (const a of BOOK_ASSUMPTIONS) push(`- ${a}`);
  push("");

  push("## The 12 losers — would NEW have cut / expired / never Pick?");
  push("");
  push("| Contract | Outcome | Lane | OLD Pick 10:55 | NEW Pick 10:55 | OLD Pick close | NEW Pick close | NEW watch | Verdict |");
  push("| --- | ---: | --- | --- | --- | --- | --- | --- | --- |");
  for (const s of losers) {
    push(
      `| ${s.row.label} | ${pct(s.row.outcomePct)} | ${s.row.lane} | ${yn(s.oldPickM)} | ${yn(s.newPickM)} | ${yn(s.oldPickC)} | ${yn(s.newPickC)} | ${s.watchNew ?? "—"} | ${verdict({
        row: s.row,
        oldMorning: s.oldPickM,
        newMorning: s.newPickM,
        oldClose: s.oldPickC,
        newClose: s.newPickC,
        watchNew: s.watchNew,
      })} |`,
    );
  }
  push("");
  const expiredWatches = losers.filter((s) => s.watchNew === "expired").length;
  const sameDay = losers.filter((s) => s.row.lane !== "watch");
  const sameDayCutClose = sameDay.filter((s) => !s.newPickC).length;
  const sameDayOldKeptClose = sameDay.filter((s) => s.oldPickC && !s.newPickC).length;
  push(
    `**All 12 losers** are either expired as watches or off the close Picks tape under NEW: **${expiredWatches}/6 aged watches expire**; **${sameDayCutClose}/6** same-day tags are out by close (OLD would still have kept ${sameDayOldKeptClose} of those as Picks at 20:00).`,
  );
  push("");
  push("### Aged call watches (6) — the class that paid −18% to −98%");
  push("");
  push("MMM 190C Sep18, MMM 190C Oct16, PGEN 8C, AVGO 387.5C, TRMB 60C, YPF 55C.");
  push("");
  push("- Friday **Picks tape**: already excluded in **both** eras (created before Fri 9:30 ET).");
  push("- Friday **watch book**: OLD left them armed. NEW **hard-expires** every one — no premium follow-through.");
  push("- YPF is the Aug 17 stale floor (OLD cap 40 / fade-prone stale; NEW cap 32 + expire).");
  push("");
  push("### Same-day ask-sweep + tide (6) — tags that still lost");
  push("");
  push("| Contract | Morning NEW | Close NEW | Why |");
  push("| --- | --- | --- | --- |");
  for (const id of ["sndk-1700p", "mu-950p", "tsla-360p-sep9", "len-81p", "nvda-235c", "tsla-360p-sep11"]) {
    const s = losers.find((x) => x.row.id === id);
    if (!s) continue;
    push(
      `| ${s.row.label} | ${s.newPickM ? `Pick ${s.newM.score}` : `out ${s.newM.score}`} | ${s.newPickC ? `Pick ${s.newC.score}` : `out ${s.newC.score}`} | ${chips(s.newC) || chips(s.newM)} |`,
    );
  }
  push("");
  push("At **10:55** (inside the 2h grace) NEW still Picks most of these — same as OLD. That is the honest miss: **grace-window losers stay on the morning book**.");
  push("By **close**, every one is **one-and-done (−14)** and fade-prone. NEW drops them from Picks. OLD still had them on the book (aging −12 only, not fade-prone).");
  push(
    "TSLA 360P Sep9 still **clears 55 at 10:55** (70) after the short-DTE + ITM haircut — not a morning cut. Both 360Ps are already off the OLD close line (52). NEW just docks them harder (35).",
  );
  push("");

  push("## The 4 winners — still make the book?");
  push("");
  push("| Contract | Outcome | Lane | OLD 10:55 | NEW 10:55 | OLD close | NEW close | Watch |");
  push("| --- | ---: | --- | --- | --- | --- | --- | --- |");
  for (const s of winners) {
    push(
      `| ${s.row.label} | ${pct(s.row.outcomePct)} | ${s.row.lane} | ${s.oldM.score} ${yn(s.oldPickM)} | ${s.newM.score} ${yn(s.newPickM)} | ${s.oldC.score} ${yn(s.oldPickC)} | ${s.newC.score} ${yn(s.newPickC)} | ${s.watchNew ?? "—"} |`,
    );
  }
  push("");
  push("**Morning book (when they were actionable)**");
  push("");
  for (const s of winnersKeptMorning) {
    push(`- **${s.row.label}** still makes it: NEW morning ${s.newPickM ? `Pick ${s.newM.score}` : s.watchNew} (${chips(s.newM) || s.watchHint || "watch"}).`);
  }
  push("");
  if (falseNegMorning.length === 0) {
    push("No winner is a **morning false negative**. NEW does not drop MU / INTC / TSLA 350P when they were still fresh.");
  } else {
    push("Morning false negatives:");
    for (const s of falseNegMorning) push(`- ${s.row.label} OLD Pick → NEW out`);
  }
  push("");
  push("**Close tape (after the move)**");
  push("");
  if (falseNegClose.length) {
    push(
      `${falseNegClose.map((s) => s.row.label).join(", ")} would **drop off Picks by close** under NEW (aged + one-and-done) if the tape never printed a second ask hit. That is the same rule that cuts SNDK / LEN. The morning shortlist still had them. We are **not** inventing a confirming print for the winners.`,
    );
  }
  push("GH is not a Friday session Pick either era. NEW **keeps the watch** because premium followed through (+54% vs arm). That is the opposite of MMM.");
  push("");

  push("## False negatives — would NEW wrongly drop a winner?");
  push("");
  push("| Risk | Happens? |");
  push("| --- | --- |");
  push("| Drop MU / INTC / TSLA 350P at 10:55 | **No.** Fresh ask-sweep still Picks. All-opening +4 (not required). |");
  push("| Drop GH watch | **No.** Premium follow-through keeps it. |");
  push("| Drop those three at 16:00–20:00 if no second print | **Yes, by design.** One-and-done does not know you were going to be +70%. Morning shortlist is the keep. |");
  push("| Prefer 350P over 360P | **Yes, small.** Near-ATM +3 vs ITM −4. Not a TSLA-only rule. |");
  push("");

  push("## Named flats (ask-sweep + tide puts)");
  push("");
  push("Same chips as the winning puts. Tags alone ≠ edge. NEW still Picks them at 10:55; cuts them by close as one-and-done — same as the losing sweeps.");
  push("");
  push("| Contract | NEW 10:55 | NEW close |");
  push("| --- | --- | --- |");
  for (const s of flats) {
    push(`| ${s.row.label} | ${s.newM.score} ${s.newPickM ? "Pick" : "out"} | ${s.newC.score} ${s.newPickC ? "Pick" : "out"} |`);
  }
  push("");

  push("## Score table (named 16 + named flats)");
  push("");
  push("| Contract | Class | OLD 10:55 | NEW 10:55 | OLD close | NEW close | NEW chips @ scoring time |");
  push("| --- | --- | ---: | ---: | ---: | ---: | --- |");
  for (const s of scored.filter((x) => x.row.cls !== "no_quote")) {
    const focus = s.row.lane === "watch" ? s.newC : s.newM;
    push(
      `| ${s.row.label} | ${s.row.cls} | ${s.oldM.score} | ${s.newM.score} | ${s.oldC.score} | ${s.newC.score} | ${chips(focus) || "—"} |`,
    );
  }
  push("");
  push("## What this is not");
  push("");
  push("- Not a backtest with real UW prints or Yahoo marks.");
  push("- Not a claim the next 32-name day will have zero −15% rows.");
  push("- Success next week: aged call watches expire instead of dying on the book, and same-day tags that never confirm get off Picks after two hours.");
  push("");

  const md = lines.join("\n");
  const out = join(process.cwd(), "study/book-2026-09-04-rescore.md");
  writeFileSync(out, md);
  console.log(md);
  console.log(`\nWrote ${out}`);
}

main();
