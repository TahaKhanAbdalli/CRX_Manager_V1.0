-- ============================================================================
-- SMOKE TEST (rolled back by design) for 20261021030000_void_order_governed_split_draft_claims.
--
-- CONTAINER ONLY: run through scripts/smoke/prove-void-order-governed-split-drafts-real-schema.mjs,
-- never against the live database. The fixtures complete deliveries on field-allocated orders, which
-- writes each order's automatic governed split draft invoices, whose customer-visible invoice numbers
-- are drawn from a non-transactional sequence that a rollback does not return; the chain also plants
-- [SMOKE] customers, fields, products, inventory, orders and deliveries, which the LIVE-DATA GUARD
-- refuses.
--
-- Rule under test: void_order voids a fulfilled order whose draft invoices are GOVERNED split drafts
-- (made by complete_delivery's automatic split through create_split_invoices_from_order, each with a
-- split_invoice_provenance row). Each governed draft is cancelled with zero money fields, its
-- provenance row is refreshed to the cancelled invoice (total and content claim), and no
-- split_invoice_mutation_claims row is left in the transaction. The exact retry replays the same
-- result and changes nothing. A governed draft that carries recorded money is still refused with
-- ORDER_VOID_DRAFT_HAS_APPLIED_MONEY and nothing changes. After the void, the provenance guard still
-- refuses a direct edit of a governed invoice.
--
-- Fail-first: before the migration step a fails (void_order's draft-cancel UPDATE is refused with
-- SPLIT_INVOICE_PROVENANCE_IMMUTABLE because no same-transaction claim exists).
--
-- HOW TO RUN: as ONE statement inside a transaction that rolls back. It ALWAYS ends with RAISE
-- EXCEPTION 'SMOKE_PASS_ROLLBACK': that exact text = PASS; any other error = FAIL.
--
-- Auth: auth.uid() reads request.jwt.claims, set with set_config(..., true) to a REAL active admin
-- profile found at run time (SMOKE_SETUP if none). Fixture INSERTs run as the table owner; the RPCs
-- under test enforce their own role checks.
-- Precondition: today is not inside a CLOSED accounting period (SMOKE_SETUP otherwise).
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_prefix text;
  v_key text;
  v_customer uuid;
  v_field uuid;
  v_field_b uuid;
  v_product uuid;
  v_pricing jsonb;
  v_order uuid[] := ARRAY[]::uuid[];
  v_oi uuid;
  v_di uuid;
  v_id uuid;
  v_i int;
  v_res jsonb;
  v_res2 jsonb;
  v_n int;
  v_governed int[] := ARRAY[0, 0];
  v_status text;
  v_before text;
  v_after text;
