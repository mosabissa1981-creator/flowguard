# FlowGuard lessons sheet (TRAIN version: built only from Oct 2024 - Jan 2026, ~329 sessions, 13,097 live-eligible setups)
Study notes, not financial advice. Nothing here predicts prices; it is a summary of what past setups did under the live rules.

## The game as it is actually scored
- Buy at the ask. Exit at +30% target, -25% stop, or after 2 sessions, sold at the bid. Only setups with spread <= 10% and puts only on ETF/index.
- Base rates over the train window: 42% hit the +30% target, 46% of exits are stops, ~11% time out. Average return is about +1.4% per trade (after spread), average loss about -31%. In plain words: a coin flip with a thin edge. The job is to skip the worse coin flips, not to find sure things.
- Stops are often gaps: 17% of ALL trades stopped out on an opening gap (fill worse than -25%, avg about -43%). Gap-up targets also happen (19%, avg about +58%). Overnight risk is real in both directions.
- Whole days win or lose together. The day-to-day swing in the average result is ~25 points versus ~7 if trades were independent. Several picks on the same day, same sector, same direction is one bet, not several. Pick few, from different issuers (GOOG/GOOGL = one issuer, SPY/QQQ/IWM puts on the same day = one bet).

## What separated better from worse setups (held in BOTH halves of the train window, Oct24-May25 and Jun25-Jan26)
Averages are per-trade return under the live rules; the "quality" bucket is below.
1. Spread. <= 4% spread: avg about +2.6%. 4-10% spread: avg about -3%. The tighter the spread, the less the entry/exit tax. Prefer spread <= 4%.
2. Option price. Entry (ask) $2-$10: avg about +3% (win 47-49%). Under $2: avg about -2.5% (win 41-43%). Cheap lotto-like contracts lose the spread tax and gap-stop more often.
3. Premium size. Flow premium $100k-$3M: avg about +3%. Under $100k: avg about -3% (small prints are noise). Over $3M or vol/OI above 30: mixed, no edge (huge one-off prints are not better).
4. Pool score. 90-99 slightly best (+2.7), 100 fine (+1.4), under 90 weak (about -3). Score ties at 100 are not an edge; pool rank 1-3 did no better than rank 10-40.
5. Time of day. Prints in the first hour (before 9:00 CT) did best (about +3%); late-morning/noon prints average about 0 to -1. Early ask-side prints > noon prints.
6. Repeat prints. A ticker that shows several candidate contracts the same day (conviction building) averaged about +2% (win 46%); a lone one-contract print averaged about -3% (win 43%). Still take only ONE contract per issuer.
7. DTE. 11-20 DTE averaged about +2.2%; 21-45 DTE about +0.7%; <= 10 DTE was inconsistent (up in one half, -6% in the other). Stay near the 11-30 DTE band.
8. Ask share. Almost everything is 95%+ ask-side, so it does not separate; below 60% ask-side was clearly worse (rare).

Quality bucket (spread <= 4% AND ask >= $2 AND premium >= $100k AND score >= 90): about +3.7% per trade, win 48-50%, about half of the pool. Everything else: about -1.1%, win 43%. This held in both halves. It is a modest edge, not a guarantee.

## Calls vs puts
- Calls averaged +1.6% (win 47%); ETF/index puts +0.8% (win 43%). In the later half puts turned negative (-1.4%) while calls stayed positive (+2.4%). Puts need a real reason: a bearish tide alone does not make an index put win, especially when the market gaps up at the open. Index-put cluster (SPY + QQQ + IWM) loses together.
- Single-stock puts are excluded by the live rule. Never pick one.

## What winners looked like (typical)
- Early-session, ask-side, sweep or not, $100k-$1M premium, ask $2-$10, spread <= 3%, 11-25 DTE, on a ticker that also showed other contracts the same day, in the direction the market then moved. The biggest gains came from a gap in the trade's direction the next morning (gap exits averaged about +58%).
## What losers looked like (typical)
- Cheap option (< $2), wide-ish spread (> 4%), small premium (< $100k), lone print, noon-hour print, score under 90, or a put on a day the tape pushes up. Many losers are gap stops: the option opens down >25% the next session and the stop cannot protect you.

## Things that did NOT work (do not lean on them)
- Dark-pool, gamma (GEX) wall/flip, open-interest, insider and net-premium confirm/conflict labels: win rates within ~3 points of each other, flipping between years. GEX walls do not cap moves.
- A machine-learning "chance of losing" model: barely better than a coin flip on unseen months (AUC about 0.54).
- Sweep versus no-sweep, ETF versus single-stock calls, premove versus picks lane: no real difference.
- Risk-off macro-day playbooks (oil/yield shocks): nothing beat simply sitting out with enough sample.
- Longer holds/other targets: a +30% target with 2-session hold wins a bit more often than +40%/3 sessions for about the same average return; scaling out early was worse.

## How to use this when picking
1. Start from candidates that pass the quality bucket; if none do, pick fewer (0 is a valid answer).
2. Pick at most 3, never two from one issuer, prefer a mix of directions only if the flow genuinely supports both.
3. Skip: ask < $2, spread > 4%, premium < $100k, score < 90, late-morning lone prints, single-stock puts.
4. Remember the edge is thin (about +1 to +4% per trade). Confidence above ~60 is not justified by this evidence.
5. Say what would make it wrong; this is a paper-trading study.
