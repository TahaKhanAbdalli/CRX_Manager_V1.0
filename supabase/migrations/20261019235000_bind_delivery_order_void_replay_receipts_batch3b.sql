-- Written 2026-10-19. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: batch 3b of the system-wide idempotency replay-binding fix (KNOWN_ISSUES.md, "about 75 live
--   functions replay a saved result matched on the retry key alone"). The second cut of the HIGH
--   money group binds the three reversals of a delivery or order:
--     cancel_delivery  (admin/rep cancels a scheduled, in-progress or completed delivery: stock is
--                       restored, the order reopens or a quick order auto-cancels with its
--                       commissions, the delivery's draft invoices are cancelled)
--     void_delivery    (admin voids a completed delivery: stock restored, order status recomputed,
--                       the delivery's draft invoices cancelled)
--     void_order       (admin voids a fulfilled order: stock and booking draws restored,
--                       commissions cancelled, draft invoices cancelled)
--   Each replays a stored receipt matched on the retry key alone, so a retry that reuses a key for a
--   DIFFERENT delivery/order, or with an edited reason, gets the first call's "done" answer and the
--   new request is never carried out (a false success; nothing is ever done twice). DeliveryDetail.tsx
--   and OrderDetail.tsx documented the reachable cases ("F1 DELIBERATELY NOT FIXED HERE"): the reason
--   is free text the user can edit before retrying, and void_order's key had no record scope.
--   cancel_delivery also replayed BEFORE its role check.
--
--   The fix is batch 1's pattern (20261016060000), reusing its live helpers: each live body is
--   RENAMED unchanged to _<name>_replay_impl_20261015 (no API role may call it), and a public wrapper
--   with the identical signature, defaults, return type, owner, search_path and grants takes its
--   place. With a key, the wrapper
--     1. requires auth.uid(), refuses a p_performed_by naming someone else, and checks the caller's
--        role, each with the same test and message its renamed body uses (cancel_delivery:
--        'authentication required' / 'actor mismatch' / 'Not authorized to cancel deliveries';
--        void_delivery: AUTH_REQUIRED / ACTOR_MISMATCH / 'Admin access required to void a completed
--        delivery'; void_order: AUTH_REQUIRED / ACTOR_MISMATCH / INSUFFICIENT_ROLE). So no stored
--        result is ever returned before the role check (cancel_delivery's old order);
--     2. computes a SHA-256 fingerprint of the actor, the target id and the reason;
--     3. calls check_idempotency_intent(key, op, auth.uid(), fingerprint), which takes the per-key
--        advisory lock (crx:idempotency:<key>). No receipt: run the body. Exact actor + intent
--        match: run the body, which replays its own stored answer exactly as before. Anything else
--        is refused with IDEMPOTENCY_ACTOR_MISMATCH or IDEMPOTENCY_INTENT_MISMATCH, which the app
--        maps to plain English (src/lib/idempotency.ts getIdempotencyBindingRejection,
--        src/lib/errorSanitizer.ts);
--     4. after a fresh run, stamps request_actor_id and request_fingerprint onto the receipt the body
--        just wrote (_bind_replay_receipt_20261015), and refuses (rolls the call back) if the body
--        wrote none. Every body writes a receipt on every fresh keyed success (read live 2026-10-19:
--        cancel_delivery and void_delivery by save_idempotency at their end; void_order through
--        _void_order_impl_20260714's save_idempotency at its end), and none returns early without one.
--   A key is REQUIRED from callers (IDEMPOTENCY_KEY_REQUIRED, 22023), as in batches 1, 2 and 3a: a
--   keyless call would run with no receipt, so a lost-response retry could repeat the reversal's
--   notifications and audit rows. Every app caller already sends one: DeliveryDetail (cancel, void),
--   OrderDetail (void). The offline queue's cancel_delivery branch (src/lib/offlineSync.ts) forwards
--   whatever params were queued, but no screen enqueues a cancel_delivery today; one queued without
--   a key would be refused (see KNOWN LIMITS).
--
--   The one internal keyless caller: batch_cancel_deliveries' private body
--   (_batch_cancel_deliveries_replay_impl_20261015, batch 2) calls cancel_delivery once per delivery
--   with NO key. It is recreated below from its pinned live body with that one call retargeted to
--   _cancel_delivery_replay_impl_20261015 (the renamed body, same arguments), as batch 2 did for
--   revert_quote_status. So a batch cancel behaves exactly as before: same checks, same per-delivery
--   work, no per-delivery receipt; batch_cancel_deliveries' own wrapper still binds the batch receipt.
--
--   Why a body's own key-only lookup cannot return ANOTHER operation's receipt on an exact match:
--   idempotency_keys has a UNIQUE index on idempotency_key, so a key has at most one row, and
--   check_idempotency_intent has already refused it (IDEMPOTENCY_CROSS_OP_KEY_REUSE) unless that row
--   is this operation's, under the lock.
--
--   SIDE DOOR CLOSED: _void_order_impl_20260714 (void_order's inner body, with its own key-only
--   replay) was executable by service_role as well as postgres (read live 2026-10-19). Nothing in
--   the app, the edge functions or the scripts calls it; it loses service_role EXECUTE here, so the
--   wrapper is the only way in, as for complete_delivery's private chain in batch 3a.
--
--   COMMIT-TIME GUARD: batch 1's deferred constraint trigger require_bound_replay_receipt_20261015
--   now also covers cancel_delivery, void_delivery and void_order. A trigger's WHEN clause cannot be
--   altered, so the trigger is dropped and recreated with the same name, function and timing, inside
--   this transaction under its ACCESS EXCLUSIVE lock on idempotency_keys (no gap is visible). No
--   second trigger is created. Only the live batch 1 + 2 + 3a trigger (24 operations, read live
--   2026-10-19) is accepted; any other definition refuses the apply (PREFLIGHT_RECEIPT_GUARD_DRIFT),
--   and the result covers 27.
--
-- ONE BEHAVIOR FIX (Codex review on this batch, HIGH): void_order could not void a fulfilled order
--   that still had a nonzero draft invoice. Its inner body sets the order 'voided' and then cancels
--   the draft with status alone, which guard_invoice_terminal_order refuses on a voided order unless
--   the draft's money fields are zero (ORDER_INVOICE_TERMINAL, whole call rolled back; 6 live
--   fulfilled orders had such a draft on 2026-10-19, and no order has ever been voided live).
--   Section 3b makes the same edit cancel_order's body already has: that one UPDATE also zeroes total,
--   paid, prepay and write-off cents. Sol review on this batch (HIGH, two rounds): zeroing must never
--   erase money recorded on a draft, even by a write that lands while the void runs, so the UPDATE
--   itself matches only a draft whose paid, prepay, write-off and credit cents are all zero, and the
--   branch refuses (ORDER_VOID_DRAFT_HAS_APPLIED_MONEY, whole call rolled back) when it updates no
--   row (live had none of 9 drafts with such amounts on 2026-10-20). Written out in full: the
--   md5-pinned live body plus only those three edits.
--
-- WHAT DOES NOT CHANGE: apart from those three draft-branch edits, no money, stock, commission or invoice logic is
--   retyped (the three bodies are renamed, pinned by md5 below); no table, row,
--   policy or receipt changes; every keyed legitimate call (first call, exact retry) returns what it
--   returns today. A keyless call to the three public names is now refused (IDEMPOTENCY_KEY_REQUIRED).
--   Checks that now run before the renamed bodies: the key requirement, the auth/actor/role tests
--   (same messages), and the actor/intent binding. A DIFFERENT user retrying someone else's key is
--   refused by the binding (IDEMPOTENCY_ACTOR_MISMATCH), which shows them nothing:
--   check_idempotency_intent discloses a stored result only to the same actor.
--
-- RECEIPT DISCLOSURE: as batch 1. The preflight refuses to apply while any unexpired receipt exists
--   for the three operations (none existed at all when read live on 2026-10-19) and the commit-time
--   guard keeps an unbound one from ever committing.
--
-- ACCESS: this file narrows access, so it applies only on Mason's owner approval
--   (scripts/owner-approve-migration.mjs): the three renamed bodies lose EXECUTE,
--   _void_order_impl_20260714 loses service_role, and a keyless call is refused. It widens nothing.
--
-- NOT IN THIS BATCH: the rest of the HIGH money group (unpost_invoice, transfer_invoice_to_job,
--   price_order, update_order_items, save_field_app_invoice, update_field_app_invoice_billing,
--   transition_rebate_claim, create_rebate_claim, close_accounting_period,
--   apply_credit_memo_to_invoice's after-lock recheck, record_job_pre/post_notifications) and the
--   MED/LOW group. save_field_app_invoice is also changed by PR #965 (20261019230000, not applied).
--
-- OVERLOADS: each of the three has exactly one overload (read-only on live 2026-10-19); the preflight
--   refuses a second one and the postflight proves exactly one wrapper and one body per name.
--
-- ROLLBACK (if ever needed, as its own reviewed migration), in this order: FIRST recreate
--   require_bound_replay_receipt_20261015 without the three operations (left covering them, it would
--   refuse every receipt the restored old bodies write, rolling back their reversals); restore
--   _batch_cancel_deliveries_replay_impl_20261015's previous body (it calls the public
--   cancel_delivery); then, for each name, DROP the wrapper, ALTER FUNCTION
--   public._<name>_replay_impl_20261015(...) RENAME TO <name>, and restore its grants (EXECUTE to
--   authenticated, service_role); optionally re-grant service_role on _void_order_impl_20260714.
--   The void_order draft-cancel fix (3b) should stay: reverting it only restores the failure.
--
-- KNOWN LIMITS (each fails safe, nothing wrong is committed):
--   * The binding runs before the body's record checks, so a caller who retries THEIR OWN key with an
--     edited request inside 24 hours sees their own earlier result in the refusal DETAIL (batch 1 has
--     the same shape; another user never sees it).
--   * A legacy offline-queued cancel_delivery without a key (none can be produced today) is refused
--     with IDEMPOTENCY_KEY_REQUIRED and stays in the queue's error path with nothing committed.
--
-- ORDERING: strict. Live high-water when written: ledger 20261019205246 (20261019200000, batch 3a).
--   Numbered above the two open, unapplied candidates 20261019220000 (PR #964) and 20261019230000
--   (PR #965), neither of which touches these functions or the guard trigger. Re-read the live
--   ledger before applying.
--
-- idempotency-body-check: exempt. Every wrapper reads idempotency_keys through
--   check_idempotency_intent with its own operation literal and writes it through
--   _bind_replay_receipt_20261015; the renamed bodies keep their own operation-scoped lookups.
--
-- Grants. Every REVOKE below is either (a) on a RENAMED body, which no caller names any more, (b) the
-- routine "FROM PUBLIC, anon" on a freshly created wrapper that is then granted to authenticated and
-- service_role, which is exactly the live ACL of the function it replaces, or (c) service_role on
-- _void_order_impl_20260714, which only the void_order body calls. The app keeps calling the same
-- names with the same arguments and reaches the wrappers:
-- caller-analysis: cancel_delivery :: src/pages/DeliveryDetail.tsx and src/lib/offlineSync.ts call the same name and signature with a key; _batch_cancel_deliveries_replay_impl_20261015 (postgres-owned definer) now calls the renamed body directly; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: void_delivery :: src/pages/DeliveryDetail.tsx calls the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: void_order :: src/pages/OrderDetail.tsx calls the same name and signature with a key; no database function calls it; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: _void_order_impl_20260714 :: called only by the void_order body (now _void_order_replay_impl_20261015, postgres-owned definer); no app, edge-function or script caller; service_role loses EXECUTE, postgres keeps it
-- caller-analysis: _batch_cancel_deliveries_replay_impl_20261015 :: recreated in place (CREATE OR REPLACE keeps its postgres-only EXECUTE); called only by the batch_cancel_deliveries wrapper

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE delivery_order_void_replay_binding_batch3b_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

-- The operations the commit-time guard covers once this file is applied, in trigger order, recorded
-- by the guard step below and read back by the postflight.
CREATE TEMP TABLE delivery_order_void_replay_binding_batch3b_guard_ops (
  ord integer PRIMARY KEY,
  operation text NOT NULL UNIQUE
) ON COMMIT DROP;

DO $preflight$
DECLARE
  v_drift text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.delivery_order_void_replay_binding_batch3b_tx') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ORDER_VOID_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.delivery_order_void_replay_binding_batch3b_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'DELIVERY_ORDER_VOID_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- The three bodies, exactly as reviewed live on 2026-10-19 (md5 ignores carriage returns), each the
  -- only overload of its name, with the live owner, attributes and grants, and no renamed copy yet.
  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_drift
    FROM (VALUES
      ('cancel_delivery', 'p_delivery_id uuid, p_cancel_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '8528b344f86c7e1aa735e386ea39f2eb'),
      ('void_delivery', 'p_delivery_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '3ef685c8f5bf778e3ae38aa2f89304da'),
      ('void_order', 'p_order_id uuid, p_performed_by uuid, p_reason text DEFAULT ''Voided by admin''::text, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'bb220157f3cd56d28e9efe88dafba896')
    ) AS pin(name, args, ret, body_md5)
   WHERE (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = pin.name) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = pin.name
           AND p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
           AND NOT p.proisstrict AND NOT p.proretset AND p.prokind = 'f'
           AND p.prorettype = pin.ret::regtype
           AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
           AND pg_get_function_arguments(p.oid) = pin.args
           AND md5(replace(p.prosrc, chr(13), '')) = pin.body_md5
           AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                       FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
               IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[])
      OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = '_' || pin.name || '_replay_impl_20261015');
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DELIVERY_ORDER_VOID_REPLAY_BODY_DRIFT: expected the exact reviewed live body (and no renamed copy yet) for: %', v_drift;
  END IF;

  -- void_order's inner body (reviewed live 2026-10-19): one overload, postgres-owned definer, its
  -- reviewed body, callable by postgres and service_role (service_role is revoked below).
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_void_order_impl_20260714') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = '_void_order_impl_20260714'
          AND p.proowner = 'postgres'::regrole AND p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND pg_get_function_identity_arguments(p.oid) = 'p_order_id uuid, p_performed_by uuid, p_reason text, p_idempotency_key text'
          AND md5(replace(p.prosrc, chr(13), '')) = 'a0a9151160a6f2b58624b30435322b94'
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['postgres', 'service_role']::text[]) THEN
    RAISE EXCEPTION 'PREFLIGHT_VOID_ORDER_IMPL_DRIFT: _void_order_impl_20260714 differs from its reviewed body or ACL';
  END IF;

  -- The one internal keyless caller of cancel_delivery: batch 2's private batch-cancel body, exactly
  -- as reviewed live (it is recreated below with that one call retargeted).
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_batch_cancel_deliveries_replay_impl_20261015') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = '_batch_cancel_deliveries_replay_impl_20261015'
          AND p.proowner = 'postgres'::regrole AND p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND pg_get_function_arguments(p.oid) = 'p_delivery_ids uuid[], p_cancel_reason text DEFAULT ''Batch cancelled''::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text'
          AND md5(replace(p.prosrc, chr(13), '')) = '25d34db60f098a22a62db53780742eee'
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['postgres']::text[]) THEN
    RAISE EXCEPTION 'PREFLIGHT_BATCH_CANCEL_DRIFT: _batch_cancel_deliveries_replay_impl_20261015 differs from its reviewed body (it calls cancel_delivery with no key)';
  END IF;

  -- No other database function, in ANY schema, and no pg_cron job may call the three by name (read
  -- live 2026-10-19: only the batch-cancel body above, which is retargeted below; no cron job). The
  -- match ignores case and allows a quoted or schema-qualified name. A new caller would be refused
  -- for a missing key. Limit: a name assembled at run time in dynamic SQL cannot be seen here; such
  -- a caller would fail closed (IDEMPOTENCY_KEY_REQUIRED, nothing committed).
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname) INTO v_drift
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND NOT (n.nspname = 'public'
              AND p.proname IN ('cancel_delivery', 'void_delivery', 'void_order', '_batch_cancel_deliveries_replay_impl_20261015'))
     AND p.prosrc ~* '(^|[^_a-z0-9])(cancel_delivery|void_delivery|void_order)"?\s*\(';
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: these functions call cancel_delivery, void_delivery or void_order and were not reviewed: %', v_drift;
  END IF;
  -- _void_order_impl_20260714 loses service_role below: only void_order's body may call it (read live
  -- 2026-10-19: no other function in any schema, no cron job).
  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY n.nspname, p.proname) INTO v_drift
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND NOT (n.nspname = 'public' AND p.proname IN ('void_order', '_void_order_impl_20260714'))
     AND p.prosrc ~* '_void_order_impl_20260714';
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: these functions call _void_order_impl_20260714 and were not reviewed: %', v_drift;
  END IF;
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $cron$SELECT string_agg(jobname, ', ' ORDER BY jobname) FROM cron.job
                  WHERE command ~* '(cancel_delivery|void_delivery|void_order)'$cron$ INTO v_drift;
    IF v_drift IS NOT NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_UNREVIEWED_INTERNAL_CALLER: these pg_cron jobs call cancel_delivery, void_delivery or void_order and were not reviewed: %', v_drift;
    END IF;
  END IF;

  -- What the wrappers rely on: the intent check as installed by 20260811130000 (pinned), the two
  -- binding columns, auth.uid() (pinned), and batch 1's live helpers (pinned).
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'check_idempotency_intent') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'check_idempotency_intent'
          AND pg_get_function_identity_arguments(p.oid) = 'p_key text, p_operation text, p_actor uuid, p_fingerprint text'
          AND md5(replace(p.prosrc, chr(13), '')) = 'edc73be809069669e8441eba7acf443d') THEN
    RAISE EXCEPTION 'PREFLIGHT_INTENT_CHECK_DRIFT: check_idempotency_intent differs from its reviewed body';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = 'public.idempotency_keys'::regclass AND NOT a.attisdropped
         AND ((a.attname = 'request_actor_id' AND a.atttypid = 'uuid'::regtype)
           OR (a.attname = 'request_fingerprint' AND a.atttypid = 'text'::regtype))) <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT_RECEIPT_COLUMNS_DRIFT: idempotency_keys.request_actor_id (uuid) and request_fingerprint (text) are required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('auth.uid()')
       AND NOT p.prosecdef
       AND md5(replace(p.prosrc, chr(13), '')) = 'cdef18c69c4f4cbbced2eaf81e628b49') THEN
    RAISE EXCEPTION 'PREFLIGHT_AUTH_UID_DRIFT: auth.uid() is missing or differs from its reviewed live body';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public._replay_fingerprint_20261015(jsonb)', '68d5c0c62579349ced47c89e6b65ccaf', false),
      ('public._bind_replay_receipt_20261015(text,text,text)', '722ddd3b5d9174c598735cb321088f73', false),
      ('public._require_bound_replay_receipt_20261015()', '5c0478525131ddbeb7b96ef1535ff91e', true)
    ) AS h(sig, body_md5, secdef)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_proc p
        WHERE p.oid = to_regprocedure(h.sig)
          AND p.proowner = 'postgres'::regrole AND p.prosecdef = h.secdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND md5(replace(p.prosrc, chr(13), '')) = h.body_md5
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['postgres']::text[])
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_BATCH1_HELPER_DRIFT: the batch-1 replay-binding helpers differ from their reviewed live bodies or ACLs';
  END IF;

  -- Cutover: a receipt written by an old body carries no binding, and the intent check refuses it.
  -- So apply only while no unexpired receipt exists for the three operations; this transaction's
  -- ACCESS EXCLUSIVE lock keeps a new one from appearing before the guard covers them.
  LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys k
              WHERE k.operation IN ('cancel_delivery', 'void_delivery', 'void_order')
                AND (k.expires_at IS NULL OR k.expires_at >= now())) THEN
    RAISE EXCEPTION 'PREFLIGHT_UNEXPIRED_RECEIPTS: an unexpired cancel_delivery, void_delivery or void_order receipt exists; wait for it to expire (24 hours) and apply again';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- The commit-time guard now covers the three operations too (same trigger, same function), keeping
