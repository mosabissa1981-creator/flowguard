# Weight proposal — 2026-09-30 (NOT applied)

Rows: 216 scored rows with chips (winner/loser/flat) since 2026-09-04. Base win 6.9% / loss 8.8%.

| chip | n | record | win% | loss% | current | proposed | note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| prem-fat | 42 | 5W/1L/36F | 11.9 | 2.4 | 7 | 9 | outperformed base rate |
| building | 69 | 6W/5L/58F | 8.7 | 7.2 | 6 | 7 | outperformed base rate |
| both | 57 | 6W/9L/42F | 10.5 | 15.8 | 8 | 7 | underperformed base rate |
| quiet | 51 | 4W/1L/46F | 7.8 | 2 | 8 | 9 | outperformed base rate |
| voi | 45 | 3W/0L/42F | 6.7 | 0 | 5 | 6 | outperformed base rate |
| score-90 | 28 | 3W/5L/20F | 10.7 | 17.9 | 6 | 5 | underperformed base rate |
| short-dte | 17 | 2W/1L/14F | 11.8 | 5.9 | -16 | -15 | outperformed base rate |
| chain-repeat | 15 | 2W/0L/13F | 13.3 | 0 | 5 | 6 | outperformed base rate |
| ask-lean | 9 | 1W/0L/8F | 11.1 | 0 | 6 | 7 | outperformed base rate |
| itm | 8 | 1W/0L/7F | 12.5 | 0 | -4 | -3 | outperformed base rate |
| single | 216 | 15W/19L/182F | 6.9 | 8.8 | 4 | 4 | keep |
| fresh | 216 | 15W/19L/182F | 6.9 | 8.8 | 3 | 3 | keep |
| with-tide | 203 | 14W/19L/170F | 6.9 | 9.4 | 6 | 6 | keep |
| otm-sweet | 202 | 13W/19L/170F | 6.4 | 9.4 | 3 | 3 | keep |
| ask-dom | 197 | 12W/19L/166F | 6.1 | 9.6 | 12 | 12 | keep |
| dte-sweet | 186 | 12W/18L/156F | 6.5 | 9.7 | 12 | 12 | keep |
| follow-thru | 131 | 9W/14L/108F | 6.9 | 10.7 | 5 | 5 | keep |
| sweep | 105 | 9W/10L/86F | 8.6 | 9.5 | 8 | 8 | keep |
| ask-sweep | 101 | 8W/10L/83F | 7.9 | 9.9 | 3 | 3 | keep |
| prem-ok | 86 | 6W/8L/72F | 7 | 9.3 | 4 | 4 | keep |
| voi-high | 51 | 2W/4L/45F | 3.9 | 7.8 | 8 | 8 | keep |
| late-print | 44 | 0W/0L/44F | 0 | 0 | -18 | -18 | keep |
| mid-size | 38 | 2W/4L/32F | 5.3 | 10.5 | 6 | 6 | keep |
| far-otm | 6 | 1W/0L/5F | 16.7 | 0 | -6 | -6 | n<8: no change proposed |
| fight-tide | 6 | 0W/0L/6F | 0 | 0 | -10 | -10 | n<8: no change proposed |
| dte-ok | 5 | 1W/0L/4F | 20 | 0 | 8 | 8 | n<8: no change proposed |
| floor | 4 | 0W/0L/4F | 0 | 0 | 5 | 5 | n<8: no change proposed |
| whale | 3 | 0W/0L/3F | 0 | 0 | 10 | 10 | n<8: no change proposed |
| floor-only | 2 | 0W/0L/2F | 0 | 0 | -12 | -12 | n<8: no change proposed |
| tiny | 2 | 1W/0L/1F | 50 | 0 | -14 | -14 | n<8: no change proposed |
| ask-mixed | 1 | 0W/0L/1F | 0 | 0 | -4 | -4 | n<8: no change proposed |

Per chip: (win rate − loss rate) minus the base rate, shrunk by n/(n+20), ×20 → integer step clamped to ±4; only chips with n ≥ 8. Proposal only — apply by editing lib/scoring.ts in a reviewed PR.
