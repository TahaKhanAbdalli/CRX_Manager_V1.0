-- ============================================================================
-- SMOKE CHAIN (rolled back by design): set_product_margin_floors / product_margin_floors
-- (20261025210000_product_margin_floors.sql). Run after apply, as ONE statement.
--
-- Auth probes (template smoke-auth-probe-template.sql):
--   P1 no-auth      claims ''                      -> AUTH_REQUIRED, nothing written
--   P2 anon-key     claims {"role":"anon"}, no sub -> AUTH_REQUIRED, nothing written
--   P3 wrong-role   an active non-admin            -> Permission denied: requires admin role
--   P4 forged actor an admin naming another actor  -> ACTOR_MISMATCH, nothing written
--   P5 positive     an active admin                -> floor set to 12.5%
-- Then the business chain on that product: the exact retry replays the same result, writes no second
-- history row and its receipt is bound to the admin; the same key with another floor is refused
-- (IDEMPOTENCY_INTENT_MISMATCH); 14.3% stores exactly 0.143; the same floor again changes nothing;
-- clearing removes the row; the history reads null>0.125>0.143>null with who and why; 100% is
-- refused. Always ends in SMOKE_PASS_ROLLBACK, so nothing persists.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_wrong uuid;
  v_product uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_key text;
  v_items jsonb;
  v_result jsonb;
  v_replay jsonb;
  v_floors_before bigint;
  v_history_before bigint;
  v_prior_history uuid[];
  v_history text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_wrong FROM public.profiles WHERE role IN ('driver', 'applicator', 'sales_rep') AND is_active
   ORDER BY CASE role WHEN 'driver' THEN 0 WHEN 'applicator' THEN 1 ELSE 2 END, created_at LIMIT 1;
  -- An active product, preferring one with no floor. Its earlier history stays, so only the rows this
  -- run adds are checked below.
  SELECT p.id INTO v_product FROM public.products p
   WHERE p.is_active
   ORDER BY EXISTS (SELECT 1 FROM public.product_margin_floors f WHERE f.product_id = p.id), p.created_at, p.id
   LIMIT 1;
  IF v_admin IS NULL OR v_wrong IS NULL OR v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: need an active admin, an active non-admin and an active product';
  END IF;
  -- Once every active product has a floor, start this one from "no floor" inside this rolled-back
  -- transaction: no history row is written and the floor is back when the chain rolls back.
  DELETE FROM public.product_margin_floors WHERE product_id = v_product;
  v_key := 'smoke:set_product_margin_floors:' || v_suffix;
  v_items := jsonb_build_array(jsonb_build_object('product_id', v_product, 'margin_floor_percent', 12.5));
  SELECT count(*) INTO v_floors_before FROM public.product_margin_floors;
  SELECT count(*) INTO v_history_before FROM public.product_margin_floor_changes;
  SELECT COALESCE(array_agg(id), '{}') INTO v_prior_history
    FROM public.product_margin_floor_changes WHERE product_id = v_product;

  -- P1 no-auth
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.set_product_margin_floors(v_items, 'smoke', NULL, v_key || ':p1');
    RAISE EXCEPTION 'SMOKE_FAIL P1: no-auth call succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL P1: %', SQLERRM; END IF;
  END;

  -- P2 anon key
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.set_product_margin_floors(v_items, 'smoke', NULL, v_key || ':p2');
    RAISE EXCEPTION 'SMOKE_FAIL P2: anon call succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL P2: %', SQLERRM; END IF;
  END;

  -- P3 wrong role
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_wrong, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_wrong::text, true);
  BEGIN
    PERFORM public.set_product_margin_floors(v_items, 'smoke', v_wrong, v_key || ':p3');
    RAISE EXCEPTION 'SMOKE_FAIL P3: non-admin call succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Permission denied: requires admin role%' THEN RAISE EXCEPTION 'SMOKE_FAIL P3: %', SQLERRM; END IF;
  END;

  -- P4 forged actor: an admin naming someone else.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  BEGIN
    PERFORM public.set_product_margin_floors(v_items, 'smoke', v_wrong, v_key || ':p4');
    RAISE EXCEPTION 'SMOKE_FAIL P4: forged actor succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'ACTOR_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL P4: %', SQLERRM; END IF;
  END;

  IF (SELECT count(*) FROM public.product_margin_floors) <> v_floors_before
     OR (SELECT count(*) FROM public.product_margin_floor_changes) <> v_history_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused probe wrote a floor or history row';
  END IF;

  -- P5 positive: admin sets 12.5%.
  v_result := public.set_product_margin_floors(v_items, 'smoke ' || v_suffix, v_admin, v_key);
  IF v_result IS DISTINCT FROM jsonb_build_object('success', true, 'status', 'saved', 'changed_count', 1, 'unchanged_count', 0) THEN
    RAISE EXCEPTION 'SMOKE_FAIL P5: unexpected result %', v_result;
  END IF;
  IF (SELECT margin_floor FROM public.product_margin_floors WHERE product_id = v_product) IS DISTINCT FROM 0.125 THEN
    RAISE EXCEPTION 'SMOKE_FAIL P5: floor not stored as 0.125';
  END IF;

  -- Exact replay: same result, no second history row, receipt bound to the admin.
  v_replay := public.set_product_margin_floors(v_items, 'smoke ' || v_suffix, v_admin, v_key);
  IF v_replay IS DISTINCT FROM v_result
     OR (SELECT count(*) FROM public.product_margin_floor_changes
          WHERE product_id = v_product AND id <> ALL (v_prior_history)) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL replay: % vs %', v_replay, v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.idempotency_keys
                  WHERE idempotency_key = v_key AND operation = 'set_product_margin_floors'
                    AND request_actor_id = v_admin AND request_fingerprint IS NOT NULL) THEN
    RAISE EXCEPTION 'SMOKE_FAIL receipt: not bound to the admin';
  END IF;

  -- Same key, another floor: refused.
  BEGIN
    PERFORM public.set_product_margin_floors(
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'margin_floor_percent', 13)), 'smoke ' || v_suffix, v_admin, v_key);
    RAISE EXCEPTION 'SMOKE_FAIL reuse: a changed request under the same key succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'IDEMPOTENCY_INTENT_MISMATCH%' THEN RAISE EXCEPTION 'SMOKE_FAIL reuse: %', SQLERRM; END IF;
  END;

  -- 14.3% stays exactly 0.143; the same floor again is a no-op; then clear it.
  PERFORM public.set_product_margin_floors(
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'margin_floor_percent', 14.3)), NULL, v_admin, v_key || ':b');
  IF (SELECT margin_floor FROM public.product_margin_floors WHERE product_id = v_product) IS DISTINCT FROM 0.143 THEN
    RAISE EXCEPTION 'SMOKE_FAIL change: floor not stored as 0.143';
  END IF;
  v_result := public.set_product_margin_floors(
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'margin_floor_percent', 14.3)), NULL, v_admin, v_key || ':c');
  IF v_result->>'changed_count' <> '0' OR v_result->>'unchanged_count' <> '1' THEN
    RAISE EXCEPTION 'SMOKE_FAIL unchanged: %', v_result;
  END IF;
  PERFORM public.set_product_margin_floors(
    jsonb_build_array(jsonb_build_object('product_id', v_product, 'margin_floor_percent', NULL)), 'cleared', v_admin, v_key || ':d');
  IF EXISTS (SELECT 1 FROM public.product_margin_floors WHERE product_id = v_product) THEN
    RAISE EXCEPTION 'SMOKE_FAIL clear: the floor row is still there';
  END IF;

  SELECT string_agg(COALESCE(old_margin_floor::text, '-') || '>' || COALESCE(new_margin_floor::text, '-')
                    || ':' || COALESCE(reason, '-') || ':' || (changed_by = v_admin)::text, ',' ORDER BY created_at, id)
    INTO v_history
    FROM public.product_margin_floor_changes WHERE product_id = v_product AND id <> ALL (v_prior_history);
  IF v_history IS DISTINCT FROM format('->0.125:smoke %s:true,0.125>0.143:-:true,0.143>-:cleared:true', v_suffix) THEN
    RAISE EXCEPTION 'SMOKE_FAIL history: %', v_history;
  END IF;

  -- Out of range.
  BEGIN
    PERFORM public.set_product_margin_floors(
      jsonb_build_array(jsonb_build_object('product_id', v_product, 'margin_floor_percent', 100)), NULL, v_admin, v_key || ':e');
    RAISE EXCEPTION 'SMOKE_FAIL range: 100%% succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'MARGIN_FLOOR_PERCENT_INVALID%' THEN RAISE EXCEPTION 'SMOKE_FAIL range: %', SQLERRM; END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
