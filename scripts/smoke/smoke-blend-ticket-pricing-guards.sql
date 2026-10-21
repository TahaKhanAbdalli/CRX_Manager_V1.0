-- ============================================================================
-- CONTAINER ONLY smoke chain for 20261020210000_blend_ticket_pricing_guards.
-- Run through scripts/smoke/prove-blend-ticket-pricing-guards-real-schema.mjs, never against the
-- live database: it creates orders and invoices, which draw customer-visible order and invoice
-- numbers from sequences that a rollback does not return.
--
-- Rules under test (Goal 3 "Pricing", Mason 2026-10-15):
--   * an order made from a blend ticket never prices a product at $0 because a tier price is
--     missing: the tier-1 price is used, and a product with no price at all is refused;
--   * a blend-ticket invoice never bills a product at $0 because it has no price;
--   * when the job's quote lists the same product more than once at different prices, the blend
--     invoice stops and lists the choices; staff pick one, and it bills as the quoted price;
--   * the same product twice at the same price is not ambiguous;
--   * a product the quote lists at $0 bills at $0 (Mason, 2026-10-20) only with an admin's written
--     below-cost reason, asked before any invoice row, and each such line is recorded in
--     below_cost_approvals; a sales rep is refused without seeing the cost.
--
-- Runs as the table owner with request.jwt.claims set to an admin (and a sales rep for the
-- own-name step), so every function sees the auth.uid() it sees on live. Every refused step must
-- leave nothing behind. Terminal SMOKE_PASS_ROLLBACK.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_other_rep uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_p_full uuid;
  v_p_t1only uuid;
  v_p_none uuid;
  v_pricing jsonb;
  v_customer uuid;
  v_field uuid;
  v_quote uuid;
  v_section uuid;
  v_job uuid;
  v_qi_700 uuid;
  v_qi_750 uuid;
  v_qi_t1_a uuid;
  v_qi_t1_b uuid;
  v_t uuid; v_t1 uuid; v_t2 uuid; v_t3 uuid; v_t4 uuid; v_t5 uuid; v_t6 uuid; v_t7 uuid; v_t8 uuid; v_t9 uuid;
  v_section_b uuid;
  v_job2 uuid;
  v_job3 uuid;
  v_job4 uuid;
  v_section_c uuid;
  v_qi_b_t1_0 uuid;
  v_qi_b_t1_600 uuid;
  v_line_t9_full uuid;
  v_line_t9_t1 uuid;
  v_invoice uuid;
  v_old_quote uuid;
  v_section_d uuid;
  v_qi_d uuid;
  v_job5 uuid;
  v_t10 uuid;
  v_line_t10 uuid;
  v_other_customer uuid;
  v_other_quote uuid;
  v_other_section uuid;
  v_qi_other uuid;
  v_line_full uuid;
  v_line_other uuid;
  v_line_t7 uuid;
  v_line_t8 uuid;
  v_json json;
  v_res jsonb;
  v_res2 jsonb;
  v_detail jsonb;
  v_err text;
  v_err_detail text;
  v_count int;
  v_cents bigint;
  v_numeric numeric;
  v_text text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_rep FROM public.profiles
   WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_other_rep FROM public.profiles
   WHERE role = 'sales_rep' AND is_active = true AND id IS DISTINCT FROM v_rep
   ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL OR v_other_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: an active admin and two active sales reps are required';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- Three products: fully priced, tier-1 only, and never priced (products are born pricing-free;
  -- the two priced ones go through the governed preview/apply path).
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] BTP Full ' || v_suffix, 'GL') RETURNING id INTO v_p_full;
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] BTP Tier1Only ' || v_suffix, 'GL') RETURNING id INTO v_p_t1only;
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] BTP Unpriced ' || v_suffix, 'GL') RETURNING id INTO v_p_none;
  v_pricing := public.preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(
      jsonb_build_object('product_id', v_p_full, 'row_version', 1, 'pricing_mode', 'price_driven',
        'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '9.00', 'tier3_price', '8.00'),
      jsonb_build_object('product_id', v_p_t1only, 'row_version', 1, 'pricing_mode', 'price_driven',
        'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '9.00', 'tier3_price', '8.00')),
    v_admin, 'e2e-btp-pricing-preview-' || v_suffix);
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed'
     OR (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint', v_admin,
    'e2e-btp-pricing-apply-' || v_suffix);
  -- The governed path always writes all three tiers, but live still holds legacy products with a
  -- tier left blank (4 with no tier 2 on 2026-10-20). Recreate one: as the table owner, with the
  -- pricing guards off for this one statement (container only; the transaction rolls back). Before
  -- this change the order body priced it at $0 for a tier-2 customer, which the below-cost line
  -- guard then refused (BELOW_COST_CONTEXT_REQUIRED, every order line needs a cost), so the order
  -- could not be made at all and staff saw a below-cost error instead of the tier-1 price.
  EXECUTE 'ALTER TABLE public.products DISABLE TRIGGER USER';
  UPDATE public.products SET tier2_price = NULL, tier3_price = NULL WHERE id = v_p_t1only;
  EXECUTE 'ALTER TABLE public.products ENABLE TRIGGER USER';
  IF (SELECT tier1_price FROM public.products WHERE id = v_p_t1only) IS DISTINCT FROM 10.00
     OR (SELECT tier2_price FROM public.products WHERE id = v_p_t1only) IS NOT NULL
     OR (SELECT tier1_price FROM public.products WHERE id = v_p_none) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the tier-1-only or unpriced fixture product has unexpected prices';
  END IF;

  -- A tier-2 customer and one 10-acre field.
  INSERT INTO public.customers (farm_name, assigned_tier)
  VALUES ('[E2E] BTP Farm ' || v_suffix, 2) RETURNING id INTO v_customer;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[E2E] BTP Field ' || v_suffix, 'corn', 10) RETURNING id INTO v_field;

  -- The job's quote: the full product twice at different prices, the tier-1-only product twice at
  -- the same price.
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, is_planned)
  VALUES ('[E2E] BTP-Q-' || v_suffix, v_customer, v_admin, 'sent', true) RETURNING id INTO v_quote;
  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, '[E2E] BTP Section', 0) RETURNING id INTO v_section;
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section, v_p_full, 0, 7.00, 20, 10, 2, 'gal/acre') RETURNING id INTO v_qi_700;
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section, v_p_full, 1, 7.50, 20, 10, 2, 'gal/acre') RETURNING id INTO v_qi_750;
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section, v_p_t1only, 2, 6.00, 20, 10, 2, 'gal/acre') RETURNING id INTO v_qi_t1_a;
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section, v_p_t1only, 3, 6.00, 20, 10, 2, 'gal/acre') RETURNING id INTO v_qi_t1_b;
  INSERT INTO public.jobs (job_number, customer_id, job_date, status, quote_id, quote_section_id, total_acres)
  VALUES ('E2E-BTP-J-' || v_suffix, v_customer, v_today, 'scheduled', v_quote, v_section, 10) RETURNING id INTO v_job;

  -- A second section of the same quote listing the full product only at $0, and the tier-1-only
  -- product at $0 and at 6.00. A $0 quote line bills $0 (Mason, 2026-10-20) behind the below-cost
  -- admin approval. On live a new $0 quote line needs that approval when the quote is saved
  -- (save_quote); this recreates the rows directly as the table owner with the quote_items
  -- triggers off for this one statement (container only; rolled back).
  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, '[E2E] BTP Section B', 1) RETURNING id INTO v_section_b;
  EXECUTE 'ALTER TABLE public.quote_items DISABLE TRIGGER USER';
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section_b, v_p_full, 0, 0, 20, 10, 2, 'gal/acre');
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section_b, v_p_t1only, 1, 0, 20, 10, 2, 'gal/acre') RETURNING id INTO v_qi_b_t1_0;
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section_b, v_p_t1only, 2, 6.00, 20, 10, 2, 'gal/acre') RETURNING id INTO v_qi_b_t1_600;
  EXECUTE 'ALTER TABLE public.quote_items ENABLE TRIGGER USER';
  INSERT INTO public.jobs (job_number, customer_id, job_date, status, quote_id, quote_section_id, total_acres)
  VALUES ('E2E-BTP-J3-' || v_suffix, v_customer, v_today, 'scheduled', v_quote, v_section_b, 10) RETURNING id INTO v_job3;
  -- A third section that does not list the full product at all.
  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, '[E2E] BTP Section C', 2) RETURNING id INTO v_section_c;
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section_c, v_p_t1only, 0, 6.00, 20, 10, 2, 'gal/acre');
  INSERT INTO public.jobs (job_number, customer_id, job_date, status, quote_id, quote_section_id, total_acres)
  VALUES ('E2E-BTP-J4-' || v_suffix, v_customer, v_today, 'scheduled', v_quote, v_section_c, 10) RETURNING id INTO v_job4;

  -- Another customer's quote, whose section a job of this customer has been pointed at.
  INSERT INTO public.customers (farm_name, assigned_tier)
  VALUES ('[E2E] BTP Other Farm ' || v_suffix, 1) RETURNING id INTO v_other_customer;
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, is_planned)
  VALUES ('[E2E] BTP-Q2-' || v_suffix, v_other_customer, v_admin, 'sent', true) RETURNING id INTO v_other_quote;
  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_other_quote, '[E2E] BTP Other Section', 0) RETURNING id INTO v_other_section;
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_other_quote, v_other_section, v_p_full, 0, 6.50, 20, 10, 2, 'gal/acre') RETURNING id INTO v_qi_other;
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_other_quote, v_other_section, v_p_full, 1, 6.75, 20, 10, 2, 'gal/acre');
  INSERT INTO public.jobs (job_number, customer_id, job_date, status, quote_id, quote_section_id, total_acres)
  VALUES ('E2E-BTP-J2-' || v_suffix, v_customer, v_today, 'scheduled', v_other_quote, v_other_section, 10) RETURNING id INTO v_job2;

  -- Nine approved, unbilled tickets (T5, T6 and T8 on the job; T6 names another rep; T7 on the
  -- job pointed at another customer's quote; T9 on the job whose quote prices are unusable).
  FOR v_count IN 1..9 LOOP
    INSERT INTO public.blend_tickets (
      ticket_number, uploaded_by, customer_id, salesman_id, status, review_status,
      payment_status, order_link_status, season, total_acres, source, job_id
    ) VALUES (
      '[E2E]-BTP-' || v_count || '-' || v_suffix, v_admin, v_customer,
      CASE WHEN v_count = 6 THEN v_other_rep END,
      'completed', 'approved', 'unbilled', 'unlinked', public.current_season(), 10, 'manual',
      CASE WHEN v_count IN (5, 6, 8) THEN v_job WHEN v_count = 7 THEN v_job2 WHEN v_count = 9 THEN v_job3 END
    ) RETURNING id INTO v_t;
    INSERT INTO public.blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres)
    VALUES (v_t, v_field, v_customer, 10);
    CASE v_count
      WHEN 1 THEN v_t1 := v_t;
      WHEN 2 THEN v_t2 := v_t;
      WHEN 3 THEN v_t3 := v_t;
      WHEN 4 THEN v_t4 := v_t;
      WHEN 5 THEN v_t5 := v_t;
      WHEN 6 THEN v_t6 := v_t;
      WHEN 7 THEN v_t7 := v_t;
      WHEN 8 THEN v_t8 := v_t;
      ELSE v_t9 := v_t;
    END CASE;
  END LOOP;
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
  VALUES (v_t1, v_p_t1only, '[E2E] BTP t1 line', 20, 'GL', 2, 'gal/ac', 1),
         (v_t2, v_p_full, '[E2E] BTP t2 full', 20, 'GL', 2, 'gal/ac', 1),
         (v_t2, v_p_none, '[E2E] BTP t2 unpriced', 20, 'GL', 2, 'gal/ac', 2),
         (v_t3, v_p_t1only, '[E2E] BTP t3 line', 20, 'GL', 2, 'gal/ac', 1),
         (v_t4, v_p_none, '[E2E] BTP t4 unpriced', 20, 'GL', 2, 'gal/ac', 1),
         (v_t5, v_p_t1only, '[E2E] BTP t5 same-price', 20, 'GL', 2, 'gal/ac', 2);
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
  VALUES (v_t5, v_p_full, '[E2E] BTP t5 two-price', 20, 'GL', 2, 'gal/ac', 1) RETURNING id INTO v_line_full;
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
  VALUES (v_t6, v_p_full, '[E2E] BTP t6 other rep', 20, 'GL', 2, 'gal/ac', 1) RETURNING id INTO v_line_other;
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
  VALUES (v_t7, v_p_full, '[E2E] BTP t7 other quote', 20, 'GL', 2, 'gal/ac', 1) RETURNING id INTO v_line_t7;
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
  VALUES (v_t8, v_p_full, '[E2E] BTP t8 stale pick', 20, 'GL', 2, 'gal/ac', 1) RETURNING id INTO v_line_t8;
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
  VALUES (v_t9, v_p_full, '[E2E] BTP t9 zero quote', 20, 'GL', 2, 'gal/ac', 1) RETURNING id INTO v_line_t9_full;
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
  VALUES (v_t9, v_p_t1only, '[E2E] BTP t9 zero or six', 20, 'GL', 2, 'gal/ac', 2) RETURNING id INTO v_line_t9_t1;

  -- 1. Order: a tier-2 customer, a product with no tier-2 price -> priced at tier 1, never $0.
  BEGIN
    v_json := public.create_order_from_blend_ticket(v_t1, 'E2E-BTP-1-' || v_suffix, v_today, NULL, v_admin, 'e2e-btp-order-1-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: the tier-1 fallback order was refused: %', v_err;
  END;
  IF (v_json::jsonb->>'success')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the tier-1 fallback order was not created: %', v_json;
  END IF;
  SELECT oi.price_per_unit, o.total_price INTO v_numeric, v_cents
    FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
   WHERE o.id = (v_json::jsonb->>'order_id')::uuid;
  IF v_numeric IS DISTINCT FROM 10.00 OR v_cents IS DISTINCT FROM 200 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an order line was priced at % (order total %) when the tier-2 price was missing; expected the 10.00 tier-1 price', v_numeric, v_cents;
  END IF;

  -- 2. Order: a product with no price at all -> refused, naming it; nothing written.
  BEGIN
    v_json := public.create_order_from_blend_ticket(v_t2, 'E2E-BTP-2-' || v_suffix, v_today, NULL, v_admin, 'e2e-btp-order-2-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: an order was made from a blend ticket with an unpriced product: %', v_json;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_PRICE_MISSING:%' || '[E2E] BTP Unpriced ' || v_suffix || '%'
       OR v_err LIKE '%[E2E] BTP Full %' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong unpriced-order refusal: %', v_err;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.orders WHERE order_number = 'E2E-BTP-2-' || v_suffix)
     OR (SELECT order_link_status FROM public.blend_tickets WHERE id = v_t2) IS DISTINCT FROM 'unlinked' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused order left an order behind or linked the ticket';
  END IF;

  -- 3. Invoice: a tier-2 customer, no tier-2 price -> billed at the tier-1 price.
  v_res := public.create_invoice_from_blend_ticket(v_t3, v_admin, 'e2e-btp-invoice-3-' || v_suffix);
  SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_text
    FROM public.invoice_items ii
   WHERE ii.invoice_id = (v_res->'invoice_ids'->>0)::uuid AND ii.product_id = v_p_t1only;
  IF v_cents IS DISTINCT FROM 1000 OR v_text IS DISTINCT FROM 'tier' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the tier-1 fallback invoice line billed % (%), expected 1000 cents (tier)', v_cents, v_text;
  END IF;

  -- 4. Invoice: a product with no price at all -> refused, naming it; nothing written.
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t4, v_admin, 'e2e-btp-invoice-4-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a blend-ticket invoice billed an unpriced product: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_PRICE_MISSING:%' || '[E2E] BTP Unpriced ' || v_suffix || '%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong unpriced-invoice refusal: %', v_err;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE blend_ticket_id = v_t4)
     OR (SELECT payment_status FROM public.blend_tickets WHERE id = v_t4) IS DISTINCT FROM 'unbilled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused unpriced invoice left an invoice behind or billed the ticket';
  END IF;

  -- 5. Invoice: the quote lists the product twice at different prices -> stops with the choices.
  --    The same product twice at the same price is not listed.
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t5, v_admin, 'e2e-btp-invoice-5-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a blend-ticket invoice picked one of two quoted prices without asking: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_err_detail = PG_EXCEPTION_DETAIL;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_QUOTE_PRICE_CHOICE_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong duplicate-quote-line refusal: %', v_err;
    END IF;
  END;
  v_detail := v_err_detail::jsonb;
  IF jsonb_array_length(v_detail->'products') <> 1
     OR (v_detail->'products'->0->>'blend_ticket_product_id')::uuid IS DISTINCT FROM v_line_full
     OR (v_detail->'products'->0->>'product_id')::uuid IS DISTINCT FROM v_p_full
     OR (v_detail->'products'->0->'options') IS DISTINCT FROM jsonb_build_array(
          jsonb_build_object('quote_item_id', v_qi_700, 'price_cents', 700),
          jsonb_build_object('quote_item_id', v_qi_750, 'price_cents', 750)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the choices handed to the screen are wrong: %', v_err_detail;
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE blend_ticket_id = v_t5) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a stopped duplicate-quote-line invoice left an invoice behind';
  END IF;

  -- 6. The pick refuses: no key, a forged actor, and a quote line for another product.
  BEGIN
    v_res := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_750, v_admin, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: a price was picked with no idempotency key';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong no-key refusal: %', v_err; END IF;
  END;
  BEGIN
    v_res := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_750, v_rep, 'e2e-btp-pick-forged-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a price was picked under a forged actor';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'ACTOR_MISMATCH' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong forged-actor refusal: %', v_err; END IF;
  END;
  BEGIN
    v_res := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_t1_a, v_admin, 'e2e-btp-pick-wrong-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a quote line for another product was accepted as the pick: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_QUOTE_PRICE_INVALID_CHOICE:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong invalid-choice refusal: %', v_err; END IF;
  END;
  IF (SELECT unit_price_cents FROM public.blend_ticket_products WHERE id = v_line_full) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused pick stored a price';
  END IF;

  -- 7. Staff pick the 7.50 line; the same key replays the same answer and refuses another pick.
  v_res := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_750, v_admin, 'e2e-btp-pick-' || v_suffix);
  IF (v_res->>'unit_price_cents')::bigint IS DISTINCT FROM 750
     OR (SELECT unit_price_cents FROM public.blend_ticket_products WHERE id = v_line_full) IS DISTINCT FROM 750 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the picked price was not stored: %', v_res;
  END IF;
  v_res2 := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_750, v_admin, 'e2e-btp-pick-' || v_suffix);
  IF v_res2 IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the pick replay returned % instead of %', v_res2, v_res;
  END IF;
  BEGIN
    v_res2 := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_700, v_admin, 'e2e-btp-pick-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a reused pick key stored a different price: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'IDEMPOTENCY_INTENT_MISMATCH' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong reused-key refusal: %', v_err; END IF;
  END;

  -- 8. The invoice now bills the picked price as quoted, and the same-price line at its quote.
  v_res := public.create_invoice_from_blend_ticket(v_t5, v_admin, 'e2e-btp-invoice-5b-' || v_suffix);
  SELECT ii.unit_price_cents, ii.price_source, ii.quoted_price_cents INTO v_cents, v_text, v_numeric
    FROM public.invoice_items ii
   WHERE ii.invoice_id = (v_res->'invoice_ids'->>0)::uuid AND ii.product_id = v_p_full;
  IF v_cents IS DISTINCT FROM 750 OR v_text IS DISTINCT FROM 'quoted' OR v_numeric IS DISTINCT FROM 750 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the picked price billed % (%, quoted %), expected 750 cents as quoted', v_cents, v_text, v_numeric;
  END IF;
  SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_text
    FROM public.invoice_items ii
   WHERE ii.invoice_id = (v_res->'invoice_ids'->>0)::uuid AND ii.product_id = v_p_t1only;
  IF v_cents IS DISTINCT FROM 600 OR v_text IS DISTINCT FROM 'quoted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the same-price quote line billed % (%), expected 600 cents as quoted', v_cents, v_text;
  END IF;

  -- 9. Once billed, the pick is locked.
  BEGIN
    v_res := public.set_blend_ticket_product_quote_price(v_line_full, v_qi_700, v_admin, 'e2e-btp-pick-late-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a price was picked on a billed ticket: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_QUOTE_PRICE_LOCKED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong billed-ticket refusal: %', v_err; END IF;
  END;

  -- 11. A ticket line's price cannot be written directly (as the table owner, the path every
  --     definer function takes, and as the authenticated role through the office policy); only
  --     the setter writes it. Clearing to NULL stays allowed.
  BEGIN
    UPDATE public.blend_ticket_products SET unit_price_cents = 1 WHERE id = v_line_t8;
    RAISE EXCEPTION 'SMOKE_FAIL: a ticket line price was written directly, skipping the pick checks';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_PRICE_PICK_REQUIRED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong direct-write refusal: %', v_err; END IF;
  END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    -- Even with the setter's flag forged in this session, a write as the authenticated role is refused.
    PERFORM set_config('app.crx_blend_quote_price_pick', '1', true);
    UPDATE public.blend_ticket_products SET unit_price_cents = 1 WHERE id = v_line_t8;
    RAISE EXCEPTION 'SMOKE_FAIL: a ticket line price was written directly through the Data API';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_PRICE_PICK_REQUIRED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong Data API direct-write refusal: %', v_err; END IF;
  END;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: SET LOCAL ROLE did not end with its sub-block (current_user %)', current_user;
  END IF;
  UPDATE public.blend_ticket_products SET unit_price_cents = NULL WHERE id = v_line_t8;

  -- 12. A pick must come from a quote of the ticket's own customer, even when the ticket's job
  --     points at another customer's quote section.
  BEGIN
    v_res := public.set_blend_ticket_product_quote_price(v_line_t7, v_qi_other, v_admin, 'e2e-btp-pick-other-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a price from another customer''s quote was accepted as the pick: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_QUOTE_PRICE_INVALID_CHOICE:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong other-customer refusal: %', v_err; END IF;
  END;
  --     Nor does the automatic lookup bill another customer's quoted price (or ask to pick one):
  --     the line bills its own tier price.
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t7, v_admin, 'e2e-btp-invoice-7-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: a ticket whose job names another customer''s quote was refused: %', v_err;
  END;
  SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_text
    FROM public.invoice_items ii
   WHERE ii.invoice_id = (v_res->'invoice_ids'->>0)::uuid AND ii.product_id = v_p_full;
  IF v_cents IS DISTINCT FROM 900 OR v_text IS DISTINCT FROM 'tier' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: another customer''s quote priced this customer''s invoice line at % (%), expected the 900-cent tier-2 price', v_cents, v_text;
  END IF;

  -- 13. Changing a line's product drops its pick, so the old price can never carry over.
  v_res := public.set_blend_ticket_product_quote_price(v_line_t8, v_qi_700, v_admin, 'e2e-btp-pick-t8-' || v_suffix);
  IF (v_res->>'unit_price_cents')::bigint IS DISTINCT FROM 700 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the T8 pick was not stored: %', v_res;
  END IF;
  UPDATE public.blend_ticket_products SET product_id = v_p_t1only WHERE id = v_line_t8;
  IF (SELECT unit_price_cents FROM public.blend_ticket_products WHERE id = v_line_t8) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: changing a line''s product kept its old pick';
  END IF;
  --     A pick also goes stale when the ticket's job changes; billing itself refuses to honour it.
  --     Put the product back, pick again, then move the ticket to a job whose quote does not list
  --     the product: the line must bill its tier price, never the old pick.
  UPDATE public.blend_ticket_products SET product_id = v_p_full WHERE id = v_line_t8;
  v_res := public.set_blend_ticket_product_quote_price(v_line_t8, v_qi_700, v_admin, 'e2e-btp-pick-t8b-' || v_suffix);
  IF (SELECT unit_price_cents FROM public.blend_ticket_products WHERE id = v_line_t8) IS DISTINCT FROM 700 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the second T8 pick was not stored: %', v_res;
  END IF;
  UPDATE public.blend_tickets SET job_id = v_job4 WHERE id = v_t8;
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t8, v_admin, 'e2e-btp-invoice-8-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: the ticket moved to a job whose quote does not list the product was refused: %', v_err;
  END;
  SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_text
    FROM public.invoice_items ii
   WHERE ii.invoice_id = (v_res->'invoice_ids'->>0)::uuid AND ii.product_id = v_p_full;
  IF v_cents IS DISTINCT FROM 900 OR v_text IS DISTINCT FROM 'tier' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a stale pick billed % (%) after the job changed, expected the 900-cent tier-2 price', v_cents, v_text;
  END IF;

  -- 14. A product the quote lists at $0 bills at $0 (Mason, 2026-10-20: "$0 of $0 but flag it in
  --     system and alert before save"), only with an admin's written below-cost reason, and each
  --     $0 line is recorded in below_cost_approvals. (Before this change the $0 line was refused
  --     by the below-cost line guard, BELOW_COST_CONTEXT_REQUIRED, so no invoice could be made.)
  --  a. $0 is a real quoted price: the quote listing the tier-1-only product at $0 and 6.00 asks.
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t9, v_admin, 'e2e-btp-invoice-9a-' || v_suffix, 'free sample');
    RAISE EXCEPTION 'SMOKE_FAIL: a quote listing a product at $0 and 6.00 billed without asking: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT, v_err_detail = PG_EXCEPTION_DETAIL;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_QUOTE_PRICE_CHOICE_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong $0-or-6.00 refusal: %', v_err;
    END IF;
  END;
  v_detail := v_err_detail::jsonb;
  IF jsonb_array_length(v_detail->'products') <> 1
     OR (v_detail->'products'->0->>'blend_ticket_product_id')::uuid IS DISTINCT FROM v_line_t9_t1
     OR (v_detail->'products'->0->'options') IS DISTINCT FROM jsonb_build_array(
          jsonb_build_object('quote_item_id', v_qi_b_t1_0, 'price_cents', 0),
          jsonb_build_object('quote_item_id', v_qi_b_t1_600, 'price_cents', 600)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the $0 choice handed to the screen is wrong: %', v_err_detail;
  END IF;
  v_res := public.set_blend_ticket_product_quote_price(v_line_t9_t1, v_qi_b_t1_0, v_admin, 'e2e-btp-pick-t9-' || v_suffix);
  IF (SELECT unit_price_cents FROM public.blend_ticket_products WHERE id = v_line_t9_t1) IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the $0 pick was not stored: %', v_res;
  END IF;
  --  b. An admin with no reason (or only spaces) is asked for one, before any invoice row.
  FOR v_count IN 1..2 LOOP
    BEGIN
      v_res := public.create_invoice_from_blend_ticket(v_t9, v_admin, 'e2e-btp-invoice-9b' || v_count || '-' || v_suffix,
        CASE WHEN v_count = 2 THEN '   ' END);
      RAISE EXCEPTION 'SMOKE_FAIL: a $0 quoted line billed with no below-cost reason: %', v_res;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_err NOT LIKE 'BELOW_COST_REASON_REQUIRED:%' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong no-reason refusal: %', v_err;
      END IF;
    END;
    v_detail := substr(v_err, length('BELOW_COST_REASON_REQUIRED:') + 1)::jsonb;
    IF v_detail->>'operation' IS DISTINCT FROM 'create_invoice_from_blend_ticket'
       OR v_detail->>'entity_type' IS DISTINCT FROM 'blend_ticket'
       OR (v_detail->>'line_id')::uuid IS DISTINCT FROM v_line_t9_full
       OR (v_detail->>'product_id')::uuid IS DISTINCT FROM v_p_full
       OR (v_detail->>'unit_price_cents')::bigint IS DISTINCT FROM 0
       OR (v_detail->>'locked_unit_cost_cents')::bigint IS DISTINCT FROM 500 THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the $0 approval request handed to the screen is wrong: %', v_err;
    END IF;
    -- Every $0 line is listed (Mason, 2026-10-20: "list every $0 line"), in ticket order.
    IF (v_detail->'zero_lines') IS DISTINCT FROM jsonb_build_array(
         jsonb_build_object('line_id', v_line_t9_full, 'product_id', v_p_full, 'product_name', '[E2E] BTP Full ' || v_suffix),
         jsonb_build_object('line_id', v_line_t9_t1, 'product_id', v_p_t1only, 'product_name', '[E2E] BTP Tier1Only ' || v_suffix)) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the approval request does not list every $0 line: %', v_detail->'zero_lines';
    END IF;
  END LOOP;
  --  c. A sales rep cannot bill a $0 line, and the refusal never shows the rep the cost.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t9, v_rep, 'e2e-btp-invoice-9c-' || v_suffix, 'rep reason');
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep billed a $0 quoted line: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    -- entity_type blend_ticket: refused by the up-front check, before any invoice number is drawn.
    IF v_err NOT LIKE 'BELOW_COST_ADMIN_REQUIRED:%' OR v_err LIKE '%cost_cents%'
       OR jsonb_array_length(substr(v_err, length('BELOW_COST_ADMIN_REQUIRED:') + 1)::jsonb->'zero_lines') IS DISTINCT FROM 2
       OR substr(v_err, length('BELOW_COST_ADMIN_REQUIRED:') + 1)::jsonb->>'entity_type' IS DISTINCT FROM 'blend_ticket' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong rep $0 refusal: %', v_err;
    END IF;
  END;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  IF EXISTS (SELECT 1 FROM public.invoices WHERE blend_ticket_id = v_t9)
     OR EXISTS (SELECT 1 FROM public.below_cost_approvals WHERE operation = 'create_invoice_from_blend_ticket') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused $0 invoice left an invoice or an approval behind';
  END IF;
  --  d. An admin with a reason bills both lines at $0 as quoted; each is flagged in
  --     below_cost_approvals with the reason.
  v_res := public.create_invoice_from_blend_ticket(v_t9, v_admin, 'e2e-btp-invoice-9d-' || v_suffix, '  free sample  ');
  v_invoice := (v_res->'invoice_ids'->>0)::uuid;
  IF (SELECT count(*) FROM public.invoice_items ii
       WHERE ii.invoice_id = v_invoice
         AND ii.product_id IN (v_p_full, v_p_t1only)
         AND ii.unit_price_cents = 0 AND ii.extended_cents = 0
         AND ii.price_source = 'quoted' AND ii.quoted_price_cents = 0) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the $0 quoted lines did not bill at $0 as quoted: %',
      (SELECT jsonb_agg(to_jsonb(ii)) FROM public.invoice_items ii WHERE ii.invoice_id = v_invoice);
  END IF;
  IF (SELECT count(*) FROM public.below_cost_approvals a
       JOIN public.invoice_items ii ON ii.id = a.line_id
      WHERE a.operation = 'create_invoice_from_blend_ticket'
        AND a.entity_type = 'invoice' AND a.entity_id = v_invoice
        AND ii.invoice_id = v_invoice AND a.product_id = ii.product_id
        AND a.actor_user_id = v_admin AND a.reason = 'free sample'
        AND a.unit_price_cents = 0 AND a.locked_unit_cost_cents = 500) <> 2
     OR (SELECT count(*) FROM public.below_cost_approvals WHERE operation = 'create_invoice_from_blend_ticket') <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the $0 lines were not flagged in below_cost_approvals: %',
      (SELECT jsonb_agg(to_jsonb(a)) FROM public.below_cost_approvals a);
  END IF;
  --  e. The below-cost context ended with the $0 line: it is not left set for the rest of the call.
  IF COALESCE(current_setting('app.crx_below_cost_operation', true), '') <> ''
     OR COALESCE(current_setting('app.crx_below_cost_reason', true), '') <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the below-cost context was left set after the invoice';
  END IF;

  -- 15. A job whose quote section belongs to another (older) quote of the same customer than the
  --     job's own quote supplies no quoted price: no pick from it, and the line bills its tier.
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, is_planned)
  VALUES ('[E2E] BTP-Q3-' || v_suffix, v_customer, v_admin, 'sent', true) RETURNING id INTO v_old_quote;
  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_old_quote, '[E2E] BTP Old Section', 0) RETURNING id INTO v_section_d;
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_old_quote, v_section_d, v_p_full, 0, 5.50, 20, 10, 2, 'gal/acre') RETURNING id INTO v_qi_d;
  INSERT INTO public.jobs (job_number, customer_id, job_date, status, quote_id, quote_section_id, total_acres)
  VALUES ('E2E-BTP-J5-' || v_suffix, v_customer, v_today, 'scheduled', v_quote, v_section_d, 10) RETURNING id INTO v_job5;
  INSERT INTO public.blend_tickets (
    ticket_number, uploaded_by, customer_id, status, review_status,
    payment_status, order_link_status, season, total_acres, source, job_id
  ) VALUES (
    '[E2E]-BTP-10-' || v_suffix, v_admin, v_customer,
    'completed', 'approved', 'unbilled', 'unlinked', public.current_season(), 10, 'manual', v_job5
  ) RETURNING id INTO v_t10;
  INSERT INTO public.blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres)
  VALUES (v_t10, v_field, v_customer, 10);
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
  VALUES (v_t10, v_p_full, '[E2E] BTP t10 other quote section', 20, 'GL', 2, 'gal/ac', 1) RETURNING id INTO v_line_t10;
  BEGIN
    v_res := public.set_blend_ticket_product_quote_price(v_line_t10, v_qi_d, v_admin, 'e2e-btp-pick-t10-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a price from a quote other than the job''s own quote was accepted as the pick: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_TICKET_QUOTE_PRICE_INVALID_CHOICE:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong other-quote-section refusal: %', v_err; END IF;
  END;
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t10, v_admin, 'e2e-btp-invoice-10-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: the ticket whose job section is on another quote was refused: %', v_err;
  END;
  SELECT ii.unit_price_cents, ii.price_source INTO v_cents, v_text
    FROM public.invoice_items ii
   WHERE ii.invoice_id = (v_res->'invoice_ids'->>0)::uuid AND ii.product_id = v_p_full;
  IF v_cents IS DISTINCT FROM 900 OR v_text IS DISTINCT FROM 'tier' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a section of another quote priced the invoice line at % (%), expected the 900-cent tier-2 price', v_cents, v_text;
  END IF;

  -- 10. Own name: a sales rep cannot pick a price on another rep's ticket.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  BEGIN
    v_res := public.set_blend_ticket_product_quote_price(v_line_other, v_qi_750, v_rep, 'e2e-btp-pick-rep-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep picked a price on another rep''s ticket: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong own-name refusal: %', v_err; END IF;
  END;
  IF (SELECT unit_price_cents FROM public.blend_ticket_products WHERE id = v_line_other) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused own-name pick stored a price';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
