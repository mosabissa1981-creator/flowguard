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
1. Spread: <= 4%: +1.4% (test: -1.1%); > 4%: -3.4% (test: -3.8%). Prefer <= 4%. Under 1% was the only spread band still positive on the unseen months (+2.1% over 2 years, n=5,824; test +1.5%, win 46%); 1-2% was +0.9% (test -4.0%). Tighter is better.
2. Ask price (2-year rows, n=19,508): under $2: -3.7% (test -7.3%, win 36%) -> skip; cheap lotto-like options lose to spread and gap stops. $2-$10: +1.9% (win 47%, n=10,596). $10-$30: +0.4% (win 45%, n=4,380), close to the pool average, so an ask above $10 is NOT a reason to pass on its own. $30+: -1.9% (n=872) and it flips between periods (train -4.4% win 35%, test 0.0% win 49%): neutral, let the other facts decide.
3. Flow premium: $100k-$3M: +1.6% (test -0.8%); under $100k: -3.6% (test -6.1%). Small prints are noise. Over $3M or vol/OI > 30 is not better.
4. Pool score: 90-99: +1.7%; 100: about +0.4%; under 90: -3.2% (test -6.6%). Score ties at 100 are not an edge and pool rank 1-3 did no better than lower ranks.
5. Time: prints before 9:00 CT: +3.5%; 12:00 CT hour: -1.0% (test -3.8%). Early ask-side prints beat noon prints.
6. Repeat prints: a ticker with several candidate contracts that day: +0.8%; a lone one-contract print: -3.6% (test -4.1%). Still take only ONE contract per issuer.
7. DTE: 11-30: +0.3% (win 45%, n=16,110). 31-45: +0.3% (win 46%, n=2,853), the same as 11-30, so 31-45 DTE is NOT a reason to pass. 7-10: +0.5% (n=457) but flips between halves (+6.8% / -6.6%): fine, lower confidence. 0-6 DTE: only 3 trades in 2 years, untested and lottery-like: pass unless everything else is in the quality bucket, confidence <= 40. 46+: -2.7% (n=85, test -15.6%): avoid.
8. Ask share is almost always 95%+, so it separates nothing; below 60% was worse (rare).

Quality bucket (spread <= 4% AND ask >= $2, no upper price cap, AND premium >= $100k AND score >= 90): +2.6% per trade, win 47%, about half the pool. Everything else: -2.1%, win 42%. On the unseen Feb-Oct 2026 months the bucket still beat the rest (+0.4% vs -4.3%), though the whole market was worse for these trades (average -1.8%). A modest edge, not a guarantee.

## Calls vs puts
- Calls +0.7% (win 46%); ETF/index puts -0.5% (win 42%). Puts did worse in the later period. A bearish tide alone does not make an index put win, especially when the market gaps up. Index puts cluster (SPY + QQQ + IWM lose together). Single-stock puts are blocked by the live rule; never pick one.

## What winners / losers looked like
- Winners: early, ask-side, $100k-$1M premium, ask $2 or more (best $2-$10, $10-$30 fine), spread <= 3% (best under 1%), 7-45 DTE (most 11-30), ticker also showing other contracts that day, market then moving the trade's way (biggest gains were next-morning gaps in the trade's direction).
- Losers: cheap (< $2), spread > 4%, premium < $100k, lone print, noon-hour print, score < 90, puts on a day the tape pushes up. Many losers are gap stops the -25% stop cannot protect against.

## Did NOT work (do not lean on these)
- Dark-pool, gamma (GEX) wall/flip, open-interest, insider, net-premium confirm/conflict labels: win rates within ~3 points, flipping between years. GEX walls do not cap moves.
- A machine-learning "chance of losing" model: AUC ~0.54 on unseen months (barely above a coin flip).
- Sweep vs no-sweep, ETF vs single-stock calls, picks vs premove lane: no real difference.
- Risk-off macro-day playbooks (oil/yield shocks): nothing beat sitting out with enough 2-year sample. Exception under test (week of Oct 12, 2026, see live-week lessons): when the selloff HOLDS after the open, morning index puts paid.
- Exits: +30% target / 2-session hold wins a bit more often than +40% / 3 sessions for about the same average return; scaling out early was worse; 10% spread rule saves a little.

## How to use this when reviewing
1. Prefer candidates in the quality bucket; if none, pick fewer (0 is a valid answer).
2. At most 3, never two from one issuer.
3. Skip: ask < $2, spread > 4%, premium < $100k, score < 90, late-morning lone prints, single-stock puts, DTE 46+. Do NOT skip just because the ask is above $10 or DTE is 31-45.
4. Edge is thin (about +1 to +4% per trade at best). Do not report confidence above ~60.
5. State what would make it wrong; this is a paper-trading study.

## Live-week lessons (study book, week of Mon Oct 12 - Fri Oct 16, 2026; small sample, one market week)
Scored on the study book (EOD mark vs flow print or skip-time mid, +/-15% = win/loss), not the +30/-25 plan. Use as tilts, not rules.
1. Risk-off morning index puts when the selloff HOLDS: on the two PRIMARY risk-off days that kept selling from the open (Oct 14 CPI, Oct 16 oil), the ETF/index puts the risk-off rule held back went 39W/1L/11F (avg +46.5%); the ones printed in the morning went 20W/0L/1F on Oct 14 and 18W/0L/0F on Oct 16. All of them were ONE correlated bet (index selloff), not 39 edges: take at most one index put and only when tide is still bearish and SPY/QQQ are below the open.
2. Gap-down that bounces -> favor calls, avoid puts: Oct 13 (QQQ -0.9% gap -> -0.3% close) puts 0W/6L/20F, calls 9W/3L/9F; Oct 15 (QQQ -1.4% gap -> +1.3% from the open) puts 1W/9L/3F (avg -30.7%), calls 6W/0L/2F. Live morning ETF puts on those two soft risk-off mornings: 0W/2L/11F and 0W/2L/0F (IWM 265P -44%, QQQ 720P -27%).
3. Early prints beat late ones: on the two sell-from-open days, puts printed before 10:00 CT went 46W/0L/2F (before 9:00 CT alone: 20W/0L/1F); puts printed at 10:00 CT or later went 3W/1L/14F (avg +6.6%, all on Oct 14). Late puts on a down day are chases; the 2-year data also favors prints before 9:00 CT (+3.5%).
4. Tight spreads won more: book rows with spread <= 2% went 35W/8L/28F (49% win, avg +27.5%) vs 2-10% 25W/10L/43F (32%).
5. This review passed 8 winners on the old "$2-$10 ask" and "DTE 11-30" bands (NVDA 240C/245C, META 780C/800C, AMD 585C, MU 900C, SMH 565C, CRWV 65C) while its 3 graded takes went 0W/1L/2F. The bands above were reworked from the 2-year data, not from this week (AMD 585C was 3 DTE and stays a pass under the 0-6 DTE line).
(The weekly section below, if present, is regenerated every Friday from the study book.)

