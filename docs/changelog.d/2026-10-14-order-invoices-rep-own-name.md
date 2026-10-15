## 2026-10-14 — Order invoices: a sales rep names only themselves as salesperson

**What changed (migration `20261014210000_order_invoices_rep_own_name`, not yet applied when written).**
When a sales rep turns an order into invoices, the database now refuses to record anyone but that rep
as the invoice's salesperson. Admins may still name anyone. `create_invoice_from_order` and
`create_split_invoices_from_order` refuse a non-admin caller whose effective salesperson,
`COALESCE(p_salesman_id, orders.salesman_id)`, is someone else, with `SALESMAN_SCOPE_DENIED`, the code
`save_invoice` already uses; the app shows "Sales reps invoice under their own name: choose yourself
as the salesman". So a blank salesperson is accepted only on the rep's own order or one with no
salesperson (Sol on PR #928: a rep can insert an order naming another rep). The one exception, Mason's
"Option A" (2026-10-14): a completed delivery's automatic split keeps the order's salesperson, so a rep
completing another rep's delivery still gets those drafts. `_complete_delivery_authorized_impl` is
re-emitted with two added lines that mark that call with the transaction-local setting
`crx.order_invoice_autosplit`, which no browser request can set. Reps still invoice any customer.

The split wrapper, re-emitted for this, also:
- refuses any invoice type but `chemical_sale` or `misc_charge` before its claim, so a refused
  `field_application` split no longer draws an invoice number and leaves a gap (Codex review on
  PR #885, CRX-LIFE-001);
- requires its idempotency key, as `create_invoice_from_order` already does. The Order page and
  `complete_delivery` always send one.

**Why.** Mason, 2026-10-14: "Do the invoice fix" (the open own-name half of the rep-scoping rule,
`KNOWN_ISSUES.md`). `invoices.salesman_id` decides who may read an invoice, so naming another
profile handed that profile read access.

**Proof.** `node scripts/smoke/prove-order-invoice-rep-own-name-real-schema.mjs` builds the
production schema in a network-disabled container, checks every replayed body against the md5 pins in the migration (read from live, read-only, on 2026-10-14),
shows the new chain `smoke-order-invoice-rep-own-name.sql` failing first on the old wrappers and
passing after, runs the seven other registered chains that cover these functions and complete_delivery
before and after, checks the autocommit, drift and re-apply refusals, and removes or reverts each hunk
in turn (including the NULL route and the autosplit marker) to show the chain catches it. `smoke-backfill-refuse-split-billing.sql` now accepts the earlier type refusal as
well as the table CHECK. `smoke-govern-invoice-order-money-lifecycle.sql` had rotted against
`20261007150050` (a deleted order's lines are locked, and only a cancelled order may be deleted): its
legacy deleted-fulfilled-order fixture now builds the order first and soft-deletes it last, with
triggers bypassed for that one statement, which only a superuser can do: the prover runs that chain as
`supabase_admin`, and a non-superuser run skips the deleted-order recovery section (CodeRabbit on #928).
`smoke-offline-action-receipts.sql` had rotted the same way as the others (a product is born
pricing-free); it now prices its product through the governed preview/apply path. The new chain is not
run on live: it draws customer-visible invoice numbers.

**Docs.** `docs/reference/migration-history.md` (row 945), `docs/reference/rpc-functions.md`,
`docs/manual/KNOWN_ISSUES.md`, `docs/manual/DECISION_LOG.md`, `docs/plans/2026-10-13-direction-and-goals.md`,
`scripts/smoke/smoke-specs.json` (spec `order_invoice_rep_own_name`).
