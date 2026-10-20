-- Written 2026-10-19. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: one server call that starts AND completes a delivery in a single transaction, for the
--   Deliveries list's Mark Delivered (KNOWN_ISSUES.md, "the Deliveries list can leave a scheduled
--   delivery In Progress if signal drops between its two steps"). Today the list calls
--   confirm_delivery (scheduled -> in_progress) and then complete_delivery as two requests; signal
--   lost in the instant after the first answers leaves the delivery In Progress. Here both steps
--   run in one transaction: either the delivery ends completed or nothing changed.
--
--   start_and_complete_delivery(p_delivery_id, p_signed_by, p_delivered_on, p_performed_by,
--                               p_quantities, p_issue_type, p_issue_notes, p_idempotency_key)
--     1. requires a key (IDEMPOTENCY_KEY_REQUIRED, 22023), auth.uid() (AUTH_REQUIRED) and refuses a
--        p_performed_by naming someone else (ACTOR_MISMATCH) -- complete_delivery's tests and
--        messages;
--     2. requires p_delivered_on, the business date the person chose (America/Chicago), and refuses
--        one that is not a real date (DELIVERED_ON_INVALID), after today's Chicago date
--        (DELIVERED_ON_IN_FUTURE), or (checked in step 4, after the receipt lookup, because the
--        bound moves with the clock) more than a calendar year back (DELIVERED_ON_TOO_OLD: a typo
--        year would date the invoice outside any accounting period);
--     3. locks the delivery row and runs complete_delivery's authorization test (active admin or
--        sales_rep, or the assigned driver) BEFORE the receipt lookup, as complete_delivery's own
--        body authorizes before replaying, so a driver taken off the delivery or a deactivated
--        account gets neither a replayed completion nor a refusal carrying the saved result;
--     4. fingerprints the actor and every argument (SHA-256, _replay_fingerprint_20261015) and calls
--        check_idempotency_intent under the per-key advisory lock. An exact retry by the same person
--        returns the saved result; a different person or request is refused
--        (IDEMPOTENCY_ACTOR_MISMATCH / IDEMPOTENCY_INTENT_MISMATCH). The fingerprint carries the
--        chosen DATE, not a derived timestamp, so an exact retry across Chicago midnight replays.
--        Only a call that is not a replay then meets the one-year bound. Then, if the delivery is scheduled, starts it by calling confirm_delivery keyless
--        (unchanged: same status change, activity row, driver notification and authorization);
--     5. completes it by calling complete_delivery under a derived key (<key>:complete), which
--        binds its own receipt as before. completed_at: NULL (the server's now()) when the chosen
--        date is today in Chicago; otherwise 17:00 UTC of the chosen date (noon CDT, 11 AM CST) -- the exact
--        value the app already sends for a past date (src/lib/paperTicket.ts
--        completedAtForDeliveredOn). So a "today" completion that reaches the server just after
--        Chicago midnight keeps the chosen day instead of moving to the next. Such a completion is
--        then dated a past day, so for an order with field allocations complete_delivery treats it
--        like any backdated completion (split drafts flagged for the office instead of created);
--     6. saves its own receipt (save_idempotency) and binds it to the caller and fingerprint
--        (_bind_replay_receipt_20261015) before returning complete_delivery's result plus
--        "started" (true when step 4 ran).
--   Any refusal in step 4 or 5 (authorization, status, closed period, stock) raises and rolls the
--   whole call back, including the start.
--
-- WHAT DOES NOT CHANGE: confirm_delivery and complete_delivery and the private chain under it are
--   not edited; no stock, invoice or period logic is retyped; no table, row, policy, trigger or
--   existing grant changes. The other screens (DeliveryDetail, FieldStop, FieldView) keep their
--   own calls.
--
-- COMMIT-TIME GUARD: the deferred trigger require_bound_replay_receipt_20261015 is not extended to
--   this operation. Only this function writes a 'start_and_complete_delivery' receipt, and it binds
--   it in the same call (_bind_replay_receipt_20261015 raises IDEMPOTENCY_RECEIPT_MISSING if none
--   was written). save_idempotency is not executable by authenticated, and an unbound receipt
--   could only ever be refused by check_idempotency_intent (it fails closed). The inner
--   complete_delivery receipt is covered by that trigger already. Recreating the trigger here
--   would race the other replay-binding batches that recreate it.
--
-- ORDERING: the live ledger read 2026-10-19 21:2x UTC has 20261019205246
--   (20261019200000_bind_delivery_job_replay_receipts_batch3a) as its newest row, effective stamp
--   20261019200000; this file sorts above it and needs that batch live (the preflight checks it).
--
-- GRANTS: EXECUTE for authenticated only (revoked from PUBLIC, anon and service_role; service_role
--   has no auth.uid() and would only ever get AUTH_REQUIRED); SECURITY DEFINER with
--   search_path = public, pg_temp. The function runs as its owner so it can call the
--   postgres-only helpers; every caller check above uses auth.uid(), and confirm_delivery and
--   complete_delivery re-check authorization on the caller.
--
-- ROLLBACK: DROP FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text,
--   text, text); the app would then need its previous two-call version.

