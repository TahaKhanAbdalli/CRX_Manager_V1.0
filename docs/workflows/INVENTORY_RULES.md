# Inventory Rules

Complete reference for inventory management, calculations, and transaction handling.

---

## Core Tables

| Table | Purpose |
|-------|---------|
| `inventory` | Stock per product per location (quantity_available, quantity_prebooked, quantity_on_order, reorder_point, min_stock_level, manufactured_at_delivery) |
| `inventory_transactions` | Audit trail of every stock change (transaction_type, quantity, plus the order_id / purchase_order_id / delivery_id / job_id it came from and notes) |
| `inventory_holds` | Reserved inventory (quantity, hold_type, expires_at, is_active) |
| `purchase_orders` | Supplier POs (po_number, vendor, status, total_cost) |
| `purchase_order_items` | PO line items (quantity_ordered, quantity_received, unit_cost) |
| `receiving_records` | Per-event receiving details (condition, lot_number, notes, storage_location) |
| `warehouses` | Storage locations (name, code, is_active, is_default) |
| `cycle_counts` | Count sessions (count_number, warehouse, status, initiated_by, completed_by) |
| `cycle_count_items` | Individual count lines (expected_qty, counted_qty, variance, is_counted, counted_by) |

---

## Season Date

**Season runs October 1 to September 30.** All YTD calculations use this boundary, NOT calendar year.

Example: "Delivered YTD" means total delivered since October 1 of the current season.

---

## Inventory Calculation Formulas

### Net Position — the canonical "where do we stand?" number
```
Net Position = quantity_available - quantity_prebooked + on_order
```
**This is the only formula used for the user-visible "Net Position" number.** The InventoryPage column, the dashboard summary and the field-app preview read this number from the same RPC: `get_inventory_position()` (Wave B.3, migration 20260507150000). The order-creation warnings (`create_direct_order`, `convert_quote_to_order`, the booking draw-down, `bulk_import_order`, `create_rush_order`) compute the same formula inside their own transaction from the `inventory` row, so their `on_order` term is the stored `inventory.quantity_on_order` column, not the RPC's open-PO sum.

Holds and planned-quote demand are **not** subtracted from Net Position. They are reported in their own "Planned" column. Mixing them in confused users in the past (audit findings P4-1 + P4-2) — three different formulas on the same page meant a sales rep could read "12 free" from one column and be warned "would go negative" from another. One formula now, period.

### Today's free stock (used internally by the manual-hold warning)
```
Today's Free = quantity_available - quantity_prebooked - active holds
```
The manual-hold creation modal warns when `Today's Free - new hold qty < 0`. Net Position is the wrong number to use here because it adds `on_order` — but a hold competes against today's physical stock, not future PO arrivals. This formula is computed client-side in `InventoryPage.tsx` from fields that the RPC returns (`quantity_available`, `quantity_prebooked`, `holds_qty`).

### On Order (incoming from suppliers)
```
On Order = SUM(GREATEST(quantity_ordered - quantity_received, 0)) from open POs
```
Only POs with status `submitted` or `partially_received` count, and an over-received line counts as 0, not a negative.

### Low Stock Alert
```
Low Stock = (reorder_point > 0 AND quantity_available <= reorder_point)
            OR quantity_available < 0
```
A product with a reorder point above 0 shows the low-stock badge at or below it. Negative stock is always low, whether or not a reorder point is set. `get_inventory_position()` returns this as `is_low_stock`.

### Total on Floor
```
Total on Floor = quantity_available (what's physically in the warehouse)
```

### Delivered YTD (season-based)
```
Delivered YTD = GREATEST(
    SUM(delivered) - SUM(cancelled_delivery_reversal + void_delivery_reversal), 0)
  from inventory_transactions linked to a delivery
  WHERE the delivery's business date >= season start date (October 1)
```
The business date is the delivery's `completed_at` (or the ledger row's `created_at` when it has none) in Chicago time. A reversal counts against the season of the delivery it reverses. An order voided with `void_order` drops out entirely: all of that order's delivered volume for the product is excluded.

---

## Twelve Transaction Types

Every inventory change creates an `inventory_transactions` record. Here are all 12 types:

