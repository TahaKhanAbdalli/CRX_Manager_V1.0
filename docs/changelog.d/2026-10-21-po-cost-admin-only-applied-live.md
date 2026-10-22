## 2026-10-21 — Purchase-order cost is admin-only: both migrations live, PR #980 merged

- Migration `20261021140000_po_cost_admin_only_and_corrections` was applied live at 22:40:56 UTC (5:40 PM Central),
  ledger version `20261021224056`, and `20261021141000_po_cost_columns_admin_only` at 00:27:48 UTC on 2026-10-22
  (7:27 PM Central), ledger version `20261022002748`. Each ran on Mason's in-chat `I approve` (the first carries a
  TRUNCATE-blocking trigger, the second revokes access on existing tables). PR #980 merged as `8399309dc` right after.
- Read-only live checks after each apply: the cost-history table (RLS on), `cost_needs_review`, the four new functions,
  both triggers and both whole-cent CHECKs exist; `anon` cannot run `set_purchase_order_item_costs`; `authenticated` and
  `anon` can no longer read `purchase_order_items.unit_cost` or `purchase_orders.total_cost`, while non-cost columns stay
  readable. The real-schema prover passed on the merged head before the applies.
- `migration-history.md` rows 962 and 963 are marked applied, the manuals carry the 00:27 UTC ledger read, the
  `KNOWN_ISSUES.md` purchase-order cost question is closed, and the schema registry was regenerated from live.
  The `2026-10-20-po-cost-admin-only-and-corrections.md` entry above describes the pre-apply candidate.
- Still open: Goal 1 step 3's column lock on the other tables (product `current_cost` stays readable through the Data
  API); a click-through of the purchase-order screens as a rep and as an admin on the live site.
