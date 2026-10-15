-- Smoke chain: the RUP sales register is admin-only (REQUIRES 20261014220000).
-- One DO block; always ends in SMOKE_PASS_ROLLBACK, so the probe row below is never kept.
-- Proves, as a real signed-in browser session (role authenticated with each live profile's claims)
-- and as a signed-out visitor (role anon):
--   * an active admin pulls the register through get_rup_sales_register and reads the table;
--   * an active sales rep, driver, applicator and commission-recipient profile, and a caller whose
--     id has no active profile (how a deactivated account looks to require_admin()), are refused
--     by the function and see 0 table rows;
--   * a signed-out visitor is refused both.
-- No profile row is changed: the deactivated case is proven by the disposable-database prover
-- (scripts/smoke/prove-rup-register-admin-only-real-schema.mjs) and here by an id with no profile.
DO $$
DECLARE
  v_proc regprocedure := 'public.get_rup_sales_register(date,date,uuid,uuid,text,boolean)'::regprocedure;
  v_src text;
  v_qual text;
  v_customer uuid;
  v_product uuid;
  v_row uuid := gen_random_uuid();
  v_marker text := 'SMOKE-RUP-' || replace(gen_random_uuid()::text, '-', '');
  v_uid uuid;
  v_role text;
  v_count bigint;
  v_refused boolean;
BEGIN
  -- Shape.
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = v_proc;
  -- The exact gated body 20261014220000 installs.
  IF md5(replace(v_src, chr(13), '')) <> '01a56f57845ccc8fcc0bc91cfd114045' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: get_rup_sales_register is not the gated body of 20261014220000';
  END IF;
  IF has_function_privilege('anon', v_proc, 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anon can execute get_rup_sales_register';
  END IF;
  SELECT qual INTO v_qual FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'rup_sales_records' AND policyname = 'rup_sales_select';
  IF v_qual IS NULL OR v_qual NOT LIKE '%is_admin()%' OR v_qual LIKE '%sales_rep%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: rup_sales_select is not admin-only: %', v_qual;
  END IF;
  IF has_table_privilege('anon', 'public.rup_sales_records', 'SELECT') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: anon holds SELECT on rup_sales_records';
  END IF;

  -- One probe register row (rolled back with everything else).
  SELECT c.id INTO v_customer FROM public.customers c ORDER BY c.created_at LIMIT 1;
  SELECT p.id INTO v_product FROM public.products p ORDER BY p.created_at LIMIT 1;
  IF v_customer IS NULL OR v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no customer or product to attach the probe row to';
  END IF;
  INSERT INTO public.rup_sales_records (id, customer_id, product_id, sale_date, product_name, quantity, unit, buyer_name, buyer_certification_number)
  VALUES (v_row, v_customer, v_product, (now() AT TIME ZONE 'America/Chicago')::date, '[SMOKE] RUP probe', 1, 'GL', '[SMOKE] buyer', v_marker);

  -- Each staff role, as a real active profile.
  FOR v_role IN SELECT unnest(ARRAY['admin', 'sales_rep', 'driver', 'applicator', 'entity_recipient']) LOOP
    SELECT p.id INTO v_uid FROM public.profiles p WHERE p.role = v_role AND p.is_active ORDER BY p.created_at LIMIT 1;
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'SMOKE_FAIL: no active % profile to probe with', v_role;
    END IF;

    v_refused := false;
    v_count := NULL;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      SELECT count(*) INTO v_count FROM public.get_rup_sales_register(NULL, NULL, NULL, NULL, NULL, true) r
       WHERE r.buyer_certification_number = v_marker;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'Permission denied: requires admin role' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: % got an unexpected error from the register: % %', v_role, SQLSTATE, SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF v_role = 'admin' AND (v_refused OR v_count <> 1) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: admin did not pull the probe row (refused=%, rows=%)', v_refused, v_count;
    ELSIF v_role <> 'admin' AND NOT v_refused THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % pulled the register (% probe rows)', v_role, v_count;
    END IF;

    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO v_count FROM public.rup_sales_records WHERE id = v_row;
    EXECUTE 'RESET ROLE';
    IF v_count <> (CASE WHEN v_role = 'admin' THEN 1 ELSE 0 END) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % read % probe rows from rup_sales_records directly', v_role, v_count;
    END IF;
  END LOOP;

  -- A signed-in id with no active profile (a deactivated account looks the same to require_admin()).
  v_uid := gen_random_uuid();
  v_refused := false;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM count(*) FROM public.get_rup_sales_register(NULL, NULL, NULL, NULL, NULL, true);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'Permission denied: requires admin role' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: an id with no profile got an unexpected error: % %', SQLSTATE, SQLERRM;
    END IF;
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an id with no active profile pulled the register';
  END IF;

  -- Signed-out visitor.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_refused := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM count(*) FROM public.get_rup_sales_register(NULL, NULL, NULL, NULL, NULL, true);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN insufficient_privilege THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a signed-out visitor pulled the register';
  END IF;
  v_refused := false;
  BEGIN
    EXECUTE 'SET LOCAL ROLE anon';
    PERFORM count(*) FROM public.rup_sales_records;
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN insufficient_privilege THEN
    v_refused := true;
  END;
  IF NOT v_refused THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a signed-out visitor can query rup_sales_records';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$$;
