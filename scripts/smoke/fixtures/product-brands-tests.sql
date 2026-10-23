-- Behaviour tests for 20261022086500_product_brands.sql, run by prove-product-brands.mjs after the
-- migration applied on the harness. Every test prints "PASS <id>"; any failure raises TEST_FAIL.
-- Actors: ...0a active admin, ...0b deactivated admin, ...0c sales rep, ...0d deactivated driver.

\set ON_ERROR_STOP 1

CREATE SCHEMA test;
GRANT USAGE ON SCHEMA test TO anon, authenticated, service_role;

-- Runs p_sql as the current role and passes only if it fails with a message starting p_expected.
CREATE FUNCTION test.expect_error(p_id text, p_sql text, p_expected text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE p_expected || '%' THEN
      RAISE NOTICE 'PASS %', p_id;
      RETURN;
    END IF;
    RAISE EXCEPTION 'TEST_FAIL %: expected "%", got "%"', p_id, p_expected, SQLERRM;
  END;
  RAISE EXCEPTION 'TEST_FAIL %: expected "%", but it succeeded', p_id, p_expected;
END;
$$;
GRANT EXECUTE ON FUNCTION test.expect_error(text, text, text) TO anon, authenticated, service_role;

CREATE FUNCTION test.pass(p_id text, p_ok boolean, p_detail text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'TEST_FAIL %: %', p_id, p_detail;
  END IF;
  RAISE NOTICE 'PASS %', p_id;
END;
$$;
GRANT EXECUTE ON FUNCTION test.pass(text, boolean, text) TO anon, authenticated, service_role;

-- ── As the active admin ──────────────────────────────────────────────────────────────────────
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);

-- B1: add a brand; it is saved trimmed, version 1, stamped with the admin.
SELECT test.pass('B1', r->>'brand_name' = 'Slam 5.4' AND (r->>'row_version')::int = 1
                 AND r->>'epa_registration' = '524-475' AND r->>'created_by' = '00000000-0000-0000-0000-00000000000a'
                 AND (r->>'is_rup') IS NULL AND r->>'signal_word' = 'Caution',
                 'unexpected saved row ' || r::text)
  FROM (SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1', '  Slam 5.4 ', '524-475', NULL,
          true, NULL, 'Caution', NULL, NULL, 'key-b1') AS r) s;

-- B2: the exact same request again replays the saved result; no second row.
SELECT test.pass('B2', (SELECT count(*) FROM public.product_brands) = 1
                 AND r->>'id' = (SELECT id::text FROM public.product_brands LIMIT 1),
                 'replay created a second row or returned another id')
  FROM (SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1', '  Slam 5.4 ', '524-475', NULL,
          true, NULL, 'Caution', NULL, NULL, 'key-b1') AS r) s;

-- B3: the same key with a changed request is refused, not replayed.
SELECT test.expect_error('B3', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'Slam 5.4', '524-999', NULL, true, NULL, 'Caution', NULL, NULL, 'key-b1')$q$, 'IDEMPOTENCY_INTENT_MISMATCH');

-- B4: one name per product, ignoring case; the same name is fine on another product.
SELECT test.expect_error('B4a', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'SLAM 5.4', NULL, NULL, true, NULL, NULL, NULL, NULL, 'key-b4a')$q$, 'BRAND_NAME_TAKEN');
SELECT test.pass('B4b', r->>'product_id' = '00000000-0000-0000-0000-0000000000a2', 'second product refused')
  FROM (SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a2', 'Slam 5.4', '524-475', NULL,
          true, NULL, NULL, NULL, NULL, 'key-b4b') AS r) s;

-- B5: EPA number shape: distributor numbers accepted, anything else refused; blank allowed.
SELECT test.pass('B5a', r->>'epa_registration' = '100-1234-5905', 'distributor number refused')
  FROM (SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1', 'Ag Saver 5.4', '100-1234-5905',
          'Agri Star', true, false, 'Warning', NULL, NULL, 'key-b5a') AS r) s;
