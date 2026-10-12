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
  - BEFORE: a sales rep really wrote through 19 of the 22 guarded RPCs (the other three already refused
    reps: batch void, bulk prepay which is disabled for everyone, and `reverse_write_off`, which a
    deactivated admin could still run - reproduced); rep, driver and offline
    completions, a rep's split completion and a rep's job completion auto-invoiced; reps' and drivers'
    quick deliveries invoiced; a rep inserted `invoice_shares` / `invoice_line_allocations` rows; a rep
    read none of an admin's invoices; a post went through an invoice changed by a concurrent save.
  - AUTOCOMMIT refused; 16 preflight drifts each refused with their own code; 4 postflight mutants
    rolled the apply back; APPLY printed `POSTFLIGHT_OK`.
  - AFTER: all 22 RPCs refuse a sales rep, driver, applicator, entity_recipient, deactivated admin and a
    caller with no profile with 42501 `INVOICING_ADMIN_ONLY`, no number drawn and nothing left, also
    with their locks held by a second session; anon cannot execute; admin results and database state
    identical to BEFORE including exact replay; the 14 already-admin-only functions refuse a rep.
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
  - 65 mutations (one per gate, round 1 included) each turned the prover red; restored, green.
- `npm run typecheck`, `npm run lint`, `npm run test` (384 files, 5483 tests passed, 123 skipped; re-run after review round 1),
  `node scripts/check-doc-drift.mjs` all pass.

### Review round 1 fixes (same day, same candidate file, still NOT APPLIED)

- Direct REST writes: a sales rep could insert, update and delete `field_app_locations` and
  `field_app_location_shares` rows on any field invoice, draft or posted (live grants and policies
  read). Their writes, and `write_offs`' writes, are revoked from `authenticated`/`anon`/`PUBLIC` and
  their write policies are admin-only; TRUNCATE is revoked on `field_app_billing_sets` / `_lines`.
- `reverse_write_off` is wrapped too: its own role test let a deactivated admin through.
- Posting version check: `post_invoice` takes the implementation's key lock before it looks for a
  stored receipt (a same-key duplicate waits and replays; proven in two sessions); a version without a
  key is `IDEMPOTENCY_KEY_REQUIRED` on `post_invoice` and `batch_post_invoices`; the batch's key-only
  receipt lookup is documented.
- `complete_job`: a non-admin's completion notifies every active admin (`job_needs_invoice`).
- The hard-guard sweep covers every invoice table (`invoice_line_share_snapshots`,
  `invoice_line_allocations`, `field_app_locations`, `field_app_location_shares`,
  `field_app_billing_sets`/`_lines`, `write_offs`), MERGE/TRUNCATE, ONLY and quoted names, procedures,
  comments stripped left to right; "guard first" no longer accepts a DECLARE initializer or a nested
  block; the key-first form only for the split wrapper. The registered chain runs the same query text.
- New CI-blocking static test `src/lib/invoiceWriterGuard.test.ts` applies the rule to every
  migration from `20261009120000` on.
- `INVOICE_EXPECTED_VERSION_INVALID` is mapped in `db.ts` / `errorSanitizer.ts`.
- Prover: the reverse-write-off bug and the direct field-app writes reproduced before; another rep's
  customer in the read check (plus a rep-scoped-read mutant); group and batch two-session races; a
  same-key duplicate; every fingerprint leg (line shares, customer shares, a member added or
  soft-deleted); the new sweep cases; mutants for each new gate.

### Review round 2 fixes (same candidate file, still NOT APPLIED)

- Delivery completion vs a versioned post (reviewers: the completion re-sizes an admin's draft
  before it locks the invoice row): checked in two sessions, before and after the candidate. Posting
  an order invoice fires `guard_mono_invoice_split_billing_post`, which locks the order's
  `order_items`, and the completion holds those rows, so the race ends in a deadlock (one side
  aborted, 40P01, nothing of it committed); a posted invoice is never re-sized. A lock added inside
  the completion was tried and dropped (it adds the same deadlock to every full completion meeting a
  post); the completion body stays the round-1 body. The prover keeps the two-session case.
