# Fri 4 Sep 2026 — OLD vs NEW rescore

Not financial advice. Local fixtures only. No Unusual Whales calls.

This is a **before/after on Friday’s real tickers**, not a promise of zero losers.

## What OLD vs NEW means

| | OLD (desk Friday, `ea89664`) | NEW (current) |
| --- | --- | --- |
| All-opening | +10 | +4 |
| Sweep / ask-sweep | +6 / none | +8 / +3 |
| Tide aligned | +4 | +6 |
| Fresh <2h | — | +3 |
| Aging | −12 if 4–24h | −12 if 4–8h; **−18** if 8h+ |
| Aged call / aged floor | — | −6 / −8 |
| Stale cap | 40 | 32 |
| Moneyness | — | near-ATM/modest OTM +3; ITM −4; deep ITM −8; far OTM −6 |
| Follow-through | — | +5 if confirmed; **one-and-done −14** after 2h with no confirm |
| Fade-prone (drops Picks) | lottery / tiny / bid / fight-tide / post-fade / stale | those + **aged / aged-call / aged-floor / one-and-done** |
| Watches | stay armed | expire after ~1 session without premium follow-through; aged **calls** hard-expire |
| Picks line | conviction ≥ 55, strict anti-fade, **this session only** | same, with the wider fade-prone set |

Picks were already **today’s session only**. Sep 3 watches were not Friday Picks in either era. They sat on the **watch book**. NEW expires that class unless premium is still up (GH).

## Honest line

Next week will still have losers. Success is **cutting the aged-watch class and one-and-done fades earlier** — not a zero-loss book. Morning ask-sweep + tide can still print and lose inside the 2h grace window (MU 950P, NVDA 235C). NEW does not pretend to know that at 10:20.

## Assumptions (fixtures, not live tape)

- No UW calls. Premiums, vol/OI, and spots are study fixtures, not Friday Yahoo prints.
- Ask-side ~93% on sweep rows (ask-sweep family). Aged call watches are floor/ask-taken leftovers.
- Spots only where the prior study already used one (MU 1048, TSLA 348, INTC 97.40, SNDK 1680, MMM 155, YPF 51.71). Others omit spot so moneyness is skipped.
- PGEN expiry not in the list — treated as Sep18. MMM Oct16 strike listed as 190C in the chat list.
- Tide: aligned when the book said tide aligned or ask-sweep+tide; INTC tide unknown; GH none.
- Follow-through: GH = premium still up. Same-day losers = none by close. Morning winners = pending at 10:20, none by 20:00 unless we invent a second print (we do not).
- 9 unnamed flats from the original 32 are one template row, not invented tickers.

## The 12 losers — would NEW have cut / expired / never Pick?

| Contract | Outcome | Lane | OLD Pick 10:55 | NEW Pick 10:55 | OLD Pick close | NEW Pick close | NEW watch | Verdict |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| MMM 190C Sep18 | -98% | watch | no | no | no | no | expired | NEW expires watch (not a Fri session Pick either era) |
| MMM 190C Oct16 | -86% | watch | no | no | no | no | expired | NEW expires watch (not a Fri session Pick either era) |
| PGEN 8C Sep18 | -80% | watch | no | no | no | no | expired | NEW expires watch (not a Fri session Pick either era) |
| AVGO 387.5C | -72% | watch | no | no | no | no | expired | NEW expires watch (not a Fri session Pick either era) |
| TRMB 60C | -49% | watch | no | no | no | no | expired | NEW expires watch (not a Fri session Pick either era) |
| YPF 55C | -18% | watch | no | no | no | no | expired | NEW expires watch (not a Fri session Pick either era) |
| SNDK 1700P | -27% | picks | yes | yes | yes | no | — | NEW still Picks in the morning; cuts by close (one-and-done / age) |
| MU 950P | -26% | morning | yes | yes | yes | no | — | NEW still Picks in the morning; cuts by close (one-and-done / age) |
| TSLA 360P Sep9 | -18% | picks | yes | yes | no | no | — | NEW on morning book only |
| LEN 81P | -17% | picks | yes | yes | yes | no | — | NEW still Picks in the morning; cuts by close (one-and-done / age) |
| NVDA 235C | -17% | morning_chat | yes | yes | yes | no | — | NEW still Picks in the morning; cuts by close (one-and-done / age) |
| TSLA 360P Sep11 | -16% | picks | yes | yes | no | no | — | NEW on morning book only |

**All 12 losers** are either expired as watches or off the close Picks tape under NEW: **6/6 aged watches expire**; **6/6** same-day tags are out by close (OLD would still have kept 4 of those as Picks at 20:00).

### Aged call watches (6) — the class that paid −18% to −98%

