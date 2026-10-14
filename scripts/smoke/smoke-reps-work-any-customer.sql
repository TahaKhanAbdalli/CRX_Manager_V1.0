-- Rollback-only chain for 20261013220000_reps_work_any_customer (Mason, 2026-10-13): a sales rep
-- works with ANY customer. Covers the customer-record writers and readers the migration opened that
-- no other chain exercises: log_customer_fact, review_customer_fact, supersede_customer_fact,
-- log_customer_interaction, get_customer_prep_card, get_customer_lapsed_products,
-- get_customer_purchase_summary and get_dispatch_board_jobs. On a [SMOKE] customer with NO assigned
-- rep, an active sales rep logs, reviews and supersedes a fact, logs an interaction, and reads the
-- prep card, lapsed products, purchase summary and dispatch board; a non-office profile is still
-- refused the prep card; and the rep still cannot reassign the customer (REP_CANNOT_REASSIGN, from
-- customers_guard_rep_edit_20261013 and save_customer). Ends in SMOKE_PASS_ROLLBACK: nothing commits.
-- The full before/after matrix is scripts/smoke/prove-reps-work-any-customer-real-schema.mjs.
DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_nonoffice uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_result jsonb;
  v_fact uuid;
  v_count bigint;
  v_err text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM public.profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at LIMIT 1;
  SELECT id INTO v_nonoffice FROM public.profiles WHERE role NOT IN ('admin', 'sales_rep') AND is_active = true ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: active admin and sales_rep required';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  INSERT INTO public.customers (farm_name, assigned_sales_rep)
  VALUES ('[SMOKE] Any-Customer ' || v_suffix, NULL)
  RETURNING id INTO v_customer;

  -- Everything below runs as the sales rep, on a customer that is not theirs.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);

  -- Facts: log (pending), review to verified, then supersede the verified fact.
  v_result := public.log_customer_fact(
    p_customer_id => v_customer, p_category => 'agronomy', p_fact_key => 'smoke_any_customer',
    p_value_text => '[SMOKE] first', p_idempotency_key => 'smk-any-fact-' || v_suffix);
  v_fact := (v_result ->> 'fact_id')::uuid;
  IF v_fact IS NULL OR v_result ->> 'status' <> 'pending_review' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rep could not log a fact on an unassigned customer: %', v_result;
  END IF;
  v_result := public.review_customer_fact(v_fact, 'verified', '[SMOKE] ok', 'smk-any-review-' || v_suffix);
  IF v_result ->> 'status' <> 'verified' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rep could not review a fact on an unassigned customer: %', v_result;
  END IF;
  v_result := public.supersede_customer_fact(v_fact, '[SMOKE] second', NULL, NULL, NULL, 'smk-any-supersede-' || v_suffix);
  IF COALESCE((v_result ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rep could not supersede a fact on an unassigned customer: %', v_result;
  END IF;
  SELECT count(*) INTO v_count FROM public.customer_facts
   WHERE customer_id = v_customer AND status = 'verified' AND superseded_at IS NULL;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected exactly one current verified fact after supersede, got %', v_count;
  END IF;

  -- Interaction log.
  v_result := public.log_customer_interaction(
    v_customer, 'call', 'outbound', now(), '[SMOKE] any-customer call',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'smk-any-interaction-' || v_suffix);
  IF (v_result ->> 'interaction_id') IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.customer_interactions
                     WHERE id = (v_result ->> 'interaction_id')::uuid AND customer_id = v_customer AND created_by = v_rep) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rep could not log an interaction on an unassigned customer: %', v_result;
  END IF;

  -- Readers.
  IF public.get_customer_prep_card(v_customer) IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rep got no prep card for an unassigned customer';
  END IF;
  IF public.get_customer_lapsed_products(v_customer) IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rep got no lapsed-products result for an unassigned customer';
  END IF;
  IF public.get_customer_purchase_summary(v_customer, extract(year FROM (now() AT TIME ZONE 'America/Chicago'))::int::text) IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rep got no purchase summary for an unassigned customer';
  END IF;
  SELECT count(*) INTO v_count FROM public.get_dispatch_board_jobs(NULL, NULL, CURRENT_DATE - 1, CURRENT_DATE + 1);
  IF v_count IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rep could not read the dispatch board';
  END IF;

  -- Still narrower: the rep cannot reassign the customer, through save_customer or the table.
  BEGIN
    PERFORM public.save_customer(v_customer,
      jsonb_build_object('farm_name', '[SMOKE] Any-Customer ' || v_suffix, 'assigned_sales_rep', v_rep,
                         'row_version_expected', (SELECT row_version FROM public.customers WHERE id = v_customer)),
      '[]'::jsonb, v_rep, 'smk-any-reassign-' || v_suffix);
    RAISE EXCEPTION 'SMOKE_FAIL: rep reassigned a customer through save_customer';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'REP_CANNOT_REASSIGN' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong save_customer reassignment refusal: %', v_err;
    END IF;
  END;
  BEGIN
    UPDATE public.customers SET assigned_sales_rep = v_rep WHERE id = v_customer;
    RAISE EXCEPTION 'SMOKE_FAIL: rep reassigned a customer through a table update';
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err <> 'REP_CANNOT_REASSIGN' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong table reassignment refusal: %', v_err;
    END IF;
  END;

  -- Other roles keep today's gate.
  IF v_nonoffice IS NULL THEN
    RAISE NOTICE 'NON-OFFICE CHECK SKIPPED: no active non-office profile to impersonate';
  ELSE
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nonoffice, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_nonoffice::text, true);
    BEGIN
      PERFORM public.get_customer_prep_card(v_customer);
      RAISE EXCEPTION 'SMOKE_FAIL: a non-office profile read a prep card';
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
      IF v_err <> 'PURCHASE_INTELLIGENCE_ACCESS_DENIED' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: wrong non-office prep card refusal: %', v_err;
      END IF;
    END;
  END IF;

  RAISE NOTICE 'SMOKE OK: rep logged/reviewed/superseded a fact, logged an interaction, read prep card, lapsed products, purchase summary and dispatch board on an unassigned customer; reassignment refused; non-office refused';
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END $smoke$;
