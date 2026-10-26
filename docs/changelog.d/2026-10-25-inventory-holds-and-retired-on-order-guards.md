## 2026-10-25 — Inventory: retired products stay on order; holds that can never release are refused and reported; product deletes keep their holds (To-Do 0.13, 0.14, 6.9 holds half)

**What changed.** Migration `20261025090000_inventory_holds_and_retired_on_order_guards` (row 983, PR #1101),
approved by Mason in chat ("Go ahead with PR A"):

- **0.13.** `get_inventory_position()` now lists a retired product while it still has quantity on an open purchase
  order (submitted or partially received), so "what to order" no longer undercounts. It drops out once nothing is
  on order, and it is never marked low-stock, so it cannot appear in the reorder banner. Output keys, row order
  and the non-admin cost strip are unchanged. Live had 0 such products.
- **0.14 (cause).** The public `create_inventory_hold()` makes `manual` holds only; any other type is refused with
  `HOLD_TYPE_NOT_ALLOWED`. It used to accept `crop_program`, which took no quote, so such a hold had no source and
  could never be released. The app only ever sends `manual`. Quote and job holds are still written by the internal
  sync functions, which are unchanged.
- **0.14 (detection).** The daily `run_data_integrity_sweep()` raises two new integrity alerts, shown on the
  integrity cleanup panel: `stuck_job_hold` (an active job hold whose job is missing, deleted, or no longer
  scheduled / in progress) and `orphan_quote_hold` (an active program hold with no live planned quote behind it;
  terminal quotes stay with the existing `stale_quote_hold`). Both counted 0 live on 2026-10-25.
- **6.9 (holds half).** `inventory_holds.product_id` no longer cascades on delete, matching inventory, order and
  PO lines: deleting a product that has holds is refused instead of silently wiping them.

No rows changed: the 9 active program holds on quote Q-2026-1994 are untouched (Mason's own decision), and no grant
moved. Also: `IntegrityCleanupPanel` describes the two new alert types in plain English; `INVENTORY_RULES.md`
documents the rules.

**6.9 money half (read-only check, no change).** On the 8 soft-deleted orders: 5 completed deliveries on 2 of them
(ORD-2026-0342, ORD-2026-0345; spring 2026, no CRX invoice, not in the 2026-10-07 billed-outside list), plus 2
voided and 1 cancelled delivery and 2 cancelled commissions; 0 invoices, 0 payments. What to do with the 5 completed
deliveries is a separate decision for Mason.

**Proof.** `scripts/smoke/prove-inventory-holds-guards-real-schema.mjs` (container, every migration replayed) shows
each old behaviour before the migration and the new one after it, grants unchanged and a second apply refused.
The live rolled-back chain `scripts/smoke/smoke-inventory-holds-guards.sql` covers (a) the retired product on order,
(b) non-manual holds refused while manual still works, (c) the new sentinel checks at 0 and then catching planted
holds, and (d) a product delete refused.
