-- ============================================================================
-- SMOKE TEST (rolled back by design) for 20261019200000_bind_delivery_job_replay_receipts_batch3a.
--
-- CONTAINER ONLY: run through scripts/smoke/prove-delivery-job-replay-binding-batch3a-real-schema.mjs,
-- never against the live database. Completing a delivery on an order writes the order's automatic
-- draft invoice, whose customer-visible invoice number comes from next_invoice_number(), which draws
-- from a non-transactional sequence (nextval) that a rollback does not return; the container prover
-- reports which sequences this chain moves. The chain also plants [SMOKE] customers, products,
-- inventory, orders, deliveries and jobs, which the LIVE-DATA GUARD refuses.
--
-- Rule under test: complete_delivery and complete_job replay a stored idempotency receipt only to
-- the person who wrote it, and only for the exact same request. A retry that reuses a key for a
-- different delivery/job, or with edited quantities, signer, issue notes, completion time or applied
-- info, is refused (IDEMPOTENCY_INTENT_MISMATCH) and changes nothing; a different person presenting
-- the key is refused (IDEMPOTENCY_ACTOR_MISMATCH) and is shown nothing; an exact retry still returns
-- the original answer and moves no extra stock; the same completion instant sent under another
-- session TimeZone is the same request; a call with no key is refused (IDEMPOTENCY_KEY_REQUIRED,
-- 22023). The offline path (stage_offline_action + process_offline_action) still completes once and
-- replays. Every fresh receipt is bound to the actor with a 64-hex fingerprint.
--
-- Fail-first: before the migration step a fails (complete_delivery hands delivery A's receipt back
-- as success for delivery B).
--
-- HOW TO RUN: as ONE statement inside a transaction that rolls back. It ALWAYS ends with RAISE
-- EXCEPTION 'SMOKE_PASS_ROLLBACK': that exact text = PASS; any other error = FAIL.
--
-- Auth: auth.uid() reads request.jwt.claims, set with set_config(..., true) to two REAL active admin
-- profiles found at run time (SMOKE_SETUP if fewer than two exist). Fixture INSERTs run as the table
-- owner; the RPCs under test enforce their own role checks.
-- Precondition: today is not inside a CLOSED accounting period (SMOKE_SETUP otherwise).
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_admin_b uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_prefix text;
  v_key text;
  v_job_key text;
  v_customer uuid;
  v_product uuid;
  v_pricing jsonb;
  v_order uuid;
  v_oi uuid;
  v_del uuid[] := ARRAY[]::uuid[];
  v_item uuid[] := ARRAY[]::uuid[];
  v_id uuid;
  v_field uuid[] := ARRAY[]::uuid[];
  v_job uuid[] := ARRAY[]::uuid[];
  v_i int;
  v_completed_at timestamptz := date_trunc('second', now()) - interval '2 minutes';
  v_client_time timestamptz := clock_timestamp() - interval '5 minutes';
  v_applied jsonb;
  v_payload jsonb;
  v_del_action uuid := gen_random_uuid();
  v_job_action uuid := gen_random_uuid();
  v_off_del_key text;
  v_off_job_key text;
  v_res jsonb;
  v_res2 jsonb;
  v_avail numeric;
  v_n int;
  v_status text;
  v_tz text;
  v_state text;
  v_detail text;
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
  v_prefix := 'smk-djrb-' || v_suffix || '-';
  v_off_del_key := v_prefix || 'offline-delivery';
  v_off_job_key := v_prefix || 'offline-job';

  -- An explicit account number: the column default draws from customer_account_number_seq.
  INSERT INTO public.customers (farm_name, account_number)
  VALUES ('[SMOKE] Delivery Job Replay Farm ' || v_suffix, '[SMOKE]-DJRB-' || v_suffix)
  RETURNING id INTO v_customer;

  -- A product is born pricing-free, so price it through the governed preview/apply path.
  INSERT INTO public.products (product_name, unit_size, epa_registration, product_form)
  VALUES ('[SMOKE] Delivery Job Replay Product ' || v_suffix, 'GL', '[SMOKE]-EPA-DJRB-' || v_suffix, 'liquid')
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
  VALUES (v_product, 'Main Warehouse', 100, 6, 'GL');

  -- One order, three 2-unit lines; deliveries 1 (A), 2 (B) and 3 (offline), one line each, all
  -- in_progress (items are written while the delivery is still scheduled, as the app does).
  INSERT INTO public.orders (order_number, customer_id, status, booking_draw)
  VALUES ('[SMOKE] DJRB-' || v_suffix, v_customer, 'confirmed', false)
  RETURNING id INTO v_order;
  FOR v_i IN 1..3 LOOP
    INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
                                    total_units_needed, total_price, profit, net_margin,
                                    quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product, '[SMOKE] replay line ' || v_i, 10, 6, 2, 20, 8, 40, 0, 2)
    RETURNING id INTO v_oi;
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, assigned_driver,
                                   scheduled_date, status, created_by)
    VALUES ('[SMOKE] DJRB-DEL-' || v_i || '-' || v_suffix, v_order, v_customer, NULL,
            CURRENT_DATE, 'scheduled', v_admin)
    RETURNING id INTO v_id;
    v_del := v_del || v_id;
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES (v_id, v_oi, v_product, 2, 0, 'GL')
    RETURNING id INTO v_id;
    v_item := v_item || v_id;
    UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_del[v_i];
  END LOOP;

  -- Three in_progress jobs (A, B, offline), each on its own field, one chemical line.
  FOR v_i IN 1..3 LOOP
    INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
    VALUES (v_customer, '[SMOKE] DJRB Field ' || v_i || ' ' || v_suffix, 'soybeans', 20)
    RETURNING id INTO v_id;
    v_field := v_field || v_id;
    INSERT INTO public.jobs (job_number, customer_id, status, job_date, season,
                             total_acres, total_price_cents, total_cost_cents, created_by)
    VALUES ('[SMOKE] DJRB-JOB-' || v_i || '-' || v_suffix, v_customer, 'scheduled', CURRENT_DATE,
            extract(year FROM CURRENT_DATE)::integer, 20, 20000, 12000, v_admin)
    RETURNING id INTO v_id;
    v_job := v_job || v_id;
    INSERT INTO public.job_fields (job_id, field_id, acres_to_treat, sort_order)
    VALUES (v_id, v_field[v_i], 20, 1);
    INSERT INTO public.job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
                                      cost_per_unit_cents, price_per_unit_cents, sort_order)
    VALUES (v_id, v_product, 1, 'GL', 0.05, 'GL', 12000, 20000, 1);
    v_res := public.start_job(v_id, v_admin, v_prefix || 'start-job-' || v_i);
    IF v_res->>'status' IS DISTINCT FROM 'in_progress' THEN
      RAISE EXCEPTION 'SMOKE_SETUP: start_job fixture failed: %', v_res;
    END IF;
  END LOOP;

  -- --------------------------------------------------------------------------------------------
  -- a. complete_delivery: a key reused for a DIFFERENT delivery is refused; B stays in_progress.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'complete-delivery';
  v_res := public.complete_delivery(v_del[1], '[SMOKE] Receiver', v_admin, NULL, NULL, '[SMOKE] notes',
                                    v_key, v_completed_at);
  IF v_res->>'delivery_id' IS DISTINCT FROM v_del[1]::text
     OR v_res->>'status' IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: complete_delivery on delivery A did not complete it: %', v_res;
  END IF;
  SELECT quantity_available INTO v_avail FROM public.inventory
   WHERE product_id = v_product AND location = 'Main Warehouse';
  IF v_avail IS DISTINCT FROM 98::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery A moved % units of stock, expected 2', 100 - v_avail;
  END IF;
  BEGIN
    v_res2 := public.complete_delivery(v_del[2], '[SMOKE] Receiver', v_admin, NULL, NULL, '[SMOKE] notes',
                                       v_key, v_completed_at);
    RAISE EXCEPTION 'SMOKE_FAIL: complete_delivery replayed delivery A''s receipt as success for delivery B: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong complete_delivery refusal for delivery B: %', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.deliveries WHERE id = v_del[2];
  IF v_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery B is % after a refused complete_delivery', v_status;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- b. The exact retry of A returns the identical result and moves no extra stock.
  -- --------------------------------------------------------------------------------------------
  v_res2 := public.complete_delivery(v_del[1], '[SMOKE] Receiver', v_admin, NULL, NULL, '[SMOKE] notes',
                                     v_key, v_completed_at);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact complete_delivery retry did not replay: % vs %', v_res2, v_res;
  END IF;
  SELECT quantity_available INTO v_avail FROM public.inventory
   WHERE product_id = v_product AND location = 'Main Warehouse';
  SELECT count(*) INTO v_n FROM public.inventory_transactions
   WHERE delivery_id = v_del[1] AND transaction_type = 'delivered';
  IF v_avail IS DISTINCT FROM 98::numeric OR v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact complete_delivery retry moved stock again (on hand %, % ledger rows)', v_avail, v_n;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- c. Same key, delivery A, any edited argument: refused.
  -- --------------------------------------------------------------------------------------------
  BEGIN
    v_res2 := public.complete_delivery(v_del[1], '[SMOKE] Receiver', v_admin,
                                       jsonb_build_object(v_item[1]::text, 1), NULL, '[SMOKE] notes',
                                       v_key, v_completed_at);
    RAISE EXCEPTION 'SMOKE_FAIL: complete_delivery replayed a receipt for edited quantities: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edited-quantities refusal: %', SQLERRM;
    END IF;
  END;
  BEGIN
    v_res2 := public.complete_delivery(v_del[1], '[SMOKE] Someone Else', v_admin, NULL, NULL, '[SMOKE] notes',
                                       v_key, v_completed_at);
    RAISE EXCEPTION 'SMOKE_FAIL: complete_delivery replayed a receipt for an edited signer: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edited-signer refusal: %', SQLERRM;
    END IF;
  END;
  BEGIN
    v_res2 := public.complete_delivery(v_del[1], '[SMOKE] Receiver', v_admin, NULL, NULL, '[SMOKE] other notes',
                                       v_key, v_completed_at);
    RAISE EXCEPTION 'SMOKE_FAIL: complete_delivery replayed a receipt for edited issue notes: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edited-notes refusal: %', SQLERRM;
    END IF;
  END;
  BEGIN
    v_res2 := public.complete_delivery(v_del[1], '[SMOKE] Receiver', v_admin, NULL, NULL, '[SMOKE] notes',
                                       v_key, v_completed_at - interval '1 minute');
    RAISE EXCEPTION 'SMOKE_FAIL: complete_delivery replayed a receipt for a different completion time: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong different-completion-time refusal: %', SQLERRM;
    END IF;
  END;

  -- --------------------------------------------------------------------------------------------
  -- d. The same completion instant under another session TimeZone is the same request: it replays.
  -- --------------------------------------------------------------------------------------------
  v_tz := current_setting('TimeZone');
  SET LOCAL TIME ZONE 'Asia/Tokyo';
  BEGIN
    v_res2 := public.complete_delivery(v_del[1], '[SMOKE] Receiver', v_admin, NULL, NULL, '[SMOKE] notes',
                                       v_key, v_completed_at);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: complete_delivery refused the same completed_at instant under another session TimeZone: %', SQLERRM;
  END;
  PERFORM set_config('TimeZone', v_tz, true);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the other-TimeZone retry did not replay the original result: % vs %', v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- e. No key: refused (22023) before anything is written; delivery B stays in_progress.
  -- --------------------------------------------------------------------------------------------
  BEGIN
    v_res2 := public.complete_delivery(v_del[2], '[SMOKE] Receiver', v_admin, NULL, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: complete_delivery ran without an idempotency key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' OR v_state IS DISTINCT FROM '22023' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless complete_delivery refusal: % (%)', SQLERRM, v_state;
    END IF;
  END;
  SELECT status INTO v_status FROM public.deliveries WHERE id = v_del[2];
  SELECT count(*) INTO v_n FROM public.inventory_transactions WHERE delivery_id = v_del[2];
  IF v_status IS DISTINCT FROM 'in_progress' OR v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a keyless complete_delivery changed delivery B (status %, % ledger rows)', v_status, v_n;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- f. A different active admin presenting K for the identical request is refused, and is shown
  --    nothing of A's stored result.
  -- --------------------------------------------------------------------------------------------
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin_b::text, true);
  BEGIN
    v_res2 := public.complete_delivery(v_del[1], '[SMOKE] Receiver', v_admin_b, NULL, NULL, '[SMOKE] notes',
                                       v_key, v_completed_at);
    RAISE EXCEPTION 'SMOKE_FAIL: a second admin replayed the first admin''s complete_delivery key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong cross-admin complete_delivery refusal: %', SQLERRM;
    END IF;
    IF COALESCE(v_detail, '') LIKE '%' || v_del[1]::text || '%'
       OR COALESCE(v_detail, '') LIKE '%auto_invoice%'
       OR COALESCE(v_detail, '') LIKE '%"result"%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the cross-admin refusal disclosed the stored result: %', v_detail;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- --------------------------------------------------------------------------------------------
  -- g. complete_job: other job on the same key refused (B stays in_progress); edited applied info
  --    refused; exact retry replays; keyless refused; NULL p_performed_by refused.
  -- --------------------------------------------------------------------------------------------
  v_job_key := v_prefix || 'complete-job';
  v_applied := jsonb_build_object(
    'actual_start_time', (now() - interval '3 hours')::text,
    'actual_end_time', (now() - interval '5 minutes')::text,
    'wind_speed', 8.5,
    'wind_direction', 'NW',
    'temperature', 72,
    'humidity', 50,
    'actual_gallons_applied', 20,
    'notes', '[SMOKE] replay binding job');
  v_res := public.complete_job(v_job[1], v_applied, v_admin, v_job_key);
  IF COALESCE(v_res->>'success', '') <> 'true' OR v_res->>'job_id' IS DISTINCT FROM v_job[1]::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: complete_job on job A did not succeed: %', v_res;
  END IF;
  BEGIN
    v_res2 := public.complete_job(v_job[2], v_applied, v_admin, v_job_key);
    RAISE EXCEPTION 'SMOKE_FAIL: complete_job replayed job A''s receipt as success for job B: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong complete_job refusal for job B: %', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.jobs WHERE id = v_job[2];
  IF v_status IS DISTINCT FROM 'in_progress'
     OR EXISTS (SELECT 1 FROM public.application_records WHERE source_type = 'job' AND source_id = v_job[2]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: job B changed under a refused complete_job (status %)', v_status;
  END IF;
  BEGIN
    v_res2 := public.complete_job(v_job[1], v_applied || jsonb_build_object('notes', '[SMOKE] edited'), v_admin, v_job_key);
    RAISE EXCEPTION 'SMOKE_FAIL: complete_job replayed a receipt for edited applied info: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong edited-applied-info refusal: %', SQLERRM;
    END IF;
  END;
  v_res2 := public.complete_job(v_job[1], v_applied, v_admin, v_job_key);
  SELECT count(*) INTO v_n FROM public.application_records WHERE source_type = 'job' AND source_id = v_job[1];
  IF v_res2 IS DISTINCT FROM v_res OR v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact complete_job retry did not replay (% application records): % vs %', v_n, v_res2, v_res;
  END IF;
  BEGIN
    v_res2 := public.complete_job(v_job[2], v_applied, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: complete_job ran without an idempotency key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' OR v_state IS DISTINCT FROM '22023' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong keyless complete_job refusal: % (%)', SQLERRM, v_state;
    END IF;
  END;
  BEGIN
    v_res2 := public.complete_job(v_job[2], v_applied, NULL, v_prefix || 'complete-job-null-actor');
    RAISE EXCEPTION 'SMOKE_FAIL: complete_job ran with a NULL p_performed_by: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM <> 'p_performed_by does not match authenticated user' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong NULL-actor complete_job refusal: %', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.jobs WHERE id = v_job[2];
  IF v_status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: job B is % after refused complete_job calls', v_status;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- h. Offline path: stage + process completes delivery 3 and job 3 once; processing again
  --    returns 'succeeded' with the same result and does no second piece of work.
  -- --------------------------------------------------------------------------------------------
  v_payload := jsonb_build_object(
    'signed_by', '[SMOKE] Offline Receiver',
    'quantities', jsonb_build_object(v_item[3]::text, '2'),
    'issue_type', 'none',
    'completed_at', to_jsonb(clock_timestamp() - interval '1 minute'));
  v_res := public.stage_offline_action(v_del_action, 'complete_delivery', v_del[3], 1, v_client_time,
                                       v_payload, v_off_del_key,
                                       (SELECT d.updated_at FROM public.deliveries d WHERE d.id = v_del[3]));
  IF v_res->>'status' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: offline delivery stage did not return received: %', v_res;
  END IF;
  v_res := public.process_offline_action(v_del_action, v_off_del_key);
  IF v_res->>'status' IS DISTINCT FROM 'succeeded'
     OR v_res->'result'->>'delivery_id' IS DISTINCT FROM v_del[3]::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: offline delivery process failed: %', v_res;
  END IF;
  v_res2 := public.process_offline_action(v_del_action, v_off_del_key);
  SELECT count(*) INTO v_n FROM public.inventory_transactions
   WHERE delivery_id = v_del[3] AND transaction_type = 'delivered';
  IF v_res2 IS DISTINCT FROM v_res OR v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: offline delivery replay changed or repeated the work (% ledger rows): % vs %', v_n, v_res2, v_res;
  END IF;

  v_payload := jsonb_build_object(
    'actual_start_time', to_jsonb(clock_timestamp() - interval '2 hours'),
    'actual_end_time', to_jsonb(clock_timestamp() - interval '5 minutes'),
    'wind_speed', 8.5,
    'wind_direction', 'NW',
    'temperature', 72,
    'humidity', 50,
    'actual_gallons_applied', 20,
    'notes', '[SMOKE] offline replay binding job',
    'field_acres', jsonb_build_array(jsonb_build_object('field_id', v_field[3], 'acres_applied', 20)));
  v_res := public.stage_offline_action(v_job_action, 'complete_job', v_job[3], 1, v_client_time,
                                       v_payload, v_off_job_key,
                                       (SELECT j.updated_at FROM public.jobs j WHERE j.id = v_job[3]));
  IF v_res->>'status' IS DISTINCT FROM 'received' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: offline job stage did not return received: %', v_res;
  END IF;
  v_res := public.process_offline_action(v_job_action, v_off_job_key);
  IF v_res->>'status' IS DISTINCT FROM 'succeeded'
     OR v_res->'result'->>'job_id' IS DISTINCT FROM v_job[3]::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: offline job process failed: %', v_res;
  END IF;
  v_res2 := public.process_offline_action(v_job_action, v_off_job_key);
  SELECT count(*) INTO v_n FROM public.application_records WHERE source_type = 'job' AND source_id = v_job[3];
  IF v_res2 IS DISTINCT FROM v_res OR v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: offline job replay changed or repeated the work (% application records): % vs %', v_n, v_res2, v_res;
  END IF;

  -- --------------------------------------------------------------------------------------------
  -- i. Every fresh receipt above is bound to the admin and carries a SHA-256 fingerprint.
  -- --------------------------------------------------------------------------------------------
  SELECT count(*) INTO v_n FROM public.idempotency_keys
   WHERE idempotency_key IN (v_key, v_job_key, v_off_del_key, v_off_job_key)
     AND operation IN ('complete_delivery', 'complete_job')
     AND request_actor_id = v_admin AND request_fingerprint ~ '^[0-9a-f]{64}$';
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: % of the 4 complete_delivery/complete_job receipts are bound to the admin with a fingerprint', v_n;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
