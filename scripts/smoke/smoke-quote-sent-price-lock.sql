-- ============================================================================
-- ROLLED-BACK smoke: a sent quote keeps the prices the customer saw (To-Do 1.2)
-- ----------------------------------------------------------------------------
-- Migration 20261027040000_quote_sent_price_lock. Products P and Q at cost 6.00 (tier 1 7.50).
-- Quotes are presented (sent, V1) at 7.50, then P is repriced to cost 7.00 (tier 1 8.75):
--   A  quantity-only revision keeps 7.50 and the expiry (the save reply reports the stored price);
--      Convert bills 7.50 (no re-send)
--   K  a same-status save of a sent quote (Mark Presented again) keeps 7.50; V2 records 7.50
--   B  "use today's price" on the line -> 8.75; Convert, Partial Order and an accepted save are
--      refused QUOTE_RESEND_REQUIRED; after the re-send (V2, new expiry) Convert bills 8.75
--   C  a manual price 9.00 is refused; rewind to V1 restores the same line id at 7.50 and
--      Convert bills 7.50
--   D  a line added in the revision, E a changed customer: Convert refused; rewinding E to V1
--      restores its customer and it converts at 7.50
--   N  a line saved without its id takes today's price (cost kept) and Convert is refused
--   O  a quote reopened after its order was cancelled is checked again: a manual price is refused
--   M  an unchanged sent booking draws down at 7.50
--   G  a planned booking revised with today's price cannot schedule a job; F a planned draft
--      never sent still schedules at its own price (Mason, 2026-10-14)
--   H  a version without line ids (written before this migration) pairs by product: an unchanged
--      quote converts; I the same with a repeated product is refused
--   J  a last version from before the protected send workflow is refused
--   L  control: a draft never sent still re-prices to the catalog (8.75) on save
--
-- HOW TO RUN: execute this whole file as ONE statement (Supabase MCP execute_sql).
-- It ALWAYS ends with RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK ...', so every fixture,
-- quote, order and ledger row is rolled back. Any other error text is a failure.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_c1 uuid;
  v_c2 uuid;
  v_p uuid;
  v_q uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_line jsonb;
  v_sections jsonb;
  v_two_sections jsonb;
  v_payload jsonb;
  v_res jsonb;
  v_err text;
  v_price_res jsonb;
  v_quotes jsonb := '{}'::jsonb;   -- letter -> quote id
  v_lines jsonb := '{}'::jsonb;    -- letter -> its first line id
  v_versions jsonb := '{}'::jsonb; -- letter -> V1 id
  v_letter text;
  v_id uuid;
  v_line_id text;
  v_rv bigint;
  v_order_id uuid;
  v_price numeric;
  v_expiry date;
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_snapshot jsonb;
  v_section_id uuid;
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

  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Price Lock Farm ' || v_suffix) RETURNING id INTO v_c1;
  INSERT INTO customers (farm_name) VALUES ('[SMOKE] Price Lock Other Farm ' || v_suffix) RETURNING id INTO v_c2;
  INSERT INTO products (product_name, unit_size) VALUES ('[SMOKE] Lock P ' || v_suffix, 'gal') RETURNING id INTO v_p;
  INSERT INTO products (product_name, unit_size) VALUES ('[SMOKE] Lock Q ' || v_suffix, 'gal') RETURNING id INTO v_q;
  v_price_res := preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(
      jsonb_build_object('product_id', v_p, 'row_version', (SELECT pricing_version FROM products WHERE id = v_p),
        'pricing_mode', 'margin_driven', 'new_cost', '6.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke price lock fixture setup'),
      jsonb_build_object('product_id', v_q, 'row_version', (SELECT pricing_version FROM products WHERE id = v_q),
        'pricing_mode', 'margin_driven', 'new_cost', '6.00',
        'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
        'change_reason', 'Rollback smoke price lock fixture setup')),
    v_admin, 'smk-lock-price-preview-1-' || v_suffix);
  PERFORM apply_product_pricing_change_set((v_price_res->>'change_set_id')::uuid,
    v_price_res->>'request_fingerprint', v_admin, 'smk-lock-price-apply-1-' || v_suffix);

  v_line := jsonb_build_object('id', null, 'client_key', '_k1', 'product_id', v_p, 'sort_order', 0,
    'notes', null, 'calc_mode', 'units_direct', 'total_units_needed', 10, 'price_override', null,
    'price_per_unit', 7.5, 'current_cost', 6, 'unit_size', 'gal', 'acres', 0);
  v_sections := jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0,
    'items', jsonb_build_array(v_line)));
  v_two_sections := jsonb_build_array(
    jsonb_build_object('section_name', 'North', 'sort_order', 0, 'items', jsonb_build_array(v_line)),
    jsonb_build_object('section_name', 'South', 'sort_order', 1,
      'items', jsonb_build_array(v_line || jsonb_build_object('client_key', '_k2'))));

  -- --------------------------------------------------------------------
  -- Every quote saved and presented (V1) at 7.50; F and L stay drafts; F, G planned.
  -- --------------------------------------------------------------------
  FOREACH v_letter IN ARRAY ARRAY['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O']
  LOOP
    v_res := save_quote(NULL, jsonb_build_object(
        'quote_number', '[SMOKE] LOCK-' || v_letter || '-' || v_suffix, 'customer_id', v_c1,
        'status', 'draft', 'tier', 1, 'commission_split', '{"splits": []}'::jsonb,
        'is_planned', v_letter IN ('F', 'G')),
      CASE WHEN v_letter = 'I' THEN v_two_sections ELSE v_sections END,
      v_admin, 'smk-lock-save-' || v_letter || '-' || v_suffix);
    v_id := (v_res->>'quote_id')::uuid;
    v_quotes := v_quotes || jsonb_build_object(v_letter, v_id);
    v_lines := v_lines || jsonb_build_object(v_letter, v_res->'item_ids'->>'_k1');
    IF v_letter NOT IN ('F', 'L') THEN
      v_res := create_quote_version(v_id, v_admin, 'presented', 'smk-lock-v1-' || v_letter || '-' || v_suffix,
        (v_res->>'row_version')::bigint);
      v_versions := v_versions || jsonb_build_object(v_letter, v_res->>'version_id');
    END IF;
  END LOOP;

  -- V1 records each line's id and manual price; the send set the expiry.
  SELECT snapshot_data INTO v_snapshot FROM quote_versions WHERE id = (v_versions->>'A')::uuid;
  IF v_snapshot->'sections'->0->'items'->0->>'quote_item_id' IS DISTINCT FROM v_lines->>'A'
     OR NOT (v_snapshot->'sections'->0->'items'->0 ? 'price_override') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (V1) snapshot lacks the line id or manual price: %', v_snapshot->'sections'->0->'items'->0;
  END IF;
  IF (SELECT expires_at FROM quotes WHERE id = (v_quotes->>'A')::uuid) IS DISTINCT FROM v_today + 15 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (V1) the send did not set expires_at to today + 15: %',
      (SELECT expires_at FROM quotes WHERE id = (v_quotes->>'A')::uuid);
  END IF;

  -- --------------------------------------------------------------------
  -- P repriced to cost 7.00 -> tier 1 8.75
  -- --------------------------------------------------------------------
  v_price_res := preview_product_pricing_changes('product_page', NULL,
    jsonb_build_array(jsonb_build_object('product_id', v_p,
      'row_version', (SELECT pricing_version FROM products WHERE id = v_p),
      'pricing_mode', 'margin_driven', 'new_cost', '7.00',
      'tier1_margin_percent', '20', 'tier2_margin_percent', '25', 'tier3_margin_percent', '30',
      'change_reason', 'Rollback smoke price lock reprice')),
    v_admin, 'smk-lock-price-preview-2-' || v_suffix);
  PERFORM apply_product_pricing_change_set((v_price_res->>'change_set_id')::uuid,
    v_price_res->>'request_fingerprint', v_admin, 'smk-lock-price-apply-2-' || v_suffix);

  -- --------------------------------------------------------------------
  -- A: quantity-only revision keeps 7.50 and the expiry; Convert bills 7.50
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'A')::uuid;
  UPDATE quotes SET expires_at = v_today + 3 WHERE id = v_id;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] LOCK-A-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv,
      'expires_at', (v_today + 60)::text),
    jsonb_set(jsonb_set(v_sections, '{0,items,0,id}', to_jsonb(v_lines->>'A')),
      '{0,items,0,total_units_needed}', '12'::jsonb),
    v_admin, 'smk-lock-save-A2-' || v_suffix);
  -- The reply reports the stored price per line, so the screen holds what the database holds.
  IF (v_res->'item_prices'->>'_k1')::numeric IS DISTINCT FROM 7.50 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (A) save reply did not report the stored price: %', v_res->'item_prices';
  END IF;
  SELECT price_per_unit INTO v_price FROM quote_items WHERE quote_id = v_id;
  SELECT expires_at INTO v_expiry FROM quotes WHERE id = v_id;
  IF v_price IS DISTINCT FROM 7.50 OR v_expiry IS DISTINCT FROM v_today + 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (A) revision re-priced to % or moved the expiry to %', v_price, v_expiry;
  END IF;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-A-' || v_suffix, v_rv, NULL);
  SELECT price_per_unit INTO v_price FROM order_items WHERE order_id = (v_res->>'order_id')::uuid;
  IF v_price IS DISTINCT FROM 7.50 OR (SELECT total_units_needed FROM order_items WHERE order_id = (v_res->>'order_id')::uuid) <> 12 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (A) quantity-only revision did not convert at 7.50 x 12: %', v_res;
  END IF;

  -- --------------------------------------------------------------------
  -- K: a same-status save of a sent quote keeps 7.50; V2 records 7.50
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'K')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] LOCK-K-' || v_suffix, 'customer_id', v_c1, 'status', 'sent', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_set(v_sections, '{0,items,0,id}', to_jsonb(v_lines->>'K')),
    v_admin, 'smk-lock-save-K2-' || v_suffix);
  v_res := create_quote_version(v_id, v_admin, 'presented', 'smk-lock-v2-K-' || v_suffix, (v_res->>'row_version')::bigint);
  SELECT snapshot_data INTO v_snapshot FROM quote_versions WHERE id = (v_res->>'version_id')::uuid;
  IF (v_snapshot->'sections'->0->'items'->0->>'price_per_unit')::numeric IS DISTINCT FROM 7.50 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (K) re-presenting re-priced the quote: %', v_snapshot->'sections'->0->'items'->0;
  END IF;

  -- --------------------------------------------------------------------
  -- B: "today's price" -> 8.75 needs a re-send before Convert, Partial Order or accepting
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'B')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] LOCK-B-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_set(jsonb_set(v_sections, '{0,items,0,id}', to_jsonb(v_lines->>'B')),
      '{0,items,0,use_todays_price}', 'true'::jsonb),
    v_admin, 'smk-lock-save-B2-' || v_suffix);
  SELECT price_per_unit INTO v_price FROM quote_items WHERE quote_id = v_id;
  IF v_price IS DISTINCT FROM 8.75 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (B) use_todays_price did not take 8.75: %', v_price;
  END IF;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    PERFORM convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-B1-' || v_suffix, v_rv, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (B) Convert of an un-re-sent price change was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (B) convert: %', v_err; END IF;
  END;
  BEGIN
    PERFORM draw_down_quote(v_id, jsonb_build_array(jsonb_build_object('product_id', v_p, 'quantity', 1)),
      v_admin, 'smk-lock-draw-B-' || v_suffix, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (B) Partial Order of an un-re-sent price change was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (B) draw: %', v_err; END IF;
  END;
  BEGIN
    PERFORM save_quote(v_id, jsonb_build_object(
        'quote_number', '[SMOKE] LOCK-B-' || v_suffix, 'customer_id', v_c1, 'status', 'accepted', 'tier', 1,
        'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
      jsonb_set(v_sections, '{0,items,0,id}', to_jsonb(v_lines->>'B')),
      v_admin, 'smk-lock-save-B3-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: (B) accepting an un-re-sent price change was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (B) accept: %', v_err; END IF;
  END;
  UPDATE quotes SET expires_at = v_today + 3 WHERE id = v_id;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := create_quote_version(v_id, v_admin, 'emailed', 'smk-lock-v2-B-' || v_suffix, v_rv);
  IF (SELECT expires_at FROM quotes WHERE id = v_id) IS DISTINCT FROM v_today + 15 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (B) the re-send did not set a new expiry';
  END IF;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-B2-' || v_suffix, v_rv, NULL);
  SELECT price_per_unit INTO v_price FROM order_items WHERE order_id = (v_res->>'order_id')::uuid;
  IF v_price IS DISTINCT FROM 8.75 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (B) re-sent quote did not convert at 8.75: %', v_price;
  END IF;

  -- --------------------------------------------------------------------
  -- C: a manual price is refused; rewind to V1 keeps the line id and converts at 7.50
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'C')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] LOCK-C-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_set(jsonb_set(v_sections, '{0,items,0,id}', to_jsonb(v_lines->>'C')),
      '{0,items,0,price_override}', '9'::jsonb),
    v_admin, 'smk-lock-save-C2-' || v_suffix);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    PERFORM convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-C1-' || v_suffix, v_rv, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (C) Convert of a manual price change was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (C) convert: %', v_err; END IF;
  END;
  PERFORM restore_quote_version(v_id, (v_versions->>'C')::uuid, v_admin, 'smk-lock-rewind-C-' || v_suffix, v_rv, NULL);
  IF (SELECT count(*) FROM quote_items WHERE quote_id = v_id) <> 1
     OR NOT EXISTS (SELECT 1 FROM quote_items WHERE quote_id = v_id AND id = (v_lines->>'C')::uuid
                     AND price_per_unit = 7.50 AND price_override IS NULL) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C) rewind did not restore the sent line: %',
      (SELECT string_agg(id::text || '@' || price_per_unit::text, ',') FROM quote_items WHERE quote_id = v_id);
  END IF;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-C2-' || v_suffix, v_rv, NULL);
  SELECT price_per_unit INTO v_price FROM order_items WHERE order_id = (v_res->>'order_id')::uuid;
  IF v_price IS DISTINCT FROM 7.50 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (C) rewound quote did not convert at 7.50: %', v_price;
  END IF;

  -- --------------------------------------------------------------------
  -- D: a line added in the revision; E: a changed customer -> Convert refused
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'D')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] LOCK-D-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_build_array(jsonb_build_object('section_name', 'Products', 'sort_order', 0, 'items', jsonb_build_array(
      v_line || jsonb_build_object('id', v_lines->>'D'),
      v_line || jsonb_build_object('client_key', '_k2', 'product_id', v_q, 'sort_order', 1)))),
    v_admin, 'smk-lock-save-D2-' || v_suffix);
  IF (SELECT string_agg(price_per_unit::text, ',' ORDER BY sort_order) FROM quote_items WHERE quote_id = v_id) IS DISTINCT FROM '7.50,7.50' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (D) unexpected prices after adding a line';
  END IF;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    PERFORM convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-D-' || v_suffix, v_rv, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (D) Convert with a line added since the send was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (D) convert: %', v_err; END IF;
  END;

  v_id := (v_quotes->>'E')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] LOCK-E-' || v_suffix, 'customer_id', v_c2, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_set(v_sections, '{0,items,0,id}', to_jsonb(v_lines->>'E')),
    v_admin, 'smk-lock-save-E2-' || v_suffix);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    PERFORM convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-E-' || v_suffix, v_rv, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (E) Convert after a customer change was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED: the customer changed%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (E) convert: %', v_err; END IF;
  END;
  -- Rewinding to V1 puts the customer back, and the quote converts at the sent price.
  PERFORM restore_quote_version(v_id, (v_versions->>'E')::uuid, v_admin, 'smk-lock-rewind-E-' || v_suffix, v_rv, NULL);
  IF (SELECT customer_id FROM quotes WHERE id = v_id) IS DISTINCT FROM v_c1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (E) rewind did not restore the sent customer';
  END IF;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-E2-' || v_suffix, v_rv, NULL);
  IF (SELECT price_per_unit FROM order_items WHERE order_id = (v_res->>'order_id')::uuid) IS DISTINCT FROM 7.50 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (E) rewound quote did not convert at 7.50';
  END IF;

  -- --------------------------------------------------------------------
  -- N: a line saved without its id (matched only by product) takes today's price, so the
  -- screen and server agree; Convert then asks for a re-send
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'N')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] LOCK-N-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    v_sections, v_admin, 'smk-lock-save-N2-' || v_suffix);
  IF (SELECT price_per_unit FROM quote_items WHERE quote_id = v_id) IS DISTINCT FROM 8.75
     OR (SELECT cost_at_quote_cents FROM quote_items WHERE quote_id = v_id) IS DISTINCT FROM 600 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (N) an id-less line did not take today''s price with its kept cost: %',
      (SELECT price_per_unit::text || '@' || cost_at_quote_cents::text FROM quote_items WHERE quote_id = v_id);
  END IF;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    PERFORM convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-N-' || v_suffix, v_rv, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (N) Convert after an id-less re-price was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (N) convert: %', v_err; END IF;
  END;

  -- --------------------------------------------------------------------
  -- O: a quote reopened after its order was cancelled is checked again at Convert
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'O')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-O1-' || v_suffix, v_rv, NULL);
  -- What cancelling the order and an admin's revert_quote_status leave behind: a cancelled
  -- order, the quote back at 'sent' and its drawn quantity zeroed (20261016140000).
  UPDATE orders SET status = 'cancelled' WHERE id = (v_res->>'order_id')::uuid;
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET status = 'sent' WHERE id = v_id;
  PERFORM set_config('app.admin_override', 'false', true);
  UPDATE quote_product_draws SET quantity_drawn = 0, updated_at = now()
   WHERE quote_id = v_id AND quantity_drawn <> 0;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] LOCK-O-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_set(jsonb_set(v_sections, '{0,items,0,id}', to_jsonb(v_lines->>'O')),
      '{0,items,0,price_override}', '9'::jsonb),
    v_admin, 'smk-lock-save-O2-' || v_suffix);
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    PERFORM convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-O2-' || v_suffix, v_rv, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (O) a reopened quote converted an un-re-sent price';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (O) convert: %', v_err; END IF;
  END;

  -- --------------------------------------------------------------------
  -- M: an unchanged sent booking draws down at the sent 7.50
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'M')::uuid;
  v_res := draw_down_quote(v_id, jsonb_build_array(jsonb_build_object('product_id', v_p, 'quantity', 4)),
    v_admin, 'smk-lock-draw-M-' || v_suffix, NULL);
  SELECT oi.price_per_unit INTO v_price FROM order_items oi JOIN orders o ON o.id = oi.order_id
  WHERE o.quote_id = v_id LIMIT 1;
  IF v_price IS DISTINCT FROM 7.50 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (M) draw-down did not bill the sent 7.50: % / %', v_price, v_res;
  END IF;

  -- --------------------------------------------------------------------
  -- G: a sent planned booking revised to today's price cannot schedule a job;
  -- F: a planned draft never sent schedules at its own price
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'G')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] LOCK-G-' || v_suffix, 'customer_id', v_c1, 'status', 'revised', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv, 'is_planned', true),
    jsonb_set(jsonb_set(v_sections, '{0,items,0,id}', to_jsonb(v_lines->>'G')),
      '{0,items,0,use_todays_price}', 'true'::jsonb),
    v_admin, 'smk-lock-save-G2-' || v_suffix);
  SELECT id INTO v_section_id FROM quote_sections WHERE quote_id = v_id;
  BEGIN
    PERFORM create_job_from_quote_section(v_id, v_section_id, v_admin, 'smk-lock-job-G-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: (G) scheduling a job from an un-re-sent price change was ALLOWED';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (G) job: %', v_err; END IF;
  END;

  v_id := (v_quotes->>'F')::uuid;
  SELECT id INTO v_section_id FROM quote_sections WHERE quote_id = v_id;
  v_res := create_job_from_quote_section(v_id, v_section_id, v_admin, 'smk-lock-job-F-' || v_suffix);
  IF (SELECT price_per_unit_cents FROM job_chemicals WHERE job_id = (v_res->>'job_id')::uuid) IS DISTINCT FROM 750 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (F) the never-sent planned draft did not schedule at its own 7.50';
  END IF;

  -- --------------------------------------------------------------------
  -- H / I: versions written before line ids pair by product
  -- --------------------------------------------------------------------
  UPDATE quote_versions qv
     SET snapshot_data = jsonb_set(qv.snapshot_data, '{sections}', (
       SELECT jsonb_agg(jsonb_set(s.section, '{items}', (
         SELECT jsonb_agg(i.item - 'quote_item_id' - 'price_override')
         FROM jsonb_array_elements(s.section->'items') AS i(item))))
       FROM jsonb_array_elements(qv.snapshot_data->'sections') AS s(section)))
   WHERE qv.id IN ((v_versions->>'H')::uuid, (v_versions->>'I')::uuid);
  v_id := (v_quotes->>'H')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  v_res := convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-H-' || v_suffix, v_rv, NULL);
  SELECT price_per_unit INTO v_price FROM order_items WHERE order_id = (v_res->>'order_id')::uuid;
  IF v_price IS DISTINCT FROM 7.50 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (H) an id-less version did not convert by product at 7.50: %', v_price;
  END IF;
  v_id := (v_quotes->>'I')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    PERFORM convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-I-' || v_suffix, v_rv, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (I) an id-less version with a repeated product converted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED%cannot tell its lines apart%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (I) convert: %', v_err; END IF;
  END;

  -- --------------------------------------------------------------------
  -- J: a last version from before the protected send workflow is refused
  -- --------------------------------------------------------------------
  UPDATE quote_versions SET restore_trusted_at = NULL WHERE id = (v_versions->>'J')::uuid;
  v_id := (v_quotes->>'J')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  BEGIN
    PERFORM convert_quote_to_order(v_id, v_admin, 'smk-lock-conv-J-' || v_suffix, v_rv, NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: (J) an untrusted version converted';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'QUOTE_RESEND_REQUIRED%before sent versions were protected%' THEN RAISE EXCEPTION 'SMOKE_FAIL: (J) convert: %', v_err; END IF;
  END;

  -- --------------------------------------------------------------------
  -- L: control, a draft never sent re-prices to the catalog on save
  -- --------------------------------------------------------------------
  v_id := (v_quotes->>'L')::uuid;
  SELECT row_version INTO v_rv FROM quotes WHERE id = v_id;
  PERFORM save_quote(v_id, jsonb_build_object(
      'quote_number', '[SMOKE] LOCK-L-' || v_suffix, 'customer_id', v_c1, 'status', 'draft', 'tier', 1,
      'commission_split', '{"splits": []}'::jsonb, 'row_version_expected', v_rv),
    jsonb_set(v_sections, '{0,items,0,id}', to_jsonb(v_lines->>'L')),
    v_admin, 'smk-lock-save-L2-' || v_suffix);
  SELECT price_per_unit INTO v_price FROM quote_items WHERE quote_id = v_id;
  IF v_price IS DISTINCT FROM 8.75 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (L) a never-sent draft did not follow the catalog: %', v_price;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK sent-price lock: A,K keep 7.50; B re-sent at 8.75; C rewound to 7.50; D,E,G,I,J,N,O refused; E rewound with its customer; M drew 7.50; F scheduled its draft price; H paired by product; L follows the catalog';
END
$smoke$;
