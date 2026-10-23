-- ============================================================================
-- SMOKE TEST (rolled back by design) for 20261022070000_role_reads_require_active_profile.
--
-- CONTAINER ONLY: run through scripts/smoke/prove-role-reads-require-active-profile-real-schema.mjs,
-- never against the live database: the chain plants [SMOKE] logins (auth.users rows), a customer,
-- an order and deliveries, which the LIVE-DATA GUARD refuses.
--
-- Rule under test: get_team_board_deliveries, get_yesterday_delivery_recap,
-- mark_inventory_row_verified and get_ar_reminder_candidates refuse a caller whose profile is
-- inactive or missing, and keep serving active users as before.
--   a. team board: an active admin sees both [SMOKE] deliveries, an active driver only the one
--      assigned to them; an inactive admin, an inactive driver and a profile-less caller are refused;
--   b. yesterday's recap: an active admin passes, an inactive sales rep is refused;
--   c. mark_inventory_row_verified on an id that does not exist: an active admin passes the gate
--      (INVENTORY_NOT_FOUND), an inactive admin and a profile-less caller are refused
--      (INSUFFICIENT_ROLE); an active sales rep is refused even with a key that has a saved result;
--   d. get_ar_reminder_candidates: an active admin gets a JSON array; an inactive admin is refused,
--      and so is an inactive sales rep whose JWT carries user_role = admin.
--
-- Fail-first: before the migration the inactive callers in a-d get data (step a fails).
--
-- HOW TO RUN: as ONE statement inside a transaction that rolls back. It ALWAYS ends with RAISE
-- EXCEPTION 'SMOKE_PASS_ROLLBACK': that exact text = PASS; any other error = FAIL.
-- Auth: auth.uid() reads request.jwt.claims, set per call to a planted profile.
-- ============================================================================
DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_admin uuid := gen_random_uuid();
  v_rep uuid := gen_random_uuid();
  v_driver uuid := gen_random_uuid();
  v_in_admin uuid := gen_random_uuid();
  v_in_rep uuid := gen_random_uuid();
  v_in_driver uuid := gen_random_uuid();
  v_nobody uuid := gen_random_uuid();
  v_customer uuid;
  v_order uuid;
  v_mine text := '[SMOKE] RRA-MINE-' || v_suffix;
  v_other text := '[SMOKE] RRA-OTHER-' || v_suffix;
  v_key text := 'smk-rra-' || v_suffix || '-cached';
  v_res jsonb;
  v_seen text[];
  v_err text;
  v_who uuid;
  v_case text;