-- every operation it already covers. Only the live batch-1+2+3a state is accepted.
-- ---------------------------------------------------------------------------------------------
DO $guard$
DECLARE
  v_prior constant text[] := ARRAY[
    'void_payment', 'delete_prepay_credit', 'edit_prepay_credit', 'apply_write_off',
    'reverse_write_off', 'apply_prepay_to_invoice', 'create_prepay_check_splits',
    'batch_apply_prepayments', 'batch_void_invoices',
    'release_inventory_hold', 'retire_inventory_item', 'reconcile_negative_inventory',
    'manual_inventory_add', 'create_order_from_blend_ticket', 'create_direct_order',
    'create_rush_order', 'close_quote_as_applied', 'close_quote_as_short',
    'create_app_record_from_bt', 'batch_cancel_deliveries', 'reverse_completed_cycle_count',
    'create_planned_holds',
    'complete_delivery', 'complete_job'];
  v_batch3b constant text[] := ARRAY['cancel_delivery', 'void_delivery', 'void_order'];
  v_ops text[];
  v_def text;
  v_count integer;
BEGIN
  SELECT count(*), max(pg_get_triggerdef(t.oid)) INTO v_count, v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.idempotency_keys'::regclass
     AND t.tgname = 'require_bound_replay_receipt_20261015'
     AND t.tgfoid = to_regprocedure('public._require_bound_replay_receipt_20261015()')
     AND t.tgenabled = 'O' AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred;
  -- No other trigger may run the guard function (the recreated trigger must stay the only one).
  IF v_count <> 1
     OR (SELECT count(*) FROM pg_trigger t
          WHERE t.tgfoid = to_regprocedure('public._require_bound_replay_receipt_20261015()')) <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_RECEIPT_GUARD_DRIFT: expected exactly one enabled deferred require_bound_replay_receipt_20261015 trigger';
  END IF;

  -- Batches 1, 2 and 3a are live (ledger 20261019205246): only their 24-operation trigger is accepted.
  IF v_def = 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
            || (SELECT string_agg(quote_literal(o) || '::text', ', ' ORDER BY ord) FROM unnest(v_prior) WITH ORDINALITY AS u(o, ord))
            || ']))) EXECUTE FUNCTION _require_bound_replay_receipt_20261015()' THEN
    v_ops := v_prior || v_batch3b;
  ELSE
    RAISE EXCEPTION 'PREFLIGHT_RECEIPT_GUARD_DRIFT: require_bound_replay_receipt_20261015 is not the batch-1+2+3a trigger: %', v_def;
  END IF;

  INSERT INTO pg_temp.delivery_order_void_replay_binding_batch3b_guard_ops (ord, operation)
  SELECT u.ord, u.o FROM unnest(v_ops) WITH ORDINALITY AS u(o, ord);

  -- Same name, function and timing; only the covered list grows. Every element is a fixed literal
  -- from this block, quoted with quote_literal.
  DROP TRIGGER require_bound_replay_receipt_20261015 ON public.idempotency_keys;
  EXECUTE format(
    'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 '
    || 'AFTER INSERT OR UPDATE ON public.idempotency_keys '
    || 'DEFERRABLE INITIALLY DEFERRED '
    || 'FOR EACH ROW '
    || 'WHEN (NEW.operation IN (%s)) '
    || 'EXECUTE FUNCTION public._require_bound_replay_receipt_20261015()',
    (SELECT string_agg(quote_literal(o), ', ' ORDER BY ord) FROM unnest(v_ops) WITH ORDINALITY AS u(o, ord)));
