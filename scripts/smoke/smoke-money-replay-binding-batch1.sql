-- ============================================================================
-- SMOKE TEST (rolled back by design) for 20261016060000_bind_money_replay_receipts_batch1.
--
-- Rule under test: a stored idempotency receipt is replayed only to the person who wrote it, and
-- only for the exact same request. A retry that reuses a key for a different record, different
-- amounts, or from a different person is refused (IDEMPOTENCY_INTENT_MISMATCH /
-- IDEMPOTENCY_ACTOR_MISMATCH) and changes nothing; an exact retry still returns the original
-- answer and is never done twice; a call with no key is refused (IDEMPOTENCY_KEY_REQUIRED).
--
-- Covers the nine wrapped money RPCs: void_payment, delete_prepay_credit, edit_prepay_credit,
-- apply_write_off, reverse_write_off, apply_prepay_to_invoice, create_prepay_check_splits,
-- batch_apply_prepayments, batch_void_invoices. Before the migration each "different record"
-- step fails with SMOKE_FAIL (the old bodies hand back the first record's receipt as success);
-- step 1 is first, so the chain fails there.
--
-- HOW TO RUN: as ONE statement (Supabase MCP execute_sql, run-smoke.mjs, or psql inside a
-- transaction that rolls back). It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK': that
-- exact text = PASS; any other error = FAIL. Nothing persists.
--
-- Auth: auth.uid() reads request.jwt.claims, set with set_config(..., true) to two REAL active
-- admin profiles found at run time (SMOKE_SETUP if fewer than two exist). Fixture INSERTs run as
-- the table owner; the RPCs under test enforce their own role checks.
--
-- Non-transactional side effects: none. Every invoice is inserted with an explicit
-- [SMOKE] invoice number (no sequence), and none of the nine RPCs or their callees draws a number
-- (checked by the container prover, which compares every sequence before and after this chain).
-- Precondition: today is not inside a CLOSED accounting period (SMOKE_SETUP otherwise).
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_admin_b uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_key text;
  v_customer uuid;
  v_inv uuid[] := ARRAY[]::uuid[];
  v_id uuid;
  v_credit_1 uuid;
  v_credit_2 uuid;
  v_credit_3 uuid;
  v_set_1 uuid;
  v_set_2 uuid;
  v_wo_1 uuid;
  v_wo_2 uuid;
  v_app uuid;
  v_res jsonb;
  v_res2 jsonb;
  v_n int;
  v_i int;
  v_cents bigint;
  v_status text;
  v_err text;
  v_sql text;
BEGIN
  -- --------------------------------------------------------------------------------------------
  -- 0. Preconditions, two real admins, fixtures.
  -- --------------------------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.accounting_periods
              WHERE status = 'closed' AND CURRENT_DATE BETWEEN period_start AND period_end) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: today falls in a CLOSED accounting period';
  END IF;
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_admin_b FROM public.profiles
   WHERE role = 'admin' AND is_active = true AND id IS DISTINCT FROM v_admin ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL OR v_admin_b IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: two active admin profiles are required';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- An explicit account number: the column default draws from customer_account_number_seq, which a
  -- rollback does not return.
  INSERT INTO public.customers (farm_name, account_number)
  VALUES ('[SMOKE] Replay Binding Farm ' || v_suffix, '[SMOKE]-RPB-' || v_suffix)
  RETURNING id INTO v_customer;
  -- Seven posted $500.00 invoices (draft insert, then the enforcer-legal draft -> posted update).
  FOR v_i IN 1..7 LOOP
    INSERT INTO public.invoices (customer_id, invoice_number, invoice_type, status, total_amount_cents,
                                 created_by, invoice_date)
    VALUES (v_customer, '[SMOKE]-RPB-' || v_i || '-' || v_suffix, 'chemical_sale', 'draft', 50000,
            v_admin, CURRENT_DATE)
    RETURNING id INTO v_id;
    UPDATE public.invoices SET status = 'posted', posted_by = v_admin, posted_at = now() WHERE id = v_id;
    v_inv := v_inv || v_id;
  END LOOP;
  -- Three $300.00 prepay credits.
  INSERT INTO public.prepay_credits (customer_id, season, original_amount_cents, balance_cents,
                                     source_type, source_reference, notes, created_by)
  VALUES (v_customer, public.current_season(), 30000, 30000, 'manual', '[SMOKE]-RPB-C1-' || v_suffix, '[SMOKE] credit 1', v_admin)
  RETURNING id INTO v_credit_1;
  INSERT INTO public.prepay_credits (customer_id, season, original_amount_cents, balance_cents,
                                     source_type, source_reference, notes, created_by)
  VALUES (v_customer, public.current_season(), 30000, 30000, 'manual', '[SMOKE]-RPB-C2-' || v_suffix, '[SMOKE] credit 2', v_admin)
  RETURNING id INTO v_credit_2;
  INSERT INTO public.prepay_credits (customer_id, season, original_amount_cents, balance_cents,
                                     source_type, source_reference, notes, created_by)
  VALUES (v_customer, public.current_season(), 30000, 30000, 'manual', '[SMOKE]-RPB-C3-' || v_suffix, '[SMOKE] credit 3', v_admin)
  RETURNING id INTO v_credit_3;
  UPDATE public.customers SET prepay_balance_cents = 90000 WHERE id = v_customer;

  -- Two payments, each a partial $10.00 on invoice 1, so the invoice stays posted.
  v_res := public.allocate_payment(v_customer, 1000, 'check', '[SMOKE]-RPB-P1-' || v_suffix, NULL, CURRENT_DATE,
    '[SMOKE] payment 1', jsonb_build_array(jsonb_build_object('invoice_id', v_inv[1], 'amount_cents', 1000)),
    v_admin, 'smk-rpb-' || v_suffix || '-alloc-1');
  v_set_1 := (v_res->>'allocation_set_id')::uuid;
  v_res := public.allocate_payment(v_customer, 1000, 'check', '[SMOKE]-RPB-P2-' || v_suffix, NULL, CURRENT_DATE,
    '[SMOKE] payment 2', jsonb_build_array(jsonb_build_object('invoice_id', v_inv[1], 'amount_cents', 1000)),
    v_admin, 'smk-rpb-' || v_suffix || '-alloc-2');
  v_set_2 := (v_res->>'allocation_set_id')::uuid;
  IF v_set_1 IS NULL OR v_set_2 IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: allocate_payment did not return allocation sets';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 1. void_payment: a key reused for a DIFFERENT payment is refused; payment 2 stays active.
  -- --------------------------------------------------------------------------------------------
  v_key := 'smk-rpb-' || v_suffix || '-void-payment';
  v_res := public.void_payment(v_set_1, '[SMOKE] void reason', v_admin, v_key);
  IF (v_res->>'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void_payment on payment 1 did not succeed: %', v_res;
  END IF;
  BEGIN
    v_res := public.void_payment(v_set_2, '[SMOKE] void reason', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: void_payment replayed another payment''s receipt as success for payment 2: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong void_payment refusal: %', SQLERRM;
    END IF;
  END;
  IF NOT (SELECT is_active FROM public.allocation_sets WHERE id = v_set_2) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: payment 2 was voided by a refused call';
  END IF;
  -- The exact retry replays (no second void, no "already voided" error).
  v_res := public.void_payment(v_set_1, '[SMOKE] void reason', v_admin, v_key);
  IF (v_res->>'idempotent')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact void_payment retry did not replay: %', v_res;
  END IF;
  -- A changed reason with the same key is a different request.
  BEGIN
    v_res := public.void_payment(v_set_1, '[SMOKE] another reason', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: void_payment replayed a receipt for a changed reason: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong void_payment changed-reason refusal: %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------------------------------
  -- 2. delete_prepay_credit: a key reused for a DIFFERENT credit is refused; credit 2 untouched.
  -- --------------------------------------------------------------------------------------------
  v_key := 'smk-rpb-' || v_suffix || '-delete-credit';
  v_res := public.delete_prepay_credit(v_credit_1, '[SMOKE] delete reason', v_admin, v_key);
  BEGIN
    v_res := public.delete_prepay_credit(v_credit_2, '[SMOKE] delete reason', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: delete_prepay_credit replayed another credit''s receipt as success for credit 2: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong delete_prepay_credit refusal: %', SQLERRM;
    END IF;
  END;
  IF (SELECT balance_cents FROM public.prepay_credits WHERE id = v_credit_2) <> 30000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: credit 2 changed under a refused delete';
  END IF;
  v_res := public.delete_prepay_credit(v_credit_1, '[SMOKE] delete reason', v_admin, v_key);
  IF (v_res->>'idempotent')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact delete_prepay_credit retry did not replay: %', v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 3. edit_prepay_credit: the same credit with a DIFFERENT new balance is refused.
  -- --------------------------------------------------------------------------------------------
  v_key := 'smk-rpb-' || v_suffix || '-edit-credit';
  v_res := public.edit_prepay_credit(v_credit_2, 25000, NULL, NULL, NULL, v_admin, v_key);
  BEGIN
    v_res := public.edit_prepay_credit(v_credit_2, 20000, NULL, NULL, NULL, v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: edit_prepay_credit replayed a receipt for a different balance: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edit_prepay_credit refusal: %', SQLERRM;
    END IF;
  END;
  IF (SELECT balance_cents FROM public.prepay_credits WHERE id = v_credit_2) <> 25000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: credit 2 balance is not the first edit''s 25000';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 4. apply_write_off: a key reused on a DIFFERENT invoice is refused; another admin is refused.
  -- --------------------------------------------------------------------------------------------
  v_key := 'smk-rpb-' || v_suffix || '-write-off';
  v_wo_1 := public.apply_write_off(v_inv[2], 1000, '[SMOKE] write-off', v_admin, v_key);
  BEGIN
    v_id := public.apply_write_off(v_inv[3], 1000, '[SMOKE] write-off', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: apply_write_off replayed invoice 2''s write-off as success for invoice 3: %', v_id;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong apply_write_off refusal: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.write_offs WHERE invoice_id = v_inv[3]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice 3 got a write-off from a refused call';
  END IF;
  v_id := public.apply_write_off(v_inv[2], 1000, '[SMOKE] write-off', v_admin, v_key);
  IF v_id IS DISTINCT FROM v_wo_1 OR (SELECT count(*) FROM public.write_offs WHERE invoice_id = v_inv[2]) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact apply_write_off retry did not replay the first write-off';
  END IF;
  -- Another admin presenting the first admin's key for the identical request is refused.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin_b::text, true);
  BEGIN
    v_id := public.apply_write_off(v_inv[2], 1000, '[SMOKE] write-off', NULL, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: a second admin replayed the first admin''s write-off key';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong cross-admin refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  -- No key: refused before anything is written (a keyless call would leave no receipt to replay).
  BEGIN
    v_id := public.apply_write_off(v_inv[3], 1000, '[SMOKE] write-off without key', v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: apply_write_off ran without an idempotency key: %', v_id;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless apply_write_off refusal: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.write_offs WHERE invoice_id = v_inv[3]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a keyless apply_write_off wrote a write-off';
  END IF;
  -- A second write-off (for step 5), with its own key.
  v_wo_2 := public.apply_write_off(v_inv[3], 1000, '[SMOKE] second write-off', v_admin, 'smk-rpb-' || v_suffix || '-write-off-2');
  IF v_wo_2 IS NULL OR v_wo_2 = v_wo_1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the second write-off was not written';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 5. reverse_write_off: a key reused for a DIFFERENT write-off is refused; write-off 2 stays.
  -- --------------------------------------------------------------------------------------------
  v_key := 'smk-rpb-' || v_suffix || '-reverse-write-off';
  v_res := public.reverse_write_off(v_wo_1, '[SMOKE] reverse reason', v_admin, v_key);
  BEGIN
    v_res := public.reverse_write_off(v_wo_2, '[SMOKE] reverse reason', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: reverse_write_off replayed write-off 1''s reversal as success for write-off 2: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong reverse_write_off refusal: %', SQLERRM;
    END IF;
  END;
  IF (SELECT reversed_at FROM public.write_offs WHERE id = v_wo_2) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: write-off 2 was reversed by a refused call';
  END IF;
  v_res2 := public.reverse_write_off(v_wo_1, '[SMOKE] reverse reason', v_admin, v_key);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact reverse_write_off retry did not replay: % vs %', v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 6. apply_prepay_to_invoice: a key reused on a DIFFERENT invoice is refused.
  -- --------------------------------------------------------------------------------------------
  v_key := 'smk-rpb-' || v_suffix || '-apply-prepay';
  v_app := public.apply_prepay_to_invoice(v_credit_3, v_inv[4], 1000, v_admin, v_key);
  BEGIN
    v_id := public.apply_prepay_to_invoice(v_credit_3, v_inv[5], 1000, v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: apply_prepay_to_invoice replayed invoice 4''s application as success for invoice 5: %', v_id;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong apply_prepay_to_invoice refusal: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.prepay_applications WHERE invoice_id = v_inv[5]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice 5 got a prepay application from a refused call';
  END IF;
  IF public.apply_prepay_to_invoice(v_credit_3, v_inv[4], 1000, v_admin, v_key) IS DISTINCT FROM v_app THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact apply_prepay_to_invoice retry did not replay';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 7. create_prepay_check_splits: the same key with a DIFFERENT check number is refused.
  -- --------------------------------------------------------------------------------------------
  v_key := 'smk-rpb-' || v_suffix || '-check-splits';
  v_res := public.create_prepay_check_splits(v_customer, '[SMOKE]-RPB-CHK1-' || v_suffix,
    jsonb_build_array(jsonb_build_object('label', 'A', 'amount_cents', 2000)), v_admin, v_key, 2000);
  BEGIN
    v_res2 := public.create_prepay_check_splits(v_customer, '[SMOKE]-RPB-CHK2-' || v_suffix,
      jsonb_build_array(jsonb_build_object('label', 'A', 'amount_cents', 2000)), v_admin, v_key, 2000);
    RAISE EXCEPTION 'SMOKE_FAIL: create_prepay_check_splits replayed check 1''s credits as success for check 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong create_prepay_check_splits refusal: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.prepay_credits WHERE reference_number = '[SMOKE]-RPB-CHK2-' || v_suffix) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: check 2 credits were created by a refused call';
  END IF;
  v_res2 := public.create_prepay_check_splits(v_customer, '[SMOKE]-RPB-CHK1-' || v_suffix,
    jsonb_build_array(jsonb_build_object('label', 'A', 'amount_cents', 2000)), v_admin, v_key, 2000);
  IF v_res2 IS DISTINCT FROM v_res
     OR (SELECT count(*) FROM public.prepay_credits WHERE reference_number = '[SMOKE]-RPB-CHK1-' || v_suffix) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact create_prepay_check_splits retry did not replay';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 8. batch_apply_prepayments: the same key with a DIFFERENT allocation list is refused.
  -- --------------------------------------------------------------------------------------------
  v_key := 'smk-rpb-' || v_suffix || '-batch-apply';
  v_res := public.batch_apply_prepayments(
    jsonb_build_array(jsonb_build_object('prepay_credit_id', v_credit_3, 'invoice_id', v_inv[4], 'amount_cents', 500)),
    v_admin, v_key);
  BEGIN
    v_res2 := public.batch_apply_prepayments(
      jsonb_build_array(jsonb_build_object('prepay_credit_id', v_credit_3, 'invoice_id', v_inv[5], 'amount_cents', 500)),
      v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: batch_apply_prepayments replayed batch 1''s applications as success for batch 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong batch_apply_prepayments refusal: %', SQLERRM;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.prepay_applications WHERE invoice_id = v_inv[5]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice 5 got a prepay application from a refused batch';
  END IF;
  v_res2 := public.batch_apply_prepayments(
    jsonb_build_array(jsonb_build_object('prepay_credit_id', v_credit_3, 'invoice_id', v_inv[4], 'amount_cents', 500)),
    v_admin, v_key);
  IF v_res2 IS DISTINCT FROM v_res
     OR (SELECT count(*) FROM public.prepay_applications WHERE invoice_id = v_inv[4]) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact batch_apply_prepayments retry did not replay';
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 9. batch_void_invoices: the same key with a DIFFERENT invoice list is refused; the same set
  --    in another order replays.
  -- --------------------------------------------------------------------------------------------
  v_key := 'smk-rpb-' || v_suffix || '-batch-void';
  v_n := public.batch_void_invoices(ARRAY[v_inv[6], v_inv[5]], '[SMOKE] void', v_admin, v_key);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: batch_void_invoices voided % invoices, expected 2', v_n;
  END IF;
  BEGIN
    v_n := public.batch_void_invoices(ARRAY[v_inv[7]], '[SMOKE] void', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: batch_void_invoices replayed batch 1''s count as success for invoice 7: %', v_n;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong batch_void_invoices refusal: %', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.invoices WHERE id = v_inv[7];
  IF v_status IS DISTINCT FROM 'posted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice 7 is % after a refused batch void', v_status;
  END IF;
  v_n := public.batch_void_invoices(ARRAY[v_inv[5], v_inv[6]], '[SMOKE] void', v_admin, v_key);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact batch_void_invoices retry (same set, other order) did not replay: %', v_n;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- 9b. Every other wrapper refuses a keyless call too (apply_write_off was step 4), including a
  --     direct keyless apply_prepay_to_invoice outside the batch path's transaction marker.
  -- --------------------------------------------------------------------------------------------
  FOREACH v_sql IN ARRAY ARRAY[
    format('SELECT public.void_payment(%L::uuid, %L, %L::uuid, NULL)', v_set_2, '[SMOKE] keyless', v_admin),
    format('SELECT public.delete_prepay_credit(%L::uuid, %L, %L::uuid, NULL)', v_credit_2, '[SMOKE] keyless', v_admin),
    format('SELECT public.edit_prepay_credit(%L::uuid, 1000, NULL, NULL, NULL, %L::uuid, NULL)', v_credit_2, v_admin),
    format('SELECT public.reverse_write_off(%L::uuid, %L, %L::uuid, NULL)', v_wo_2, '[SMOKE] keyless', v_admin),
    format('SELECT public.apply_prepay_to_invoice(%L::uuid, %L::uuid, 100, %L::uuid, NULL)', v_credit_3, v_inv[7], v_admin),
    format('SELECT public.create_prepay_check_splits(%L::uuid, %L, %L::jsonb, %L::uuid, NULL, 100)',
           v_customer, '[SMOKE]-RPB-KEYLESS-' || v_suffix, '[{"label":"A","amount_cents":100}]', v_admin),
    format('SELECT public.batch_apply_prepayments(%L::jsonb, %L::uuid, NULL)',
           jsonb_build_array(jsonb_build_object('prepay_credit_id', v_credit_3, 'invoice_id', v_inv[7], 'amount_cents', 100)), v_admin),
    format('SELECT public.batch_void_invoices(ARRAY[%L::uuid], %L, %L::uuid, NULL)', v_inv[7], '[SMOKE] keyless', v_admin)
  ] LOOP
    BEGIN
      EXECUTE v_sql;
      RAISE EXCEPTION 'SMOKE_FAIL: a keyless call ran: %', v_sql;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless refusal for %: %', v_sql, SQLERRM;
      END IF;
    END;
  END LOOP;

  -- --------------------------------------------------------------------------------------------
  -- 10. Every receipt written above is bound to the admin and carries a fingerprint, and a legacy
  --     receipt with neither binding is refused rather than replayed.
  -- --------------------------------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.idempotency_keys
   WHERE idempotency_key LIKE 'smk-rpb-' || v_suffix || '-%'
     AND operation IN ('void_payment', 'delete_prepay_credit', 'edit_prepay_credit', 'apply_write_off',
                       'reverse_write_off', 'apply_prepay_to_invoice', 'create_prepay_check_splits',
                       'batch_apply_prepayments', 'batch_void_invoices')
     AND request_actor_id = v_admin AND request_fingerprint ~ '^[0-9a-f]{64}$';
  IF v_n <> 10 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % of the 10 receipts are bound to the admin with a fingerprint', v_n;
  END IF;
  v_key := 'smk-rpb-' || v_suffix || '-legacy';
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
  VALUES (v_key, 'apply_write_off', jsonb_build_object('id', v_wo_1));
  BEGIN
    v_id := public.apply_write_off(v_inv[7], 1000, '[SMOKE] write-off', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: an unbound legacy receipt was replayed: %', v_id;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong legacy-receipt refusal: %', SQLERRM;
    END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
