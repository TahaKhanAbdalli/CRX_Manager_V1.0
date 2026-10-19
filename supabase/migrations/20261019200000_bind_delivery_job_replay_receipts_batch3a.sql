-- Written 2026-10-18. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: batch 3a of the system-wide idempotency replay-binding fix (KNOWN_ISSUES.md, "about 75 live
--   functions replay a saved result matched on the retry key alone"). The HIGH money group (row 2 of
--   that entry's table) is split; this first cut binds the two field completions that move money AND
--   stock:
--     complete_delivery  (driver/office completes a delivery: stock leaves the warehouse, the order's
--                         automatic invoice or split drafts are written)
--     complete_job       (applicator/office completes a spray job: product is consumed, the
--                         application record and the job's automatic invoice draft are written)
--   Both replay a stored receipt matched on the retry key alone, so a retry that reuses a key for a
--   DIFFERENT delivery/job, or with edited quantities, signer, issue notes or applied info, gets the
--   first call's "done" answer and the new request is never carried out (a false success; nothing is
--   ever done twice). DeliveryDetail.tsx documents the reachable case: a driver edits quantities
--   after an ambiguous reply and the retained key replays the first quantities.
--
--   The fix is batch 1's pattern (20261016060000), reusing its live helpers: each live body is
--   RENAMED unchanged to _<name>_replay_impl_20261015 (no API role may call it), and a public wrapper
--   with the identical signature, defaults, return type, owner, search_path and grants takes its
--   place. With a key, the wrapper
--     1. requires auth.uid() and refuses a p_performed_by naming someone else, with the same test and
--        message its renamed body uses (complete_delivery: AUTH_REQUIRED / ACTOR_MISMATCH, NULL
--        allowed; complete_job: 'Not authenticated' / 'p_performed_by does not match authenticated
--        user', NULL refused);
--     2. computes a SHA-256 fingerprint of the actor, the target id and every other argument;
--        complete_delivery's p_completed_at is fingerprinted as its epoch, so the session TimeZone
--        cannot change the fingerprint of the same instant;
--     3. calls check_idempotency_intent(key, op, auth.uid(), fingerprint), which takes the per-key
--        advisory lock (crx:idempotency:<key>). No receipt: run the body. Exact actor + intent
--        match: run the body, which replays its own stored answer exactly as before. Anything else
--        is refused with IDEMPOTENCY_ACTOR_MISMATCH or IDEMPOTENCY_INTENT_MISMATCH, which the app
--        maps to plain English (src/lib/idempotency.ts getIdempotencyBindingRejection,
--        src/lib/errorSanitizer.ts);
--     4. after a fresh run, stamps request_actor_id and request_fingerprint onto the receipt the body
--        just wrote (_bind_replay_receipt_20261015), and refuses (rolls the call back) if the body
--        wrote none. Both bodies write a receipt on every fresh success (read live 2026-10-18:
--        complete_delivery through save_idempotency in _complete_delivery_authorized_impl, whose
--        result _complete_delivery_period_preflight_impl may then rewrite in place with stock
--        warnings; complete_job by its own INSERT), and neither returns early without one.
--   A key is REQUIRED (IDEMPOTENCY_KEY_REQUIRED, 22023), as in batches 1 and 2: a keyless call would
--   run with no receipt, so a lost-response retry could repeat the stock and invoice work. Every
--   caller already sends one: the five app screens (Deliveries, DeliveryDetail, FieldStop,
--   FieldView, JobDetail) and the one internal caller, process_offline_action, which refuses a
--   missing key itself and replays the offline receipt's saved request under its own key, so its
--   fingerprint is the same on every attempt.
--
--   Why a body's own key-only lookup cannot return ANOTHER operation's receipt on an exact match:
--   idempotency_keys has a UNIQUE index on idempotency_key, so a key has at most one row, and
--   check_idempotency_intent has already refused it (IDEMPOTENCY_CROSS_OP_KEY_REUSE) unless that row
--   is this operation's, under the lock.
--
--   COMMIT-TIME GUARD: batch 1's deferred constraint trigger require_bound_replay_receipt_20261015
--   now also covers complete_delivery and complete_job. A trigger's WHEN clause cannot be altered, so
--   the trigger is dropped and recreated with the same name, function and timing, inside this
--   transaction under its ACCESS EXCLUSIVE lock on idempotency_keys (no gap is visible). No second
--   trigger is created. Replay-binding batch 2 (20261016140000, PR #951) recreates the same trigger;
--   it was not applied when this file was written and was applied live on 2026-10-19 (ledger
--   20261019010324), so this file accepts only the batch 1 + batch 2 trigger and keeps every
--   operation it covers: the nine batch-1 operations + batch 2's thirteen + these two (24). Any
--   other trigger definition, the earlier batch-1-only literal included, refuses the apply
--   (PREFLIGHT_RECEIPT_GUARD_DRIFT): with batch 2 live, a batch-1-only trigger is drift, and
--   rebuilding from it would leave the thirteen batch-2 operations unguarded (Codex on PR #954).
--
-- WHAT DOES NOT CHANGE: no money, stock or invoice logic is retyped (the bodies are renamed, pinned
--   by md5 below); the private chain under complete_delivery (_complete_delivery_period_preflight_impl,
--   _complete_delivery_aggregate_impl, _complete_delivery_authorized_impl) is untouched and stays
--   callable only by postgres; no table, row, policy or receipt changes; every keyed legitimate call
--   (first call, exact retry) returns what it returns today. A keyless call is now refused
--   (IDEMPOTENCY_KEY_REQUIRED). Checks that now run before the renamed bodies: the key requirement,
--   the auth/actor test (same messages), and the actor/intent binding. The body's delivery/job
--   authorization still runs inside the renamed body; a DIFFERENT user retrying someone else's key
--   is now refused by the binding (IDEMPOTENCY_ACTOR_MISMATCH) before that authorization, which
--   still shows them nothing: check_idempotency_intent discloses a stored result only to the same
--   actor.
--
-- RECEIPT DISCLOSURE: as batch 1. The preflight refuses to apply while any unexpired receipt exists
--   for the two operations (none existed when read live on 2026-10-18; the newest is from 2026-08-08
--   and expired) and the commit-time guard keeps an unbound one from ever committing.
--
-- ACCESS: this file narrows access, so it applies only on Mason's owner approval
--   (scripts/owner-approve-migration.mjs): the two renamed bodies lose EXECUTE, and a keyless call is
--   refused. It widens nothing.
--
-- NOT IN THIS BATCH: the rest of the HIGH money group (void_order, void_delivery, cancel_delivery,
--   unpost_invoice, transfer_invoice_to_job, price_order, update_order_items, save_field_app_invoice,
--   update_field_app_invoice_billing, transition_rebate_claim, create_rebate_claim,
--   close_accounting_period, apply_credit_memo_to_invoice's after-lock recheck,
--   record_job_pre/post_notifications) and the MED/LOW group. cancel_delivery waits for batch 2:
--   batch_cancel_deliveries calls it per delivery with no key.
--
-- OVERLOADS: each of the two has exactly one overload (read-only on live 2026-10-18); the preflight
--   refuses a second one and the postflight proves exactly one wrapper and one body per name.
--
-- ROLLBACK (if ever needed, as its own reviewed migration), in this order: FIRST recreate
--   require_bound_replay_receipt_20261015 without complete_delivery and complete_job (left covering
--   them, it would refuse every receipt the restored old bodies write, rolling back their stock and
--   invoice work); then, for each name, DROP the wrapper, ALTER FUNCTION
--   public._<name>_replay_impl_20261015(...) RENAME TO <name>, and restore its grants (EXECUTE to
--   authenticated, service_role). Batch 1's helpers stay (batches 1 and 2 still use them).
--
-- KNOWN LIMITS (security review, 2026-10-18; each fails safe, nothing wrong is committed):
--   * Lock order: the wrapper takes the per-key advisory lock before the body locks the delivery or
--     job row, while process_offline_action locks the row first and then calls the wrapper. An
--     online retry and an offline sync of the SAME key at the same moment can deadlock; PostgreSQL
--     aborts one side (40P01), which process_offline_action re-raises for a later retry.
--   * The binding runs before the body's role and assignment check, so a caller who lost access in
--     the last 24 hours and retries THEIR OWN key with an edited request sees their own earlier
--     result in the refusal DETAIL (batch 1 has the same shape; another user never sees it).
--   * process_offline_action labels the new refusals generically for the office (PAYLOAD_INVALID or
--     UNEXPECTED_SERVER_ERROR); the action still goes to needs_review with nothing committed.
--
-- ORDERING: strict. Live high-water when written: 20261016060000 (PR #942, replay-binding batch 1,
--   ledger 20261016121253). Numbered above 20261016140000 (PR #951, batch 2, applied live
--   2026-10-19 as ledger 20261019010324, before this file as planned). Written as 20261018230000;
--   renumbered 20261019200000 above 20261019010000 (PR #957, applied live 2026-10-19 as ledger
--   20261019182757; it touches none of the bodies this file pins, whose live md5s were re-read
--   after it). Re-read the live ledger before applying.
--
-- idempotency-body-check: exempt. Every wrapper reads idempotency_keys through
--   check_idempotency_intent with its own operation literal and writes it through
--   _bind_replay_receipt_20261015; the renamed bodies keep their own operation-scoped lookups.
--
-- Grants. Every REVOKE below is either (a) on a RENAMED body, which no caller names any more, or
-- (b) the routine "FROM PUBLIC, anon" on a freshly created wrapper that is then granted to
-- authenticated and service_role, which is exactly the live ACL of the function it replaces. The app
-- keeps calling the same name with the same arguments and reaches the wrapper:
-- caller-analysis: complete_delivery :: src/pages/Deliveries.tsx, src/pages/DeliveryDetail.tsx and src/pages/FieldStop.tsx call the same name and signature with a key; process_offline_action (postgres-owned definer) calls it by name with the offline receipt's key and reaches the wrapper; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: complete_job :: src/pages/FieldView.tsx and src/pages/JobDetail.tsx call the same name and signature with a key; process_offline_action calls it by name with the offline receipt's key and reaches the wrapper; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE delivery_job_replay_binding_batch3a_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

-- The operations the commit-time guard covers once this file is applied, in trigger order, recorded
-- by the guard step below and read back by the postflight.
CREATE TEMP TABLE delivery_job_replay_binding_batch3a_guard_ops (
  ord integer PRIMARY KEY,
  operation text NOT NULL UNIQUE
) ON COMMIT DROP;

DO $preflight$
DECLARE
  v_drift text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.delivery_job_replay_binding_batch3a_tx') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_JOB_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.delivery_job_replay_binding_batch3a_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'DELIVERY_JOB_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- The two bodies, exactly as reviewed live on 2026-10-18 (md5 ignores carriage returns), each the
  -- only overload of its name, with the live owner, attributes and grants, and no renamed copy yet.
  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_drift
    FROM (VALUES
      ('complete_delivery', 'p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone', 'jsonb', 'a1e9a043f27d3566f8ecf6d5e3a809ab'),
      ('complete_job', 'p_job_id uuid, p_applied_info jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '4e4c38e3e8be66e2d24c434bb54c0521')
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
    RAISE EXCEPTION 'PREFLIGHT_DELIVERY_JOB_REPLAY_BODY_DRIFT: expected the exact reviewed live body (and no renamed copy yet) for: %', v_drift;
  END IF;

  -- complete_delivery's private chain keeps a key-only replay below the wrapper; it must stay
  -- callable by postgres alone (read live 2026-10-18), so the wrapper is the only way in.
  SELECT string_agg(chain.name, ', ' ORDER BY chain.name) INTO v_drift
    FROM (VALUES
      ('_complete_delivery_period_preflight_impl'),
      ('_complete_delivery_aggregate_impl'),
      ('_complete_delivery_authorized_impl')
    ) AS chain(name)
   WHERE (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = chain.name) <> 1
      OR EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = chain.name
           AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                       FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
               IS DISTINCT FROM ARRAY['postgres']::text[]);
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_COMPLETE_DELIVERY_CHAIN_ACL: expected exactly one private impl callable only by postgres for: %', v_drift;
  END IF;

  -- The one internal caller: it must still send its offline receipt's key and saved request
  -- (reviewed live body, 2026-10-18).
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'process_offline_action') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'process_offline_action'
          AND pg_get_function_identity_arguments(p.oid) = 'p_client_action_id uuid, p_idempotency_key text'
          AND md5(replace(p.prosrc, chr(13), '')) = '0461eebf65f23ccc8fe3852375eb9c78') THEN
    RAISE EXCEPTION 'PREFLIGHT_OFFLINE_ACTION_DRIFT: process_offline_action differs from its reviewed body (it calls both functions by name)';
  END IF;

  -- What the wrappers rely on: the intent check as installed by 20260811130000 (pinned), the two
  -- binding columns, auth.uid() (pinned), and batch 1's live helpers and guard (pinned).
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
  -- So apply only while no unexpired receipt exists for the two operations; this transaction's
  -- ACCESS EXCLUSIVE lock keeps a new one from appearing before the guard covers them.
  LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys k
              WHERE k.operation IN ('complete_delivery', 'complete_job')
                AND (k.expires_at IS NULL OR k.expires_at >= now())) THEN
    RAISE EXCEPTION 'PREFLIGHT_UNEXPIRED_RECEIPTS: an unexpired complete_delivery or complete_job receipt exists; wait for it to expire (24 hours) and apply again';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- The commit-time guard now covers the two operations too (same trigger, same function), keeping
-- every operation it already covers. Only the batch-1+2 prior state is accepted (see the header).
-- ---------------------------------------------------------------------------------------------
DO $guard$
DECLARE
  v_batch1 constant text[] := ARRAY[
    'void_payment', 'delete_prepay_credit', 'edit_prepay_credit', 'apply_write_off',
    'reverse_write_off', 'apply_prepay_to_invoice', 'create_prepay_check_splits',
    'batch_apply_prepayments', 'batch_void_invoices'];
  v_batch2 constant text[] := ARRAY[
    'release_inventory_hold', 'retire_inventory_item', 'reconcile_negative_inventory',
    'manual_inventory_add', 'create_order_from_blend_ticket', 'create_direct_order',
    'create_rush_order', 'close_quote_as_applied', 'close_quote_as_short',
    'create_app_record_from_bt', 'batch_cancel_deliveries', 'reverse_completed_cycle_count',
    'create_planned_holds'];
  v_batch3a constant text[] := ARRAY['complete_delivery', 'complete_job'];
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

  -- Batch 2 is live (ledger 20261019010324), so only the batch-1+2 trigger is accepted: a
  -- batch-1-only literal now means drift, and keeping it would leave the batch-2 operations unguarded.
  IF v_def = 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
            || (SELECT string_agg(quote_literal(o) || '::text', ', ' ORDER BY ord) FROM unnest(v_batch1 || v_batch2) WITH ORDINALITY AS u(o, ord))
            || ']))) EXECUTE FUNCTION _require_bound_replay_receipt_20261015()' THEN
    v_ops := v_batch1 || v_batch2 || v_batch3a;
  ELSE
    RAISE EXCEPTION 'PREFLIGHT_RECEIPT_GUARD_DRIFT: require_bound_replay_receipt_20261015 is not the batch-1+2 trigger: %', v_def;
  END IF;

  INSERT INTO pg_temp.delivery_job_replay_binding_batch3a_guard_ops (ord, operation)
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
-- 1. complete_delivery (also called by name from process_offline_action, with the offline key)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz) RENAME TO _complete_delivery_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._complete_delivery_replay_impl_20261015(uuid, text, uuid, jsonb, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_quantities jsonb DEFAULT NULL::jsonb,
  p_issue_type text DEFAULT NULL::text,
  p_issue_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text,
  p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: complete_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- Same tests and messages as the renamed body.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- p_quantities is fingerprinted as sent (jsonb normalizes key order); p_completed_at as its epoch,
  -- so the session TimeZone cannot change the fingerprint of the same instant.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'delivery_id', p_delivery_id,
    'signed_by', p_signed_by,
    'quantities', p_quantities,
    'issue_type', p_issue_type,
    'issue_notes', p_issue_notes,
    'completed_at_epoch', extract(epoch FROM p_completed_at)
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'complete_delivery', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._complete_delivery_replay_impl_20261015(p_delivery_id, p_signed_by, p_performed_by, p_quantities, p_issue_type, p_issue_notes, p_idempotency_key, p_completed_at);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'complete_delivery', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_delivery(uuid, text, uuid, jsonb, text, text, text, timestamptz) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. complete_job (also called by name from process_offline_action, with the offline key)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.complete_job(uuid, jsonb, uuid, text) RENAME TO _complete_job_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._complete_job_replay_impl_20261015(uuid, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.complete_job(
  p_job_id uuid,
  p_applied_info jsonb,
  p_performed_by uuid,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: complete_job requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- Same tests and messages as the renamed body, which is strict: the caller must name itself.
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;
  -- p_applied_info is fingerprinted as sent (jsonb normalizes key order; array order counts).
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'job_id', p_job_id,
    'applied_info', p_applied_info
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'complete_job', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._complete_job_replay_impl_20261015(p_job_id, p_applied_info, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'complete_job', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.complete_job(uuid, jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_job(uuid, jsonb, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------------------------
DO $postflight$
DECLARE
  v_bad text;
  v_expected_def text;
BEGIN
  IF to_regclass('pg_temp.delivery_job_replay_binding_batch3a_tx') IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_JOB_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.delivery_job_replay_binding_batch3a_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'DELIVERY_JOB_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_bad
    FROM (VALUES
      ('complete_delivery', 'p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone', 'jsonb', 'a1e9a043f27d3566f8ecf6d5e3a809ab'),
      ('complete_job', 'p_job_id uuid, p_applied_info jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '4e4c38e3e8be66e2d24c434bb54c0521')
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
          AND md5(replace(p.prosrc, chr(13), '')) = pin.body_md5
          AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                      FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
              IS NOT DISTINCT FROM ARRAY['postgres']::text[]);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_DELIVERY_JOB_REPLAY_CONTRACT: wrapper or renamed body drifted for: %', v_bad;
  END IF;

  -- The commit-time guard: the one trigger running the guard function, exactly as recorded above
  -- (every previously covered operation, then these two), deferred AFTER INSERT OR UPDATE per row.
  IF (SELECT count(*) FROM pg_temp.delivery_job_replay_binding_batch3a_guard_ops) <> 24
     OR NOT EXISTS (SELECT 1 FROM pg_temp.delivery_job_replay_binding_batch3a_guard_ops WHERE operation = 'complete_delivery')
     OR NOT EXISTS (SELECT 1 FROM pg_temp.delivery_job_replay_binding_batch3a_guard_ops WHERE operation = 'complete_job') THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECEIPT_GUARD_CONTRACT: the recorded guard operation list is not a reviewed state';
  END IF;
  v_expected_def := 'CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015 AFTER INSERT OR UPDATE ON public.idempotency_keys DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.operation = ANY (ARRAY['
    || (SELECT string_agg(quote_literal(g.operation) || '::text', ', ' ORDER BY g.ord) FROM pg_temp.delivery_job_replay_binding_batch3a_guard_ops g)
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

  RAISE NOTICE 'POSTFLIGHT_OK: complete_delivery and complete_job now replay a stored result only for the same person and the exact same request';
END
$postflight$;
