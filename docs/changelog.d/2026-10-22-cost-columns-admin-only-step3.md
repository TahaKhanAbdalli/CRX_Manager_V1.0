## 2026-10-22 — Goal 1 step 3: cost, profit and margin columns locked on the remaining cost tables

**What changed.** Migration `20261022101000_cost_columns_admin_only` (migration history row 977; written, not
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
Server functions that run with owner rights (SECURITY DEFINER) cannot be closed by column grants, so the 45
that a signed-in user can execute and whose body names a cost, profit or margin field were read live on
2026-10-25 (Luna round 2), plus every such function whose output columns name one and the three pass-through
wrappers whose inner function does. Each one that returns cost, profit or margin is admin-only (`require_admin()`
or `is_admin()`: the reports, statements, dashboards, application-service costs, `get_admin_cost_fields`,
`get_quote_versions`) or blanks those fields for non-admins (`get_sales_detail_report`, `get_sales_summary_report`,
`get_inventory_position`, `match_quick_receive_items`, `save_quote`). The rest return none: `load_recipe_into_job`
a count, `manual_inventory_add` and `bulk_import_order` a status and quantity warnings, and
`get_customer_year_end_summary`'s `total_cost_cents` is the customer's billed line total, not CRX cost.

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

**Review fixes (2026-10-25).** The lock also refuses to run unless the three functions it leaves as the
only way to cost or the invoice version (`get_admin_cost_fields`, `get_quote_versions`,
`invoice_postable_version`) are still owned by `postgres` and still pinned to `search_path = public, pg_temp`,
as live has them (read 2026-10-23); the proof shows each drift is refused. The rollback smoke check for
posting versions now reads the view's function, and two test fixtures read admin cost in exact cents. The
whole-row check now also refuses a signed-in-executable function that RETURNS a locked row (or has one as an
OUT/TABLE column, or takes or returns an array of them): a definer one would keep handing out cost. Live has
none besides the old `invoice_post_version`, which this file drops first. The proof runs the posting-version
rollback smoke before and after the lock. Luna rounds 3 and 4 added three more refusals: a partly narrowed read
of a generated column; the `invoices_postable` view not readable by signed-in users (or readable by signed-out
ones); and any signed-in-executable SECURITY DEFINER function that reads cost but is not one of the 45 reviewed
live on 2026-10-25, so the review above is re-checked at apply time rather than trusted. The new-column test
guard also refuses a new column named like cost, profit or margin that is not listed as a cost field.

**Deferred (Mason, 2026-10-25).** Luna round 5 asked the preflight to pin the bodies of the 45 reviewed
functions and to follow their calls into inner helper functions. Both concern owner-rights functions, which
column grants never limit; this lock neither widens nor narrows them, so Mason chose to ship the lock as is and
track the function audit separately (`KNOWN_ISSUES.md` KI-02 follow-up: trace the 22 pass-through call chains and
add a standing invariant sweep).
