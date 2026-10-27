## 2026-10-26 — Price sheet warnings: reviewer round 2 fixes (To-Do 0.1, before apply)

From the rls-security and migration-drift reviewers on `20261026230000_price_sheet_warnings_and_approval.sql`
(not yet applied; both found no BLOCKER and no SQL HIGH):

- Apply locks the change set before reading its approval receipt, the order approve uses, so approving
  and applying the same change set from two tabs can no longer deadlock.
- The verify block also refuses if the signed-in API role can run the inner pricing engine (the approval
  gate lives in the wrapper above it), and checks `metabase_ro` on the helpers and on
  `approve_pricing_change_set`.
- Comments state the remaining window exactly (a quote change of any kind between the second read and the
  commit; a floor written outside `set_product_margin_floors`) and that the second read refuses on any
  floor or quote change for the set's products, failing safe.
- Still to do at apply time: record a fresh live ordering check (row by row) in migration history row 990.