SELECT test.expect_error('B5b', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'Bad Epa', 'EPA 524-475', NULL, true, NULL, NULL, NULL, NULL, 'key-b5b')$q$, 'EPA_REGISTRATION_INVALID');
SELECT test.pass('B5c', (r->>'epa_registration') IS NULL, 'blank EPA not stored as NULL')
  FROM (SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1', 'Unregistered Adjuvant', '  ',
          NULL, true, NULL, NULL, NULL, NULL, 'key-b5c') AS r) s;
-- B5d/B5e: the same shapes the EPA lookup accepts: no zero-led part, at most 6/5/6 digits.
SELECT test.expect_error('B5d', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'Zero Epa', '0-1', NULL, true, NULL, NULL, NULL, NULL, 'key-b5d')$q$, 'EPA_REGISTRATION_INVALID');
SELECT test.expect_error('B5e', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'Long Epa', '1234567-1', NULL, true, NULL, NULL, NULL, NULL, 'key-b5e')$q$, 'EPA_REGISTRATION_INVALID');
-- B5f: the table refuses it too, so no other writer can store an invalid number.
SELECT test.pass('B5f', count(*) = 1 AND bool_and(
    pg_get_constraintdef(c.oid) LIKE '%[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$%'
  ), 'the table has no single epa_registration check using the EPA lookup shapes')
  FROM pg_constraint c
 WHERE c.conrelid = 'public.product_brands'::regclass AND c.contype = 'c'
   AND pg_get_constraintdef(c.oid) LIKE '%epa_registration%';

-- B6: field checks.
SELECT test.expect_error('B6a', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  '   ', NULL, NULL, true, NULL, NULL, NULL, NULL, 'key-b6a')$q$, 'BRAND_NAME_REQUIRED');
SELECT test.expect_error('B6b', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'X', NULL, NULL, true, NULL, 'Poison', NULL, NULL, 'key-b6b')$q$, 'SIGNAL_WORD_INVALID');
SELECT test.expect_error('B6c', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'X', NULL, NULL, true, NULL, NULL, NULL, NULL, NULL)$q$, 'IDEMPOTENCY_KEY_REQUIRED');
SELECT test.expect_error('B6d', format($q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  %L, NULL, NULL, true, NULL, NULL, NULL, NULL, 'key-b6d')$q$, repeat('x', 201)), 'BRAND_TEXT_TOO_LONG');
SELECT test.expect_error('B6e', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000ff',
  'X', NULL, NULL, true, NULL, NULL, NULL, NULL, 'key-b6e')$q$, 'PRODUCT_NOT_FOUND');
SELECT test.expect_error('B6f', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'X', NULL, NULL, true, NULL, NULL, NULL, 1, 'key-b6f')$q$, 'ROW_VERSION_UNEXPECTED');

-- B7: edits need the version they read; a stale version is refused; the product can't change.
SELECT test.pass('B7a', (r->>'row_version')::int = 2 AND r->>'is_currently_sourced' = 'false' AND r->>'is_rup' = 'true',
                 'edit not applied ' || r::text)
  FROM (SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1', 'Slam 5.4', '524-475', NULL,
          false, true, 'Caution',
          (SELECT id FROM public.product_brands WHERE product_id = '00000000-0000-0000-0000-0000000000a1' AND brand_name = 'Slam 5.4'),
          1, 'key-b7a') AS r) s;
SELECT test.expect_error('B7b', format($q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'Slam 5.4', '524-475', NULL, true, true, 'Caution', %L, 1, 'key-b7b')$q$,
  (SELECT id FROM public.product_brands WHERE product_id = '00000000-0000-0000-0000-0000000000a1' AND brand_name = 'Slam 5.4')),
  'BRAND_CHANGED');
SELECT test.expect_error('B7c', format($q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'Slam 5.4', '524-475', NULL, true, true, 'Caution', %L, NULL, 'key-b7c')$q$,
  (SELECT id FROM public.product_brands WHERE product_id = '00000000-0000-0000-0000-0000000000a1' AND brand_name = 'Slam 5.4')),
  'ROW_VERSION_REQUIRED');
SELECT test.expect_error('B7d', format($q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a2',
  'Slam 5.4', '524-475', NULL, true, true, 'Caution', %L, 2, 'key-b7d')$q$,
  (SELECT id FROM public.product_brands WHERE product_id = '00000000-0000-0000-0000-0000000000a1' AND brand_name = 'Slam 5.4')),
  'BRAND_PRODUCT_MISMATCH');
