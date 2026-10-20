-- ============================================================================
-- SMOKE TEST (rolled back by design) for 20261019220000_start_and_complete_delivery.
--
-- CONTAINER ONLY: run through scripts/smoke/prove-start-and-complete-delivery-real-schema.mjs,
-- never against the live database. Completing a delivery on an order writes the order's automatic
-- draft invoice, whose invoice number draws from a sequence a rollback does not return, and the
-- chain plants [SMOKE] customers, products, inventory, orders and deliveries, which the LIVE-DATA
-- GUARD refuses.
--
-- Rule under test: start_and_complete_delivery starts a scheduled delivery and completes it in ONE
-- transaction, on the chosen America/Chicago business date, with a required retry key bound to the
-- caller and the exact request.
--   a. scheduled delivery, today: completed, started = true, stock moved once, completion dated
--      today in Chicago, the start's activity row written; both receipts bound (64-hex fingerprint);
--   b. the exact retry returns the identical result and moves no extra stock;
--   b2. a deactivated account cannot replay its own saved completion (authorization runs first);
--   c. the same key for a DIFFERENT delivery is refused (IDEMPOTENCY_INTENT_MISMATCH), and that
--      delivery stays scheduled;
--   d. the same key from a different person is refused (IDEMPOTENCY_ACTOR_MISMATCH);
--   d2. an exact retry whose date has since passed the one-year bound still replays (the bound runs
--       after the receipt lookup);
--   e. no key: IDEMPOTENCY_KEY_REQUIRED; no date: DELIVERED_ON_REQUIRED; a forged p_performed_by:
--      ACTOR_MISMATCH; tomorrow: DELIVERED_ON_IN_FUTURE; one day past a calendar year back, or -infinity:
--      DELIVERED_ON_TOO_OLD (-infinity: DELIVERED_ON_INVALID); each leaves the delivery scheduled;
--   f. a past date (yesterday): completed at 17:00 UTC of that date, Chicago date = yesterday (the
--      path a "today" request takes when it reaches the server after Chicago midnight);
--   g. a completion that fails AFTER the start (a closed accounting period) leaves the delivery
--      scheduled with no start activity: the start rolls back with it;
--   h. an in_progress delivery completes with started = false.
--
-- Fail-first: before the migration the function does not exist (step a fails).
--
-- HOW TO RUN: as ONE statement inside a transaction that rolls back. It ALWAYS ends with RAISE
-- EXCEPTION 'SMOKE_PASS_ROLLBACK': that exact text = PASS; any other error = FAIL.
-- Auth: auth.uid() reads request.jwt.claims, set to two active admin profiles found at run time.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_admin_b uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_prefix text;
  v_key text;
  v_customer uuid;
  v_product uuid;
  v_pricing jsonb;
  v_order uuid;
  v_oi uuid;
  v_del uuid[] := ARRAY[]::uuid[];
  v_id uuid;
  v_i int;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_res jsonb;
  v_res2 jsonb;
  v_avail numeric;
  v_n int;
  v_status text;
  v_completed timestamptz;
  v_fp text;
  v_actor uuid;
  v_closed_start date;
  v_aged date;