- Read side: `field_app_billing_lines_select` is widened too; both split-billing read policies let a
  rep read a set or line only through a non-deleted invoice that uses it; `invoices_select` and
  `invoice_items_select` are `TO authenticated` (under `TO public` anon got a permission error from
  `is_sales_rep()` instead of no rows). Cost and margin on invoices: reps already read the same cost
  and margin on every order line (live policies read 2026-10-10), so no new kind of data opens.
- Postflight: the version readers' owner and EXECUTE list are pinned; `invoices` / `invoice_items`
  must have no API write grant; a guard-first body with an exception handler is not accepted; dynamic
  SQL (`EXECUTE`) naming an invoice table counts as a write; a trigger writing an invoice table from a
  table `authenticated` can write refuses the apply; the apply session's `search_path` is pinned to
  live's default so the policy pins do not depend on the apply tool.
- PR-time guard `src/lib/invoiceWriterGuard.test.ts`: keyed by signature (a guarded overload cannot
  hide an unguarded one); comment stripping keeps string literals; the exception-handler and
  dynamic-SQL rules; `REVIEWED_BODIES` pins the guard helper, the fingerprint, `complete_job` and the
  completion implementation, and any later re-emission of a pre-existing invoice-reaching internal
  function needs a reviewed pin (probe: re-emitting the pre-candidate completion body is caught).
  Each new rule was mutation-checked (5 of 5 mutants turned the test red).
