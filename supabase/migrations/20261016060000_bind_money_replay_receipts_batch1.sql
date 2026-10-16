-- Written 2026-10-15. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: batch 1 of the system-wide idempotency replay-binding fix (KNOWN_ISSUES.md, "about 75 live
--   functions replay a saved result matched on the retry key alone"; follow-up task_d66d87f4 of
--   PR #933). Nine money RPCs replay a stored receipt matched on the retry key alone, so a retry that
--   reuses a key for a DIFFERENT record or amount gets the first call's "done" answer and the new
--   record is never touched (a false success; nothing is ever done twice):
--     void_payment, delete_prepay_credit, edit_prepay_credit, apply_write_off, reverse_write_off,
--     apply_prepay_to_invoice, create_prepay_check_splits, batch_apply_prepayments,
--     batch_void_invoices.
--   void_payment, delete_prepay_credit and edit_prepay_credit even echo the NEW record's id in that
--   false success. Two app screens keep one key across different targets today (Invoices batch void,
--   PrepayWorkspacePanel batch apply), so this is reachable from the UI.
--
--   The fix is the commission-payout pattern (20260811130000, gauntlet row 3.5): each live body is
--   RENAMED unchanged to _<name>_replay_impl_20261015 (no API role may call it), and a public wrapper
--   with the identical signature, defaults, return type, owner, search_path and grants takes its
--   place. With a key, the wrapper
--     1. requires auth.uid() (AUTH_REQUIRED) and refuses a p_performed_by naming someone else
--        (ACTOR_MISMATCH), the same tests (and codes) every renamed body makes;
--     2. computes a SHA-256 fingerprint of the actor, the target id(s) and every editable argument;
--     3. calls check_idempotency_intent(key, op, auth.uid(), fingerprint), which takes the per-key
--        advisory lock (crx:idempotency:<key>) that check_idempotency and the receipt insert trigger
--        also take; void_payment, delete/edit_prepay_credit and reverse_write_off read receipts
--        without that lock today, so for them this is new serialization. No receipt: run the body.
--        Exact actor + intent match: run the body, which replays its own stored answer exactly as
--        before. Anything else is refused with IDEMPOTENCY_ACTOR_MISMATCH or
--        IDEMPOTENCY_INTENT_MISMATCH, which the app maps to plain English (src/lib/idempotency.ts
--        getIdempotencyBindingRejection, src/lib/errorSanitizer.ts);
--     4. after a fresh run, stamps request_actor_id (auth.uid()) and request_fingerprint onto the
--        receipt the body just wrote, inside the same transaction, and refuses (rolls the whole call
--        back) if the body wrote none.
--   A key is REQUIRED (IDEMPOTENCY_KEY_REQUIRED, 22023, the house form from 20260721145936): a
--   keyless call would run with no receipt, so a lost-response retry could repeat the money action
--   (Codex P1 on PR #942). Every app call site already sends one. The one internal exception:
--   _batch_apply_prepayments_impl applies each allocation through apply_prepay_to_invoice with no
--   key, under the batch's own bound key; batch_apply_prepayments marks that call with the
--   transaction-local setting crx.batch_apply_prepayments_internal (no Data API request can set
--   it), and apply_prepay_to_invoice accepts a keyless call only while it is set.
--
--   Why a body's own key-only lookup cannot return ANOTHER operation's receipt on an exact match:
--   idempotency_keys has a UNIQUE index on idempotency_key (idempotency_keys_idempotency_key_key,
--   read live 2026-10-15), so a key has at most one row, and check_idempotency_intent has already
--   refused it (IDEMPOTENCY_CROSS_OP_KEY_REUSE) unless that row is this operation's, under the lock.
--
--   Three more pieces (review round 1, 2026-10-15):
--   * ACTIVE-ADMIN GATE on reverse_write_off, delete_prepay_credit and edit_prepay_credit, on every
--     path: after the auth and actor tests, NOT is_admin() raises the body's own message.
--     reverse_write_off's body tests (SELECT role ... AND is_active) != 'admin', which is NULL for a
--     deactivated or missing profile and lets the call through; delete/edit replay a receipt before
--     their role test. Every admin who can call them today still can; a deactivated admin cannot.
--   * COMMIT-TIME GUARD: deferred constraint trigger require_bound_replay_receipt_20261015 refuses
--     (REPLAY_RECEIPT_UNBOUND) any receipt for the nine operations still unbound at commit, so an
--     old body running across the apply, or any other writer, cannot commit one. With the
--     preflight's refusal of unexpired receipts (under an ACCESS EXCLUSIVE lock on idempotency_keys
--     held to commit), no legacy receipt exists for the screen to trip over after the apply.
--   * _batch_apply_prepayments_impl loses its leftover service_role EXECUTE (it has no
--     authorization of its own and its key-only replay sits below the wrapper).
--
-- WHAT DOES NOT CHANGE: no money logic is retyped (the bodies are renamed, pinned by md5 below);
--   no table, row, policy or receipt changes; every keyed legitimate call (first call, exact
--   retry) returns what it returns today. A keyless call is now refused (IDEMPOTENCY_KEY_REQUIRED),
--   except apply_prepay_to_invoice under the batch_apply_prepayments marker. Checks that now run
--   before the renamed bodies: the key requirement, the active-admin gate on the three gated
--   wrappers (and batch_apply_prepayments), and the actor/intent binding.
--
-- RECEIPT DISCLOSURE: check_idempotency_intent puts the stored result in the error DETAIL only on an
--   INTENT mismatch by the SAME actor (who already received that result), or for a legacy receipt
--   with neither binding column. The preflight refuses to apply while any unexpired receipt exists
--   for the nine operations (none existed when read live on 2026-10-15) and the commit-time guard
--   keeps an unbound one from ever committing, so the legacy path has nothing to disclose.
--
-- ACCESS: this file narrows access, so it applies only on Mason's owner approval
--   (scripts/owner-approve-migration.mjs): the renamed bodies and _batch_apply_prepayments_impl lose
--   EXECUTE, and three wrappers add an active-admin test. It widens nothing.
--
-- NOT IN THIS BATCH: the other ~65 unbound functions (batches 2-4 in KNOWN_ISSUES.md), and
--   mark_inventory_row_verified's NULL-role test (found in passing; not one of the nine).
--
-- OVERLOADS: each of the nine has exactly one overload (read-only on live 2026-10-15); the preflight
--   refuses a second one and the postflight proves exactly one wrapper and one body per name.
--
-- ROLLBACK (if ever needed, as its own reviewed migration), in this order: FIRST
--   DROP TRIGGER require_bound_replay_receipt_20261015 ON public.idempotency_keys and DROP FUNCTION
--   public._require_bound_replay_receipt_20261015() (left behind, it would refuse every receipt the
--   restored old bodies write, rolling back their money actions); then, for each name, DROP the
--   wrapper, ALTER FUNCTION public._<name>_replay_impl_20261015(...) RENAME TO <name>, and restore
--   its grants (EXECUTE to authenticated, service_role); re-grant EXECUTE on
--   _batch_apply_prepayments_impl to service_role if wanted; then drop _replay_fingerprint_20261015
--   and _bind_replay_receipt_20261015.
--
-- ORDERING: strict. Live high-water when renumbered: 20261016030000 (PR #947, photo buckets
--   private, applied 2026-10-16 05:19 UTC). Written as 20261015190000 and renumbered three times
--   to sort above 20261015200000, 20261015230000 and 20261016030000. Re-read the live ledger
--   before applying.
--
-- idempotency-body-check: exempt. Every wrapper reads idempotency_keys through
--   check_idempotency_intent with its own operation literal and writes it through
--   _bind_replay_receipt_20261015; the renamed bodies keep their own operation-scoped lookups.
--
-- Grants. Every REVOKE below is either (a) on a RENAMED body, which no caller names any more, or
-- (b) the routine "FROM PUBLIC, anon" on a freshly created wrapper that is then granted to
-- authenticated and service_role, which is exactly the live ACL of the function it replaces. The app
-- keeps calling the same name with the same arguments and reaches the wrapper:
-- caller-analysis: void_payment :: src/pages/PaymentHistory.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: delete_prepay_credit :: src/components/prepay/PrepaymentManagerPanel.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: edit_prepay_credit :: src/components/prepay/PrepaymentManagerPanel.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: apply_write_off :: src/components/invoices/WriteOffModal.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: reverse_write_off :: src/pages/InvoiceDetail.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: apply_prepay_to_invoice :: no UI caller; _batch_apply_prepayments_impl calls it by name with no key under the batch marker and reaches the wrapper, which delegates; only the renamed body loses EXECUTE
-- caller-analysis: create_prepay_check_splits :: src/components/prepay/PrepaymentManagerPanel.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: batch_apply_prepayments :: src/components/prepay/PrepayWorkspacePanel.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: batch_void_invoices :: src/pages/Invoices.tsx calls the same name and signature; the new wrapper keeps EXECUTE for authenticated; only the renamed body loses it
-- caller-analysis: _batch_apply_prepayments_impl :: no UI or Edge Function caller; its only caller is the renamed batch_apply_prepayments body, a postgres-owned definer function, which keeps calling it

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE money_replay_binding_batch1_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_drift text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.money_replay_binding_batch1_tx') IS NULL THEN
    RAISE EXCEPTION 'MONEY_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.money_replay_binding_batch1_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'MONEY_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- The nine bodies, exactly as reviewed live on 2026-10-15 (md5 ignores carriage returns), each the
  -- only overload of its name, with the live owner, attributes and grants, and no renamed copy yet.
  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_drift
    FROM (VALUES
      ('void_payment', 'p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '70fd746c15f4a6629680a724f3588967'),
      ('delete_prepay_credit', 'p_credit_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'bcb90bd23619af6f1e45c69bb2db4169'),
      ('edit_prepay_credit', 'p_credit_id uuid, p_new_balance_cents bigint DEFAULT NULL::bigint, p_reference_number text DEFAULT NULL::text, p_bucket_label text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '366db16a403a0f508b28aadc8862475c'),
      ('apply_write_off', 'p_invoice_id uuid, p_amount_cents bigint, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'uuid', '00e8d020f9faf6276de8ddaf4f1411fc'),
      ('reverse_write_off', 'p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '70ef11ccad193eb6ef5ee88dcba6f8cd'),
      ('apply_prepay_to_invoice', 'p_prepay_credit_id uuid, p_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'uuid', 'c9377dab8f2534a03af2c27a6e1d510c'),
      ('create_prepay_check_splits', 'p_customer_id uuid, p_reference_number text, p_splits jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text, p_expected_total_cents bigint DEFAULT NULL::bigint', 'jsonb', '6a164940dfac7afd05d06612e702bb52'),
      ('batch_apply_prepayments', 'p_allocations jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '15624992c9375e08a0ec1914437e6e40'),
      ('batch_void_invoices', 'p_invoice_ids uuid[], p_void_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'integer', '32fa9718f29e18c8eff4539e36ac84b3')
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
    RAISE EXCEPTION 'PREFLIGHT_MONEY_REPLAY_BODY_DRIFT: expected the exact reviewed live body (and no renamed copy yet) for: %', v_drift;
  END IF;

  -- What the wrappers rely on: the intent check as installed by 20260811130000 (pinned), whose lock
  -- is the one the bodies' lookups take, the two binding columns, auth.uid(), and extensions.digest.
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
  IF to_regprocedure('extensions.digest(bytea,text)') IS NULL OR to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_DEPENDENCY_MISSING: extensions.digest(bytea, text) and auth.uid() are required';
  END IF;
  -- The active-admin gate the three gated wrappers add (reviewed live body, 2026-10-15).
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'is_admin') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'is_admin'
          AND pg_get_function_identity_arguments(p.oid) = ''
          AND md5(replace(p.prosrc, chr(13), '')) = 'f76bf61116c3bd52bd9c6ea125079b73') THEN
    RAISE EXCEPTION 'PREFLIGHT_IS_ADMIN_DRIFT: is_admin() differs from its reviewed body';
  END IF;
  -- The private impl batch_apply_prepayments delegates to: exactly the live ACL this file narrows.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_batch_apply_prepayments_impl'
       AND pg_get_function_identity_arguments(p.oid) = 'p_allocations jsonb, p_performed_by uuid, p_idempotency_key text'
       AND md5(replace(p.prosrc, chr(13), '')) = 'e4c54a1cc435b2e14d59bea571eb18b6'
       AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres', 'service_role']::text[]) THEN
    RAISE EXCEPTION 'PREFLIGHT_BATCH_APPLY_IMPL_DRIFT: _batch_apply_prepayments_impl differs from its reviewed body or ACL';
  END IF;
  -- Cutover: a receipt written by an old body carries no binding, and the intent check refuses it
  -- (the screen then retires the key, so a lost-response retry could run the action again). So
  -- apply only while no unexpired receipt exists for the nine operations; this transaction's
  -- ACCESS EXCLUSIVE lock below keeps a new one from appearing before the guard trigger exists.
  LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM public.idempotency_keys k
              WHERE k.operation IN ('void_payment', 'delete_prepay_credit', 'edit_prepay_credit', 'apply_write_off', 'reverse_write_off', 'apply_prepay_to_invoice', 'create_prepay_check_splits', 'batch_apply_prepayments', 'batch_void_invoices')
                AND (k.expires_at IS NULL OR k.expires_at >= now())) THEN
    RAISE EXCEPTION 'PREFLIGHT_UNEXPIRED_RECEIPTS: an unexpired receipt exists for one of the nine operations; wait for it to expire (24 hours) and apply again';
  END IF;
  -- Not re-runnable: the helpers must not exist yet.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('_replay_fingerprint_20261015', '_bind_replay_receipt_20261015',
                                  '_require_bound_replay_receipt_20261015'))
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'require_bound_replay_receipt_20261015') THEN
    RAISE EXCEPTION 'PREFLIGHT_HELPERS_EXIST: the batch-1 replay-binding helpers are already installed';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- Shared helpers (callable by no API role; reused by the later batches).
-- ---------------------------------------------------------------------------------------------

-- SHA-256 hex of the canonical jsonb text of a request. jsonb normalizes key order and whitespace,
-- so the same arguments always give the same fingerprint.
CREATE FUNCTION public._replay_fingerprint_20261015(p_request jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fingerprint$
  SELECT encode(extensions.digest(convert_to(p_request::text, 'UTF8'), 'sha256'), 'hex');
$fingerprint$;
REVOKE ALL ON FUNCTION public._replay_fingerprint_20261015(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Stamp the receipt a body just wrote with who asked (auth.uid(), never a parameter) and exactly
-- what they asked for. Only a fresh, unbound receipt is stamped; if the body wrote none (or an
-- already-bound one), the whole call is refused and rolled back, so an unbound receipt for a wrapped
-- operation can never be committed. Deliberately NOT SECURITY DEFINER: it is only ever called from
-- the definer wrappers below, so it already runs with their owner's rights, and lends none.
CREATE FUNCTION public._bind_replay_receipt_20261015(
  p_key text,
  p_operation text,
  p_fingerprint text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $bind$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor,
         request_fingerprint = p_fingerprint
   WHERE idempotency_key = p_key
     AND operation = p_operation
     AND request_actor_id IS NULL
     AND request_fingerprint IS NULL;
  IF NOT FOUND THEN
    -- Bare code: the app matches the message exactly (src/lib/idempotency.ts).
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'
      USING DETAIL = format('%s wrote no receipt to bind for this key', p_operation);
  END IF;
END;
$bind$;
REVOKE ALL ON FUNCTION public._bind_replay_receipt_20261015(text, text, text) FROM PUBLIC, anon, authenticated, service_role;

-- Commit-time guard: a receipt for one of the nine operations must be bound (actor and fingerprint)
-- by the time its transaction commits, whether it was inserted or later updated (an UPDATE that
-- cleared a binding column would otherwise turn a good receipt into a refused legacy one). The wrappers insert through the renamed body and bind right
-- after, so the check is DEFERRED to commit. It refuses an old body still running across the apply,
-- and any other writer, from committing an unbound receipt. A receipt deleted before commit (the
-- expiry clean-up) is ignored. SECURITY DEFINER on purpose: a deferred trigger runs at COMMIT under
-- the role active then (on PostgreSQL 17, the caller's session role, e.g. authenticated, after the
-- definer RPC has returned), and that role cannot see idempotency_keys rows (RLS USING (false)), so
-- an invoker guard would find nothing and let an unbound receipt commit. It reads one row by id and
-- writes nothing.
CREATE FUNCTION public._require_bound_replay_receipt_20261015()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $require_bound$
BEGIN
  IF EXISTS (SELECT 1 FROM public.idempotency_keys k
              WHERE k.id = NEW.id
                AND (k.request_actor_id IS NULL OR k.request_fingerprint IS NULL)) THEN
    RAISE EXCEPTION 'REPLAY_RECEIPT_UNBOUND'
      USING DETAIL = format('a %s receipt was not bound to its caller and request before commit', NEW.operation);
  END IF;
  RETURN NULL;
END;
$require_bound$;
REVOKE ALL ON FUNCTION public._require_bound_replay_receipt_20261015() FROM PUBLIC, anon, authenticated, service_role;

CREATE CONSTRAINT TRIGGER require_bound_replay_receipt_20261015
  AFTER INSERT OR UPDATE ON public.idempotency_keys
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.operation IN ('void_payment', 'delete_prepay_credit', 'edit_prepay_credit', 'apply_write_off', 'reverse_write_off', 'apply_prepay_to_invoice', 'create_prepay_check_splits', 'batch_apply_prepayments', 'batch_void_invoices'))
  EXECUTE FUNCTION public._require_bound_replay_receipt_20261015();

-- ---------------------------------------------------------------------------------------------
-- 1. void_payment
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.void_payment(uuid, text, uuid, text) RENAME TO _void_payment_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._void_payment_replay_impl_20261015(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.void_payment(
  p_allocation_set_id uuid,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: void_payment requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'allocation_set_id', p_allocation_set_id,
    'reason', p_reason
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'void_payment', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'string' THEN
    -- The body stores to_jsonb(<allocation set uuid>), a JSON string.
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._void_payment_replay_impl_20261015(p_allocation_set_id, p_reason, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'void_payment', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.void_payment(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_payment(uuid, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. delete_prepay_credit
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.delete_prepay_credit(uuid, text, uuid, text) RENAME TO _delete_prepay_credit_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._delete_prepay_credit_replay_impl_20261015(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.delete_prepay_credit(
  p_credit_id uuid,
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
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- An ACTIVE admin only. The renamed body's own role test is weaker (see the header).
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required to delete prepay credits';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: delete_prepay_credit requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'credit_id', p_credit_id,
    'reason', p_reason
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'delete_prepay_credit', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._delete_prepay_credit_replay_impl_20261015(p_credit_id, p_reason, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'delete_prepay_credit', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.delete_prepay_credit(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_prepay_credit(uuid, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. edit_prepay_credit
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.edit_prepay_credit(uuid, bigint, text, text, text, uuid, text) RENAME TO _edit_prepay_credit_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._edit_prepay_credit_replay_impl_20261015(uuid, bigint, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.edit_prepay_credit(
  p_credit_id uuid,
  p_new_balance_cents bigint DEFAULT NULL::bigint,
  p_reference_number text DEFAULT NULL::text,
  p_bucket_label text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
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
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- An ACTIVE admin only. The renamed body's own role test is weaker (see the header).
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required to edit prepay credits';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: edit_prepay_credit requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'credit_id', p_credit_id,
    'new_balance_cents', p_new_balance_cents,
    'reference_number', p_reference_number,
    'bucket_label', p_bucket_label,
    'notes', p_notes
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'edit_prepay_credit', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._edit_prepay_credit_replay_impl_20261015(p_credit_id, p_new_balance_cents, p_reference_number, p_bucket_label, p_notes, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'edit_prepay_credit', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.edit_prepay_credit(uuid, bigint, text, text, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.edit_prepay_credit(uuid, bigint, text, text, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. apply_write_off
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.apply_write_off(uuid, bigint, text, uuid, text) RENAME TO _apply_write_off_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._apply_write_off_replay_impl_20261015(uuid, bigint, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.apply_write_off(
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result uuid;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: apply_write_off requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'invoice_id', p_invoice_id,
    'amount_cents', p_amount_cents,
    'reason', p_reason
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'apply_write_off', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._apply_write_off_replay_impl_20261015(p_invoice_id, p_amount_cents, p_reason, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'apply_write_off', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.apply_write_off(uuid, bigint, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_write_off(uuid, bigint, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 5. reverse_write_off
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.reverse_write_off(uuid, text, uuid, text) RENAME TO _reverse_write_off_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._reverse_write_off_replay_impl_20261015(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.reverse_write_off(
  p_write_off_id uuid,
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
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- An ACTIVE admin only. The renamed body's own role test is weaker (see the header).
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required to reverse write-offs';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: reverse_write_off requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'write_off_id', p_write_off_id,
    'reason', p_reason
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'reverse_write_off', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._reverse_write_off_replay_impl_20261015(p_write_off_id, p_reason, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'reverse_write_off', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.reverse_write_off(uuid, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_write_off(uuid, text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. apply_prepay_to_invoice (also called by name, with no key, from _batch_apply_prepayments_impl)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.apply_prepay_to_invoice(uuid, uuid, bigint, uuid, text) RENAME TO _apply_prepay_to_invoice_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._apply_prepay_to_invoice_replay_impl_20261015(uuid, uuid, bigint, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.apply_prepay_to_invoice(
  p_prepay_credit_id uuid,
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result uuid;
BEGIN
  IF p_idempotency_key IS NULL THEN
    -- Only the batch path may call without a key; it runs under its own bound key.
    IF current_setting('crx.batch_apply_prepayments_internal', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: apply_prepay_to_invoice requires p_idempotency_key' USING ERRCODE = '22023';
    END IF;
    RETURN public._apply_prepay_to_invoice_replay_impl_20261015(p_prepay_credit_id, p_invoice_id, p_amount_cents, p_performed_by, NULL);
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'prepay_credit_id', p_prepay_credit_id,
    'invoice_id', p_invoice_id,
    'amount_cents', p_amount_cents
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'apply_prepay_to_invoice', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._apply_prepay_to_invoice_replay_impl_20261015(p_prepay_credit_id, p_invoice_id, p_amount_cents, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'apply_prepay_to_invoice', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.apply_prepay_to_invoice(uuid, uuid, bigint, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_prepay_to_invoice(uuid, uuid, bigint, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. create_prepay_check_splits
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.create_prepay_check_splits(uuid, text, jsonb, uuid, text, bigint) RENAME TO _create_prepay_check_splits_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._create_prepay_check_splits_replay_impl_20261015(uuid, text, jsonb, uuid, text, bigint) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.create_prepay_check_splits(
  p_customer_id uuid,
  p_reference_number text,
  p_splits jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_expected_total_cents bigint DEFAULT NULL::bigint
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_prepay_check_splits requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- p_splits is fingerprinted as sent: a reordered split list is a different request.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'customer_id', p_customer_id,
    'reference_number', p_reference_number,
    'splits', p_splits,
    'expected_total_cents', p_expected_total_cents
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_prepay_check_splits', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._create_prepay_check_splits_replay_impl_20261015(p_customer_id, p_reference_number, p_splits, p_performed_by, p_idempotency_key, p_expected_total_cents);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_prepay_check_splits', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_prepay_check_splits(uuid, text, jsonb, uuid, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_prepay_check_splits(uuid, text, jsonb, uuid, text, bigint) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 8. batch_apply_prepayments (its renamed body still delegates to _batch_apply_prepayments_impl)
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.batch_apply_prepayments(jsonb, uuid, text) RENAME TO _batch_apply_prepayments_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._batch_apply_prepayments_replay_impl_20261015(jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.batch_apply_prepayments(
  p_allocations jsonb,
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
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: batch_apply_prepayments requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- Same codes and strictness as the renamed body: the caller must name itself (NULL refused).
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH' USING ERRCODE = '42501';
  END IF;
  -- Same check, code and message as the renamed body, made before the receipt is read.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
  -- p_allocations is fingerprinted as sent: a reordered allocation list is a different request.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'allocations', p_allocations
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'batch_apply_prepayments', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  IF v_replay IS NOT NULL THEN
    -- Exact actor + intent match: the stored receipt is exactly what the body returned.
    RETURN v_replay -> 'result';
  END IF;
  -- Its body applies each allocation through apply_prepay_to_invoice with no key; mark this
  -- transaction so that wrapper accepts those (and only those) keyless calls.
  PERFORM set_config('crx.batch_apply_prepayments_internal', '1', true);
  v_result := public._batch_apply_prepayments_replay_impl_20261015(p_allocations, p_performed_by, p_idempotency_key);
  PERFORM set_config('crx.batch_apply_prepayments_internal', '', true);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'batch_apply_prepayments', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.batch_apply_prepayments(jsonb, uuid, text) IS
  'Admin-only prepay batch application. Binds a keyed replay to auth.uid() and the exact allocation list (20261016060000), then delegates to _batch_apply_prepayments_replay_impl_20261015, which enforces AUTH_REQUIRED, ACTOR_MISMATCH and is_admin() before _batch_apply_prepayments_impl.';
REVOKE ALL ON FUNCTION public._batch_apply_prepayments_impl(jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 9. batch_void_invoices
-- ---------------------------------------------------------------------------------------------
ALTER FUNCTION public.batch_void_invoices(uuid[], text, uuid, text) RENAME TO _batch_void_invoices_replay_impl_20261015;
REVOKE ALL ON FUNCTION public._batch_void_invoices_replay_impl_20261015(uuid[], text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.batch_void_invoices(
  p_invoice_ids uuid[],
  p_void_reason text,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result integer;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: batch_void_invoices requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- The body treats the ids as a set (WHERE id = ANY), so the fingerprint does too.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'invoice_ids', to_jsonb(ARRAY(SELECT DISTINCT u.id FROM unnest(p_invoice_ids) AS u(id) ORDER BY u.id)),
    'void_reason', p_void_reason
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'batch_void_invoices', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  v_result := public._batch_void_invoices_replay_impl_20261015(p_invoice_ids, p_void_reason, p_performed_by, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'batch_void_invoices', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.batch_void_invoices(uuid[], text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_void_invoices(uuid[], text, uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------------------------
DO $postflight$
DECLARE
  v_bad text;
BEGIN
  IF to_regclass('pg_temp.money_replay_binding_batch1_tx') IS NULL THEN
    RAISE EXCEPTION 'MONEY_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.money_replay_binding_batch1_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'MONEY_REPLAY_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  SELECT string_agg(pin.name, ', ' ORDER BY pin.name) INTO v_bad
    FROM (VALUES
      ('void_payment', 'p_allocation_set_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '70fd746c15f4a6629680a724f3588967'),
      ('delete_prepay_credit', 'p_credit_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', 'bcb90bd23619af6f1e45c69bb2db4169'),
      ('edit_prepay_credit', 'p_credit_id uuid, p_new_balance_cents bigint DEFAULT NULL::bigint, p_reference_number text DEFAULT NULL::text, p_bucket_label text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '366db16a403a0f508b28aadc8862475c'),
      ('apply_write_off', 'p_invoice_id uuid, p_amount_cents bigint, p_reason text, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'uuid', '00e8d020f9faf6276de8ddaf4f1411fc'),
      ('reverse_write_off', 'p_write_off_id uuid, p_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '70ef11ccad193eb6ef5ee88dcba6f8cd'),
      ('apply_prepay_to_invoice', 'p_prepay_credit_id uuid, p_invoice_id uuid, p_amount_cents bigint, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'uuid', 'c9377dab8f2534a03af2c27a6e1d510c'),
      ('create_prepay_check_splits', 'p_customer_id uuid, p_reference_number text, p_splits jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text, p_expected_total_cents bigint DEFAULT NULL::bigint', 'jsonb', '6a164940dfac7afd05d06612e702bb52'),
      ('batch_apply_prepayments', 'p_allocations jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text', 'jsonb', '15624992c9375e08a0ec1914437e6e40'),
      ('batch_void_invoices', 'p_invoice_ids uuid[], p_void_reason text, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text', 'integer', '32fa9718f29e18c8eff4539e36ac84b3')
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
    RAISE EXCEPTION 'POSTFLIGHT_MONEY_REPLAY_CONTRACT: wrapper or renamed body drifted for: %', v_bad;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY['public._replay_fingerprint_20261015(jsonb)',
                        'public._bind_replay_receipt_20261015(text,text,text)']) AS h(sig)
      CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS api_role
     WHERE to_regprocedure(h.sig) IS NULL
        OR has_function_privilege(api_role, to_regprocedure(h.sig), 'EXECUTE')
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._bind_replay_receipt_20261015(text,text,text)') AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_HELPER_CONTRACT: both replay-binding helpers must exist, callable by no API role, and the binder must not be SECURITY DEFINER';
  END IF;

  -- The commit-time guard: one enabled, deferred AFTER INSERT OR UPDATE row trigger on idempotency_keys,
  -- running the guard function, which no API role may call.
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.idempotency_keys'::regclass
         AND t.tgname = 'require_bound_replay_receipt_20261015'
         AND t.tgfoid = to_regprocedure('public._require_bound_replay_receipt_20261015()')
         AND t.tgenabled = 'O' AND t.tgconstraint <> 0 AND t.tgdeferrable AND t.tginitdeferred
         AND (t.tgtype::int & 1) = 1      -- ROW level
         AND (t.tgtype::int & 2) = 0      -- AFTER
         AND (t.tgtype::int & 4) <> 0     -- INSERT
         AND (t.tgtype::int & 16) <> 0    -- UPDATE
     ) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_proc p
                     WHERE p.oid = to_regprocedure('public._require_bound_replay_receipt_20261015()')
                       AND p.prosecdef AND p.proowner = 'postgres'::regrole
                       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[])
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS api_role
                 WHERE has_function_privilege(api_role, 'public._require_bound_replay_receipt_20261015()', 'EXECUTE')) THEN
    RAISE EXCEPTION 'POSTFLIGHT_RECEIPT_GUARD_CONTRACT: the deferred bound-receipt guard (a postgres-owned SECURITY DEFINER function no API role may call) is not installed as reviewed';
  END IF;

  -- The private batch impl is callable only by postgres now.
  IF ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
             FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
            WHERE p.oid = to_regprocedure('public._batch_apply_prepayments_impl(jsonb,uuid,text)')
              AND a.privilege_type = 'EXECUTE' ORDER BY 1)
       IS DISTINCT FROM ARRAY['postgres']::text[] THEN
    RAISE EXCEPTION 'POSTFLIGHT_BATCH_APPLY_IMPL_ACL: _batch_apply_prepayments_impl must be callable only by postgres';
  END IF;

  RAISE NOTICE 'POSTFLIGHT_OK: nine money RPCs now replay a stored result only for the same person and the exact same request';
END
$postflight$;
