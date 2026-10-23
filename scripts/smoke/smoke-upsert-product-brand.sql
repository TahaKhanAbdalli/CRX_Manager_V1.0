-- ============================================================================
-- SMOKE CHAIN (rolled back by design): upsert_product_brand / product_brands
-- (20261022086500_product_brands.sql). Run after apply, as ONE statement.
--
-- Auth probes (template smoke-auth-probe-template.sql; the RPC has NO actor parameter, the actor is
-- auth.uid(), so P4 "forged actor" does not apply):
--   P1 no-auth      claims ''                      -> AUTH_REQUIRED, nothing written
--   P2 anon-key     claims {"role":"anon"}, no sub -> AUTH_REQUIRED, nothing written
--   P3 wrong-role   an active non-admin            -> NOT_AUTHORIZED, nothing written
--   P5 positive     an active admin                -> brand added
-- Then the business chain on that brand: exact replay returns the same row; an edit with the
-- version it read bumps the version; a stale edit is refused (BRAND_CHANGED); a second brand with
-- the same name in other case is refused (BRAND_NAME_TAKEN); the receipt is bound to the admin.
-- Always ends in SMOKE_PASS_ROLLBACK, so nothing persists.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_wrong uuid;
  v_product uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_name text;
  v_key text;
  v_result jsonb;
  v_replay jsonb;
  v_edit jsonb;
  v_before bigint;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_wrong FROM public.profiles WHERE role IN ('driver', 'applicator', 'sales_rep') AND is_active
   ORDER BY CASE role WHEN 'driver' THEN 0 WHEN 'applicator' THEN 1 ELSE 2 END, created_at LIMIT 1;
  SELECT id INTO v_product FROM public.products WHERE is_active ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_wrong IS NULL OR v_product IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: need an active admin, an active non-admin and an active product';
  END IF;
  v_name := 'Smoke Brand ' || v_suffix;
  v_key := 'smoke:upsert_product_brand:' || v_suffix;
  SELECT count(*) INTO v_before FROM public.product_brands;

  -- P1 no-auth
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    PERFORM public.upsert_product_brand(v_product, v_name, '524-475', NULL, true, NULL, NULL, NULL, NULL, v_key || ':p1');
    RAISE EXCEPTION 'SMOKE_FAIL P1: no-auth call succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL P1: %', SQLERRM; END IF;
  END;

  -- P2 anon key
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    PERFORM public.upsert_product_brand(v_product, v_name, '524-475', NULL, true, NULL, NULL, NULL, NULL, v_key || ':p2');
    RAISE EXCEPTION 'SMOKE_FAIL P2: anon call succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'AUTH_REQUIRED%' THEN RAISE EXCEPTION 'SMOKE_FAIL P2: %', SQLERRM; END IF;
  END;

  -- P3 wrong role
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_wrong, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_wrong::text, true);
  BEGIN
    PERFORM public.upsert_product_brand(v_product, v_name, '524-475', NULL, true, NULL, NULL, NULL, NULL, v_key || ':p3');
    RAISE EXCEPTION 'SMOKE_FAIL P3: non-admin call succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'NOT_AUTHORIZED%' THEN RAISE EXCEPTION 'SMOKE_FAIL P3: %', SQLERRM; END IF;
  END;

  IF (SELECT count(*) FROM public.product_brands) <> v_before THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused probe wrote a brand';
  END IF;

  -- P5 positive: admin adds a brand.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_result := public.upsert_product_brand(v_product, v_name, '524-475', 'Smoke Co', true, NULL, 'Caution', NULL, NULL, v_key);
  IF v_result->>'brand_name' <> v_name OR (v_result->>'row_version')::int <> 1
     OR v_result->>'created_by' <> v_admin::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL P5: unexpected saved row %', v_result;
  END IF;

  -- Exact replay: same row, nothing new.
  v_replay := public.upsert_product_brand(v_product, v_name, '524-475', 'Smoke Co', true, NULL, 'Caution', NULL, NULL, v_key);
  IF v_replay->>'id' <> v_result->>'id' OR (SELECT count(*) FROM public.product_brands) <> v_before + 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL replay: % vs %', v_replay, v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.idempotency_keys
                  WHERE idempotency_key = v_key AND operation = 'upsert_product_brand'
                    AND request_actor_id = v_admin AND request_fingerprint IS NOT NULL) THEN
    RAISE EXCEPTION 'SMOKE_FAIL receipt: not bound to the admin';
  END IF;

  -- Edit with the version read; then a stale edit.
  v_edit := public.upsert_product_brand(v_product, v_name, '524-475', 'Smoke Co', false, true, 'Caution',
    (v_result->>'id')::uuid, 1, v_key || ':edit');
  IF (v_edit->>'row_version')::int <> 2 OR (v_edit->>'is_currently_sourced')::boolean THEN
    RAISE EXCEPTION 'SMOKE_FAIL edit: %', v_edit;
  END IF;
  BEGIN
    PERFORM public.upsert_product_brand(v_product, v_name, '524-475', NULL, true, NULL, NULL,
      (v_result->>'id')::uuid, 1, v_key || ':stale');
    RAISE EXCEPTION 'SMOKE_FAIL stale: stale edit succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BRAND_CHANGED%' THEN RAISE EXCEPTION 'SMOKE_FAIL stale: %', SQLERRM; END IF;
  END;

  -- Same name in another case on the same product.
  BEGIN
    PERFORM public.upsert_product_brand(v_product, upper(v_name), NULL, NULL, true, NULL, NULL, NULL, NULL, v_key || ':dup');
    RAISE EXCEPTION 'SMOKE_FAIL dup: duplicate name succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'BRAND_NAME_TAKEN%' THEN RAISE EXCEPTION 'SMOKE_FAIL dup: %', SQLERRM; END IF;
  END;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
