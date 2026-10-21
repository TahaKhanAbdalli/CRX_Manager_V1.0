## 2026-10-21 — void_order can void an order with governed split draft invoices (migration 20261021030000, not applied)

- `void_order` now claims, cancels and re-records an order's governed split draft invoices the way
  `cancel_order` does: it locks the order and the governed drafts, writes a same-transaction
  `'cancel_order'` claim for each, runs the unchanged body, refreshes each provenance row to the
  cancelled invoice, checks the refresh and drops the claims. Before this, voiding such an order rolled
  back with `SPLIT_INVOICE_PROVENANCE_IMMUTABLE` (the open follow-up from replay-binding batch 3b).
  Live impact was none (no governed split invoices exist live); it must land before split billing is used.
- No claims CHECK or guard change: the guard already accepts a `'cancel_order'` claim only for the
  exact draft-to-cancelled, money-zeroed write the void makes.
- Defense in depth: `_void_order_impl_20260714`'s draft-cancel UPDATE also requires `status = 'draft'`
  (CodeRabbit on #967) and `deleted_at IS NULL` (Luna on #987), so an invoice posted or soft-deleted between
  the loop's read and the UPDATE is never matched (live already refuses posted to cancelled through the
  status-transition trigger; a soft-deleted draft could otherwise be cancelled and zeroed). The postflight
  checks the body is its live pin plus only those two lines.
- Proof: `scripts/smoke/prove-void-order-governed-split-drafts-real-schema.mjs` (Docker, real schema) with
  the new chain `scripts/smoke/smoke-void-order-governed-split-drafts.sql` (CONTAINER ONLY).