END
$guard$;

-- ---------------------------------------------------------------------------------------------
-- 1. cancel_delivery (also called, keyless, by batch_cancel_deliveries' private body: see 4.)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.cancel_delivery(uuid, text, uuid, text) RENAME TO _cancel_delivery_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._cancel_delivery_replay_impl_20261015(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.cancel_delivery(
  p_delivery_id uuid,
  p_cancel_reason text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: cancel_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- Same tests and messages as the renamed body; the role check now runs before any replay.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_performed_by IS NOT NULL AND v_actor IS DISTINCT FROM p_performed_by THEN RAISE EXCEPTION 'actor mismatch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized to cancel deliveries';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'delivery_id', p_delivery_id,
    'cancel_reason', p_cancel_reason
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'cancel_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._cancel_delivery_replay_impl_20261015(p_delivery_id, p_cancel_reason, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'cancel_delivery', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.cancel_delivery(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_delivery(uuid, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. void_delivery
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.void_delivery(uuid, text, uuid, text) RENAME TO _void_delivery_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._void_delivery_replay_impl_20261015(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.void_delivery(
  p_delivery_id uuid,
  p_reason text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: void_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- Same tests and messages as the renamed body (which also checks them before its replay).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admin access required to void a completed delivery';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'delivery_id', p_delivery_id,
    'reason', p_reason
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'void_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._void_delivery_replay_impl_20261015(p_delivery_id, p_reason, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'void_delivery', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.void_delivery(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_delivery(uuid, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. void_order (its renamed body still delegates to _void_order_impl_20260714)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.void_order(uuid, uuid, text, text) RENAME TO _void_order_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._void_order_replay_impl_20261015(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._void_order_impl_20260714(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.void_order(
  p_order_id uuid,
  p_performed_by uuid,
  p_reason text DEFAULT 'Voided by admin'::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: void_order requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- Same tests and messages as the renamed body (which also checks them before its replay).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'order_id', p_order_id,
    'reason', p_reason
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'void_order', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._void_order_replay_impl_20261015(p_order_id, p_performed_by, p_reason, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'void_order', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.void_order(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_order(uuid, uuid, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3b. void_order's inner body cancels a draft invoice the way cancel_order does.
--     Its live body (pinned above) sets the order 'voided' and THEN cancels the order's draft
--     invoices with status alone. guard_invoice_terminal_order lets a draft on a voided order become
--     'cancelled' only when its money fields are zero (its canonical cancel cleanup), so voiding any
--     fulfilled order with a nonzero draft invoice failed with ORDER_INVOICE_TERMINAL and rolled
--     back (6 live fulfilled orders had one, read 2026-10-19; no order has ever been voided live).
--     cancel_order's body zeroes total, paid, prepay and write-off cents in the same UPDATE. This
--     makes the one same edit here, to the pinned live body (written out below), and the postflight proves nothing
--     else in it changed. A never-posted draft has no financial impact (the body's own comment);
--     the audit row above it still records the draft's original total. The zeroing is only safe on a
--     draft with no money recorded against it, so the UPDATE's own WHERE requires paid, prepay,
--     write-off and credit cents to be zero on the row it writes (a concurrent write that records
--     money is seen there, after its row lock), and the branch refuses with
--     ORDER_VOID_DRAFT_HAS_APPLIED_MONEY when no row was updated. Before this batch such a void also
--     rolled back, so a recorded amount is never erased.
-- ---------------------------------------------------------------------------------------------
-- The full body is written out (the pinned live body, md5 a0a9151160a6f2b58624b30435322b94 checked in
-- the preflight, plus only the zeroing lines, the zero-money WHERE and the no-row refusal) so every
-- migration scanner reads it. The postflight re-checks that removing those three edits gives back
-- the pinned md5.
-- CREATE OR REPLACE keeps the owner and the ACL (service_role was revoked above).
CREATE OR REPLACE FUNCTION public._void_order_impl_20260714(p_order_id uuid, p_performed_by uuid, p_reason text DEFAULT 'Voided by admin'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid;
  v_order record;
  v_item record;
  v_invoice record;
  v_admin record;
  v_inventory_restored integer := 0;
  v_commissions_cancelled integer := 0;
  v_paid_commissions integer := 0;
  v_draft_voided integer := 0;
  v_posted_notified integer := 0;
  v_existing jsonb;
  v_result jsonb;
  -- A3<<<
  v_draw_item record;
  v_draw_quote record;
  v_draw_fully_drawn boolean;
  -- >>>A3
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT is_admin() THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'void_order');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF v_order.status != 'fulfilled' THEN
    RAISE EXCEPTION 'INVALID_ORDER_STATUS: %', v_order.status;
  END IF;

  -- Commission batch-freeze guard (overnight bug-hunt HIGH, 20260620): a pending
  -- commission already committed to a non-voided commission_payments batch must not
  -- be silently cancelled here — post_commission_payment would later resurrect it to
  -- 'paid' and pay the retained snapshot. Force the admin to void the payout first.
  IF EXISTS (
    SELECT 1
    FROM public.commissions cm
    JOIN public.commission_payment_items cpi ON cpi.commission_id = cm.id
    JOIN public.commission_payments cp ON cp.id = cpi.commission_payment_id
    WHERE cm.order_id = p_order_id
      AND cm.status = 'pending'
      AND cp.status <> 'voided'
  ) THEN
    RAISE EXCEPTION 'ORDER_HAS_BATCHED_COMMISSIONS: order % has pending commission(s) committed to an active commission payment batch. Void that payment first, then void the order.', v_order.order_number;
  END IF;

  -- fulfilled→voided is a deliberate admin reversal the status-transition trigger does not
  -- include; bracket ONLY this write with the transaction-local admin override.
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE public.orders
    SET status = 'voided',
        updated_at = now()
  WHERE id = p_order_id;
  PERFORM set_config('app.admin_override', 'false', true);
  -- A3<<< draw-ledger reversal (finding A3, 20260610190000 — see file header).
  -- void = the order is nulled and goods return to the warehouse, so the FULL
  -- drawn quantity goes back to the booking balance.
  IF COALESCE(v_order.booking_draw, false) AND v_order.quote_id IS NOT NULL THEN
    -- Lock the parent quote first: same quote → inventory order as
    -- draw_down_quote, and serializes against a concurrent draw.
    SELECT * INTO v_draw_quote FROM public.quotes
    WHERE id = v_order.quote_id FOR UPDATE;

    FOR v_draw_item IN
      SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS qty_drawn
      FROM public.order_items
      WHERE order_id = p_order_id AND product_id IS NOT NULL
      GROUP BY product_id
      HAVING SUM(COALESCE(total_units_needed, 0)) > 0
    LOOP
      UPDATE public.quote_product_draws
        SET quantity_drawn = GREATEST(quantity_drawn - v_draw_item.qty_drawn, 0),
            updated_at = now()
      WHERE quote_id = v_order.quote_id
        AND product_id = v_draw_item.product_id;
    END LOOP;

    -- If this was the final draw, the quote sits at 'accepted'; with the
    -- balance restored it is no longer fully drawn, so reopen the booking.
    IF v_draw_quote.status = 'accepted' THEN
      SELECT COALESCE(bool_and(COALESCE(d.quantity_drawn, 0) >= b.booked), true) INTO v_draw_fully_drawn
      FROM (
        SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
        FROM public.quote_items WHERE quote_id = v_order.quote_id
        GROUP BY product_id
      ) b
      LEFT JOIN public.quote_product_draws d
        ON d.quote_id = v_order.quote_id AND d.product_id = b.product_id
      WHERE b.booked > 0;

      IF NOT v_draw_fully_drawn THEN
        -- accepted→sent is enforcer-legal on the live enforcer today; the
        -- override bracket is defense-in-depth (see file header).
        PERFORM set_config('app.admin_override', 'true', true);
        UPDATE public.quotes SET status = 'sent', updated_at = now()
        WHERE id = v_order.quote_id;
        PERFORM set_config('app.admin_override', 'false', true);

        INSERT INTO public.activity_feed (event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id)
        VALUES ('booking_reopened',
          'Booking ' || v_draw_quote.quote_number || ' reopened (accepted → sent): draw order ' ||
            v_order.order_number || ' was voided, returning its drawn quantity to the booking balance',
          v_actor, 'quote', v_order.quote_id, v_draw_quote.customer_id);
      END IF;
    END IF;
    -- VOID-1 fix (2026-06-13): the draw moved hold→prebooked; complete_delivery
    -- drained the prebooked to 0 before fulfilment, and the drawn ledger was just
    -- reversed above, so the still-OPEN booking's hold must be REBUILT to
    -- booked−drawn — a preserved (decremented) hold leaks the returned quantity
    -- out of the reservation (Net Free over-counts). Runs for every booking_draw
    -- void (reopened or not). The helper self-gates for non-planned/closed quotes.
    -- Symmetric twin of the cancel_order fix (20260613150100).
    PERFORM _sync_planned_holds(v_order.quote_id, v_actor);
  END IF;
  -- >>>A3

  FOR v_item IN
    SELECT product_id, quantity_delivered
    FROM public.order_items
    WHERE order_id = p_order_id
      AND COALESCE(quantity_delivered, 0) > 0
  LOOP
    UPDATE public.inventory
      SET quantity_available = quantity_available + v_item.quantity_delivered,
          updated_at = now()
    WHERE product_id = v_item.product_id
      AND location = 'Main Warehouse';

    INSERT INTO public.inventory_transactions (
      product_id, transaction_type, quantity, to_location,
      order_id, performed_by, notes
    ) VALUES (
      v_item.product_id,
      'void_delivery_reversal',
      v_item.quantity_delivered,
      'Main Warehouse',
      p_order_id,
      v_actor,
      'Restored ' || v_item.quantity_delivered || ' units - order ' ||
        v_order.order_number || ' voided. Reason: ' || p_reason
    );

    v_inventory_restored := v_inventory_restored + 1;
  END LOOP;

  UPDATE public.commissions
    SET status = 'cancelled',
        commission_amount = 0
  WHERE order_id = p_order_id
    AND status = 'pending';
  GET DIAGNOSTICS v_commissions_cancelled = ROW_COUNT;

  SELECT COUNT(*) INTO v_paid_commissions
  FROM public.commissions
  WHERE order_id = p_order_id AND status = 'paid';

  IF v_paid_commissions > 0 THEN
    FOR v_admin IN
      SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO public.notifications (
        user_id, title, message,
        notification_type,
        related_entity_type,
        related_entity_id
      ) VALUES (
        v_admin.id,
        'Voided Order Has Paid Commissions',
        'Order ' || v_order.order_number || ' was voided but has ' ||
          v_paid_commissions || ' paid commission(s). Manual review required.',
        'void_review', 'order', p_order_id
      );
    END LOOP;
  END IF;

  FOR v_invoice IN
    SELECT * FROM public.invoices
    WHERE order_id = p_order_id
      AND deleted_at IS NULL
      AND status IN ('draft', 'posted')
  LOOP
    IF v_invoice.status = 'draft' THEN
      -- never-posted draft has no financial impact: cancel (allowed transition), do not void.
      UPDATE public.invoices
        SET status = 'cancelled',
            void_reason = 'Order ' || v_order.order_number || ' voided. ' || p_reason,
            total_amount_cents = 0,
            paid_amount_cents = 0,
            prepay_applied_cents = 0,
            write_off_cents = 0,
            updated_at = now()
      WHERE id = v_invoice.id
        AND COALESCE(paid_amount_cents, 0) = 0
        AND COALESCE(prepay_applied_cents, 0) = 0
        AND COALESCE(write_off_cents, 0) = 0
        AND COALESCE(credit_applied_cents, 0) = 0;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'ORDER_VOID_DRAFT_HAS_APPLIED_MONEY: draft invoice % carries a recorded payment, prepay, write-off or credit; reverse it before voiding the order', v_invoice.invoice_number;
      END IF;

      INSERT INTO public.financial_audit_log (
        operation_type,
        entity_type,
        entity_id,
        actor_role,
        old_values, new_values, total_impact_cents, description
      ) VALUES (
        'invoice_cancelled', 'invoice', v_invoice.id, 'admin',
        jsonb_build_object('status', 'draft', 'total_cents', v_invoice.total_amount_cents),
        jsonb_build_object('status', 'cancelled', 'void_reason', 'Order voided'),
        -1 * v_invoice.total_amount_cents,
        'Auto-cancelled draft invoice ' || v_invoice.invoice_number ||
          ' - order ' || v_order.order_number || ' voided'
      );

      v_draft_voided := v_draft_voided + 1;
    ELSIF v_invoice.status = 'posted' THEN
      FOR v_admin IN
        SELECT id FROM public.profiles WHERE role = 'admin' AND is_active = true
      LOOP
        INSERT INTO public.notifications (
          user_id, title, message,
          notification_type,
          related_entity_type,
          related_entity_id
        ) VALUES (
          v_admin.id,
          'Voided Order - Posted Invoice Needs Review',
          'Order ' || v_order.order_number || ' was voided. Invoice ' ||
            v_invoice.invoice_number || ' is posted and needs manual voiding.',
          'void_review', 'invoice', v_invoice.id
        );
      END LOOP;

      v_posted_notified := v_posted_notified + 1;
    END IF;
  END LOOP;

  INSERT INTO public.financial_audit_log (
    operation_type,
    entity_type,
    entity_id,
    actor_role,
    old_values, new_values, total_impact_cents, description
  ) VALUES (
    'order_voided', 'order', p_order_id, 'admin',
    jsonb_build_object('status', 'fulfilled', 'total_price', v_order.total_price),
    jsonb_build_object('status', 'voided', 'void_reason', p_reason),
    -1 * ROUND(v_order.total_price * 100)::bigint,
    'Order ' || v_order.order_number || ' voided. Reason: ' || p_reason
  );

  INSERT INTO public.activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id,
    customer_id
  ) VALUES (
    'order_voided',
    'Order ' || v_order.order_number || ' voided. ' ||
      v_inventory_restored || ' product(s) inventory restored. ' ||
      v_commissions_cancelled || ' commission(s) cancelled. ' ||
      v_draft_voided || ' draft invoice(s) cancelled.' ||
      CASE WHEN v_posted_notified > 0
           THEN ' ' || v_posted_notified || ' posted invoice(s) flagged for review.'
           ELSE '' END ||
      CASE WHEN v_paid_commissions > 0
           THEN ' ' || v_paid_commissions || ' paid commission(s) flagged for review.'
           ELSE '' END ||
      ' Reason: ' || p_reason,
    v_actor, 'order', p_order_id, v_order.customer_id
  );

  v_result := jsonb_build_object(
    'status', 'voided',
    'order_number', v_order.order_number,
    'inventory_products_restored', v_inventory_restored,
    'commissions_cancelled', v_commissions_cancelled,
    'paid_commissions_flagged', v_paid_commissions,
    'draft_invoices_voided', v_draft_voided,
    'posted_invoices_flagged', v_posted_notified
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'void_order', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 4. batch_cancel_deliveries' private body: its live body (pinned above) with ONE change, the
--    per-delivery cancel_delivery(...) call retargeted to the renamed body. The batch cancels
--    keyless per delivery, as before; the public wrapper would now refuse that for a missing key.
--    CREATE OR REPLACE keeps its owner and its postgres-only EXECUTE.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._batch_cancel_deliveries_replay_impl_20261015(p_delivery_ids uuid[], p_cancel_reason text DEFAULT 'Batch cancelled'::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_del record;
  v_count integer := 0;
  v_actor uuid;
  v_result jsonb;
  v_existing jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  PERFORM check_rate_limit(v_actor, 'batch_cancel_deliveries', 3, 60);
  IF array_length(p_delivery_ids, 1) IS NULL THEN RAISE EXCEPTION 'No delivery IDs provided'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'batch_cancel_deliveries');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'count')::integer; END IF;
  END IF;

  FOR v_del IN SELECT id, status FROM deliveries WHERE id = ANY(p_delivery_ids) ORDER BY id
  LOOP
    IF v_del.status NOT IN ('scheduled', 'in_progress', 'completed') THEN CONTINUE; END IF;
    v_result := _cancel_delivery_replay_impl_20261015(p_delivery_id := v_del.id, p_cancel_reason := p_cancel_reason, p_performed_by := v_actor);
    IF (v_result->>'success')::boolean THEN v_count := v_count + 1; END IF;
  END LOOP;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'batch_cancel_deliveries', jsonb_build_object('count', v_count));
  END IF;

  RETURN v_count;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------------------------
DO $postflight$
DECLARE
  v_bad text;
  v_expected_def text;
  v_batch_src text;
BEGIN
  IF to_regclass('pg_temp.delivery_order_void_replay_binding_batch3b_tx') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_ORDER_VOID_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.delivery_order_void_replay_binding_batch3b_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'DELIVERY_ORDER_VOID_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_bad
    FROM (VALUES
      ('cancel_delivery', 'p_delivery_id uuid, p_cancel_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '8528b344f86c7e1aa735e386ea39f2eb'),
      ('void_delivery', 'p_delivery_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '3ef685c8f5bf778e3ae38aa2f89304da'),
      ('void_order', 'p_order_id uuid, p_performed_by uuid, p_reason text DEFAULT ''Voided by admin''::text, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'bb220157f3cd56d28e9efe88dafba896')
    ) AS pin(name, args, ret, body_md5)
   WHERE
     -- Exactly one public wrapper with the live signature, defaults and return type: definer,
     -- pinned search_path, it routes through the intent check, the receipt binder and its renamed
     -- body, and is callable by authenticated and service_role but never by anon or PUBLIC.
     (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = pin.name) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = pin.name
          AND pg_get_function_arguments(p.oid) = pin.args
          AND p.prorettype = pin.ret::regtype AND NOT p.proretset AND p.provolatile = 'v'
          AND NOT p.proisstrict AND p.prokind = 'f'
          AND p.proowner = 'postgres'::regrole AND p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND strpos(p.prosrc, 'check_idempotency_intent(p_idempotency_key, ''' || pin.name || ''',') > 0
          AND strpos(p.prosrc, '_bind_replay_receipt_20261015(p_idempotency_key, ''' || pin.name || ''',') > 0
          AND strpos(p.prosrc, '_' || pin.name || '_replay_impl_20261015(') > 0
          AND strpos(p.prosrc, 'IDEMPOTENCY_KEY_REQUIRED: ' || pin.name || ' requires p_idempotency_key') > 0
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[])
     -- Exactly one renamed body: byte-identical to the reviewed live body, callable only by postgres.
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = '_' || pin.name || '_replay_impl_20261015') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = '_' || pin.name || '_replay_impl_20261015'
          AND p.proowner = 'postgres'::regrole AND p.prosecdef
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND md5(replace(p.prosrc, chr(13), '')) = pin.body_md5
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['postgres']::text[]);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_ORDER_VOID_REPLAY_CONTRACT: wrapper or renamed body drifted for: %', v_bad;
  END IF;

  -- void_order's inner body: unchanged (one overload, owner, definer, search_path), callable only by postgres.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_void_order_impl_20260714') <> 1
     OR NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_void_order_impl_20260714'
       AND p.proowner = 'postgres'::regrole AND p.prosecdef
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       AND pg_get_function_arguments(p.oid) = 'p_order_id uuid, p_performed_by uuid, p_reason text DEFAULT ''Voided by admin''::text, p_idempotency_key text DEFAULT NULL::text'
       AND p.prorettype = 'jsonb'::regtype
       -- Its only changes are the draft branch's 3b edits: the UPDATE zeroing the four money fields,
       -- only on a row with no recorded money (its WHERE), and the refusal when it updates no row.
       -- Stripping all three must give back the pinned md5.
       AND strpos(p.prosrc, E'            total_amount_cents = 0,\n            paid_amount_cents = 0,\n            prepay_applied_cents = 0,\n            write_off_cents = 0,\n') > 0
       AND strpos(p.prosrc, E'\n        AND COALESCE(paid_amount_cents, 0) = 0\n        AND COALESCE(prepay_applied_cents, 0) = 0\n        AND COALESCE(write_off_cents, 0) = 0\n        AND COALESCE(credit_applied_cents, 0) = 0') > 0
       AND strpos(p.prosrc, E'      IF NOT FOUND THEN\n        RAISE EXCEPTION ''ORDER_VOID_DRAFT_HAS_APPLIED_MONEY: draft invoice % carries a recorded payment, prepay, write-off or credit; reverse it before voiding the order'', v_invoice.invoice_number;\n      END IF;\n') > 0
       AND md5(replace(replace(replace(replace(p.prosrc, chr(13), ''),
                       E'      IF NOT FOUND THEN\n        RAISE EXCEPTION ''ORDER_VOID_DRAFT_HAS_APPLIED_MONEY: draft invoice % carries a recorded payment, prepay, write-off or credit; reverse it before voiding the order'', v_invoice.invoice_number;\n      END IF;\n', ''),
                       E'\n        AND COALESCE(paid_amount_cents, 0) = 0\n        AND COALESCE(prepay_applied_cents, 0) = 0\n        AND COALESCE(write_off_cents, 0) = 0\n        AND COALESCE(credit_applied_cents, 0) = 0', ''),
                       E'            total_amount_cents = 0,\n            paid_amount_cents = 0,\n            prepay_applied_cents = 0,\n            write_off_cents = 0,\n',
                       '')) = 'a0a9151160a6f2b58624b30435322b94'
       AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]) THEN
    RAISE EXCEPTION 'POSTFLIGHT_VOID_ORDER_IMPL_CONTRACT: _void_order_impl_20260714 must be its reviewed body plus only the draft branch''s guarded money-field zeroing and no-row refusal, and callable only by postgres';
  END IF;

  -- The batch-cancel body: still postgres-only, and its only change is the retargeted call.
  SELECT replace(p.prosrc, chr(13), '') INTO v_batch_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = '_batch_cancel_deliveries_replay_impl_20261015'
     AND p.proowner = 'postgres'::regrole AND p.prosecdef
     AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                 FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
         IS NOT DISTINCT FROM ARRAY['postgres']::text[];
  IF v_batch_src IS NULL
     OR strpos(v_batch_src, 'v_result := _cancel_delivery_replay_impl_20261015(p_delivery_id := v_del.id, p_cancel_reason := p_cancel_reason, p_performed_by := v_actor);') = 0
     OR v_batch_src ~ '(^|[^_a-z])cancel_delivery\s*\('
     OR md5(replace(v_batch_src, '_cancel_delivery_replay_impl_20261015(p_delivery_id', 'cancel_delivery(p_delivery_id')) <> '25d34db60f098a22a62db53780742eee' THEN
    RAISE EXCEPTION 'POSTFLIGHT_BATCH_CANCEL_CONTRACT: _batch_cancel_deliveries_replay_impl_20261015 must differ from its reviewed body only by the retargeted cancel call';
  END IF;

  -- The commit-time guard: the one trigger running the guard function, exactly as recorded above
  -- (every previously covered operation, then these three), deferred AFTER INSERT OR UPDATE per row.
  IF (SELECT count(*) FROM pg_temp.delivery_order_void_replay_binding_batch3b_guard_ops) <> 27
     OR (SELECT count(*) FROM pg_temp.delivery_order_void_replay_binding_batch3b_guard_ops
          WHERE operation IN ('cancel_delivery', 'void_delivery', 'void_order')) <> 3 THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECEIPT_GUARD_CONTRACT: the recorded guard operation list is not a reviewed state';
  END IF;
  v_expected_def := 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
    || (SELECT string_agg(quote_literal(g.operation) || '::text', ', ' ORDER BY g.ord) FROM pg_temp.delivery_order_void_replay_binding_batch3b_guard_ops g)
    || ']))) EXECUTE FUNCTION _require_bound_replay_receipt_20261015()';
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.idempotency_keys'::regclass
         AND t.tgname = 'require_bound_replay_receipt_20261015'
         AND t.tgfoid = to_regprocedure('public._require_bound_replay_receipt_20261015()')
         AND t.tgenabled = 'O' AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
         AND (t.tgtype::int & 1) = 1      -- ROW level
         AND (t.tgtype::int & 2) = 0      -- AFTER
         AND (t.tgtype::int & 4) <> 0     -- INSERT
         AND (t.tgtype::int & 16) <> 0    -- UPDATE
         AND pg_get_triggerdef(t.oid) = v_expected_def) <> 1
     OR (SELECT count(*) FROM pg_trigger t
          WHERE t.tgfoid = to_regprocedure('public._require_bound_replay_receipt_20261015()')) <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECEIPT_GUARD_CONTRACT: require_bound_replay_receipt_20261015 is not installed as reviewed';
  END IF;

  -- The helpers are still callable by no API role.
  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY['public._replay_fingerprint_20261015(jsonb)',
                        'public._bind_replay_receipt_20261015(text,text,text)',
                        'public._require_bound_replay_receipt_20261015()']) AS h(sig)
      CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS api_role
     WHERE to_regprocedure(h.sig) IS NULL
        OR has_function_privilege(api_role, to_regprocedure(h.sig), 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_HELPER_CONTRACT: the replay-binding helpers must exist and be callable by no API role';
  END IF;

  RAISE NOTICE 'POSTFLIGHT_OK: cancel_delivery, void_delivery and void_order now replay a stored result only for the same person and the exact same request';
END
$postflight$;
