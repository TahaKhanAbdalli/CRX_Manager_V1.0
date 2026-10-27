## 2026-10-27 — Sell-price history is live (To-Do 0.4, PR #1122)

- **Migration applied:** `20261026140000_product_price_history_starting_snapshot` was applied live at 04:47:21 UTC on 2026-10-27 (11:47 PM Central on 2026-10-26), ledger version `20261027044721`.
  - It went in before the merge, under the autonomous-landing rule.
  - PR #1122 merged as `62e1a1ea5`.
- **Live check after the apply** (read-only):
  - 587 products have a starting point.
  - Every product has price history.
  - No real change is missing who made it.
  - The four `cost_history` rules are in place and validated.
  - Deleting a product with history is now refused.
  - The live smoke chain passed and rolled back.
- **Seen working on production:**
  - The Sell Price History card works for a product with real price changes and for one with only a starting point.
  - The Cost History card leaves the starting point out.
- **Still to do:** refresh the schema registry and the generated Supabase types for the new `cost_history` rules (`changed_by` nullable, `starting_snapshot`). That needs a live schema read, so it is a separate change.