| Type | When used | Effect on quantity_available |
|------|-----------|------------------------------|
| `received` | PO items are received | + (increases stock) |
| `booked` | An order is created and its lines are pre-booked, by every order-creation path except quick delivery: quote conversion, direct order, rush order, bulk import, blend-ticket order and booking draw-down. Inventory holds write no ledger row | No change to quantity_available (adds to quantity_prebooked) |
| `delivered` | Delivery is completed | - (decreases stock) |
| `returned` | Customer return is received back | + (increases stock, if restocked) |
| `adjusted` | Manual inventory adjustment or cycle count variance | +/- (can go either direction) — **see caveat below** |
| `transferred` | Allowed by the type check and shown in the ledger, but no current code writes it (there is no warehouse-transfer function) | +/- if ever used (decrease at source, increase at destination) |
| `job_applied` | Product applied during a job or field application (incl. blend-ticket applications) | - (decreases stock) |
| `prebooked` | A quick delivery creates its order, or an order edit adds a line or raises a quantity | No change to quantity_available (adds to quantity_prebooked) |
| `released` | An order is cancelled or voided (its undelivered remainder), an order edit removes or lowers a line, or a quick delivery is cancelled. Completing a delivery lowers quantity_prebooked without a `released` row | No change to quantity_available (reduces quantity_prebooked) |
| `prebook_reconciliation` | Data-fix correction of `quantity_prebooked` only (added 2026-06-10) | **No change to quantity_available** (prebooked-only) |
| `cancelled_delivery_reversal` | Cancelled delivery restores inventory | + (increases stock) |
| `void_delivery_reversal` | Voided delivery restores inventory | + (increases stock) |

### Caveats for anyone recomputing stock from the ledger

- **Historical `adjusted` rows are not always available-affecting.** Before
  `prebook_reconciliation` existed, prebooked-only corrections were recorded as
  `adjusted` rows distinguishable only by their notes (e.g. "Prebooked
  reconciliation: cancel_delivery bug fix (migration 20260331900000)",
  "prebooked inventory ... was missing"). Exclude those rows when recomputing
  `quantity_available`, or the recompute will be wrong by exactly their amounts
  (this caused a false-positive HIGH in the 2026-06-10 audit). New
  prebooked-only corrections MUST use `prebook_reconciliation` instead. There
  are exactly five such rows (2026-03-13/14); the integrity report's ledger
  check skips them by id (`PREBOOK_ONLY_ADJUSTMENT_TX_IDS` in
  `src/lib/reconciliation.ts`, 2026-10-07).
- **Soft-deleted orders do not hold reservations.** Before 2026-07-21 an order
  could be soft-deleted while still `confirmed`, so its `quantity_prebooked` was
  never released; `guard_order_delivered_activity_cancel` now refuses that, and
  `20261007150200` released the leftovers. The prebooked integrity check counts
  only `confirmed`/`partially_fulfilled` orders that are not deleted.
- **Early-March 2026 seeds are unledgered.** A handful of products created
  around 2026-03-04 had `quantity_available` seeded with no `received` ledger
  rows; the ledger is not a complete derivation of stock for that era.
