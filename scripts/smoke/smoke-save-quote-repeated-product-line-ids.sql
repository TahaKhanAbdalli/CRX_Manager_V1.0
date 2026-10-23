-- ============================================================================
-- ROLLED-BACK smoke: a quote with the same product on two lines (QUOTE_ITEM_AMBIGUOUS_COST)
-- ----------------------------------------------------------------------------
-- QuoteBuilder now sends each saved line's quote_items id plus a client_key on
-- every line, and installs the item_ids map save_quote returns. This chain sends
-- exactly that payload shape through the real save_quote, create_quote_version
-- and convert_quote_to_order, and proves each line keeps its own quote-time cost:
--   1. new quote, product P on two sections (one per field), cost 6.00
--   2. P repriced to 8.00
--   3. an id-less re-save (the old screen) is refused QUOTE_ITEM_AMBIGUOUS_COST
--   4. a re-save naming both lines plus a NEW third line of P succeeds:
--      the two saved lines keep 600 cents, the new line takes 800, ids are stable
--   5. a re-save naming all three lines (lines now at different costs) succeeds
--   6. Mark Presented (create_quote_version 'presented')
--   7. Convert: save as accepted, convert_quote_to_order; each order line carries
--      its own quote line's cost (6, 6, 8)
--   8. control: a quote without a repeated product, after its product is
--      repriced, re-saves with or without ids and keeps its quote-time cost, as before
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- quote, order and ledger row is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_customer_id uuid;
  v_product_id uuid;
  v_product_b uuid;
  v_quote_id uuid;
  v_ctrl_id uuid;
  v_version bigint;
  v_res jsonb;
  v_err text;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_line jsonb;
  v_payload jsonb;
  v_sections jsonb;
  v_ids jsonb;
  v_id1 text;
  v_id2 text;
  v_id3 text;
  v_costs text;
  v_order_id uuid;
  v_order_costs text;
  v_ctrl_cost bigint;

  -- Reprice through the governed pricing path so the quote-cost snapshot stays real.
  v_price_res jsonb;