- Live, read-only (2026-10-10): every preflight pin re-checked against live (23 wrapped RPCs: body,
  owner, security mode, `search_path`, result, grants; 33 more body pins; 17 replaced policies and the
  policy sets) - all match; `batch_void_invoices` still delegates to `void_invoice` (its pin and
  `batch_cancel_deliveries`' come from the live body / the 2026-07-27 baseline, not a migration file);
  no function uses `EXECUTE` with an invoice table; the only invoice-writing trigger is on `invoices`;
  `guard_mono_invoice_split_billing_post` is enabled live.
- Prover: the completion race (two sessions, before and after); the BEFORE rep writes must change the
  invoice itself (posts posted, unposts unposted, field-app header fields set); the admin comparison
  includes per-table row-count deltas over 18 tables; notification recipients must be exactly the
  active admins; the split key refusal for every role; frozen implementations closed to every API
  role and refused when called directly; a service_role caller with no subject refused; 7 more
  postflight mutants (11 in all, one per postflight branch); sweep cases and mutants for the
  exception-handler and dynamic-SQL rules; the completion mutant must fail for its named reason;
  after the mutations every section is re-run green and every policy is back at its pin.
- Error text: the posting refusals no longer say "This invoice" (they also come from group and batch
  posts); `db.ts` records that a version-checked post needs a key.
- Proof (2026-10-10, fresh container): `INVOICING_ADMIN_ONLY_PROOF_PASS ... postflight=11_mutants
  ... completion_race=posted_invoice_never_resized_before_and_after ... chains=9_pass,
  9_fail_before_and_after_no_signal,2_rep_chains_stop_at_admin_only ... mutations=68_detected`
  (the race ended with the rep's completion aborted as the deadlock victim and the admin's post
  intact, before and after). `npm run typecheck`, `npm run lint`, `npm run test` (5489 passed,
  123 skipped) and `node scripts/check-doc-drift.mjs` pass.

### 2026-10-10 - Mason's decisions "1.a" and "2:yes" (still NOT APPLIED)

- **1.a, invoice upkeep (no behaviour change):** a sales rep's order pricing / order-line
  edits / rush order (`price_order`, `update_order_items`, `create_rush_order`) and delivery cancel
  (`cancel_delivery`, `batch_cancel_deliveries`), and a rep's or driver's partial delivery completion
  (the resize and tote stamp in `_complete_delivery_authorized_impl`; drivers reach no other upkeep
  path, the rest role-gate to admin and sales_rep) keep updating an admin's DRAFT or UNPOSTED invoice
  exactly as today; posted invoices never change; an admin still reviews and posts. Recorded in the
  migration header (the "NEEDS MASON" line is gone), the comments on both sweep allowlists (preflight
  and postflight, and the chain's step-8 copy), DECISION_LOG, KNOWN_ISSUES and OWNER_PLAYBOOK. This
  settles the round-3 Luna BLOCKER and rls-security HIGH about the upkeep paths. Separate defects stay
  OPEN: a cancel can reverse a COMPLETED delivery; `update_order_items` does not lock the invoice.
- **2, customer names for reps:** new `public.get_invoice_customer_names(p_customer_ids uuid[])
  RETURNS TABLE(id uuid, farm_name text)` (SQL, STABLE, SECURITY DEFINER, `search_path = public,
  pg_temp`, EXECUTE for `authenticated` only): the farm name of each requested customer that a
  non-deleted invoice names (customer, customer share, line share or line-share snapshot), for an
  active admin or sales rep; anyone else gets no rows. The `customers` policies are not touched: the
  preflight and postflight pin `customers_select`, `customers_select_location_dispatchee` (live md5
  read 2026-10-10) and the policy set; the postflight pins the reader's body, result columns,
  volatility, owner and EXECUTE list (`POSTFLIGHT_CUSTOMER_NAMES_CONTRACT`,
  `POSTFLIGHT_CUSTOMERS_POLICY`). Phase 2 switches the pages to it.
- Prover: section 5b (customer names) before and after; 3 more preflight drifts, 4 more postflight
  mutants and 7 more mutations (role gate, invoice-reference gate, soft-deleted filter, share leg, an
  extra column, an anon grant, `customers_select` widened). Shape test: two new cases.
- Proof (fresh container, 2026-10-10): `INVOICING_ADMIN_ONLY_PROOF_PASS ... preflight=19_drifts
  postflight=15_mutants ... customer_names=rep_names_only,customers_policy_unwidened,others_none,anon_denied
  ... mutations=75_detected`; a rep, another rep and an admin read exactly the two invoice-named
  customers' farm names (not the customer on no invoice, not the one on a soft-deleted invoice), keys
  `farm_name,id` only; a rep's direct `customers` read of them stays empty. `npm run typecheck`,
  `npm run lint`, `npm run test` (5491 passed, 123 skipped) and `check-doc-drift` pass.

### 2026-10-10 - review round 4 fixes (still NOT APPLIED)

- **Posting version covers the customer's payment terms** (Luna MED, confirmed live: the assigned
  sales rep can edit `customers.payment_terms` under `customers_update`, and the post falls back to
  it for the due date). `_invoice_review_fingerprint` now also hashes the invoice customer's
  `payment_terms`; body pin `658f42b2...` -> `d5645406...` in the postflight and
  `invoiceWriterGuard.test.ts`. Residual (KNOWN_ISSUES): the customer row is read, not locked.
- **`batch_post_invoices`' receipt lookup is scoped to its operation** (`k.operation =
  'batch_post_invoices'`, the name its frozen body claims under, read live), so the version re-check
  no longer relies on the frozen body's cross-operation refusal. Wrapper pin `83ebbc30...` ->
  `23f5dde2...`.
- **TRUNCATE** on `invoice_line_shares`, `invoice_line_share_snapshots`, `field_app_billing_sets`
  and `field_app_billing_lines` is revoked from `authenticated, anon, PUBLIC` (was `authenticated`
  only) and the postflight asserts `anon` has none (live 2026-10-10: anon and PUBLIC held none).
- **PR-time guard** (`invoiceWriterGuard.test.ts`) gains the table layer: a later write grant on an
  invoice table (or all tables) to an API role, a non-SELECT or altered policy on one, row level
  security turned off, or a function created through dynamic SQL in a DO block, fails until reviewed.
- **Prover**: the names reader's four legs are each exercised both ways (C7 line share, C8 snapshot
  on live invoices returned; C9 share, C10 snapshot, C11 line share on soft-deleted invoices not);
  sentinels in every writable customer column; a deactivated sales rep gets no names; 10 more
  runtime mutants (each leg dropped / joined to any invoice / counting deleted invoices, a role gate
  ignoring `is_active`, other fields folded into `farm_name`), every names mutant names its expected
  failure; 6 more postflight mutants (no pinned search_path, SECURITY INVOKER, VOLATILE, a
  service_role grant, a second overload, `customers_select_location_dispatchee` widened) and one
  more preflight drift; the version check refuses after the assigned rep edits the customer's terms
  through RLS (on the round-3 body that post went through) and after a cross-operation batch key,
  each with a mutation.
- **Chain** step 6b: a rep reads only `(id, farm_name)` of an unassigned customer on an invoice
  (direct read empty), a driver gets nothing; `get_invoice_customer_names` added to the spec's covers.
- **Docs**: drivers reach upkeep only through partial completion (the other upkeep RPCs role-gate to
  admin and sales_rep); reps see invoice-level terms/balances (from the 2026-10-09 read widening),
  not customer address, phone, contacts or account number.
- **Deferred, with owners in KNOWN_ISSUES**: `cancel_delivery` reversing a completed delivery (Luna
  HIGH, pre-existing, not redefined here); `update_order_items`' unlocked line detach (Luna MED,
  pre-existing); the trigger check not following calls (accepted residual; live has no such
  trigger); the names reader's field-app / write-off / allocation references (phase 2; none on live).
- Live read-only checks 2026-10-10: the `customers` policy md5s and five-policy set match the pins;
  the only trigger that reaches an invoice write (directly or through calls) is
  `trg_snapshot_line_shares_on_post` on `invoices`, which `authenticated` cannot write.
- Proof (fresh container, 2026-10-10): `INVOICING_ADMIN_ONLY_PROOF_PASS ... preflight=20_drifts
  postflight=21_mutants ... mutations=87_detected`. `npm run typecheck`, `npm run lint`,
  `npm run test` (5495 passed, 123 skipped) and `check-doc-drift` pass.

### 2026-10-10 - phase 2: the screens (needs the file above applied first)

Mason's decisions applied: reps SEE every invoice, read-only, with customer names; routes whose only
purpose is creating an invoice are admin-only; reps' order edits and partial completions keep
updating admin drafts (no UI block, "1.a"); reps still cancel deliveries and record payments.

- **One rule:** `canManageInvoices(role) = role === 'admin'` in `src/lib/pagePermissions.ts`; every
  invoice-changing control below uses it.
- **Routes and nav** (`src/App.tsx`, `pagePermissions.ts`, `Sidebar.tsx`, `TopBar.tsx`):
  `invoices/field-app/new`, `split-billing/new` and `split-billing/:id` are `['admin']`, and the
  `split-billing` page entry is admin-only. The invoice list and detail routes, the Field Invoices
  tabs and the field-app invoice view stay `['admin','sales_rep']`; their nav entries stay for reps.
  `/invoices/new` (the Misc Charge entry) shares the `invoices/:id` detail route, so InvoiceDetail
  sends a non-admin back to the list. The Split Billing nav link and the New menu's "Field App
  Invoice" are admin-only. Drivers unchanged.
- **Inside the pages, hidden or disabled for non-admins:** `Invoices.tsx` (row checkboxes, Select
  All, Post/Void/Delete/Print Selected, Misc Charge); `InvoiceDetail.tsx` (Save, Post, Transfer to
  Scheduling, Apply Credit, Unpost, every editable field; a "Read-only — only an admin can change,
  post or unpost invoices" note; Print and the existing field-invoice Email stay); the three Field
  Invoices panels (Post All, Unpost All, Manual Invoice; a rep's row action reads "View");
  `UnbilledApplicationsPanel` (Create Invoice column); `FieldApplicationInvoice.tsx` (every input
  disabled through `canEdit`; Save, Post, Unpost, Delete, Transfer gone; Print, Old Print, Email
  stay; a rep gets a read-only note instead of the "unpost to edit" banner); `FieldAppSplitInvoiceEditor`
  (second layer behind the route: a notice instead of the editor); `OrderDetail` (Create Invoice,
  Create Split Invoices, Consolidate drafts, Post all drafts; Price Order stays); `BlendTicketDetail`
  (the Direct Invoice card); `JobDetail` (Transfer to Invoice); `OfficeCockpit` (Post all clean; the
  queue stays). `PaymentAllocation` needed no change: it has no credit-memo or prepay apply (those
  live on InvoiceDetail and the admin-only Prepay page). Handlers re-check the rule too.
- **Split children for reps:** the Split Billing editor is admin-only, so InvoiceDetail no longer
  sends a rep's draft split child there (it renders read-only), and the per-acre editor hands a
  rep's split child to `/field-invoices/:id` with a one-shot `splitChildReadOnly` route state that
  stops InvoiceDetail bouncing a job-less draft straight back (no redirect loop).
- **Unsaved-changes guards:** a rep's read-only page never turns dirty (InvoiceDetail's new tracking
  counts only an admin's edits; FieldApplicationInvoice's inputs are disabled through `canEdit`), so
  neither the Post block nor the leave-page prompt fires for a rep.
- **Rep-visible copy:** after a non-admin completes a delivery: "Delivery completed. An admin will
  create the invoice." (DeliveryDetail, FieldStop; the Deliveries list keeps its delivery number:
  "Delivery D-123 completed. An admin will create the invoice."); a job: "Job completed! Application
  record R-1 created. An admin will create the invoice." FieldStop's done screen says the same. The
  page decides by role; no RPC result changed. DeliveryDetail's "a draft invoice is created
  automatically" help tip has rep wording and the auto-created-invoice banner is admin-only.
  QuickDeliveryModal: no "Create draft invoice" box for non-admins, `p_skip_invoice` always true for
  them (the database forces it too), banner, confirm and toast say an admin will create the invoice;
  an admin's banner now says the invoice is posted "by an admin" (was "by a sales rep").
- **Customer names for reps** (`src/lib/invoiceCustomerNames.ts`): `fillHiddenCustomerNames` calls
  `get_invoice_customer_names` once per list with only the ids whose `customers` embed came back blank,
  so an admin (who reads every customer) never calls it. Used by Chemical Invoices, InvoiceDetail,
  the three Field Invoices lists, the per-acre editor's split-member banner and
  `buildInvoicePdfDataFromRow`'s customer-share names (which then fall back to the name stored on the
  share row). A failed read is not fatal (the page keeps "Unknown"). Not covered (blank for a rep):
  the per-acre editor's location table (field owner), the Unbilled backlog and the Today page tiles.
- **InvoiceDetail Post (addendum 8b):** Post is disabled while the form has unsaved edits, with the
  reason shown; the posting version (`get_invoice_post_version([id])`, or
  `get_invoice_group_post_version(group)` for a split group) is read at the start of every load,
  before anything shown is read, and again when Post is pressed; if they differ the page reloads
  with "This invoice changed since you reviewed it — it has been reloaded; check it and post again."
  The credit-limit and restricted-use checks run on the SAVED invoice read after that version. The
  version goes out as `p_expected_version` on `post_invoice` / `post_invoice_group` (with the
  existing key; a group post passes the signed-in admin as `p_performed_by`, which the group check
  requires); `INVOICE_CHANGED_SINCE_REVIEW` shows the same message and reloads. The 17de50533
  browser-side re-check was used as reference only; the database check is the gate. The list pages'
  bulk posts now send a version too (see "Bulk Post checks what the list showed" below).
- **Types:** `src/types/supabase.ts` is generated from live and does not know the two version readers,
  the names reader or `p_expected_version` yet. Following the repo's typed-wrapper pattern
  (`quoteLifecycleRpc.ts`), `src/lib/invoicePostVersion.ts` and `src/lib/invoiceCustomerNames.ts` call
  them through `supabaseUntyped` with hand-declared argument and result shapes (no `any`, no
  `@ts-ignore`). **Regenerate `src/types/supabase.ts` after the apply** and move these calls back to
  the typed client.
- **Tests:** new `src/pages/InvoiceDetail.adminOnly.test.tsx`, `src/pages/Invoices.adminOnly.test.tsx`,
  `src/components/field-invoices/FieldInvoicesAdminOnly.test.tsx`; rep cases added to
  `FieldApplicationInvoice.test.tsx`, `FieldAppSplitInvoiceEditor.test.tsx`,
  `UnbilledApplicationsPanel.test.tsx`, `QuickDeliveryModal.test.tsx`, `TopBar.test.tsx`,
  `pagePermissions.test.ts`; nav tests assert reps keep both invoice tabs. All 26 new behaviour cases
  were run against the pre-change source files (restored from HEAD, tests kept) and every one failed
  there. `idempotency-reset-order.test.ts`: InvoiceDetail no longer has a `.throwOnError()` site of its
  own (it moved into the helper), so its stale `throw-on-error` allowance was removed.
- **Known red gate until the apply:** `src/lib/rpcFixtureLiveDiff.test.ts` ("every literal production
  RPC call exists live or in a verified queued migration") fails because the page now calls
  `get_invoice_customer_names`, `get_invoice_post_version` and `get_invoice_group_post_version`, which
  are not live yet. That guard exists so a frontend cannot merge ahead of its migration; its queued
  exception may not be committed (the same file's "does not commit queued RPC exceptions" case
  fails on any non-empty `QUEUED_MIGRATION_FUNCTIONS`; the header allows that map only as a local,
  uncommitted bridge). It clears when the migration is applied and the checked-in `pg_proc` snapshot
  in that test is regenerated from live (part of the apply step). Do not merge before that. Nobody
  may report `npm run test` as passing for phase 2 until then.

#### Review round 5 (2026-10-10, compliance + UI-logic + Luna findings)

- **Posting version on the other two editors** (two MEDs): the per-acre field-app editor reads the
  version (`get_invoice_post_version`, or `get_invoice_group_post_version` for a group, from the
  preflight's `status` and `invoice_group_id`) at the start of every admin load of a draft or
  unposted invoice, before the invoice data; the Split Billing editor reads the group's version
  before every readback of its result card (after a save, on reopen, and after a refusal). Both post
  through `postReviewedInvoice` / `postReviewedInvoiceGroup` with `p_expected_version`, refuse to
  post (nothing sent) when the version could not be read or belongs to another group, and on
  `INVOICE_CHANGED_SINCE_REVIEW` reload with the shared message. The two messages now live in
  `src/lib/invoicePostVersion.ts`.
- **Handlers re-check the rule** in `FieldApplicationInvoice` (save, override-save, post, unpost,
  void, delete, transfer), the Split Billing editor (save, post) and InvoiceDetail's void, apply
  credit and reverse write-off; InvoiceDetail's Void, Record Payment / Write Off and Reverse
  write-off controls use `canManage` instead of a second `isAdmin` test (same result).
- **InvoiceDetail** says "Could not check the saved invoice before posting. Nothing was posted"
  (and reloads) when the version could not be read at load, instead of "This invoice changed".
- **Reps and unreadable customers:** the Chemical Invoices list shows another rep's customer as plain
  text, with no link and no peek drawer (`get_customer_summary` is unscoped; KNOWN_ISSUES); a rep's
  Email on such a customer's field invoice says "You can't see this customer's email address. Ask an
  admin to email this invoice." instead of "no email address on file"; a rep's row action in the
  Drafts tray shows an eye, not a pencil.
- **PDF share names** use the name stored on the share row before the names reader, so a rep's Print
  All no longer makes one reader call per invoice (the reader is called only for a share with
  neither).
- **Tests:** InvoiceDetail's admin-only test now uses the real `hasRpcCode`, `RpcErrorCodes`,
  `assertRpcResult` and `describePostInvoiceBlock`; admin rows with a blank embed assert exactly one
  names call with exactly that id (InvoiceDetail, Chemical Invoices). Every new behaviour case was
  run against the pre-change page and failed there. `idempotency-reset-order.test.ts`: the per-acre
  editor's only `.throwOnError()` post moved into the helper, so its stale `throw-on-error` allowance
  was removed (the guard's own "no allowlist entry is stale" case requires it).
- **Refuted, with evidence:** Luna HIGH "a member inserted after the member query escapes the group
  version". Live read-only 2026-10-10: `authenticated` has no INSERT or UPDATE on `invoices`; the
  only functions that write `invoices.invoice_group_id` are `save_field_app_invoice` (an existing
  group only through its wrapper, which takes `pg_advisory_xact_lock(hashtextextended(group,0))`),
  `save_field_app_split_invoice` (same lock on the set's group), and
  `create_split_invoices_from_order` / `create_invoice_from_blend_ticket` /
  `transfer_job_to_invoice` / `_save_field_app_split_invoice_impl` for a new set, which mint a new
  `gen_random_uuid()` group.
  The versioned group post takes that same lock before its member read, so no writer can add a
  member to the group in between.
- **Deferred, unchanged migration** (each already an accepted residual or KNOWN_ISSUES entry with an
  owner; changing them means re-pinning and re-proving the file): `cancel_delivery` reversing a
  completed delivery (Luna HIGH, pre-existing, Mason's addendum item 5 says do not fix it here);
  field-app acres not in the fingerprint and customer terms read, not locked (header lines 161-164);
  `update_order_items`' unlocked line detach; the completion/post deadlock (one side retries); the
  trigger check not following calls (no live instance); the postflight's comment stripping not being
  literal-aware (no live instance).

### 2026-10-12 - Bulk Post checks what the list showed (Codex Luna HIGH; no database change)

- **The gap:** the four bulk posts (Chemical Sales "Post Selected", the Field Invoices Drafts tab
  "Post All", the Office Cockpit "Post all clean" and the order page "Post all drafts") called
  `post_invoice` / `post_invoice_group` with no posting version. If another admin changed an invoice
  from $50.00 to $70.00 after the list loaded, clicking Post posted the $70.00 nobody on that screen
  had seen.
- **Now:** before posting anything, each of the four reads the posting version of every invoice or
  split group it is about to post (`src/lib/invoiceBulkPostReview.ts`, at most six reads at once),
  and only then re-reads the rows the screen showed (status, total, customer, invoice date, split
  group, last-changed time). If any row is gone, deleted or different, nothing is posted, the screen
  reloads and says "N invoice(s) changed since this list loaded — the list was reloaded; check them
  and post again." If the check itself cannot run, nothing is posted and the screen says so. When
  everything matches, each post carries the version just read, so the database still refuses
  (`INVOICE_CHANGED_SINCE_REVIEW`, shown in plain words in the failures list) a change that lands
  after the check. (Superseded the same day by review round 1 below: reading the version at click
  folded changes the list does not show, such as a customer's terms or a split-group member it never
  loaded, into the version. The versions are now read when the screen loads.)
- **Kept as before:** each target's idempotency key (reused on a retry), partial-success reporting,
  the Field Invoices this-season skip, the order page's already-posted check (it runs first, so a
  post that already went through is still counted as done), the cockpit's fresh watchdog re-check
  (the version check runs after it, on the still-clean invoices only), and the Chemical Sales list
  keeping failed invoices selected. The cockpit's "Ready to Post" load now also reads each invoice's
  customer and last-changed time so it has something to compare.
- **Proof:** the screen tests were written first and run against the unchanged code: 11 failed
  there (no version read, no `p_expected_version`, and a changed invoice was posted anyway); all
  pass after. New `src/lib/invoiceBulkPostReview.test.ts` covers the read order, each kind of
  change, a missing or deleted row, a failed version read (no row read), a failed row read, the
  six-at-a-time limit and the 100-row chunks. This needs the migration above applied before it can
  run against the real database; no signed-in browser run was possible here.

### 2026-10-12 - Bulk Post review round 1: the version is read when the screen loads

- **What the reviewers found (and was true):** the first version read each target's posting version
  when Post was CLICKED, then compared only the invoice rows (status, total, customer, date, split
  group, last-changed time). The version also covers the invoice's lines, line shares, customer
  shares, the customer's payment terms and every member of a split group, and those can change
  without touching the invoice row. So a change made between the load and the click (a rep moving a
  customer from Net 30 to Net 10, a line edit that keeps the total, or a split-group member the list
  never loaded or that was added later) was folded into the version and posted. The wording "a post
  that succeeds is exactly what the screen showed" was wrong.
- **Now:** each of the four screens reads its posting versions as soon as its rows load (admins
  only; `useInvoicePostBaseline` in `src/lib/invoiceBulkPostReview.ts`), and the post sends THAT
  version. Anything in the version that changes after the load makes the database refuse that post
  (`INVOICE_CHANGED_SINCE_REVIEW`). At click the screen still re-reads the rows it showed, and now
  also each targeted split group's member list; any change refuses the whole batch early, reloads
  the screen and names up to three of the changed invoices ("2 invoice(s) changed since this page
  loaded (INV-1, INV-2) — nothing was posted. The page is being refreshed; check them and post
  again."; it says list, tray, cockpit or page). A target with no load-time version is never posted
  unversioned: the review refuses, and `postReviewedInvoice` / `postReviewedInvoiceGroup` now
  refuse a missing or malformed version before calling the database at all.
- **Other fixes in this round:** the order page's "Post all drafts" left out soft-deleted drafts (the
  order's invoice load keeps them, and one deleted draft made every run refuse); a database refusal
  of one target in a bulk run now says that invoice "changed since this screen loaded, so it was not
  posted" instead of "nothing was posted"; these refusals are an expected outcome, so they no longer
  go to Sentry as errors (`ExpectedActionRefusal` in `src/lib/criticalAction.ts`); the order page
  still reports "Already posted (N)" and sends its status-check errors to Sentry when the review
  refuses; the cockpit clears each invoice's idempotency key as soon as that invoice posts (a kept
  key could later replay the old receipt and report a post that never happened); a shown row loaded
  without its last-changed time is refused instead of compared less.
- **What is left (honest limits):** the load-time read runs right AFTER the rows query, so a change
  to a line, share or the customer's terms in that moment (well under a second) is in the version
  without being on screen; the invoice row itself is still compared at click. Reading versions at
  load costs one call per stand-alone draft or split group (six at a time) each time an admin loads
  one of these screens; a single "versions for many invoices" reader would need a new migration
  (deferred). A retry after a lost response whose reload also failed is refused as "changed" once
  (the admin's own post); the next reload clears it. Split-group members the screen never loaded
  (past the row cap, or another status) are posted as the group post always did, bound to their
  load-time state. The cockpit's Post all clean posts every clean draft it loaded, including the ones
  behind its "+N more" line, not only the six it lists; each is checked the same way.
- **Proof:** `src/lib/invoiceBulkPostReview.test.ts` (24 tests: load-time reads, members after
  versions, six at a time, the hook serving only its own load, no version read at click, every kind
  of header change, required last-changed time, group member added or removed, failed reads, the
  messages, the per-target wording, the post helpers refusing a missing version). Screen tests: a
  change the list does not show is refused by the database for that invoice only and the retry
  reuses its key; a version that could not be read at load posts nothing; a new split-group member
  stops the group post; a database refusal of a group in the Field Invoices tray names only that
  group while the other invoice posts; the soft-deleted order draft; the order page's refusal path;
  the cockpit key. The order and cockpit fixes were each shown to fail with the fix removed.

### Not done here (owners)

- Apply: Mason's explicit yes and Windows Hello approval, after PR #889's four migrations. Then,
  before merging this branch: regenerate the `pg_proc` snapshot in `rpcFixtureLiveDiff.test.ts` and
  `src/types/supabase.ts` from live (the renamed `_*_pre_admin_only_20261009` names may then need
  classifying in `rpcContracts.test.ts` / `rpcFixtureLiveDiff.test.ts`).
- Phase 2 verification in a signed-in browser (admin and sales rep) after the apply: no signed-in
  browser run was possible here.
- CI does not run the container prover or the chain; `src/lib/invoiceWriterGuard.test.ts` is the
  PR-time guard.
- At apply: re-pin `scripts/db-invariant-sweeps/allowlist.json` (`complete_job`'s contract digest
  changes; the new wrappers pass `p_performed_by` to their frozen bodies) from live digests.
- Tell Mason: reps read cost/margin on invoices (already on orders); applicators' job completions
  now notify every admin. (Design Q4b, the upkeep question, was decided 2026-10-10: see below.)
- InvoiceDetail still has no leave-page warning (unsaved edits are dropped silently on navigation;
  nothing posts wrongly). KNOWN_ISSUES keeps it open.
- Later upkeep change: `update_order_items`' draft line-link detach should lock the invoice first.
- Regenerate `.claude/schema-registry.json` after the apply.
