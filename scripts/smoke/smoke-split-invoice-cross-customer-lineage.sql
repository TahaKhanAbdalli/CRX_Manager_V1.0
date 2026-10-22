-- Post-apply rollback-only chain for 20261021150000_split_invoice_cross_customer_lineage: split
-- billing can bill a field owner who is not the order's customer, and only through the governed
-- split path.
--
-- FAIL-FIRST CONTRACT: against the pre-fix guard_invoice_terminal_order a split onto another
-- customer's field rolls back with INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID, and this chain raises
-- SMOKE_FAIL at step 1. Against the fix:
--   1. create_split_invoices_from_order on an order for customer A, whose lines are on (i) a field
--      split 50/50 between A and B (field_billing_defaults), (ii) a field owned by C with no
--      defaults, and (iii) a field owned by X billed wholly to Y, creates four governed drafts
--      (A 10.00, B 10.00, C 20.00, Y 20.00) that add up to the order, each with its provenance, and
--      an exact retry replays them;
--   2. post_invoice_group posts all four (the provenance branch admits each UPDATE);
--   3. refusals, each INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID unless noted. At the new exception's
--      limits: (b) a grouped invoice for D, owning no field of the split, inside a hand-made claim on
--      the split order; (c) a grouped invoice for B inside a hand-made claim on A's UNSPLIT order;
--      (f) an UNGROUPED invoice for B inside a claim on the split order; (g) a grouped invoice for X
--      in that claim, X owning a field whose billing defaults exclude X. Unchanged rules it must
--      keep: (a) a plain invoice for B on A's unsplit order; (d) re-pointing A's ordinary invoice to
--      B; (e) re-pointing a posted split invoice (SPLIT_INVOICE_PROVENANCE_IMMUTABLE, the older
--      identity trigger, which fires first);
--   4. void_invoice_group voids all four (the provenance branch admits each UPDATE).
--
-- Fixtures: an [E2E]-marked product priced through the governed preview/apply path, six
-- customers and four fields. Runs as the earliest active admin. One DO block, terminal exception ->
-- nothing commits. CONTAINER ONLY: creating and posting invoices draws customer-visible numbers.
DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;  -- the business date
  v_admin uuid;
  v_a uuid;
  v_b uuid;
  v_c uuid;
  v_d uuid;
  v_x uuid;
  v_y uuid;
  v_x_field uuid;
  v_shared_field uuid;
  v_c_field uuid;
  v_d_field uuid;
  v_product uuid;
  v_pricing jsonb;
  v_split_order uuid;
  v_plain_order uuid;
  v_item uuid;
  v_ids uuid[];
  v_group uuid;
  v_plain_invoice uuid;
  v_key text;
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

  -- Order lines need a positive cost basis, COST_BASIS_REQUIRED, and a product is born
  -- pricing-free, so price a fresh shell through the governed preview/apply path.
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] Split Lineage Product ' || v_suffix, 'GL') RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes(
    'product_page',
    NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00'
    )),
    v_admin,
    'e2e-split-lineage-pricing-preview-' || v_suffix
  );
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed'
     OR (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing->>'change_set_id')::uuid,
    v_pricing->>'request_fingerprint',
    v_admin,
    'e2e-split-lineage-pricing-apply-' || v_suffix
  );
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
  VALUES (v_product, 'Main Warehouse', 100, 0, 'GL');

  INSERT INTO public.customers (farm_name) VALUES ('[E2E] Lineage A ' || v_suffix) RETURNING id INTO v_a;
  INSERT INTO public.customers (farm_name) VALUES ('[E2E] Lineage B ' || v_suffix) RETURNING id INTO v_b;
  INSERT INTO public.customers (farm_name) VALUES ('[E2E] Lineage C ' || v_suffix) RETURNING id INTO v_c;
  INSERT INTO public.customers (farm_name) VALUES ('[E2E] Lineage D ' || v_suffix) RETURNING id INTO v_d;
  -- A shared field owned by A and billed 50/50 to A and B; a field owned by C (no defaults); a
  -- field owned by D that no order line uses.
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_a, '[E2E] Lineage Shared ' || v_suffix, 'corn', 100) RETURNING id INTO v_shared_field;
  INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary)
  VALUES (v_shared_field, v_a, 50, true), (v_shared_field, v_b, 50, false);
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_c, '[E2E] Lineage C Field ' || v_suffix, 'corn', 50) RETURNING id INTO v_c_field;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_d, '[E2E] Lineage D Field ' || v_suffix, 'corn', 10) RETURNING id INTO v_d_field;
  -- A field owned by X but billed wholly to Y (X is not among its billing defaults).
  INSERT INTO public.customers (farm_name) VALUES ('[E2E] Lineage X ' || v_suffix) RETURNING id INTO v_x;
  INSERT INTO public.customers (farm_name) VALUES ('[E2E] Lineage Y ' || v_suffix) RETURNING id INTO v_y;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_x, '[E2E] Lineage X Field ' || v_suffix, 'corn', 10) RETURNING id INTO v_x_field;
  INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary)
  VALUES (v_x_field, v_y, 100, true);

  -- The split order (customer A): line 1 on the shared field, line 2 on C's field.
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-LINEAGE-SPLIT-' || v_suffix, v_a, v_today, 'confirmed', false, NULL)
  RETURNING id INTO v_split_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, sort_order
  ) VALUES (
    v_split_order, v_product, '[E2E] lineage shared line', 10, 5, 2, 20, 10, 50, 0, 2, 1
  ) RETURNING id INTO v_item;
  INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
  VALUES (v_item, v_shared_field, 100);
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, sort_order
  ) VALUES (
    v_split_order, v_product, '[E2E] lineage C line', 10, 5, 2, 20, 10, 50, 0, 2, 2
  ) RETURNING id INTO v_item;
  INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
  VALUES (v_item, v_c_field, 50);
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining, sort_order
  ) VALUES (
    v_split_order, v_product, '[E2E] lineage X field line', 10, 5, 2, 20, 10, 50, 0, 2, 3
  ) RETURNING id INTO v_item;
  INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
  VALUES (v_item, v_x_field, 10);

  -- An unsplit order for A.
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-LINEAGE-PLAIN-' || v_suffix, v_a, v_today, 'confirmed', false, NULL)
  RETURNING id INTO v_plain_order;
  INSERT INTO public.order_items (
    order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin,
    quantity_delivered, quantity_remaining
  ) VALUES (
    v_plain_order, v_product, '[E2E] lineage plain line', 10, 5, 2, 20, 10, 50, 0, 2
  );

  -- 1. The split bills A, B, C and Y. FAIL-FIRST: before 20261021150000 the first draft for a
  --    customer other than A rolls the
  --    whole call back with INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID.
  v_key := 'e2e-split-lineage-split-' || v_suffix;
  BEGIN
    v_ids := public.create_split_invoices_from_order(v_split_order, NULL, 'chemical_sale', v_key);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: a split onto another customer''s field was refused: %', v_err;
  END;
  IF COALESCE(cardinality(v_ids), 0) <> 4
     OR (SELECT array_agg(i.customer_id ORDER BY i.customer_id) FROM public.invoices i WHERE i.id = ANY (v_ids))
          IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[v_a, v_b, v_c, v_y]) AS x)
     OR (SELECT count(DISTINCT i.invoice_group_id) FROM public.invoices i WHERE i.id = ANY (v_ids)) <> 1
     OR (SELECT sum(i.total_amount_cents) FROM public.invoices i WHERE i.id = ANY (v_ids)) IS DISTINCT FROM 6000::numeric
     OR (SELECT i.total_amount_cents FROM public.invoices i WHERE i.id = ANY (v_ids) AND i.customer_id = v_a) IS DISTINCT FROM 1000::bigint
     OR (SELECT i.total_amount_cents FROM public.invoices i WHERE i.id = ANY (v_ids) AND i.customer_id = v_b) IS DISTINCT FROM 1000::bigint
     OR (SELECT i.total_amount_cents FROM public.invoices i WHERE i.id = ANY (v_ids) AND i.customer_id = v_c) IS DISTINCT FROM 2000::bigint
     OR (SELECT i.total_amount_cents FROM public.invoices i WHERE i.id = ANY (v_ids) AND i.customer_id = v_y) IS DISTINCT FROM 2000::bigint
     OR (SELECT count(*) FROM public.split_invoice_provenance p
           JOIN public.invoices i ON i.id = p.invoice_id
          WHERE p.invoice_id = ANY (v_ids) AND p.customer_id = i.customer_id) <> 4 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the split did not bill A 10.00, B 10.00, C 20.00 and Y 20.00 as one governed group';
  END IF;
  IF public.create_split_invoices_from_order(v_split_order, NULL, 'chemical_sale', v_key) IS DISTINCT FROM v_ids THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the cross-customer split did not replay exactly';
  END IF;
  SELECT invoice_group_id INTO v_group FROM public.invoices WHERE id = v_ids[1];

  -- 2. Posting the group updates each draft; the provenance branch admits B's, C's and Y's.
  BEGIN
    SELECT public.post_invoice_group(v_group, v_admin, 'e2e-split-lineage-post-' || v_suffix) INTO v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: posting the cross-customer split group was refused: %', v_err;
  END;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE id = ANY (v_ids) AND status IS DISTINCT FROM 'posted') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the cross-customer split group did not post every invoice';
  END IF;

  -- 3a. A plain invoice for B on A's unsplit order.
  BEGIN
    INSERT INTO public.invoices (order_id, customer_id, invoice_type, status, season, created_by,
      total_amount_cents, invoice_date)
    VALUES (v_plain_order, v_b, 'chemical_sale', 'draft', public.compute_season(v_today), v_admin, 0, v_today);
    RAISE EXCEPTION 'SMOKE_FAIL: a plain invoice billed another customer on an order';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong plain cross-customer refusal: %', v_err;
    END IF;
  END;

  -- 3b. Inside a hand-made claim on the split order, a grouped invoice for D (who owns no field of
  --     the split) is still refused: the customer must be one the split bills.
  INSERT INTO public.split_invoice_creation_claims (transaction_id, order_id, claim_nonce)
  VALUES (pg_current_xact_id(), v_split_order, gen_random_uuid());
  BEGIN
    INSERT INTO public.invoices (order_id, customer_id, invoice_type, status, season, created_by,
      total_amount_cents, invoice_date, invoice_group_id)
    VALUES (v_split_order, v_d, 'chemical_sale', 'draft', public.compute_season(v_today), v_admin, 0, v_today, gen_random_uuid());
    RAISE EXCEPTION 'SMOKE_FAIL: a claimed split invoice billed a customer the split does not bill';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong unresolved-owner refusal: %', v_err;
    END IF;
  END;
  DELETE FROM public.split_invoice_creation_claims WHERE transaction_id = pg_current_xact_id();

  -- 3c. Inside a hand-made claim on A's UNSPLIT order, a grouped invoice for B is refused.
  INSERT INTO public.split_invoice_creation_claims (transaction_id, order_id, claim_nonce)
  VALUES (pg_current_xact_id(), v_plain_order, gen_random_uuid());
  BEGIN
    INSERT INTO public.invoices (order_id, customer_id, invoice_type, status, season, created_by,
      total_amount_cents, invoice_date, invoice_group_id)
    VALUES (v_plain_order, v_b, 'chemical_sale', 'draft', public.compute_season(v_today), v_admin, 0, v_today, gen_random_uuid());
    RAISE EXCEPTION 'SMOKE_FAIL: a claimed grouped invoice billed another customer on an unsplit order';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong unsplit-order claim refusal: %', v_err;
    END IF;
  END;
  DELETE FROM public.split_invoice_creation_claims WHERE transaction_id = pg_current_xact_id();

  -- 3d. A's ordinary invoice cannot be re-pointed to B.
  v_plain_invoice := public.create_invoice_from_order(v_plain_order, NULL, 'chemical_sale', 'e2e-split-lineage-plain-' || v_suffix);
  BEGIN
    UPDATE public.invoices SET customer_id = v_b WHERE id = v_plain_invoice;
    RAISE EXCEPTION 'SMOKE_FAIL: an ordinary order invoice was re-pointed to another customer';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong re-point refusal: %', v_err;
    END IF;
  END;

  -- 3e. A posted split invoice cannot be re-pointed to another customer. The older provenance
  --     identity trigger refuses it first (BEFORE triggers fire in name order); this step keeps
  --     that true now that the lineage guard admits governed split customers.
  BEGIN
    UPDATE public.invoices SET customer_id = v_d WHERE id = ANY (v_ids) AND customer_id = v_b;
    RAISE EXCEPTION 'SMOKE_FAIL: a governed split invoice was re-pointed to another customer';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'SPLIT_INVOICE_PROVENANCE_IMMUTABLE:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong split re-point refusal: %', v_err;
    END IF;
  END;

  -- 3f. Inside a hand-made claim on the split order, an UNGROUPED invoice for B (an owner the split
  --     bills) is refused: only a grouped split invoice may name another customer.
  INSERT INTO public.split_invoice_creation_claims (transaction_id, order_id, claim_nonce)
  VALUES (pg_current_xact_id(), v_split_order, gen_random_uuid());
  BEGIN
    INSERT INTO public.invoices (order_id, customer_id, invoice_type, status, season, created_by,
      total_amount_cents, invoice_date)
    VALUES (v_split_order, v_b, 'chemical_sale', 'draft', public.compute_season(v_today), v_admin, 0, v_today);
    RAISE EXCEPTION 'SMOKE_FAIL: an ungrouped invoice inside a split claim billed another customer';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong ungrouped-in-claim refusal: %', v_err;
    END IF;
  END;

  -- 3g. In the same claim, a grouped invoice for X is refused: X owns a field of the split, but that
  --     field bills only its billing-default customer Y.
  BEGIN
    INSERT INTO public.invoices (order_id, customer_id, invoice_type, status, season, created_by,
      total_amount_cents, invoice_date, invoice_group_id)
    VALUES (v_split_order, v_x, 'chemical_sale', 'draft', public.compute_season(v_today), v_admin, 0, v_today, gen_random_uuid());
    RAISE EXCEPTION 'SMOKE_FAIL: a claimed split invoice billed a field owner its billing defaults exclude';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong excluded-owner refusal: %', v_err;
    END IF;
  END;
  DELETE FROM public.split_invoice_creation_claims WHERE transaction_id = pg_current_xact_id();

  -- 4. Voiding the posted group updates each member again; the provenance branch admits it.
  BEGIN
    PERFORM public.void_invoice_group(v_group, '[E2E] lineage group void', 'e2e-split-lineage-void-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: voiding the cross-customer split group was refused: %', v_err;
  END;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE id = ANY (v_ids) AND status IS DISTINCT FROM 'voided') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the cross-customer split group did not void every invoice';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
