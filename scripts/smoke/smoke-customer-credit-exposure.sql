-- Rollback-only chain for 20261027030000_customer_credit_exposure (PR #1132's credit check, Sol HIGH:
-- a rep's check could not see another rep's drafts through invoice RLS).
-- On a [SMOKE] customer with a $10,000.00 limit it plants invoices owned by sales rep A: a draft,
-- an unposted, a posted and an overdue invoice (all counted), a paid, a voided and a cancelled
-- invoice, a soft-deleted draft and a draft credit memo with a negative balance (none counted), plus
-- a draft for another customer (not counted). Then:
--   1. sales rep B (who owns none of them) gets exposure_cents = 960000 and credit_limit_cents =
--      1000000 - rep A's $9,000 draft is counted for rep B;
--   2. rep A and an active admin get the same answer;
--   3. a customer whose limit is null, 0 or negative (all "no limit") answers
--      credit_limit_cents = null, exposure_cents = 0;
--   4. an unknown or null customer id raises CUSTOMER_NOT_FOUND (never 0);
--   5. an active non-office profile and a signed-in JWT with no profile are refused (Permission
--      denied), and so is an inactive sales rep when the database has one (the container prover
--      seeds one; live has none).
-- Ends in SMOKE_PASS_ROLLBACK: nothing commits. The before/after proof with real browser roles
-- (RLS hides rep A's draft from rep B; anon cannot execute) is
-- scripts/smoke/prove-customer-credit-exposure-real-schema.mjs.
DO $smoke$
DECLARE
  v_admin uuid;
  v_rep_a uuid;
  v_rep_b uuid;
  v_nonoffice uuid;
  v_inactive uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_customer uuid;
  v_other uuid;
  v_nolimit uuid;
  v_zero uuid;
  v_negative uuid;
  v_unknown uuid;
  v_inv uuid;
  v_result jsonb;
  v_caller uuid;
  v_label text;
  v_refused boolean;
  v_err text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_rep_a FROM public.profiles WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_rep_b FROM public.profiles WHERE role = 'sales_rep' AND is_active = true AND id <> v_rep_a ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_nonoffice FROM public.profiles WHERE role NOT IN ('admin', 'sales_rep') AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_inactive FROM public.profiles WHERE role = 'sales_rep' AND is_active = false ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL OR v_rep_a IS NULL OR v_rep_b IS NULL OR v_nonoffice IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: an active admin, two active sales reps and an active non-office profile are required';
  END IF;

  -- Fixture, planted as the admin.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  INSERT INTO public.customers (farm_name, credit_limit_cents, assigned_sales_rep)
  VALUES ('[SMOKE] Credit Exposure ' || v_suffix, 1000000, v_rep_a) RETURNING id INTO v_customer;
  INSERT INTO public.customers (farm_name, credit_limit_cents)
  VALUES ('[SMOKE] Credit Exposure Other ' || v_suffix, 1000000) RETURNING id INTO v_other;
  INSERT INTO public.customers (farm_name, credit_limit_cents)
  VALUES ('[SMOKE] Credit Exposure No Limit ' || v_suffix, NULL) RETURNING id INTO v_nolimit;
  INSERT INTO public.customers (farm_name, credit_limit_cents)
  VALUES ('[SMOKE] Credit Exposure Zero Limit ' || v_suffix, 0) RETURNING id INTO v_zero;
  INSERT INTO public.customers (farm_name, credit_limit_cents)
  VALUES ('[SMOKE] Credit Exposure Negative Limit ' || v_suffix, -500) RETURNING id INTO v_negative;

  -- Counted: draft 900000 + unposted 10000 + posted 20000 + overdue 30000 = 960000.
  INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, salesman_id)
  VALUES ('[SMOKE]-CX-DRAFT-' || v_suffix, v_customer, 'chemical_sale', 'draft', v_today, v_today + 30, 900000, v_rep_a, v_rep_a);

  INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, salesman_id)
  VALUES ('[SMOKE]-CX-UNPOSTED-' || v_suffix, v_customer, 'chemical_sale', 'draft', v_today, v_today + 30, 10000, v_rep_a, v_rep_a)
  RETURNING id INTO v_inv;
  UPDATE public.invoices SET status = 'unposted' WHERE id = v_inv;

  INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, salesman_id)
  VALUES ('[SMOKE]-CX-POSTED-' || v_suffix, v_customer, 'chemical_sale', 'draft', v_today, v_today + 30, 20000, v_rep_a, v_rep_a)
  RETURNING id INTO v_inv;
  UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = v_inv;

  INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, salesman_id)
  VALUES ('[SMOKE]-CX-OVERDUE-' || v_suffix, v_customer, 'chemical_sale', 'draft', v_today - 60, v_today - 30, 30000, v_rep_a, v_rep_a)
  RETURNING id INTO v_inv;
  UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = v_inv;
  UPDATE public.invoices SET status = 'overdue' WHERE id = v_inv;

  -- Not counted: paid, voided, cancelled, soft-deleted, a negative-balance credit memo, another customer.
  INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, paid_amount_cents, created_by, salesman_id)
  VALUES ('[SMOKE]-CX-PAID-' || v_suffix, v_customer, 'chemical_sale', 'draft', v_today, v_today + 30, 40000, 40000, v_rep_a, v_rep_a)
  RETURNING id INTO v_inv;
  UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = v_inv;
  UPDATE public.invoices SET status = 'paid' WHERE id = v_inv;

  INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, salesman_id)
  VALUES ('[SMOKE]-CX-VOIDED-' || v_suffix, v_customer, 'chemical_sale', 'draft', v_today, v_today + 30, 50000, v_rep_a, v_rep_a)
  RETURNING id INTO v_inv;
  UPDATE public.invoices SET status = 'posted', posted_at = now() WHERE id = v_inv;
  UPDATE public.invoices SET status = 'voided' WHERE id = v_inv;

  INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, salesman_id)
  VALUES ('[SMOKE]-CX-CANCELLED-' || v_suffix, v_customer, 'chemical_sale', 'draft', v_today, v_today + 30, 60000, v_rep_a, v_rep_a)
  RETURNING id INTO v_inv;
  UPDATE public.invoices SET status = 'cancelled' WHERE id = v_inv;

  INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, salesman_id, deleted_at)
  VALUES ('[SMOKE]-CX-DELETED-' || v_suffix, v_customer, 'chemical_sale', 'draft', v_today, v_today + 30, 70000, v_rep_a, v_rep_a, now());

  INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, total_amount_cents, created_by, salesman_id)
  VALUES ('[SMOKE]-CX-CREDIT-' || v_suffix, v_customer, 'credit_memo', 'draft', v_today, -80000, v_rep_a, v_rep_a);

  INSERT INTO public.invoices (invoice_number, customer_id, invoice_type, status, invoice_date, due_date, total_amount_cents, created_by, salesman_id)
  VALUES ('[SMOKE]-CX-OTHER-' || v_suffix, v_other, 'chemical_sale', 'draft', v_today, v_today + 30, 90000, v_rep_a, v_rep_a);

  IF (SELECT min(balance_cents) FROM public.invoices WHERE customer_id = v_customer AND invoice_type = 'credit_memo') >= 0 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the credit memo fixture does not have a negative balance';
  END IF;

  -- 1-2. Rep B (owns nothing here), rep A and the admin all get the whole exposure.
  FOR v_caller, v_label IN SELECT * FROM (VALUES (v_rep_b, 'rep B'), (v_rep_a, 'rep A'), (v_admin, 'admin')) AS c(id, label) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_caller, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_caller::text, true);
    v_result := public.customer_credit_exposure(v_customer);
    IF v_result IS DISTINCT FROM jsonb_build_object('customer_id', v_customer, 'credit_limit_cents', 1000000, 'exposure_cents', 960000) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step 1-2 % expected limit 1000000 and exposure 960000 (rep A draft counted), got %', v_label, v_result;
    END IF;
    IF jsonb_typeof(v_result -> 'exposure_cents') <> 'number' OR (v_result ->> 'exposure_cents') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step 1-2 % exposure_cents is not whole cents: %', v_label, v_result;
    END IF;
  END LOOP;

  -- 3. No limit (null, 0 or negative are all "no limit"), no invoices (still as the admin).
  FOR v_caller, v_label IN SELECT * FROM (VALUES (v_nolimit, 'null limit'), (v_zero, 'zero limit'), (v_negative, 'negative limit')) AS c(id, label) LOOP
    v_result := public.customer_credit_exposure(v_caller);
    IF v_result IS DISTINCT FROM jsonb_build_object('customer_id', v_caller, 'credit_limit_cents', NULL::bigint, 'exposure_cents', 0) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step 3 % expected credit_limit_cents null and exposure 0, got %', v_label, v_result;
    END IF;
  END LOOP;

  -- 4. Unknown customer and a null id.
  FOR v_unknown, v_label IN SELECT * FROM (VALUES (gen_random_uuid(), 'unknown id'), (NULL::uuid, 'null id')) AS c(id, label) LOOP
    v_refused := false;
    v_err := NULL;
    v_result := NULL;
    BEGIN
      v_result := public.customer_credit_exposure(v_unknown);
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      v_refused := v_err LIKE 'CUSTOMER_NOT_FOUND%';
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step 4 % was not refused with CUSTOMER_NOT_FOUND (result %, error %)', v_label, v_result, v_err;
    END IF;
  END LOOP;

  -- 5. Refused callers. Claims are set here, outside the probe sub-blocks.
  FOR v_caller, v_label IN
    SELECT * FROM (VALUES (v_nonoffice, 'non-office profile'), (gen_random_uuid(), 'no profile'), (v_inactive, 'inactive sales rep')) AS c(id, label)
     WHERE c.id IS NOT NULL
  LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_caller, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_caller::text, true);
    v_refused := false;
    v_err := NULL;
    v_result := NULL;
    BEGIN
      v_result := public.customer_credit_exposure(v_customer);
    EXCEPTION WHEN OTHERS THEN
      v_err := SQLERRM;
      v_refused := v_err LIKE 'Permission denied%';
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'SMOKE_FAIL: step 5 % was not refused (result %, error %)', v_label, v_result, v_err;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
