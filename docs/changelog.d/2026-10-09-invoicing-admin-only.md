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

### Not done here (owners)

- Apply: Mason's explicit yes and Windows Hello approval, after PR #889's four migrations.
- Phase 2 (screens) after PR #892: hide every mutating invoice control for non-admins, send the
  reviewed version when posting, the rep's customer-name gap on invoice lists, and the
  `src/types/supabase.ts` entries for `p_expected_version` and the two version readers (regenerate
  from live after the apply; the renamed `_*_pre_admin_only_20261009` names may then need
  classifying in `rpcContracts.test.ts` / `rpcFixtureLiveDiff.test.ts`).
- `package.json` proof script line (ask-listed file): `"proof:invoicing-admin-only": "node scripts/smoke/prove-invoicing-admin-only-real-schema.mjs"`.
- CI does not run the container prover or the chain; `src/lib/invoiceWriterGuard.test.ts` is the
  PR-time guard.
- At apply: re-pin `scripts/db-invariant-sweeps/allowlist.json` (`complete_job`'s contract digest
  changes; the new wrappers pass `p_performed_by` to their frozen bodies) from live digests.
- Tell Mason: reps read cost/margin on invoices (already on orders); applicators' job completions
  now notify every admin. (Design Q4b, the upkeep question, was decided 2026-10-10: see below.)
- Phase 2 also switches the invoice list, detail, field-invoice panels and the PDF's share names to
  `get_invoice_customer_names` for the farm name (one call per page with the ids it shows), adds it
  to `src/types/supabase.ts`, and keeps the PDF's address block on the direct `customers` read
  (assigned customers only for reps, by decision).
- Later upkeep change: `update_order_items`' draft line-link detach should lock the invoice first.
- Regenerate `.claude/schema-registry.json` after the apply.
