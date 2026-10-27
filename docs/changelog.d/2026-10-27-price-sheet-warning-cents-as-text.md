## 2026-10-27 — Price sheet warnings send cents as text (To-Do 0.1, Codex App on PR #1131)

- Migration `20261027050000_price_sheet_warnings_and_approval.sql` (not applied): the warning details' `cost_before_cents`, `cost_after_cents` and each tier's `before_cents` / `after_cents` are now JSON text, like every other cents value at the pricing boundary. As JSON numbers, a value above 2^53 would lose digits, the screen's exact-cents reader would refuse it, and the whole preview would fail to open. The browser already reads text cents (`exactIntegerCents`). Approval and apply compare the warning set from the same function, so their comparison is unchanged.
- The real-schema proof gains a step checking that all four are JSON strings, and was re-run on the edited file.