-- PREFLIGHT: every function this one calls exists with the signature it calls (PL/pgSQL resolves
-- calls only at run time, so a missing one would otherwise fail mid-completion), batch 3a is live
-- (complete_delivery is the bound wrapper), and this function does not exist yet.
DO $preflight$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.confirm_delivery(uuid,uuid,text)',
    'public.complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamptz)',
    'public._complete_delivery_replay_impl_20261015(uuid,text,uuid,jsonb,text,text,text,timestamptz)',
    'public.check_idempotency_intent(text,text,uuid,text)',
    'public.save_idempotency(text,text,jsonb)',
    'public._bind_replay_receipt_20261015(text,text,text)',
    'public._replay_fingerprint_20261015(jsonb)'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_START_AND_COMPLETE_DEPENDENCY_MISSING: %', v_sig;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'start_and_complete_delivery') THEN
    RAISE EXCEPTION 'PREFLIGHT_START_AND_COMPLETE_ALREADY_EXISTS';
  END IF;
END;
$preflight$;

CREATE FUNCTION public.start_and_complete_delivery(
  p_delivery_id uuid,
  p_signed_by text,
  p_delivered_on date,
  p_performed_by uuid DEFAULT NULL,
  p_quantities jsonb DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_issue_notes text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_completed_at timestamptz;
  v_fingerprint text;
  v_replay jsonb;
  v_status text;
  v_assigned_driver uuid;
  v_actor_role text;
  v_started boolean := false;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: start_and_complete_delivery requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF p_delivered_on IS NULL THEN
    RAISE EXCEPTION 'DELIVERED_ON_REQUIRED: choose the delivery date' USING ERRCODE = '22023';
  END IF;
  -- A real date no more than a year back: refuses +/-infinity and typo years, which would otherwise
  -- date the delivery and its invoice outside any accounting period.
  IF NOT isfinite(p_delivered_on) THEN
    RAISE EXCEPTION 'DELIVERED_ON_INVALID: % is not a real date', p_delivered_on USING ERRCODE = '22023';
  END IF;
  IF p_delivered_on > v_today THEN
    RAISE EXCEPTION 'DELIVERED_ON_IN_FUTURE: the delivery date % is after today (%)', p_delivered_on, v_today
      USING ERRCODE = '22023';
  END IF;
  -- The one-year bound moves with the clock, so it runs after the receipt lookup below: an exact
  -- retry of a completion saved on the oldest allowed date, landing after Chicago midnight, still
  -- replays instead of being refused. A date valid when sent never becomes a future date.

  -- complete_delivery's own test, run BEFORE the receipt lookup, so a driver taken off the
  -- delivery or a deactivated account gets neither a replayed completion nor a refusal that
  -- carries the saved result (check_idempotency_intent's intent-mismatch DETAIL).
  SELECT status, assigned_driver INTO v_status, v_assigned_driver
    FROM public.deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery not found: %', p_delivery_id;
  END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  -- p_quantities is fingerprinted as sent (jsonb normalizes key order); the chosen date, not a
  -- derived instant, so an exact retry keeps its fingerprint across Chicago midnight.
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'delivery_id', p_delivery_id,
    'signed_by', p_signed_by,
    'delivered_on', p_delivered_on,
    'quantities', p_quantities,
    'issue_type', p_issue_type,
    'issue_notes', p_issue_notes
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'start_and_complete_delivery', v_actor, v_fingerprint);

  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  IF p_delivered_on < (v_today - interval '1 year')::date THEN
    RAISE EXCEPTION 'DELIVERED_ON_TOO_OLD: the delivery date % is more than a year before today (%)', p_delivered_on, v_today
      USING ERRCODE = '22023';
  END IF;

  IF v_status = 'scheduled' THEN
    PERFORM public.confirm_delivery(p_delivery_id, v_actor, NULL);
    v_started := true;
  END IF;

  IF p_delivered_on < v_today THEN
    -- 17:00 UTC of the chosen date (noon CDT, 11 AM CST): the same instant the app already sends
    -- for a past date (completedAtForDeliveredOn), and always the chosen date in Chicago.
    v_completed_at := (p_delivered_on + time '17:00') AT TIME ZONE 'UTC';
  END IF;

  v_result := public.complete_delivery(
    p_delivery_id,
    p_signed_by,
    v_actor,
    p_quantities,
    p_issue_type,
    p_issue_notes,
    p_idempotency_key || ':complete',
    v_completed_at
  );
  IF v_result IS NULL OR jsonb_typeof(v_result) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'COMPLETE_DELIVERY_RESULT_INVALID';
  END IF;
  v_result := v_result || jsonb_build_object('started', v_started);

  PERFORM public.save_idempotency(p_idempotency_key, 'start_and_complete_delivery', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'start_and_complete_delivery', v_fingerprint);
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text) TO authenticated;

COMMENT ON FUNCTION public.start_and_complete_delivery(uuid, text, date, uuid, jsonb, text, text, text) IS
  'Deliveries list Mark Delivered: starts a scheduled delivery (confirm_delivery) and completes it (complete_delivery) in one transaction, on the chosen America/Chicago business date. Key required and bound to caller + request.';
