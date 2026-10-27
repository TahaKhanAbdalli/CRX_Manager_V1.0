-- ============================================================================
-- ROLLED-BACK smoke: Convert to Order straight from a sent quote (KI-12, To-Do 1.3)
-- ----------------------------------------------------------------------------
-- QuoteBuilder no longer saves a quote as 'accepted' before converting it; it calls
-- convert_quote_to_order on the sent quote, which marks it accepted in the same
-- transaction as the order. This chain sends exactly that through the real RPCs:
--   1. product P at cost 6.00 (tier 1 = 7.50); a draft quote of P, no manual price
--   2. Mark Presented (create_quote_version) -> sent at 7.50
--   3. P repriced to cost 7.00 (tier 1 = 8.75)
--   4. Convert straight from 'sent': one order, quote accepted, the order line at the
--      sent 7.50 (no save ran, so nothing re-priced it)
--   5. the old screen path, save as 'accepted' first, no longer re-prices either: since
--      20261027040000 a sent quote keeps its line prices on every save (it re-priced to 8.75 before)
--   6. P repriced to cost 8.00, above the sent 7.50: Convert of a third sent quote is
--      refused without a reason (BELOW_COST_REASON_REQUIRED), then converts with an
--      admin's reason, keeps 7.50 and records the below-cost approval
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
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_line jsonb;
  v_sections jsonb;
  v_res jsonb;
  v_err text;
  v_quote_a uuid;
  v_quote_b uuid;
  v_quote_c uuid;
  v_version bigint;
  v_order_id uuid;
  v_order_price numeric;
  v_contrast_price numeric;
  v_below_price numeric;
  v_approvals int;
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
  VALUES ('[SMOKE] One-step Convert Farm ' || v_suffix)
  RETURNING id INTO v_customer_id;
  INSERT INTO products (product_name, unit_size)
  VALUES ('[SMOKE] One-step Convert Product ' || v_suffix, 'gal')
  RETURNING id INTO v_product_id;

  -- --------------------------------------------------------------------
  -- 1. P at cost 6.00, tier 1 margin 20% -> 7.50
  -- --------------------------------------------------------------------
  v_price_res := preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id,
      'row_version', (SELECT pricing_version FROM products WHERE id = v_product_id),
      'pricing_mode', 'margin_driven', 'new_cost', '6.00',
      'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
      'change_reason', 'Rollback smoke one-step convert fixture setup')),
    v_admin, 'smk-c1s-price-preview-1-' || v_suffix);
  PERFORM apply_product_pricing_change_set(
    (v_price_res->>'change_set_id')::uuid, v_price_res->>'request_fingerprint',
    v_admin, 'smk-c1s-price-apply-1-' || v_suffix);
  IF (SELECT tier1_price FROM products WHERE id = v_product_id) IS DISTINCT FROM 7.50 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: expected tier 1 at 7.50, got %',
      (SELECT tier1_price FROM products WHERE id = v_product_id);
  END IF;

  v_line := jsonb_build_object(
    'id', null, 'client_key', '_k1',
    'product_id', v_product_id, 'sort_order', 0, 'notes', null,
    'calc_mode', 'units_direct', 'total_units_needed', 10,
    'price_override', null, 'price_per_unit', 7.5, 'current_cost', 6,
    'unit_size', 'gal', 'acres', 0);
  v_sections := jsonb_build_array(jsonb_build_object(
    'section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(v_line)));

  -- --------------------------------------------------------------------
  -- 2. Three draft quotes of P, each presented (sent) at 7.50
  -- --------------------------------------------------------------------
  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] C1S-A-' || v_suffix, 'customer_id', v_customer_id,
      'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb),
    v_sections, v_admin, 'smk-c1s-save-a-' || v_suffix);
  v_quote_a := (v_res->>'quote_id')::uuid;
  PERFORM create_quote_version(v_quote_a, v_admin, 'presented', 'smk-c1s-present-a-' || v_suffix,
    (v_res->>'row_version')::bigint);

  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] C1S-B-' || v_suffix, 'customer_id', v_customer_id,
      'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb),
    v_sections, v_admin, 'smk-c1s-save-b-' || v_suffix);
  v_quote_b := (v_res->>'quote_id')::uuid;
  PERFORM create_quote_version(v_quote_b, v_admin, 'presented', 'smk-c1s-present-b-' || v_suffix,
    (v_res->>'row_version')::bigint);

  v_res := save_quote(NULL, jsonb_build_object(
      'quote_number', '[SMOKE] C1S-C-' || v_suffix, 'customer_id', v_customer_id,
      'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb),
    v_sections, v_admin, 'smk-c1s-save-c-' || v_suffix);
  v_quote_c := (v_res->>'quote_id')::uuid;
  PERFORM create_quote_version(v_quote_c, v_admin, 'presented', 'smk-c1s-present-c-' || v_suffix,
    (v_res->>'row_version')::bigint);

  IF (SELECT count(*) FROM quotes WHERE id IN (v_quote_a, v_quote_b, v_quote_c) AND status = 'sent') <> 3
     OR (SELECT count(*) FROM quote_items WHERE quote_id IN (v_quote_a, v_quote_b, v_quote_c) AND price_per_unit = 7.50) <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (2) expected three sent quotes priced at 7.50';
  END IF;

  -- --------------------------------------------------------------------
  -- 3. P repriced to cost 7.00 -> tier 1 8.75
  -- --------------------------------------------------------------------
  v_price_res := preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id,
      'row_version', (SELECT pricing_version FROM products WHERE id = v_product_id),
      'pricing_mode', 'margin_driven', 'new_cost', '7.00',
      'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
      'change_reason', 'Rollback smoke one-step convert reprice')),
    v_admin, 'smk-c1s-price-preview-2-' || v_suffix);
  PERFORM apply_product_pricing_change_set(
    (v_price_res->>'change_set_id')::uuid, v_price_res->>'request_fingerprint',
    v_admin, 'smk-c1s-price-apply-2-' || v_suffix);

  -- --------------------------------------------------------------------
  -- 4. The new screen path: Convert straight from 'sent'
  -- --------------------------------------------------------------------
  SELECT row_version INTO v_version FROM quotes WHERE id = v_quote_a;
  v_res := convert_quote_to_order(v_quote_a, v_admin, 'smk-c1s-convert-a-' || v_suffix, v_version, NULL);
  v_order_id := (v_res->>'order_id')::uuid;
  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (4) convert from sent returned no order: %', v_res;
  END IF;
  IF (SELECT status FROM quotes WHERE id = v_quote_a) IS DISTINCT FROM 'accepted' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (4) the converted quote is not accepted';
  END IF;
  IF (SELECT count(*) FROM orders WHERE quote_id = v_quote_a AND deleted_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (4) expected exactly one order for the converted quote';
  END IF;
  SELECT price_per_unit INTO v_order_price FROM order_items WHERE order_id = v_order_id;
  IF v_order_price IS DISTINCT FROM 7.50 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (4) order line not at the sent 7.50: %', v_order_price;
  END IF;

  -- --------------------------------------------------------------------
  -- 5. The old screen path, save as accepted first, keeps the sent price too (the lock)
  -- --------------------------------------------------------------------
  SELECT row_version INTO v_version FROM quotes WHERE id = v_quote_b;
  v_res := save_quote(v_quote_b, jsonb_build_object(
      'quote_number', '[SMOKE] C1S-B-' || v_suffix, 'customer_id', v_customer_id,
      'status', 'accepted', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb,
      'row_version_expected', v_version),
    jsonb_set(v_sections, '{0,items,0,id}',
      to_jsonb((SELECT id FROM quote_items WHERE quote_id = v_quote_b)::text)),
    v_admin, 'smk-c1s-save-b-accept-' || v_suffix);
  SELECT price_per_unit INTO v_contrast_price FROM quote_items WHERE quote_id = v_quote_b;
  IF v_contrast_price IS DISTINCT FROM 7.50 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (5) an accepted save re-priced the sent quote to %', v_contrast_price;
  END IF;

  -- --------------------------------------------------------------------
  -- 6. Cost above the sent price: Convert needs an admin's reason
  -- --------------------------------------------------------------------
  v_price_res := preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id,
      'row_version', (SELECT pricing_version FROM products WHERE id = v_product_id),
      'pricing_mode', 'margin_driven', 'new_cost', '8.00',
      'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
      'change_reason', 'Rollback smoke one-step convert cost rise')),
    v_admin, 'smk-c1s-price-preview-3-' || v_suffix);
  PERFORM apply_product_pricing_change_set(
    (v_price_res->>'change_set_id')::uuid, v_price_res->>'request_fingerprint',
    v_admin, 'smk-c1s-price-apply-3-' || v_suffix);

  SELECT row_version INTO v_version FROM quotes WHERE id = v_quote_c;
  BEGIN
    PERFORM convert_quote_to_order(v_quote_c, v_admin, 'smk-c1s-convert-c1-' || v_suffix, v_version, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (6) below-cost convert without a reason was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE '%BELOW_COST_REASON_REQUIRED%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (6) expected BELOW_COST_REASON_REQUIRED, got: %', v_err;
    END IF;
  END;
  IF (SELECT status FROM quotes WHERE id = v_quote_c) IS DISTINCT FROM 'sent' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (6) the refused convert changed the quote status';
  END IF;

  v_res := convert_quote_to_order(v_quote_c, v_admin, 'smk-c1s-convert-c2-' || v_suffix, v_version,
    'Rollback smoke: honor the sent price');
  v_order_id := (v_res->>'order_id')::uuid;
  SELECT price_per_unit INTO v_below_price FROM order_items WHERE order_id = v_order_id;
  IF v_below_price IS DISTINCT FROM 7.50 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (6) approved below-cost order line not at the sent 7.50: %', v_below_price;
  END IF;
  SELECT count(*) INTO v_approvals FROM below_cost_approvals
  WHERE operation = 'convert_quote_to_order' AND product_id = v_product_id
    AND actor_user_id = v_admin AND unit_price_cents = 750 AND locked_unit_cost_cents = 800
    AND reason = 'Rollback smoke: honor the sent price';
  IF v_approvals < 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (6) no below-cost approval was recorded';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK one-step convert kept %; accepted save kept %; below-cost convert kept % with % approval row(s)',
    v_order_price, v_contrast_price, v_below_price, v_approvals;
END
$smoke$;