MMM 190C Sep18, MMM 190C Oct16, PGEN 8C, AVGO 387.5C, TRMB 60C, YPF 55C.

- Friday **Picks tape**: already excluded in **both** eras (created before Fri 9:30 ET).
- Friday **watch book**: OLD left them armed. NEW **hard-expires** every one — no premium follow-through.
- YPF is the Aug 17 stale floor (OLD cap 40 / fade-prone stale; NEW cap 32 + expire).

### Same-day ask-sweep + tide (6) — tags that still lost

| Contract | Morning NEW | Close NEW | Why |
| --- | --- | --- | --- |
| SNDK 1700P | Pick 91 | out 56 | sweep+8, ask-sweep+3, otm-sweet+3, with-tide+6, aged-18, no-follow-14 |
| MU 950P | Pick 91 | out 56 | sweep+8, ask-sweep+3, otm-sweet+3, with-tide+6, aged-18, no-follow-14 |
| TSLA 360P Sep9 | Pick 70 | out 35 | short-dte-6, sweep+8, ask-sweep+3, itm-4, with-tide+6, aged-18, no-follow-14 |
| LEN 81P | Pick 88 | out 53 | sweep+8, ask-sweep+3, with-tide+6, aged-18, no-follow-14 |
| NVDA 235C | Pick 88 | out 47 | sweep+8, ask-sweep+3, with-tide+6, aged-18, aged-call-6, no-follow-14 |
| TSLA 360P Sep11 | Pick 84 | out 35 | short-dte-6, sweep+8, ask-sweep+3, itm-4, with-tide+6, aged-18, no-follow-14 |

At **10:55** (inside the 2h grace) NEW still Picks most of these — same as OLD. That is the honest miss: **grace-window losers stay on the morning book**.
By **close**, every one is **one-and-done (−14)** and fade-prone. NEW drops them from Picks. OLD still had them on the book (aging −12 only, not fade-prone).
TSLA 360P Sep9 still **clears 55 at 10:55** (70) after the short-DTE + ITM haircut — not a morning cut. Both 360Ps are already off the OLD close line (52). NEW just docks them harder (35).

## The 4 winners — still make the book?

| Contract | Outcome | Lane | OLD 10:55 | NEW 10:55 | OLD close | NEW close | Watch |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| MU 1060C Sep18 | +70% | morning_chat | 78 yes | 91 yes | 66 yes | 50 no | — |
| GH 150P Sep18 | +54% | watch | 45 no | 13 no | 57 no | 13 no | ok |
| TSLA 350P Sep11 | +48% | morning | 78 yes | 91 yes | 52 no | 42 no | — |
| INTC 99C Sep18 | +40% | morning_chat | 74 yes | 85 yes | 62 yes | 44 no | — |

**Morning book (when they were actionable)**

- **MU 1060C Sep18** still makes it: NEW morning Pick 91 (sweep+8, ask-sweep+3, otm-sweet+3, with-tide+6, fresh+3).
- **GH 150P Sep18** still makes it: NEW morning ok (floor-only-12, aged-18, aged-floor-8, no-follow-14).
- **TSLA 350P Sep11** still makes it: NEW morning Pick 91 (sweep+8, ask-sweep+3, otm-sweet+3, with-tide+6, fresh+3).
- **INTC 99C Sep18** still makes it: NEW morning Pick 85 (sweep+8, ask-sweep+3, otm-sweet+3, fresh+3).

No winner is a **morning false negative**. NEW does not drop MU / INTC / TSLA 350P when they were still fresh.

**Close tape (after the move)**

MU 1060C Sep18, INTC 99C Sep18 would **drop off Picks by close** under NEW (aged + one-and-done) if the tape never printed a second ask hit. That is the same rule that cuts SNDK / LEN. The morning shortlist still had them. We are **not** inventing a confirming print for the winners.
GH is not a Friday session Pick either era. NEW **keeps the watch** because premium followed through (+54% vs arm). That is the opposite of MMM.

## False negatives — would NEW wrongly drop a winner?

| Risk | Happens? |
| --- | --- |
| Drop MU / INTC / TSLA 350P at 10:55 | **No.** Fresh ask-sweep still Picks. All-opening +4 (not required). |
| Drop GH watch | **No.** Premium follow-through keeps it. |
| Drop those three at 16:00–20:00 if no second print | **Yes, by design.** One-and-done does not know you were going to be +70%. Morning shortlist is the keep. |
| Prefer 350P over 360P | **Yes, small.** Near-ATM +3 vs ITM −4. Not a TSLA-only rule. |

## Named flats (ask-sweep + tide puts)

Same chips as the winning puts. Tags alone ≠ edge. NEW still Picks them at 10:55; cuts them by close as one-and-done — same as the losing sweeps.

