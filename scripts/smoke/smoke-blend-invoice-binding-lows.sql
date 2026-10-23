-- ============================================================================
-- CONTAINER ONLY smoke chain for 20261022020000_blend_invoice_binding_lows.
-- Run through scripts/smoke/prove-blend-invoice-binding-lows-real-schema.mjs, never against the
-- live database: it creates invoices, which draw customer-visible invoice numbers from a sequence
-- that a rollback does not return.
--
-- The rules under test (the four LOW leftovers of 20261021070000):
--   1. a per-unit line's amount and cost, and the invoice totals, come from the quantity the line
--      stores (4 places), not the unrounded quantity;
--   2. an "included in grower share" line's cost in the invoice total comes from that same stored
--      quantity;
--   3. an approved $0 quoted line records the catalog cost the approval showed, not the ticket
--      line's editable cost copy; a priced quoted line on the same ticket keeps its copy;
--   4. with the dead key test gone, the replay lookup and the receipt still work: the same key
--      returns the same invoices, and the key reused on another ticket is refused;
--   5. a positive quantity that rounds to 0 at the stored 4 places is refused
--      (BLEND_INVOICE_QUANTITY_ROUNDS_TO_ZERO), per-unit and grower share, leaving no invoice and
--      drawing no invoice number (a drawn number is never given back).
-- (The preflight pins are proven by the prover, not this chain.)
--
-- One product costs $900.00 (tier 2 $1,400.00); a line at 0.123456 gal/ac on 10 acres is
-- 1.23456 gal, stored as 1.2346. Unrounded: amount 172838, cost 111110. Stored: 172844, 111114.
--
-- Runs as the table owner with request.jwt.claims set to an admin. Terminal SMOKE_PASS_ROLLBACK.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_p_big uuid;
  v_p_q uuid;
  v_pricing jsonb;
  v_customer uuid;
  v_field uuid;
  v_field_share uuid;
  v_quote uuid;
  v_section uuid;
  v_job uuid;
  v_t_unit uuid;
  v_t_share uuid;
  v_t_zero uuid;
  v_t_tiny uuid;
  v_t_tiny_share uuid;
  v_line_zero uuid;
  v_invoice uuid;
  v_res jsonb;
  v_res2 jsonb;
  v_detail jsonb;
  v_err text;
  v_count int;
  v_row record;
  v_seq bigint;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: an active admin is required';
  END IF;
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- Two products through the governed pricing path: an expensive one (so a 4th-place quantity
  -- difference is worth cents) and an ordinary one.
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] BIL Big ' || v_suffix, 'GL') RETURNING id INTO v_p_big;
  INSERT INTO public.products (product_name, unit_size)
  VALUES ('[E2E] BIL Q ' || v_suffix, 'GL') RETURNING id INTO v_p_q;
  v_pricing := public.preview_product_pricing_changes(
    'product_page', NULL,
    jsonb_build_array(
      jsonb_build_object('product_id', v_p_big, 'row_version', 1, 'pricing_mode', 'price_driven',
        'new_cost', '900.00', 'tier1_price', '1500.00', 'tier2_price', '1400.00', 'tier3_price', '1300.00'),
      jsonb_build_object('product_id', v_p_q, 'row_version', 1, 'pricing_mode', 'price_driven',
        'new_cost', '5.00', 'tier1_price', '10.00', 'tier2_price', '9.00', 'tier3_price', '8.00')),
    v_admin, 'e2e-bil-pricing-preview-' || v_suffix);
  IF v_pricing->>'status' IS DISTINCT FROM 'previewed'
     OR (v_pricing->>'apply_allowed')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'SMOKE_SETUP: governed product pricing preview failed: %', v_pricing;
  END IF;
  PERFORM public.apply_product_pricing_change_set(
    (v_pricing->>'change_set_id')::uuid, v_pricing->>'request_fingerprint', v_admin,
    'e2e-bil-pricing-apply-' || v_suffix);
  IF (SELECT current_cost FROM public.products WHERE id = v_p_big) IS DISTINCT FROM 900.00
     OR (SELECT tier2_price FROM public.products WHERE id = v_p_big) IS DISTINCT FROM 1400.00 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the expensive fixture product has unexpected cost or prices';
  END IF;

  -- A tier-2 customer with a plain 10-acre field and a 10-acre field billed at a flat $25.00/acre
  -- that includes the chemicals.
  INSERT INTO public.customers (farm_name, assigned_tier)
  VALUES ('[E2E] BIL Farm ' || v_suffix, 2) RETURNING id INTO v_customer;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[E2E] BIL Field ' || v_suffix, 'corn', 10) RETURNING id INTO v_field;
  INSERT INTO public.fields (customer_id, field_name, crop_type, total_acres)
  VALUES (v_customer, '[E2E] BIL Share Field ' || v_suffix, 'corn', 10) RETURNING id INTO v_field_share;
  INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary, price_override_cents, pricing_note)
  VALUES (v_field_share, v_customer, 100, true, 2500, 'package');

  -- The job's quote: the expensive product at $0 (a free sample), the ordinary one at 6.00. On
  -- live a new $0 quote line needs the below-cost approval when the quote is saved (save_quote);
  -- this recreates the $0 row directly as the table owner with the quote_items triggers off for
  -- this one statement (container only; rolled back).
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, is_planned)
  VALUES ('[E2E] BIL-Q-' || v_suffix, v_customer, v_admin, 'sent', true) RETURNING id INTO v_quote;
  INSERT INTO public.quote_sections (quote_id, section_name, sort_order)
  VALUES (v_quote, '[E2E] BIL Section', 0) RETURNING id INTO v_section;
  EXECUTE 'ALTER TABLE public.quote_items DISABLE TRIGGER USER';
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section, v_p_big, 0, 0, 20, 10, 2, 'gal/acre');
  EXECUTE 'ALTER TABLE public.quote_items ENABLE TRIGGER USER';
  INSERT INTO public.quote_items (quote_id, section_id, product_id, sort_order, price_per_unit, total_units_needed, acres, actual_rate, rate_unit)
  VALUES (v_quote, v_section, v_p_q, 1, 6.00, 20, 10, 2, 'gal/acre');
  INSERT INTO public.jobs (job_number, customer_id, job_date, status, quote_id, quote_section_id, total_acres)
  VALUES ('E2E-BIL-J-' || v_suffix, v_customer, v_today, 'scheduled', v_quote, v_section, 10) RETURNING id INTO v_job;

  -- Three approved, unbilled tickets: per-unit (plain field), grower share (share field), and $0
  -- quoted (plain field, on the job).
  FOR v_count IN 1..5 LOOP
    INSERT INTO public.blend_tickets (
      ticket_number, uploaded_by, customer_id, status, review_status,
      payment_status, order_link_status, season, total_acres, source, job_id
    ) VALUES (
      '[E2E]-BIL-' || v_count || '-' || v_suffix, v_admin, v_customer,
      'completed', 'approved', 'unbilled', 'unlinked', public.current_season(), 10, 'manual',
      CASE WHEN v_count = 3 THEN v_job END
    ) RETURNING id INTO v_invoice;
    INSERT INTO public.blend_ticket_fields (blend_ticket_id, field_id, customer_id, actual_acres)
    VALUES (v_invoice, CASE WHEN v_count IN (2, 5) THEN v_field_share ELSE v_field END, v_customer, 10);
    CASE v_count
      WHEN 1 THEN v_t_unit := v_invoice;
      WHEN 2 THEN v_t_share := v_invoice;
      WHEN 3 THEN v_t_zero := v_invoice;
      WHEN 4 THEN v_t_tiny := v_invoice;
      ELSE v_t_tiny_share := v_invoice;
    END CASE;
  END LOOP;
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order)
  VALUES (v_t_unit, v_p_big, '[E2E] BIL per-unit', 1.23456, 'GL', 0.123456, 'gal/ac', 1),
         (v_t_share, v_p_big, '[E2E] BIL in grower share', 1.23456, 'GL', 0.123456, 'gal/ac', 1),
         -- 0.000004 gal/ac on 10 acres is 0.00004 gal, which stores as 0.0000.
         (v_t_tiny, v_p_big, '[E2E] BIL tiny per-unit', 0.00004, 'GL', 0.000004, 'gal/ac', 1),
         (v_t_tiny_share, v_p_big, '[E2E] BIL tiny in grower share', 0.00004, 'GL', 0.000004, 'gal/ac', 1);
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order, unit_cost_cents)
  VALUES (v_t_zero, v_p_big, '[E2E] BIL zero quoted', 20, 'GL', 2, 'gal/ac', 1, 100) RETURNING id INTO v_line_zero;
  INSERT INTO public.blend_ticket_products (blend_ticket_id, product_id, product_name, quantity, unit, rate_per_acre, rate_per_acre_unit, sequence_order, unit_cost_cents)
  VALUES (v_t_zero, v_p_q, '[E2E] BIL quoted six', 20, 'GL', 2, 'gal/ac', 2, 100);

  -- 1. Per-unit line (Mode B): billed and costed from the stored quantity.
  v_res := public.create_invoice_from_blend_ticket(v_t_unit, v_admin, 'e2e-bil-invoice-1-' || v_suffix);
  v_invoice := (v_res->'invoice_ids'->>0)::uuid;
  SELECT ii.quantity, ii.unit_price_cents, ii.extended_cents, ii.cost_cents INTO v_row
    FROM public.invoice_items ii WHERE ii.invoice_id = v_invoice AND ii.product_id = v_p_big;
  IF v_row.quantity IS DISTINCT FROM 1.2346 OR v_row.unit_price_cents IS DISTINCT FROM 140000::bigint THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the per-unit line is not 1.2346 at 140000 cents: %', to_jsonb(v_row);
  END IF;
  IF v_row.extended_cents IS DISTINCT FROM 172844::bigint
     OR (SELECT total_amount_cents FROM public.invoices WHERE id = v_invoice) IS DISTINCT FROM 172844::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the per-unit line amount is not its stored quantity x price (172844): line %, invoice %',
      v_row.extended_cents, (SELECT total_amount_cents FROM public.invoices WHERE id = v_invoice);
  END IF;
  IF v_row.cost_cents IS DISTINCT FROM 90000::bigint
     OR (SELECT total_cost_cents FROM public.invoices WHERE id = v_invoice) IS DISTINCT FROM 111114::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the per-unit invoice cost is not the stored quantity x cost (111114): line cost %, invoice cost %',
      v_row.cost_cents, (SELECT total_cost_cents FROM public.invoices WHERE id = v_invoice);
  END IF;

  -- 4. The replay lookup and the receipt still run with the dead test gone: the same key returns
  --    the same invoices and writes nothing; the same key on another ticket is refused.
  -- Every row an invoice call writes, counted before the replay.
  SELECT jsonb_build_object(
           'invoices', (SELECT count(*) FROM public.invoices),
           'items', (SELECT count(*) FROM public.invoice_items),
           'shares', (SELECT count(*) FROM public.invoice_shares),
           'audit', (SELECT count(*) FROM public.financial_audit_log),
           'activity', (SELECT count(*) FROM public.activity_feed),
           'approvals', (SELECT count(*) FROM public.below_cost_approvals))
    INTO v_detail;
  BEGIN
    v_res2 := public.create_invoice_from_blend_ticket(v_t_unit, v_admin, 'e2e-bil-invoice-1-' || v_suffix);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    RAISE EXCEPTION 'SMOKE_FAIL: the same key did not replay the same invoices: %', v_err;
  END;
  IF v_res2 IS DISTINCT FROM v_res
     OR (SELECT count(*) FROM public.invoices WHERE blend_ticket_id = v_t_unit) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the same key did not replay the same invoices: % then %', v_res, v_res2;
  END IF;
  IF v_detail IS DISTINCT FROM jsonb_build_object(
           'invoices', (SELECT count(*) FROM public.invoices),
           'items', (SELECT count(*) FROM public.invoice_items),
           'shares', (SELECT count(*) FROM public.invoice_shares),
           'audit', (SELECT count(*) FROM public.financial_audit_log),
           'activity', (SELECT count(*) FROM public.activity_feed),
           'approvals', (SELECT count(*) FROM public.below_cost_approvals)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the replay wrote rows: before %', v_detail;
  END IF;
  BEGIN
    v_res2 := public.create_invoice_from_blend_ticket(v_t_share, v_admin, 'e2e-bil-invoice-1-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a key reused on another ticket returned or made invoices: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'IDEMPOTENCY_INTENT_MISMATCH' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong reused-key refusal: %', v_err;
    END IF;
  END;
  BEGIN
    v_res2 := public.create_invoice_from_blend_ticket(v_t_share, v_admin, '  ');
    RAISE EXCEPTION 'SMOKE_FAIL: a blend-ticket invoice was made with a blank retry key: %', v_res2;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'IDEMPOTENCY_KEY_REQUIRED:%' THEN RAISE EXCEPTION 'SMOKE_FAIL: wrong blank-key refusal: %', v_err; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE blend_ticket_id = v_t_share) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused key left an invoice behind';
  END IF;

  -- 2. Grower-share line (Mode A): asks for the approval, then its cost in the invoice total comes
  --    from the stored quantity.
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t_share, v_admin, 'e2e-bil-invoice-2a-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: the grower-share ticket billed with no approval: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BELOW_COST_REASON_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong grower-share approval request: %', v_err;
    END IF;
  END;
  v_detail := substr(v_err, length('BELOW_COST_REASON_REQUIRED:') + 1)::jsonb;
  v_res := public.create_invoice_from_blend_ticket(v_t_share, v_admin, 'e2e-bil-invoice-2b-' || v_suffix, 'package price', v_detail->'zero_lines');
  v_invoice := (v_res->'invoice_ids'->>0)::uuid;
  SELECT ii.quantity, ii.extended_cents, ii.cost_cents INTO v_row
    FROM public.invoice_items ii
   WHERE ii.invoice_id = v_invoice AND ii.product_id = v_p_big AND ii.description LIKE '% — included in grower share';
  IF v_row.quantity IS DISTINCT FROM 1.2346 OR v_row.extended_cents IS DISTINCT FROM 0::bigint
     OR v_row.cost_cents IS DISTINCT FROM 90000::bigint
     OR (SELECT total_amount_cents FROM public.invoices WHERE id = v_invoice) IS DISTINCT FROM 25000::bigint THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the grower-share invoice is not 1.2346 at $0 under a $250.00 share: %',
      (SELECT jsonb_agg(to_jsonb(ii)) FROM public.invoice_items ii WHERE ii.invoice_id = v_invoice);
  END IF;
  IF (SELECT total_cost_cents FROM public.invoices WHERE id = v_invoice) IS DISTINCT FROM 111114::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the included chemical''s cost in the invoice is not its stored quantity x cost (111114): %',
      (SELECT total_cost_cents FROM public.invoices WHERE id = v_invoice);
  END IF;

  -- 3. $0 quoted line: records the catalog cost the approval showed (90000), not the ticket
  --    line's editable copy (100); the 6.00 quoted line on the same ticket keeps its copy.
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t_zero, v_admin, 'e2e-bil-invoice-3a-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: the $0 quoted line billed with no approval: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BELOW_COST_REASON_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong $0 approval request: %', v_err;
    END IF;
  END;
  v_detail := substr(v_err, length('BELOW_COST_REASON_REQUIRED:') + 1)::jsonb;
  IF jsonb_array_length(v_detail->'zero_lines') <> 1
     OR (v_detail->'zero_lines'->0->>'line_id')::uuid IS DISTINCT FROM v_line_zero
     OR (v_detail->'zero_lines'->0->>'cost_cents')::bigint IS DISTINCT FROM 90000 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the $0 approval does not show the one $0 line at its 90000 catalog cost: %', v_detail;
  END IF;
  v_res := public.create_invoice_from_blend_ticket(v_t_zero, v_admin, 'e2e-bil-invoice-3b-' || v_suffix, 'free sample', v_detail->'zero_lines');
  v_invoice := (v_res->'invoice_ids'->>0)::uuid;
  IF (SELECT ii.unit_price_cents FROM public.invoice_items ii WHERE ii.invoice_id = v_invoice AND ii.product_id = v_p_big) IS DISTINCT FROM 0::bigint
     OR (SELECT ii.unit_price_cents FROM public.invoice_items ii WHERE ii.invoice_id = v_invoice AND ii.product_id = v_p_q) IS DISTINCT FROM 600::bigint THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the $0 ticket did not bill $0 and 6.00 as quoted: %',
      (SELECT jsonb_agg(to_jsonb(ii)) FROM public.invoice_items ii WHERE ii.invoice_id = v_invoice);
  END IF;
  IF (SELECT ii.cost_cents FROM public.invoice_items ii WHERE ii.invoice_id = v_invoice AND ii.product_id = v_p_big) IS DISTINCT FROM 90000::bigint
     OR (SELECT a.locked_unit_cost_cents FROM public.below_cost_approvals a
          JOIN public.invoice_items ii ON ii.id = a.line_id
         WHERE a.entity_id = v_invoice AND ii.product_id = v_p_big) IS DISTINCT FROM 90000::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the approved $0 line records the ticket''s cost copy, not the approved catalog cost: %',
      (SELECT jsonb_agg(to_jsonb(ii)) FROM public.invoice_items ii WHERE ii.invoice_id = v_invoice);
  END IF;
  -- 20 x 90000 + 20 x 100.
  IF (SELECT ii.cost_cents FROM public.invoice_items ii WHERE ii.invoice_id = v_invoice AND ii.product_id = v_p_q) IS DISTINCT FROM 100::bigint
     OR (SELECT total_cost_cents FROM public.invoices WHERE id = v_invoice) IS DISTINCT FROM 1802000::bigint THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the $0 ticket''s other line or invoice cost changed source: line %, invoice %',
      (SELECT ii.cost_cents FROM public.invoice_items ii WHERE ii.invoice_id = v_invoice AND ii.product_id = v_p_q),
      (SELECT total_cost_cents FROM public.invoices WHERE id = v_invoice);
  END IF;
  IF COALESCE(current_setting('app.crx_below_cost_operation', true), '') <> ''
     OR COALESCE(current_setting('app.crx_below_cost_reason', true), '') <> '' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the below-cost context was left set after the invoices';
  END IF;

  -- 5. A quantity that rounds to 0 at 4 places is refused, not billed as a 0-quantity line, and
  --    before an invoice number is drawn.
  v_seq := pg_sequence_last_value('public.invoice_number_seq');
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t_tiny, v_admin, 'e2e-bil-invoice-5a-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: a quantity that rounds to 0 at 4 places was billed (per-unit): %',
      (SELECT jsonb_agg(to_jsonb(ii)) FROM public.invoice_items ii WHERE ii.invoice_id = (v_res->'invoice_ids'->>0)::uuid);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_INVOICE_QUANTITY_ROUNDS_TO_ZERO:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong per-unit zero-quantity refusal: %', v_err;
    END IF;
  END;
  -- The grower-share ticket asks for its $0 approval first; approved, it is still refused.
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t_tiny_share, v_admin, 'e2e-bil-invoice-5b-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: the tiny grower-share ticket billed with no approval: %', v_res;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BELOW_COST_REASON_REQUIRED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong tiny grower-share approval request: %', v_err;
    END IF;
  END;
  v_detail := substr(v_err, length('BELOW_COST_REASON_REQUIRED:') + 1)::jsonb;
  BEGIN
    v_res := public.create_invoice_from_blend_ticket(v_t_tiny_share, v_admin, 'e2e-bil-invoice-5c-' || v_suffix, 'package price', v_detail->'zero_lines');
    RAISE EXCEPTION 'SMOKE_FAIL: a quantity that rounds to 0 at 4 places was billed (grower share): %',
      (SELECT jsonb_agg(to_jsonb(ii)) FROM public.invoice_items ii WHERE ii.invoice_id = (v_res->'invoice_ids'->>0)::uuid);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err NOT LIKE 'BLEND_INVOICE_QUANTITY_ROUNDS_TO_ZERO:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong grower-share zero-quantity refusal: %', v_err;
    END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE blend_ticket_id IN (v_t_tiny, v_t_tiny_share))
     OR (SELECT count(*) FROM public.blend_tickets WHERE id IN (v_t_tiny, v_t_tiny_share) AND payment_status = 'unbilled') <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused zero-quantity ticket left an invoice or was marked billed';
  END IF;
  IF pg_sequence_last_value('public.invoice_number_seq') IS DISTINCT FROM v_seq THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a zero-quantity refusal drew an invoice number: % then %',
      v_seq, pg_sequence_last_value('public.invoice_number_seq');
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
