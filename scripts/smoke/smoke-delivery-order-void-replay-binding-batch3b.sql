-- ============================================================================
-- SMOKE TEST (rolled back by design) for 20261019235000_bind_delivery_order_void_replay_receipts_batch3b.
--
-- CONTAINER ONLY: run through scripts/smoke/prove-delivery-order-void-replay-binding-batch3b-real-schema.mjs,
-- never against the live database. The fixtures complete deliveries on orders, which writes each
-- order's automatic draft invoice, whose customer-visible invoice number comes from
-- next_invoice_number(), which draws from a non-transactional sequence (nextval) that a rollback does
-- not return; the container prover reports which sequences this chain moves. The chain also plants
-- [SMOKE] customers, products, inventory, orders and deliveries, which the LIVE-DATA GUARD refuses.
--
-- Rule under test: cancel_delivery, void_delivery and void_order replay a stored idempotency receipt
-- only to the person who wrote it, and only for the exact same request (the record and the reason).
-- A retry that reuses a key for a different delivery/order, or with an edited reason, is refused
-- (IDEMPOTENCY_INTENT_MISMATCH) and changes nothing; a different admin presenting the key is refused
-- (IDEMPOTENCY_ACTOR_MISMATCH) and is shown nothing; an exact retry still returns the original
-- answer; a call with no key is refused (IDEMPOTENCY_KEY_REQUIRED, 22023); cancel_delivery checks the
-- caller's role before any stored result is returned (an applicator presenting an admin's key gets
-- 'Not authorized to cancel deliveries', not the admin's result). batch_cancel_deliveries still
-- cancels through cancel_delivery's body with no per-delivery key. Every fresh receipt is bound to the
-- actor with a 64-hex fingerprint.
--
-- Fail-first: before the migration step a fails (cancel_delivery hands delivery A's receipt back as
-- success for delivery B).
--
-- HOW TO RUN: as ONE statement inside a transaction that rolls back. It ALWAYS ends with RAISE
-- EXCEPTION 'SMOKE_PASS_ROLLBACK': that exact text = PASS; any other error = FAIL.
--
-- Auth: auth.uid() reads request.jwt.claims, set with set_config(..., true) to two REAL active admin
-- profiles and one REAL active applicator found at run time (SMOKE_SETUP if any is missing). Fixture
-- INSERTs run as the table owner; the RPCs under test enforce their own role checks.
-- Precondition: today is not inside a CLOSED accounting period (SMOKE_SETUP otherwise).
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_admin_b uuid;
  v_applicator uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_prefix text;
  v_key text;
  v_void_key text;
  v_order_key text;
  v_batch_key text;
  v_customer uuid;
  v_product uuid;
  v_pricing jsonb;
  v_order uuid[] := ARRAY[]::uuid[];
  v_oi uuid;
  v_id uuid;
  v_del uuid[] := ARRAY[]::uuid[];   -- 1 A, 2 B, 3 E (scheduled); 4 C, 5 D (completed); 6, 7 fulfil orders 2, 3
  v_i int;
  v_res jsonb;
  v_res2 jsonb;
  v_count int;
  v_n int;
  v_status text;
  v_state text;
  v_detail text;
