-- Smoke chain: database functions hand cost, profit and margin only to admins
-- (REQUIRES 20261019010000; Goal 1 part 3, step 1).
-- One DO block; READ-ONLY (it writes nothing) and always ends in SMOKE_PASS_ROLLBACK.
-- Proves, as a real signed-in browser session (role authenticated with each live profile's claims)
-- and as a signed-out visitor (role anon):
--   * an active admin runs the six cost reports (gross sales, inventory cost, field profitability, dashboard summary,
--     profitability, bottom-line P&L); an active sales rep, driver, applicator, commission-recipient
--     profile and an id with no active profile (how a deactivated account looks to require_admin())
--     are each refused; a signed-out visitor cannot call them at all;
--   * the sales detail and summary reports give a sales rep the same rows as an admin, with every
--     cost, profit and margin value NULL;
--   * get_inventory_position gives a sales rep the same rows as an admin, none carrying current_cost.
-- The below-cost refusal message and save_quote's reply need a write to exercise, so they are proven
-- only in the disposable database (scripts/smoke/prove-cost-margin-admin-only-rpc-leaks-real-schema.mjs).
DO $$
DECLARE
  v_reports text[] := ARRAY[
    'SELECT count(*) FROM public.get_gross_sales_report(''2000-01-01'', ''2100-01-01'', ''product'')',
    'SELECT count(*) FROM public.get_inventory_cost_report()',
    'SELECT count(*) FROM public.get_field_profitability(NULL)',
    'SELECT count(*) FROM public.get_profitability_report(''product'')',
    'SELECT count(*) FROM public.get_bottom_line_pnl(''2000-01-01'', ''2100-01-01'')',
    'SELECT count(*) FROM (SELECT public.dashboard_summary()) s'
  ];
  v_report text;
  v_role text;
  v_uid uuid;
  v_admin uuid;
  v_rep uuid;
  v_refused boolean;
  v_count bigint;
  v_admin_detail bigint;
  v_rep_detail bigint;
  v_rep_detail_cost bigint;
  v_admin_summary bigint;
  v_rep_summary bigint;
  v_rep_summary_cost bigint;
  v_admin_position jsonb;
  v_rep_position jsonb;
  v_sig text;
BEGIN
  -- Shape: the wrappers are definer functions with the pinned search_path, callable by signed-in
  -- users and not by anon; the renamed bodies are callable by no API role.
  FOREACH v_sig IN ARRAY ARRAY[
    'public.get_gross_sales_report(date,date,text)', 'public.get_inventory_cost_report()',
    'public.get_field_profitability(text)', 'public.get_profitability_report(text,date,date)',
    'public.get_bottom_line_pnl(date,date)',
    'public.get_sales_detail_report(date,date,uuid,uuid[],uuid,text,integer)',
    'public.get_sales_summary_report(text,date,date,uuid,uuid[],uuid,text,integer)',
    'public.get_inventory_position()', 'public.dashboard_summary()', 'public.save_quote(uuid,jsonb,jsonb,uuid,text)'
  ] LOOP
    IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']
              FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig)) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % is not SECURITY DEFINER with the pinned search_path', v_sig;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(v_sig), 'EXECUTE')
       OR NOT has_function_privilege('authenticated', to_regprocedure(v_sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: % has the wrong EXECUTE grants', v_sig;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname LIKE '\_%\_cost\_impl\_20261019') <> 9 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: expected 9 renamed _*_cost_impl_20261019 bodies';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
               AND p.proname LIKE '\_%\_cost\_impl\_20261019'
               AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
                    OR has_function_privilege('anon', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a renamed cost body is callable by an API role';
  END IF;
  IF position('locked_unit_cost_cents''' IN (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'public._enforce_below_cost_line()'::regprocedure)) = 0
     OR position('v_detail := v_detail - ''locked_unit_cost_cents''' IN (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'public._enforce_below_cost_line()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: _enforce_below_cost_line does not strip the cost for non-admins';
  END IF;

  -- Each staff role, as a real active profile: the six cost reports.
  FOR v_role IN SELECT unnest(ARRAY['admin', 'sales_rep', 'driver', 'applicator', 'entity_recipient']) LOOP
    SELECT p.id INTO v_uid FROM public.profiles p WHERE p.role = v_role AND p.is_active ORDER BY p.created_at LIMIT 1;
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'SMOKE_FAIL: no active % profile to probe with', v_role;
    END IF;
    IF v_role = 'admin' THEN v_admin := v_uid; END IF;
    IF v_role = 'sales_rep' THEN v_rep := v_uid; END IF;

    FOREACH v_report IN ARRAY v_reports LOOP
      v_refused := false;
      BEGIN
        PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
        PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
        EXECUTE 'SET LOCAL ROLE authenticated';
        EXECUTE v_report INTO v_count;
        EXECUTE 'RESET ROLE';
      EXCEPTION WHEN OTHERS THEN
        EXECUTE 'RESET ROLE';
        IF SQLERRM <> 'Permission denied: requires admin role' THEN
          RAISE EXCEPTION 'SMOKE_FAIL: % got an unexpected error from [%]: % %', v_role, v_report, SQLSTATE, SQLERRM;
        END IF;
        v_refused := true;
      END;
      IF v_role = 'admin' AND v_refused THEN
        RAISE EXCEPTION 'SMOKE_FAIL: admin was refused [%]', v_report;
      ELSIF v_role <> 'admin' AND NOT v_refused THEN
        RAISE EXCEPTION 'SMOKE_FAIL: % ran [%] (% rows)', v_role, v_report, v_count;
      END IF;
    END LOOP;
  END LOOP;

  -- A signed-in id with no active profile, and a signed-out visitor.
  v_uid := gen_random_uuid();
  FOREACH v_report IN ARRAY v_reports LOOP
    v_refused := false;
    BEGIN
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
      EXECUTE 'SET LOCAL ROLE authenticated';
      EXECUTE v_report INTO v_count;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'RESET ROLE';
      IF SQLERRM <> 'Permission denied: requires admin role' THEN
        RAISE EXCEPTION 'SMOKE_FAIL: an id with no profile got an unexpected error from [%]: % %', v_report, SQLSTATE, SQLERRM;
      END IF;
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'SMOKE_FAIL: an id with no active profile ran [%]', v_report;
    END IF;

    v_refused := false;
    BEGIN
      PERFORM set_config('request.jwt.claims', '', true);
      PERFORM set_config('request.jwt.claim.sub', '', true);
      EXECUTE 'SET LOCAL ROLE anon';
      EXECUTE v_report INTO v_count;
      EXECUTE 'RESET ROLE';
    EXCEPTION WHEN insufficient_privilege THEN
      EXECUTE 'RESET ROLE';
      v_refused := true;
    END;
    IF NOT v_refused THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a signed-out visitor ran [%]', v_report;
    END IF;
  END LOOP;

  -- Sales reports and inventory position: same rows for the rep, no cost values.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_admin_detail FROM public.get_sales_detail_report();
  SELECT count(*) INTO v_admin_summary FROM public.get_sales_summary_report();
  v_admin_position := public.get_inventory_position();
  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*), count(cost) + count(profit) + count(margin_pct)
    INTO v_rep_detail, v_rep_detail_cost FROM public.get_sales_detail_report();
  SELECT count(*), count(total_cost) + count(total_profit) + count(margin_pct)
    INTO v_rep_summary, v_rep_summary_cost FROM public.get_sales_summary_report();
  v_rep_position := public.get_inventory_position();
  EXECUTE 'RESET ROLE';

  IF v_rep_detail <> v_admin_detail OR v_rep_detail_cost <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: sales detail: rep % rows (% cost values), admin % rows', v_rep_detail, v_rep_detail_cost, v_admin_detail;
  END IF;
  IF v_rep_summary <> v_admin_summary OR v_rep_summary_cost <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: sales summary: rep % rows (% cost values), admin % rows', v_rep_summary, v_rep_summary_cost, v_admin_summary;
  END IF;
  IF jsonb_array_length(v_rep_position) <> jsonb_array_length(v_admin_position) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inventory position: rep % rows, admin % rows', jsonb_array_length(v_rep_position), jsonb_array_length(v_admin_position);
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_rep_position) e WHERE e ? 'current_cost') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inventory position hands the rep current_cost';
  END IF;
  IF jsonb_array_length(v_admin_position) > 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_admin_position) e WHERE e ? 'current_cost') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: inventory position no longer hands the admin current_cost';
  END IF;

  RAISE NOTICE 'cost-margin smoke: % sales-detail rows, % summary rows, % inventory rows checked',
    v_admin_detail, v_admin_summary, jsonb_array_length(v_admin_position);
  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$$;
