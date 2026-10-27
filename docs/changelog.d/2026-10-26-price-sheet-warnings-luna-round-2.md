## 2026-10-26 — Price sheet warnings: Luna round 2 fixes (To-Do 0.1, before apply)

Fixes from Luna round 2 on `20261026230000_price_sheet_warnings_and_approval.sql` (not yet applied):

- Approval and apply compare each warning's details, not only its codes: a floor raised from 30% to 40%
  after the approval, still under it, now refuses with `PRICING_WARNINGS_CHANGED` instead of applying
  under the old acknowledgement. The helper `_pricing_change_set_warning_codes` became
  `_pricing_change_set_warning_set`.
- Apply reads the warnings' other inputs (margin floors, open sent quotes) again through the new helper
  `_pricing_change_set_warning_inputs` after the pricing engine has locked and updated the products, and
  rolls back if they changed. A floor writer locks the product row, so a floor change during apply is
  now always caught or waits; no product lock is taken earlier (that would reverse the engine's lock
  order). Still known: a quote sent in the instant before commit (sending takes no product lock); the
  sent-quote price lock (To-Do 1.2) closes it.
- The Products list (inline preview, workbook preview, approval) and the product page (approval) use one
  retry key per exact request, so a retry after changing the source, reason or acknowledgement is not
  refused as a changed payload.
- Proof: `PRICE_SHEET_WARNINGS_PROOF_PASS`, 53 steps before and after, with a second mutation test.