BEGIN
  -- --------------------------------------------------------------------------------------------
  -- 0. Preconditions, two real admins and an applicator, fixtures.
  -- --------------------------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.accounting_periods
              WHERE status = 'closed' AND CURRENT_DATE BETWEEN period_start AND period_end) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: today falls in a CLOSED accounting period';
  END IF;
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_admin_b FROM public.profiles
   WHERE role = 'admin' AND is_active = true AND id IS DISTINCT FROM v_admin ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_applicator FROM public.profiles
   WHERE role = 'applicator' AND is_active = true ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL OR v_admin_b IS NULL OR v_applicator IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: two active admin profiles and one active applicator are required';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_prefix := 'smk-dovb-' || v_suffix || '-';

  -- An explicit account number: the column default draws from customer_account_number_seq.
  INSERT INTO public.customers (farm_name, account_number)
  VALUES ('[SMOKE] Void Replay Farm ' || v_suffix, '[SMOKE]-DOVB-' || v_suffix)
  RETURNING id INTO v_customer;

  -- A product is born pricing-free, so price it through the governed preview/apply path.
  INSERT INTO public.products (product_name, unit_size, epa_registration, product_form)
  VALUES ('[SMOKE] Void Replay Product ' || v_suffix, 'GL', '[SMOKE]-EPA-DOVB-' || v_suffix, 'liquid')
  RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')),
    v_admin, v_prefix || 'pricing-preview');
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed'
     OR (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint', v_admin, v_prefix || 'pricing-apply');

  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
  VALUES (v_product, 'Main Warehouse', 100, 14, 'GL');

  -- Order 1 carries five 2-unit lines with one delivery each (A, B, E stay scheduled; C, D are
  -- completed below); orders 2 and 3 carry one line each, delivered in full so they are fulfilled.
  FOR v_i IN 1..3 LOOP
    INSERT INTO public.orders (order_number, customer_id, status, booking_draw)
    VALUES ('[SMOKE] DOVB-' || v_i || '-' || v_suffix, v_customer, 'confirmed', false)
    RETURNING id INTO v_id;
    v_order := v_order || v_id;
  END LOOP;
  FOR v_i IN 1..7 LOOP
    INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
                                    total_units_needed, total_price, profit, net_margin,
                                    quantity_delivered, quantity_remaining)
    VALUES (CASE WHEN v_i <= 5 THEN v_order[1] WHEN v_i = 6 THEN v_order[2] ELSE v_order[3] END,
            v_product, '[SMOKE] void line ' || v_i, 10, 6, 2, 20, 8, 40, 0, 2)
    RETURNING id INTO v_oi;
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, assigned_driver,
                                   scheduled_date, status, created_by)
    VALUES ('[SMOKE] DOVB-DEL-' || v_i || '-' || v_suffix,
            CASE WHEN v_i <= 5 THEN v_order[1] WHEN v_i = 6 THEN v_order[2] ELSE v_order[3] END,
            v_customer, NULL, CURRENT_DATE, 'scheduled', v_admin)
    RETURNING id INTO v_id;
    v_del := v_del || v_id;
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES (v_id, v_oi, v_product, 2, 0, 'GL');
  END LOOP;
  -- Complete C, D and the two full-order deliveries (each under its own key).
  FOR v_i IN 4..7 LOOP
    UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_del[v_i];
    v_res := public.complete_delivery(v_del[v_i], '[SMOKE] Receiver', v_admin, NULL, NULL, NULL,
                                      v_prefix || 'complete-' || v_i, NULL);
    IF v_res->>'status' IS DISTINCT FROM 'completed' THEN
      RAISE EXCEPTION 'SMOKE_SETUP: complete_delivery fixture failed for delivery %: %', v_i, v_res;
    END IF;
  END LOOP;
  SELECT string_agg(status, ',' ORDER BY ord) INTO v_status
    FROM unnest(v_order[2:3]) WITH ORDINALITY AS u(oid, ord) JOIN public.orders o ON o.id = u.oid;
  IF v_status IS DISTINCT FROM 'fulfilled,fulfilled' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: orders 2 and 3 are not fulfilled after full delivery: %', v_status;
  END IF;
  -- Each completion wrote a nonzero draft invoice: void_order must cancel it (the old body failed
  -- here with ORDER_INVOICE_TERMINAL; 3b of the migration zeroes its money fields as cancel_order does).
  SELECT count(*) INTO v_n FROM public.invoices
   WHERE order_id IN (v_order[2], v_order[3]) AND status = 'draft' AND deleted_at IS NULL AND total_amount_cents > 0;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: expected one nonzero draft invoice on each of orders 2 and 3, found %', v_n;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- a. cancel_delivery: a key reused for a DIFFERENT delivery is refused; B stays scheduled.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'cancel-delivery';
  v_res := public.cancel_delivery(v_del[1], '[SMOKE] customer called', v_admin, v_key);
  IF (v_res->>'success')::boolean IS DISTINCT FROM true OR v_res->>'delivery_id' IS DISTINCT FROM v_del[1]::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: cancel_delivery on delivery A did not cancel it: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.cancel_delivery(v_del[2], '[SMOKE] customer called', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: cancel_delivery replayed delivery A''s receipt as success for delivery B: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong cancel_delivery refusal for delivery B: %', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.deliveries WHERE id = v_del[2];
  IF v_status IS DISTINCT FROM 'scheduled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery B is % after a refused cancel_delivery', v_status;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- b. The exact retry of A returns the identical result; one cancellation activity row.
  -- --------------------------------------------------------------------------------------------
  v_res2 := public.cancel_delivery(v_del[1], '[SMOKE] customer called', v_admin, v_key);
  SELECT count(*) INTO v_n FROM public.activity_feed
   WHERE event_type = 'delivery_cancelled' AND related_entity_id = v_del[1];
  IF v_res2 IS DISTINCT FROM v_res OR v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact cancel_delivery retry did not replay once (% activity rows): % vs %', v_n, v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- c. Same key, delivery A, an edited reason: refused.
  -- --------------------------------------------------------------------------------------------
  BEGIN
    v_res2 := public.cancel_delivery(v_del[1], '[SMOKE] weather', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: cancel_delivery replayed a receipt for an edited reason: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edited-reason cancel_delivery refusal: %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------------------------------
  -- d0. The SAME person, after losing the role, retrying their own exact request is stopped by the
  --     role check and is not handed the stored result (the old body replayed before its role
  --     check; the actor/intent binding alone would replay here, since actor and request match).
  -- --------------------------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin_b::text, true);
  UPDATE public.profiles SET role = 'applicator' WHERE id = v_admin;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    v_res2 := public.cancel_delivery(v_del[1], '[SMOKE] customer called', v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: cancel_delivery handed a stored result to its author after they lost the role: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM IS DISTINCT FROM 'Not authorized to cancel deliveries' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong demoted-author cancel_delivery refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin_b::text, true);
  UPDATE public.profiles SET role = 'admin' WHERE id = v_admin;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- --------------------------------------------------------------------------------------------
  -- d. An applicator presenting the admin's key is stopped by the role check, never shown the
  --    admin's result (the old body replayed before its role check).
  -- --------------------------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_applicator, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_applicator::text, true);
  BEGIN
    v_res2 := public.cancel_delivery(v_del[1], '[SMOKE] customer called', v_applicator, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: cancel_delivery handed an admin''s stored result to an applicator: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM IS DISTINCT FROM 'Not authorized to cancel deliveries' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong applicator cancel_delivery refusal: %', SQLERRM;
    END IF;
    IF COALESCE(v_detail, '') LIKE '%' || v_del[1]::text || '%' OR COALESCE(v_detail, '') LIKE '%items_restored%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the applicator refusal disclosed the stored result: %', v_detail;
    END IF;
  END;

  -- --------------------------------------------------------------------------------------------
  -- e. A second admin presenting the key for the identical request is refused and shown nothing.
  -- --------------------------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin_b::text, true);
  BEGIN
    v_res2 := public.cancel_delivery(v_del[1], '[SMOKE] customer called', v_admin_b, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: a second admin replayed the first admin''s cancel_delivery key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong cross-admin cancel_delivery refusal: %', SQLERRM;
    END IF;
    IF COALESCE(v_detail, '') LIKE '%' || v_del[1]::text || '%' OR COALESCE(v_detail, '') LIKE '%"result"%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the cross-admin refusal disclosed the stored result: %', v_detail;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- --------------------------------------------------------------------------------------------
  -- f. No key: refused (22023); delivery B stays scheduled.
  -- --------------------------------------------------------------------------------------------
  BEGIN
    v_res2 := public.cancel_delivery(v_del[2], '[SMOKE] customer called', v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: cancel_delivery ran without an idempotency key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' OR v_state IS DISTINCT FROM '22023' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless cancel_delivery refusal: % (%)', SQLERRM, v_state;
    END IF;
  END;
  SELECT status INTO v_status FROM public.deliveries WHERE id = v_del[2];
  IF v_status IS DISTINCT FROM 'scheduled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery B is % after a refused keyless cancel', v_status;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- g. batch_cancel_deliveries still cancels through cancel_delivery's body with no per-delivery
  --    key: E is cancelled, the count is 1, and no cancel_delivery receipt is written for it.
  -- --------------------------------------------------------------------------------------------
  v_batch_key := v_prefix || 'batch-cancel';
  BEGIN
    v_count := public.batch_cancel_deliveries(ARRAY[v_del[3]], '[SMOKE] batch', v_admin, v_batch_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: batch_cancel_deliveries could not cancel through cancel_delivery: %', SQLERRM;
  END;
  SELECT status INTO v_status FROM public.deliveries WHERE id = v_del[3];
  SELECT count(*) INTO v_n FROM public.idempotency_keys
   WHERE operation = 'cancel_delivery' AND idempotency_key LIKE v_prefix || '%' AND idempotency_key <> v_key;
  IF v_count IS DISTINCT FROM 1 OR v_status IS DISTINCT FROM 'cancelled' OR v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: batch cancel returned % with delivery E %, and % stray cancel receipts', v_count, v_status, v_n;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- h. void_delivery: another delivery on the same key is refused; exact retry replays; edited
  --    reason refused; second admin refused; keyless refused.
  -- --------------------------------------------------------------------------------------------
  v_void_key := v_prefix || 'void-delivery';
  v_res := public.void_delivery(v_del[4], '[SMOKE] wrong product', v_admin, v_void_key);
  IF (v_res->>'success')::boolean IS DISTINCT FROM true OR v_res->>'delivery_id' IS DISTINCT FROM v_del[4]::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void_delivery on delivery C did not void it: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.void_delivery(v_del[5], '[SMOKE] wrong product', v_admin, v_void_key);
    RAISE EXCEPTION 'SMOKE_FAIL: void_delivery replayed delivery C''s receipt as success for delivery D: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong void_delivery refusal for delivery D: %', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.deliveries WHERE id = v_del[5];
  IF v_status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery D is % after a refused void_delivery', v_status;
  END IF;
  v_res2 := public.void_delivery(v_del[4], '[SMOKE] wrong product', v_admin, v_void_key);
  SELECT count(*) INTO v_n FROM public.inventory_transactions
   WHERE delivery_id = v_del[4] AND transaction_type = 'void_delivery_reversal';
  IF v_res2 IS DISTINCT FROM v_res OR v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact void_delivery retry did not replay once (% reversal rows): % vs %', v_n, v_res2, v_res;
  END IF;
  BEGIN
    v_res2 := public.void_delivery(v_del[4], '[SMOKE] damaged', v_admin, v_void_key);
    RAISE EXCEPTION 'SMOKE_FAIL: void_delivery replayed a receipt for an edited reason: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edited-reason void_delivery refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin_b::text, true);
  BEGIN
    v_res2 := public.void_delivery(v_del[4], '[SMOKE] wrong product', v_admin_b, v_void_key);
    RAISE EXCEPTION 'SMOKE_FAIL: a second admin replayed the first admin''s void_delivery key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong cross-admin void_delivery refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    v_res2 := public.void_delivery(v_del[5], '[SMOKE] wrong product', v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: void_delivery ran without an idempotency key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' OR v_state IS DISTINCT FROM '22023' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless void_delivery refusal: % (%)', SQLERRM, v_state;
    END IF;
  END;

  -- --------------------------------------------------------------------------------------------
  -- i. void_order: another order on the same key is refused; exact retry replays; edited reason
  --    refused; second admin refused; keyless refused.
  -- --------------------------------------------------------------------------------------------
  v_order_key := v_prefix || 'void-order';
  BEGIN
    v_res := public.void_order(v_order[2], v_admin, '[SMOKE] billed elsewhere', v_order_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void_order could not void a fulfilled order with a draft invoice: %', SQLERRM;
  END;
  SELECT status INTO v_status FROM public.orders WHERE id = v_order[2];
  IF v_res->>'status' IS DISTINCT FROM 'voided' OR v_status IS DISTINCT FROM 'voided'
     OR (v_res->>'draft_invoices_voided')::int IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void_order on order 2 did not void it and its one draft (%): %', v_status, v_res;
  END IF;
  SELECT count(*) INTO v_n FROM public.invoices
   WHERE order_id = v_order[2] AND deleted_at IS NULL AND status = 'cancelled'
     AND total_amount_cents = 0 AND paid_amount_cents = 0 AND prepay_applied_cents = 0 AND write_off_cents = 0;
  IF v_n <> 1 OR EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_order[2] AND deleted_at IS NULL AND status = 'draft') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: order 2''s draft invoice is not cancelled with zero money fields (% cancelled)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.financial_audit_log
   WHERE operation_type = 'invoice_cancelled' AND entity_id IN (SELECT id FROM public.invoices WHERE order_id = v_order[2])
     AND total_impact_cents < 0;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the cancelled draft has % invoice_cancelled audit rows recording its original total, expected 1', v_n;
  END IF;
  BEGIN
    v_res2 := public.void_order(v_order[3], v_admin, '[SMOKE] billed elsewhere', v_order_key);
    RAISE EXCEPTION 'SMOKE_FAIL: void_order replayed order 2''s receipt as success for order 3: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong void_order refusal for order 3: %', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.orders WHERE id = v_order[3];
  IF v_status IS DISTINCT FROM 'fulfilled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: order 3 is % after a refused void_order', v_status;
  END IF;
  v_res2 := public.void_order(v_order[2], v_admin, '[SMOKE] billed elsewhere', v_order_key);
  SELECT count(*) INTO v_n FROM public.financial_audit_log
   WHERE operation_type = 'order_voided' AND entity_id = v_order[2];
  IF v_res2 IS DISTINCT FROM v_res OR v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact void_order retry did not replay once (% audit rows): % vs %', v_n, v_res2, v_res;
  END IF;
  BEGIN
    v_res2 := public.void_order(v_order[2], v_admin, '[SMOKE] duplicate order', v_order_key);
    RAISE EXCEPTION 'SMOKE_FAIL: void_order replayed a receipt for an edited reason: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edited-reason void_order refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin_b::text, true);
  BEGIN
    v_res2 := public.void_order(v_order[2], v_admin_b, '[SMOKE] billed elsewhere', v_order_key);
    RAISE EXCEPTION 'SMOKE_FAIL: a second admin replayed the first admin''s void_order key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong cross-admin void_order refusal: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    v_res2 := public.void_order(v_order[3], v_admin, '[SMOKE] billed elsewhere', NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: void_order ran without an idempotency key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' OR v_state IS DISTINCT FROM '22023' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless void_order refusal: % (%)', SQLERRM, v_state;
    END IF;
  END;

  -- --------------------------------------------------------------------------------------------
  -- i2. A draft that already carries recorded money is refused, never zeroed: order 3's draft gets
  --     a 100-cent payment (a direct fixture write), and void_order must refuse with
  --     ORDER_VOID_DRAFT_HAS_APPLIED_MONEY and change nothing.
  -- --------------------------------------------------------------------------------------------
  UPDATE public.invoices SET paid_amount_cents = 100
   WHERE order_id = v_order[3] AND status = 'draft' AND deleted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: expected one draft invoice on order 3 to give a payment, found %', v_n;
  END IF;
  BEGIN
    v_res2 := public.void_order(v_order[3], v_admin, '[SMOKE] billed elsewhere', v_prefix || 'void-order-paid-draft');
    RAISE EXCEPTION 'SMOKE_FAIL: void_order voided an order whose draft invoice carries a recorded payment: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ORDER_VOID_DRAFT_HAS_APPLIED_MONEY%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong refusal for a draft with a recorded payment: %', SQLERRM;
    END IF;
  END;
  SELECT o.status || ',' || i.status || ',' || i.paid_amount_cents INTO v_status
    FROM public.orders o JOIN public.invoices i ON i.order_id = o.id AND i.deleted_at IS NULL
   WHERE o.id = v_order[3];
  IF v_status IS DISTINCT FROM 'fulfilled,draft,100' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused void_order changed order 3 or its paid draft: %', v_status;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- j. Every fresh receipt above is bound to the admin and carries a SHA-256 fingerprint.
  -- --------------------------------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.idempotency_keys
   WHERE (idempotency_key, operation) IN ((v_key, 'cancel_delivery'), (v_void_key, 'void_delivery'),
                                          (v_order_key, 'void_order'), (v_batch_key, 'batch_cancel_deliveries'))
     AND request_actor_id = v_admin AND request_fingerprint ~ '^[0-9a-f]{64}$';
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % of the 4 cancel/void receipts are bound to the admin with a fingerprint', v_n;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