BEGIN
  -- 0. Fixtures: six logins (profiles from handle_new_user's direct-SQL path), three deactivated.
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (v_admin,     'smk-rra-admin-'     || v_suffix || '@example.invalid', jsonb_build_object('full_name', '[SMOKE] RRA admin '     || v_suffix, 'role', 'admin')),
    (v_rep,       'smk-rra-rep-'       || v_suffix || '@example.invalid', jsonb_build_object('full_name', '[SMOKE] RRA rep '       || v_suffix, 'role', 'sales_rep')),
    (v_driver,    'smk-rra-driver-'    || v_suffix || '@example.invalid', jsonb_build_object('full_name', '[SMOKE] RRA driver '    || v_suffix, 'role', 'driver')),
    (v_in_admin,  'smk-rra-in-admin-'  || v_suffix || '@example.invalid', jsonb_build_object('full_name', '[SMOKE] RRA in admin '  || v_suffix, 'role', 'admin')),
    (v_in_rep,    'smk-rra-in-rep-'    || v_suffix || '@example.invalid', jsonb_build_object('full_name', '[SMOKE] RRA in rep '    || v_suffix, 'role', 'sales_rep')),
    (v_in_driver, 'smk-rra-in-driver-' || v_suffix || '@example.invalid', jsonb_build_object('full_name', '[SMOKE] RRA in driver ' || v_suffix, 'role', 'driver'));
  -- Only an admin may change is_active (_guard_profile_role_lock): deactivate as the planted admin.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  UPDATE public.profiles SET is_active = false WHERE id IN (v_in_admin, v_in_rep, v_in_driver);
  IF (SELECT count(*) FROM public.profiles WHERE id IN (v_admin, v_rep, v_driver) AND is_active) <> 3
     OR (SELECT count(*) FROM public.profiles WHERE id IN (v_in_admin, v_in_rep, v_in_driver) AND NOT is_active) <> 3 THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the planted profiles are not three active and three inactive';
  END IF;

  INSERT INTO public.customers (farm_name, account_number)
  VALUES ('[SMOKE] RRA Farm ' || v_suffix, '[SMOKE]-RRA-' || v_suffix)
  RETURNING id INTO v_customer;
  INSERT INTO public.orders (order_number, customer_id, status, booking_draw)
  VALUES ('[SMOKE] RRA-' || v_suffix, v_customer, 'confirmed', false)
  RETURNING id INTO v_order;
  INSERT INTO public.deliveries (delivery_number, order_id, customer_id, assigned_driver, scheduled_date, status, created_by) VALUES
    (v_mine,  v_order, v_customer, v_driver, CURRENT_DATE, 'scheduled', v_admin),
    (v_other, v_order, v_customer, NULL,     CURRENT_DATE, 'scheduled', v_admin);
  INSERT INTO public.idempotency_keys (idempotency_key, operation, result, expires_at)
  VALUES (v_key, 'mark_inventory_row_verified', '{"cleared":true,"reason":"smoke-cache"}'::jsonb, now() + interval '1 day');

  -- a. Team board.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_res := public.get_team_board_deliveries();
  SELECT array_agg(e->>'delivery_number' ORDER BY e->>'delivery_number') INTO v_seen
    FROM jsonb_array_elements(v_res->'today') e WHERE e->>'delivery_number' IN (v_mine, v_other);
  IF v_seen IS DISTINCT FROM ARRAY[v_mine, v_other] THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a. the active admin did not see both deliveries: %', v_seen;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  v_res := public.get_team_board_deliveries();
  SELECT array_agg(e->>'delivery_number') INTO v_seen
    FROM jsonb_array_elements(v_res->'today') e WHERE e->>'delivery_number' IN (v_mine, v_other);
  IF v_seen IS DISTINCT FROM ARRAY[v_mine] THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a. the active driver did not see only their own delivery: %', v_seen;
  END IF;
  FOREACH v_who IN ARRAY ARRAY[v_in_admin, v_in_driver, v_nobody] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_who, 'role', 'authenticated')::text, true);
    v_err := NULL;
    BEGIN
      v_res := public.get_team_board_deliveries();
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS DISTINCT FROM 'INSUFFICIENT_ROLE: active account required' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a. an inactive or profile-less caller was not refused by the team board (%): %', v_err, v_res;
    END IF;
  END LOOP;

  -- b. Yesterday's recap.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_res := public.get_yesterday_delivery_recap();
  IF jsonb_typeof(v_res->'completed') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: b. the active admin did not get a recap: %', v_res;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_in_rep, 'role', 'authenticated')::text, true);
  v_err := NULL;
  BEGIN
    v_res := public.get_yesterday_delivery_recap();
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS DISTINCT FROM 'INSUFFICIENT_ROLE: active account required' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: b. the inactive sales rep was not refused by the recap (%): %', v_err, v_res;
  END IF;

  -- c. mark_inventory_row_verified (an id that does not exist: the gate is what is tested).
  FOREACH v_case IN ARRAY ARRAY['admin', 'in_admin', 'nobody', 'rep_cached'] LOOP
    v_who := CASE v_case WHEN 'admin' THEN v_admin WHEN 'in_admin' THEN v_in_admin WHEN 'nobody' THEN v_nobody ELSE v_rep END;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_who, 'role', 'authenticated')::text, true);
    v_err := NULL;
    BEGIN
      v_res := public.mark_inventory_row_verified(gen_random_uuid(), NULL, CASE WHEN v_case = 'rep_cached' THEN v_key END);
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_case = 'admin' AND (v_err IS NULL OR v_err NOT LIKE 'INVENTORY_NOT_FOUND:%') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: c. the active admin did not pass the gate (%)', v_err;
    ELSIF v_case <> 'admin' AND v_err IS DISTINCT FROM 'INSUFFICIENT_ROLE: admin required' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: c. % was not refused by mark_inventory_row_verified (%): %', v_case, v_err, v_res;
    END IF;
  END LOOP;

  -- d. get_ar_reminder_candidates.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  IF jsonb_typeof(public.get_ar_reminder_candidates()) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: d. the active admin did not get the overdue list';
  END IF;
  FOREACH v_case IN ARRAY ARRAY['in_admin', 'in_rep_claim'] LOOP
    PERFORM set_config('request.jwt.claims', CASE v_case
      WHEN 'in_admin' THEN json_build_object('sub', v_in_admin, 'role', 'authenticated')
      ELSE json_build_object('sub', v_in_rep, 'role', 'authenticated', 'user_role', 'admin') END::text, true);
    v_err := NULL;
    BEGIN
      v_res := public.get_ar_reminder_candidates();
    EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
    END;
    IF v_err IS DISTINCT FROM 'permission denied: admin role required' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: d. % was not refused by get_ar_reminder_candidates (%)', v_case, v_err;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
