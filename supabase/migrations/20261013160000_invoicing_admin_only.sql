-- Written 2026-10-09. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: invoicing becomes ADMIN-ONLY. No sales rep, driver or other non-admin role can call any
-- invoicing RPC: create, edit, post, unpost, void or transfer an invoice, or apply a credit memo
-- or prepayment to one. Sales reps can now READ every invoice (read-only). Posting can bind to
-- the version an admin reviewed.
-- Active sales reps (and admins) can also read the CUSTOMER NAME (farm_name) of every customer an
-- invoice names, and nothing else about that customer, through get_invoice_customer_names (Mason
-- 2026-10-10, decision 2; see "Decision 2" below). The customers table policy is NOT widened.
-- WHAT IS NOT CHANGED: INVOICE UPKEEP (Mason-approved 2026-10-10, in chat, "1.a": keep
-- auto-updating, exactly as today). These are side effects of order and delivery work, not
-- invoicing RPCs: a sales rep's order pricing, line edits, rush orders and delivery cancels, and a
-- rep's or driver's partial delivery completion, keep updating an admin's DRAFT or UNPOSTED invoice
-- (drivers reach only the completion resize: the other paths role-gate to admin and sales_rep);
-- a POSTED invoice never changes; an admin still reviews and posts. The upkeep allowlist is exactly:
--   price_order, update_order_items, create_rush_order (re-price, re-date or detach the lines of an
--     admin's draft or unposted invoice on that order, and refresh its totals);
--   the delivery-completion partial resize and tote stamp inside _complete_delivery_authorized_impl
--     (a rep's or driver's partial completion resizes an admin's draft for that delivery; brief 1c,
--     addendum item 4);
--   cancel_delivery and batch_cancel_deliveries (a rep's cancel still cancels a draft or unposted
--     invoice of that delivery; Mason 2026-10-09, addendum item 5 and Q4a).
-- This settles the review round 3 Luna BLOCKER and rls-security HIGH about these paths: they are
-- owner-approved behaviour, not defects. Two separate defects on these paths stay OPEN in
-- KNOWN_ISSUES (not part of the decision): a cancel can reverse a COMPLETED delivery, and
-- update_order_items' line detach takes no invoice row lock.
--
-- WHY (Mason, 2026-10-09, in chat): "no reps should be able to invoice any customer"; rep scoping
-- is dropped (PR #891 closed, its 20261008120000 is never applied). His answers to the design
-- questions, which this file implements:
--   Q1 payments: reps still RECORD payments (allocate_payment unchanged); applying credit memos
--      and prepayments becomes admin-only.
--   Q2 reps SEE all invoices, read-only (a read-permission widening, recorded as his decision).
--   Q3 drivers too: admin-only for every non-admin role.
--   Q4/Q5 a rep's or driver's delivery or job completion makes no invoice; admins are notified
--      and the delivery waits in "Delivered, not invoiced".
--   Q4a cancelling a delivery that has an admin's invoice is NOT blocked: cancel_delivery is not
--      changed (reps keep today's behaviour, incl. the automatic cancel of the draft invoice).
--   Q6 the old rep/invoice open items close; rep scoping is formally dropped.
--   PR #892 split (Mason 2026-10-09): the server-side posting version check moves in here.
--
-- HOW (nothing in any data row changes; no invoice, payment or delivery row is rewritten):
--  1a public._require_invoicing_admin(): refuses unless auth.uid() is an ACTIVE admin
--     (EXISTS form: a NULL uid, a missing or an inactive profile all fail closed) with
--     INVOICING_ADMIN_ONLY (SQLSTATE 42501). Internal only (no EXECUTE for any API role).
--  1b Rename-and-wrap: each public invoicing RPC is renamed to
--     _<name>_pre_admin_only_20261009 (body, OID and owner travel with it; EXECUTE is then
--     closed to every role but postgres) and a wrapper with the SAME name, argument names,
--     types, defaults and result takes its place. The wrapper's first statement is the guard, so
--     a non-admin gets 42501 before any lock, idempotency claim, invoice number or write; then it
--     calls the frozen body with every argument by name. Admin behaviour, request shapes and
--     idempotency receipts are unchanged (the key passes through untouched).
--     Wrapped: save_invoice, save_field_app_invoice, save_field_app_split_invoice,
--     create_invoice_from_order, create_split_invoices_from_order, create_invoice_from_blend_ticket,
--     transfer_job_to_invoice, transfer_invoice_to_job, consolidate_draft_invoices,
--     update_field_app_applied_info, update_field_app_invoice_billing, post_invoice,
--     post_invoice_group, batch_post_invoices, unpost_invoice, unpost_invoice_group,
--     batch_void_invoices (tidy-up: reps already fail inside void_invoice), (Q1)
--     apply_credit_memo_to_invoice, reverse_credit_memo_application, apply_prepay_to_invoice,
--     batch_apply_all_prepayments, and reverse_write_off (review round 1: its own role test
--     `(SELECT role ...) != 'admin'` is NULL, not true, for a caller with no active profile, so a
--     deactivated admin was not refused; the wrapper's EXISTS guard refuses that caller first).
--     A service_role caller has no auth.uid(), so the guard refuses it too; no server-side caller
--     of these RPCs exists (pg_cron, triggers and supabase/functions checked 2026-10-09).
--     create_split_invoices_from_order also REQUIRES its idempotency key first (carried over from
--     closed PR #891): a NULL, empty or all-whitespace key is
--     IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order (22023) for every role. Its
--     callers always send one (read live 2026-10-09: _complete_delivery_authorized_impl passes
--     COALESCE(key, delivery id) || ':autosplit'; OrderDetail.tsx uses useIdempotencyKey).
--  1c Delivery completion (_complete_delivery_authorized_impl, verbatim live body plus one hunk):
--     the single-customer auto-invoice runs only when the completer is an admin. Anyone else
--     completes the delivery exactly as today (inventory, order status, remainders) with no
--     invoice and no invoice number; one activity row ('delivery_invoice_pending_admin') and one
--     notification per active admin ('delivery_needs_invoice') are written. A split (field
--     allocated) order already falls back to needs_split_billing + notify when the split wrapper
--     refuses, inside its own BEGIN/EXCEPTION. Upkeep of an admin's existing draft (the tote
--     stamp, the partial-delivery resize) keeps its effect. Nothing raises, so an offline replay
--     still ends 'applied'. A delivery with no order_id was never auto-invoiced (by anyone) and
--     still writes no pending-admin row; that is unchanged behaviour, not part of this file.
--     That upkeep vs an admin's versioned post (review round 2, checked in two sessions): the
--     resize writes invoice_items before it locks the invoices row, but posting an order's invoice
--     fires guard_mono_invoice_split_billing_post, which locks every order_items row of the order
--     FOR UPDATE, and the completion holds those rows (it updated them) until it commits. So the
--     two serialize, or, when the post already holds the invoice row and the completion is waiting
--     for it, Postgres aborts one of them as a deadlock (40P01) and nothing half-done commits; a
--     posted invoice is never re-sized. Locking the invoices in the completion as well was tried
--     and dropped: it adds the same deadlock to every FULL completion that meets a post. Only the
--     tote stamp can land on an invoice posted meanwhile (tote numbers; not money).
--  1d complete_job (verbatim live body plus one hunk): the automatic draft runs only for an
--     admin; anyone else writes the existing 'auto_draft_skipped' row, now saying invoicing is
--     admin-only (not 'auto_draft_failed'), and (Q4/Q5: admins are notified) one notification per
--     active admin ('job_needs_invoice').
--  1e create_quick_delivery is renamed and wrapped WITHOUT the guard: for a non-admin the wrapper
--     passes p_skip_invoice = true (coerce, do not refuse, so an old cached client that still
--     sends false keeps working); for an admin it passes p_skip_invoice through unchanged. The
--     frozen body creates no invoice and draws no number when p_skip_invoice is true. Its replay
--     fingerprint includes skip_invoice, so a non-admin retrying, after the apply, a request first
--     sent before it (same key, skip=false) gets IDEMPOTENCY_INTENT_MISMATCH instead of the stored
--     result; no rep or driver has ever made a quick delivery on live.
--  1h Table layer (defence in depth; every app write goes through the RPCs above): INSERT,
--     UPDATE, DELETE and TRUNCATE on invoice_shares, invoice_line_allocations, field_app_locations,
--     field_app_location_shares and write_offs are revoked from authenticated, anon and PUBLIC (no
--     app code writes them directly; every writer is a postgres-owned SECURITY DEFINER function,
--     read live 2026-10-09); TRUNCATE on invoice_line_shares, invoice_line_share_snapshots,
--     field_app_billing_sets and field_app_billing_lines from authenticated, anon and PUBLIC
--     (review round 4: anon and PUBLIC held no TRUNCATE there on live 2026-10-10; revoked and
--     asserted anyway, so a later grant cannot slip past the postflight); the INSERT policies
--     invoices_insert, invoice_items_insert, invoice_shares_insert and invoice_line_alloc_insert,
--     and the INSERT/UPDATE/DELETE policies of field_app_locations and field_app_location_shares,
--     become is_admin() only (they were is_admin() OR is_sales_rep()).
--  Addendum 2 Read side (Mason 2026-10-09, a read-permission WIDENING): the SELECT policies of
--     invoices, invoice_items, invoice_shares, invoice_line_shares, invoice_line_share_snapshots,
--     field_app_billing_sets and field_app_billing_lines add is_sales_rep() (the invoice list,
--     detail, field-invoice and PDF views read these; a split billing set or line only when a
--     non-deleted invoice uses it); write_offs gets a second read-only policy for sales reps. The
--     existing created_by / salesman_id legs stay, so drivers and every other role read exactly
--     what they read today; invoices_select and invoice_items_select now apply TO authenticated
--     (anon read no rows before and after). Every write policy stays admin-only. The rows include
--     cost and margin (invoices.total_cost_cents, invoice_items.cost_cents): reps already read the
--     same cost and margin on every order of every customer (order_items.cost_per_unit,
--     cost_at_time_cents and net_margin; orders.total_cost and total_margin_pct; policies
--     oitems_select / orders_select = is_admin() OR is_sales_rep(), read live 2026-10-10), so this
--     opens no new kind of data. NOT widened: the customers table (a rep still reads only the
--     customer rows assigned to them; see Decision 2 for the names-only read).
--  Decision 2 (Mason 2026-10-10, in chat, "2:yes": reps SEE CUSTOMER NAMES on invoices, names only,
--     not full customer records): public.get_invoice_customer_names(p_customer_ids uuid[]) returns
--     TABLE(id uuid, farm_name text) - the display name every invoice page shows - for the ids
--     asked for that a non-deleted invoice names (invoices.customer_id, invoice_shares.customer_id,
--     invoice_line_shares.customer_id, invoice_line_share_snapshots.customer_id), and only when the
--     caller is an active admin or an active sales rep; any other caller (driver, applicator,
--     entity_recipient, deactivated user, no profile) gets no rows. A SECURITY DEFINER read
--     function, not a view: the repo retired its SECURITY DEFINER view (profile_public_view became
--     security_invoker in 20260729125227) and a security_invoker view over customers would still
--     be filtered by customers_select. It is STABLE, writes nothing, takes no idempotency key (a
--     read), and is granted to authenticated only (anon and service_role cannot execute it). No
--     other customer column (address, phone, email, contact, account number, terms, credit) is
--     reachable through it; customers_select and the customers policy set are pinned before and
--     after. Phase 2 switches the invoice pages to it.
--  Addendum 8(a) Posting version check (moved in from PR #892): post_invoice, post_invoice_group
--     and batch_post_invoices take a trailing p_expected_version text DEFAULT NULL. It is the value
--     get_invoice_post_version(ids) / get_invoice_group_post_version(group) returned when the
--     admin reviewed: an md5 over every invoice that would post (header row, lines, line shares
--     and customer shares; for a group, every non-deleted member, so a new member also counts).
--     When it is supplied, the wrapper first requires the idempotency key (post_invoice and
--     batch_post_invoices: IDEMPOTENCY_KEY_REQUIRED, 22023, the same refusal their frozen bodies
--     raise, so a version is never silently ignored), takes the key's advisory locks the
--     implementation takes (post_invoice: 'crx:idempotency:'||key, the lock check_idempotency
--     holds to the end of the transaction, so a duplicate same-key call waits and then replays;
--     the group and batch wrappers: their implementation's key locks), then, only when the call
--     will really post (no stored receipt under that key), the group lock and the invoice rows
--     ordered by id, and refuses with INVOICE_CHANGED_SINCE_REVIEW if anything differs. NULL keeps
--     the old behaviour, so old callers keep working. The old two/three-argument functions are
--     renamed away, so exactly one public overload of each name exists and PostgREST cannot see
--     two callable signatures. The fingerprint is the invoice header plus its lines and shares
--     (the addendum's "header plus lines") plus the invoice customer's payment_terms (review round
--     4, Luna MED: when the invoice has no terms of its own, the post sets the due date from the
--     customer's terms, and the assigned sales rep can still edit that customer row under
--     customers_update, read live 2026-10-10; a terms change after review now refuses the post).
--     It hashes every invoices column, so any change to the invoice row (updated_at included)
--     refuses a post until the admin reloads. Not covered: a field invoice's field_app_locations
--     acres (every writer is admin-only after this file). The customers row is read, not locked:
--     a terms edit that commits between the wrapper's check and the post's own terms read (the
--     same transaction, milliseconds apart) can still move the due date; the amount never moves.
--
-- CALLERS (MANDATORY comment-stripped pg_proc scan, read live 2026-10-09, every schema): the only
-- SQL callers of the renamed names are
--   _batch_apply_prepayments_impl -> apply_prepay_to_invoice (behind admin-only batch_apply_prepayments)
--   _create_split_invoices_from_order_provenance_impl_20260719 -> create_invoice_from_order (runs after the admin-only split wrapper)
--   _complete_delivery_authorized_impl -> create_split_invoices_from_order (inside BEGIN/EXCEPTION: a refusal is the needs_split_billing fallback)
--   batch_post_invoices -> post_invoice (the frozen batch body now reaches the post_invoice wrapper; admin context)
--   unpost_invoice_group -> unpost_invoice (same, admin context)
--   complete_job -> transfer_job_to_invoice (re-emitted in 1d: only an admin reaches it)
-- No pg_cron job, edge function or trigger calls any of them (cron.job read live; supabase/functions grepped).
-- actor-binding-check: exempt - complete_job is the verbatim live body plus the admin-only hunk; it
-- binds p_performed_by to auth.uid() before any write (RAISE 'p_performed_by does not match
-- authenticated user'). _complete_delivery_authorized_impl is internal (EXECUTE for postgres only)
-- behind complete_delivery, which refuses ACTOR_MISMATCH first. Every wrapper passes its actor
-- argument to its frozen implementation, which keeps its own strict actor refusal.
-- Every REVOKE below on a renamed function closes the FROZEN implementation; a wrapper with the
-- same public name, arguments, defaults, result and EXECUTE grants (authenticated, service_role)
-- takes its place, so every UI callsite keeps calling the same name and reaches the wrapper (which
-- refuses non-admins: Mason's decision 2026-10-09).
-- caller-analysis: save_invoice :: renamed; same-name wrapper keeps the grants; InvoiceDetail callsite reaches the wrapper
-- caller-analysis: save_field_app_invoice :: renamed; same-name wrapper keeps the grants; FieldApplicationInvoice callsite reaches the wrapper
-- caller-analysis: save_field_app_split_invoice :: renamed; same-name wrapper keeps the grants; FieldAppSplitInvoiceEditor callsite reaches the wrapper
-- caller-analysis: create_invoice_from_order :: renamed; same-name wrapper keeps the grants; OrderDetail callsite reaches the wrapper
-- caller-analysis: create_split_invoices_from_order :: renamed; same-name wrapper keeps the grants; OrderDetail callsite (always sends a key) reaches the wrapper
-- caller-analysis: create_invoice_from_blend_ticket :: renamed; same-name wrapper keeps the grants; BlendTicketDetail callsite reaches the wrapper
-- caller-analysis: transfer_job_to_invoice :: renamed; same-name wrapper keeps the grants; UnbilledApplicationsPanel and JobDetail callsites reach the wrapper
-- caller-analysis: transfer_invoice_to_job :: renamed; same-name wrapper keeps the grants; FieldApplicationInvoice and InvoiceDetail callsites reach the wrapper
-- caller-analysis: consolidate_draft_invoices :: renamed; same-name wrapper keeps the grants; OrderDetail callsite reaches the wrapper
-- caller-analysis: update_field_app_applied_info :: renamed; same-name wrapper keeps the grants; FieldApplicationInvoice callsite reaches the wrapper
-- caller-analysis: update_field_app_invoice_billing :: renamed; same-name wrapper keeps the grants; FieldApplicationInvoice callsite reaches the wrapper
-- caller-analysis: post_invoice :: renamed; same-name wrapper (extra trailing p_expected_version DEFAULT NULL) keeps the grants; every existing callsite reaches it unchanged
-- caller-analysis: post_invoice_group :: renamed; same-name wrapper (extra trailing p_expected_version DEFAULT NULL) keeps the grants; every existing callsite reaches it unchanged
-- caller-analysis: batch_post_invoices :: renamed; same-name wrapper (extra trailing p_expected_version DEFAULT NULL) keeps the grants; every existing callsite reaches it unchanged
-- caller-analysis: unpost_invoice :: renamed; same-name wrapper keeps the grants; FieldInvoicesPostedPanel, FieldApplicationInvoice and InvoiceDetail callsites reach the wrapper
-- caller-analysis: unpost_invoice_group :: renamed; same-name wrapper keeps the grants; FieldApplicationInvoice and InvoiceDetail callsites reach the wrapper
-- caller-analysis: batch_void_invoices :: renamed; same-name wrapper keeps the grants; Invoices callsite reaches the wrapper
-- caller-analysis: apply_credit_memo_to_invoice :: renamed; same-name wrapper keeps the grants; InvoiceDetail callsite reaches the wrapper
-- caller-analysis: reverse_credit_memo_application :: renamed; same-name wrapper keeps the grants; no UI callsite found (src grepped 2026-10-09)
-- caller-analysis: apply_prepay_to_invoice :: renamed; same-name wrapper keeps the grants; its SQL caller _batch_apply_prepayments_impl runs as postgres
-- caller-analysis: batch_apply_all_prepayments :: renamed; same-name wrapper keeps the grants; PrepaymentManagerPanel callsite reaches the wrapper
-- caller-analysis: reverse_write_off :: renamed; same-name wrapper keeps the grants; InvoiceDetail callsite reaches the wrapper
-- caller-analysis: create_quick_delivery :: renamed; same-name wrapper (no guard, coerces p_skip_invoice for non-admins) keeps the grants; QuickDeliveryModal callsite reaches it
-- caller-analysis: _require_invoicing_admin :: new internal helper, never granted to an API role; only the wrappers (postgres-owned) call it
-- caller-analysis: _invoice_review_fingerprint :: new internal helper, never granted to an API role; only postgres-owned functions call it
-- caller-analysis: get_invoice_customer_names :: new read-only RPC (Decision 2, Mason 2026-10-10), granted to authenticated only; no callsite yet (phase 2 switches the invoice pages to it)
--
-- NOT CHANGED (the upkeep allowlist, Mason-approved 2026-10-10 "1.a"; see WHAT IS NOT CHANGED
-- above): cancel_delivery / batch_cancel_deliveries (reps may cancel deliveries with an invoice;
-- their draft AND unposted invoices of that delivery are cancelled as today; the "cancel reverses
-- a COMPLETED delivery" bug stays OPEN in KNOWN_ISSUES); price_order, update_order_items and
-- create_rush_order (order upkeep: they re-price, re-date or detach lines of an admin's draft or
-- unposted invoice on the order, under its row lock, so a versioned post refuses after them;
-- update_order_items' line detach takes no invoice lock: a separate defect, OPEN in KNOWN_ISSUES);
-- the delivery-completion resize and tote stamp (section 1c); allocate_payment (Q1); the
-- already-admin-only invoice, credit, write-off, payment and order functions (pinned below).
-- The postflight HARD-GUARD sweep refuses the apply if any function or procedure authenticated can
-- run can reach (by name) a write (INSERT, UPDATE, DELETE, MERGE or TRUNCATE, with or without ONLY
-- or quotes) to an invoice table (invoices, invoice_items, invoice_shares, invoice_line_shares,
-- invoice_line_share_snapshots, invoice_line_allocations, field_app_locations,
-- field_app_location_shares, field_app_billing_sets, field_app_billing_lines, write_offs), or an
-- EXECUTE in a body that names one, without calling the guard first and is not on one of those
-- pinned lists. "First" means no statement and no DECLARE initializer runs before it, and the
-- body has no exception handler that could catch the guard's refusal. A second check refuses a
-- trigger that writes an invoice table from a table authenticated can write. It is a catalog
-- regex, not a parser: other schemas, calls through a quoted or schema-dotted name the regex does
-- not match, string literals that contain comment markers, and tables outside that list (for
-- example credit_memo_applications, prepay_applications, the split_invoice_* claim tables) are
-- outside it. src/lib/invoiceWriterGuard.test.ts applies the same rule (literal-aware, overload-
-- aware, and pinning re-emissions of the completion chain and the guard helper) to every migration
-- from this one on, on every PR.
--
-- idempotency-body-check: exempt - every wrapper passes p_idempotency_key unchanged to the frozen
-- implementation, which keeps its existing claim/check before any write and its receipt after
-- it; the guard and the version check run before both. The two new get_*_post_version functions
-- only read.
--
-- ORDERING: strict. Apply ONLY after PR #889's four migrations (20261007150000, 20261007150050,
-- 20261007150100, 20261007150200) are applied live: the preflight refuses until all four are in
-- the ledger by name (PREFLIGHT_PR889_NOT_APPLIED). This file shares no function with #889.
-- APPLY GATE: this changes who can do what (permissions), so it is an AGENTS.md hard gate: it needs
-- Mason's explicit yes in the current conversation and his owner-approval chat reply for this exact
-- file (it replaced Windows Hello on 2026-10-09). It is NOT a routine-grant auto-apply.
-- ROLLBACK: a new migration drops each wrapper, renames each frozen implementation back and
-- re-grants it to authenticated and service_role, re-emits the two pinned pre-change bodies
-- (f8de9f000e40f7bfd8f792012f04fee0, 4e4c38e3e8be66e2d24c434bb54c0521), drops the four helpers
-- and get_invoice_customer_names (Decision 2; the pages then fall back to their direct customers
-- embeds, which show a rep only assigned customers' names), and restores the policy texts and grants pinned in the preflight. No data is involved.

SET LOCAL lock_timeout = '5s';
-- The policy pins below hash the server's deparsed policy text, which prints is_admin()
-- unqualified only while public is on the search_path: pin the apply session to live's default
-- (read 2026-10-10) so the pins do not depend on how the apply tool connects.
SET LOCAL search_path = "$user", public, extensions;

CREATE TEMP TABLE crx_invoicing_admin_only_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

-- =============================================================================================
-- PREFLIGHT: refuse on any drift from what this file was reviewed against.
-- =============================================================================================
DO $preflight$
DECLARE
  r record;
  v_oid oid;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF to_regclass('pg_temp.crx_invoicing_admin_only_tx') IS NULL THEN
    RAISE EXCEPTION 'CRX_INVOICING_ADMIN_ONLY_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.crx_invoicing_admin_only_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'CRX_INVOICING_ADMIN_ONLY_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- ORDERING: PR #889's four migrations must be in the ledger first (by name, as
  -- scripts/apply-migration-file.mjs records them).
  IF (SELECT count(DISTINCT name) FROM supabase_migrations.schema_migrations
       WHERE name IN ('20261007150000_record_deliveries_billed_outside_crx',
                      '20261007150050_lock_soft_deleted_orders',
                      '20261007150100_mark_spring_2026_deliveries_billed_in_chem_man',
                      '20261007150200_release_reservations_of_deleted_spring_orders')) <> 4 THEN
    RAISE EXCEPTION 'PREFLIGHT_PR889_NOT_APPLIED: apply PR #889''s four migrations (20261007150000..20261007150200) before this file';
  END IF;

  -- Nothing this file creates may exist yet.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname IN ('_require_invoicing_admin', '_invoice_review_fingerprint',
                          'get_invoice_post_version', 'get_invoice_group_post_version',
                          'get_invoice_customer_names')
            OR p.proname LIKE '%_pre_admin_only_20261009')
  ) OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'write_offs_select_sales_rep') THEN
    RAISE EXCEPTION 'PREFLIGHT_ALREADY_APPLIED: an object this file creates already exists';
  END IF;

  -- The RPCs renamed and wrapped below: exactly one overload, the reviewed body, signature,
  -- result, security mode, search_path, owner and ACL.
  FOR r IN SELECT * FROM (VALUES
    ('save_invoice', 'jsonb,jsonb,text', 'p_invoice jsonb, p_items jsonb DEFAULT ''[]''::jsonb, p_idempotency_key text DEFAULT NULL::text', 'uuid', 'cb932dc51a680442affde5aeba2eaee3'),
    ('save_field_app_invoice', 'uuid,jsonb,jsonb,jsonb,uuid,uuid,text', 'p_invoice_id uuid, p_invoice jsonb, p_locations jsonb, p_chemicals jsonb, p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '8700762576625bd06a833845d57ddbb6'),
    ('save_field_app_split_invoice', 'uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text', 'p_billing_set_id uuid, p_source_job_id uuid, p_invoice jsonb, p_fields jsonb, p_lines jsonb, p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '82003fe2895aa1d7c7810559f4fb771a'),
    ('create_invoice_from_order', 'uuid,uuid,text,text', 'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text', 'uuid', 'a1a91643bd8866823ae359f7e0ec290e'),
    ('create_split_invoices_from_order', 'uuid,uuid,text,text', 'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text', 'uuid[]', '398030fbb64006b4750e7e89a61b6cb9'),
    ('create_invoice_from_blend_ticket', 'uuid,uuid,text', 'p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'c520a7301f88f3e96ed7bbc33101c4ef'),
    ('transfer_job_to_invoice', 'uuid,uuid,text', 'p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'b083dd371b091d7b70bb4cdc015c9bc8'),
    ('transfer_invoice_to_job', 'uuid,uuid,text', 'p_invoice_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '7394bd0343c19e98bf746576a56bf6e4'),
    ('consolidate_draft_invoices', 'uuid,uuid,text', 'p_order_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '0c8394691ef461ba780fd4ba0e770c51'),
    ('update_field_app_applied_info', 'uuid[],text,text,text,uuid,text,numeric,numeric,text,numeric,time without time zone,text,numeric,numeric,text,numeric,time without time zone,text,boolean,boolean,numeric,boolean', 'p_invoice_ids uuid[], p_wind_direction text DEFAULT NULL::text, p_temperature_text text DEFAULT NULL::text, p_applicator_name text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_start_temp_f numeric DEFAULT NULL::numeric, p_start_wind_mph numeric DEFAULT NULL::numeric, p_start_wind_direction text DEFAULT NULL::text, p_start_humidity_pct numeric DEFAULT NULL::numeric, p_start_weather_time time without time zone DEFAULT NULL::time without time zone, p_start_weather_source text DEFAULT NULL::text, p_end_temp_f numeric DEFAULT NULL::numeric, p_end_wind_mph numeric DEFAULT NULL::numeric, p_end_wind_direction text DEFAULT NULL::text, p_end_humidity_pct numeric DEFAULT NULL::numeric, p_end_weather_time time without time zone DEFAULT NULL::time without time zone, p_end_weather_source text DEFAULT NULL::text, p_weather_manual_override boolean DEFAULT NULL::boolean, p_update_weather boolean DEFAULT false, p_diluent_rate_gpa numeric DEFAULT NULL::numeric, p_update_diluent boolean DEFAULT false', 'jsonb', 'e6d5f41411e96cd4453d2209c846645d'),
    ('update_field_app_invoice_billing', 'uuid[],text,text,text,date,text,text,jsonb,uuid,text', 'p_invoice_ids uuid[], p_purchase_order_ref text DEFAULT NULL::text, p_payment_terms text DEFAULT NULL::text, p_header_notes text DEFAULT NULL::text, p_due_date date DEFAULT NULL::date, p_footer_notes text DEFAULT NULL::text, p_internal_notes text DEFAULT NULL::text, p_discounts jsonb DEFAULT ''{}''::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '34695e4be9724bf46dc5e962f8f0e478'),
    ('post_invoice', 'uuid,text', 'p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text', 'void', '6a5e3ab75bc63936f23eab85383ff6ad'),
    ('post_invoice_group', 'uuid,uuid,text', 'p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'd9e36f0dfb055e3cc68c18793e70dbfc'),
    ('batch_post_invoices', 'uuid[],text', 'p_invoice_ids uuid[], p_idempotency_key text DEFAULT NULL::text', 'jsonb', '482bd8cd15728ffc51f83900eaf89b3c'),
    ('unpost_invoice', 'uuid,uuid,text', 'p_invoice_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '161f18c3ccd6126a6fb683c5160f82dc'),
    ('unpost_invoice_group', 'uuid,uuid,text', 'p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'dc476e07621c4c7dc86595442ed1a9f0'),
    ('batch_void_invoices', 'uuid[],text,uuid,text', 'p_invoice_ids uuid[], p_void_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'integer', '32fa9718f29e18c8eff4539e36ac84b3'),
    ('apply_credit_memo_to_invoice', 'uuid,uuid,bigint,uuid,text', 'p_credit_memo_id uuid, p_target_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'uuid', 'bcc242c8715aaed81b9455fbc905237f'),
    ('reverse_credit_memo_application', 'uuid,text,uuid,text', 'p_application_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '38cea043fc7dae4e65bc8593c95bddfb'),
    ('apply_prepay_to_invoice', 'uuid,uuid,bigint,uuid,text', 'p_prepay_credit_id uuid, p_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'uuid', 'c9377dab8f2534a03af2c27a6e1d510c'),
    ('batch_apply_all_prepayments', 'uuid,text', 'p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '1d76228210c474da37c9a3cd91b97b7d'),
    ('reverse_write_off', 'uuid,text,uuid,text', 'p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '70ef11ccad193eb6ef5ee88dcba6f8cd'),
    ('create_quick_delivery', 'uuid,jsonb,uuid,date,text,uuid,text,boolean', 'p_customer_id uuid, p_items jsonb, p_driver_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE, p_delivery_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_skip_invoice boolean DEFAULT false', 'jsonb', '69c1d569fb2e9eb913502d59e41a76fe')
  ) AS t(name, ident, args, ret, md5) LOOP
    v_oid := to_regprocedure('public.' || r.name || '(' || r.ident || ')');
    IF v_oid IS NULL
       OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = r.name) <> 1
       OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
             AND NOT p.proisstrict AND NOT p.proretset AND p.prokind = 'f'
             AND format_type(p.prorettype, NULL) = r.ret
             AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
             AND pg_get_function_arguments(p.oid) = r.args
             AND md5(replace(p.prosrc, chr(13), '')) = r.md5
             AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                         FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
                 IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
             AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'PREFLIGHT_RPC_DRIFT: public.%(%) is not the reviewed contract', r.name, r.ident;
    END IF;
  END LOOP;

  -- The two bodies re-emitted below (sections 1c and 1d).
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) = 'f8de9f000e40f7bfd8f792012f04fee0'
         AND p.prosecdef AND p.proowner = 'postgres'::regrole
         AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_function_arguments(p.oid) = 'p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone'
         AND p.proacl::text = '{postgres=X/postgres}'
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
     IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_COMPLETE_DELIVERY_DRIFT: _complete_delivery_authorized_impl is not the reviewed body';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) = '4e4c38e3e8be66e2d24c434bb54c0521'
         AND p.prosecdef AND p.proowner = 'postgres'::regrole
         AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
         AND pg_get_function_arguments(p.oid) = 'p_job_id uuid, p_applied_info jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text'
         AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                     FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
             IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.complete_job(uuid,jsonb,uuid,text)'))
     IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_COMPLETE_JOB_DRIFT: complete_job is not the reviewed body';
  END IF;

  -- Helpers the new code relies on: role helpers (policies, guard, coercion), the idempotency
  -- helpers whose advisory locks the posting version check takes first (so it takes them in the
  -- implementation's order), the posting implementations that define that order, the quick
  -- delivery implementation whose p_skip_invoice = true creates no invoice, and the completion
  -- chain layers outside the re-emitted impl.
  FOR r IN SELECT * FROM (VALUES
    ('public.is_admin()', 'f76bf61116c3bd52bd9c6ea125079b73'),
    ('public.is_sales_rep()', 'fcb3133010fe3f4f56e3be31f709d102'),
    ('public.check_idempotency(text,text)', 'cb810b6f78d587b8e0f2869f87ded757'),
    ('public._claim_bound_lifecycle_idempotency(text,text,text,text,jsonb)', '0d6fe6c0c9ea71f11ce8cc233665eba2'),
    ('public._post_invoice_idem_impl_20260721(uuid,text)', '11626fd7f9d15ad9d507a6979068d5d7'),
    ('public._post_invoice_public_impl_20260718(uuid,text)', '39b9f427eb843e6cba859a1db62553a8'),
    ('public._create_quick_delivery_intent_impl_20260802(uuid,jsonb,uuid,date,text,uuid,text,boolean)', 'f5cc01e983fd1c8aa1e8a7895777a7ab'),
    ('public._complete_delivery_aggregate_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)', 'b888901587accbee7f7fe4aeb512e683'),
    ('public._complete_delivery_period_preflight_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)', 'a9f80dc25207eba595e9998409e9ceb9')
  ) AS t(sig, md5) LOOP
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) = r.md5 AND p.prosecdef
               AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'PREFLIGHT_HELPER_DRIFT: % is not the reviewed body', r.sig;
    END IF;
  END LOOP;

  -- The already-admin-only and upkeep functions the postflight sweep classifies.
  FOR r IN SELECT * FROM (VALUES
    ('public.void_invoice(uuid,text,text)', '2b1be1b706614f9a909581b0493d679f'),
    ('public.void_invoice_group(uuid,text,text)', 'fa19808b6ab6b0663663cd28c89a3326'),
    ('public.delete_invoices(uuid[],uuid,text)', '24c271164caa2369c57c3bdc5d88c50a'),
    ('public.create_invoice_for_unbilled_delivery(uuid,uuid,text)', 'a7f2531bd09ea6c650063f9661871caa'),
    ('public.generate_finance_charges(date,uuid,uuid[],text)', '56a397500167abf1b2801d22a31075dd'),
    ('public.issue_return_credit(uuid,uuid,text)', 'f3fcab7980d1640501fc038b0c8ac902'),
    ('public.unapply_credit_memo(uuid,text,uuid,text)', 'ba69e04e86dec86723d3ac9487f51272'),
    ('public.apply_write_off(uuid,bigint,text,uuid,text)', '00e8d020f9faf6276de8ddaf4f1411fc'),
    ('public.void_payment(uuid,text,uuid,text)', '70fd746c15f4a6629680a724f3588967'),
    ('public.apply_remaining_prepayments(uuid,uuid,text)', 'c0d7a2aef843ace0f557af2d096b090e'),
    ('public.batch_apply_prepayments(jsonb,uuid,text)', '15624992c9375e08a0ec1914437e6e40'),
    ('public.void_order(uuid,uuid,text,text)', 'bb220157f3cd56d28e9efe88dafba896'),
    ('public.cancel_order(uuid,uuid,text)', '501473a43b505df72bc803a7354b0e60'),
    ('public.void_delivery(uuid,text,uuid,text)', '3ef685c8f5bf778e3ae38aa2f89304da'),
    ('public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)', 'a1e9a043f27d3566f8ecf6d5e3a809ab'),
    ('public.process_offline_action(uuid,text)', '0461eebf65f23ccc8fe3852375eb9c78'),
    -- The upkeep allowlist: Mason-approved 2026-10-10 ("1.a": a rep's or driver's order and
    -- delivery work keeps updating an admin's draft or unposted invoice, exactly as today).
    ('public.cancel_delivery(uuid,text,uuid,text)', '8528b344f86c7e1aa735e386ea39f2eb'),
    ('public.batch_cancel_deliveries(uuid[],text,uuid,text)', '25d34db60f098a22a62db53780742eee'),
    ('public.price_order(uuid,jsonb,uuid,text)', 'ab2bcf3ac499cf78eef1f706d4e9501f'),
    ('public.update_order_items(uuid,jsonb,uuid,text)', 'e35fce6708edee32fb1876fa60d7da4b'),
    ('public.create_rush_order(uuid,jsonb,text,text,uuid,text)', '9027a97ab42a109f5e81188736f52f9c'),
    ('public.allocate_payment(uuid,bigint,text,text,text,date,text,jsonb,uuid,text)', '6a945a2510d8e788d4e6f03c0c6d7563')
  ) AS t(sig, md5) LOOP
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) = r.md5 FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig))
       IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'PREFLIGHT_SWEEP_LIST_DRIFT: % changed since it was classified', r.sig;
    END IF;
  END LOOP;

  -- The policies this file replaces, and the full policy set on each table it touches.
  FOR r IN SELECT * FROM (VALUES
    ('invoices', 'invoices_select', 'ec85564020388a3efb3c4d8968906ad9'),
    ('invoice_items', 'invoice_items_select', 'c02df80cb38993d78d0de20f945cbe7a'),
    ('invoice_shares', 'invoice_shares_select', '0da587e780c552489a31bc1765b73e78'),
    ('invoice_line_shares', 'invoice_line_shares_select', '0b9cdd77443ad18ca53f1bef97ff764e'),
    ('invoice_line_share_snapshots', 'invoice_line_share_snapshots_select', '0162464aed38a378de79388897cd4eb2'),
    ('field_app_billing_sets', 'field_app_billing_sets_select', '1e8067c5a457410dff18572e9a170f03'),
    ('field_app_billing_lines', 'field_app_billing_lines_select', '54a70c764e751fcacb6fe38d8713ba74'),
    ('invoices', 'invoices_insert', '52722e61e9bef7b2ff1a9a2f33cef7be'),
    ('invoice_items', 'invoice_items_insert', '52722e61e9bef7b2ff1a9a2f33cef7be'),
    ('invoice_shares', 'invoice_shares_insert', 'e5ca188a3e2901d57253b2c007f5a3bf'),
    ('invoice_line_allocations', 'invoice_line_alloc_insert', '52722e61e9bef7b2ff1a9a2f33cef7be'),
    ('write_offs', 'write_offs_select_admin', '3a62ac9ae6afb0b8195d72a0b07a24da'),
    ('field_app_locations', 'field_app_locations_insert', '52722e61e9bef7b2ff1a9a2f33cef7be'),
    ('field_app_locations', 'field_app_locations_update', '7680ae67028c233ada58f74c302d87bd'),
    ('field_app_locations', 'field_app_locations_delete', '0b3f94a02ac505d82e218752005f2c32'),
    ('field_app_location_shares', 'field_app_location_shares_insert', '52722e61e9bef7b2ff1a9a2f33cef7be'),
    ('field_app_location_shares', 'field_app_location_shares_update', '7680ae67028c233ada58f74c302d87bd'),
    ('field_app_location_shares', 'field_app_location_shares_delete', '0b3f94a02ac505d82e218752005f2c32'),
    -- Decision 2 (Mason 2026-10-10): the customers read policies this file must NOT widen (read
    -- live 2026-10-10); the postflight re-checks the same pins and the same policy set.
    ('customers', 'customers_select', '4d86cb39838dc338ac722922bbb91b5f'),
    ('customers', 'customers_select_location_dispatchee', 'a4b57f89a3b63679c902d9bcf25ef25c')
  ) AS t(tbl, pol, pin) LOOP
    IF (SELECT md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''))
          FROM pg_policies WHERE schemaname = 'public' AND tablename = r.tbl AND policyname = r.pol)
       IS DISTINCT FROM r.pin THEN
      RAISE EXCEPTION 'PREFLIGHT_POLICY_DRIFT: %.% is not the reviewed policy', r.tbl, r.pol;
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM (VALUES
    ('invoices', ARRAY['invoices_delete', 'invoices_insert', 'invoices_select', 'invoices_update']::text[]),
    ('invoice_items', ARRAY['invoice_items_delete', 'invoice_items_insert', 'invoice_items_select', 'invoice_items_update']::text[]),
    ('invoice_shares', ARRAY['invoice_shares_delete', 'invoice_shares_insert', 'invoice_shares_select', 'invoice_shares_update']::text[]),
    ('invoice_line_shares', ARRAY['invoice_line_shares_select']::text[]),
    ('invoice_line_share_snapshots', ARRAY['invoice_line_share_snapshots_select']::text[]),
    ('invoice_line_allocations', ARRAY['invoice_line_alloc_insert', 'invoice_line_alloc_select']::text[]),
    ('field_app_billing_sets', ARRAY['field_app_billing_sets_select']::text[]),
    ('field_app_billing_lines', ARRAY['field_app_billing_lines_select']::text[]),
    ('write_offs', ARRAY['write_offs_insert_admin', 'write_offs_select_admin']::text[]),
    ('field_app_locations', ARRAY['field_app_locations_delete', 'field_app_locations_insert', 'field_app_locations_select', 'field_app_locations_update']::text[]),
    ('field_app_location_shares', ARRAY['field_app_location_shares_delete', 'field_app_location_shares_insert', 'field_app_location_shares_select', 'field_app_location_shares_update']::text[]),
    ('customers', ARRAY['customers_delete', 'customers_insert', 'customers_select', 'customers_select_location_dispatchee', 'customers_update']::text[])
  ) AS t(tbl, pols) LOOP
    IF ARRAY(SELECT policyname::text FROM pg_policies WHERE schemaname = 'public' AND tablename = r.tbl ORDER BY 1)
       IS DISTINCT FROM r.pols THEN
      RAISE EXCEPTION 'PREFLIGHT_POLICY_SET_DRIFT: % has policies other than the reviewed set', r.tbl;
    END IF;
  END LOOP;
END
$preflight$;

-- =============================================================================================
-- 1a. The guard every invoicing RPC calls first, and the posting version helpers.
-- =============================================================================================
CREATE FUNCTION public._require_invoicing_admin()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = auth.uid()
       AND role = 'admin'
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'INVOICING_ADMIN_ONLY: only an admin can create, edit, post, unpost, void or transfer invoices, or apply credits and prepayments to them'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public._require_invoicing_admin() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public._invoice_review_fingerprint(p_invoice_ids uuid[])
 RETURNS text
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
 SET "TimeZone" = 'UTC'
AS $function$
  SELECT md5(COALESCE(string_agg(
           to_jsonb(i)::text
           || '|' || COALESCE((SELECT jsonb_agg(to_jsonb(ii) ORDER BY ii.id)::text
                                 FROM public.invoice_items ii
                                WHERE ii.invoice_id = i.id), '[]')
           || '|' || COALESCE((SELECT jsonb_agg(to_jsonb(ls) ORDER BY ls.id)::text
                                 FROM public.invoice_line_shares ls
                                 JOIN public.invoice_items lii ON lii.id = ls.invoice_item_id
                                WHERE lii.invoice_id = i.id), '[]')
           || '|' || COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id)::text
                                 FROM public.invoice_shares s
                                WHERE s.invoice_id = i.id), '[]')
           || '|' || COALESCE(to_jsonb((SELECT c.payment_terms
                                          FROM public.customers c
                                         WHERE c.id = i.customer_id))::text, 'null'),
           chr(10) ORDER BY i.id), ''))
    FROM public.invoices i
   WHERE i.id = ANY (COALESCE(p_invoice_ids, '{}'::uuid[]));
$function$;
REVOKE ALL ON FUNCTION public._invoice_review_fingerprint(uuid[]) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_invoice_post_version(p_invoice_ids uuid[])
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._invoice_review_fingerprint(p_invoice_ids);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_invoice_post_version(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoice_post_version(uuid[]) TO authenticated, service_role;

CREATE FUNCTION public.get_invoice_group_post_version(p_invoice_group_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._invoice_review_fingerprint(ARRAY(
    SELECT i.id
      FROM public.invoices i
     WHERE i.invoice_group_id = p_invoice_group_id
       AND i.deleted_at IS NULL
  ));
END;
$function$;

REVOKE ALL ON FUNCTION public.get_invoice_group_post_version(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_invoice_group_post_version(uuid) TO authenticated, service_role;

-- =============================================================================================
-- 1b / 1e / 1i / addendum 8(a). Rename each public RPC to its frozen implementation (the body,
-- OID, owner and ACL travel with the rename; the ACL is then closed), and put a wrapper with the
-- same name, arguments, defaults and result in its place. Internal callers that call these by
-- name now reach the wrappers (wanted: see the header).
-- =============================================================================================

ALTER FUNCTION public.save_invoice(jsonb,jsonb,text) RENAME TO _save_invoice_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._save_invoice_pre_admin_only_20261009(jsonb,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_invoice(p_invoice jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._save_invoice_pre_admin_only_20261009(
    p_invoice => p_invoice,
    p_items => p_items,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.save_invoice(jsonb,jsonb,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_invoice(jsonb,jsonb,text) TO authenticated, service_role;

ALTER FUNCTION public.save_field_app_invoice(uuid,jsonb,jsonb,jsonb,uuid,uuid,text) RENAME TO _save_field_app_invoice_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._save_field_app_invoice_pre_admin_only_20261009(uuid,jsonb,jsonb,jsonb,uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_field_app_invoice(p_invoice_id uuid, p_invoice jsonb, p_locations jsonb, p_chemicals jsonb, p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._save_field_app_invoice_pre_admin_only_20261009(
    p_invoice_id => p_invoice_id,
    p_invoice => p_invoice,
    p_locations => p_locations,
    p_chemicals => p_chemicals,
    p_performed_by => p_performed_by,
    p_application_service_id => p_application_service_id,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.save_field_app_invoice(uuid,jsonb,jsonb,jsonb,uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_field_app_invoice(uuid,jsonb,jsonb,jsonb,uuid,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.save_field_app_split_invoice(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text) RENAME TO _save_field_app_split_invoice_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._save_field_app_split_invoice_pre_admin_only_20261009(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_field_app_split_invoice(p_billing_set_id uuid, p_source_job_id uuid, p_invoice jsonb, p_fields jsonb, p_lines jsonb, p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._save_field_app_split_invoice_pre_admin_only_20261009(
    p_billing_set_id => p_billing_set_id,
    p_source_job_id => p_source_job_id,
    p_invoice => p_invoice,
    p_fields => p_fields,
    p_lines => p_lines,
    p_performed_by => p_performed_by,
    p_application_service_id => p_application_service_id,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.save_field_app_split_invoice(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_field_app_split_invoice(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.create_invoice_from_order(uuid,uuid,text,text) RENAME TO _create_invoice_from_order_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._create_invoice_from_order_pre_admin_only_20261009(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.create_invoice_from_order(p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT 'chemical_sale'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._create_invoice_from_order_pre_admin_only_20261009(
    p_order_id => p_order_id,
    p_salesman_id => p_salesman_id,
    p_invoice_type => p_invoice_type,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.create_invoice_from_order(uuid,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_from_order(uuid,uuid,text,text) TO authenticated, service_role;

ALTER FUNCTION public.create_split_invoices_from_order(uuid,uuid,text,text) RENAME TO _create_split_invoices_from_order_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._create_split_invoices_from_order_pre_admin_only_20261009(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.create_split_invoices_from_order(p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT 'chemical_sale'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public._require_invoicing_admin();
  RETURN public._create_split_invoices_from_order_pre_admin_only_20261009(
    p_order_id => p_order_id,
    p_salesman_id => p_salesman_id,
    p_invoice_type => p_invoice_type,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.create_split_invoices_from_order(uuid,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_split_invoices_from_order(uuid,uuid,text,text) TO authenticated, service_role;

ALTER FUNCTION public.create_invoice_from_blend_ticket(uuid,uuid,text) RENAME TO _create_invoice_from_blend_ticket_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._create_invoice_from_blend_ticket_pre_admin_only_20261009(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.create_invoice_from_blend_ticket(p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._create_invoice_from_blend_ticket_pre_admin_only_20261009(
    p_blend_ticket_id => p_blend_ticket_id,
    p_created_by => p_created_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.create_invoice_from_blend_ticket(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_from_blend_ticket(uuid,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.transfer_job_to_invoice(uuid,uuid,text) RENAME TO _transfer_job_to_invoice_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._transfer_job_to_invoice_pre_admin_only_20261009(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.transfer_job_to_invoice(p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._transfer_job_to_invoice_pre_admin_only_20261009(
    p_job_id => p_job_id,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.transfer_job_to_invoice(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_job_to_invoice(uuid,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.transfer_invoice_to_job(uuid,uuid,text) RENAME TO _transfer_invoice_to_job_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._transfer_invoice_to_job_pre_admin_only_20261009(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.transfer_invoice_to_job(p_invoice_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._transfer_invoice_to_job_pre_admin_only_20261009(
    p_invoice_id => p_invoice_id,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.transfer_invoice_to_job(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_invoice_to_job(uuid,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.consolidate_draft_invoices(uuid,uuid,text) RENAME TO _consolidate_draft_invoices_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._consolidate_draft_invoices_pre_admin_only_20261009(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.consolidate_draft_invoices(p_order_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._consolidate_draft_invoices_pre_admin_only_20261009(
    p_order_id => p_order_id,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.consolidate_draft_invoices(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consolidate_draft_invoices(uuid,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.update_field_app_applied_info(uuid[],text,text,text,uuid,text,numeric,numeric,text,numeric,time without time zone,text,numeric,numeric,text,numeric,time without time zone,text,boolean,boolean,numeric,boolean) RENAME TO _update_field_app_applied_info_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._update_field_app_applied_info_pre_admin_only_20261009(uuid[],text,text,text,uuid,text,numeric,numeric,text,numeric,time without time zone,text,numeric,numeric,text,numeric,time without time zone,text,boolean,boolean,numeric,boolean) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.update_field_app_applied_info(p_invoice_ids uuid[], p_wind_direction text DEFAULT NULL::text, p_temperature_text text DEFAULT NULL::text, p_applicator_name text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_start_temp_f numeric DEFAULT NULL::numeric, p_start_wind_mph numeric DEFAULT NULL::numeric, p_start_wind_direction text DEFAULT NULL::text, p_start_humidity_pct numeric DEFAULT NULL::numeric, p_start_weather_time time without time zone DEFAULT NULL::time without time zone, p_start_weather_source text DEFAULT NULL::text, p_end_temp_f numeric DEFAULT NULL::numeric, p_end_wind_mph numeric DEFAULT NULL::numeric, p_end_wind_direction text DEFAULT NULL::text, p_end_humidity_pct numeric DEFAULT NULL::numeric, p_end_weather_time time without time zone DEFAULT NULL::time without time zone, p_end_weather_source text DEFAULT NULL::text, p_weather_manual_override boolean DEFAULT NULL::boolean, p_update_weather boolean DEFAULT false, p_diluent_rate_gpa numeric DEFAULT NULL::numeric, p_update_diluent boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._update_field_app_applied_info_pre_admin_only_20261009(
    p_invoice_ids => p_invoice_ids,
    p_wind_direction => p_wind_direction,
    p_temperature_text => p_temperature_text,
    p_applicator_name => p_applicator_name,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key,
    p_start_temp_f => p_start_temp_f,
    p_start_wind_mph => p_start_wind_mph,
    p_start_wind_direction => p_start_wind_direction,
    p_start_humidity_pct => p_start_humidity_pct,
    p_start_weather_time => p_start_weather_time,
    p_start_weather_source => p_start_weather_source,
    p_end_temp_f => p_end_temp_f,
    p_end_wind_mph => p_end_wind_mph,
    p_end_wind_direction => p_end_wind_direction,
    p_end_humidity_pct => p_end_humidity_pct,
    p_end_weather_time => p_end_weather_time,
    p_end_weather_source => p_end_weather_source,
    p_weather_manual_override => p_weather_manual_override,
    p_update_weather => p_update_weather,
    p_diluent_rate_gpa => p_diluent_rate_gpa,
    p_update_diluent => p_update_diluent
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.update_field_app_applied_info(uuid[],text,text,text,uuid,text,numeric,numeric,text,numeric,time without time zone,text,numeric,numeric,text,numeric,time without time zone,text,boolean,boolean,numeric,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_field_app_applied_info(uuid[],text,text,text,uuid,text,numeric,numeric,text,numeric,time without time zone,text,numeric,numeric,text,numeric,time without time zone,text,boolean,boolean,numeric,boolean) TO authenticated, service_role;

ALTER FUNCTION public.update_field_app_invoice_billing(uuid[],text,text,text,date,text,text,jsonb,uuid,text) RENAME TO _update_field_app_invoice_billing_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._update_field_app_invoice_billing_pre_admin_only_20261009(uuid[],text,text,text,date,text,text,jsonb,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.update_field_app_invoice_billing(p_invoice_ids uuid[], p_purchase_order_ref text DEFAULT NULL::text, p_payment_terms text DEFAULT NULL::text, p_header_notes text DEFAULT NULL::text, p_due_date date DEFAULT NULL::date, p_footer_notes text DEFAULT NULL::text, p_internal_notes text DEFAULT NULL::text, p_discounts jsonb DEFAULT '{}'::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._update_field_app_invoice_billing_pre_admin_only_20261009(
    p_invoice_ids => p_invoice_ids,
    p_purchase_order_ref => p_purchase_order_ref,
    p_payment_terms => p_payment_terms,
    p_header_notes => p_header_notes,
    p_due_date => p_due_date,
    p_footer_notes => p_footer_notes,
    p_internal_notes => p_internal_notes,
    p_discounts => p_discounts,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.update_field_app_invoice_billing(uuid[],text,text,text,date,text,text,jsonb,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_field_app_invoice_billing(uuid[],text,text,text,date,text,text,jsonb,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.post_invoice(uuid,text) RENAME TO _post_invoice_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._post_invoice_pre_admin_only_20261009(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.post_invoice(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text, p_expected_version text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_cached jsonb;
BEGIN
  PERFORM public._require_invoicing_admin();
  IF p_expected_version IS NOT NULL THEN
    IF p_expected_version !~ '^[0-9a-f]{32}$' THEN
      RAISE EXCEPTION 'INVOICE_EXPECTED_VERSION_INVALID: post_invoice expects the version from get_invoice_post_version'
        USING ERRCODE = '22023';
    END IF;
    IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: post_invoice'
        USING ERRCODE = '22023';
    END IF;
    -- The implementation's key lock (check_idempotency takes the same one and holds it to the
    -- end of the transaction): a duplicate call with this key waits here until the first one
    -- commits, then finds its receipt and replays without a re-check.
    PERFORM pg_advisory_xact_lock(hashtextextended('crx:idempotency:' || p_idempotency_key, 0));
    v_cached := public.check_idempotency(p_idempotency_key, 'post_invoice');
    IF v_cached IS NULL THEN
      PERFORM 1 FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
      IF public._invoice_review_fingerprint(ARRAY[p_invoice_id]) IS DISTINCT FROM p_expected_version THEN
        RAISE EXCEPTION 'INVOICE_CHANGED_SINCE_REVIEW: the invoice changed after it was reviewed; reload and review it again before posting';
      END IF;
    END IF;
  END IF;
  PERFORM public._post_invoice_pre_admin_only_20261009(
    p_invoice_id => p_invoice_id,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.post_invoice(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice(uuid,text,text) TO authenticated, service_role;

ALTER FUNCTION public.post_invoice_group(uuid,uuid,text) RENAME TO _post_invoice_group_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._post_invoice_group_pre_admin_only_20261009(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.post_invoice_group(p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text, p_expected_version text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_cached jsonb;
  v_member_ids uuid[];
BEGIN
  PERFORM public._require_invoicing_admin();
  IF p_expected_version IS NOT NULL THEN
    IF p_expected_version !~ '^[0-9a-f]{32}$' THEN
      RAISE EXCEPTION 'INVOICE_EXPECTED_VERSION_INVALID: post_invoice_group expects the version from get_invoice_group_post_version'
        USING ERRCODE = '22023';
    END IF;
    -- Codex, PR #902: a versioned group post needs a key too, as post_invoice and
    -- batch_post_invoices do (the frozen body treats it as optional), so a lost reply replays.
    IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: post_invoice_group'
        USING ERRCODE = '22023';
    END IF;
    IF p_invoice_group_id IS NOT NULL AND p_performed_by IS NOT DISTINCT FROM auth.uid() THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('post_invoice_group:' || p_idempotency_key, 0));
      v_cached := public.check_idempotency(p_idempotency_key, 'post_invoice_group');
      IF v_cached IS NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(p_invoice_group_id::text, 0));
        SELECT array_agg(m.id ORDER BY m.id) INTO v_member_ids
          FROM (SELECT i.id
                  FROM public.invoices i
                 WHERE i.invoice_group_id = p_invoice_group_id
                   AND i.deleted_at IS NULL
                 ORDER BY i.id
                   FOR UPDATE) m;
        IF public._invoice_review_fingerprint(v_member_ids) IS DISTINCT FROM p_expected_version THEN
          RAISE EXCEPTION 'INVOICE_CHANGED_SINCE_REVIEW: an invoice in this group changed after it was reviewed; reload and review it again before posting';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN public._post_invoice_group_pre_admin_only_20261009(
    p_invoice_group_id => p_invoice_group_id,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.post_invoice_group(uuid,uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice_group(uuid,uuid,text,text) TO authenticated, service_role;

ALTER FUNCTION public.batch_post_invoices(uuid[],text) RENAME TO _batch_post_invoices_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._batch_post_invoices_pre_admin_only_20261009(uuid[],text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.batch_post_invoices(p_invoice_ids uuid[], p_idempotency_key text DEFAULT NULL::text, p_expected_version text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  IF p_expected_version IS NOT NULL THEN
    IF p_expected_version !~ '^[0-9a-f]{32}$' THEN
      RAISE EXCEPTION 'INVOICE_EXPECTED_VERSION_INVALID: batch_post_invoices expects the version from get_invoice_post_version'
        USING ERRCODE = '22023';
    END IF;
    IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: batch_post_invoices'
        USING ERRCODE = '22023';
    END IF;
    IF array_length(p_invoice_ids, 1) IS NOT NULL THEN
      -- The two key locks _claim_bound_lifecycle_idempotency takes, in its order. The receipt
      -- lookup is scoped to this operation (review round 4): only a batch_post_invoices receipt
      -- skips the re-check; a receipt stored by ANOTHER operation does not, so this gate never
      -- relies on the frozen body's IDEMPOTENCY_CROSS_OP_KEY_REUSE refusal (which still follows).
      PERFORM pg_advisory_xact_lock(hashtextextended('crx:idempotency:batch_post_invoices:' || p_idempotency_key, 0));
      PERFORM pg_advisory_xact_lock(hashtextextended('crx:idempotency:' || p_idempotency_key, 0));
      IF NOT EXISTS (
        SELECT 1
          FROM public.idempotency_keys k
         WHERE k.idempotency_key = p_idempotency_key
           AND k.operation = 'batch_post_invoices'
           AND (k.expires_at IS NULL OR k.expires_at >= now())
      ) THEN
        PERFORM 1 FROM public.invoices i WHERE i.id = ANY (p_invoice_ids) ORDER BY i.id FOR UPDATE;
        IF public._invoice_review_fingerprint(p_invoice_ids) IS DISTINCT FROM p_expected_version THEN
          RAISE EXCEPTION 'INVOICE_CHANGED_SINCE_REVIEW: an invoice in this batch changed after it was reviewed; reload and review it again before posting';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN public._batch_post_invoices_pre_admin_only_20261009(
    p_invoice_ids => p_invoice_ids,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.batch_post_invoices(uuid[],text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_post_invoices(uuid[],text,text) TO authenticated, service_role;

ALTER FUNCTION public.unpost_invoice(uuid,uuid,text) RENAME TO _unpost_invoice_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._unpost_invoice_pre_admin_only_20261009(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.unpost_invoice(p_invoice_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._unpost_invoice_pre_admin_only_20261009(
    p_invoice_id => p_invoice_id,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.unpost_invoice(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unpost_invoice(uuid,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.unpost_invoice_group(uuid,uuid,text) RENAME TO _unpost_invoice_group_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._unpost_invoice_group_pre_admin_only_20261009(uuid,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.unpost_invoice_group(p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._unpost_invoice_group_pre_admin_only_20261009(
    p_invoice_group_id => p_invoice_group_id,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.unpost_invoice_group(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unpost_invoice_group(uuid,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.batch_void_invoices(uuid[],text,uuid,text) RENAME TO _batch_void_invoices_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._batch_void_invoices_pre_admin_only_20261009(uuid[],text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.batch_void_invoices(p_invoice_ids uuid[], p_void_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._batch_void_invoices_pre_admin_only_20261009(
    p_invoice_ids => p_invoice_ids,
    p_void_reason => p_void_reason,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.batch_void_invoices(uuid[],text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_void_invoices(uuid[],text,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.apply_credit_memo_to_invoice(uuid,uuid,bigint,uuid,text) RENAME TO _apply_credit_memo_to_invoice_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._apply_credit_memo_to_invoice_pre_admin_only_20261009(uuid,uuid,bigint,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.apply_credit_memo_to_invoice(p_credit_memo_id uuid, p_target_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._apply_credit_memo_to_invoice_pre_admin_only_20261009(
    p_credit_memo_id => p_credit_memo_id,
    p_target_invoice_id => p_target_invoice_id,
    p_amount_cents => p_amount_cents,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.apply_credit_memo_to_invoice(uuid,uuid,bigint,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_credit_memo_to_invoice(uuid,uuid,bigint,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.reverse_credit_memo_application(uuid,text,uuid,text) RENAME TO _reverse_credit_memo_application_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._reverse_credit_memo_application_pre_admin_only_20261009(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.reverse_credit_memo_application(p_application_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._reverse_credit_memo_application_pre_admin_only_20261009(
    p_application_id => p_application_id,
    p_reason => p_reason,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.reverse_credit_memo_application(uuid,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_credit_memo_application(uuid,text,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.apply_prepay_to_invoice(uuid,uuid,bigint,uuid,text) RENAME TO _apply_prepay_to_invoice_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._apply_prepay_to_invoice_pre_admin_only_20261009(uuid,uuid,bigint,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.apply_prepay_to_invoice(p_prepay_credit_id uuid, p_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._apply_prepay_to_invoice_pre_admin_only_20261009(
    p_prepay_credit_id => p_prepay_credit_id,
    p_invoice_id => p_invoice_id,
    p_amount_cents => p_amount_cents,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.apply_prepay_to_invoice(uuid,uuid,bigint,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_prepay_to_invoice(uuid,uuid,bigint,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.batch_apply_all_prepayments(uuid,text) RENAME TO _batch_apply_all_prepayments_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._batch_apply_all_prepayments_pre_admin_only_20261009(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.batch_apply_all_prepayments(p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._batch_apply_all_prepayments_pre_admin_only_20261009(
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.batch_apply_all_prepayments(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_apply_all_prepayments(uuid,text) TO authenticated, service_role;

-- reverse_write_off was already meant to be admin-only, but its role test lets a caller with no
-- active profile through (NULL != 'admin' is NULL). The guard refuses that caller first.
ALTER FUNCTION public.reverse_write_off(uuid,text,uuid,text) RENAME TO _reverse_write_off_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._reverse_write_off_pre_admin_only_20261009(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.reverse_write_off(p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM public._require_invoicing_admin();
  RETURN public._reverse_write_off_pre_admin_only_20261009(
    p_write_off_id => p_write_off_id,
    p_reason => p_reason,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.reverse_write_off(uuid,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_write_off(uuid,text,uuid,text) TO authenticated, service_role;

ALTER FUNCTION public.create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean) RENAME TO _create_quick_delivery_pre_admin_only_20261009;
REVOKE ALL ON FUNCTION public._create_quick_delivery_pre_admin_only_20261009(uuid,jsonb,uuid,date,text,uuid,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.create_quick_delivery(p_customer_id uuid, p_items jsonb, p_driver_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE, p_delivery_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_skip_invoice boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN public._create_quick_delivery_pre_admin_only_20261009(
    p_customer_id => p_customer_id,
    p_items => p_items,
    p_driver_id => p_driver_id,
    p_scheduled_date => p_scheduled_date,
    p_delivery_notes => p_delivery_notes,
    p_performed_by => p_performed_by,
    p_idempotency_key => p_idempotency_key,
    p_skip_invoice => CASE WHEN public.is_admin() THEN p_skip_invoice ELSE true END
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean) TO authenticated, service_role;

-- =============================================================================================
-- 1c. Delivery completion: verbatim live body; the single-customer auto-invoice now runs only
-- for an admin (ELSIF), and every other completer gets the activity row and admin
-- notifications (new ELSE). CREATE OR REPLACE keeps the OID, owner and ACL.
-- =============================================================================================
CREATE OR REPLACE FUNCTION public._complete_delivery_authorized_impl(p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_qty_to_deliver numeric;
  v_deduct_from_prebooked numeric;
  v_any_partial boolean := false;
  v_all_delivered boolean;
  v_linked_invoice record;
  v_result jsonb;
  v_existing jsonb;
  v_actor uuid;
  v_actor_role text;
  v_auto_invoice_id uuid;
  v_auto_invoice_number text;
  v_auto_total_cents bigint := 0;
  v_auto_cost_cents bigint := 0;
  -- CRX-MONEY-LIFECYCLE-001: cents allocated to THIS delivery from the order
  -- line's stored total, rather than re-extended from price x quantity.
  v_line_alloc_cents bigint := 0;
  v_existing_active_invoice_count int;
  v_closed_period record;
  v_admin record;
  -- U9 stock-policy WARN-NOT-BLOCK
  v_short_count int := 0;
  v_stock_warnings text[] := '{}';
  v_short_product_ids uuid[] := '{}';
  v_effective_completion_date date;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  -- U15: optional backdate. Reject future timestamps (small clock-skew allowance);
  -- NULL = legacy behavior (now()/CURRENT_DATE).
  IF p_completed_at IS NOT NULL AND p_completed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'COMPLETED_AT_IN_FUTURE: completion time cannot be in the future';
  END IF;

  v_effective_completion_date := COALESCE(
    (p_completed_at AT TIME ZONE 'America/Chicago')::date,
    (now() AT TIME ZONE 'America/Chicago')::date
  );

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'complete_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  IF v_delivery.status != 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be in_progress to complete (current status: %). Call confirm_delivery() first.', v_delivery.status;
  END IF;

  -- PR-01 fix: column is `scheduled_date`, not `delivery_date`.
  SELECT id, period_start, period_end
    INTO v_closed_period
    FROM accounting_periods
   WHERE status = 'closed'
     AND v_effective_completion_date BETWEEN period_start AND period_end
   LIMIT 1;

  IF FOUND THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'backdated_delivery_in_closed_period',
      'WARNING: Delivery ' || v_delivery.delivery_number ||
        ' completed for ' || v_effective_completion_date::text ||
        ' which falls in CLOSED accounting period ' ||
        v_closed_period.period_start::text || ' to ' ||
        v_closed_period.period_end::text || '. Operation proceeded; verify with finance.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );

    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Backdated Delivery Completion',
        'Delivery ' || v_delivery.delivery_number ||
          ' was completed for ' || v_effective_completion_date::text ||
          ' — that date is inside a CLOSED accounting period (' ||
          v_closed_period.period_start::text || ' to ' ||
          v_closed_period.period_end::text || '). Inventory and lifecycle ' ||
          'changes proceeded. Verify the financial impact.',
        'period_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  FOR v_item IN
    SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;
    IF v_qty_to_deliver < v_item.quantity THEN v_any_partial := true; END IF;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;
    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;
    -- U9: WARN-NOT-BLOCK (was: RAISE EXCEPTION 'Insufficient inventory ...').
    -- Same on-hand math; completion proceeds and stock is allowed to go negative.
    IF NOT FOUND OR COALESCE(v_inv.quantity_available, 0) < v_qty_to_deliver THEN
      v_short_count := v_short_count + 1;
      v_short_product_ids := array_append(v_short_product_ids, v_item.product_id);
      v_stock_warnings := array_append(v_stock_warnings,
        v_item.product_name || ': need ' || v_qty_to_deliver || ', only ' ||
        COALESCE(v_inv.quantity_available, 0) || ' on-hand');
      -- U9 (Codex R2 P2): seed a zero row when missing so the deduction UPDATE
      -- below lands and the on-hand aggregate goes visibly negative.
      IF NOT FOUND THEN
        INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, manufactured_at_delivery)
        VALUES (v_item.product_id, 'Main Warehouse', 0, 0, true)  -- surfaces on /integrity-cleanup (P4-7 phantom-row flag)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  -- P2-D: authorize the post-completion delivery_items + lifecycle writes below.
  -- The enforce_delivery_items_parent_lock trigger blocks writes to a
  -- non-scheduled delivery's items; complete_delivery legitimately records
  -- quantity_delivered after flipping status to 'completed', so it sets the
  -- canonical admin_override escape hatch (transaction-local).
  SET LOCAL app.admin_override = 'true';

  UPDATE deliveries SET
    status = 'completed', completed_at = COALESCE(p_completed_at, now()), signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  FOR v_item IN
    SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;
    UPDATE delivery_items SET quantity_delivered = v_qty_to_deliver WHERE id = v_item.id;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;

    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_qty_to_deliver,
      quantity_remaining = GREATEST(quantity_remaining - v_qty_to_deliver, 0)
    WHERE id = v_item.order_item_id;

    -- U9: flag the delivered ledger row for review when the product was short.
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes, requires_review
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE '' END ||
        CASE WHEN v_item.product_id = ANY(v_short_product_ids)
          THEN ' [SHORT STOCK — review required]' ELSE '' END ||
        '. Signed by: ' || p_signed_by,
      v_item.product_id = ANY(v_short_product_ids)
    );

    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
    v_deduct_from_prebooked := LEAST(v_qty_to_deliver, COALESCE(v_inv.quantity_prebooked, 0));

    UPDATE inventory SET
      quantity_available = quantity_available - v_qty_to_deliver,
      quantity_prebooked = quantity_prebooked - v_deduct_from_prebooked,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- U2 (Codex P2): with per-delivery invoices now possible on one order, the
  -- tote copy must NOT stamp a SIBLING delivery's invoice — scope it to this
  -- delivery's own invoice or an order-level one (delivery_id IS NULL), the
  -- same shape as the auto-invoice guard below. Return-credit lines are
  -- immutable accounting provenance, not delivery-sale lines to relabel.
  UPDATE invoice_items ii
  SET tote_number = di.tote_number
  FROM delivery_items di
  JOIN invoices inv ON inv.order_id = v_delivery.order_id AND inv.deleted_at IS NULL
    AND inv.invoice_type <> 'credit_memo'
    AND (inv.delivery_id = p_delivery_id OR inv.delivery_id IS NULL)
  WHERE di.delivery_id = p_delivery_id
    AND ii.invoice_id = inv.id
    AND di.order_item_id = ii.order_item_id
    AND di.tote_number IS NOT NULL;

  IF v_any_partial THEN
    FOR v_item IN
      SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id AND di.quantity_delivered < di.quantity
    LOOP
      INSERT INTO delivery_remainders (
        original_delivery_id, order_id, order_item_id,
        customer_id, product_id, quantity_remaining, unit_size
      ) VALUES (
        p_delivery_id, v_delivery.order_id, v_item.order_item_id,
        v_delivery.customer_id, v_item.product_id,
        v_item.quantity - v_item.quantity_delivered, v_item.unit_size
      );
    END LOOP;
  END IF;

  -- U2 #39: close out the remainder rows THIS follow-up delivery was created to satisfy.
  -- create_followup_delivery flips the parent's remainders 'pending'->'scheduled' and stamps
  -- followup_delivery_id = this delivery. Now that this delivery has completed, mark them
  -- 'fulfilled'. Any lines this follow-up ITSELF shorted are already captured as fresh
  -- 'pending' remainder rows by the v_any_partial INSERT above (original_delivery_id = this
  -- delivery), so this flip never loses outstanding quantity — it prevents the same shortfall
  -- being double-counted as both a stale 'scheduled' row and a new 'pending' row. Idempotent
  -- (guarded by status = 'scheduled'); targets rows disjoint from the ones just inserted.
  UPDATE delivery_remainders
     SET status = 'fulfilled', updated_at = now()
   WHERE followup_delivery_id = p_delivery_id
     AND status = 'scheduled';

  -- P2 fix (Codex 2026-07-10): serialize concurrent same-day FINAL deliveries on the SAME
  -- order. Two deliveries completing at once each read v_all_delivered under READ COMMITTED
  -- without seeing the other's uncommitted order_items decrement, so both could compute
  -- false and skip the Feature A auto-split (order falls back to manual split-billing — safe,
  -- but the auto-split silently doesn't fire). Take the orders row lock BEFORE the read: the
  -- second completion blocks here until the first commits, then sees the committed decrement.
  -- Lock ORDER is unchanged (deliveries -> inventory -> orders): the UPDATE orders just below
  -- already acquired this same row lock — this only moves the acquisition ahead of the read,
  -- adding no new lock pair (no new deadlock surface).
  IF v_delivery.order_id IS NOT NULL THEN
    PERFORM 1 FROM orders WHERE id = v_delivery.order_id FOR UPDATE;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  IF v_any_partial AND v_delivery.order_id IS NOT NULL THEN
    FOR v_linked_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id AND status = 'draft' AND delivery_id = p_delivery_id
    LOOP
      UPDATE invoice_items ii SET
        quantity = di.quantity_delivered,
        extended_cents = public._allocated_delivery_cents(
                           ii.order_item_id, di.quantity_delivered, ii.invoice_id)
      FROM delivery_items di
      WHERE di.delivery_id = p_delivery_id AND ii.invoice_id = v_linked_invoice.id AND ii.order_item_id = di.order_item_id;
      -- Overnight bug-hunt LOW (20260620): also recompute the stored header cost so
      -- a partial completion doesn't leave total_cost_cents sized to the full qty.
      -- cost_cents is PER-UNIT cents; line cost = cost_cents * quantity (no *100).
      UPDATE invoices SET
        total_amount_cents = (SELECT COALESCE(SUM(extended_cents), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
        total_cost_cents = (SELECT COALESCE(SUM(cost_cents * quantity), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
        updated_at = now()
      WHERE id = v_linked_invoice.id;
    END LOOP;
  END IF;

  IF v_delivery.order_id IS NOT NULL THEN
    -- U2 #34: per-DELIVERY-aware guard (was per-ORDER). Block only if THIS delivery already
    -- has an active invoice, or an ORDER-LEVEL invoice (delivery_id IS NULL) already covers
    -- the whole order. An active invoice tied to a DIFFERENT delivery must NOT block this
    -- delivery — otherwise a follow-up delivery of shorted product is never billed.
    SELECT COUNT(*) INTO v_existing_active_invoice_count
    FROM invoices
    WHERE order_id = v_delivery.order_id
      AND status NOT IN ('voided', 'cancelled')
      AND invoice_type <> 'credit_memo'
      AND deleted_at IS NULL
      AND (delivery_id = p_delivery_id OR delivery_id IS NULL);

    IF v_existing_active_invoice_count = 0 THEN
      -- U7 SAFE-SCOPE (#43): a field/acre-allocated order must NOT be mono-billed
      -- 100% to the primary customer (that dead-ends the landlord's payment). Skip the
      -- auto-draft, flag the order for a manual per-owner split-billing pass, and notify
      -- the office. Non-allocated orders keep the EXACT auto-draft in the ELSE below.
      IF EXISTS (
        SELECT 1 FROM order_item_field_allocations oifa
        JOIN order_items oi ON oi.id = oifa.order_item_id
        WHERE oi.order_id = v_delivery.order_id
      ) THEN
        -- Codex pre-ship HIGH fix: only auto-split when the delivery's EFFECTIVE date is TODAY.
        -- create_split_invoices_from_order stamps invoice_date = CURRENT_DATE and takes no date arg, so
        -- auto-splitting a BACKDATED completion (p_completed_at in a prior/closed period) would silently
        -- date the drafts today and shift AR aging/terms — while the mono-bill path (below) respects the
        -- backdate. A backdated allocated order falls through to flag+notify (the office creates the split
        -- manually, exactly as before Feature A); same-day completions (the common case) auto-split.
        IF v_all_delivered
           AND v_effective_completion_date = (now() AT TIME ZONE 'America/Chicago')::date THEN
          -- the whole order is now delivered TODAY -> auto-create the per-owner split DRAFTS via the proven engine.
          BEGIN
            PERFORM create_split_invoices_from_order(
              v_delivery.order_id, NULL, 'chemical_sale',
              COALESCE(p_idempotency_key, p_delivery_id::text) || ':autosplit'
            );
            -- create_split_invoices_from_order creates draft invoices per owner, clears
            -- needs_split_billing, and writes its own activity_feed + financial_audit_log rows.
            -- Add ONE activity_feed row noting the auto-creation on this delivery completion.
            INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
            VALUES (
              'split_invoices_auto_created',
              'Delivery ' || v_delivery.delivery_number || ' completed the order — per-owner split DRAFT invoices were auto-created (review + post them).',
              v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
            );
          EXCEPTION WHEN OTHERS THEN
            -- Any reason the split cannot run yet (order not priced -> PRICING_INCOMPLETE, an
            -- edge race, a still-open sibling delivery, etc.): fall back to today's flag+notify.
            -- The subtransaction rolls back any partial split work; the delivery completion is UNAFFECTED.
        UPDATE orders SET needs_split_billing = true, updated_at = now()
          WHERE id = v_delivery.order_id;
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'order_needs_split_billing',
          'Delivery ' || v_delivery.delivery_number || ' completed on a multi-owner (field/acre) order — auto-invoice skipped; create split invoices from the order to bill each owner.',
          v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
        );
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (
            user_id, title, message, notification_type,
            related_entity_type, related_entity_id
          ) VALUES (
            v_admin.id,
            'Order needs split billing',
            'Delivery ' || v_delivery.delivery_number || ' completed on a field/acre-allocated order. The mono-bill auto-invoice was skipped — open the order and use "Create Split Invoices" to bill each owner their own payable invoice.',
            'split_billing', 'order', v_delivery.order_id
          );
        END LOOP;
        END;
      ELSE
        -- Partial delivery of an allocated order (product still remains): keep today's
        -- skip-and-queue exactly. (Per-delivery split billing for partial orders is a separate redesign.)
        UPDATE orders SET needs_split_billing = true, updated_at = now()
          WHERE id = v_delivery.order_id;
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'order_needs_split_billing',
          'Delivery ' || v_delivery.delivery_number || ' completed on a multi-owner (field/acre) order — auto-invoice skipped; create split invoices from the order to bill each owner.',
          v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
        );
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (
            user_id, title, message, notification_type,
            related_entity_type, related_entity_id
          ) VALUES (
            v_admin.id,
            'Order needs split billing',
            'Delivery ' || v_delivery.delivery_number || ' completed on a field/acre-allocated order. The mono-bill auto-invoice was skipped — open the order and use "Create Split Invoices" to bill each owner their own payable invoice.',
            'split_billing', 'order', v_delivery.order_id
          );
        END LOOP;
      END IF;
      ELSIF v_actor_role = 'admin' THEN
      v_auto_invoice_number := next_invoice_number('chemical_sale');
      INSERT INTO invoices (
        invoice_number, invoice_type, order_id, customer_id, delivery_id,
        status, invoice_date, total_amount_cents, total_cost_cents, created_by
      ) VALUES (
        v_auto_invoice_number, 'chemical_sale', v_delivery.order_id, v_delivery.customer_id, p_delivery_id,
        'draft', v_effective_completion_date, 0, 0, v_actor
      ) RETURNING id INTO v_auto_invoice_id;

      v_auto_total_cents := 0;
      v_auto_cost_cents := 0;
      FOR v_item IN
        SELECT di.id AS di_id, di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id, di.tote_number,
               oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name,
               p.product_name AS p_name
          FROM delivery_items di
          JOIN order_items oi ON oi.id = di.order_item_id
          JOIN products p ON p.id = di.product_id
         WHERE di.delivery_id = p_delivery_id
           AND COALESCE(di.quantity_delivered, 0) > 0
      LOOP
        v_line_alloc_cents := public._allocated_delivery_cents(
                                v_item.order_item_id, v_item.quantity_delivered, NULL);
        v_auto_total_cents := v_auto_total_cents + v_line_alloc_cents;
        v_auto_cost_cents  := v_auto_cost_cents  + ROUND(v_item.quantity_delivered * COALESCE(v_item.cost_per_unit, 0) * 100)::bigint;
        INSERT INTO invoice_items (
          invoice_id, order_item_id, product_id, description,
          quantity, unit_price_cents, extended_cents, cost_cents,
          unit_size, tote_number
        ) VALUES (
          v_auto_invoice_id, v_item.order_item_id, v_item.product_id,
          COALESCE(v_item.oi_product_name, v_item.p_name),
          v_item.quantity_delivered,
          ROUND(v_item.price_per_unit * 100)::bigint,
          v_line_alloc_cents,
          ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint,
          v_item.unit_size,
          v_item.tote_number
        );
      END LOOP;

      UPDATE invoices
         SET total_amount_cents = v_auto_total_cents,
             total_cost_cents   = v_auto_cost_cents
       WHERE id = v_auto_invoice_id;

      -- Overnight bug-hunt MED (20260620): provenance breadcrumb. Write the same
      -- financial_audit_log 'invoice_created' row create_invoice_from_order /
      -- create_invoice_for_unbilled_delivery write, so the append-only ledger
      -- records this auto-creator too (it previously logged only activity_feed).
      -- Draft-stage provenance; post_invoice still writes 'invoice_posted' later.
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_auto_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object(
          'invoice_number', v_auto_invoice_number,
          'delivery_id', p_delivery_id,
          'order_id', v_delivery.order_id,
          'customer_id', v_delivery.customer_id,
          'total_cents', v_auto_total_cents
        ),
        v_auto_total_cents,
        'Invoice ' || v_auto_invoice_number || ' auto-created on completion of delivery ' || v_delivery.delivery_number
      );
      ELSE
        -- Invoicing is admin-only (Mason 2026-10-09): a sales rep's or driver's completion
        -- creates no invoice and draws no invoice number. The delivery still completes; the
        -- office is told, and the delivery waits under "Delivered, not invoiced" until an
        -- admin bills it (DeliveryDetail Create Invoice).
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'delivery_invoice_pending_admin',
          'Delivery ' || v_delivery.delivery_number || ' completed by a non-admin — no draft invoice created; an admin must invoice it.',
          v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
        );
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (
            user_id, title, message, notification_type,
            related_entity_type, related_entity_id
          ) VALUES (
            v_admin.id,
            'Delivery needs an invoice',
            'Delivery ' || v_delivery.delivery_number || ' was completed by a non-admin. Invoicing is admin-only, so no draft invoice was created — open the delivery and use Create Invoice to bill it.',
            'delivery_needs_invoice', 'delivery', p_delivery_id
          );
        END LOOP;
      END IF;
    END IF;
  END IF;

  -- U9: short-stock WARN emit (mirrors the backdated-period warn+notify pattern above).
  IF v_short_count > 0 THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'delivery_short_stock',
      'WARNING: Delivery ' || v_delivery.delivery_number || ' completed with ' || v_short_count ||
        ' product(s) short on stock: ' || array_to_string(v_stock_warnings, ' | ') ||
        '. Completion proceeded; on-hand inventory went negative — review with the warehouse.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );
    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Short Stock — Delivery ' || v_delivery.delivery_number,
        'Delivery ' || v_delivery.delivery_number || ' was completed but ' || v_short_count ||
          ' product(s) did not have enough on-hand stock: ' || array_to_string(v_stock_warnings, ' | ') ||
          '. The completion proceeded and inventory went negative; please review.',
        'stock_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number || ' completed. Signed by: ' || p_signed_by ||
      CASE WHEN v_any_partial THEN ' (partial delivery — remainders created)' ELSE '' END ||
      CASE WHEN v_auto_invoice_id IS NOT NULL THEN ' [draft invoice ' || v_auto_invoice_number || ' auto-created]' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- U9: additive result fields — warnings[] + short_stock_count.
  v_result := jsonb_build_object(
    'status', CASE WHEN v_any_partial THEN 'partial' ELSE 'completed' END,
    'delivery_id', p_delivery_id,
    'order_fulfilled', v_all_delivered,
    'auto_invoice', CASE
      WHEN v_auto_invoice_id IS NOT NULL THEN
        jsonb_build_object('invoice_id', v_auto_invoice_id, 'invoice_number', v_auto_invoice_number, 'total_cents', v_auto_total_cents)
      ELSE NULL
    END,
    'stock_warning', (v_short_count > 0),
    'short_stock_count', v_short_count,
    'warnings', to_jsonb(v_stock_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'complete_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- =============================================================================================
-- 1d. complete_job: verbatim live body; the automatic draft runs only for an admin, and the
-- skip row says why.
-- =============================================================================================
CREATE OR REPLACE FUNCTION public.complete_job(p_job_id uuid, p_applied_info jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor          uuid := auth.uid();
  v_existing       jsonb;
  v_job            record;
  v_record_number  text;
  v_record_id      uuid;
  v_product_data   jsonb;
  v_weather        jsonb;
  v_chem           record;
  v_inv            record;
  v_inv_found      boolean;
  v_jf             record;
  v_first_field_id uuid;
  v_field_count    int := 0;
  v_short_count    int := 0;
  v_new_avail      numeric;
  v_short_flag     boolean;
  v_result         jsonb;
  v_deduct_qty     numeric;
  -- U11<<< raw-fallback bookkeeping for unconvertible units
  v_unconverted    boolean;
  v_unconv_count   int := 0;
  -- >>>U11
  -- U12 (Codex R2 P2): running sum of the per-field acres actually recorded, so
  -- the record header can be corrected when the caller sent 'field_acres' overrides.
  v_acres_sum      numeric := 0;
  v_auto_draft_on    boolean := false;
  v_existing_invoice uuid;
  v_auto_draft_key   text;
  -- N2-7 #106a/#106b<<< actual application date + applicator snapshot locals.
  v_application_date date;
  v_applicator_id      uuid;
  v_applicator_name    text;
  v_applicator_license text;
  -- >>>N2-7
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key AND operation = 'complete_job';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT j.*, c.farm_name AS customer_name
    INTO v_job
    FROM jobs j
    JOIN customers c ON c.id = j.customer_id
   WHERE j.id = p_job_id
   FOR UPDATE OF j;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found: %', p_job_id;
  END IF;

  -- U12: widened with an OR branch — but NARROWER than start_job's (Codex R1 P1,
  -- tightened again R2 P1): complete_job stamps application records + acres for
  -- EVERY field and deducts inventory for EVERY chemical on the job, so a
  -- location-only dispatchee may complete it ONLY when BOTH hold:
  --   (1) EVERY job_fields row on the job is covered by an ACTIVE dispatch owned
  --       by the caller (directly, or via active membership in the dispatched
  --       crew) — an undispatched field means someone's work isn't even assigned
  --       yet, so the whole-job close stays with the office / whole-job assignee;
  --   (2) no OTHER party holds an ACTIVE dispatch anywhere on the job.
  -- On any split/partial-dispatch job this branch stays closed — admin/sales_rep
  -- or jobs.applicator_id complete those, exactly as before this migration.
  -- Still a strict superset of live behavior.
  IF NOT (
    is_admin() OR is_sales_rep()
    -- NULL-SAFE (U12 live-verify finding): when jobs.applicator_id IS NULL this
    -- comparison yielded NULL, and IF NOT (NULL) skips the RAISE — any active
    -- applicator could start/complete a NULL-applicator job. Wrap it so the
    -- branch is FALSE, not NULL, and authorization falls through to the
    -- dispatch-based branch (which is already null-safe).
    OR (is_applicator() AND v_job.applicator_id IS NOT NULL AND v_job.applicator_id = v_actor)
    OR (
      is_applicator()
      AND public._is_dispatched_to_me(p_job_id)
      -- (1) every field on the job is actively dispatched to the caller.
      -- Crew ownership requires BOTH the membership row AND the crew itself to
      -- be active (RLS R2 M2) — matching _is_dispatched_to_me and the
      -- job_location_dispatches_select policy, so the completion power is never
      -- looser than the read power.
      AND NOT EXISTS (
        SELECT 1
          FROM job_fields jf2
         WHERE jf2.job_id = p_job_id
           AND NOT EXISTS (
             SELECT 1
               FROM job_location_dispatches d2
              WHERE d2.job_field_id = jf2.id
                AND d2.dispatch_status = 'dispatched'
                AND (
                  d2.applicator_id = v_actor
                  OR (d2.crew_id IS NOT NULL AND EXISTS (
                        SELECT 1
                          FROM ground_crew_members gcm
                          JOIN ground_crews gc ON gc.id = gcm.crew_id
                         WHERE gcm.crew_id = d2.crew_id
                           AND gcm.profile_id = v_actor
                           AND gcm.is_active
                           AND gc.is_active))
                )
           )
      )
      -- (2) and nobody ELSE holds an active dispatch on the job. The applicator
      -- comparison is wrapped null-safe (RLS R2 M1): on a crew-held dispatch
      -- d.applicator_id IS NULL, and `NULL = v_actor` would poison the NOT()
      -- into NULL and silently drop the row from the EXISTS.
      AND NOT EXISTS (
        SELECT 1
          FROM job_location_dispatches d
         WHERE d.job_id = p_job_id
           AND d.dispatch_status = 'dispatched'
           AND NOT (
             (d.applicator_id IS NOT NULL AND d.applicator_id = v_actor)
             OR (d.crew_id IS NOT NULL AND EXISTS (
                   SELECT 1
                     FROM ground_crew_members gcm
                     JOIN ground_crews gc ON gc.id = gcm.crew_id
                    WHERE gcm.crew_id = d.crew_id
                      AND gcm.profile_id = v_actor
                      AND gcm.is_active
                      AND gc.is_active))
           )
      )
    )
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this job';
  END IF;

  IF v_job.status != 'in_progress' THEN
    RAISE EXCEPTION 'Job must be in_progress before completion. Current status: %. Use start_job() first.', v_job.status;
  END IF;

  -- Fires A4's jobs lifecycle trigger → _sync_job_holds releases this job's hold
  -- and re-syncs the parent quote (keeping the draw). The quote hold / booking is
  -- owned by A4 from here; the loop below only deducts physical stock.
  UPDATE jobs SET status = 'completed' WHERE id = p_job_id;

  INSERT INTO job_applied_info (
    job_id, actual_start_time, actual_end_time,
    wind_speed, wind_direction, temperature, humidity,
    actual_gallons_applied, notes
  ) VALUES (
    p_job_id,
    CASE WHEN p_applied_info->>'actual_start_time' IS NOT NULL
      THEN (p_applied_info->>'actual_start_time')::timestamptz ELSE NULL END,
    CASE WHEN p_applied_info->>'actual_end_time' IS NOT NULL
      THEN (p_applied_info->>'actual_end_time')::timestamptz ELSE NULL END,
    (p_applied_info->>'wind_speed')::numeric,
    p_applied_info->>'wind_direction',
    (p_applied_info->>'temperature')::numeric,
    (p_applied_info->>'humidity')::numeric,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    p_applied_info->>'notes'
  )
  ON CONFLICT (job_id) DO UPDATE SET
    actual_start_time      = COALESCE(EXCLUDED.actual_start_time,      job_applied_info.actual_start_time),
    actual_end_time        = EXCLUDED.actual_end_time,
    wind_speed             = EXCLUDED.wind_speed,
    wind_direction         = EXCLUDED.wind_direction,
    temperature            = EXCLUDED.temperature,
    humidity               = EXCLUDED.humidity,
    actual_gallons_applied = EXCLUDED.actual_gallons_applied,
    notes                  = EXCLUDED.notes;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id',       jc.product_id,
        'product_name',     p.product_name,
        'quantity',         jc.quantity,
        'unit',             jc.unit,
        'rate_per_acre',    jc.rate_per_acre,
        'rate_unit',        jc.rate_unit,
        'epa_registration', p.epa_registration,
        'is_rup',           COALESCE(p.is_rup, false),
        -- U4<<< legal record marks a grower-supplied product; the row STAYS in
        -- product_data (REI/PHI watchdog + as-applied proof still see it). (#53/#54)
        'customer_supplied', jc.customer_supplied
        -- >>>U4
      )
      ORDER BY jc.sort_order
    ),
    '[]'::jsonb
  )
  INTO v_product_data
  FROM job_chemicals jc
  LEFT JOIN products p ON p.id = jc.product_id
  WHERE jc.job_id = p_job_id;

  v_weather := jsonb_build_object(
    'wind_speed',     (p_applied_info->>'wind_speed')::numeric,
    'wind_direction', p_applied_info->>'wind_direction',
    'temperature',    (p_applied_info->>'temperature')::numeric,
    'humidity',       (p_applied_info->>'humidity')::numeric
  );

  v_record_number := next_application_record_number();

  SELECT field_id INTO v_first_field_id
    FROM job_fields
   WHERE job_id = p_job_id
   ORDER BY sort_order, id
   LIMIT 1;

  -- N2-7 #106a<<< the ACTUAL application date. The job_applied_info upsert above already
  -- merged the completer-sent start with the start_job-stamped start
  -- (COALESCE(EXCLUDED.actual_start_time, existing)), so that row's actual_start_time is
  -- the single source of truth for "when it was actually applied". Prefer the just-sent
  -- value, then the stored start, then fall back to v_job.job_date EXACTLY as before this
  -- migration when no actual start exists anywhere (byte-identical to old behavior).
  -- Codex R1 P2: cast through the BUSINESS timezone, not the session default
  -- (UTC on Supabase) — a 7:30 PM Central start is still "today" on the legal
  -- record, not tomorrow. CRX operates in US Central only (single-region ag
  -- retailer); if that ever changes this becomes an app_settings value.
  v_application_date := COALESCE(
    (
      COALESCE(
        (p_applied_info->>'actual_start_time')::timestamptz,
        (SELECT jai.actual_start_time FROM job_applied_info jai WHERE jai.job_id = p_job_id)
      ) AT TIME ZONE 'America/Chicago'
    )::date,
    v_job.job_date
  );
  -- >>>N2-7 #106a

  -- N2-7 #106b<<< snapshot the applicator's identity as-of NOW onto the legal record.
  -- Same applicator the record is attributed to (below): the completer when they're an
  -- applicator, else the job-header applicator (which may be NULL for wizard-dispatched
  -- jobs → both snapshot columns stay NULL, additive-safe).
  v_applicator_id := CASE WHEN is_applicator() THEN v_actor ELSE v_job.applicator_id END;
  IF v_applicator_id IS NOT NULL THEN
    SELECT pr.full_name, pr.applicator_license_number
      INTO v_applicator_name, v_applicator_license
      FROM profiles pr WHERE pr.id = v_applicator_id;
    -- Codex R1 P2: applicator_licenses is the CANONICAL license store for staff
    -- (the assignment gate + UI read it); profiles.applicator_license_number is
    -- not maintained by the current frontend. Prefer the newest active canonical
    -- license; keep the profiles value only as a fallback for shops that typed
    -- it there.
    SELECT COALESCE(
             (SELECT al.license_number
                FROM applicator_licenses al
               WHERE al.profile_id = v_applicator_id
                 AND al.is_active = true
               ORDER BY al.expiry_date DESC NULLS LAST
               LIMIT 1),
             v_applicator_license
           )
      INTO v_applicator_license;
  END IF;
  -- >>>N2-7 #106b

  INSERT INTO application_records (
    record_number, source_type, source_id,
    customer_id, applicator_id, field_id,
    application_date, product_data,
    total_acres, total_volume, total_volume_unit,
    vehicle_id, weather_conditions,
    notes, season, created_by,
    -- N2-7 #106b: legal-record applicator snapshot columns.
    applicator_name, applicator_license_number
  ) VALUES (
    v_record_number, 'job', p_job_id,
    v_job.customer_id,
    -- U12 (Codex R2 P1): attribute the legal application record to the person who
    -- ACTUALLY completed it when that person is an applicator — the new location-
    -- dispatch path means the completer may not be jobs.applicator_id (which can
    -- even be NULL for wizard-dispatched jobs). For the whole-job assignee this is
    -- the same value as before (v_actor = v_job.applicator_id); for office closes
    -- (admin/sales_rep) keep the job-header applicator exactly as today.
    -- N2-7: this is exactly v_applicator_id (computed above from the same CASE), so
    -- applicator_id is byte-identical to live; reusing the local keeps it in lockstep
    -- with the name/license snapshot.
    v_applicator_id,
    v_first_field_id,
    -- N2-7 #106a: actual application date (was v_job.job_date).
    v_application_date, v_product_data,
    v_job.total_acres,
    (p_applied_info->>'actual_gallons_applied')::numeric,
    'gallons',
    v_job.vehicle_id, v_weather, v_job.notes, v_job.season,
    p_performed_by,
    -- N2-7 #106b: applicator identity snapshot.
    v_applicator_name, v_applicator_license
  )
  RETURNING id INTO v_record_id;

  FOR v_jf IN
    SELECT jf.field_id,
           -- U12 addition: an optional per-field override from
           -- p_applied_info->'field_acres' = [{"field_id":uuid,"acres_applied":n}, ...].
           -- Falls through to the ORIGINAL chain when absent/no match — byte-identical
           -- to the pre-U12 behavior for every caller that doesn't pass it.
           COALESCE(
             (SELECT GREATEST(0, (elem->>'acres_applied')::numeric)
                FROM jsonb_array_elements(COALESCE(p_applied_info->'field_acres', '[]'::jsonb)) elem
               WHERE nullif(elem->>'field_id', '')::uuid = jf.field_id
               LIMIT 1),
             jf.acres_to_treat, f.total_acres, 0
           ) AS acres,
           COALESCE(jf.sort_order, 0)                    AS sort_order
      FROM job_fields jf
      JOIN fields f ON f.id = jf.field_id
     WHERE jf.job_id = p_job_id
     ORDER BY jf.sort_order, jf.id
  LOOP
    INSERT INTO application_record_fields (application_record_id, field_id, acres, sort_order)
    VALUES (v_record_id, v_jf.field_id, v_jf.acres, v_jf.sort_order);
    v_field_count := v_field_count + 1;
    v_acres_sum   := v_acres_sum + COALESCE(v_jf.acres, 0);
  END LOOP;

  -- U12 (Codex R2 P2): when the caller sent per-field applied-acres overrides,
  -- the record HEADER must reflect what was actually recorded, not the planned
  -- job total — reports read application_records.total_acres. Only corrected
  -- when 'field_acres' was provided: callers that omit it keep today's header
  -- value byte-for-byte (v_job.total_acres), preserving backward compatibility.
  IF p_applied_info ? 'field_acres' AND v_field_count > 0 THEN
    UPDATE application_records
       SET total_acres = v_acres_sum
     WHERE id = v_record_id;
  END IF;

  FOR v_chem IN
    SELECT jc.product_id, jc.quantity, jc.unit, p.inventory_unit AS inv_unit, p.product_form AS prod_form
      FROM job_chemicals jc
      JOIN products p ON p.id = jc.product_id
     -- U4<<< skip customer-supplied lines: they came from the grower, not our
     -- shed — no stock to deduct, no 'job_applied' inventory transaction. (#53/#54)
     WHERE jc.job_id = p_job_id AND jc.quantity > 0 AND jc.customer_supplied = false
     -- >>>U4
  LOOP
    -- U11<<< convert the rate-unit job-chem quantity to the product's inventory unit
    -- before deducting stock (a 16-pt line on a gallons-stocked product must remove 2
    -- gal, not 16). On an unconvertible / blank / unknown unit, DO NOT block the field
    -- job (a stuck applicator can't ship the day's work): fall back to the RAW quantity
    -- and flag the row for office review. This mirrors the hold engine EXACTLY —
    -- _sync_job_holds reserved COALESCE(field_app_priced_quantity(...), jc.quantity)
    -- inventory-units for this same line, so deducting the same fallback keeps the
    -- "reserved X → removed X" invariant intact (was: A6 hard RAISE JOB_INV_UNIT_UNCONVERTIBLE,
    -- which blocked completion of ANY job carrying an unconvertible unit).
    -- Codex P1: normalize FIRST — legacy rows may carry per-acre-suffixed units
    -- ('pt/ac'); the raw string NULLs out of the converter and would raw-deduct
    -- 16 "pt/ac" as 16 gal. normalize_rate_unit('pt/ac')='pt' → converts to 2 gal.
    -- (The hold engines share this normalization gap — queued as a follow-up;
    -- correcting the PHYSICAL deduction takes precedence over symmetry.)
    v_deduct_qty  := field_app_priced_quantity(v_chem.quantity, normalize_rate_unit(v_chem.unit), v_chem.inv_unit, v_chem.prod_form);
    v_unconverted := (v_deduct_qty IS NULL);
    IF v_unconverted THEN
      v_deduct_qty   := v_chem.quantity;      -- raw fallback, equals the reserved hold
      v_unconv_count := v_unconv_count + 1;
    END IF;
    -- >>>U11

    SELECT * INTO v_inv
      FROM inventory
     WHERE product_id = v_chem.product_id AND location = 'Main Warehouse'
     FOR UPDATE;
    v_inv_found := FOUND;

    v_new_avail  := COALESCE(v_inv.quantity_available, 0) - v_deduct_qty;
    v_short_flag := v_new_avail < 0;
    IF v_short_flag THEN
      v_short_count := v_short_count + 1;
    END IF;

    -- LAYER2<<< §3.5 fix: deduct physical stock ONLY. The parent quote's holds
    -- and prebooked are owned by A4's jobs lifecycle trigger (which already fired
    -- on the status='completed' update above). The removed "Phase 7" drain
    -- (v_hold_qty / v_decrement_pb / prebooked decrement / crop_program FIFO
    -- drain) double-reduced free stock for order-drawn planned quotes.
    IF NOT v_inv_found THEN
      INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, quantity_on_order)
      VALUES (v_chem.product_id, 'Main Warehouse', -v_deduct_qty, 0, 0);
    ELSE
      UPDATE inventory SET
        quantity_available = quantity_available - v_deduct_qty,
        updated_at         = now()
      WHERE product_id = v_chem.product_id AND location = 'Main Warehouse';
    END IF;
    -- >>>LAYER2

    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      performed_by, notes, job_id, requires_review
    ) VALUES (
      v_chem.product_id, 'job_applied', v_deduct_qty, 'Main Warehouse',
      p_performed_by,
      -- U11<<< recorded qty ALWAYS = what stock moved (converted, or raw fallback). Name
      -- the original line qty/unit when a conversion (or a raw fallback) happened, so the
      -- audit row is self-explaining and reconcilable (mirrors A5's link/audit-row lesson).
      'Job ' || v_job.job_number || ' completed — ' || v_deduct_qty || ' units applied' ||
        CASE
          WHEN v_unconverted
            THEN ' [UNIT NOT CONVERTIBLE — line ' || v_chem.quantity || ' ' || COALESCE(NULLIF(v_chem.unit, ''), '?')
                 || ' recorded raw vs inventory unit ' || COALESCE(NULLIF(v_chem.inv_unit, ''), '?') || '; review required]'
          WHEN lower(btrim(COALESCE(v_chem.unit, ''))) IS DISTINCT FROM lower(btrim(COALESCE(v_chem.inv_unit, '')))
            THEN ' (converted from ' || v_chem.quantity || ' ' || COALESCE(NULLIF(v_chem.unit, ''), '?') || ')'
          ELSE ''
        END ||
        CASE WHEN v_short_flag THEN ' [SHORT STOCK — review required]' ELSE '' END,
      p_job_id,
      (v_short_flag OR v_unconverted)
      -- >>>U11
    );
  END LOOP;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'job_completed',
    'Job ' || v_job.job_number || ' completed across ' || v_field_count || ' field(s). Application record: ' || v_record_number ||
      CASE WHEN v_short_count > 0
           THEN ' (⚠ ' || v_short_count || ' short-stock chemical(s) — review required)'
           ELSE '' END ||
      -- U11<<< surface raw-fallback lines to the office the same way short-stock is surfaced
      CASE WHEN v_unconv_count > 0
           THEN ' (⚠ ' || v_unconv_count || ' chemical(s) with non-convertible units — recorded raw, review required)'
           ELSE '' END,
      -- >>>U11
    p_performed_by, 'job', p_job_id, v_job.customer_id
  );

  v_result := jsonb_build_object(
    'success',                true,
    'job_id',                 p_job_id,
    'application_record_id',  v_record_id,
    'record_number',          v_record_number,
    'field_count',            v_field_count,
    'short_stock_count',      v_short_count
  );

  BEGIN
    SELECT (setting_value = 'true')
      INTO v_auto_draft_on
      FROM app_settings
     WHERE setting_key = 'auto_draft_invoice_on_job_completion';
    v_auto_draft_on := COALESCE(v_auto_draft_on, false);

    -- #117<<< make every skip visible. Previously: the flag-ON + non-office case
    -- (the #107 applicator gap) and the already-invoiced case both did NOTHING —
    -- silence indistinguishable from success. Now each writes an
    -- 'auto_draft_skipped' activity row. The POLICY (should applicator
    -- completions auto-draft?) is unchanged and stays an owner decision (#107).
    -- A non-admin's completion never drafts and always tells the admins, whether or not the
    -- auto-draft setting is on (CodeRabbit, PR #902): invoicing is admin-only.
    IF is_admin() THEN
      IF v_auto_draft_on THEN
        SELECT i.id INTO v_existing_invoice
          FROM invoices i
         WHERE i.job_id = p_job_id
           AND i.deleted_at IS NULL
           AND i.status NOT IN ('voided', 'cancelled')
         LIMIT 1;

        IF v_existing_invoice IS NULL THEN
          v_auto_draft_key := 'auto_draft_job:' || p_job_id::text;
          PERFORM transfer_job_to_invoice(p_job_id, p_performed_by, v_auto_draft_key);
        ELSE
          INSERT INTO activity_feed (
            event_type, description, performed_by,
            related_entity_type, related_entity_id, customer_id
          ) VALUES (
            'auto_draft_skipped',
            'Job ' || v_job.job_number || ' completed — automatic draft invoice skipped: '
              || 'an active invoice already exists for this job.',
            p_performed_by, 'job', p_job_id, v_job.customer_id
          );
        END IF;
      END IF;
    ELSE
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'auto_draft_skipped',
          'Job ' || v_job.job_number || ' completed by a non-admin — automatic draft '
            || 'invoice skipped (invoicing is admin-only). '
            || 'Bill this job manually.',
          p_performed_by, 'job', p_job_id, v_job.customer_id
        );
        INSERT INTO notifications (
          user_id, title, message, notification_type,
          related_entity_type, related_entity_id
        )
        SELECT p.id,
               'Job needs an invoice',
               'Job ' || v_job.job_number || ' was completed by a non-admin. Invoicing is admin-only, so no draft invoice was created — open the job and bill it.',
               'job_needs_invoice', 'job', p_job_id
          FROM profiles p
         WHERE p.role = 'admin' AND p.is_active = true;
    END IF;
    -- >>>#117
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      INSERT INTO activity_feed (
        event_type, description, performed_by,
        related_entity_type, related_entity_id, customer_id
      ) VALUES (
        'auto_draft_failed',
        'Job ' || v_job.job_number || ' completed, but the automatic draft invoice could '
          || 'not be created (needs attention — bill it manually). Reason: ' || SQLERRM,
        p_performed_by, 'job', p_job_id, v_job.customer_id
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'complete_job', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- =============================================================================================
-- 1h. Table layer (defence in depth: every app write goes through the RPCs above).
-- =============================================================================================
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.invoice_shares, public.invoice_line_allocations FROM authenticated, anon, PUBLIC;
REVOKE TRUNCATE ON public.invoice_line_shares, public.invoice_line_share_snapshots FROM authenticated, anon, PUBLIC;
-- Field-application invoice child rows and write-offs: their table grants let a sales rep write
-- them through the REST API (field_app_locations / _shares RLS allowed is_sales_rep() on any
-- invoice, draft or posted). Every writer is a postgres-owned SECURITY DEFINER function (read live
-- 2026-10-09: _save_field_app_invoice_impl_20260714, _save_field_app_split_invoice_impl,
-- apply_write_off, reverse_write_off) and src/ only reads these tables, so nothing legitimate
-- needs the grants.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.field_app_locations, public.field_app_location_shares, public.write_offs FROM authenticated, anon, PUBLIC;
REVOKE TRUNCATE ON public.field_app_billing_sets, public.field_app_billing_lines FROM authenticated, anon, PUBLIC;

DROP POLICY field_app_locations_insert ON public.field_app_locations;
CREATE POLICY field_app_locations_insert ON public.field_app_locations
  FOR INSERT TO public
  WITH CHECK (public.is_admin());

DROP POLICY field_app_locations_update ON public.field_app_locations;
CREATE POLICY field_app_locations_update ON public.field_app_locations
  FOR UPDATE TO public
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY field_app_locations_delete ON public.field_app_locations;
CREATE POLICY field_app_locations_delete ON public.field_app_locations
  FOR DELETE TO public
  USING (public.is_admin());

DROP POLICY field_app_location_shares_insert ON public.field_app_location_shares;
CREATE POLICY field_app_location_shares_insert ON public.field_app_location_shares
  FOR INSERT TO public
  WITH CHECK (public.is_admin());

DROP POLICY field_app_location_shares_update ON public.field_app_location_shares;
CREATE POLICY field_app_location_shares_update ON public.field_app_location_shares
  FOR UPDATE TO public
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY field_app_location_shares_delete ON public.field_app_location_shares;
CREATE POLICY field_app_location_shares_delete ON public.field_app_location_shares
  FOR DELETE TO public
  USING (public.is_admin());

DROP POLICY invoices_insert ON public.invoices;
CREATE POLICY invoices_insert ON public.invoices
  FOR INSERT TO public
  WITH CHECK (public.is_admin());

DROP POLICY invoice_items_insert ON public.invoice_items;
CREATE POLICY invoice_items_insert ON public.invoice_items
  FOR INSERT TO public
  WITH CHECK (public.is_admin());

DROP POLICY invoice_shares_insert ON public.invoice_shares;
CREATE POLICY invoice_shares_insert ON public.invoice_shares
  FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());

DROP POLICY invoice_line_alloc_insert ON public.invoice_line_allocations;
CREATE POLICY invoice_line_alloc_insert ON public.invoice_line_allocations
  FOR INSERT TO public
  WITH CHECK (public.is_admin());

-- =============================================================================================
-- Addendum 2. Read side (Mason 2026-10-09): sales reps read EVERY invoice and the child rows the
-- invoice list, detail, field-invoice and PDF views select. Drivers and other roles: unchanged.
-- =============================================================================================

-- invoices_select and invoice_items_select move from TO public to TO authenticated (review round
-- 2): their new is_sales_rep() leg is not executable by anon, so under TO public an anon read
-- would fail with "permission denied for function is_sales_rep" instead of returning no rows.
-- Under TO authenticated anon has no read policy here and reads no rows, exactly as before.
DROP POLICY invoices_select ON public.invoices;
CREATE POLICY invoices_select ON public.invoices
  FOR SELECT TO authenticated
  USING (public.is_admin() OR public.is_sales_rep() OR created_by = (SELECT auth.uid() AS uid) OR salesman_id = (SELECT auth.uid() AS uid));

DROP POLICY invoice_items_select ON public.invoice_items;
CREATE POLICY invoice_items_select ON public.invoice_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
      FROM public.invoices
     WHERE invoices.id = invoice_items.invoice_id
       AND (public.is_admin() OR public.is_sales_rep() OR invoices.created_by = (SELECT auth.uid() AS uid) OR invoices.salesman_id = (SELECT auth.uid() AS uid))
  ));

DROP POLICY invoice_shares_select ON public.invoice_shares;
CREATE POLICY invoice_shares_select ON public.invoice_shares
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
      FROM public.invoices i
     WHERE i.id = invoice_shares.invoice_id
       AND i.deleted_at IS NULL
       AND (public.is_admin() OR public.is_sales_rep() OR i.created_by = (SELECT auth.uid() AS uid) OR i.salesman_id = (SELECT auth.uid() AS uid))
  ));

DROP POLICY invoice_line_shares_select ON public.invoice_line_shares;
CREATE POLICY invoice_line_shares_select ON public.invoice_line_shares
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
     WHERE ii.id = invoice_line_shares.invoice_item_id
       AND i.deleted_at IS NULL
       AND (public.is_admin() OR public.is_sales_rep() OR i.created_by = (SELECT auth.uid() AS uid) OR i.salesman_id = (SELECT auth.uid() AS uid))
  ));

DROP POLICY invoice_line_share_snapshots_select ON public.invoice_line_share_snapshots;
CREATE POLICY invoice_line_share_snapshots_select ON public.invoice_line_share_snapshots
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1
      FROM public.invoices i
     WHERE i.id = invoice_line_share_snapshots.invoice_id
       AND i.deleted_at IS NULL
       AND (public.is_admin() OR public.is_sales_rep() OR i.created_by = (SELECT auth.uid() AS uid) OR i.salesman_id = (SELECT auth.uid() AS uid))
  ));

-- Split billing sets and their lines: a sales rep reads the ones linked to a non-deleted invoice
-- (every invoice, per Mason), not a set that no invoice uses (review round 2: the rep leg sits
-- inside the invoice EXISTS, exactly like the created_by / salesman_id legs).
DROP POLICY field_app_billing_sets_select ON public.field_app_billing_sets;
CREATE POLICY field_app_billing_sets_select ON public.field_app_billing_sets
  FOR SELECT TO authenticated
  USING (public.is_admin() OR EXISTS (
    SELECT 1
      FROM public.invoices i
     WHERE i.field_app_billing_set_id = field_app_billing_sets.id
       AND i.deleted_at IS NULL
       AND (public.is_sales_rep() OR i.created_by = (SELECT auth.uid() AS uid) OR i.salesman_id = (SELECT auth.uid() AS uid))
  ));

DROP POLICY field_app_billing_lines_select ON public.field_app_billing_lines;
CREATE POLICY field_app_billing_lines_select ON public.field_app_billing_lines
  FOR SELECT TO authenticated
  USING (public.is_admin() OR EXISTS (
    SELECT 1
      FROM public.invoices i
     WHERE i.field_app_billing_set_id = field_app_billing_lines.billing_set_id
       AND i.deleted_at IS NULL
       AND (public.is_sales_rep() OR i.created_by = (SELECT auth.uid() AS uid) OR i.salesman_id = (SELECT auth.uid() AS uid))
  ));

-- write_offs: the admin read policy stays as it is (its name says what it does); reps get a
-- second, read-only policy so the invoice detail can list an invoice's write-offs.
CREATE POLICY write_offs_select_sales_rep ON public.write_offs
  FOR SELECT TO authenticated
  USING (public.is_sales_rep());

-- =============================================================================================
-- Decision 2 (Mason 2026-10-10, "2:yes"): reps see CUSTOMER NAMES on invoices - names only, not
-- the customer record. The customers table and its policies are unchanged (pinned in the preflight
-- and the postflight): a rep's direct read still returns only the customers assigned to them.
-- This reader returns id + farm_name, nothing else, for the requested ids that a non-deleted
-- invoice names (as its customer, a customer share, a line share or a posted line-share snapshot),
-- and only to an active admin or an active sales rep (is_admin() / is_sales_rep() both require an
-- active profile); every other caller gets no rows. Read-only (STABLE, no writes, so no
-- idempotency key). Granted to authenticated only.
-- =============================================================================================
CREATE FUNCTION public.get_invoice_customer_names(p_customer_ids uuid[])
 RETURNS TABLE(id uuid, farm_name text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
  SELECT c.id, c.farm_name
    FROM public.customers c
   WHERE c.id = ANY (COALESCE(p_customer_ids, '{}'::uuid[]))
     AND (public.is_admin() OR public.is_sales_rep())
     AND (EXISTS (SELECT 1
                    FROM public.invoices i
                   WHERE i.customer_id = c.id
                     AND i.deleted_at IS NULL)
          OR EXISTS (SELECT 1
                       FROM public.invoice_shares s
                       JOIN public.invoices i ON i.id = s.invoice_id
                      WHERE s.customer_id = c.id
                        AND i.deleted_at IS NULL)
          OR EXISTS (SELECT 1
                       FROM public.invoice_line_shares ls
                       JOIN public.invoice_items ii ON ii.id = ls.invoice_item_id
                       JOIN public.invoices i ON i.id = ii.invoice_id
                      WHERE ls.customer_id = c.id
                        AND i.deleted_at IS NULL)
          OR EXISTS (SELECT 1
                       FROM public.invoice_line_share_snapshots sn
                       JOIN public.invoices i ON i.id = sn.invoice_id
                      WHERE sn.customer_id = c.id
                        AND i.deleted_at IS NULL))
   ORDER BY c.id;
$function$;

REVOKE ALL ON FUNCTION public.get_invoice_customer_names(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_invoice_customer_names(uuid[]) TO authenticated;
COMMENT ON FUNCTION public.get_invoice_customer_names(uuid[]) IS
  'Names-only customer read for invoice pages (Mason 2026-10-10): id + farm_name of customers a non-deleted invoice names; active admins and sales reps only, everyone else gets no rows.';

-- =============================================================================================
-- POSTFLIGHT: the exact reviewed result, or the whole apply rolls back.
-- =============================================================================================
DO $postflight$
DECLARE
  r record;
  v_oid oid;
  v_unclassified text;
BEGIN
  -- Each wrapper: one overload, the reviewed body, signature and result, definer + search_path,
  -- the original ACL; the guard (or, for the split wrapper, the key check then the guard) is its
  -- first statement. Each frozen implementation: the unchanged body, closed to everyone but postgres.
  FOR r IN SELECT * FROM (VALUES
    ('save_invoice', 'jsonb,jsonb,text', 'p_invoice jsonb, p_items jsonb DEFAULT ''[]''::jsonb, p_idempotency_key text DEFAULT NULL::text', 'uuid', '6af07de9a7581784231223a05ed90242', '_save_invoice_pre_admin_only_20261009', 'jsonb,jsonb,text', 'cb932dc51a680442affde5aeba2eaee3', 'guard'),
    ('save_field_app_invoice', 'uuid,jsonb,jsonb,jsonb,uuid,uuid,text', 'p_invoice_id uuid, p_invoice jsonb, p_locations jsonb, p_chemicals jsonb, p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '8ed99cd3e1afc941a87806b5f0c6e3b9', '_save_field_app_invoice_pre_admin_only_20261009', 'uuid,jsonb,jsonb,jsonb,uuid,uuid,text', '8700762576625bd06a833845d57ddbb6', 'guard'),
    ('save_field_app_split_invoice', 'uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text', 'p_billing_set_id uuid, p_source_job_id uuid, p_invoice jsonb, p_fields jsonb, p_lines jsonb, p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '631f17712d64ece012a373591269e5de', '_save_field_app_split_invoice_pre_admin_only_20261009', 'uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text', '82003fe2895aa1d7c7810559f4fb771a', 'guard'),
    ('create_invoice_from_order', 'uuid,uuid,text,text', 'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text', 'uuid', 'a8fc652aee43030cd72e8159e5174669', '_create_invoice_from_order_pre_admin_only_20261009', 'uuid,uuid,text,text', 'a1a91643bd8866823ae359f7e0ec290e', 'guard'),
    ('create_split_invoices_from_order', 'uuid,uuid,text,text', 'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text', 'uuid[]', '2076f3b50a430573a9661ca0388566ab', '_create_split_invoices_from_order_pre_admin_only_20261009', 'uuid,uuid,text,text', '398030fbb64006b4750e7e89a61b6cb9', 'key_then_guard'),
    ('create_invoice_from_blend_ticket', 'uuid,uuid,text', 'p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'a1d2c65c5ab7cf563439905b1733e48e', '_create_invoice_from_blend_ticket_pre_admin_only_20261009', 'uuid,uuid,text', 'c520a7301f88f3e96ed7bbc33101c4ef', 'guard'),
    ('transfer_job_to_invoice', 'uuid,uuid,text', 'p_job_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '8aabe711f2174d4a0f6be3d806bd2389', '_transfer_job_to_invoice_pre_admin_only_20261009', 'uuid,uuid,text', 'b083dd371b091d7b70bb4cdc015c9bc8', 'guard'),
    ('transfer_invoice_to_job', 'uuid,uuid,text', 'p_invoice_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'bf8109c7a0e12a89e0e7aafd8867864f', '_transfer_invoice_to_job_pre_admin_only_20261009', 'uuid,uuid,text', '7394bd0343c19e98bf746576a56bf6e4', 'guard'),
    ('consolidate_draft_invoices', 'uuid,uuid,text', 'p_order_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'b8a4dfc983776fd78632da1d43e7469d', '_consolidate_draft_invoices_pre_admin_only_20261009', 'uuid,uuid,text', '0c8394691ef461ba780fd4ba0e770c51', 'guard'),
    ('update_field_app_applied_info', 'uuid[],text,text,text,uuid,text,numeric,numeric,text,numeric,time without time zone,text,numeric,numeric,text,numeric,time without time zone,text,boolean,boolean,numeric,boolean', 'p_invoice_ids uuid[], p_wind_direction text DEFAULT NULL::text, p_temperature_text text DEFAULT NULL::text, p_applicator_name text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_start_temp_f numeric DEFAULT NULL::numeric, p_start_wind_mph numeric DEFAULT NULL::numeric, p_start_wind_direction text DEFAULT NULL::text, p_start_humidity_pct numeric DEFAULT NULL::numeric, p_start_weather_time time without time zone DEFAULT NULL::time without time zone, p_start_weather_source text DEFAULT NULL::text, p_end_temp_f numeric DEFAULT NULL::numeric, p_end_wind_mph numeric DEFAULT NULL::numeric, p_end_wind_direction text DEFAULT NULL::text, p_end_humidity_pct numeric DEFAULT NULL::numeric, p_end_weather_time time without time zone DEFAULT NULL::time without time zone, p_end_weather_source text DEFAULT NULL::text, p_weather_manual_override boolean DEFAULT NULL::boolean, p_update_weather boolean DEFAULT false, p_diluent_rate_gpa numeric DEFAULT NULL::numeric, p_update_diluent boolean DEFAULT false', 'jsonb', '5941af2185db68b79304dec3e91e3b1c', '_update_field_app_applied_info_pre_admin_only_20261009', 'uuid[],text,text,text,uuid,text,numeric,numeric,text,numeric,time without time zone,text,numeric,numeric,text,numeric,time without time zone,text,boolean,boolean,numeric,boolean', 'e6d5f41411e96cd4453d2209c846645d', 'guard'),
    ('update_field_app_invoice_billing', 'uuid[],text,text,text,date,text,text,jsonb,uuid,text', 'p_invoice_ids uuid[], p_purchase_order_ref text DEFAULT NULL::text, p_payment_terms text DEFAULT NULL::text, p_header_notes text DEFAULT NULL::text, p_due_date date DEFAULT NULL::date, p_footer_notes text DEFAULT NULL::text, p_internal_notes text DEFAULT NULL::text, p_discounts jsonb DEFAULT ''{}''::jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'b1d361da2cb271ee9fa71bd972339d92', '_update_field_app_invoice_billing_pre_admin_only_20261009', 'uuid[],text,text,text,date,text,text,jsonb,uuid,text', '34695e4be9724bf46dc5e962f8f0e478', 'guard'),
    ('post_invoice', 'uuid,text,text', 'p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text, p_expected_version text DEFAULT NULL::text', 'void', 'c7f467aac765b1d2f0cc897b27eca832', '_post_invoice_pre_admin_only_20261009', 'uuid,text', '6a5e3ab75bc63936f23eab85383ff6ad', 'guard'),
    ('post_invoice_group', 'uuid,uuid,text,text', 'p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text, p_expected_version text DEFAULT NULL::text', 'jsonb', '5f3917902a9a86810d48b6e6cadc5d76', '_post_invoice_group_pre_admin_only_20261009', 'uuid,uuid,text', 'd9e36f0dfb055e3cc68c18793e70dbfc', 'guard'),
    ('batch_post_invoices', 'uuid[],text,text', 'p_invoice_ids uuid[], p_idempotency_key text DEFAULT NULL::text, p_expected_version text DEFAULT NULL::text', 'jsonb', '23f5dde223ef83fb14281393bc8cdd3d', '_batch_post_invoices_pre_admin_only_20261009', 'uuid[],text', '482bd8cd15728ffc51f83900eaf89b3c', 'guard'),
    ('unpost_invoice', 'uuid,uuid,text', 'p_invoice_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '7f6bc25acd00ce5731dea00012fb8b82', '_unpost_invoice_pre_admin_only_20261009', 'uuid,uuid,text', '161f18c3ccd6126a6fb683c5160f82dc', 'guard'),
    ('unpost_invoice_group', 'uuid,uuid,text', 'p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '4d4fc94b5893849b1799329992075c8f', '_unpost_invoice_group_pre_admin_only_20261009', 'uuid,uuid,text', 'dc476e07621c4c7dc86595442ed1a9f0', 'guard'),
    ('batch_void_invoices', 'uuid[],text,uuid,text', 'p_invoice_ids uuid[], p_void_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'integer', '922e078236eb524367d54addec6c6d42', '_batch_void_invoices_pre_admin_only_20261009', 'uuid[],text,uuid,text', '32fa9718f29e18c8eff4539e36ac84b3', 'guard'),
    ('apply_credit_memo_to_invoice', 'uuid,uuid,bigint,uuid,text', 'p_credit_memo_id uuid, p_target_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'uuid', 'e98f494783df19014587a01614675191', '_apply_credit_memo_to_invoice_pre_admin_only_20261009', 'uuid,uuid,bigint,uuid,text', 'bcc242c8715aaed81b9455fbc905237f', 'guard'),
    ('reverse_credit_memo_application', 'uuid,text,uuid,text', 'p_application_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '19cec1a2c82c983e79d68f25b92deef2', '_reverse_credit_memo_application_pre_admin_only_20261009', 'uuid,text,uuid,text', '38cea043fc7dae4e65bc8593c95bddfb', 'guard'),
    ('apply_prepay_to_invoice', 'uuid,uuid,bigint,uuid,text', 'p_prepay_credit_id uuid, p_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'uuid', '6a653820c14a0b250fc13f1e0ca55678', '_apply_prepay_to_invoice_pre_admin_only_20261009', 'uuid,uuid,bigint,uuid,text', 'c9377dab8f2534a03af2c27a6e1d510c', 'guard'),
    ('batch_apply_all_prepayments', 'uuid,text', 'p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '532ca41ae42e4b0fabe026b3b1f59641', '_batch_apply_all_prepayments_pre_admin_only_20261009', 'uuid,text', '1d76228210c474da37c9a3cd91b97b7d', 'guard'),
    ('reverse_write_off', 'uuid,text,uuid,text', 'p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '619599f68aa5e6cfd9a339e831e2516f', '_reverse_write_off_pre_admin_only_20261009', 'uuid,text,uuid,text', '70ef11ccad193eb6ef5ee88dcba6f8cd', 'guard'),
    ('create_quick_delivery', 'uuid,jsonb,uuid,date,text,uuid,text,boolean', 'p_customer_id uuid, p_items jsonb, p_driver_id uuid DEFAULT NULL::uuid, p_scheduled_date date DEFAULT CURRENT_DATE, p_delivery_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_skip_invoice boolean DEFAULT false', 'jsonb', '1bf67e10cae538b5090b067aa3f665f5', '_create_quick_delivery_pre_admin_only_20261009', 'uuid,jsonb,uuid,date,text,uuid,text,boolean', '69c1d569fb2e9eb913502d59e41a76fe', 'coerce')
  ) AS t(name, ident, args, ret, md5, impl, impl_ident, impl_md5, shape) LOOP
    v_oid := to_regprocedure('public.' || r.name || '(' || r.ident || ')');
    IF v_oid IS NULL
       OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = r.name) <> 1
       OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
             AND NOT p.proisstrict AND NOT p.proretset
             AND format_type(p.prorettype, NULL) = r.ret
             AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
             AND pg_get_function_arguments(p.oid) = r.args
             AND md5(replace(p.prosrc, chr(13), '')) = r.md5
             AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                         FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
                 IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
             AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
            FROM pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'POSTFLIGHT_WRAPPER_CONTRACT: public.%(%) is not the reviewed wrapper', r.name, r.ident;
    END IF;
    -- A DECLARE section may only declare (name and type, no initializer, no call), so nothing
    -- runs before the guard.
    IF r.shape = 'guard' AND (SELECT prosrc FROM pg_proc WHERE oid = v_oid)
         !~ '^\s*(DECLARE(\s+(?![Bb][Ee][Gg][Ii][Nn]\M)\w+\s+[\w\[\]. %]+;)*\s+)?BEGIN\s+PERFORM public\._require_invoicing_admin\(\);' THEN
      RAISE EXCEPTION 'POSTFLIGHT_WRAPPER_CONTRACT: public.% must call _require_invoicing_admin() first', r.name;
    END IF;
    IF r.shape = 'key_then_guard' AND (SELECT prosrc FROM pg_proc WHERE oid = v_oid)
         !~ '^\s*BEGIN\s+IF p_idempotency_key IS NULL OR p_idempotency_key !~ ''\[\^\[:space:\]\]'' THEN\s+RAISE EXCEPTION ''IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order''\s+USING ERRCODE = ''22023'';\s+END IF;\s+PERFORM public\._require_invoicing_admin\(\);' THEN
      RAISE EXCEPTION 'POSTFLIGHT_WRAPPER_CONTRACT: public.% must require its key, then call _require_invoicing_admin(), before anything else', r.name;
    END IF;
    -- An exception handler could catch the guard's refusal and carry on (review round 2).
    IF r.shape IN ('guard', 'key_then_guard')
       AND regexp_replace((SELECT prosrc FROM pg_proc WHERE oid = v_oid), '/\*([^*]|\*+[^*/])*\*+/|--[^\n]*', '', 'g') ~* '\mexception\s+when\M' THEN
      RAISE EXCEPTION 'POSTFLIGHT_WRAPPER_CONTRACT: public.% must not catch exceptions (its guard''s refusal must end the call)', r.name;
    END IF;
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) = r.impl_md5 AND p.prosecdef
               AND p.proacl::text = '{postgres=X/postgres}'
          FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.impl || '(' || r.impl_ident || ')'))
       IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'POSTFLIGHT_IMPL_CONTRACT: public.% must keep its reviewed body and be closed to every role but postgres', r.impl;
    END IF;
  END LOOP;

  -- The helpers.
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) = '629609ce38f7c192abfde5be47848557' AND p.prosecdef AND p.proacl::text = '{postgres=X/postgres}'
             AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        FROM pg_proc p WHERE p.oid = to_regprocedure('public._require_invoicing_admin()')) IS DISTINCT FROM true
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) = 'd56454064dc8f78063a2afd2bada9697' AND p.prosecdef AND p.proacl::text = '{postgres=X/postgres}'
             AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp', 'TimeZone=UTC']::text[]
        FROM pg_proc p WHERE p.oid = to_regprocedure('public._invoice_review_fingerprint(uuid[])')) IS DISTINCT FROM true
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) = '55c7d613e474d5eb02431965ba0872a5' AND p.prosecdef
             AND p.proowner = 'postgres'::regrole
             AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
             AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                         FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
                 IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
             AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.get_invoice_post_version(uuid[])')) IS DISTINCT FROM true
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) = '6a7255f8760de8918bdd727a6d96d222' AND p.prosecdef
             AND p.proowner = 'postgres'::regrole
             AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
             AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                         FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
                 IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
             AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.get_invoice_group_post_version(uuid)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_HELPER_CONTRACT: the guard or a posting version helper is not the reviewed function';
  END IF;

  -- Decision 2: the names-only reader. One overload, the reviewed body, exactly (id, farm_name),
  -- read-only (STABLE), definer + pinned search_path, owned by postgres, executable by
  -- authenticated (and its owner) only; and the customers policies unchanged.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'get_invoice_customer_names') <> 1
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) = 'cd26c61c5150a4f4670a50c91657aec7' AND p.prosecdef
             AND p.proowner = 'postgres'::regrole AND p.provolatile = 's' AND p.proretset
             AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
             AND pg_get_function_result(p.oid) = 'TABLE(id uuid, farm_name text)'
             AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                         FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
                 IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres']::text[]
             AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
             AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.get_invoice_customer_names(uuid[])')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_CUSTOMER_NAMES_CONTRACT: get_invoice_customer_names is not the reviewed names-only reader';
  END IF;
  IF ARRAY(SELECT policyname::text FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customers' ORDER BY 1)
       IS DISTINCT FROM ARRAY['customers_delete', 'customers_insert', 'customers_select', 'customers_select_location_dispatchee', 'customers_update']::text[]
     OR (SELECT md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''))
           FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_select')
          IS DISTINCT FROM '4d86cb39838dc338ac722922bbb91b5f'
     OR (SELECT md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''))
           FROM pg_policies WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_select_location_dispatchee')
          IS DISTINCT FROM 'a4b57f89a3b63679c902d9bcf25ef25c' THEN
    RAISE EXCEPTION 'POSTFLIGHT_CUSTOMERS_POLICY: the customers read policies changed (Decision 2 exposes names through get_invoice_customer_names only)';
  END IF;

  -- The two re-emissions.
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) = 'b9b314f56adeba3a58ebe38a48d839b1' AND p.prosecdef AND p.proacl::text = '{postgres=X/postgres}'
             AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        FROM pg_proc p WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)'))
       IS DISTINCT FROM true
     OR (SELECT md5(replace(p.prosrc, chr(13), '')) = '726c96af2fa6d5709291cc3b77083745' AND p.prosecdef
             AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
             AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                         FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
                 IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.complete_job(uuid,jsonb,uuid,text)'))
       IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_REEMIT_CONTRACT: complete_delivery''s implementation or complete_job is not the reviewed body';
  END IF;

  -- Table privileges.
  -- invoices and invoice_items: authenticated and anon hold no write grant on live (read
  -- 2026-10-10); nothing here changes that, and the postflight now pins it (review round 2).
  IF has_table_privilege('authenticated', 'public.invoices', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.invoice_items', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.invoices', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.invoice_items', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.invoice_shares', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.invoice_line_allocations', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.invoice_shares', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.invoice_line_allocations', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.invoice_line_shares', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.invoice_line_share_snapshots', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.field_app_locations', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.field_app_location_shares', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.write_offs', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.field_app_locations', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.field_app_location_shares', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.write_offs', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('authenticated', 'public.field_app_billing_sets', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.field_app_billing_lines', 'TRUNCATE')
     -- Review round 4: anon (whose check includes PUBLIC's grants) holds no TRUNCATE on these four.
     OR has_table_privilege('anon', 'public.invoice_line_shares', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.invoice_line_share_snapshots', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.field_app_billing_sets', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.field_app_billing_lines', 'TRUNCATE')
     OR NOT has_table_privilege('authenticated', 'public.invoice_shares', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.invoice_line_allocations', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.field_app_locations', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.field_app_location_shares', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.write_offs', 'SELECT') THEN
    RAISE EXCEPTION 'POSTFLIGHT_TABLE_GRANTS: invoice child-table privileges are not the reviewed set';
  END IF;

  -- Policies: the server's deparsed text of each replaced policy, and the new write_offs one.
  FOR r IN SELECT * FROM (VALUES
    ('field_app_billing_sets', 'field_app_billing_sets_select', 'dd6e7c5a99b656ef6507081cdc03fbde'),
    ('field_app_billing_lines', 'field_app_billing_lines_select', 'f620450f72e8f20df057ee3a064d2f72'),
    ('invoice_items', 'invoice_items_insert', 'bd1972a06eea215895d9ecec861d5991'),
    ('invoice_items', 'invoice_items_select', '6ad37c59f4084df092b8f92b2cb5b55a'),
    ('invoice_line_allocations', 'invoice_line_alloc_insert', 'bd1972a06eea215895d9ecec861d5991'),
    ('invoice_line_share_snapshots', 'invoice_line_share_snapshots_select', '331e116056bab07ff8ad2cd6822b8422'),
    ('invoice_line_shares', 'invoice_line_shares_select', 'b815c6c25bfbb868be54b7c55539f700'),
    ('invoice_shares', 'invoice_shares_insert', 'd99642aa0333a7d54b96a4dac2a8821b'),
    ('invoice_shares', 'invoice_shares_select', 'a8ccec5b1069a7b20b51cafec4b87e3b'),
    ('invoices', 'invoices_insert', 'bd1972a06eea215895d9ecec861d5991'),
    ('invoices', 'invoices_select', 'a782d070f3d4f779cca9c6c8aa19b49a'),
    ('write_offs', 'write_offs_select_admin', '3a62ac9ae6afb0b8195d72a0b07a24da'),
    ('write_offs', 'write_offs_select_sales_rep', '1393b5e874366105fa053906dab34629'),
    ('field_app_locations', 'field_app_locations_insert', 'bd1972a06eea215895d9ecec861d5991'),
    ('field_app_locations', 'field_app_locations_update', 'd4f3167a940eee97d1cd03f0bc03df5f'),
    ('field_app_locations', 'field_app_locations_delete', 'e95dffee2933869bf3a622fe2ef0456a'),
    ('field_app_location_shares', 'field_app_location_shares_insert', 'bd1972a06eea215895d9ecec861d5991'),
    ('field_app_location_shares', 'field_app_location_shares_update', 'd4f3167a940eee97d1cd03f0bc03df5f'),
    ('field_app_location_shares', 'field_app_location_shares_delete', 'e95dffee2933869bf3a622fe2ef0456a')
  ) AS t(tbl, pol, pin) LOOP
    IF (SELECT md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''))
          FROM pg_policies WHERE schemaname = 'public' AND tablename = r.tbl AND policyname = r.pol)
       IS DISTINCT FROM r.pin THEN
      RAISE EXCEPTION 'POSTFLIGHT_POLICY_CONTRACT: %.% is not the reviewed policy', r.tbl, r.pol;
    END IF;
  END LOOP;

  -- HARD-GUARD catalog sweep. Every public function or procedure that authenticated can execute
  -- and that can reach (by name, comments stripped left to right) an INSERT, UPDATE, DELETE, MERGE
  -- or TRUNCATE (ONLY and quoted names included) on an invoice table, or an EXECUTE in a body
  -- that names an invoice table, must call _require_invoicing_admin() first (a DECLARE section
  -- before it may only declare: no initializer, no call; only create_split_invoices_from_order
  -- may check its key before it) with no exception handler anywhere in its body, or be a pinned
  -- already-admin-only function, or a pinned upkeep function. Anything else refuses the apply.
  -- scripts/smoke/smoke-invoicing-admin-only.sql step 8 runs this exact query text.
  WITH RECURSIVE fn AS (
    SELECT p.oid, p.proname, p.prosrc,
           regexp_replace(replace(p.prosrc, chr(13), ''), '/\*([^*]|\*+[^*/])*\*+/|--[^\n]*', '', 'g') AS body
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') AND p.prolang <> 13
  ), writer AS (
    SELECT oid FROM fn
     WHERE body ~* '\m(insert\s+into|update|delete\s+from|merge\s+into|truncate(\s+table)?)\s+(only\s+)?("?public"?\s*\.\s*)?"?(invoices|invoice_items|invoice_shares|invoice_line_shares|invoice_line_share_snapshots|invoice_line_allocations|field_app_locations|field_app_location_shares|field_app_billing_sets|field_app_billing_lines|write_offs)("|\M)'
        -- Dynamic SQL that names an invoice table anywhere (string literals included) counts as
        -- a write: the regex cannot see what EXECUTE runs (none on live, read 2026-10-10).
        OR (body ~* '\mexecute\M'
            AND body ~* '\m(invoices|invoice_items|invoice_shares|invoice_line_shares|invoice_line_share_snapshots|invoice_line_allocations|field_app_locations|field_app_location_shares|field_app_billing_sets|field_app_billing_lines|write_offs)\M')
  ), edge AS (
    SELECT a.oid AS caller, b.oid AS callee
      FROM fn a JOIN fn b ON a.oid <> b.oid AND a.body ~ ('\m' || b.proname || '\s*\(')
  ), reach AS (
    SELECT oid FROM writer
    UNION
    SELECT e.caller FROM edge e JOIN reach x ON x.oid = e.callee
  ), pinned AS (
    SELECT * FROM (VALUES
      ('void_invoice(uuid,text,text)', '2b1be1b706614f9a909581b0493d679f'),
      ('void_invoice_group(uuid,text,text)', 'fa19808b6ab6b0663663cd28c89a3326'),
      ('delete_invoices(uuid[],uuid,text)', '24c271164caa2369c57c3bdc5d88c50a'),
      ('create_invoice_for_unbilled_delivery(uuid,uuid,text)', 'a7f2531bd09ea6c650063f9661871caa'),
      ('generate_finance_charges(date,uuid,uuid[],text)', '56a397500167abf1b2801d22a31075dd'),
      ('issue_return_credit(uuid,uuid,text)', 'f3fcab7980d1640501fc038b0c8ac902'),
      ('unapply_credit_memo(uuid,text,uuid,text)', 'ba69e04e86dec86723d3ac9487f51272'),
      ('apply_write_off(uuid,bigint,text,uuid,text)', '00e8d020f9faf6276de8ddaf4f1411fc'),
      ('void_payment(uuid,text,uuid,text)', '70fd746c15f4a6629680a724f3588967'),
      ('apply_remaining_prepayments(uuid,uuid,text)', 'c0d7a2aef843ace0f557af2d096b090e'),
      ('batch_apply_prepayments(jsonb,uuid,text)', '15624992c9375e08a0ec1914437e6e40'),
      ('void_order(uuid,uuid,text,text)', 'bb220157f3cd56d28e9efe88dafba896'),
      ('cancel_order(uuid,uuid,text)', '501473a43b505df72bc803a7354b0e60'),
      ('void_delivery(uuid,text,uuid,text)', '3ef685c8f5bf778e3ae38aa2f89304da'),
      ('complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)', 'a1e9a043f27d3566f8ecf6d5e3a809ab'),
      ('process_offline_action(uuid,text)', '0461eebf65f23ccc8fe3852375eb9c78'),
      -- The upkeep allowlist (Mason-approved 2026-10-10, "1.a"): cancel_delivery,
      -- batch_cancel_deliveries, price_order, update_order_items and create_rush_order keep
      -- updating an admin's draft or unposted invoice; complete_delivery's resize and tote stamp
      -- is reached through its pinned entry above.
      ('cancel_delivery(uuid,text,uuid,text)', '8528b344f86c7e1aa735e386ea39f2eb'),
      ('batch_cancel_deliveries(uuid[],text,uuid,text)', '25d34db60f098a22a62db53780742eee'),
      ('price_order(uuid,jsonb,uuid,text)', 'ab2bcf3ac499cf78eef1f706d4e9501f'),
      ('update_order_items(uuid,jsonb,uuid,text)', 'e35fce6708edee32fb1876fa60d7da4b'),
      ('create_rush_order(uuid,jsonb,text,text,uuid,text)', '9027a97ab42a109f5e81188736f52f9c'),
      ('allocate_payment(uuid,bigint,text,text,text,date,text,jsonb,uuid,text)', '6a945a2510d8e788d4e6f03c0c6d7563'),
      ('complete_job(uuid,jsonb,uuid,text)', '726c96af2fa6d5709291cc3b77083745'),
      ('create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean)', '1bf67e10cae538b5090b067aa3f665f5')
    ) AS t(sig, md5)
  )
  SELECT string_agg(f.oid::regprocedure::text, ', ' ORDER BY f.oid::regprocedure::text) INTO v_unclassified
    FROM fn f JOIN reach x ON x.oid = f.oid
   WHERE has_function_privilege('authenticated', f.oid, 'EXECUTE')
     -- A body with an exception handler can catch the guard's refusal and still write, so a
     -- guard first does not count there (review round 2).
     AND (f.body ~* '\mexception\s+when\M' OR (true
     AND f.prosrc !~ '^\s*(DECLARE(\s+(?![Bb][Ee][Gg][Ii][Nn]\M)\w+\s+[\w\[\]. %]+;)*\s+)?BEGIN\s+PERFORM public\._require_invoicing_admin\(\);'
     AND NOT (f.proname = 'create_split_invoices_from_order'
              AND f.prosrc ~ '^\s*BEGIN\s+IF p_idempotency_key IS NULL OR p_idempotency_key !~ ''\[\^\[:space:\]\]'' THEN\s+RAISE EXCEPTION ''IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order''\s+USING ERRCODE = ''22023'';\s+END IF;\s+PERFORM public\._require_invoicing_admin\(\);')))
     AND NOT EXISTS (SELECT 1 FROM pinned pn
                      WHERE to_regprocedure('public.' || pn.sig) = f.oid
                        AND md5(replace(f.prosrc, chr(13), '')) = pn.md5);
  IF v_unclassified IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_UNGUARDED_INVOICE_WRITER: % can reach an invoice write without _require_invoicing_admin() and is not on a pinned list', v_unclassified;
  END IF;

  -- Triggers (review round 2): the sweep above follows calls by name only. No trigger whose
  -- function writes an invoice table may sit on a table authenticated can INSERT, UPDATE or
  -- DELETE (read live 2026-10-10: the only such trigger, trg_snapshot_line_shares_on_post, is on
  -- invoices, which authenticated cannot write).
  SELECT string_agg(t.tgname || ' on ' || t.tgrelid::regclass::text, ', ' ORDER BY t.tgname) INTO v_unclassified
    FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
   WHERE NOT t.tgisinternal
     AND (has_table_privilege('authenticated', t.tgrelid, 'INSERT')
          OR has_table_privilege('authenticated', t.tgrelid, 'UPDATE')
          OR has_table_privilege('authenticated', t.tgrelid, 'DELETE'))
     AND regexp_replace(replace(p.prosrc, chr(13), ''), '/\*([^*]|\*+[^*/])*\*+/|--[^\n]*', '', 'g')
         ~* '\m(insert\s+into|update|delete\s+from|merge\s+into|truncate(\s+table)?)\s+(only\s+)?("?public"?\s*\.\s*)?"?(invoices|invoice_items|invoice_shares|invoice_line_shares|invoice_line_share_snapshots|invoice_line_allocations|field_app_locations|field_app_location_shares|field_app_billing_sets|field_app_billing_lines|write_offs)("|\M)';
  IF v_unclassified IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_INVOICE_TRIGGER: % writes an invoice table from a table authenticated can write', v_unclassified;
  END IF;

  RAISE NOTICE 'POSTFLIGHT_OK: invoicing is admin-only';
END
$postflight$;

NOTIFY pgrst, 'reload schema';
