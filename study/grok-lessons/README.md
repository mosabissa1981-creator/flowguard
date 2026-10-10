# Grok "lessons" study (TEST MODE, not financial advice)
Grok cannot be fine-tuned, so the 2-year history is distilled into a lessons sheet + 24 real examples that ride in the prompt.
- lessons-train.md / examples-train.txt: built ONLY from Oct 2024-Jan 2026 (used for the held-out backtest).
- lessons-full.md / examples-full.txt: built from all 2 years (used by the TEST-MODE shadow module lessons_review).
- Backtest: 100 random days of Feb-Oct 2026 (held out), Grok 4.7 with vs without the sheet, live exit rules (+30% / -25% / 2 sessions, ask in, bid out, spread <= 10%, puts ETF/index only). Results: grok-lessons-results.json.
- Result: lessons arm +4.0 pts avg return, +4.4 pts win rate vs no-lessons, 95% day-bootstrap ranges -4.6..+12.6 and -4.1..+13.4 -> within noise. The gain came from 19 puts; on calls both arms are about the same.
- Wiring: lib/shadow/lessons-review.ts, enabled only with FLOWGUARD_LESSONS_TEST=1 (default OFF). Logs a shadow verdict (module lessons_review); never changes live picks, never sends Telegram.
- Scripts: scripts/study/grok-lessons-{dataset,examples,backtest,score}.py (data under /workspace/flowguard/study/grok-lessons-work).
