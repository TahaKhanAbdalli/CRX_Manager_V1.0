-- Post-apply rollback-only chain for 20261014210000_order_invoices_rep_own_name: a sales rep
-- turning an order into invoices names only themselves as salesperson; admins name anyone.
--
-- FAIL-FIRST CONTRACT: against the pre-fix wrappers a sales rep's create_invoice_from_order
-- naming another rep SUCCEEDS, making an invoice under that rep's name, and this chain raises
-- SMOKE_FAIL at step 1. Against the fix:
--   1-3. create_invoice_from_order: a rep naming another rep or an admin is SALESMAN_SCOPE_DENIED
--        with nothing written, even on a key that already replays; a rep naming themselves
--        works and replays exactly; a NULL salesperson is refused on another rep's order and
--        resolves to the rep on the rep's own order and to no one on an order with none; an
--        admin names another rep.
--   4.   create_split_invoices_from_order on a field-allocated order: a NULL or blank key is
--        IDEMPOTENCY_KEY_REQUIRED, SQLSTATE 22023; field_application is ORDER_INVOICE_TYPE_NOT_ALLOWED,
--        SQLSTATE 23514, before any invoice number is drawn: no invoice sequence moves, and it leaves no
--        claim; a rep naming another rep, or passing NULL on another rep's order, is
--        SALESMAN_SCOPE_DENIED; a rep naming themselves gets
--        governed split drafts under their own name; an admin names another rep.
--   5.   complete_delivery's automatic split, which sends a NULL salesperson and marks its own
--        call, still creates the governed split drafts under the order's salesperson when a rep
--        completes another rep's delivery.
--
-- Fixtures: an [E2E]-marked product priced through the governed preview/apply path, two
-- existing active sales reps, and a customer assigned to the OTHER rep: reps invoice any customer,
-- Mason 2026-10-13. One DO block, terminal exception -> nothing commits.
DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;  -- the business date
  v_admin uuid;
  v_rep uuid;
  v_other_rep uuid;
  v_customer uuid;
  v_product uuid;
  v_field uuid;
  v_pricing jsonb;
  v_orders uuid[] := '{}'::uuid[];
  v_items uuid[] := '{}'::uuid[];
  v_order uuid;
  v_item uuid;
  v_i integer;
  v_invoice uuid;
  v_replay uuid;
  v_ids uuid[];
  v_delivery uuid;
  v_delivery_item uuid;
  v_key text;
  v_named uuid;
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
  -- Two existing active sales reps: no profile is created or changed, and every invoice below is
  -- rolled back. The disposable-schema proof seeds two before it runs this chain.
  SELECT id INTO v_rep
    FROM public.profiles
   WHERE role = 'sales_rep' AND is_active = true
   ORDER BY created_at, id
   LIMIT 1;
  SELECT id INTO v_other_rep
    FROM public.profiles
   WHERE role = 'sales_rep' AND is_active = true AND id IS DISTINCT FROM v_rep
   ORDER BY created_at, id
   LIMIT 1;
  IF v_rep IS NULL OR v_other_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: two active sales reps required';
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- Order lines need a positive cost basis, COST_BASIS_REQUIRED, and a product is born
  -- pricing-free, so price a fresh shell through the governed preview/apply path.
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] Own Name Product ' || v_suffix, 'GL') RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes(
    'product_page',
    NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00'
    )),
    v_admin,
    'e2e-own-name-pricing-preview-' || v_suffix
  );
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed'
     OR (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing->>'change_set_id')::uuid,
    v_pricing->>'request_fingerprint',
    v_admin,
    'e2e-own-name-pricing-apply-' || v_suffix
  );
  IF (SELECT current_cost FROM public.products WHERE id = v_product) IS DISTINCT FROM 5.00::numeric THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing apply did not price the product';
  END IF;
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
  VALUES (v_product, 'Main Warehouse', 100, 0, 'GL');

  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[E2E] Own Name Farm ' || v_suffix, v_other_rep) RETURNING id INTO v_customer;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[E2E] Own Name Field ' || v_suffix, 'corn', 100)
  RETURNING id INTO v_field;

  -- Seven orders: 1-6 with the OTHER rep as salesperson (1-3 plain, 4-5 field-allocated, 6
  -- field-allocated for the delivery-completion step), 7 plain with no salesperson.
  FOR v_i IN 1..7 LOOP
    INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
    VALUES ('E2E-OWN-NAME-' || v_i || '-' || v_suffix, v_customer, v_today, 'confirmed', false,
            CASE WHEN v_i = 7 THEN NULL ELSE v_other_rep END)
    RETURNING id INTO v_order;
    INSERT INTO public.order_items (
      order_id, product_id, product_name, price_per_unit, cost_per_unit,
      total_units_needed, total_price, profit, net_margin,
      quantity_delivered, quantity_remaining
    ) VALUES (
      v_order, v_product, '[E2E] own name line ' || v_i, 10, 5,
      2, 20, 10, 50, 0, 2
    ) RETURNING id INTO v_item;
    IF v_i BETWEEN 4 AND 6 THEN
      INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
      VALUES (v_item, v_field, 100);
    END IF;
    v_orders := v_orders || v_order;
    v_items := v_items || v_item;
  END LOOP;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);

  -- 1. create_invoice_from_order: a rep naming another rep, or an admin, is refused and
  --    writes nothing. FAIL-FIRST: before 20261014210000 the first call succeeds.
  FOREACH v_named IN ARRAY ARRAY[v_other_rep, v_admin] LOOP
    v_key := 'e2e-own-name-single-denied-' || v_named || '-' || v_suffix;
    BEGIN
      PERFORM public.create_invoice_from_order(v_orders[1], v_named, 'chemical_sale', v_key);
      RAISE EXCEPTION 'SMOKE_FAIL: a sales rep created an order invoice under another profile''s name';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' OR v_state <> 'P0001' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong single-invoice salesperson refusal, SQLSTATE %: %', v_state, v_err;
      END IF;
    END;
    IF EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key = v_key) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a refused order invoice recorded its idempotency key';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_orders[1]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused order invoice left an invoice behind';
  END IF;

  -- 2. The rep naming themselves works on another rep's customer and order, replays exactly,
  --    and the refusal runs before the replay lookup, so a used key cannot rename the invoice.
  v_key := 'e2e-own-name-single-self-' || v_suffix;
  v_invoice := public.create_invoice_from_order(v_orders[1], v_rep, 'chemical_sale', v_key);
  v_replay := public.create_invoice_from_order(v_orders[1], v_rep, 'chemical_sale', v_key);
  IF v_invoice IS NULL OR v_replay IS DISTINCT FROM v_invoice THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the rep''s own-name order invoice did not create and replay exactly';
  END IF;
  BEGIN
    PERFORM public.create_invoice_from_order(v_orders[1], v_other_rep, 'chemical_sale', v_key);
    RAISE EXCEPTION 'SMOKE_FAIL: a reused key let a rep name another salesperson';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong reused-key salesperson refusal: %', v_err;
    END IF;
  END;

  -- 3. A NULL salesperson resolves to the order's salesperson, so a rep is refused on another
  --    rep's order (FAIL-FIRST against the first fix: it accepted this), allowed on their own
  --    order and on an order with no salesperson; an admin may name any rep.
  BEGIN
    PERFORM public.create_invoice_from_order(v_orders[2], NULL, 'chemical_sale', 'e2e-own-name-single-null-other-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a NULL salesperson let a rep invoice under another rep''s name';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong NULL-salesperson refusal: %', v_err;
    END IF;
  END;
  -- An admin makes it the rep's own order (since 20261015130000 a rep cannot take over another
  -- rep's order themselves).
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  UPDATE public.orders SET salesman_id = v_rep WHERE id = v_orders[2];
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  v_ids := ARRAY[
    public.create_invoice_from_order(v_orders[2], NULL, 'chemical_sale', 'e2e-own-name-single-null-' || v_suffix),
    public.create_invoice_from_order(v_orders[7], NULL, 'chemical_sale', 'e2e-own-name-single-none-' || v_suffix)
  ];
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_ids := v_ids || public.create_invoice_from_order(
    v_orders[3], v_other_rep, 'chemical_sale', 'e2e-own-name-single-admin-' || v_suffix
  );
  IF (SELECT salesman_id FROM public.invoices WHERE id = v_invoice) IS DISTINCT FROM v_rep
     OR (SELECT created_by FROM public.invoices WHERE id = v_invoice) IS DISTINCT FROM v_rep
     OR (SELECT salesman_id FROM public.invoices WHERE id = v_ids[1]) IS DISTINCT FROM v_rep
     OR (SELECT salesman_id FROM public.invoices WHERE id = v_ids[2]) IS NOT NULL
     OR (SELECT salesman_id FROM public.invoices WHERE id = v_ids[3]) IS DISTINCT FROM v_other_rep
     OR (SELECT count(*) FROM public.invoices WHERE order_id = ANY (v_orders[1:3] || v_orders[7])) <> 4 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: order invoices carry the wrong salesperson or count';
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);

  -- 4a. The split wrapper now requires its idempotency key, like create_invoice_from_order.
  FOREACH v_key IN ARRAY ARRAY[NULL, '   ']::text[] LOOP
    BEGIN
      PERFORM public.create_split_invoices_from_order(v_orders[4], v_rep, 'chemical_sale', v_key);
      RAISE EXCEPTION 'SMOKE_FAIL: create_split_invoices_from_order accepted a missing key';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_err NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order%' OR v_state <> '22023' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong split missing-key refusal, SQLSTATE %: %', v_state, v_err;
      END IF;
    END;
  END LOOP;

  -- 4b. A field_application split is refused before any invoice number is drawn: no invoice
  --     sequence moves. Sequences are not transactional, so a drawn number would stay drawn.
  SELECT string_agg(seqname || '=' || COALESCE(pg_sequence_last_value(to_regclass('public.' || seqname))::text, 'null'), ',' ORDER BY seqname)
    INTO v_seq_before
    FROM unnest(ARRAY['cs_invoice_number_seq', 'mc_invoice_number_seq', 'cm_invoice_number_seq', 'invoice_number_seq']) AS seqname
   WHERE to_regclass('public.' || seqname) IS NOT NULL;
  BEGIN
    PERFORM public.create_split_invoices_from_order(
      v_orders[4], v_rep, 'field_application', 'e2e-own-name-split-field-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: create_split_invoices_from_order accepted field_application';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'ORDER_INVOICE_TYPE_NOT_ALLOWED:%' OR v_state <> '23514' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong split type refusal, SQLSTATE %: %', v_state, v_err;
    END IF;
  END;
  SELECT string_agg(seqname || '=' || COALESCE(pg_sequence_last_value(to_regclass('public.' || seqname))::text, 'null'), ',' ORDER BY seqname)
    INTO v_seq_after
    FROM unnest(ARRAY['cs_invoice_number_seq', 'mc_invoice_number_seq', 'cm_invoice_number_seq', 'invoice_number_seq']) AS seqname
   WHERE to_regclass('public.' || seqname) IS NOT NULL;
  IF v_seq_after IS DISTINCT FROM v_seq_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused field_application split drew an invoice number (% -> %)', v_seq_before, v_seq_after;
  END IF;

  -- 4c. A rep naming another rep on a split, or passing NULL on another rep's order outside
  --     complete_delivery's marked call, is refused and writes nothing.
  FOREACH v_named IN ARRAY ARRAY[v_other_rep, NULL]::uuid[] LOOP
    BEGIN
      PERFORM public.create_split_invoices_from_order(
        v_orders[4], v_named, 'chemical_sale', 'e2e-own-name-split-denied-' || COALESCE(v_named::text, 'null') || '-' || v_suffix
      );
      RAISE EXCEPTION 'SMOKE_FAIL: a sales rep created split invoices under another rep''s name (named %)', COALESCE(v_named::text, 'NULL');
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' OR v_state <> 'P0001' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong split salesperson refusal, SQLSTATE %: %', v_state, v_err;
      END IF;
    END;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_orders[4])
     OR EXISTS (SELECT 1 FROM public.split_invoice_creation_claims WHERE order_id = v_orders[4]) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused split left an invoice or creation claim behind';
  END IF;

  -- 4d. The rep naming themselves gets governed split drafts under their own name, replayed
  --     exactly; an admin may name another rep.
  v_key := 'e2e-own-name-split-self-' || v_suffix;
  v_ids := public.create_split_invoices_from_order(v_orders[4], v_rep, 'chemical_sale', v_key);
  IF COALESCE(cardinality(v_ids), 0) = 0
     OR public.create_split_invoices_from_order(v_orders[4], v_rep, 'chemical_sale', v_key) IS DISTINCT FROM v_ids THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the rep''s own-name split did not create and replay exactly';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  IF EXISTS (SELECT 1 FROM unnest(v_ids) AS r JOIN public.invoices i ON i.id = r
              WHERE i.salesman_id IS DISTINCT FROM v_rep OR i.invoice_group_id IS NULL)
     OR (SELECT count(*) FROM public.split_invoice_provenance p WHERE p.invoice_id = ANY (v_ids))
          <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the rep''s split drafts are not governed drafts under the rep''s name';
  END IF;
  v_ids := public.create_split_invoices_from_order(
    v_orders[5], v_other_rep, 'chemical_sale', 'e2e-own-name-split-admin-' || v_suffix
  );
  IF COALESCE(cardinality(v_ids), 0) = 0
     OR EXISTS (SELECT 1 FROM unnest(v_ids) AS r JOIN public.invoices i ON i.id = r
                 WHERE i.salesman_id IS DISTINCT FROM v_other_rep) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an admin could not create split drafts naming another rep';
  END IF;

  -- 5. complete_delivery's automatic split sends a NULL salesperson, so a rep completing the
  --    delivery still gets the governed split drafts, under the order's salesperson. The
  --    automatic split swallows its own errors, so assert the drafts and their feed row.
  INSERT INTO public.deliveries (
    delivery_number, order_id, customer_id, assigned_driver, scheduled_date, status, created_by
  ) VALUES (
    'E2E-OWN-NAME-DEL-' || v_suffix, v_orders[6], v_customer, NULL, v_today, 'scheduled', v_admin
  ) RETURNING id INTO v_delivery;
  INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
  VALUES (v_delivery, v_items[6], v_product, 2, 0, 'GL')
  RETURNING id INTO v_delivery_item;
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  PERFORM public.complete_delivery(
    v_delivery, 'Smoke Receiver', v_rep,
    jsonb_build_object(v_delivery_item::text, 2),
    NULL, NULL, 'e2e-own-name-complete-' || v_suffix, NULL
  );
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  IF (SELECT status FROM public.deliveries WHERE id = v_delivery) IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the delivery did not complete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.activity_feed
                  WHERE event_type = 'split_invoices_auto_created'
                    AND related_entity_id = v_orders[6])
     OR (SELECT count(*) FROM public.invoices i
           JOIN public.split_invoice_provenance p ON p.invoice_id = i.id
          WHERE i.order_id = v_orders[6]
            AND i.invoice_group_id IS NOT NULL
            AND i.salesman_id = v_other_rep) = 0
     OR EXISTS (SELECT 1 FROM public.invoices
                 WHERE order_id = v_orders[6] AND salesman_id IS DISTINCT FROM v_other_rep)
     OR (SELECT needs_split_billing FROM public.orders WHERE id = v_orders[6]) IS TRUE THEN
    RAISE EXCEPTION 'SMOKE_FAIL: completing the delivery did not auto-create governed split drafts under the order''s salesperson';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
