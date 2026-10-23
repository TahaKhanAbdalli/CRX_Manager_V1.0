## 2026-10-22 — Goal 1 step 3: cost, profit and margin columns locked on the remaining cost tables

**What changed.** Migration `20261022091000_cost_columns_admin_only` (migration history row 977; written, not
yet applied) takes the cost,
profit and margin columns of `products`, `quotes`, `quote_items`, `quote_versions` (`snapshot_data`), `orders`,
`order_items`, `invoices`, `invoice_items`, `jobs`, `job_chemicals`, `blend_ticket_products` and `commissions` out of
the Data API grants of `authenticated` and `anon`. Every other column keeps exactly the privileges it had (except the generated `jobs.remaining_acres`, which drops
an `INSERT`/`UPDATE` it could never use). Where
`authenticated` could write a table directly (`quotes`, `orders`, `jobs`, `job_chemicals`, `blend_ticket_products`,
`commissions`), its `INSERT`/`UPDATE` grants list every column except cost, so a rep can no longer type a cost
straight into those rows. Admins keep seeing cost through `get_admin_cost_fields`, and quote history through
`get_quote_versions`, both admin-checked server functions; no screen changes. Once applied, this finishes Goal 1 part 3 (cost and
margin are admin-only, Mason 2026-10-15). Purchase-order cost was locked earlier (`20261021141000`, PR #980).

**Why it was safe.** A read-only inventory on 2026-10-22 checked every one of the 201 places the app reads these
tables and the 20 places it writes them: none asks for a cost column or a whole row (`*`), and none writes cost. Edge
Functions read them only with the service role. Every function or trigger that reads cost runs with its owner's
rights (SECURITY DEFINER) or is a helper only those call; the triggers that run as the caller only touch the row being
written, which needs no column privilege. None of the tables feeds a realtime subscription.

**Docs.** `KNOWN_ISSUES.md` entry updated, to be closed after the apply (two residuals accepted for now by Mason on
2026-10-21: commission amount and rate imply profit; a below-cost refusal lets a rep narrow a cost by trial and
error) and corrected: reps could not write `invoice_items`
directly. `gotchas.md`: the column-carved table list now names all twelve tables. Goals doc: Goal 1 status.

**Proof.** `node scripts/smoke/prove-cost-columns-admin-only-real-schema.mjs` builds the production schema in a
throwaway database, replays every migration, and checks the lock role by role before and after.

**Invoice posting version (2026-10-22).** The lock first removes the old `invoice_post_version` on
`invoices` (PR #1018), which reads a whole invoice row and would fail for everyone once cost is hidden.
Screens read the version from `invoices_postable` (migration 20261022090000) since that change, and
the lock refuses to run unless that view and its function are in place. The proof replays both first,
then shows an admin and a rep still get the version from the view after the lock.