| Contract | NEW 10:55 | NEW close |
| --- | --- | --- |
| QQQ 480P Sep18 | 88 Pick | 53 out |
| SMH 280P Sep18 | 88 Pick | 53 out |
| AMZN 220P Sep18 | 88 Pick | 53 out |
| HD 360P Sep18 | 88 Pick | 53 out |
| MDB 320P Sep18 | 88 Pick | 53 out |
| NVDA 230P Sep18 | 88 Pick | 53 out |
| Unnamed ask-sweep+tide puts (×9) | 88 Pick | 53 out |

## Score table (named 16 + named flats)

| Contract | Class | OLD 10:55 | NEW 10:55 | OLD close | NEW close | NEW chips @ scoring time |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| MU 1060C Sep18 | winner | 78 | 91 | 66 | 50 | sweep+8, ask-sweep+3, otm-sweet+3, with-tide+6, fresh+3 |
| GH 150P Sep18 | winner | 45 | 13 | 57 | 13 | floor-only-12, aged-18, aged-floor-8, no-follow-14 |
| TSLA 350P Sep11 | winner | 78 | 91 | 52 | 42 | sweep+8, ask-sweep+3, otm-sweet+3, with-tide+6, fresh+3 |
| INTC 99C Sep18 | winner | 74 | 85 | 62 | 44 | sweep+8, ask-sweep+3, otm-sweet+3, fresh+3 |
| MMM 190C Sep18 | loser | 66 | 16 | 78 | 16 | opening+4, far-otm-6, floor-only-12, aged-18, aged-call-6, aged-floor-8, no-follow-14 |
| MMM 190C Oct16 | loser | 66 | 16 | 78 | 16 | opening+4, far-otm-6, floor-only-12, aged-18, aged-call-6, aged-floor-8, no-follow-14 |
| PGEN 8C Sep18 | loser | 66 | 34 | 78 | 34 | opening+4, aged-18, aged-call-6, no-follow-14 |
| AVGO 387.5C | loser | 66 | 34 | 78 | 34 | opening+4, aged-18, aged-call-6, no-follow-14 |
| TRMB 60C | loser | 66 | 34 | 78 | 34 | opening+4, aged-18, aged-call-6, no-follow-14 |
| YPF 55C | loser | 40 | 32 | 40 | 32 | opening+4, otm-sweet+3, floor-only-12, aged-call-6, aged-floor-8, no-follow-14, stale-14 |
| SNDK 1700P | loser | 78 | 91 | 66 | 56 | sweep+8, ask-sweep+3, otm-sweet+3, with-tide+6, fresh+3 |
| MU 950P | loser | 78 | 91 | 66 | 56 | sweep+8, ask-sweep+3, otm-sweet+3, with-tide+6, fresh+3 |
| TSLA 360P Sep9 | loser | 64 | 70 | 52 | 35 | short-dte-6, sweep+8, ask-sweep+3, itm-4, with-tide+6, fresh+3 |
| LEN 81P | loser | 78 | 88 | 66 | 53 | sweep+8, ask-sweep+3, with-tide+6, fresh+3 |
| NVDA 235C | loser | 78 | 88 | 66 | 47 | sweep+8, ask-sweep+3, with-tide+6, fresh+3 |
| TSLA 360P Sep11 | loser | 78 | 84 | 52 | 35 | sweep+8, ask-sweep+3, itm-4, with-tide+6, fresh+3 |
| QQQ 480P Sep18 | flat | 78 | 88 | 66 | 53 | sweep+8, ask-sweep+3, with-tide+6, fresh+3 |
| SMH 280P Sep18 | flat | 78 | 88 | 66 | 53 | sweep+8, ask-sweep+3, with-tide+6, fresh+3 |
| AMZN 220P Sep18 | flat | 78 | 88 | 66 | 53 | sweep+8, ask-sweep+3, with-tide+6, fresh+3 |
| HD 360P Sep18 | flat | 78 | 88 | 66 | 53 | sweep+8, ask-sweep+3, with-tide+6, fresh+3 |
| MDB 320P Sep18 | flat | 78 | 88 | 66 | 53 | sweep+8, ask-sweep+3, with-tide+6, fresh+3 |
| NVDA 230P Sep18 | flat | 78 | 88 | 66 | 53 | sweep+8, ask-sweep+3, with-tide+6, fresh+3 |
| Unnamed ask-sweep+tide puts (×9) | flat | 78 | 88 | 66 | 53 | sweep+8, ask-sweep+3, with-tide+6, fresh+3 |

## What this is not

- Not a backtest with real UW prints or Yahoo marks.
- Not a claim the next 32-name day will have zero −15% rows.
- Success next week: aged call watches expire instead of dying on the book, and same-day tags that never confirm get off Picks after two hours.
