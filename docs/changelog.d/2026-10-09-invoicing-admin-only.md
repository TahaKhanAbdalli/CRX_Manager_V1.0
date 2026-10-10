## 2026-10-09 - Invoicing becomes admin-only (database phase; migration written, NOT APPLIED)

Mason's decision (2026-10-09, in chat): no sales rep, driver or other non-admin may invoice any
customer; rep scoping is dropped (PR #891 closed, its `20261008120000` never applied); sales reps read
every invoice. His answers: reps still record payments, applying credit memos and prepayments becomes
admin-only; drivers are included; a rep's or driver's completion makes no invoice and notifies the
admins; cancelling a delivery that has an admin's invoice is not blocked; the old rep/invoice items
close. The server-side posting version check moves in from PR #892 (Mason chose "split it").

### What changed (phase 1 = database only; the screens are phase 2, after PR #892)

- `supabase/migrations/20261009120000_invoicing_admin_only.sql` — **LOCAL CANDIDATE, NOT APPLIED.**
  - `_require_invoicing_admin()`: fail-closed EXISTS check for an ACTIVE admin, 42501
    `INVOICING_ADMIN_ONLY`, executable by no API role.
  - Rename-and-wrap of 22 public RPCs (create/edit, post/unpost, batch void, credit memo and prepay
    apply, quick delivery): the reviewed body becomes `_<name>_pre_admin_only_20261009` (owner-only);
    the wrapper keeps the name, arguments, defaults, result and ACL and calls the guard first.
    `create_split_invoices_from_order` requires its key first (carried over from #891).
    `create_quick_delivery` forces `p_skip_invoice = true` for non-admins instead of refusing.
  - `_complete_delivery_authorized_impl` and `complete_job` re-emitted from their live bodies with one
    admin-only hunk each; a non-admin's completion writes `delivery_invoice_pending_admin` activity and a
    `delivery_needs_invoice` notification per active admin.
  - Posting version check: `post_invoice`, `post_invoice_group`, `batch_post_invoices` take a trailing
    `p_expected_version text DEFAULT NULL`; readers `get_invoice_post_version(uuid[])` and
    `get_invoice_group_post_version(uuid)`; refusal `INVOICE_CHANGED_SINCE_REVIEW` under the
    implementation's row locks; old callers unchanged; one overload per name.
  - Table layer: invoice INSERT policies admin-only; direct writes on `invoice_shares` and
    `invoice_line_allocations` revoked. Read side: six invoice SELECT policies add `is_sales_rep()`,
    plus `write_offs_select_sales_rep`.
  - Preflight pins every changed body (live md5 read 2026-10-09), signature, ACL and policy, and
    requires PR #889's four migrations in the ledger; the postflight pins the result and runs a
    hard-guard catalog sweep that refuses the apply if any function `authenticated` can run reaches an
    invoice write without the guard and is not on a pinned already-admin-only or upkeep list.
- `src/lib/db.ts`, `src/lib/errorSanitizer.ts`: `INVOICING_ADMIN_ONLY` ("Only an admin can do
  invoicing.") and `INVOICE_CHANGED_SINCE_REVIEW`, with tests.
- `src/lib/invoicingAdminOnlyMigration.test.ts` (static shape test);
  `src/lib/rpcContracts.test.ts` follows `batch_post_invoices`' replay contract into its frozen body;
  `src/lib/rlsContracts.test.ts` records the new invoice read rule.
- `scripts/smoke/smoke-invoicing-admin-only.sql` (container-only chain, spec
  `_require_invoicing_admin`) and `scripts/smoke/prove-invoicing-admin-only-real-schema.mjs`.
- Chains kept passing across the change: `smoke-order-invoice-type-gate.sql`,
  `smoke-prepay-payment-inactive-actor-gate.sql` (branch on the guard existing; drop after apply) and
  `smoke-field-app-split-penny-exact.sql` (follows the renamed bodies).
- Docs: DECISION_LOG, KNOWN_ISSUES, CURRENT_STATE, OWNER_PLAYBOOK, RLS_SECURITY_GUIDE,
  QUOTE_TO_DELIVERY, rpc-functions, migration-history (row 938, LOCAL CANDIDATE).

### Proof observed

- Live re-grounding (read-only, 2026-10-09): every changed body's md5 (CR-stripped), signature,
  result, security mode, `search_path` and ACL; the comment-stripped `pg_proc` caller scan for every
  renamed name (listed in the migration header); `cron.job` and `supabase/functions` (no callers);
  the 11 replaced policies and the invoice-table grants. The container replay matches all of them.
- `node scripts/smoke/prove-invoicing-admin-only-real-schema.mjs` → `INVOICING_ADMIN_ONLY_PROOF_PASS`
  (fresh container, baseline + 103 replayed migrations + PR #889's two schema migrations):
  - BEFORE: a sales rep really wrote through 19 of the 21 guarded RPCs (the other two already refused
    reps: batch void, and bulk prepay which is disabled for everyone); rep, driver and offline
    completions, a rep's split completion and a rep's job completion auto-invoiced; reps' and drivers'
    quick deliveries invoiced; a rep inserted `invoice_shares` / `invoice_line_allocations` rows; a rep
    read none of an admin's invoices; a post went through an invoice changed by a concurrent save.
  - AUTOCOMMIT refused; 14 preflight drifts each refused with their own code; 4 postflight mutants
    rolled the apply back; APPLY printed `POSTFLIGHT_OK`.
  - AFTER: all 21 RPCs refuse a sales rep, driver, applicator, entity_recipient, deactivated admin and a
    caller with no profile with 42501 `INVOICING_ADMIN_ONLY`, no number drawn and nothing left, also
    with their locks held by a second session; anon cannot execute; admin results and database state
    identical to BEFORE including exact replay; the 15 already-admin-only functions refuse a rep.
  - Reads: a rep reads every invoice table the pages read; drivers and applicators unchanged.
  - Completions: no invoice and no number for reps and drivers (online, offline, split), one activity
    row and one notification per active admin, listed under "Delivered, not invoiced"; the admin's
    Create Invoice bills the same lines the old auto-invoice had; admin completions and the partial
    resize of an admin's quick-delivery draft unchanged; `cancel_delivery` unchanged.
  - Posting version check: two-session race refused under the row lock; unchanged invoice, group and
    batch post; replay not re-checked; old callers (positional and named) still post.
  - Sweep clean; a new unguarded writer, a late guard and a changed upkeep body are caught.
  - 20 related registered chains: 9 pass before and after, 9 fail identically before and after
    (container fixtures), 2 stale rep chains now stop at `INVOICING_ADMIN_ONLY` (intended).
  - 46 mutations (one per gate) each turned the prover red; restored, green.
- `npm run typecheck`, `npm run lint`, `npm run test` (383 files, 5475 tests passed, 123 skipped),
  `node scripts/check-doc-drift.mjs` all pass.

### Not done here (owners)

- Apply: Mason's explicit yes and Windows Hello approval, after PR #889's four migrations.
- Phase 2 (screens) after PR #892: hide every mutating invoice control for non-admins, send the
  reviewed version when posting, the rep's customer-name gap on invoice lists.
- `package.json` proof script line (ask-listed file): `"proof:invoicing-admin-only": "node scripts/smoke/prove-invoicing-admin-only-real-schema.mjs"`.
- CI does not run the container prover or the chain; the sweep blocks at apply time, not on the PR.
- Regenerate `.claude/schema-registry.json` after the apply.