BEGIN
  -- --------------------------------------------------------------------------------------------
  -- 0. Preconditions, one real admin, fixtures.
  -- --------------------------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.accounting_periods
              WHERE status = 'closed' AND CURRENT_DATE BETWEEN period_start AND period_end) THEN
    RAISE EXCEPTION 'SMOKE_SETUP: today falls in a CLOSED accounting period';
  END IF;
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: an active admin profile is required';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_prefix := 'smk-vogs-' || v_suffix || '-';

  -- One farm with two fields; each order's one line is allocated across both fields (split
  -- evidence), so the order is billed through the governed split engine. Both fields belong to the
  -- order's own customer, so every split invoice does too (a split onto another customer's field
  -- needs 20261021150000; smoke-split-invoice-cross-customer-lineage.sql covers that).
  INSERT INTO public.customers (farm_name, account_number)
  VALUES ('[SMOKE] Split Void Farm ' || v_suffix, '[SMOKE]-VOGS-' || v_suffix)
  RETURNING id INTO v_customer;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[SMOKE] Split Void Field A ' || v_suffix, 'corn', 100)
  RETURNING id INTO v_field;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[SMOKE] Split Void Field B ' || v_suffix, 'corn', 100)
  RETURNING id INTO v_field_b;

  -- A product is born pricing-free, so price it through the governed preview/apply path.
  INSERT INTO public.products (product_name, unit_size, epa_registration, product_form)
  VALUES ('[SMOKE] Split Void Product ' || v_suffix, 'GL', '[SMOKE]-EPA-VOGS-' || v_suffix, 'liquid')
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
  VALUES (v_product, 'Main Warehouse', 100, 8, 'GL');

  -- Orders 1 and 2: one 4-unit line each, allocated across both fields, delivered in full, so each
  -- is fulfilled and its completion writes governed split drafts.
  FOR v_i IN 1..2 LOOP
    INSERT INTO public.orders (order_number, customer_id, status, booking_draw)
    VALUES ('[SMOKE] VOGS-' || v_i || '-' || v_suffix, v_customer, 'confirmed', false)
    RETURNING id INTO v_id;
    v_order := v_order || v_id;
    INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
                                    total_units_needed, total_price, profit, net_margin,
                                    quantity_delivered, quantity_remaining)
    VALUES (v_id, v_product, '[SMOKE] split void line ' || v_i, 10, 6, 4, 40, 16, 40, 0, 4)
    RETURNING id INTO v_oi;
    INSERT INTO public.order_item_field_allocations (order_item_id, field_id, acres)
    VALUES (v_oi, v_field, 50), (v_oi, v_field_b, 50);
    INSERT INTO public.deliveries (delivery_number, order_id, customer_id, assigned_driver,
                                   scheduled_date, status, created_by)
    VALUES ('[SMOKE] VOGS-DEL-' || v_i || '-' || v_suffix, v_id, v_customer, NULL, CURRENT_DATE, 'scheduled', v_admin)
    RETURNING id INTO v_id;
    INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
    VALUES (v_id, v_oi, v_product, 4, 0, 'GL')
    RETURNING id INTO v_di;
    UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_id;
    v_res := public.complete_delivery(v_id, '[SMOKE] Receiver', v_admin, jsonb_build_object(v_di::text, 4),
                                      NULL, NULL, v_prefix || 'complete-' || v_i, NULL);
    IF v_res->>'status' IS DISTINCT FROM 'completed' THEN
      RAISE EXCEPTION 'SMOKE_SETUP: complete_delivery fixture failed for order %: %', v_i, v_res;
    END IF;
    -- complete_delivery's automatic split runs only for a same-day (Chicago) completion and swallows
    -- its own errors (the order is then flagged for a manual split). When it made no invoice, make
    -- the governed split drafts the manual way, so any error surfaces here.
    IF NOT EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_order[v_i] AND deleted_at IS NULL) THEN
      BEGIN
        PERFORM public.create_split_invoices_from_order(v_order[v_i], NULL, 'chemical_sale', v_prefix || 'split-' || v_i);
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'SMOKE_SETUP: create_split_invoices_from_order failed for order %: %', v_i, SQLERRM;
      END;
    END IF;
  END LOOP;
  SELECT string_agg(status, ',' ORDER BY ord) INTO v_status
    FROM unnest(v_order) WITH ORDINALITY AS u(oid, ord) JOIN public.orders o ON o.id = u.oid;
  IF v_status IS DISTINCT FROM 'fulfilled,fulfilled' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: orders 1 and 2 are not fulfilled after full delivery: %', v_status;
  END IF;
  -- Every draft on both orders is a governed split draft with a nonzero total and a provenance row
  -- that matches it exactly.
  FOR v_i IN 1..2 LOOP
    SELECT count(*) INTO v_n FROM public.invoices i
      JOIN public.split_invoice_provenance p ON p.invoice_id = i.id
     WHERE i.order_id = v_order[v_i] AND i.deleted_at IS NULL AND i.status = 'draft'
       AND i.invoice_group_id IS NOT NULL AND i.total_amount_cents > 0
       AND p.total_amount_cents = i.total_amount_cents
       AND p.content_claim = public._split_invoice_content_claim(i.id);
    IF v_n = 0 OR v_n <> (SELECT count(*) FROM public.invoices WHERE order_id = v_order[v_i] AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'SMOKE_SETUP: order % has % governed split drafts and % invoices; expected every invoice to be a governed nonzero draft',
        v_i, v_n, (SELECT count(*) FROM public.invoices WHERE order_id = v_order[v_i] AND deleted_at IS NULL);
    END IF;
    v_governed[v_i] := v_n;
  END LOOP;
  RAISE NOTICE 'SMOKE_INFO: governed split drafts per order: %', v_governed;

  -- --------------------------------------------------------------------------------------------
  -- a. void_order voids order 1 and cancels every governed split draft with zero money fields.
  --    FAIL-FIRST: before the migration the draft-cancel UPDATE is refused by the provenance guard.
  -- --------------------------------------------------------------------------------------------
  v_key := v_prefix || 'void-order-1';
  BEGIN
    v_res := public.void_order(v_order[1], v_admin, '[SMOKE] split order billed elsewhere', v_key);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void_order could not void a fulfilled order with governed split drafts: %', SQLERRM;
  END;
  SELECT status INTO v_status FROM public.orders WHERE id = v_order[1];
  IF v_status IS DISTINCT FROM 'voided'
     OR v_res->>'status' IS DISTINCT FROM 'voided'
     OR (v_res->>'draft_invoices_voided')::int IS DISTINCT FROM v_governed[1] THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void_order on order 1 did not void it and its % governed drafts (%): %', v_governed[1], v_status, v_res;
  END IF;
  SELECT count(*) INTO v_n FROM public.invoices
   WHERE order_id = v_order[1] AND deleted_at IS NULL AND status = 'cancelled'
     AND total_amount_cents = 0 AND paid_amount_cents = 0 AND prepay_applied_cents = 0 AND write_off_cents = 0;
  IF v_n <> v_governed[1] OR EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_order[1] AND status = 'draft') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: order 1''s governed drafts are not all cancelled with zero money fields (% of %)', v_n, v_governed[1];
  END IF;

  -- b. Each provenance row now matches its cancelled invoice exactly (total and content claim).
  SELECT count(*) INTO v_n FROM public.invoices i
    JOIN public.split_invoice_provenance p ON p.invoice_id = i.id
   WHERE i.order_id = v_order[1]
     AND p.total_amount_cents = 0 AND p.total_amount_cents = i.total_amount_cents
     AND p.content_claim = public._split_invoice_content_claim(i.id);
  IF v_n <> v_governed[1] THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the provenance of order 1''s cancelled drafts was not refreshed (% of % match)', v_n, v_governed[1];
  END IF;

  -- c. No mutation claim is left behind in this transaction.
  SELECT count(*) INTO v_n FROM public.split_invoice_mutation_claims WHERE transaction_id = pg_current_xact_id();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: void_order left % split_invoice_mutation_claims rows in the transaction', v_n;
  END IF;

  -- d. The exact retry replays the same result and changes nothing (no second audit row, the same
  --    provenance).
  SELECT string_agg(p.invoice_id || ':' || p.total_amount_cents || ':' || md5(p.content_claim::text), ',' ORDER BY p.invoice_id)
    INTO v_before FROM public.split_invoice_provenance p WHERE p.order_id = v_order[1];
  v_res2 := public.void_order(v_order[1], v_admin, '[SMOKE] split order billed elsewhere', v_key);
  SELECT string_agg(p.invoice_id || ':' || p.total_amount_cents || ':' || md5(p.content_claim::text), ',' ORDER BY p.invoice_id)
    INTO v_after FROM public.split_invoice_provenance p WHERE p.order_id = v_order[1];
  SELECT count(*) INTO v_n FROM public.financial_audit_log
   WHERE operation_type = 'order_voided' AND entity_id = v_order[1];
  IF v_res2 IS DISTINCT FROM v_res OR v_n <> 1 OR v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the exact void_order retry did not replay once unchanged (% audit rows): % vs %', v_n, v_res2, v_res;
  END IF;
  SELECT count(*) INTO v_n FROM public.split_invoice_mutation_claims WHERE transaction_id = pg_current_xact_id();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the void_order retry left % split_invoice_mutation_claims rows', v_n;
  END IF;

  -- e. The provenance guard still holds after the void: a direct edit of a cancelled governed
  --    invoice is refused.
  BEGIN
    UPDATE public.invoices SET header_notes = '[SMOKE] direct edit'
     WHERE id = (SELECT id FROM public.invoices WHERE order_id = v_order[1] ORDER BY id LIMIT 1);
    RAISE EXCEPTION 'SMOKE_FAIL: a governed split invoice was edited directly after the void';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'SPLIT_INVOICE_PROVENANCE_IMMUTABLE%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong refusal of a direct governed-invoice edit: %', SQLERRM;
    END IF;
  END;

  -- f. A governed draft that carries recorded money is refused, never zeroed: order 2's first draft
  --    gets a 100-cent payment (a direct fixture write; paid cents are not provenance content), and
  --    void_order must refuse with ORDER_VOID_DRAFT_HAS_APPLIED_MONEY and change nothing.
  UPDATE public.invoices SET paid_amount_cents = 100
   WHERE id = (SELECT id FROM public.invoices WHERE order_id = v_order[2] AND status = 'draft' ORDER BY id LIMIT 1);
  SELECT string_agg(i.id || ':' || i.status || ':' || i.total_amount_cents || ':' || p.total_amount_cents || ':' || md5(p.content_claim::text), ',' ORDER BY i.id)
    INTO v_before FROM public.invoices i JOIN public.split_invoice_provenance p ON p.invoice_id = i.id
   WHERE i.order_id = v_order[2];
  BEGIN
    v_res2 := public.void_order(v_order[2], v_admin, '[SMOKE] split order billed elsewhere', v_prefix || 'void-order-2-paid');
    RAISE EXCEPTION 'SMOKE_FAIL: void_order voided an order whose governed draft carries a recorded payment: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF SQLERRM NOT LIKE 'ORDER_VOID_DRAFT_HAS_APPLIED_MONEY%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong void_order refusal for a paid governed draft: %', SQLERRM;
    END IF;
  END;
  SELECT string_agg(i.id || ':' || i.status || ':' || i.total_amount_cents || ':' || p.total_amount_cents || ':' || md5(p.content_claim::text), ',' ORDER BY i.id)
    INTO v_after FROM public.invoices i JOIN public.split_invoice_provenance p ON p.invoice_id = i.id
   WHERE i.order_id = v_order[2];
  IF (SELECT status FROM public.orders WHERE id = v_order[2]) IS DISTINCT FROM 'fulfilled'
     OR v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused void_order changed order 2 or its governed drafts';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
