# Weight proposal — 2026-10-02 (NOT applied)

Rows: 224 scored rows with chips (winner/loser/flat) since 2026-09-04. Base win 7.6% / loss 9.4%.

| chip | n | record | win% | loss% | current | proposed | note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| prem-fat | 44 | 7W/1L/36F | 15.9 | 2.3 | 7 | 9 | outperformed base rate |
| chain-repeat | 16 | 3W/0L/13F | 18.8 | 0 | 5 | 7 | outperformed base rate |
| building | 70 | 7W/5L/58F | 10 | 7.1 | 6 | 7 | outperformed base rate |
| quiet | 56 | 5W/3L/48F | 8.9 | 5.4 | 8 | 9 | outperformed base rate |
| voi | 46 | 3W/0L/43F | 6.5 | 0 | 5 | 6 | outperformed base rate |
| short-dte | 17 | 2W/1L/14F | 11.8 | 5.9 | -16 | -15 | outperformed base rate |
| itm | 9 | 2W/0L/7F | 22.2 | 0 | -4 | -3 | outperformed base rate |
| ask-lean | 9 | 1W/0L/8F | 11.1 | 0 | 6 | 7 | outperformed base rate |
| single | 224 | 17W/21L/186F | 7.6 | 9.4 | 4 | 4 | keep |
| fresh | 220 | 15W/21L/184F | 6.8 | 9.5 | 3 | 3 | keep |
| with-tide | 210 | 16W/20L/174F | 7.6 | 9.5 | 6 | 6 | keep |
| otm-sweet | 209 | 14W/21L/174F | 6.7 | 10 | 3 | 3 | keep |
| ask-dom | 204 | 14W/20L/170F | 6.9 | 9.8 | 12 | 12 | keep |
| dte-sweet | 194 | 14W/20L/160F | 7.2 | 10.3 | 12 | 12 | keep |
| follow-thru | 138 | 11W/15L/112F | 8 | 10.9 | 5 | 5 | keep |
| sweep | 111 | 10W/11L/90F | 9 | 9.9 | 8 | 8 | keep |
| ask-sweep | 107 | 9W/11L/87F | 8.4 | 10.3 | 3 | 3 | keep |
| prem-ok | 90 | 6W/9L/75F | 6.7 | 10 | 4 | 4 | keep |
| both | 64 | 8W/10L/46F | 12.5 | 15.6 | 8 | 8 | keep |
| voi-high | 54 | 4W/4L/46F | 7.4 | 7.4 | 8 | 8 | keep |
| late-print | 44 | 0W/0L/44F | 0 | 0 | -18 | -18 | keep |
| mid-size | 39 | 3W/4L/32F | 7.7 | 10.3 | 6 | 6 | keep |
| score-90 | 32 | 4W/5L/23F | 12.5 | 15.6 | 6 | 6 | keep |
| dte-sweet-plus | 8 | 2W/2L/4F | 25 | 25 | 4 | 4 | keep |
| event-iv | 8 | 2W/2L/4F | 25 | 25 | 0 | 0 | keep |
| far-otm | 6 | 1W/0L/5F | 16.7 | 0 | -6 | -6 | n<8: no change proposed |
| fight-tide | 6 | 0W/0L/6F | 0 | 0 | -10 | -10 | n<8: no change proposed |
| dte-ok | 5 | 1W/0L/4F | 20 | 0 | 8 | 8 | n<8: no change proposed |
| morning-ask | 5 | 2W/1L/2F | 40 | 20 | 8 | 8 | n<8: no change proposed |
| floor | 4 | 0W/0L/4F | 0 | 0 | 5 | 5 | n<8: no change proposed |
| whale | 3 | 0W/0L/3F | 0 | 0 | 10 | 10 | n<8: no change proposed |
| floor-only | 2 | 0W/0L/2F | 0 | 0 | -12 | -12 | n<8: no change proposed |
| tiny | 2 | 1W/0L/1F | 50 | 0 | -14 | -14 | n<8: no change proposed |
| aging | 2 | 2W/0L/0F | 100 | 0 | -12 | -12 | n<8: no change proposed |
| ask-mixed | 1 | 0W/0L/1F | 0 | 0 | -4 | -4 | n<8: no change proposed |

Per chip: (win rate − loss rate) minus the base rate, shrunk by n/(n+20), ×20 → integer step clamped to ±4; only chips with n ≥ 8. Proposal only — apply by editing lib/scoring.ts in a reviewed PR.
