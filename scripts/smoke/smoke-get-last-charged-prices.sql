-- ============================================================================
-- SMOKE CHAIN (rolled back by design): get_last_charged_prices / price_tier_at_sale
-- (20261027060000_last_charged_prices.sql). Run after apply, as ONE statement.
--
-- Auth probes (template smoke-auth-probe-template.sql):
--   P1 no-auth      claims ''                      -> AUTH_REQUIRED
--   P2 anon-key     claims {"role":"anon"}, no sub -> AUTH_REQUIRED
--   P3 wrong-role   an active driver or applicator -> Permission denied: requires admin or sales_rep role
--   P4 positive     an active admin and an active sales rep read the same answer
-- Then the business chain, on a throwaway customer at tier 2 and an active product: nothing charged
-- yet; a confirmed order line is stamped tier 2 and becomes the last charge; a draft invoice line
-- for it is stamped tier 2 from the order line and does not count (the order still shows); a
-- cancelled order does not count; an unknown customer is refused. Always ends in
-- SMOKE_PASS_ROLLBACK, so nothing persists.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_wrong uuid;
  v_product uuid;
  v_customer uuid := gen_random_uuid();
  v_order uuid := gen_random_uuid();
  v_cancelled uuid := gen_random_uuid();
  v_line uuid := gen_random_uuid();
  v_invoice uuid := gen_random_uuid();
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_result jsonb;
  v_rep_result jsonb;
  v_tier smallint;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM public.profiles WHERE role = 'sales_rep' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_wrong FROM public.profiles WHERE role IN ('driver', 'applicator') AND is_active ORDER BY created_at LIMIT 1;
  SELECT p.id INTO v_product FROM public.products p WHERE p.is_active AND p.tier1_price > 0 ORDER BY p.created_at, p.id LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL OR v_wrong IS NULL OR v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: need an active admin, sales rep, driver or applicator, and a priced active product';
  END IF;

  INSERT INTO public.customers (id, farm_name, assigned_tier) VALUES (v_customer, '[SMOKE] last charged ' || v_suffix, 2);

  -- P1 no-auth
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.get_last_charged_prices(v_customer, ARRAY[v_product]);
    RAISE EXCEPTION 'SMOKE_FAIL P1: no-auth call succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL P1: %', SQLERRM; END IF;
  END;

  -- P2 anon key
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.get_last_charged_prices(v_customer, ARRAY[v_product]);
    RAISE EXCEPTION 'SMOKE_FAIL P2: anon call succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL P2: %', SQLERRM; END IF;
  END;

  -- P3 wrong role
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_wrong, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_wrong::text, true);
  BEGIN
    PERFORM public.get_last_charged_prices(v_customer, ARRAY[v_product]);
    RAISE EXCEPTION 'SMOKE_FAIL P3: driver/applicator call succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Permission denied: requires admin or sales_rep role%' THEN RAISE EXCEPTION 'SMOKE_FAIL P3: %', SQLERRM; END IF;
  END;

  -- P4 positive, as the admin: nothing charged yet.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_result := public.get_last_charged_prices(v_customer, ARRAY[v_product]);
  IF v_result IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'SMOKE_FAIL P4 empty: %', v_result;
  END IF;

  -- A confirmed order line: stamped with the customer's tier, and the last charge.
  INSERT INTO public.orders (id, order_number, customer_id, status, order_date)
  VALUES (v_order, 'ORD-SMOKE-' || v_suffix, v_customer, 'confirmed', DATE '2026-10-01');
  INSERT INTO public.order_items (id, order_id, product_id, product_name, price_per_unit, total_units_needed, total_price)
  SELECT v_line, v_order, p.id, p.product_name, round(p.tier1_price * 2, 2), 1, round(p.tier1_price * 2, 2)
    FROM public.products p WHERE p.id = v_product;
  SELECT price_tier_at_sale INTO v_tier FROM public.order_items WHERE id = v_line;
  IF v_tier IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL stamp order line: tier %', v_tier;
  END IF;
  v_result := public.get_last_charged_prices(v_customer, ARRAY[v_product]);
  IF jsonb_array_length(v_result) <> 1
     OR v_result->0->>'source' <> 'order'
     OR v_result->0->>'charged_on' <> '2026-10-01'
     OR (v_result->0->>'price_tier')::int <> 2
     OR (v_result->0->>'unit_price_cents')::bigint
        <> (SELECT round(price_per_unit * 100)::bigint FROM public.order_items WHERE id = v_line) THEN
    RAISE EXCEPTION 'SMOKE_FAIL order counts: %', v_result;
  END IF;

  -- The rep reads the same answer, though the customer is not theirs.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  v_rep_result := public.get_last_charged_prices(v_customer, ARRAY[v_product]);
  IF v_rep_result IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL P4 rep: % vs admin %', v_rep_result, v_result;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- The customer moves to tier 3: the stamped line keeps tier 2.
  UPDATE public.customers SET assigned_tier = 3 WHERE id = v_customer;
  IF (SELECT price_tier_at_sale FROM public.order_items WHERE id = v_line) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL stamp moved with the customer tier';
  END IF;

  -- A draft invoice line for that order line: stamped 2 from the order line, and not a charge.
  INSERT INTO public.invoices (id, invoice_number, customer_id, order_id, status, invoice_date, created_by)
  VALUES (v_invoice, 'INV-SMOKE-' || v_suffix, v_customer, v_order, 'draft', DATE '2026-10-05', v_admin);
  INSERT INTO public.invoice_items (invoice_id, order_item_id, product_id, description, quantity, unit_price_cents, extended_cents)
  SELECT v_invoice, v_line, oi.product_id, oi.product_name, 1, round(oi.price_per_unit * 100)::bigint, round(oi.price_per_unit * 100)::bigint
    FROM public.order_items oi WHERE oi.id = v_line;
  IF (SELECT price_tier_at_sale FROM public.invoice_items WHERE invoice_id = v_invoice) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL stamp invoice line: %', (SELECT price_tier_at_sale FROM public.invoice_items WHERE invoice_id = v_invoice);
  END IF;
  IF public.get_last_charged_prices(v_customer, ARRAY[v_product]) IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL draft invoice changed the answer: %', public.get_last_charged_prices(v_customer, ARRAY[v_product]);
  END IF;

  -- A later cancelled order does not count.
  INSERT INTO public.orders (id, order_number, customer_id, status, order_date)
  VALUES (v_cancelled, 'ORD-SMOKE-X-' || v_suffix, v_customer, 'confirmed', DATE '2026-10-20');
  INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, total_units_needed, total_price)
  SELECT v_cancelled, p.id, p.product_name, round(p.tier1_price * 3, 2), 1, round(p.tier1_price * 3, 2)
    FROM public.products p WHERE p.id = v_product;
  UPDATE public.orders SET status = 'cancelled' WHERE id = v_cancelled;
  IF public.get_last_charged_prices(v_customer, ARRAY[v_product]) IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'SMOKE_FAIL cancelled order counted: %', public.get_last_charged_prices(v_customer, ARRAY[v_product]);
  END IF;

  -- Unknown customer.
  BEGIN
    PERFORM public.get_last_charged_prices(gen_random_uuid(), ARRAY[v_product]);
    RAISE EXCEPTION 'SMOKE_FAIL unknown customer succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'CUSTOMER_NOT_FOUND%' THEN RAISE EXCEPTION 'SMOKE_FAIL unknown customer: %', SQLERRM; END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
