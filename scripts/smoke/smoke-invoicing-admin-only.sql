-- Rollback-only chain for 20261009120000_invoicing_admin_only (Mason 2026-10-09: no sales rep,
-- driver or other non-admin may invoice any customer; reps READ every invoice; posting can bind to
-- the version an admin reviewed).
--
-- CONTAINER ONLY: it plants [E2E] users, a priced product, customers, orders and deliveries and
-- draws invoice numbers on its admin steps. Run it through
-- scripts/smoke/prove-invoicing-admin-only-real-schema.mjs, never against the live database.
--
-- FAIL-FIRST CONTRACT: before the candidate a sales rep's call to the first wrapped RPC is not
-- refused with INVOICING_ADMIN_ONLY, so this chain raises its step-1 SMOKE_FAIL. After it:
--   1-2 every wrapped invoicing RPC refuses a sales rep and a driver with 42501
--       INVOICING_ADMIN_ONLY before anything else (the arguments are dummies on purpose: the guard
--       is the first statement), with no invoice number drawn;
--   3   the split wrapper refuses a NULL key for an admin (IDEMPOTENCY_KEY_REQUIRED, 22023);
--   4   a rep's quick delivery that still sends p_skip_invoice = false creates no invoice;
--   5   a rep's delivery completion completes with no invoice and no number, one
--       delivery_invoice_pending_admin activity row and one notification per active admin;
--   6   a rep (as authenticated, through RLS) reads an admin's invoice and its lines;
--   6b  (Decision 2, Mason 2026-10-10) for a customer not assigned to the rep that an invoice
--       names, a rep's direct customers read returns nothing while get_invoice_customer_names
--       returns exactly (id, farm_name); a driver gets no names;
--   7   a post with the version the admin reviewed is refused once the invoice changed
--       (INVOICE_CHANGED_SINCE_REVIEW) and goes through with the current version;
--   8   the catalog sweep finds no function authenticated can run that reaches an invoice write
--       without the guard first, other than the reviewed already-admin-only and upkeep functions,
--       each pinned by signature and body md5. The query is the migration postflight's text,
--       byte for byte (the prover checks that the two stay identical).
-- Every SMOKE_FAIL names its step. One DO block, terminal exception -> nothing commits.
DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_admin uuid;
  v_rep uuid := gen_random_uuid();
  v_driver uuid := gen_random_uuid();
  v_who uuid;
  v_label text;
  v_product uuid;
  v_pricing jsonb;
  v_customer uuid;
  v_order uuid;
  v_item uuid;
  v_delivery uuid;
  v_invoice uuid;
  v_version text;
  v_result jsonb;
  v_seq_before text;
  v_seq_after text;
  v_err text;
  v_state text;
  v_count integer;
  v_admins integer;
  v_call text;
  v_unclassified text;
  v_other_customer uuid;
  v_names text;
  v_calls text[] := ARRAY[
    $c$SELECT public.save_invoice('{}'::jsonb, '[]'::jsonb, 'e2e-ao-1')$c$,
    $c$SELECT public.save_field_app_invoice(gen_random_uuid(), '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, auth.uid(), NULL, 'e2e-ao-2')$c$,
    $c$SELECT public.save_field_app_split_invoice(NULL, NULL, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, auth.uid(), NULL, 'e2e-ao-3')$c$,
    $c$SELECT public.create_invoice_from_order(gen_random_uuid(), NULL, 'chemical_sale', 'e2e-ao-4')$c$,
    $c$SELECT public.create_split_invoices_from_order(gen_random_uuid(), NULL, 'chemical_sale', 'e2e-ao-5')$c$,
    $c$SELECT public.create_invoice_from_blend_ticket(gen_random_uuid(), auth.uid(), 'e2e-ao-6')$c$,
    $c$SELECT public.transfer_job_to_invoice(gen_random_uuid(), auth.uid(), 'e2e-ao-7')$c$,
    $c$SELECT public.transfer_invoice_to_job(gen_random_uuid(), auth.uid(), 'e2e-ao-8')$c$,
    $c$SELECT public.consolidate_draft_invoices(gen_random_uuid(), auth.uid(), 'e2e-ao-9')$c$,
    $c$SELECT public.update_field_app_applied_info(ARRAY[gen_random_uuid()], NULL, NULL, NULL, auth.uid(), 'e2e-ao-10')$c$,
    $c$SELECT public.update_field_app_invoice_billing(ARRAY[gen_random_uuid()], 'PO', NULL, NULL, NULL, NULL, NULL, '{}'::jsonb, auth.uid(), 'e2e-ao-11')$c$,
    $c$SELECT public.post_invoice(gen_random_uuid(), 'e2e-ao-12')$c$,
    $c$SELECT public.post_invoice_group(gen_random_uuid(), auth.uid(), 'e2e-ao-13')$c$,
    $c$SELECT public.batch_post_invoices(ARRAY[gen_random_uuid()], 'e2e-ao-14')$c$,
    $c$SELECT public.unpost_invoice(gen_random_uuid(), auth.uid(), 'e2e-ao-15')$c$,
    $c$SELECT public.unpost_invoice_group(gen_random_uuid(), auth.uid(), 'e2e-ao-16')$c$,
    $c$SELECT public.batch_void_invoices(ARRAY[gen_random_uuid()], 'void', auth.uid(), 'e2e-ao-17')$c$,
    $c$SELECT public.apply_credit_memo_to_invoice(gen_random_uuid(), gen_random_uuid(), 100, auth.uid(), 'e2e-ao-18')$c$,
    $c$SELECT public.reverse_credit_memo_application(gen_random_uuid(), 'reason', auth.uid(), 'e2e-ao-19')$c$,
    $c$SELECT public.apply_prepay_to_invoice(gen_random_uuid(), gen_random_uuid(), 100, auth.uid(), 'e2e-ao-20')$c$,
    $c$SELECT public.batch_apply_all_prepayments(auth.uid(), 'e2e-ao-21')$c$,
    $c$SELECT public.reverse_write_off(gen_random_uuid(), 'reason', auth.uid(), 'e2e-ao-22')$c$
  ];
BEGIN
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: active admin required'; END IF;
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (v_rep, 'e2e-ao-rep-' || v_suffix || '@example.invalid', '{"full_name":"[E2E] Admin-only Rep","role":"sales_rep"}'::jsonb),
    (v_driver, 'e2e-ao-driver-' || v_suffix || '@example.invalid', '{"full_name":"[E2E] Admin-only Driver","role":"driver"}'::jsonb);
  IF (SELECT count(*) FROM public.profiles WHERE id IN (v_rep, v_driver) AND is_active) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the rep and driver profiles were not created';
  END IF;
  -- The "no number drawn" checks read the sequences directly: require CACHE 1.
  IF (SELECT count(*) FROM pg_sequences
       WHERE schemaname = 'public'
         AND sequencename IN ('invoice_number_seq', 'cs_invoice_number_seq', 'mc_invoice_number_seq', 'cm_invoice_number_seq')
         AND cache_size = 1) <> 4 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the four invoice-number sequences must exist with CACHE 1';
  END IF;
  v_admins := (SELECT count(*) FROM public.profiles WHERE role = 'admin' AND is_active = true);

  -- Steps 1-2: every wrapped RPC refuses a sales rep and a driver first.
  FOREACH v_who IN ARRAY ARRAY[v_rep, v_driver] LOOP
    v_label := CASE WHEN v_who = v_rep THEN 'step 1 (sales rep)' ELSE 'step 2 (driver)' END;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_who, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_who::text, true);
    FOREACH v_call IN ARRAY v_calls LOOP
      SELECT string_agg(sequencename || '=' || COALESCE(last_value::text, 'none'), ',' ORDER BY sequencename) INTO v_seq_before
        FROM pg_sequences WHERE schemaname = 'public' AND sequencename LIKE '%invoice_number_seq';
      BEGIN
        EXECUTE v_call;
        RAISE EXCEPTION 'SMOKE_FAIL: %: % was not refused', v_label, v_call;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
        IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
        SELECT string_agg(sequencename || '=' || COALESCE(last_value::text, 'none'), ',' ORDER BY sequencename) INTO v_seq_after
          FROM pg_sequences WHERE schemaname = 'public' AND sequencename LIKE '%invoice_number_seq';
        IF v_seq_after IS DISTINCT FROM v_seq_before THEN
          RAISE EXCEPTION 'SMOKE_FAIL: %: % drew an invoice number before refusing (%)', v_label, v_call, v_err;
        END IF;
        IF v_state <> '42501' OR v_err NOT LIKE 'INVOICING_ADMIN_ONLY:%' THEN
          RAISE EXCEPTION 'SMOKE_FAIL: %: % was refused with % % instead of INVOICING_ADMIN_ONLY', v_label, v_call, v_state, v_err;
        END IF;
      END;
    END LOOP;
  END LOOP;

  -- Step 3: the split wrapper requires its key, for an admin too.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    PERFORM public.create_split_invoices_from_order(gen_random_uuid(), NULL, 'chemical_sale', NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: step 3: a split with a NULL key was not refused';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_state <> '22023' OR v_err <> 'IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step 3: wrong NULL-key refusal: % %', v_state, v_err;
    END IF;
  END;

  -- Fixtures (admin): a product priced through the governed path, a rep-assigned customer.
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] Admin-only Product ' || v_suffix, 'GL') RETURNING id INTO v_product;
  v_pricing := public.preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'row_version', 1, 'pricing_mode', 'price_driven',
      'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '10.00', 'tier3_price', '10.00')),
    v_admin, 'e2e-ao-pricing-preview-' || v_suffix);
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed' OR (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set((v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint', v_admin, 'e2e-ao-pricing-apply-' || v_suffix);
  INSERT INTO public.inventory (product_id, location, quantity_available, quantity_prebooked, unit_size)
  VALUES (v_product, 'Main Warehouse', 1000, 0, 'GL')
  ON CONFLICT DO NOTHING;
  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[E2E] Admin-only Farm ' || v_suffix, v_rep) RETURNING id INTO v_customer;

  -- Step 4: a rep's quick delivery with p_skip_invoice = false (an old cached client).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  SELECT string_agg(sequencename || '=' || COALESCE(last_value::text, 'none'), ',' ORDER BY sequencename) INTO v_seq_before
    FROM pg_sequences WHERE schemaname = 'public' AND sequencename LIKE '%invoice_number_seq';
  v_result := public.create_quick_delivery(v_customer, jsonb_build_array(jsonb_build_object('product_id', v_product, 'quantity', 2)),
    NULL, v_today, NULL, v_rep, 'e2e-ao-quick-' || v_suffix, false);
  SELECT string_agg(sequencename || '=' || COALESCE(last_value::text, 'none'), ',' ORDER BY sequencename) INTO v_seq_after
    FROM pg_sequences WHERE schemaname = 'public' AND sequencename LIKE '%invoice_number_seq';
  IF v_result->>'delivery_id' IS NULL OR v_result->>'invoice_id' IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.invoices WHERE delivery_id = (v_result->>'delivery_id')::uuid)
     OR v_seq_after IS DISTINCT FROM v_seq_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 4: a rep''s quick delivery created an invoice or drew a number: %', v_result;
  END IF;

  -- Step 5: a rep completes a non-split delivery.
  INSERT INTO public.orders (order_number, customer_id, order_date, status, booking_draw)
  VALUES ('E2E-AO-' || v_suffix, v_customer, v_today, 'confirmed', false) RETURNING id INTO v_order;
  INSERT INTO public.order_items (order_id, product_id, product_name, price_per_unit, cost_per_unit,
    total_units_needed, total_price, profit, net_margin, quantity_delivered, quantity_remaining, unit_size)
  VALUES (v_order, v_product, '[E2E] admin-only line', 10, 5, 4, 40, 20, 50, 0, 4, 'GL') RETURNING id INTO v_item;
  INSERT INTO public.deliveries (delivery_number, order_id, customer_id, scheduled_date, status, created_by)
  VALUES ('E2E-AO-DEL-' || v_suffix, v_order, v_customer, v_today, 'scheduled', v_admin) RETURNING id INTO v_delivery;
  INSERT INTO public.delivery_items (delivery_id, order_item_id, product_id, quantity, quantity_delivered, unit_size)
  VALUES (v_delivery, v_item, v_product, 4, 0, 'GL');
  UPDATE public.deliveries SET status = 'in_progress' WHERE id = v_delivery;
  SELECT string_agg(sequencename || '=' || COALESCE(last_value::text, 'none'), ',' ORDER BY sequencename) INTO v_seq_before
    FROM pg_sequences WHERE schemaname = 'public' AND sequencename LIKE '%invoice_number_seq';
  PERFORM public.complete_delivery(v_delivery, '[E2E] Receiver', v_rep, NULL, NULL, NULL, 'e2e-ao-complete-' || v_suffix, NULL);
  SELECT string_agg(sequencename || '=' || COALESCE(last_value::text, 'none'), ',' ORDER BY sequencename) INTO v_seq_after
    FROM pg_sequences WHERE schemaname = 'public' AND sequencename LIKE '%invoice_number_seq';
  IF (SELECT status FROM public.deliveries WHERE id = v_delivery) <> 'completed' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 5: the rep''s delivery did not complete';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE order_id = v_order) OR v_seq_after IS DISTINCT FROM v_seq_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 5: the rep''s completion created an invoice or drew a number';
  END IF;
  IF (SELECT count(*) FROM public.activity_feed WHERE related_entity_id = v_delivery AND event_type = 'delivery_invoice_pending_admin') <> 1
     OR (SELECT count(*) FROM public.notifications WHERE related_entity_id = v_delivery AND notification_type = 'delivery_needs_invoice') <> v_admins THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 5: expected one pending-admin activity row and % admin notifications', v_admins;
  END IF;

  -- Step 6: a rep reads an admin's invoice and its lines through RLS. Step 7 builds the invoice.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_invoice := public.save_invoice(
    jsonb_build_object('customer_id', v_customer, 'invoice_type', 'misc_charge', 'status', 'draft', 'invoice_date', v_today, 'header_notes', '[E2E] reviewed'),
    jsonb_build_array(jsonb_build_object('description', '[E2E] fee', 'quantity', 1, 'unit_price_cents', 1500, 'extended_cents', 1500)),
    'e2e-ao-misc-' || v_suffix);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT (SELECT count(*) FROM public.invoices WHERE id = v_invoice) + (SELECT count(*) FROM public.invoice_items WHERE invoice_id = v_invoice) INTO v_count;
  EXECUTE 'RESET ROLE';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 6: a rep could not read an admin''s invoice and its line (saw % rows)', v_count;
  END IF;

  -- Step 6b: names only, for a customer the rep is not assigned that an admin's invoice names.
  INSERT INTO public.customers (farm_name, assigned_sales_rep, contact_name, phone, billing_address)
  VALUES ('[E2E] Other Rep Farm ' || v_suffix, NULL, '[E2E] Secret Contact', '555-0100', '1 Secret Rd')
  RETURNING id INTO v_other_customer;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  PERFORM public.save_invoice(
    jsonb_build_object('customer_id', v_other_customer, 'invoice_type', 'misc_charge', 'status', 'draft', 'invoice_date', v_today, 'header_notes', '[E2E] names'),
    jsonb_build_array(jsonb_build_object('description', '[E2E] fee', 'quantity', 1, 'unit_price_cents', 1500, 'extended_cents', 1500)),
    'e2e-ao-misc-names-' || v_suffix);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_count FROM public.customers WHERE id = v_other_customer;
  SELECT string_agg(to_jsonb(cn)::text, ',') INTO v_names FROM public.get_invoice_customer_names(ARRAY[v_other_customer]) cn;
  EXECUTE 'RESET ROLE';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 6b: a rep read a customer row that is not assigned to them directly';
  END IF;
  IF v_names IS DISTINCT FROM jsonb_build_object('id', v_other_customer, 'farm_name', '[E2E] Other Rep Farm ' || v_suffix)::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 6b: the names reader did not return exactly (id, farm_name) to a rep: %', v_names;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_count FROM public.get_invoice_customer_names(ARRAY[v_other_customer]);
  EXECUTE 'RESET ROLE';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 6b: the names reader returned names to a driver';
  END IF;

  -- Step 7: the posting version check.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_version := public.get_invoice_post_version(ARRAY[v_invoice]);
  PERFORM public.save_invoice(
    jsonb_build_object('id', v_invoice, 'customer_id', v_customer, 'invoice_type', 'misc_charge', 'status', 'draft', 'invoice_date', v_today, 'header_notes', '[E2E] changed after review'),
    jsonb_build_array(jsonb_build_object('description', '[E2E] fee', 'quantity', 1, 'unit_price_cents', 1500, 'extended_cents', 1500)),
    'e2e-ao-misc-edit-' || v_suffix);
  BEGIN
    PERFORM public.post_invoice(v_invoice, 'e2e-ao-post-stale-' || v_suffix, v_version);
    RAISE EXCEPTION 'SMOKE_FAIL: step 7: a post with a stale reviewed version went through';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'INVOICE_CHANGED_SINCE_REVIEW:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step 7: wrong stale-version refusal: %', v_err;
    END IF;
  END;
  PERFORM public.post_invoice(v_invoice, 'e2e-ao-post-' || v_suffix, public.get_invoice_post_version(ARRAY[v_invoice]));
  IF (SELECT status FROM public.invoices WHERE id = v_invoice) <> 'posted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 7: the post with the current version did not post';
  END IF;

  -- Step 8: the catalog sweep (the migration postflight's query, byte for byte: functions pinned by
  -- signature and body md5, so a changed upkeep body or a new overload is flagged too).
  WITH RECURSIVE fn AS (
    SELECT p.oid, p.proname, p.prosrc,
           regexp_replace(replace(p.prosrc, chr(13), ''), '/\*([^*]|\*+[^*/])*\*+/|--[^\n]*', '', 'g') AS body
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') AND p.prolang <> 13
  ), writer AS (
    SELECT oid FROM fn
     WHERE body ~* '\m(insert\s+into|update|delete\s+from|merge\s+into|truncate(\s+table)?)\s+(only\s+)?("?public"?\s*\.\s*)?"?(invoices|invoice_items|invoice_shares|invoice_line_shares|invoice_line_share_snapshots|invoice_line_allocations|field_app_locations|field_app_location_shares|field_app_billing_sets|field_app_billing_lines|write_offs)("|\M)'
        -- Dynamic SQL that names an invoice table anywhere (string literals included) counts as
        -- a write: the regex cannot see what EXECUTE runs (none on live, read 2026-10-10).
        OR (body ~* '\mexecute\M'
            AND body ~* '\m(invoices|invoice_items|invoice_shares|invoice_line_shares|invoice_line_share_snapshots|invoice_line_allocations|field_app_locations|field_app_location_shares|field_app_billing_sets|field_app_billing_lines|write_offs)\M')
  ), edge AS (
    SELECT a.oid AS caller, b.oid AS callee
      FROM fn a JOIN fn b ON a.oid <> b.oid AND a.body ~ ('\m' || b.proname || '\s*\(')
  ), reach AS (
    SELECT oid FROM writer
    UNION
    SELECT e.caller FROM edge e JOIN reach x ON x.oid = e.callee
  ), pinned AS (
    SELECT * FROM (VALUES
      ('void_invoice(uuid,text,text)', '2b1be1b706614f9a909581b0493d679f'),
      ('void_invoice_group(uuid,text,text)', 'fa19808b6ab6b0663663cd28c89a3326'),
      ('delete_invoices(uuid[],uuid,text)', '24c271164caa2369c57c3bdc5d88c50a'),
      ('create_invoice_for_unbilled_delivery(uuid,uuid,text)', 'a7f2531bd09ea6c650063f9661871caa'),
      ('generate_finance_charges(date,uuid,uuid[],text)', '56a397500167abf1b2801d22a31075dd'),
      ('issue_return_credit(uuid,uuid,text)', 'f3fcab7980d1640501fc038b0c8ac902'),
      ('unapply_credit_memo(uuid,text,uuid,text)', 'ba69e04e86dec86723d3ac9487f51272'),
      ('apply_write_off(uuid,bigint,text,uuid,text)', '00e8d020f9faf6276de8ddaf4f1411fc'),
      ('void_payment(uuid,text,uuid,text)', '70fd746c15f4a6629680a724f3588967'),
      ('apply_remaining_prepayments(uuid,uuid,text)', 'c0d7a2aef843ace0f557af2d096b090e'),
      ('batch_apply_prepayments(jsonb,uuid,text)', '15624992c9375e08a0ec1914437e6e40'),
      ('void_order(uuid,uuid,text,text)', 'bb220157f3cd56d28e9efe88dafba896'),
      ('cancel_order(uuid,uuid,text)', '501473a43b505df72bc803a7354b0e60'),
      ('void_delivery(uuid,text,uuid,text)', '3ef685c8f5bf778e3ae38aa2f89304da'),
      ('complete_delivery(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)', 'a1e9a043f27d3566f8ecf6d5e3a809ab'),
      ('process_offline_action(uuid,text)', '0461eebf65f23ccc8fe3852375eb9c78'),
      -- The upkeep allowlist (Mason-approved 2026-10-10, "1.a"): cancel_delivery,
      -- batch_cancel_deliveries, price_order, update_order_items and create_rush_order keep
      -- updating an admin's draft or unposted invoice; complete_delivery's resize and tote stamp
      -- is reached through its pinned entry above.
      ('cancel_delivery(uuid,text,uuid,text)', '8528b344f86c7e1aa735e386ea39f2eb'),
      ('batch_cancel_deliveries(uuid[],text,uuid,text)', '25d34db60f098a22a62db53780742eee'),
      ('price_order(uuid,jsonb,uuid,text)', 'ab2bcf3ac499cf78eef1f706d4e9501f'),
      ('update_order_items(uuid,jsonb,uuid,text)', 'e35fce6708edee32fb1876fa60d7da4b'),
      ('create_rush_order(uuid,jsonb,text,text,uuid,text)', '9027a97ab42a109f5e81188736f52f9c'),
      ('allocate_payment(uuid,bigint,text,text,text,date,text,jsonb,uuid,text)', '6a945a2510d8e788d4e6f03c0c6d7563'),
      ('complete_job(uuid,jsonb,uuid,text)', '9196da7ce6337bd0176a67b37be950f2'),
      ('create_quick_delivery(uuid,jsonb,uuid,date,text,uuid,text,boolean)', '1bf67e10cae538b5090b067aa3f665f5')
    ) AS t(sig, md5)
  )
  SELECT string_agg(f.oid::regprocedure::text, ', ' ORDER BY f.oid::regprocedure::text) INTO v_unclassified
    FROM fn f JOIN reach x ON x.oid = f.oid
   WHERE has_function_privilege('authenticated', f.oid, 'EXECUTE')
     -- A body with an exception handler can catch the guard's refusal and still write, so a
     -- guard first does not count there (review round 2).
     AND (f.body ~* '\mexception\s+when\M' OR (true
     AND f.prosrc !~ '^\s*(DECLARE(\s+(?![Bb][Ee][Gg][Ii][Nn]\M)\w+\s+[\w\[\]. %]+;)*\s+)?BEGIN\s+PERFORM public\._require_invoicing_admin\(\);'
     AND NOT (f.proname = 'create_split_invoices_from_order'
              AND f.prosrc ~ '^\s*BEGIN\s+IF p_idempotency_key IS NULL OR p_idempotency_key !~ ''\[\^\[:space:\]\]'' THEN\s+RAISE EXCEPTION ''IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order''\s+USING ERRCODE = ''22023'';\s+END IF;\s+PERFORM public\._require_invoicing_admin\(\);')))
     AND NOT EXISTS (SELECT 1 FROM pinned pn
                      WHERE to_regprocedure('public.' || pn.sig) = f.oid
                        AND md5(replace(f.prosrc, chr(13), '')) = pn.md5);
  IF v_unclassified IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: step 8: unguarded invoice writers reachable by authenticated: %', v_unclassified;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