BEGIN
  SELECT id INTO v_admin FROM profiles
  WHERE role = 'admin' AND is_active = true
  ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile found';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO customers (farm_name)
  VALUES ('[SMOKE] Repeated Product Farm ' || v_suffix)
  RETURNING id INTO v_customer_id;

  INSERT INTO products (product_name, unit_size)
  VALUES ('[SMOKE] Repeated Product ' || v_suffix, 'gal')
  RETURNING id INTO v_product_id;
  INSERT INTO products (product_name, unit_size)
  VALUES ('[SMOKE] Control Product ' || v_suffix, 'gal')
  RETURNING id INTO v_product_b;

  v_price_res := preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(
      jsonb_build_object(
        'product_id', v_product_id,
        'row_version', (SELECT pricing_version FROM products WHERE id = v_product_id),
        'pricing_mode', 'margin_driven', 'new_cost', '6.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke repeated-product fixture setup'),
      jsonb_build_object(
        'product_id', v_product_b,
        'row_version', (SELECT pricing_version FROM products WHERE id = v_product_b),
        'pricing_mode', 'margin_driven', 'new_cost', '6.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke repeated-product fixture setup')),
    v_admin, 'smk-sqrp-price-preview-1-' || v_suffix);
  PERFORM apply_product_pricing_change_set(
    (v_price_res->>'change_set_id')::uuid, v_price_res->>'request_fingerprint',
    v_admin, 'smk-sqrp-price-apply-1-' || v_suffix);

  v_line := jsonb_build_object(
    'product_id', v_product_id, 'sort_order', 0, 'notes', null,
    'calc_mode', 'units_direct', 'total_units_needed', 10,
    'price_override', 20, 'price_per_unit', 20, 'current_cost', 6,
    'unit_size', 'gal', 'acres', 0);

  -- --------------------------------------------------------------------
  -- 1. New quote: product P on two sections (two fields)
  -- --------------------------------------------------------------------
  v_payload := jsonb_build_object(
    'quote_number', '[SMOKE] QRP-' || v_suffix,
    'customer_id', v_customer_id, 'status', 'draft', 'tier', 1,
    'commission_split', '{"splits": []}'::jsonb);
  v_sections := jsonb_build_array(
    jsonb_build_object('section_name', 'North field', 'sort_order', 0,
      'items', jsonb_build_array(v_line || jsonb_build_object('id', null, 'client_key', '_k1'))),
    jsonb_build_object('section_name', 'South field', 'sort_order', 1,
      'items', jsonb_build_array(v_line || jsonb_build_object('id', null, 'client_key', '_k2', 'total_units_needed', 20))));
  v_res := save_quote(NULL, v_payload, v_sections, v_admin, 'smk-sqrp-save-1-' || v_suffix);
  v_quote_id := (v_res->>'quote_id')::uuid;
  v_version := (v_res->>'row_version')::bigint;
  v_ids := v_res->'item_ids';
  v_id1 := v_ids->>'_k1';
  v_id2 := v_ids->>'_k2';
  IF v_quote_id IS NULL OR v_id1 IS NULL OR v_id2 IS NULL OR v_id1 = v_id2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) create did not return two line ids: %', v_res;
  END IF;
  IF (SELECT array_agg(cost_at_quote_cents ORDER BY total_units_needed) FROM quote_items WHERE quote_id = v_quote_id)
     IS DISTINCT FROM ARRAY[600, 600]::bigint[] THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (1) expected both lines at 600 cents';
  END IF;

  -- --------------------------------------------------------------------
  -- 2. Reprice P to 8.00
  -- --------------------------------------------------------------------
  v_price_res := preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id,
      'row_version', (SELECT pricing_version FROM products WHERE id = v_product_id),
      'pricing_mode', 'margin_driven', 'new_cost', '8.00',
      'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
      'change_reason', 'Rollback smoke repeated-product reprice')),
    v_admin, 'smk-sqrp-price-preview-2-' || v_suffix);
  PERFORM apply_product_pricing_change_set(
    (v_price_res->>'change_set_id')::uuid, v_price_res->>'request_fingerprint',
    v_admin, 'smk-sqrp-price-apply-2-' || v_suffix);

  v_payload := v_payload || jsonb_build_object('row_version_expected', v_version);

  -- --------------------------------------------------------------------
  -- 3. The old screen: same edit, no ids -> refused
  -- --------------------------------------------------------------------
  BEGIN
    PERFORM save_quote(v_quote_id, v_payload, jsonb_build_array(
      jsonb_build_object('section_name', 'North field', 'sort_order', 0,
        'items', jsonb_build_array(v_line || jsonb_build_object('total_units_needed', 12))),
      jsonb_build_object('section_name', 'South field', 'sort_order', 1,
        'items', jsonb_build_array(v_line || jsonb_build_object('total_units_needed', 20)))),
      v_admin, 'smk-sqrp-save-old-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: (3) id-less re-save of a repeated product was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_ITEM_AMBIGUOUS_COST%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (3) expected QUOTE_ITEM_AMBIGUOUS_COST, got: %', v_err;
    END IF;
  END;

  -- --------------------------------------------------------------------
  -- 4. The fixed screen: name both lines, edit one, add a new line of P
  -- --------------------------------------------------------------------
  v_sections := jsonb_build_array(
    jsonb_build_object('section_name', 'North field', 'sort_order', 0,
      'items', jsonb_build_array(v_line || jsonb_build_object('id', v_id1, 'client_key', '_k1', 'total_units_needed', 12))),
    jsonb_build_object('section_name', 'South field', 'sort_order', 1,
      'items', jsonb_build_array(
        v_line || jsonb_build_object('id', v_id2, 'client_key', '_k2', 'total_units_needed', 20),
        v_line || jsonb_build_object('id', null, 'client_key', '_k3', 'total_units_needed', 5, 'sort_order', 1))));
  v_res := save_quote(v_quote_id, v_payload, v_sections, v_admin, 'smk-sqrp-save-2-' || v_suffix);
  v_version := (v_res->>'row_version')::bigint;
  v_ids := v_res->'item_ids';
  v_id3 := v_ids->>'_k3';
  IF v_ids->>'_k1' IS DISTINCT FROM v_id1 OR v_ids->>'_k2' IS DISTINCT FROM v_id2 OR v_id3 IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (4) line ids not stable / new id missing: %', v_ids;
  END IF;
  SELECT string_agg(trim_scale(total_units_needed)::text || '@' || cost_at_quote_cents::text, ',' ORDER BY total_units_needed)
    INTO v_costs FROM quote_items WHERE quote_id = v_quote_id;
  IF v_costs IS DISTINCT FROM '5@800,12@600,20@600' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (4) expected 5@800,12@600,20@600, got %', v_costs;
  END IF;

  -- --------------------------------------------------------------------
  -- 5. Re-save naming all three lines (now at different costs)
  -- --------------------------------------------------------------------
  v_sections := jsonb_set(v_sections, '{1,items,1,id}', to_jsonb(v_id3));
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_version);
  v_res := save_quote(v_quote_id, v_payload, v_sections, v_admin, 'smk-sqrp-save-3-' || v_suffix);
  v_version := (v_res->>'row_version')::bigint;
  SELECT string_agg(trim_scale(total_units_needed)::text || '@' || cost_at_quote_cents::text, ',' ORDER BY total_units_needed)
    INTO v_costs FROM quote_items WHERE quote_id = v_quote_id;
  IF v_costs IS DISTINCT FROM '5@800,12@600,20@600' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (5) expected 5@800,12@600,20@600, got %', v_costs;
  END IF;

  -- --------------------------------------------------------------------
  -- 6. Mark Presented: the screen saves first, then records the version
  -- --------------------------------------------------------------------
  v_payload := v_payload || jsonb_build_object('row_version_expected', v_version);
  v_res := save_quote(v_quote_id, v_payload, v_sections, v_admin, 'smk-sqrp-save-4-' || v_suffix);
  v_version := (v_res->>'row_version')::bigint;
  v_res := create_quote_version(v_quote_id, v_admin, 'presented', 'smk-sqrp-present-' || v_suffix, v_version);
  IF (SELECT status FROM quotes WHERE id = v_quote_id) IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (6) presented quote is not sent: %', v_res;
  END IF;
  SELECT row_version INTO v_version FROM quotes WHERE id = v_quote_id;

  -- --------------------------------------------------------------------
  -- 7. Convert: save as accepted, then convert_quote_to_order
  -- --------------------------------------------------------------------
  v_payload := v_payload || jsonb_build_object('status', 'accepted', 'row_version_expected', v_version);
  v_res := save_quote(v_quote_id, v_payload, v_sections, v_admin, 'smk-sqrp-save-5-' || v_suffix);
  v_version := (v_res->>'row_version')::bigint;
  SELECT string_agg(trim_scale(total_units_needed)::text || '@' || cost_at_quote_cents::text, ',' ORDER BY total_units_needed)
    INTO v_costs FROM quote_items WHERE quote_id = v_quote_id;
  IF v_costs IS DISTINCT FROM '5@800,12@600,20@600' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (7) accepted save changed costs: %', v_costs;
  END IF;
  v_res := convert_quote_to_order(v_quote_id, v_admin, 'smk-sqrp-convert-' || v_suffix, v_version, NULL);
  v_order_id := (v_res->>'order_id')::uuid;
  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (7) convert returned no order: %', v_res;
  END IF;
  SELECT string_agg(trim_scale(total_units_needed)::text || '@' || trim_scale(cost_per_unit)::text, ',' ORDER BY total_units_needed)
    INTO v_order_costs FROM order_items WHERE order_id = v_order_id;
  IF v_order_costs IS NULL
     OR v_order_costs IS DISTINCT FROM '5@8,12@6,20@6' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (7) order lines did not keep each quote line''s cost: %', v_order_costs;
  END IF;

  -- --------------------------------------------------------------------
  -- 8. Control: no repeated product -> re-saves exactly as before
  -- --------------------------------------------------------------------
  v_line := v_line || jsonb_build_object('product_id', v_product_b);
  v_res := save_quote(NULL,
    jsonb_build_object('quote_number', '[SMOKE] QRPC-' || v_suffix, 'customer_id', v_customer_id,
      'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb),
    jsonb_build_array(jsonb_build_object('section_name', 'Only field', 'sort_order', 0,
      'items', jsonb_build_array(v_line))),
    v_admin, 'smk-sqrp-ctrl-1-' || v_suffix);
  v_ctrl_id := (v_res->>'quote_id')::uuid;
  v_version := (v_res->>'row_version')::bigint;
  -- Reprice the control product so a re-save that re-stamped today's cost would show.
  v_price_res := preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product_b,
      'row_version', (SELECT pricing_version FROM products WHERE id = v_product_b),
      'pricing_mode', 'margin_driven', 'new_cost', '9.00',
      'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
      'change_reason', 'Rollback smoke repeated-product control reprice')),
    v_admin, 'smk-sqrp-price-preview-3-' || v_suffix);
  PERFORM apply_product_pricing_change_set(
    (v_price_res->>'change_set_id')::uuid, v_price_res->>'request_fingerprint',
    v_admin, 'smk-sqrp-price-apply-3-' || v_suffix);
  -- id-less re-save (old screen) still works and keeps the quote-time cost
  v_res := save_quote(v_ctrl_id,
    jsonb_build_object('quote_number', '[SMOKE] QRPC-' || v_suffix, 'customer_id', v_customer_id,
      'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_version),
    jsonb_build_array(jsonb_build_object('section_name', 'Only field', 'sort_order', 0,
      'items', jsonb_build_array(v_line || jsonb_build_object('total_units_needed', 15)))),
    v_admin, 'smk-sqrp-ctrl-2-' || v_suffix);
  v_version := (v_res->>'row_version')::bigint;
  SELECT cost_at_quote_cents INTO v_ctrl_cost FROM quote_items WHERE quote_id = v_ctrl_id AND total_units_needed = 15;
  IF v_ctrl_cost IS DISTINCT FROM 600 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (8) control quote cost changed on the id-less re-save: %', v_ctrl_cost;
  END IF;
  -- id-bearing re-save (new screen) works too and keeps it
  v_res := save_quote(v_ctrl_id,
    jsonb_build_object('quote_number', '[SMOKE] QRPC-' || v_suffix, 'customer_id', v_customer_id,
      'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_version),
    jsonb_build_array(jsonb_build_object('section_name', 'Only field', 'sort_order', 0,
      'items', jsonb_build_array(v_line || jsonb_build_object('total_units_needed', 16,
        'id', (SELECT id FROM quote_items WHERE quote_id = v_ctrl_id), 'client_key', '_c1')))),
    v_admin, 'smk-sqrp-ctrl-3-' || v_suffix);
  SELECT cost_at_quote_cents INTO v_ctrl_cost FROM quote_items WHERE quote_id = v_ctrl_id AND total_units_needed = 16;
  IF v_ctrl_cost IS DISTINCT FROM 600 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (8) control quote cost changed on the id-bearing re-save: %', v_ctrl_cost;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK quote lines %; order lines %; control cost %', v_costs, v_order_costs, v_ctrl_cost;
END
$smoke$;