BEGIN
  -- 0. Preconditions, two admins, fixtures.
  IF EXISTS (SELECT 1 FROM public.accounting_periods
              WHERE status = 'closed' AND (v_today - 1) BETWEEN period_start AND period_end) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: yesterday falls in a CLOSED accounting period';
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
  v_prefix := 'smk-sacd-' || v_suffix || '-';

  INSERT INTO public.customers (farm_name, account_number)
  VALUES ('[SMOKE] Start Complete Farm ' || v_suffix, '[SMOKE]-SACD-' || v_suffix)
  RETURNING id INTO v_customer;
  INSERT INTO public.products (product_name, unit_size, epa_registration, product_form)
  VALUES ('[SMOKE] Start Complete Product ' || v_suffix, 'GL', '[SMOKE]-EPA-SACD-' || v_suffix, 'liquid')
  RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '6.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')),
    v_admin, v_prefix || 'pricing-preview');
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint', v_admin, v_prefix || 'pricing-apply');
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
  VALUES (v_product, 'Main Warehouse', 100, 8, 'GL');

  -- One order, four 2-unit lines; deliveries 1-3 scheduled, 4 in_progress.
  INSERT INTO public.orders (order_number, customer_id, status, booking_draw)
  VALUES ('[SMOKE] SACD-' || v_suffix, v_customer, 'confirmed', false)
  RETURNING id INTO v_order;
  FOR v_i IN 1..4 LOOP
    INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
                                    total_units_needed, total_price, profit, net_margin,
                                    quantity_delivered, quantity_remaining)
    VALUES (v_order, v_product, '[SMOKE] line ' || v_i, 10, 6, 2, 20, 8, 40, 0, 2)
    RETURNING id INTO v_oi;
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, assigned_driver,
                                   scheduled_date, status, created_by)
    VALUES ('[SMOKE] SACD-DEL-' || v_i || '-' || v_suffix, v_order, v_customer, NULL,
            CURRENT_DATE, 'scheduled', v_admin)
    RETURNING id INTO v_id;
    v_del := v_del || v_id;
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES (v_id, v_oi, v_product, 2, 0, 'GL');
  END LOOP;
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_del[4];

  -- a. Scheduled delivery, today: one call starts and completes it.
  v_key := v_prefix || 'start-complete';
  v_res := public.start_and_complete_delivery(v_del[1], '[SMOKE] Receiver', v_today, v_admin, NULL, NULL, NULL, v_key);
  IF v_res->>'status' IS DISTINCT FROM 'completed' OR (v_res->>'started')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: start_and_complete_delivery did not start and complete delivery 1: %', v_res;
  END IF;
  SELECT status, completed_at INTO v_status, v_completed FROM public.deliveries WHERE id = v_del[1];
  IF v_status IS DISTINCT FROM 'completed' OR (v_completed AT TIME ZONE 'America/Chicago')::date IS DISTINCT FROM v_today THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery 1 is % completed at % (expected completed, Chicago date %)', v_status, v_completed, v_today;
  END IF;
  SELECT quantity_available INTO v_avail FROM public.inventory WHERE product_id = v_product AND location = 'Main Warehouse';
  IF v_avail IS DISTINCT FROM 98::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery 1 moved % units, expected 2', 100 - v_avail;
  END IF;
  SELECT count(*) INTO v_n FROM public.activity_feed
   WHERE event_type = 'delivery_confirmed' AND related_entity_id = v_del[1];
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery 1 has % start activity rows, expected 1', v_n;
  END IF;
  SELECT request_actor_id, request_fingerprint INTO v_actor, v_fp FROM public.idempotency_keys
   WHERE idempotency_key = v_key AND operation = 'start_and_complete_delivery';
  IF v_actor IS DISTINCT FROM v_admin OR v_fp IS NULL OR v_fp !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the start_and_complete_delivery receipt is not bound (actor %, fingerprint %)', v_actor, v_fp;
  END IF;
  SELECT request_actor_id, request_fingerprint INTO v_actor, v_fp FROM public.idempotency_keys
   WHERE idempotency_key = v_key || ':complete' AND operation = 'complete_delivery';
  IF v_actor IS DISTINCT FROM v_admin OR v_fp IS NULL OR v_fp !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the inner complete_delivery receipt is not bound (actor %, fingerprint %)', v_actor, v_fp;
  END IF;

  -- b. The exact retry replays and moves no extra stock.
  v_res2 := public.start_and_complete_delivery(v_del[1], '[SMOKE] Receiver', v_today, v_admin, NULL, NULL, NULL, v_key);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact retry did not replay: % vs %', v_res2, v_res;
  END IF;
  SELECT quantity_available INTO v_avail FROM public.inventory WHERE product_id = v_product AND location = 'Main Warehouse';
  IF v_avail IS DISTINCT FROM 98::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact retry moved stock again (% left)', v_avail;
  END IF;

  -- b2. A deactivated account cannot replay its own saved completion (authorization runs first).
  -- The second admin deactivates the first (profile changes need an admin), then the first retries.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin_b::text, true);
  UPDATE public.profiles SET is_active = false WHERE id = v_admin;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    v_res2 := public.start_and_complete_delivery(v_del[1], '[SMOKE] Receiver', v_today, v_admin, NULL, NULL, NULL, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: a deactivated account replayed its completion: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'Not authorized to complete this delivery%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong refusal for a deactivated replay: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin_b::text, true);
  UPDATE public.profiles SET is_active = true WHERE id = v_admin;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- c. The same key for a different delivery is refused; delivery 2 stays scheduled.
  BEGIN
    v_res2 := public.start_and_complete_delivery(v_del[2], '[SMOKE] Receiver', v_today, v_admin, NULL, NULL, NULL, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: delivery 1''s key replayed as success for delivery 2: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong refusal for a reused key on delivery 2: %', SQLERRM;
    END IF;
  END;

  -- d. The same key from another person is refused.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin_b::text, true);
  BEGIN
    v_res2 := public.start_and_complete_delivery(v_del[1], '[SMOKE] Receiver', v_today, NULL, NULL, NULL, NULL, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: another admin received delivery 1''s saved result: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_ACTOR_MISMATCH%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong refusal for another admin''s retry: %', SQLERRM;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- d2. An exact retry of a completion whose date has since passed the one-year bound (it was the
  -- oldest allowed date when it committed, and the retry lands after Chicago midnight) replays the
  -- saved result instead of being refused DELIVERED_ON_TOO_OLD. The clock cannot move inside the
  -- chain, so the saved receipt is planted exactly as the function writes and binds it.
  v_aged := (v_today - interval '1 year')::date - 1;
  v_fp := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_admin, 'delivery_id', v_del[1], 'signed_by', '[SMOKE] Receiver', 'delivered_on', v_aged,
    'quantities', NULL::jsonb, 'issue_type', NULL::text, 'issue_notes', NULL::text));
  PERFORM public.save_idempotency(v_prefix || 'aged', 'start_and_complete_delivery', v_res);
  PERFORM public._bind_replay_receipt_20261015(v_prefix || 'aged', 'start_and_complete_delivery', v_fp);
  BEGIN
    v_res2 := public.start_and_complete_delivery(v_del[1], '[SMOKE] Receiver', v_aged, v_admin, NULL, NULL, NULL, v_prefix || 'aged');
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an exact retry of an aged-out date was refused: %', SQLERRM;
  END;
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an exact retry of an aged-out date did not replay: % vs %', v_res2, v_res;
  END IF;

  -- e. Refusals before any change.
  BEGIN
    v_res2 := public.start_and_complete_delivery(v_del[2], '[SMOKE] Receiver', v_today, v_admin, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: a keyless call ran: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    -- 22023 = the function's own first check, before any work (save_idempotency's later refusal is P0001).
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED: start_and_complete_delivery%' OR SQLSTATE <> '22023' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: keyless refusal was % (%)', SQLERRM, SQLSTATE;
    END IF;
  END;
  BEGIN
    v_res2 := public.start_and_complete_delivery(v_del[2], '[SMOKE] Receiver', NULL, v_admin, NULL, NULL, NULL, v_prefix || 'no-date');
    RAISE EXCEPTION 'SMOKE_FAIL: a dateless call ran: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'DELIVERED_ON_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: dateless refusal was %', SQLERRM; END IF;
  END;
  BEGIN
    v_res2 := public.start_and_complete_delivery(v_del[2], '[SMOKE] Receiver', v_today, v_admin_b, NULL, NULL, NULL, v_prefix || 'forged');
    RAISE EXCEPTION 'SMOKE_FAIL: a forged p_performed_by ran: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL: forged-actor refusal was %', SQLERRM; END IF;
  END;
  BEGIN
    v_res2 := public.start_and_complete_delivery(v_del[2], '[SMOKE] Receiver', v_today + 1, v_admin, NULL, NULL, NULL, v_prefix || 'future');
    RAISE EXCEPTION 'SMOKE_FAIL: a future date ran: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'DELIVERED_ON_IN_FUTURE%' THEN RAISE EXCEPTION 'SMOKE_FAIL: future-date refusal was %', SQLERRM; END IF;
  END;
  BEGIN
    v_res2 := public.start_and_complete_delivery(v_del[2], '[SMOKE] Receiver', (v_today - interval '1 year')::date - 1, v_admin, NULL, NULL, NULL, v_prefix || 'too-old');
    RAISE EXCEPTION 'SMOKE_FAIL: a date more than a year back ran: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'DELIVERED_ON_TOO_OLD%' THEN RAISE EXCEPTION 'SMOKE_FAIL: too-old refusal was %', SQLERRM; END IF;
  END;
  BEGIN
    v_res2 := public.start_and_complete_delivery(v_del[2], '[SMOKE] Receiver', '-infinity'::date, v_admin, NULL, NULL, NULL, v_prefix || 'neg-infinity');
    RAISE EXCEPTION 'SMOKE_FAIL: a -infinity date ran: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'DELIVERED_ON_INVALID%' THEN RAISE EXCEPTION 'SMOKE_FAIL: -infinity refusal was %', SQLERRM; END IF;
  END;
  SELECT status INTO v_status FROM public.deliveries WHERE id = v_del[2];
  IF v_status IS DISTINCT FROM 'scheduled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery 2 is % after refused calls', v_status;
  END IF;

  -- f. Yesterday: completed at midday of yesterday.
  v_res := public.start_and_complete_delivery(v_del[2], '[SMOKE] Receiver', v_today - 1, v_admin, NULL, NULL, NULL, v_prefix || 'yesterday');
  SELECT status, completed_at INTO v_status, v_completed FROM public.deliveries WHERE id = v_del[2];
  IF v_status IS DISTINCT FROM 'completed'
     OR v_completed IS DISTINCT FROM ((v_today - 1) + time '17:00') AT TIME ZONE 'UTC'
     OR (v_completed AT TIME ZONE 'America/Chicago')::date IS DISTINCT FROM v_today - 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: delivery 2 (yesterday) is % at %: %', v_status, v_completed, v_res;
  END IF;

  -- g. A completion refused after the start rolls the start back too.
  -- The whole calendar month about three months back (inside the one-year window), closed.
  v_closed_start := date_trunc('month', v_today - 90)::date;
  UPDATE public.accounting_periods SET status = 'closed'
   WHERE period_start = v_closed_start;
  IF NOT FOUND THEN
    INSERT INTO public.accounting_periods (period_start, period_end, status, notes)
    VALUES (v_closed_start, (v_closed_start + interval '1 month' - interval '1 day')::date, 'closed', '[SMOKE] closed period');
  END IF;
  BEGIN
    v_res2 := public.start_and_complete_delivery(v_del[3], '[SMOKE] Receiver', v_closed_start + 14, v_admin, NULL, NULL, NULL, v_prefix || 'closed');
    RAISE EXCEPTION 'SMOKE_FAIL: a completion in a closed period ran: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE '%falls in closed accounting period%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong refusal for a closed-period completion: %', SQLERRM;
    END IF;
  END;
  SELECT status INTO v_status FROM public.deliveries WHERE id = v_del[3];
  SELECT count(*) INTO v_n FROM public.activity_feed WHERE event_type = 'delivery_confirmed' AND related_entity_id = v_del[3];
  IF v_status IS DISTINCT FROM 'scheduled' OR v_n <> 0
     OR EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key LIKE v_prefix || 'closed%') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused completion left delivery 3 % with % start rows (or a receipt)', v_status, v_n;
  END IF;

  -- h. An in_progress delivery completes without a start.
  v_res := public.start_and_complete_delivery(v_del[4], '[SMOKE] Receiver', v_today, v_admin, NULL, NULL, NULL, v_prefix || 'in-progress');
  IF v_res->>'status' IS DISTINCT FROM 'completed' OR (v_res->>'started')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the in_progress delivery did not complete without a start: %', v_res;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
