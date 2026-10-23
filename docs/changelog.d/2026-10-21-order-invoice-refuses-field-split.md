## 2026-10-21 — single order invoice refuses an order split across fields

- New migration `20261022021000_order_invoice_refuses_field_split.sql` (not applied yet):
  `create_invoice_from_order` now refuses an order whose lines are split across fields with
  `ORDER_HAS_FIELD_SPLIT`, so such an order can only be billed per field owner through
  `create_split_invoices_from_order`. Before, a direct call or an Order page with a stale or failed
  allocation read billed the order's own customer for every field owner's share. The check sits
  after the replay lookup, so an exact retry of an invoice already created still returns it. Asked
  for by Sol on PR #993; financial rules belong in the database.
- The Order page shows the refusal in plain words (`src/lib/errorSanitizer.ts`): nothing was billed,
  refresh and choose Create Invoice again to bill each field owner.
- Proof: `scripts/smoke/prove-order-invoice-refuses-field-split-real-schema.mjs` over the container
  chain `smoke-order-invoice-refuses-field-split.sql`, plus
  `src/__tests__/orderInvoiceFieldSplitMigration.test.ts`.