- **Warn-not-block is now UNIVERSAL (2026-07-06, owner decision §6.1 of the
  business-workflow review).** `complete_delivery` and `create_quick_delivery`
  no longer hard-block on insufficient stock (mig `20260706130000`): they
  proceed, allow negative stock, flag the ledger row (`requires_review = true`),
  and notify admins — matching the order-creation and job/blend-application
  paths, which already warned-and-flagged. History: the delivery hard block was
  restored 2026-04-30 after a deliberate 2026-03-19→04-30 no-block window, and
  retired again 2026-07-06 (real paper tickets must be enterable even when the
  count is wrong — the count is what's wrong, not reality).
- **Reversals may drive stock negative by design** (2026-06-10): 
  `reverse_receiving_record` / the `receiving_records` delete trigger subtract
  the full reversed quantity so the ledger always equals the applied change; a
  negative snapshot is surfaced for reconciliation rather than silently clamped.

### Critical rule: All inventory math happens in the database, NOT in React.

Inventory calculations are done in PostgreSQL RPCs and triggers. The React frontend only displays results — it never calculates an authoritative stock level itself. Some screens do compute warning-only figures in the browser from raw inventory columns; known cases include the manual-hold preview "Today's Free" (above), the Deliveries page shortage badge (`quantity_available` only, compared with each product's need summed across all active deliveries on the list) and the New Delivery stock warning (available minus prebooked). They only warn: whatever is saved comes from the database, and `create_inventory_hold()` recomputes free stock there before it saves a hold.

The single source of truth for inventory math is the `get_inventory_position()` RPC (added in Wave B.3, migration 20260507150000). It returns a JSON array with one row per inventory row of an active product, plus one row for an active product that has no inventory row but has stock on open POs (that row has a null `inventory_id` and `location`); an active product with neither gets no row. Each row has `inventory_id`, `product_id`, `product_name`, `inventory_unit`, `container_size`, `container_type`, `vendor`, `current_cost`, `location`, `unit_size`, `quantity_available`, `quantity_prebooked`, `quantity_on_order`, `holds_qty`, `job_holds_qty`, `planned_qty`, `delivered_ytd` (season-to-date), the computed `net_position`, `reorder_point`, `min_stock_level` and `is_low_stock`. **Don't add a parallel inventory aggregation in another file; if you need numbers, call this RPC.** Known exceptions are the stock checks inside write RPCs, which compute their numbers inline in their own transaction instead of calling this RPC. The order-creation RPCs (`create_direct_order`, `convert_quote_to_order`, the booking draw-down, `bulk_import_order` and `create_rush_order`) use the Net Position formula from the `inventory` row (see Net Position above). `create_quick_delivery()` locks the row and uses `quantity_available - quantity_prebooked`, deliberately leaving out on-order stock because the product leaves today. `convert_quote_to_order`, the draw-down and `bulk_import_order` lock that row first; `create_direct_order` and `create_rush_order` read it without a lock. Existing display and reporting code does not all follow the rule yet. Known cases: `get_inventory_forecast()` (Forecast tab) returns product/month forecast rows, so it reads the same supply columns itself (see the note below); `get_inventory_cost_report()` (Reports page) aggregates on its own; and several screens compute warning-only figures in the browser (see above, plus the pick-list shortages on Orders and Order Detail and the on-hand warning on Delivery Detail). New display or reporting code must still call this RPC.

Note: `get_inventory_forecast()` (Forecast tab) computes the same supply numbers (`current_available`, `prebooked`, `on_order`) using the same column definitions, so the two views are already consistent. A future cleanup could DRY the supply math by having `get_inventory_forecast` call `get_inventory_position` internally; today both functions just read the same source columns identically.

---

## Inventory Holds

Holds reserve inventory for planned quotes without actually deducting stock.

### Fields
- `quantity` — how much is reserved
- `hold_type` — `manual`, `crop_program`, or `job` (job reservations)
- `expires_at` — when the hold automatically releases (nullable)
- `is_active` — whether the hold is currently in effect

### How holds work
1. Quote is marked `is_planned = true` while it is `draft`, `sent` or `revised`
2. System creates `inventory_holds` records for each quote item
3. Holds reduce "Today's Free" but NOT `quantity_available` (and not Net Position)
4. Holds are released when the quote is accepted (including by conversion to an order), declined, expired, cancelled or closed, or when `is_planned` is switched off
5. Expired holds (past `expires_at`) are no longer counted

### Manual holds — server-side validated (P4-3, 2026-05-07)
The `/inventory` page's "Create Hold" flow goes through the `create_inventory_hold()` RPC, NOT a bare table insert. The RPC takes a `FOR UPDATE` lock on the Main Warehouse inventory row and recomputes today's free inside the transaction.

Migration `20260908130000` (applied live 2026-09-15) adds a per-key serialization layer in front of that body: the idempotency key is required, the caller must be an ACTIVE admin/sales_rep, and `check_idempotency_intent` locks the key and compares actor + request BEFORE the stock check, so a double-click or a retry racing the original replays the first hold instead of erroring. Before that apply, the second racing call failed with `IDEMPOTENCY_CONCURRENT_REPLAY_RETRY` even though the hold existed.

Free-stock formula:

```
Today's free = quantity_available − quantity_prebooked − SUM(active hold quantities)
```

If `today's free − requested qty < 0`, the RPC `RAISE EXCEPTION 'INSUFFICIENT_HOLD_INVENTORY'` and the hold is NOT created. Admins can override by passing `p_force=true` with a non-blank `p_force_reason` — the override is recorded in `activity_feed` with a `WARNING:` description prefix. Sales reps cannot force.

This closes the concurrency window where two admins clicking "Create Hold" simultaneously could each pass the client-side warning and both succeed, leaving total holds in excess of available inventory.

### Important
- Holds do NOT deduct from `quantity_available` — they only affect the Today's Free calculation
- Multiple holds can exist for the same product
- The browser-side warning at hold-creation is now a UX preview only; the server is the authoritative gate

---

## Phantom inventory rows (P4-7, 2026-05-07)

`inventory.manufactured_at_delivery boolean NOT NULL DEFAULT false` flags rows that were created during a delivery completion when the product had no prior inventory record. Since `20260706130000` (warn-not-block, 2026-07-06), `complete_delivery` and `create_quick_delivery` DO auto-create a zero row on the NOT FOUND branch — with `manufactured_at_delivery = true` — so the shortage stays visible in the position math instead of a silent no-op UPDATE. Such rows surface on `/integrity-cleanup` as designed. The flag's original purposes remain:

1. A future driver-app or field-app path that legitimately needs to manufacture rows.
2. Detecting regressions to an older `complete_delivery` body that had an auto-create branch (the March 19 body in `20260319200000` used to do this).

When the flag is true, the row surfaces on `/integrity-cleanup` under the "Phantom inventory rows" section. The admin RPC `mark_inventory_row_verified(p_inventory_id, p_performed_by, p_idempotency_key)` clears the flag after physical-stock confirmation, logging to `activity_feed`.

---

## Purchase Order Lifecycle

### Status values
`draft`, `submitted`, `partially_received`, `fully_received`, `cancelled`.
The normal path is `draft` → `submitted` → `fully_received`, passing through `partially_received` only when the PO is received in more than one shipment (one `receive_po_items()` call that receives everything goes straight to `fully_received`). `cancelled` is a separate end state, not a step after `fully_received`.

### Tables
- `purchase_orders` — PO header (po_number format: PO-YYYY-NNNN via `next_po_number()`)
- `purchase_order_items` — line items with quantity_ordered, quantity_received, unit_cost, cost_needs_review
- `purchase_order_item_cost_changes` — admin-only, append-only history of every line cost change (who, when, old/new, reason)

### Purchase cost (admin-only; `20261021140000`, Mason 2026-10-20)
- A line a sales rep adds (or switches to another product) takes the product's catalog cost and is flagged
  `cost_needs_review`; a rep never changes a stored cost.
- Admins set, correct or confirm cost with `set_purchase_order_item_costs`, received lines included (a received
  line needs a reason). It changes only the line cost and the PO total — never inventory quantities, receiving
  records, or the product's catalog cost. Inventory value uses catalog cost, so a correction moves no inventory value.
- Do not reverse a receipt just to fix its cost.

### Source files
- `src/pages/PurchaseOrders.tsx` — PO list
- `src/pages/NewPurchaseOrder.tsx` — create PO
- `src/pages/PurchaseOrderDetail.tsx` — PO detail with receive modal

### Receiving flow
1. Open a submitted PO
2. Click "Receive Items" to open the two-step receive modal
3. For each item: enter quantity received, condition, lot number, notes, storage location
4. Submit calls `receive_po_items()` RPC which:
   - Creates `receiving_records` entries (one per item received)
   - Updates `purchase_order_items.quantity_received`
   - Updates `inventory.quantity_available` (adds received quantity)
   - Does NOT change product cost/tier prices or write `cost_history` (see Cost History below)
   - Updates PO status to `partially_received` or `fully_received`

### Quick Receive (shortcut)
- 3-step wizard: select vendor + products -> auto-match to oldest open POs -> confirm
- Uses `match_quick_receive_items()` RPC to automatically allocate items to the right POs
- Source: `src/components/receiving/QuickReceivePanel.tsx`

### Key RPCs
- `receive_po_items()` — per-item condition/lot/notes/storage, creates receiving_records
- `get_receiving_log()` — paginated, filterable receiving history
- `get_receiving_summary()` — dashboard stats
- `match_quick_receive_items()` — auto-allocate for Quick Receive

---

## Cost History

Receiving does **not** touch product cost, tier prices, or `cost_history` — the current
`receive_po_items()` body (last rewritten in `20260714230000`, later only wrapped) writes inventory,
the ledger, receiving records and PO rows only. Product cost and tier prices change only through the
pricing edit paths, and each change writes a `cost_history` row whose `change_source` is one of
`pricing_worksheet`, `product_page`, `products_inline` (or `legacy_frontend` for old rows).

### Table: `cost_history`
- `product_id`, `old_cost` / `new_cost`, `old_tierN_price` / `new_tierN_price` and `old_tierN_margin` / `new_tierN_margin` (N = 1–3), `change_source`, `change_reason`, `change_note`, `change_set_id`, `old_pricing_version` / `new_pricing_version`, `changed_by`, `changed_at`
- Full column list: `.claude/schema-registry.json` → `columns.cost_history`

---

## Cycle Counts

Physical inventory verification process.

### Flow
1. Create a cycle count for a warehouse
2. System populates `cycle_count_items` with expected quantities from `inventory`
3. User enters actual counted quantities
4. System calculates variance (counted - expected)
5. Complete the count via `complete_cycle_count()` RPC
6. Variances create `inventory_transactions` of type 'adjusted'

### Tables
- `cycle_counts` — count sessions (status: in_progress/completed/cancelled)
- `cycle_count_items` — per-product count lines (expected_qty, counted_qty, variance, variance_pct, is_counted, counted_by, counted_at)

### Source: `src/pages/CycleCounts.tsx`

---

## Staff recovery: a locked Adjust, Hold or Receive dialog

If the reply to an adjustment, hold or receipt is lost, the app cannot tell whether it went through. It
locks the dialog to that exact request so nobody can book it twice. The lock follows the person into every
tab of the same browser and survives a reload. Plain steps for staff:

1. **Amber note "The last response was uncertain ... Retry it unchanged".** Click the **Retry Exact**
   button (Retry Exact Adjustment, Retry Exact Hold or Retry Exact Receiving). It re-sends the same request
   under the same request key, so it can only finish the original, never add a second one. Do not re-type
   the request somewhere else instead.
2. **"... was already applied/created in another tab. Refreshing ..."** Nothing to do. The first attempt went
   through and the page refreshes itself.
3. **The retry fails again with a connection error.** The dialog stays locked, and it reopens the next time
   you open Inventory. Retry once the connection is back. The retry stays available for 23 hours.
4. **"Another page or tab has an unresolved request for this operation."** Go back to the tab or page that
   started it and retry there, or close the other tabs and reopen Inventory.
5. **"The safe automatic retry window expired. Do not submit this mutation again."** Do not re-enter it.
   Check whether it went through: for a hold, look in the **Active Holds** list on the Inventory page; for
   an adjustment or receipt, open the product row's **View transaction history** (the Transaction Ledger).
   Tell an admin what you found (product, quantity, customer, time). If it did not go through and is still
   needed, the admin decides who re-enters it. Today the expired dialog cannot be cleared inside the app, and
   the lock lives only in that one browser, so the re-entry happens from a different browser or device.
   Tracked in `docs/manual/KNOWN_ISSUES.md` (OPEN 2026-09-11 expired uncertain request).

## Safety Checklist for Inventory Changes

- [ ] All stock math happens in PostgreSQL RPCs — never calculate in React
- [ ] Every stock change creates an `inventory_transactions` record
- [ ] Use `checkMutationResult()` after inventory writes
- [ ] Test with edge cases: zero stock, negative variance, concurrent holds
- [ ] Verify that receiving updates both PO items AND inventory levels
- [ ] Verify receiving leaves product cost, tier prices and `cost_history` unchanged
- [ ] Remember: season is October 1 to September 30 for all YTD calculations
- [ ] Money remains exact whole cents — follow "Money Handling" in `docs/workflows/SAFE_DEVELOPMENT_RULES.md`
