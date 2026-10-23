## 2026-10-21 — split billing can bill a field owner who is not the order's customer

- New migration `20261021150000_split_invoice_cross_customer_lineage.sql` (not applied yet): the
  invoice guard `guard_invoice_terminal_order` used to refuse every order invoice for a customer other
  than the order's, so a field split onto another customer's field rolled back. It now admits exactly
  one exception: a governed split invoice, created inside `create_split_invoices_from_order`'s claim
  for a customer the order's field split resolves to, and afterward only under its private
  provenance row. Every other mismatch is still refused. Needed before PR #1006 (Sol, HIGH).
- Proof: `scripts/smoke/prove-split-invoice-cross-customer-lineage-real-schema.mjs` over the
  container chain `smoke-split-invoice-cross-customer-lineage.sql` (a four-customer split created,
  replayed, posted and voided; refusals at the exception's limits and of the unchanged rule; four
  mutations), plus
  `src/__tests__/splitInvoiceLineageMigration.test.ts`.
- Split returns (same PR, `20261021155000_split_payer_return_credit.sql`, not applied yet; Mason:
  "Build split returns first"): a field owner billed through a split can return its billed share and
  gets its own return credit; on any split order each payer, the order's customer included, can
  return only its own billed share; a return credit memo passes the split-order invoice guard only
  inside the credit's claim (before this, no return on a split order could be credited). The Returns
  screen lists the orders a customer was split-billed on and caps each line, through two read-only
  server lookups, which show a sales rep a split order only when the rep may read every active invoice
  billing that customer there (as `invoices_select` allows), and an admin always; it shows what is left
  of the customer's billed share in quantity and cents. A split return whose price went stale because
  an earlier return of the same line was cancelled is refused at receipt and credit
  (`RETURN_SPLIT_SHARE_REPRICED`: cancel and recreate it). Split invoices bill an order line with no
  unit as `ea`, the unit its return carries, so such a line can be returned and credited. A split
  return and its credit memo show the payer's billed rate as the unit price, not the order price, and
  only an admin or a rep who may read that payer's split invoices can create one. Splitting an order
  now freezes the fields' billing percentages until it finishes, so an edit saved mid-split cannot
  bill some lines at the old split and others at the new one. Proof:
  `scripts/smoke/prove-split-payer-return-credit-real-schema.mjs` over
  `smoke-split-payer-return-credit.sql`, plus `src/__tests__/splitPayerReturnMigration.test.ts`.
