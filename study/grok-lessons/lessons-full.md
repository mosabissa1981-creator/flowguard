# FlowGuard lessons sheet (FULL version: Oct 2024 - Oct 2026, ~499 sessions, 19,508 live-eligible setups)
Study notes, not financial advice. This is a summary of what past setups did under the live rules; it does not predict prices.
(The effects below were first found on Oct 2024-Jan 2026 and then re-checked on Feb-Oct 2026 data the sheet had not seen: same direction, smaller size.)

## The game as scored
- Buy at the ask. Exit at +30% target, -25% stop, or after 2 sessions, sold at the bid. Only spread <= 10% and puts only on ETF/index.
- Over 2 years: 41% hit the +30% target, 48% stop out, ~11% time out. Average return about +0.3% per trade after spread; average loss about -31%. It is a coin flip with a very thin edge. The job is skipping the worse coin flips, not finding sure things.
- Gaps matter: 19% of ALL trades stopped on an opening gap (avg about -42%); 19% hit the target on a gap up (avg about +57%). Overnight risk cuts both ways.
- Whole days win or lose together: the day-to-day swing in average result is about 24 points versus about 7 if trades were independent (monthly averages ranged from -7% to +8%). Same-day picks in one sector/direction are one bet. Pick few, different issuers (GOOG/GOOGL = one issuer; SPY/QQQ/IWM puts = one bet).

## What separated better from worse (full period -> unseen Feb-Oct 2026)
Averages are per-trade return under live rules.
1. Spread: <= 4%: +1.4% (test: -1.1%); > 4%: -3.4% (test: -3.8%). Prefer <= 4%.
2. Ask price: $2-$10: +1.9% (test -0.3%); under $2: -3.7% (test -7.3%, win 36%). Cheap lotto-like options lose to spread and gap stops.
3. Flow premium: $100k-$3M: +1.6% (test -0.8%); under $100k: -3.6% (test -6.1%). Small prints are noise. Over $3M or vol/OI > 30 is not better.
4. Pool score: 90-99: +1.7%; 100: about +0.4%; under 90: -3.2% (test -6.6%). Score ties at 100 are not an edge and pool rank 1-3 did no better than lower ranks.
5. Time: prints before 9:00 CT: +3.5%; 12:00 CT hour: -1.0% (test -3.8%). Early ask-side prints beat noon prints.
6. Repeat prints: a ticker with several candidate contracts that day: +0.8%; a lone one-contract print: -3.6% (test -4.1%). Still take only ONE contract per issuer.
7. DTE: 11-20 days is fine; <= 10 days has too little data and flips between periods. Stay near 11-30.
8. Ask share is almost always 95%+, so it separates nothing; below 60% was worse (rare).

Quality bucket (spread <= 4% AND ask >= $2 AND premium >= $100k AND score >= 90): +2.6% per trade, win 47%, about half the pool. Everything else: -2.1%, win 42%. On the unseen Feb-Oct 2026 months the bucket still beat the rest (+0.4% vs -4.3%), though the whole market was worse for these trades (average -1.8%). A modest edge, not a guarantee.

## Calls vs puts
- Calls +0.7% (win 46%); ETF/index puts -0.5% (win 42%). Puts did worse in the later period. A bearish tide alone does not make an index put win, especially when the market gaps up. Index puts cluster (SPY + QQQ + IWM lose together). Single-stock puts are blocked by the live rule; never pick one.

## What winners / losers looked like
- Winners: early, ask-side, $100k-$1M premium, ask $2-$10, spread <= 3%, 11-25 DTE, ticker also showing other contracts that day, market then moving the trade's way (biggest gains were next-morning gaps in the trade's direction).
- Losers: cheap (< $2), spread > 4%, premium < $100k, lone print, noon-hour print, score < 90, puts on a day the tape pushes up. Many losers are gap stops the -25% stop cannot protect against.

## Did NOT work (do not lean on these)
- Dark-pool, gamma (GEX) wall/flip, open-interest, insider, net-premium confirm/conflict labels: win rates within ~3 points, flipping between years. GEX walls do not cap moves.
- A machine-learning "chance of losing" model: AUC ~0.54 on unseen months (barely above a coin flip).
- Sweep vs no-sweep, ETF vs single-stock calls, picks vs premove lane: no real difference.
- Risk-off macro-day playbooks (oil/yield shocks): nothing beat sitting out with enough sample.
- Exits: +30% target / 2-session hold wins a bit more often than +40% / 3 sessions for about the same average return; scaling out early was worse; 10% spread rule saves a little.

## How to use this when reviewing
1. Prefer candidates in the quality bucket; if none, pick fewer (0 is a valid answer).
2. At most 3, never two from one issuer.
3. Skip: ask < $2, spread > 4%, premium < $100k, score < 90, late-morning lone prints, single-stock puts.
4. Edge is thin (about +1 to +4% per trade at best). Do not report confidence above ~60.
5. State what would make it wrong; this is a paper-trading study.
