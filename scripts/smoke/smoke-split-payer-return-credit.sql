-- Post-apply rollback-only chain for 20261021155000_split_payer_return_credit: a field owner billed
-- through a split (a customer other than the order's) can return its billed share and receive its
-- own return credit, and no payer can return another payer's share.
--
-- FAIL-FIRST CONTRACT: before the fix create_return refuses any returner other than the order's
-- customer (RETURN_ORDER_CUSTOMER_MISMATCH), and this chain raises SMOKE_FAIL at step 1. Against
-- the fix:
--   0. setup: an order for customer A with two lines on one field billed 50/50 to A and landlord B
--      (line 1: 4 GL at 10.00; line 2: 1 GL at 10.01, whose cents split unevenly), delivered in full
--      through complete_delivery, split into two governed invoices and posted;
--   1. B returns 1 GL of line 1: the return is B's, priced 10.00 from B's own billed cents;
--   2. refusals: B returning more than its open share (RETURN_QUANTITY_EXCEEDS_BILLED_SHARE); A
--      returning more than A was billed although the goods were delivered (same code); customer D,
--      billed nothing on the order (RETURN_ORDER_CUSTOMER_MISMATCH);
--   3. B's return is approved, received (restocked) and credited: one posted credit memo for B on
--      A's order, -10.00, its one line backed by B's split invoice line, the claim gone;
--   4. the memo is applied to B's split invoice (the guard admits the memo's UPDATE as the credit of
--      B's return);
--   (1 also checks the Returns screen's read-only lookups: B may then return 1 GL / 0.5 GL more, A
--    2 GL, D nothing, and they show what is left of B's billed share in quantity and cents;)
--   4b. the payer billed the odd cent on line 2 returns it in two parts, priced 2.51 then 2.50 (the
--      lookup quotes the 2.50 first); after the first is cancelled the second's price is stale, and
--      issue_return_credit (i) and receive_return (ii) refuse it (RETURN_SPLIT_SHARE_REPRICED);
--   5. B's whole share of line 2 credits exactly what B was billed for it, not a cent more;
--   5b. on a second split order whose invoices are still drafts, A cannot return anything
--      (RETURN_SPLIT_SHARE_NOT_BILLED);
--   5c. on a third split order whose line has no unit, the split invoices bill it as 'ea', and B's
--      return of it is created, received and credited (-10.00) from B's own line;
--   6. the guard still refuses a credit memo for B on A's order with no claim, and a memo for D
--      inside a claim for B (INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID).
--
-- Fixtures: an [E2E]-marked product priced through the governed preview/apply path, three
-- customers and one field. Runs as the earliest active admin. One DO block, terminal exception ->
-- nothing commits. CONTAINER ONLY: delivering, invoicing and crediting draw customer-visible numbers.
DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;  -- the business date
  v_admin uuid;
  v_rep uuid;
  v_a uuid;
  v_b uuid;
  v_d uuid;
  v_field uuid;
  v_product uuid;
  v_pricing jsonb;
  v_order uuid;
  v_line1 uuid;
  v_line2 uuid;
  v_delivery uuid;
  v_group uuid;
  v_b_invoice uuid;
  v_b_line1_item uuid;
  v_b_line2_cents bigint;
  v_return uuid;
  v_return2 uuid;
  v_return3 uuid;
  v_p uuid;
  v_round int;
  v_first uuid;
  v_second uuid;
  v_memo uuid;
  v_order2 uuid;
  v_line3 uuid;
  v_delivery2 uuid;
  v_order3 uuid;
  v_line4 uuid;
  v_delivery3 uuid;
  v_group3 uuid;
  v_b_line4_item uuid;
  v_return4 uuid;
  v_res jsonb;
  v_err text;
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

  -- 0. Setup. Order lines need a positive cost basis, so price a fresh product shell through the
  --    governed preview/apply path.
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] Split Payer Return Product ' || v_suffix, 'GL') RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes(
    'product_page',
    NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00'
    )),
    v_admin,
    'e2e-split-return-pricing-preview-' || v_suffix
  );
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed'
     OR (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing->>'change_set_id')::uuid,
    v_pricing->>'request_fingerprint',
    v_admin,
    'e2e-split-return-pricing-apply-' || v_suffix
  );
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
  VALUES (v_product, 'Main Warehouse', 100, 0, 'GL');

  INSERT INTO public.customers (farm_name) VALUES ('[E2E] Split Return A ' || v_suffix) RETURNING id INTO v_a;
  INSERT INTO public.customers (farm_name) VALUES ('[E2E] Split Return B ' || v_suffix) RETURNING id INTO v_b;
  INSERT INTO public.customers (farm_name) VALUES ('[E2E] Split Return D ' || v_suffix) RETURNING id INTO v_d;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_a, '[E2E] Split Return Field ' || v_suffix, 'corn', 100) RETURNING id INTO v_field;
  INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary)
  VALUES (v_field, v_a, 50, true), (v_field, v_b, 50, false);

  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-SPLIT-RETURN-' || v_suffix, v_a, v_today, 'confirmed', false, NULL)
  RETURNING id INTO v_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit, unit_size,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, sort_order
  ) VALUES (
    v_order, v_product, '[E2E] split return line 1', 10, 5, 'GL', 4, 40, 20, 50, 0, 4, 1
  ) RETURNING id INTO v_line1;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit, unit_size,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, sort_order
  ) VALUES (
    v_order, v_product, '[E2E] split return line 2', 10.01, 5, 'GL', 1, 10.01, 5.01, 50, 0, 1, 2
  ) RETURNING id INTO v_line2;
  INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
  VALUES (v_line1, v_field, 100), (v_line2, v_field, 100);

  -- Deliver everything through the canonical completion boundary. A same-day completion of a
  -- field-allocated order creates the per-owner split drafts itself; create them if it did not.
  INSERT INTO public.deliveries (delivery_number, order_id, customer_id, scheduled_date, status, created_by)
  VALUES ('E2E-SPLIT-RETURN-D-' || v_suffix, v_order, v_a, v_today, 'scheduled', v_admin)
  RETURNING id INTO v_delivery;
  INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
  VALUES (v_delivery, v_line1, v_product, 4, 4, 'GL'), (v_delivery, v_line2, v_product, 1, 1, 'GL');
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery;
  v_res := public.complete_delivery(
    v_delivery, '[E2E] Split Return Receiver', v_admin,
    NULL, NULL, NULL, 'e2e-split-return-complete-' || v_suffix, now()
  );
  IF v_res->>'delivery_id' IS DISTINCT FROM v_delivery::text THEN
    RAISE EXCEPTION 'SMOKE_SETUP: complete_delivery returned an unexpected receipt: %', v_res;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_order AND invoice_group_id IS NOT NULL) THEN
    PERFORM public.create_split_invoices_from_order(v_order, NULL, 'chemical_sale', 'e2e-split-return-split-' || v_suffix);
  END IF;
  SELECT invoice_group_id INTO v_group
    FROM public.invoices WHERE order_id = v_order AND invoice_group_id IS NOT NULL LIMIT 1;
  PERFORM public.post_invoice_group(v_group, v_admin,
    (SELECT jsonb_object_agg(i.id, public._invoice_post_version(i.id)) FROM public.invoices i WHERE i.invoice_group_id = v_group AND i.deleted_at IS NULL),
    'e2e-split-return-post-' || v_suffix);
  SELECT i.id INTO v_b_invoice
    FROM public.invoices i WHERE i.invoice_group_id = v_group AND i.customer_id = v_b;
  SELECT ii.id INTO v_b_line1_item
    FROM public.invoice_items ii WHERE ii.invoice_id = v_b_invoice AND ii.order_item_id = v_line1;
  SELECT ii.extended_cents INTO v_b_line2_cents
    FROM public.invoice_items ii WHERE ii.invoice_id = v_b_invoice AND ii.order_item_id = v_line2;
  IF v_b_invoice IS NULL
     OR (SELECT count(*) FROM public.invoices WHERE invoice_group_id = v_group) <> 2
     OR EXISTS (SELECT 1 FROM public.invoices WHERE invoice_group_id = v_group AND status IS DISTINCT FROM 'posted')
     OR (SELECT ii.quantity FROM public.invoice_items ii WHERE ii.id = v_b_line1_item) IS DISTINCT FROM 2::numeric
     OR (SELECT ii.extended_cents FROM public.invoice_items ii WHERE ii.id = v_b_line1_item) IS DISTINCT FROM 2000::bigint
     OR v_b_line2_cents IS NULL OR v_b_line2_cents NOT IN (500, 501) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the delivered order did not split into posted A and B invoices (B line 1: 2 GL, 20.00)';
  END IF;

  -- 1. B, the landlord, returns 1 GL of line 1. FAIL-FIRST: before 20261021155000 the return must
  --    be the order customer's.
  BEGIN
    v_res := public.create_return(
      jsonb_build_object('customer_id', v_b, 'order_id', v_order, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line1, 'quantity', 1, 'condition', 'unopened', 'restock', true)),
      'e2e-split-return-create-b1-' || v_suffix
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: a split payer''s return was refused: %', v_err;
  END;
  v_return := (v_res->>'return_id')::uuid;
  IF (SELECT customer_id FROM public.returns WHERE id = v_return) IS DISTINCT FROM v_b
     OR (SELECT extended_cents FROM public.return_items WHERE return_id = v_return) IS DISTINCT FROM 1000::bigint
     OR (SELECT unit_price_cents FROM public.return_items WHERE return_id = v_return) IS DISTINCT FROM 1000::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: B''s return is not B''s 1 GL at 10.00';
  END IF;
  -- The split in step 0 froze the billing defaults for the rest of its transaction (this one), so
  -- no field edit could commit between its per-field reads: SHARE blocks every write until commit.
  IF NOT EXISTS (
    SELECT 1 FROM pg_locks l
     WHERE l.locktype = 'relation'
       AND l.relation = 'public.field_billing_defaults'::regclass
       AND l.mode = 'ShareLock'
       AND l.granted
       AND l.pid = pg_backend_pid()
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the split did not hold the billing defaults in SHARE mode for its transaction';
  END IF;
  -- The Returns screen's read-only lookups follow the same rule: with B's 1 GL open, B may return
  -- 1 GL more of line 1 and 0.5 GL of line 2, A 2 GL of line 1, D nothing; the order is among B's
  -- split-billed orders.
  IF NOT (v_order IN (SELECT public.get_split_payer_return_orders(v_b)))
     OR (SELECT returnable_qty FROM public.get_return_line_allowances(v_order, v_b) WHERE order_item_id = v_line1) IS DISTINCT FROM 1::numeric
     OR (SELECT returnable_qty FROM public.get_return_line_allowances(v_order, v_b) WHERE order_item_id = v_line2) IS DISTINCT FROM 0.5::numeric
     OR (SELECT returnable_qty FROM public.get_return_line_allowances(v_order, v_a) WHERE order_item_id = v_line1) IS DISTINCT FROM 2::numeric
     OR EXISTS (SELECT 1 FROM public.get_return_line_allowances(v_order, v_d)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the return lookups do not show B 1 GL / 0.5 GL, A 2 GL, and nothing for D';
  END IF;
  -- The screen shows what is left of each payer's own billed share, not the order price: B 1 GL /
  -- 10.00 of line 1 (2 GL / 20.00 billed, 1 GL / 10.00 open), 0.5 GL / 5.00 or 5.01 of line 2.
  IF (SELECT share_left_qty FROM public.get_return_line_allowances(v_order, v_b) WHERE order_item_id = v_line1) IS DISTINCT FROM 1::numeric
     OR (SELECT share_left_cents FROM public.get_return_line_allowances(v_order, v_b) WHERE order_item_id = v_line1) IS DISTINCT FROM 1000::bigint
     OR (SELECT share_left_qty FROM public.get_return_line_allowances(v_order, v_b) WHERE order_item_id = v_line2) IS DISTINCT FROM 0.5::numeric
     OR (SELECT share_left_cents FROM public.get_return_line_allowances(v_order, v_b) WHERE order_item_id = v_line2) IS DISTINCT FROM v_b_line2_cents THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the return lookup does not show what is left of B''s own billed share';
  END IF;
  -- A sales rep who neither created B's split invoice nor is its salesperson cannot read it under
  -- invoices_select, so the lookups show that rep nothing about it.
  SELECT id INTO v_rep FROM public.profiles
   WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_rep IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active sales rep required'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  IF v_order IN (SELECT public.get_split_payer_return_orders(v_b))
     OR EXISTS (SELECT 1 FROM public.get_return_line_allowances(v_order, v_b))
     OR EXISTS (SELECT 1 FROM public.get_return_line_allowances(v_order, v_a)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep who cannot read the split invoices saw their billing through the return lookups';
  END IF;
  -- Nor can that rep create B's return, which would store a price derived from B's hidden invoice.
  BEGIN
    PERFORM public.create_return(
      jsonb_build_object('customer_id', v_b, 'order_id', v_order, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line1, 'quantity', 0.5)),
      'e2e-split-return-create-rep-hidden-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep who cannot read B''s split invoice created B''s return';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF position('RETURN_SPLIT_INVOICE_NOT_VISIBLE' IN v_err) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the hidden-invoice return failed for the wrong reason: %', v_err;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- 2a. B cannot return more than its open billed share (2 GL billed, 1 GL already open).
  BEGIN
    PERFORM public.create_return(
      jsonb_build_object('customer_id', v_b, 'order_id', v_order, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line1, 'quantity', 1.5)),
      'e2e-split-return-create-b-over-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: B returned more than its billed share';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF position('RETURN_QUANTITY_EXCEEDS_BILLED_SHARE' IN v_err) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: B''s over-share return failed for the wrong reason: %', v_err;
    END IF;
  END;
  -- 2b. A cannot return B's share: 3 GL fit the delivered 4 GL (1 GL open), but A was billed 2 GL.
  BEGIN
    PERFORM public.create_return(
      jsonb_build_object('customer_id', v_a, 'order_id', v_order, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line1, 'quantity', 3)),
      'e2e-split-return-create-a-over-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: the order customer returned the landlord''s share';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF position('RETURN_QUANTITY_EXCEEDS_BILLED_SHARE' IN v_err) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: A''s over-share return failed for the wrong reason: %', v_err;
    END IF;
  END;
  -- 2c. D, billed nothing on the order, cannot return from it.
  BEGIN
    PERFORM public.create_return(
      jsonb_build_object('customer_id', v_d, 'order_id', v_order, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line1, 'quantity', 1)),
      'e2e-split-return-create-d-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: a customer billed nothing on the order returned from it';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF position('RETURN_ORDER_CUSTOMER_MISMATCH' IN v_err) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: D''s return failed for the wrong reason: %', v_err;
    END IF;
  END;

  -- 3. Approve, receive and credit B's return.
  BEGIN
    PERFORM public.approve_return(v_return, v_admin, 'e2e-split-return-approve-' || v_suffix);
    PERFORM public.receive_return(v_return, v_admin, 'e2e-split-return-receive-' || v_suffix);
    v_res := public.issue_return_credit(v_return, v_admin, 'e2e-split-return-credit-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: B''s return could not be received and credited: %', v_err;
  END;
  SELECT credit_invoice_id INTO v_memo FROM public.returns WHERE id = v_return;
  IF (SELECT status FROM public.returns WHERE id = v_return) IS DISTINCT FROM 'credited'
     OR (SELECT bool_and(restocked) FROM public.return_items WHERE return_id = v_return) IS DISTINCT FROM true
     OR (SELECT i.customer_id FROM public.invoices i WHERE i.id = v_memo) IS DISTINCT FROM v_b
     OR (SELECT i.order_id FROM public.invoices i WHERE i.id = v_memo) IS DISTINCT FROM v_order
     OR (SELECT i.invoice_type FROM public.invoices i WHERE i.id = v_memo) IS DISTINCT FROM 'credit_memo'
     OR (SELECT i.status FROM public.invoices i WHERE i.id = v_memo) IS DISTINCT FROM 'posted'
     OR (SELECT i.total_amount_cents FROM public.invoices i WHERE i.id = v_memo) IS DISTINCT FROM -1000::bigint
     OR (SELECT count(*) FROM public.invoice_items ii WHERE ii.invoice_id = v_memo AND ii.quantity < 0) <> 1
     OR EXISTS (SELECT 1 FROM public.invoice_items ii
                 WHERE ii.invoice_id = v_memo AND ii.quantity < 0
                   AND ii.return_credit_source_item_id IS DISTINCT FROM v_b_line1_item)
     OR EXISTS (SELECT 1 FROM public.return_credit_customer_claims) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: B''s credit is not one posted -10.00 memo for B on the order, backed by B''s own line';
  END IF;

  -- 4. Apply the memo to B's split invoice.
  BEGIN
    PERFORM public.apply_credit_memo_to_invoice(v_memo, v_b_invoice, 1000, v_admin, 'e2e-split-return-apply-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: B''s credit memo could not be applied to B''s invoice: %', v_err;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.credit_memo_applications cma
     WHERE cma.credit_memo_id = v_memo AND cma.target_invoice_id = v_b_invoice AND cma.amount_cents = 1000
  ) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no 10.00 application of B''s memo to B''s invoice was recorded';
  END IF;

  -- 4b. Line 2's payer P billed the odd 5.01 for 0.5 GL (A or B, by the split's penny rounding).
  --     Two 0.25 GL returns telescope: 2.51, then 2.50, and the lookup quotes the second exactly
  --     before it is made. Cancelling the first leaves the second's 2.50 stale (alone it would be
  --     2.51), so crediting it (i) or receiving it (ii) refuses RETURN_SPLIT_SHARE_REPRICED. Each
  --     return is cancelled again, so step 5 starts with nothing open on line 2.
  v_p := CASE WHEN v_b_line2_cents = 501 THEN v_b ELSE v_a END;
  IF (SELECT share_left_cents FROM public.get_return_line_allowances(v_order, v_p) WHERE order_item_id = v_line2) IS DISTINCT FROM 501::bigint THEN
    RAISE EXCEPTION 'SMOKE_SETUP: neither payer was billed 5.01 for line 2';
  END IF;
  FOR v_round IN 1..2 LOOP
    BEGIN
      v_res := public.create_return(
        jsonb_build_object('customer_id', v_p, 'order_id', v_order, 'reason', 'defective'),
        jsonb_build_array(jsonb_build_object('order_item_id', v_line2, 'quantity', 0.25, 'restock', true)),
        'e2e-split-return-create-p1-' || v_round || '-' || v_suffix
      );
      v_first := (v_res->>'return_id')::uuid;
      IF (SELECT extended_cents FROM public.return_items WHERE return_id = v_first) IS DISTINCT FROM 251::bigint THEN
        RAISE EXCEPTION 'SMOKE_FAIL: P''s first 0.25 GL return of line 2 is not 2.51';
      END IF;
      IF (SELECT share_left_qty FROM public.get_return_line_allowances(v_order, v_p) WHERE order_item_id = v_line2) IS DISTINCT FROM 0.25::numeric
         OR (SELECT share_left_cents FROM public.get_return_line_allowances(v_order, v_p) WHERE order_item_id = v_line2) IS DISTINCT FROM 250::bigint THEN
        RAISE EXCEPTION 'SMOKE_FAIL: after a 2.51 return of 0.25 GL the lookup does not quote the 0.25 GL / 2.50 left of P''s line-2 share';
      END IF;
      v_res := public.create_return(
        jsonb_build_object('customer_id', v_p, 'order_id', v_order, 'reason', 'defective'),
        jsonb_build_array(jsonb_build_object('order_item_id', v_line2, 'quantity', 0.25, 'restock', true)),
        'e2e-split-return-create-p2-' || v_round || '-' || v_suffix
      );
      v_second := (v_res->>'return_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
      RAISE EXCEPTION 'SMOKE_FAIL: P''s two 0.25 GL returns of line 2 were refused: %', v_err;
    END;
    IF (SELECT extended_cents FROM public.return_items WHERE return_id = v_first) IS DISTINCT FROM 251::bigint
       OR (SELECT extended_cents FROM public.return_items WHERE return_id = v_second) IS DISTINCT FROM 250::bigint THEN
      RAISE EXCEPTION 'SMOKE_FAIL: P''s two 0.25 GL returns of line 2 are not 2.51 then 2.50';
    END IF;
    -- Their unit price is P's billed rate (5.01 for 0.5 GL: 10.02), not the order's 10.01.
    IF EXISTS (SELECT 1 FROM public.return_items WHERE return_id IN (v_first, v_second)
                AND unit_price_cents IS DISTINCT FROM 1002::bigint) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: P''s line-2 returns do not show P''s billed rate 10.02 as their unit price';
    END IF;
    PERFORM public.approve_return(v_second, v_admin, 'e2e-split-return-approve-p2-' || v_round || '-' || v_suffix);
    IF v_round = 1 THEN
      -- (i) received while the first is open (2.50 is exact then), then the first is cancelled.
      BEGIN
        PERFORM public.receive_return(v_second, v_admin, 'e2e-split-return-receive-p2-' || v_suffix);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
        RAISE EXCEPTION 'SMOKE_FAIL: P''s second line-2 return could not be received: %', v_err;
      END;
      PERFORM public.cancel_return(v_first, '[E2E] cancelled first', v_admin, 'e2e-split-return-cancel-p1-1-' || v_suffix);
      BEGIN
        PERFORM public.issue_return_credit(v_second, v_admin, 'e2e-split-return-credit-p2-' || v_suffix);
        RAISE EXCEPTION 'SMOKE_FAIL: a stale split return price was credited after an earlier return was cancelled';
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
        IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
        IF position('RETURN_SPLIT_SHARE_REPRICED' IN v_err) = 0 THEN
          RAISE EXCEPTION 'SMOKE_FAIL: the stale credit failed for the wrong reason: %', v_err;
        END IF;
      END;
    ELSE
      -- (ii) the first is cancelled before the second is received.
      PERFORM public.cancel_return(v_first, '[E2E] cancelled first', v_admin, 'e2e-split-return-cancel-p1-2-' || v_suffix);
      BEGIN
        PERFORM public.receive_return(v_second, v_admin, 'e2e-split-return-receive-p2-stale-' || v_suffix);
        RAISE EXCEPTION 'SMOKE_FAIL: a stale split return price was received after an earlier return was cancelled';
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
        IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
        IF position('RETURN_SPLIT_SHARE_REPRICED' IN v_err) = 0 THEN
          RAISE EXCEPTION 'SMOKE_FAIL: the stale receipt failed for the wrong reason: %', v_err;
        END IF;
      END;
    END IF;
    PERFORM public.cancel_return(v_second, '[E2E] stale price', v_admin, 'e2e-split-return-cancel-p2-' || v_round || '-' || v_suffix);
  END LOOP;
  IF (SELECT share_left_cents FROM public.get_return_line_allowances(v_order, v_p) WHERE order_item_id = v_line2) IS DISTINCT FROM 501::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the cancelled returns still hold part of P''s line-2 share';
  END IF;

  -- 5. Returning B's whole line-2 share (0.5 GL of 1 GL at 10.01, billed 5.00 or 5.01 by the split's
  --    penny rounding) credits exactly what B was billed for it. The quantities are chosen so the
  --    order-price formula (quantity x 10.01) misses B's cents either way: one 0.5 GL return when B
  --    was billed 5.00 (order price: 5.01), two 0.25 GL returns when B was billed 5.01 (order
  --    price: 2.50 + 2.50). Each return is received and credited.
  BEGIN
    v_res := public.create_return(
      jsonb_build_object('customer_id', v_b, 'order_id', v_order, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line2,
        'quantity', CASE WHEN v_b_line2_cents = 500 THEN 0.5 ELSE 0.25 END, 'restock', true)),
      'e2e-split-return-create-b2-' || v_suffix
    );
    v_return2 := (v_res->>'return_id')::uuid;
    IF v_b_line2_cents = 501 THEN
      v_res := public.create_return(
        jsonb_build_object('customer_id', v_b, 'order_id', v_order, 'reason', 'defective'),
        jsonb_build_array(jsonb_build_object('order_item_id', v_line2, 'quantity', 0.25, 'restock', true)),
        'e2e-split-return-create-b3-' || v_suffix
      );
      v_return3 := (v_res->>'return_id')::uuid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: B''s partial return of line 2 was refused: %', v_err;
  END;
  IF (SELECT sum(extended_cents) FROM public.return_items WHERE return_id IN (v_return2, v_return3))
       IS DISTINCT FROM v_b_line2_cents::numeric THEN
    RAISE EXCEPTION 'SMOKE_FAIL: B''s partial returns of line 2 do not add up to B''s billed % cents', v_b_line2_cents;
  END IF;
  BEGIN
    PERFORM public.approve_return(v_return2, v_admin, 'e2e-split-return-approve-b2-' || v_suffix);
    PERFORM public.receive_return(v_return2, v_admin, 'e2e-split-return-receive-b2-' || v_suffix);
    IF v_return3 IS NOT NULL THEN
      PERFORM public.approve_return(v_return3, v_admin, 'e2e-split-return-approve-b3-' || v_suffix);
      PERFORM public.receive_return(v_return3, v_admin, 'e2e-split-return-receive-b3-' || v_suffix);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: B''s line-2 return could not be received: %', v_err;
  END;
  BEGIN
    PERFORM public.issue_return_credit(v_return2, v_admin, 'e2e-split-return-credit-b2-' || v_suffix);
    IF v_return3 IS NOT NULL THEN
      PERFORM public.issue_return_credit(v_return3, v_admin, 'e2e-split-return-credit-b3-' || v_suffix);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: B''s line-2 return could not be credited: %', v_err;
  END;
  IF (SELECT -sum(i.total_amount_cents) FROM public.returns r JOIN public.invoices i ON i.id = r.credit_invoice_id
       WHERE r.id IN (v_return2, v_return3)) IS DISTINCT FROM v_b_line2_cents::numeric
     OR EXISTS (SELECT 1 FROM public.returns r JOIN public.invoices i ON i.id = r.credit_invoice_id
                 WHERE r.id IN (v_return2, v_return3) AND i.customer_id IS DISTINCT FROM v_b) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: B''s line-2 credits are not exactly B''s billed % cents, all to B', v_b_line2_cents;
  END IF;
  -- The returns and their credit memo lines show B's billed rate (10.00 or 10.02), not 10.01.
  IF EXISTS (SELECT 1 FROM public.return_items WHERE return_id IN (v_return2, v_return3)
              AND unit_price_cents IS DISTINCT FROM (v_b_line2_cents * 2)::bigint)
     OR EXISTS (SELECT 1 FROM public.returns r JOIN public.invoice_items ii ON ii.invoice_id = r.credit_invoice_id
                 WHERE r.id IN (v_return2, v_return3) AND ii.quantity < 0
                   AND ii.unit_price_cents IS DISTINCT FROM (v_b_line2_cents * 2)::bigint) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: B''s line-2 returns or credit lines do not show B''s billed rate as the unit price';
  END IF;

  -- 5b. On a second split order whose per-owner invoices are still drafts, the order's own customer
  --     cannot return anything: nothing is billed to A yet, and the split will bill part to B.
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-SPLIT-RETURN-2-' || v_suffix, v_a, v_today, 'confirmed', false, NULL)
  RETURNING id INTO v_order2;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit, unit_size,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, sort_order
  ) VALUES (
    v_order2, v_product, '[E2E] split return draft line', 10, 5, 'GL', 2, 20, 10, 50, 0, 2, 1
  ) RETURNING id INTO v_line3;
  INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
  VALUES (v_line3, v_field, 100);
  INSERT INTO public.deliveries (delivery_number, order_id, customer_id, scheduled_date, status, created_by)
  VALUES ('E2E-SPLIT-RETURN-D2-' || v_suffix, v_order2, v_a, v_today, 'scheduled', v_admin)
  RETURNING id INTO v_delivery2;
  INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
  VALUES (v_delivery2, v_line3, v_product, 2, 2, 'GL');
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery2;
  PERFORM public.complete_delivery(
    v_delivery2, '[E2E] Split Return Receiver', v_admin,
    NULL, NULL, NULL, 'e2e-split-return-complete-2-' || v_suffix, now()
  );
  IF EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_order2 AND status IN ('posted', 'overdue', 'paid')) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the second split order already has a posted invoice';
  END IF;
  BEGIN
    PERFORM public.create_return(
      jsonb_build_object('customer_id', v_a, 'order_id', v_order2, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line3, 'quantity', 1)),
      'e2e-split-return-create-a-draft-' || v_suffix
    );
    RAISE EXCEPTION 'SMOKE_FAIL: the order customer returned goods its unposted split had not billed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF position('RETURN_SPLIT_SHARE_NOT_BILLED' IN v_err) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the draft-split return failed for the wrong reason: %', v_err;
    END IF;
  END;

  -- 5c. A split line with no unit: the split invoices bill it as 'ea', the unit its return carries,
  --     so the payer's return is created, received and credited from its own line (before
  --     20261021155000 the invoices copied the empty unit, and the credit refuses a source line
  --     whose unit differs: RETURN_CREDIT_UNIT_MISMATCH).
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-SPLIT-RETURN-3-' || v_suffix, v_a, v_today, 'confirmed', false, NULL)
  RETURNING id INTO v_order3;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit, unit_size,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, sort_order
  ) VALUES (
    v_order3, v_product, '[E2E] split return no-unit line', 10, 5, NULL, 2, 20, 10, 50, 0, 2, 1
  ) RETURNING id INTO v_line4;
  INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
  VALUES (v_line4, v_field, 100);
  INSERT INTO public.deliveries (delivery_number, order_id, customer_id, scheduled_date, status, created_by)
  VALUES ('E2E-SPLIT-RETURN-D3-' || v_suffix, v_order3, v_a, v_today, 'scheduled', v_admin)
  RETURNING id INTO v_delivery3;
  INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
  VALUES (v_delivery3, v_line4, v_product, 2, 2, 'GL');
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery3;
  PERFORM public.complete_delivery(
    v_delivery3, '[E2E] Split Return Receiver', v_admin,
    NULL, NULL, NULL, 'e2e-split-return-complete-3-' || v_suffix, now()
  );
  IF NOT EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_order3 AND invoice_group_id IS NOT NULL) THEN
    PERFORM public.create_split_invoices_from_order(v_order3, NULL, 'chemical_sale', 'e2e-split-return-split-3-' || v_suffix);
  END IF;
  SELECT invoice_group_id INTO v_group3
    FROM public.invoices WHERE order_id = v_order3 AND invoice_group_id IS NOT NULL LIMIT 1;
  PERFORM public.post_invoice_group(v_group3, v_admin,
    (SELECT jsonb_object_agg(i.id, public._invoice_post_version(i.id)) FROM public.invoices i WHERE i.invoice_group_id = v_group3 AND i.deleted_at IS NULL),
    'e2e-split-return-post-3-' || v_suffix);
  SELECT ii.id INTO v_b_line4_item
    FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
   WHERE i.invoice_group_id = v_group3 AND i.customer_id = v_b AND i.status = 'posted'
     AND ii.order_item_id = v_line4 AND ii.quantity = 1 AND ii.extended_cents = 1000;
  IF v_b_line4_item IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the no-unit split line was not billed to B (1 unit, 10.00)';
  END IF;
  -- B returns it (damaged, not restocked), and it is received and credited from B's own line.
  BEGIN
    v_res := public.create_return(
      jsonb_build_object('customer_id', v_b, 'order_id', v_order3, 'reason', 'defective'),
      jsonb_build_array(jsonb_build_object('order_item_id', v_line4, 'quantity', 1,
        'condition', 'damaged', 'restock', false)),
      'e2e-split-return-create-b-no-unit-' || v_suffix
    );
    v_return4 := (v_res->>'return_id')::uuid;
    PERFORM public.approve_return(v_return4, v_admin, 'e2e-split-return-approve-b-no-unit-' || v_suffix);
    PERFORM public.receive_return(v_return4, v_admin, 'e2e-split-return-receive-b-no-unit-' || v_suffix);
    PERFORM public.issue_return_credit(v_return4, v_admin, 'e2e-split-return-credit-b-no-unit-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: B''s return of the no-unit split line could not be created, received and credited: %', v_err;
  END;
  IF (SELECT i.total_amount_cents FROM public.returns r JOIN public.invoices i ON i.id = r.credit_invoice_id
       WHERE r.id = v_return4) IS DISTINCT FROM -1000::bigint
     OR EXISTS (SELECT 1 FROM public.returns r JOIN public.invoice_items ii ON ii.invoice_id = r.credit_invoice_id
                 WHERE r.id = v_return4 AND ii.quantity < 0
                   AND ii.return_credit_source_item_id IS DISTINCT FROM v_b_line4_item) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: B''s no-unit credit is not -10.00 backed by B''s own line';
  END IF;
  IF (SELECT unit_size FROM public.invoice_items WHERE id = v_b_line4_item) IS DISTINCT FROM 'ea' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the split invoice did not bill the no-unit line as ea';
  END IF;

  -- 6a. The guard: a credit memo for B on A's order, outside any claim.
  BEGIN
    INSERT INTO public.invoices (order_id, customer_id, invoice_type, status, season, created_by,
      total_amount_cents, invoice_date)
    VALUES (v_order, v_b, 'credit_memo', 'draft', public.current_season(), v_admin, -100, v_today);
    RAISE EXCEPTION 'SMOKE_FAIL: an unclaimed credit memo billed another customer on the order';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF position('INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID' IN v_err) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the unclaimed memo failed for the wrong reason: %', v_err;
    END IF;
  END;
  -- 6b. A credit memo for D inside a claim for B.
  BEGIN
    INSERT INTO public.return_credit_customer_claims (return_id, order_id, customer_id)
    VALUES (v_return2, v_order, v_b);
    INSERT INTO public.invoices (order_id, customer_id, invoice_type, status, season, created_by,
      total_amount_cents, invoice_date)
    VALUES (v_order, v_d, 'credit_memo', 'draft', public.current_season(), v_admin, -100, v_today);
    RAISE EXCEPTION 'SMOKE_FAIL: a claim for B admitted a credit memo for another customer';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF position('INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID' IN v_err) = 0 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the memo for D failed for the wrong reason: %', v_err;
    END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
