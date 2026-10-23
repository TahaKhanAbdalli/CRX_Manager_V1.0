-- Post-apply rollback-only chain for 20261022021000_order_invoice_refuses_field_split:
-- create_invoice_from_order refuses an order whose lines are split across fields, after its
-- replay lookup.
--
-- FAIL-FIRST CONTRACT: against the pre-fix implementation create_invoice_from_order on a
-- field-allocated order SUCCEEDS, billing the order's own customer for every field owner's share,
-- and this chain raises SMOKE_FAIL at step 1. Against the fix:
--   1. an order with every line allocated is ORDER_HAS_FIELD_SPLIT, SQLSTATE 23514: no invoice, no
--      saved key, and no invoice sequence moves;
--   2. an order with only one of two lines allocated is refused the same way;
--   3. an invoice created before its order was split (its draft voided first, since an active
--      invoice blocks a new allocation) still replays exactly under its key, a reused
--      key with different arguments is still IDEMPOTENCY_ARGUMENT_MISMATCH, and a new key is
--      ORDER_HAS_FIELD_SPLIT;
--   4. create_split_invoices_from_order still bills the allocated order as governed per-owner
--      drafts (here one: the split step's field belongs to the ordering customer, see below);
--   5. a cancelled allocated order is still ORDER_INVOICE_TERMINAL (the terminal test runs first);
--   6. an allocated order with a live delivery gets the billing core's own live-delivery refusal,
--      word for word (it passes before the fix too, where the core raises it).
--
-- Fixtures: an [E2E]-marked product priced through the governed preview/apply path, an ordering
-- customer and a separate field-owner customer whose field the allocated lines are split onto.
-- Runs as the earliest active admin. One DO block, terminal exception -> nothing commits.
DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;  -- the business date
  v_admin uuid;
  v_customer uuid;
  v_owner uuid;
  v_product uuid;
  v_field uuid;
  v_own_field uuid;
  v_pricing jsonb;
  v_orders uuid[] := '{}'::uuid[];
  v_items uuid[] := '{}'::uuid[];
  v_order uuid;
  v_item uuid;
  v_i integer;
  v_invoice uuid;
  v_ids uuid[];
  v_key text;
  v_seq_before text;
  v_seq_after text;
  v_err text;
  v_state text;
BEGIN
  SELECT id INTO v_admin
    FROM public.profiles
   WHERE role = 'admin' AND is_active = true
   ORDER BY created_at
   LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- Order lines need a positive cost basis, COST_BASIS_REQUIRED, and a product is born
  -- pricing-free, so price a fresh shell through the governed preview/apply path.
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] Field Split Product ' || v_suffix, 'GL') RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes(
    'product_page',
    NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00'
    )),
    v_admin,
    'e2e-field-split-pricing-preview-' || v_suffix
  );
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed'
     OR (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing->>'change_set_id')::uuid,
    v_pricing->>'request_fingerprint',
    v_admin,
    'e2e-field-split-pricing-apply-' || v_suffix
  );
  IF (SELECT current_cost FROM public.products WHERE id = v_product) IS DISTINCT FROM 5.00::numeric THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing apply did not price the product';
  END IF;
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
  VALUES (v_product, 'Main Warehouse', 100, 0, 'GL');

  INSERT INTO public.customers (farm_name)
  VALUES ('[E2E] Field Split Orderer ' || v_suffix) RETURNING id INTO v_customer;
  INSERT INTO public.customers (farm_name)
  VALUES ('[E2E] Field Split Owner ' || v_suffix) RETURNING id INTO v_owner;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_owner, '[E2E] Field Split Field ' || v_suffix, 'corn', 100)
  RETURNING id INTO v_field;
  -- The split step bills a field the ordering customer owns, to keep it to one draft; billing
  -- another owner through a split (20261021150000) has its own chain.
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[E2E] Field Split Own Field ' || v_suffix, 'corn', 100)
  RETURNING id INTO v_own_field;

  -- Five orders, one line each except order 3 (two lines): 1 every line allocated; 2 unallocated
  -- (invoiced, then split, for the replay step); 3 only its second line allocated; 4 allocated, for
  -- the split path; 5 allocated, then cancelled.
  FOR v_i IN 1..5 LOOP
    INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
    VALUES ('E2E-FIELD-SPLIT-' || v_i || '-' || v_suffix, v_customer, v_today, 'confirmed', false, NULL)
    RETURNING id INTO v_order;
    INSERT INTO public.order_items (
      order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin,
      quantity_delivered, quantity_remaining, sort_order
    ) VALUES (
      v_order, v_product, '[E2E] field split line ' || v_i, 10, 5,
      2, 20, 10, 50, 0, 2, 1
    ) RETURNING id INTO v_item;
    IF v_i = 3 THEN
      -- The first line stays unallocated; the second is split onto the field.
      INSERT INTO public.order_items (
        order_id, product_id, product_name, price_per_unit, cost_per_unit,
        total_units_needed, total_price, profit, net_margin,
        quantity_delivered, quantity_remaining, sort_order
      ) VALUES (
        v_order, v_product, '[E2E] field split line 3b', 10, 5,
        2, 20, 10, 50, 0, 2, 2
      ) RETURNING id INTO v_item;
    END IF;
    IF v_i IN (1, 3, 4, 5) THEN
      INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
      VALUES (v_item, CASE WHEN v_i = 4 THEN v_own_field ELSE v_field END, 100);
    END IF;
    v_orders := v_orders || v_order;
    v_items := v_items || v_item;
  END LOOP;

  -- 1. An order split across fields is refused before anything is written. FAIL-FIRST: before
  --    20261022021000 this call succeeds and bills the ordering customer for the owner's share.
  SELECT string_agg(seqname || '=' || COALESCE(pg_sequence_last_value(to_regclass('public.' || seqname))::text, 'null'), ',' ORDER BY seqname)
    INTO v_seq_before
    FROM unnest(ARRAY['cs_invoice_number_seq', 'mc_invoice_number_seq', 'cm_invoice_number_seq', 'invoice_number_seq']) AS seqname
   WHERE to_regclass('public.' || seqname) IS NOT NULL;
  v_key := 'e2e-field-split-refused-' || v_suffix;
  BEGIN
    PERFORM public.create_invoice_from_order(v_orders[1], NULL, 'chemical_sale', v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: create_invoice_from_order billed an order split across fields to one customer';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_HAS_FIELD_SPLIT:%' OR v_state <> '23514' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong field-split refusal, SQLSTATE %: %', v_state, v_err;
    END IF;
  END;
  SELECT string_agg(seqname || '=' || COALESCE(pg_sequence_last_value(to_regclass('public.' || seqname))::text, 'null'), ',' ORDER BY seqname)
    INTO v_seq_after
    FROM unnest(ARRAY['cs_invoice_number_seq', 'mc_invoice_number_seq', 'cm_invoice_number_seq', 'invoice_number_seq']) AS seqname
   WHERE to_regclass('public.' || seqname) IS NOT NULL;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_orders[1])
     OR EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = v_key) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused field-split order left an invoice or a saved key behind';
  END IF;
  IF v_seq_after IS DISTINCT FROM v_seq_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused field-split order drew an invoice number (% -> %)', v_seq_before, v_seq_after;
  END IF;

  -- 2. One allocated line is enough: an order with only its second line split is refused too.
  BEGIN
    PERFORM public.create_invoice_from_order(v_orders[3], NULL, 'chemical_sale', 'e2e-field-split-partial-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: create_invoice_from_order billed a partly split order to one customer';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_HAS_FIELD_SPLIT:%' OR v_state <> '23514' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong partial field-split refusal, SQLSTATE %: %', v_state, v_err;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_orders[3]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused partly split order left an invoice behind';
  END IF;

  -- 3. The refusal sits after the replay lookup: an invoice created before its order was split
  --    replays exactly; a reused key with other arguments is still a mismatch; a new key refuses.
  v_key := 'e2e-field-split-replay-' || v_suffix;
  v_invoice := public.create_invoice_from_order(v_orders[2], NULL, 'chemical_sale', v_key);
  IF v_invoice IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL: the unsplit order did not invoice'; END IF;
  -- An active invoice blocks a new allocation (ORDER_ALLOCATION_INVOICE_CONFLICT), so the order is
  -- split only after its draft is voided, the one way an invoiced order becomes split.
  PERFORM public.void_invoice(v_invoice, '[E2E] field split replay void', 'e2e-field-split-void-' || v_suffix);
  INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
  VALUES (v_items[2], v_field, 100);
  BEGIN
    IF public.create_invoice_from_order(v_orders[2], NULL, 'chemical_sale', v_key) IS DISTINCT FROM v_invoice THEN
      RAISE EXCEPTION 'SMOKE_FAIL: an exact retry of an invoice created before the split did not replay its id';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    RAISE EXCEPTION 'SMOKE_FAIL: an exact retry of an invoice created before the split did not replay its id (%)', v_err;
  END;
  BEGIN
    PERFORM public.create_invoice_from_order(v_orders[2], v_admin, 'chemical_sale', v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: a reused key with different arguments was accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_ARGUMENT_MISMATCH:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong reused-key refusal: %', v_err;
    END IF;
  END;
  BEGIN
    PERFORM public.create_invoice_from_order(v_orders[2], NULL, 'chemical_sale', 'e2e-field-split-replay-new-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a new key billed an order split after its first invoice';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_HAS_FIELD_SPLIT:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong new-key refusal on a since-split order: %', v_err;
    END IF;
  END;
  IF (SELECT count(*) FROM public.invoices WHERE order_id = v_orders[2]) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the since-split order carries other than its one original invoice';
  END IF;

  -- 4. The split path is unaffected: a governed per-owner draft for the allocated order (its field
  --    belongs to the ordering customer, so one draft for the whole line). Its
  --    no-allocation fallback is not exercised: it sends a NULL key to create_invoice_from_order,
  --    which has refused that with IDEMPOTENCY_KEY_REQUIRED since 2026-07-21 (rpc-functions.md).
  v_key := 'e2e-field-split-split-' || v_suffix;
  v_ids := public.create_split_invoices_from_order(v_orders[4], NULL, 'chemical_sale', v_key);
  IF COALESCE(cardinality(v_ids), 0) <> 1
     OR public.create_split_invoices_from_order(v_orders[4], NULL, 'chemical_sale', v_key) IS DISTINCT FROM v_ids
     OR (SELECT customer_id FROM public.invoices WHERE id = v_ids[1]) IS DISTINCT FROM v_customer
     OR (SELECT invoice_group_id FROM public.invoices WHERE id = v_ids[1]) IS NULL
     OR (SELECT total_amount_cents FROM public.invoices WHERE id = v_ids[1]) IS DISTINCT FROM 2000::bigint
     OR NOT EXISTS (SELECT 1 FROM public.split_invoice_provenance WHERE invoice_id = v_ids[1]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: create_split_invoices_from_order no longer bills the field owner as a governed draft';
  END IF;

  -- 5. The terminal-order test still runs first: a cancelled allocated order is terminal.
  UPDATE public.orders SET status = 'cancelled' WHERE id = v_orders[5];
  BEGIN
    PERFORM public.create_invoice_from_order(v_orders[5], NULL, 'chemical_sale', 'e2e-field-split-cancelled-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a cancelled order invoiced';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_INVOICE_TERMINAL:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong cancelled-order refusal: %', v_err;
    END IF;
  END;

  -- 6. An order with a live delivery gets the billing core's own refusal, word for word, before the
  --    field-split test and its line lock (so the call never waits on complete_delivery): here an
  --    allocated order with a scheduled delivery, which the core refuses the same way.
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-FIELD-SPLIT-6-' || v_suffix, v_customer, v_today, 'confirmed', false, NULL)
  RETURNING id INTO v_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, sort_order
  ) VALUES (
    v_order, v_product, '[E2E] field split line 6', 10, 5,
    2, 20, 10, 50, 0, 2, 1
  ) RETURNING id INTO v_item;
  INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
  VALUES (v_item, v_field, 100);
  INSERT INTO public.deliveries (delivery_number, order_id, customer_id, status, created_by)
  VALUES ('E2E-FIELD-SPLIT-D6-' || v_suffix, v_order, v_customer, 'scheduled', v_admin);
  BEGIN
    PERFORM public.create_invoice_from_order(v_order, NULL, 'chemical_sale', 'e2e-field-split-delivery-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: an order with a live delivery invoiced';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'Cannot create an order-level invoice for order E2E-FIELD-SPLIT-6-' || v_suffix
         || ' — it has 1 active delivery(ies); invoices are created per delivery on completion. Cancel/void those deliveries first to bill the whole order manually.' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong live-delivery refusal: %', v_err;
    END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
