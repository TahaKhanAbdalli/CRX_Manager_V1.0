-- ============================================================================
-- CONTAINER ONLY smoke chain for 20261015130000_orders_blend_tickets_rep_own_name.
-- Run through scripts/smoke/prove-orders-blend-tickets-rep-own-name-real-schema.mjs, never against
-- the live database: it creates orders and invoices, which draw customer-visible order and invoice
-- numbers from sequences that a rollback does not return.
--
-- Rule under test (Mason, 2026-10-06, narrowed 2026-10-13): a sales rep records only themselves
-- (or no one) as salesperson on orders and blend tickets, changes a salesperson only from blank to
-- themselves, and bills or converts a blend ticket only when it is theirs or has no salesperson.
-- Admins are unrestricted. An update that leaves the salesperson alone is never refused.
--
-- Runs as the table owner with request.jwt.claims switched between an admin and a rep, so the
-- guard sees the same auth.uid() it sees on live; the blend-ticket UPDATE and the order INSERT are
-- also tried as the authenticated role through Row Level Security, the way the browser reaches
-- them. Every step must leave the refused row unchanged. Terminal SMOKE_PASS_ROLLBACK.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_other_rep uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_product uuid;
  v_pricing jsonb;
  v_customer uuid;
  v_field uuid;
  v_order uuid;
  v_order_other uuid;
  v_order_blank uuid;
  v_order_own uuid;
  v_tickets uuid[] := ARRAY[]::uuid[];
  v_ticket uuid;
  v_res jsonb;
  v_json json;
  v_err text;
  v_i int;
  v_count int;
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

  -- A product priced through the governed preview/apply path (products are born pricing-free).
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] Rep Salesman Product ' || v_suffix, 'GL') RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')),
    v_admin, 'e2e-rep-salesman-pricing-preview-' || v_suffix);
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed'
     OR (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint', v_admin,
    'e2e-rep-salesman-pricing-apply-' || v_suffix);
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
  VALUES (v_product, 'Main Warehouse', 1000, 0, 'GL');

  INSERT INTO public.customers (farm_name, assigned_sales_rep, assigned_tier)
  VALUES ('[E2E] Rep Salesman Farm ' || v_suffix, v_other_rep, 1) RETURNING id INTO v_customer;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[E2E] Rep Salesman Field ' || v_suffix, 'corn', 10) RETURNING id INTO v_field;

  -- Seven approved, unbilled tickets, inserted by the admin:
  --   1 other rep (rep bills: refused; admin bills it)      2 the rep (rep bills)
  --   3 no one (rep bills)                                   4 other rep (rep converts: refused)
  --   5 no one (rep converts)                                6 no one (rep's direct UPDATEs)
  --   7 other rep (rep's direct UPDATEs)
  -- The admin naming a rep on new rows is itself a check: only sales reps are held to their own name.
  BEGIN
  FOR v_i IN 1..7 LOOP
    INSERT INTO public.blend_tickets (
      ticket_number, uploaded_by, customer_id, salesman_id, status, review_status,
      payment_status, order_link_status, season, total_acres, source
    ) VALUES (
      '[E2E]-RSN-' || v_i || '-' || v_suffix, v_admin, v_customer,
      CASE WHEN v_i IN (1, 4, 7) THEN v_other_rep WHEN v_i = 2 THEN v_rep ELSE NULL END,
      'completed', 'approved', 'unbilled', 'unlinked', public.current_season(), 10, 'manual'
    ) RETURNING id INTO v_ticket;
    INSERT INTO public.blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres)
    VALUES (v_ticket, v_field, v_customer, 10);
    INSERT INTO public.blend_ticket_products (
      blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order
    ) VALUES (v_ticket, v_product, '[E2E] RSN line ' || v_i, 20, 'GL', 2, 'gal/ac', 1);
    v_tickets := v_tickets || v_ticket;
  END LOOP;

  -- Orders inserted by the admin: one naming the other rep, one blank, one the rep's own.
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-RSN-OTHER-' || v_suffix, v_customer, v_today, 'confirmed', false, v_other_rep)
  RETURNING id INTO v_order_other;
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-RSN-BLANK-' || v_suffix, v_customer, v_today, 'confirmed', false, NULL)
  RETURNING id INTO v_order_blank;
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-RSN-OWN-' || v_suffix, v_customer, v_today, 'confirmed', false, v_rep)
  RETURNING id INTO v_order_own;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: an admin could not name a sales rep on a new order or blend ticket';
    END IF;
    RAISE;
  END;

  -- From here on, the rep.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);

  -- 1. A rep cannot create an order naming another rep: as the owner (the path every definer RPC
  --    takes) and as the authenticated role through orders_insert (the browser's path).
  BEGIN
    INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
    VALUES ('E2E-RSN-1-' || v_suffix, v_customer, v_today, 'confirmed', false, v_other_rep);
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep created an order under another rep''s name';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong order-insert refusal: %', v_err;
    END IF;
  END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
    VALUES ('E2E-RSN-1B-' || v_suffix, v_customer, v_today, 'confirmed', false, v_admin);
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep created an order naming an admin through the Data API';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong Data API order-insert refusal: %', v_err;
    END IF;
  END;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: SET LOCAL ROLE did not end with its sub-block (current_user %)', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.orders WHERE order_number IN ('E2E-RSN-1-' || v_suffix, 'E2E-RSN-1B-' || v_suffix)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused order insert left a row';
  END IF;

  -- 2. A rep creates orders under their own name or none, also through the Data API.
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-RSN-2A-' || v_suffix, v_customer, v_today, 'confirmed', false, v_rep);
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-RSN-2B-' || v_suffix, v_customer, v_today, 'confirmed', false, NULL);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
    VALUES ('E2E-RSN-2C-' || v_suffix, v_customer, v_today, 'confirmed', false, v_rep);
    RAISE EXCEPTION 'SMOKE_STEP_OK';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err IS DISTINCT FROM 'SMOKE_STEP_OK' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a sales rep could not create an order under their own name through the Data API: %', v_err;
    END IF;
  END;
  IF (SELECT count(*) FROM public.orders WHERE order_number IN ('E2E-RSN-2A-' || v_suffix, 'E2E-RSN-2B-' || v_suffix)) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep could not create an order under their own name or none';
  END IF;

  -- 3. Changing an order's salesperson: only from blank to the rep. Another rep's name is never
  --    replaced (not even with the rep's own) or cleared; the rep's own is never cleared; a blank
  --    never takes someone else's name. An update that leaves the salesperson alone always works.
  BEGIN
    UPDATE public.orders SET salesman_id = v_rep WHERE id = v_order_other;
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep took over another rep''s order';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong order take-over refusal: %', v_err;
    END IF;
  END;
  BEGIN
    UPDATE public.orders SET salesman_id = NULL WHERE id = v_order_other;
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep cleared another rep''s name from an order';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong order clear refusal: %', v_err;
    END IF;
  END;
  BEGIN
    UPDATE public.orders SET salesman_id = v_other_rep WHERE id = v_order_blank;
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep put another rep''s name on a blank order';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong blank-order refusal: %', v_err;
    END IF;
  END;
  BEGIN
    UPDATE public.orders SET salesman_id = NULL WHERE id = v_order_own;
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep cleared the salesperson from their own order';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong own-order clear refusal: %', v_err;
    END IF;
  END;
  -- Unchanged salesperson on another rep's order, even with the column in the SET list.
  BEGIN
    UPDATE public.orders SET salesman_id = salesman_id, notes = 'rep touched it' WHERE id = v_order_other;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: an update that left another rep''s salesperson alone was refused: %', v_err;
  END;
  UPDATE public.orders SET salesman_id = v_rep WHERE id = v_order_blank;
  IF (SELECT salesman_id FROM public.orders WHERE id = v_order_other) IS DISTINCT FROM v_other_rep
     OR (SELECT notes FROM public.orders WHERE id = v_order_other) IS DISTINCT FROM 'rep touched it'
     OR (SELECT salesman_id FROM public.orders WHERE id = v_order_blank) IS DISTINCT FROM v_rep
     OR (SELECT salesman_id FROM public.orders WHERE id = v_order_own) IS DISTINCT FROM v_rep THEN
    RAISE EXCEPTION 'SMOKE_FAIL: order salespeople are not what the allowed and refused updates should leave';
  END IF;

  -- 4. Blend tickets through the browser's path (blend_tickets_office_update): a blank never takes
  --    another rep's name, another rep's name is never replaced or cleared; a blank takes the rep's
  --    own, and edits that leave the salesperson alone work on another rep's ticket.
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.blend_tickets SET salesman_id = v_other_rep WHERE id = v_tickets[6];
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep put another rep''s name on a blank blend ticket';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong blank-ticket refusal: %', v_err;
    END IF;
  END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.blend_tickets SET salesman_id = v_rep WHERE id = v_tickets[7];
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep took over another rep''s blend ticket';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong ticket take-over refusal: %', v_err;
    END IF;
  END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.blend_tickets SET salesman_id = v_rep WHERE id = v_tickets[6];
    UPDATE public.blend_tickets SET salesman_id = salesman_id, notes = 'rep note' WHERE id = v_tickets[7];
    RAISE EXCEPTION 'SMOKE_STEP_OK';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err IS DISTINCT FROM 'SMOKE_STEP_OK' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a sales rep could not claim a blank ticket or edit another rep''s ticket: %', v_err;
    END IF;
  END;
  -- That block rolled back with its sub-transaction; replay the allowed edits as the owner.
  UPDATE public.blend_tickets SET salesman_id = v_rep WHERE id = v_tickets[6];
  UPDATE public.blend_tickets SET salesman_id = salesman_id, notes = 'rep note' WHERE id = v_tickets[7];
  IF (SELECT salesman_id FROM public.blend_tickets WHERE id = v_tickets[6]) IS DISTINCT FROM v_rep
     OR (SELECT salesman_id FROM public.blend_tickets WHERE id = v_tickets[7]) IS DISTINCT FROM v_other_rep THEN
    RAISE EXCEPTION 'SMOKE_FAIL: blend-ticket salespeople are not what the allowed and refused updates should leave';
  END IF;
  BEGIN
    INSERT INTO public.blend_tickets (ticket_number, uploaded_by, customer_id, salesman_id, status,
      review_status, payment_status, order_link_status, season, total_acres, source)
    VALUES ('[E2E]-RSN-INS-' || v_suffix, v_rep, v_customer, v_other_rep, 'completed', 'approved',
      'unbilled', 'unlinked', public.current_season(), 10, 'manual');
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep created a blend ticket under another rep''s name';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong ticket-insert refusal: %', v_err;
    END IF;
  END;

  -- 5. Billing a blend ticket: refused on another rep's ticket before any invoice is written (and
  --    even with a key that already replays); the rep bills their own and an unassigned ticket.
  SELECT count(*) INTO v_count FROM public.invoices;
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_tickets[1], v_rep, 'e2e-rsn-bill-other-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep billed another rep''s blend ticket under that rep''s name';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong blend-ticket billing refusal: %', v_err;
    END IF;
  END;
  IF (SELECT count(*) FROM public.invoices) <> v_count
     OR (SELECT payment_status FROM public.blend_tickets WHERE id = v_tickets[1]) IS DISTINCT FROM 'unbilled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused blend-ticket billing wrote something';
  END IF;
  -- The replay lookup is keyed by the key alone, not by who calls. So an admin bills ticket 1
  -- under the other rep first, and the rep retrying with the admin's key must still be refused,
  -- not handed the admin's invoices.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_res := public.create_invoice_from_blend_ticket(v_tickets[1], v_admin, 'e2e-rsn-bill-admin-' || v_suffix);
  IF (SELECT salesman_id FROM public.invoices WHERE id = (v_res->'invoice_ids'->>0)::uuid) IS DISTINCT FROM v_other_rep THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an admin could not bill another rep''s blend ticket: %', v_res;
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  SELECT count(*) INTO v_count FROM public.invoices;
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_tickets[1], v_rep, 'e2e-rsn-bill-admin-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep replayed an admin''s billing of another rep''s blend ticket: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong blend-ticket replay refusal: %', v_err;
    END IF;
  END;
  IF (SELECT count(*) FROM public.invoices) <> v_count THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused blend-ticket replay wrote something';
  END IF;
  -- The same key on an unassigned ticket passes the own-name test, so the replay itself must
  -- refuse to hand back the admin's invoices for ticket 1.
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_tickets[3], v_rep, 'e2e-rsn-bill-admin-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep replayed an admin''s billing key on another ticket: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'IDEMPOTENCY_INTENT_MISMATCH' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong cross-ticket replay refusal: %', v_err;
    END IF;
  END;
  IF (SELECT count(*) FROM public.invoices) <> v_count
     OR (SELECT payment_status FROM public.blend_tickets WHERE id = v_tickets[3]) IS DISTINCT FROM 'unbilled' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused cross-ticket replay wrote something';
  END IF;
  v_res := public.create_invoice_from_blend_ticket(v_tickets[2], v_rep, 'e2e-rsn-bill-own-' || v_suffix);
  IF (SELECT salesman_id FROM public.invoices WHERE id = (v_res->'invoice_ids'->>0)::uuid) IS DISTINCT FROM v_rep THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep could not bill their own blend ticket under their name: %', v_res;
  END IF;
  -- A replay of the rep's own billing still returns it.
  IF public.create_invoice_from_blend_ticket(v_tickets[2], v_rep, 'e2e-rsn-bill-own-' || v_suffix) IS DISTINCT FROM v_res THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the rep''s own blend-ticket billing did not replay';
  END IF;
  -- The rep's own key on a different ticket is refused (the receipt is bound to its ticket).
  BEGIN
    v_json := public.create_invoice_from_blend_ticket(v_tickets[3], v_rep, 'e2e-rsn-bill-own-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a billing key replayed onto a different blend ticket: %', v_json;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'IDEMPOTENCY_INTENT_MISMATCH' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong other-ticket replay refusal: %', v_err;
    END IF;
  END;
  -- An admin's key on the rep's own ticket is refused to the rep (the receipt is bound to its
  -- caller): the admin bills ticket 6, which names the rep, and the rep retries that key.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM public.create_invoice_from_blend_ticket(v_tickets[6], v_admin, 'e2e-rsn-bill-admin6-' || v_suffix);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  BEGIN
    v_json := public.create_invoice_from_blend_ticket(v_tickets[6], v_rep, 'e2e-rsn-bill-admin6-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep replayed an admin''s billing key on their own ticket: %', v_json;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'IDEMPOTENCY_INTENT_MISMATCH' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong other-caller replay refusal: %', v_err;
    END IF;
  END;
  v_res := public.create_invoice_from_blend_ticket(v_tickets[3], v_rep, 'e2e-rsn-bill-none-' || v_suffix);
  IF NOT EXISTS (SELECT 1 FROM public.invoices WHERE id = (v_res->'invoice_ids'->>0)::uuid AND salesman_id IS NULL) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep could not bill an unassigned blend ticket: %', v_res;
  END IF;

  -- 6. Converting a blend ticket to an order copies its salesperson: refused on another rep's
  --    ticket, allowed on an unassigned one.
  BEGIN
    v_json := public.create_order_from_blend_ticket(v_tickets[4], 'E2E-RSN-6A-' || v_suffix, v_today, NULL, v_rep, 'e2e-rsn-order-other-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep converted another rep''s blend ticket into an order under that rep''s name: %', v_json;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong ticket-conversion refusal: %', v_err;
    END IF;
  END;
  v_json := public.create_order_from_blend_ticket(v_tickets[5], 'E2E-RSN-6B-' || v_suffix, v_today, NULL, v_rep, 'e2e-rsn-order-none-' || v_suffix);
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE order_number = 'E2E-RSN-6B-' || v_suffix AND salesman_id IS NULL) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep could not convert an unassigned blend ticket: %', v_json;
  END IF;

  -- 7. An admin is unrestricted: converts another rep's ticket under that rep's name (step 5
  --    showed an admin billing one), and reassigns orders and tickets.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_json := public.create_order_from_blend_ticket(v_tickets[4], 'E2E-RSN-7A-' || v_suffix, v_today, NULL, v_admin, 'e2e-rsn-order-admin-' || v_suffix);
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE order_number = 'E2E-RSN-7A-' || v_suffix AND salesman_id = v_other_rep) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an admin could not convert another rep''s blend ticket: %', v_json;
  END IF;
  UPDATE public.orders SET salesman_id = v_rep WHERE id = v_order_other;
  UPDATE public.blend_tickets SET salesman_id = NULL WHERE id = v_tickets[7];
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw, salesman_id)
  VALUES ('E2E-RSN-7B-' || v_suffix, v_customer, v_today, 'confirmed', false, v_other_rep);
  IF (SELECT salesman_id FROM public.orders WHERE id = v_order_other) IS DISTINCT FROM v_rep
     OR (SELECT salesman_id FROM public.blend_tickets WHERE id = v_tickets[7]) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an admin could not reassign an order or a blend ticket';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