SELECT test.expect_error('B7e', format($q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'Ag Saver 5.4', '524-475', NULL, true, true, 'Caution', %L, 2, 'key-b7e')$q$,
  (SELECT id FROM public.product_brands WHERE product_id = '00000000-0000-0000-0000-0000000000a1' AND brand_name = 'Slam 5.4')),
  'BRAND_NAME_TAKEN');

-- B8: no direct writes, even for an admin; reads work.
SELECT test.expect_error('B8a', $q$INSERT INTO public.product_brands (product_id, brand_name, created_by, updated_by)
  VALUES ('00000000-0000-0000-0000-0000000000a1', 'Sneaky', '00000000-0000-0000-0000-00000000000a',
          '00000000-0000-0000-0000-00000000000a')$q$, 'permission denied');
SELECT test.expect_error('B8b', $q$UPDATE public.product_brands SET epa_registration = '1-1'$q$, 'permission denied');
SELECT test.expect_error('B8c', $q$DELETE FROM public.product_brands$q$, 'permission denied');
SELECT test.pass('B8d', (SELECT count(*) FROM public.product_brands) = 4, 'admin cannot read all four brands');

-- ── As a deactivated admin ──────────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
SELECT test.expect_error('B9a', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'Slam 5.4', '524-475', NULL, true, NULL, 'Caution', NULL, NULL, 'key-b1')$q$, 'NOT_AUTHORIZED');

-- ── As a sales rep ──────────────────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000c', false);
SELECT test.expect_error('B9b', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'Rep Brand', NULL, NULL, true, NULL, NULL, NULL, NULL, 'key-b9b')$q$, 'NOT_AUTHORIZED');
SELECT test.pass('B9c', (SELECT count(*) FROM public.product_brands) = 4, 'expected an active sales rep to read all four brands');

-- ── As a deactivated driver ─────────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000d', false);
SELECT test.pass('B9d', (SELECT count(*) FROM public.product_brands) = 0, 'a deactivated profile can read brands');

-- ── With no sign-in ─────────────────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT test.expect_error('B9e', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'X', NULL, NULL, true, NULL, NULL, NULL, NULL, 'key-b9e')$q$, 'AUTH_REQUIRED');
RESET ROLE;

SET ROLE anon;
SELECT test.expect_error('B10a', $q$SELECT count(*) FROM public.product_brands$q$, 'permission denied');
SELECT test.expect_error('B10b', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'X', NULL, NULL, true, NULL, NULL, NULL, NULL, 'key-b10b')$q$, 'permission denied');
RESET ROLE;

SET ROLE service_role;
SELECT test.expect_error('B10c', $q$SELECT count(*) FROM public.product_brands$q$, 'permission denied');
SELECT test.expect_error('B10d', $q$SELECT public.upsert_product_brand('00000000-0000-0000-0000-0000000000a1',
  'X', NULL, NULL, true, NULL, NULL, NULL, NULL, 'key-b10d')$q$, 'permission denied');
RESET ROLE;

-- B11: the updated_at stamp moves on an edit and the replay receipt is bound to the admin.
-- The edit (B7a) ran in a later statement than the insert (B1), so a working trigger leaves updated_at strictly later.
SELECT test.pass('B11a', (SELECT updated_at > created_at FROM public.product_brands WHERE brand_name = 'Slam 5.4'
                            AND product_id = '00000000-0000-0000-0000-0000000000a1'), 'updated_at did not move on the edit');
SELECT test.pass('B11b', (SELECT count(*) FROM public.idempotency_keys
                           WHERE operation = 'upsert_product_brand'
                             AND (request_actor_id IS NULL OR request_fingerprint IS NULL)) = 0,
                 'a receipt was left unbound');

-- B12: both profile references have an index that starts with them, so a profile change never scans brands.
SELECT test.pass('B12', (SELECT count(DISTINCT a.attname) FROM pg_index i
                          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
                         WHERE i.indrelid = 'public.product_brands'::regclass
                           AND a.attname IN ('created_by', 'updated_by')) = 2,
                 'a profile reference has no index');
