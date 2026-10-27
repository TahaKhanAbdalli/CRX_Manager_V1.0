## 2026-10-26 — Price sheet warnings: review fixes (To-Do 0.1, before apply)

Fixes from Luna round 1 and the RLS and migration-drift reviewers on
`20261026230000_price_sheet_warnings_and_approval.sql` (not yet applied):

- The margin-floor warning compares each tier's stored net margin with the floor, the rule the floor is
  defined by. Recomputing it from cent-rounded prices flagged a tier set exactly at its floor.
- Approval refuses a preview made before this migration (its rows carry no source): preview it again.
- Apply reads the approval receipt with a share lock, and a missing change set keeps its
  `CHANGE_SET_NOT_FOUND`.
- The 10% comparisons run in exact numeric, so an extreme cent value cannot overflow.
- A product-page rate-unit change between blank and none no longer logs a false history row.
- Known and stated in the file: products are not locked before apply's warning re-check, because doing so
  would reverse the supplier-cost engine's lock order and could deadlock a supplier-price correction or a
  receipt; a floor change or a quote sent in that instant is not re-checked. The product page's direct
  rate edit is logged in history but not gated by approval (a named follow-up).
- `CostHistory` in `src/types/index.ts` gains the new history fields.
