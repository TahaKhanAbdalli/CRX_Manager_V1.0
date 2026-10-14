## 2026-10-13 — Sales reps work with ANY customer (migration `20261013220000`, NOT applied)

**Owner decision (Mason, in chat, 2026-10-13):** reps create, post and email invoices for any customer,
under their own name only; reps see and edit every customer and every customer-related record; only an
admin reassigns a customer; on a customer not assigned to them a rep cannot change its default commission
split; statements and year-end summaries open to reps. Recorded in `docs/manual/DECISION_LOG.md`. This
reverses the 2026-10-09 admin-only plan (PR #902, closed unmerged) and drops rep scoping.

**Why it was needed:** 146 of 154 live customers have no assigned rep, and live (read 2026-10-13) let a rep
see only their assigned customers and refused save, post and group post for any other customer
(`CUSTOMER_SCOPE_DENIED`), so reps could bill and email almost nobody.

**Database** (`supabase/migrations/20261013220000_reps_work_any_customer.sql`, permissions widening; applies
only with Mason's owner-approval reply):
- 20 functions re-created from their verbatim live bodies (headers checked byte-identical to live) with only
  the assigned-rep tests removed or narrowed (the header lists every hunk, including the dispatch board and
  dispatched list, which now show reps every customer's name); 19 policies lose their assigned-rep
  condition, every other condition kept (20 pinned: `customers_insert` is pinned unchanged).
- Reps always invoice under their own name: `save_invoice` sets a rep's salesperson to the rep ("No
  Salesman" or an omitted key cannot leave a new invoice unattributed or blank an existing one; Codex P1 on
  PR #907), and naming someone else is still refused (`SALESMAN_SCOPE_DENIED`).
- Still refused: a rep changing or posting an
  EXISTING invoice or split set not under their own name, i.e. they are not its salesperson and it is not an
  unattributed invoice they created (`INVOICE_SCOPE_DENIED`,
  `SPLIT_SET_NOT_OWNED`; added after review, since the old assigned-customer rule was the only gate on
  someone else's draft); a rep creating a customer not assigned to themselves (`REP_MUST_SELF_ASSIGN`); a rep
  reassigning a customer (`REP_CANNOT_REASSIGN`, compared with the stored rep, since the edit page always
  sends it back, and only on a current page, so a stale page still gets the reload prompt); a rep changing
  the default commission split of a customer not assigned to them (`COMMISSION_SPLIT_ADMIN_OR_ASSIGNED_REP`);
  a rep deactivating a customer with posted or overdue invoices (`CUSTOMER_HAS_OPEN_INVOICES`; the
  Customers page checked this only in React); and a rep editing a prepay balance by a direct table UPDATE
  (`PREPAY_BALANCE_SERVER_ONLY`; the prepay and payment functions still work), and a customer a rep inserts
  directly starts with no prepay balance. The last four are enforced
  on every path by the new trigger `customers_guard_rep_edit_20261013`, which runs with the caller's rights,
  plus the definer-rights reader `_customer_has_open_invoice_20261013`.
- "Statements" means the 90-day ledger on a customer's page (`get_customer_statement`); printable and
  emailed statements (AR Aging, `get_detailed_statement_data`) stay admin-only.
- Unchanged: every admin-only action, drivers, applicators and other roles, `invoices_select` (a rep reads
  the invoices they created or are the salesperson on), the balance listing's invoice-level filter, the
  reps' own call lists and "my customers" flags, quick deliveries, and the order-invoice RPCs.
- Preflight pins every replaced body and policy to its live md5 of 2026-10-13; postflight checks no
  assigned-rep test remains and owner, grants and security are unchanged.

**Edge Function** `customer-document-files`: admins and sales reps reach every customer's documents (was:
reps only their assigned customers). Needs a deploy, which waits for Mason's explicit OK.

**Screens:** the year-end report's batch code loses its dead non-admin "not assigned to you" branch and
the assigned-customer helper (Generate All is admin-only, so nothing a user sees changes; reps open any
customer's summary in single-customer mode); the Misc Charge invoice screen now loads each customer's email and
billing address, so Email works there and the printed invoice shows the address (both were broken for
admins too); the Documents tab offers Remove to every rep; the customer page shows the default commission
split read-only to a rep on a customer not assigned to them, and its save errors now go through
`sanitizeError` (they showed raw database text); five new error messages (`REP_CANNOT_REASSIGN`,
`COMMISSION_SPLIT_ADMIN_OR_ASSIGNED_REP`, `INVOICE_SCOPE_DENIED`, `CUSTOMER_HAS_OPEN_INVOICES`,
`PREPAY_BALANCE_SERVER_ONLY`).

**Proof:** `node scripts/smoke/prove-reps-work-any-customer-real-schema.mjs` builds the production schema
baseline in a disposable PostgreSQL 17 container, replays every migration, checks the 20 bodies and 20
policies match live, then runs 70 calls as an admin, two reps, a driver, an applicator and a deactivated
rep BEFORE and AFTER the candidate: reps are refused before and allowed after; the narrower rules still
refuse after; every admin and other-role result is identical before and after; a drifted body aborts the
preflight; a second apply is refused; and with the guard trigger dropped the rep's direct reassignment
succeeds (so the refusal is the trigger). Prints `REPS_ANY_CUSTOMER_PROOF_PASS`.

**Live smoke chains** (run on live, rolled back, after the apply): new `smoke-reps-work-any-customer.sql`
(spec `reps_work_any_customer`) covers the eight touched functions no chain covered (the four fact and
interaction writers, prep card, lapsed products, purchase summary, dispatch board) plus the reassignment
refusal; in a disposable container it fails before the candidate (`FACT_ACCESS_DENIED`) and passes after.
Four chains that asserted the old assigned-customer rule now assert the new one:
`smoke-financial-scope-and-delivery-aggregate.sql` (a rep reads any statement and invoices any customer under
their own name; other people's invoices are `INVOICE_SCOPE_DENIED`), `smoke-adversarial-money-inventory-closeout.sql`,
`smoke-per-line-split-billing.sql` (G4: a rep resolves any customer's split) and
`smoke-save-quote-customer-row-version.sql` (a rep edits any customer but cannot reassign it). The first two
were already failing on main at their replay step (`IDEMPOTENCY_ACTOR_MISMATCH` since the August
actor-bound receipts, measured in a disposable container) and now accept that refusal too.

**Follow-ups (not in this change):** the order-invoice RPCs' salesperson check (`KNOWN_ISSUES.md`); the old
SQL smoke chains that assert `CUSTOMER_SCOPE_DENIED` describe the rule at their own migration and are not
re-run past it.
