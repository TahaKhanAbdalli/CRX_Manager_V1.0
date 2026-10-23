-- STATUS: NOT APPLIED.
-- Generic products list the real brands that may fill them (step 1, PR A).
--
-- Why: CRX quotes and prices a generic product ("Roundup 5.4# Generic") but delivers one of several
-- real brands, each with its own EPA registration number. Today a product can hold one EPA number,
-- and the acceptable brands live only as text inside the product name. Plan:
-- docs/plans/2026-10-22-product-brands-step1-PLAN.md (section 4, item 1).
--
-- What this file does (new objects only; no existing table, function, policy or row changes):
--   1. product_brands: one row per acceptable brand of a product, with its own EPA number,
--      manufacturer, "currently sourced" switch, restricted-use flag and signal word. Everyone
--      signed in with an active profile may read it; no API role may write it directly.
--   2. upsert_product_brand: the one way to add or edit a brand. Admin only, retry key required and
--      bound to the caller and the request, and an edit must name the version it read so two admins
--      can't silently overwrite each other. A brand is retired by switching is_currently_sourced
--      off, never deleted, so later delivery records can keep pointing at it.
--
-- Nothing reads this table yet; delivery capture and paperwork come in PR B. A brand may be added to
-- an inactive product (an admin may set brands up before reactivating it).
--
-- idempotency-body-check: exempt. upsert_product_brand reads idempotency_keys through
--   check_idempotency_intent (the caller- and request-bound lookup, as in
--   20261019220000_start_and_complete_delivery.sql) and records its result through save_idempotency
--   plus _bind_replay_receipt_20261015; the hook recognizes only the older check_idempotency.
--
-- COMMIT-TIME GUARD: the deferred trigger require_bound_replay_receipt_20261015 is not extended to
--   this operation, for the reasons 20261019220000 gives: only this function writes an
--   'upsert_product_brand' receipt and binds it in the same call (_bind_replay_receipt_20261015
--   raises IDEMPOTENCY_RECEIPT_MISSING if none was written), save_idempotency is not executable by
--   authenticated, and recreating the trigger would race the replay-binding batches that own it.
--
-- GRANTS: only the routine lock-down of the two objects this file creates (the table readable by
--   authenticated, the function executable by authenticated); no existing object's access changes.
--   service_role and metabase_ro get no access to the table; PR B reads it with the user's session.
--
-- ORDERING: coordinator stamp 20261022086500, migration-history row 975. Re-read the live ledger
--   before applying and confirm this stamp sorts above its newest effective stamp.
--
-- ROLLBACK (only while no later table references product_brands):
--   DROP FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text);
--   DROP TABLE public.product_brands;

SET LOCAL lock_timeout = '5s';

-- PREFLIGHT: every function this file calls exists with the signature it calls (PL/pgSQL resolves
-- calls only at run time, so a missing one would otherwise fail on the first save), and neither new
-- object exists yet.
DO $preflight$
DECLARE
  v_sig text;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public.check_idempotency_intent(text,text,uuid,text)',
    'public.save_idempotency(text,text,jsonb)',
    'public._bind_replay_receipt_20261015(text,text,text)',
    'public._replay_fingerprint_20261015(jsonb)',
    'public.is_admin()',
    'public.is_active_profile()',
    'public.update_updated_at()'
  ] LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'PREFLIGHT_PRODUCT_BRANDS_DEPENDENCY_MISSING: %', v_sig;
    END IF;
  END LOOP;
  IF to_regclass('public.product_brands') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_PRODUCT_BRANDS_TABLE_EXISTS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'upsert_product_brand') THEN
    RAISE EXCEPTION 'PREFLIGHT_UPSERT_PRODUCT_BRAND_EXISTS';
  END IF;
END;
$preflight$;

CREATE TABLE public.product_brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  brand_name text NOT NULL CHECK (
    btrim(brand_name) <> '' AND brand_name = btrim(brand_name) AND char_length(brand_name) <= 200
  ),
  -- Blank only for an unregistered product (some adjuvants); PR B decides what paperwork prints then.
  -- Same shapes the EPA lookup accepts (supabase/functions/epa-lookup/logic.ts): a Section 3 number
  -- (company-product) or a distributor number (company-product-distributor), no zero-led parts.
  epa_registration text CHECK (
    epa_registration IS NULL OR epa_registration ~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$'
  ),
  manufacturer text CHECK (
    manufacturer IS NULL
    OR (btrim(manufacturer) <> '' AND manufacturer = btrim(manufacturer) AND char_length(manufacturer) <= 200)
  ),
  is_currently_sourced boolean NOT NULL DEFAULT true,
  -- NULL means not yet confirmed. Restricted-use status belongs to the registration, so two brands of
  -- one generic can differ; the delivery's RUP record will follow the brand, not the generic (PR B).
  is_rup boolean,
  signal_word text CHECK (signal_word IS NULL OR signal_word IN ('Danger', 'Warning', 'Caution')),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Lets a later table bind (product_id, brand_id) so a Roundup line can't carry a Liberty brand.
  CONSTRAINT product_brands_product_id_id_key UNIQUE (product_id, id)
);

ALTER TABLE public.product_brands OWNER TO postgres;

CREATE UNIQUE INDEX uq_product_brands_product_name
  ON public.product_brands(product_id, lower(brand_name));

-- product_id is already covered by the two unique keys above; the profile references need their own
-- so a profile change never scans this table for its RESTRICT check.
CREATE INDEX idx_product_brands_created_by ON public.product_brands(created_by);
CREATE INDEX idx_product_brands_updated_by ON public.product_brands(updated_by);

ALTER TABLE public.product_brands ENABLE ROW LEVEL SECURITY;

CREATE POLICY product_brands_select
  ON public.product_brands
  FOR SELECT TO authenticated
  USING ((SELECT public.is_active_profile()));

-- Supabase default privileges grant every API role full table access; take it all back and give
-- the app read access only. Writes go through upsert_product_brand.
REVOKE ALL ON TABLE public.product_brands FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_brands TO authenticated;

CREATE TRIGGER set_product_brands_updated_at
  BEFORE UPDATE ON public.product_brands
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

COMMENT ON TABLE public.product_brands IS
  'Acceptable real brands of a (usually generic) product, each with its own EPA registration. Read by active profiles; written only through upsert_product_brand (admin). Retired by is_currently_sourced = false, never deleted.';

CREATE OR REPLACE FUNCTION public.upsert_product_brand(
  p_product_id uuid,
  p_brand_name text,
  p_epa_registration text,
  p_manufacturer text,
  p_is_currently_sourced boolean,
  p_is_rup boolean,
  p_signal_word text,
  p_brand_id uuid DEFAULT NULL,
  p_expected_row_version integer DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_brand_name text := btrim(p_brand_name);
  v_epa text := NULLIF(btrim(p_epa_registration), '');
  v_manufacturer text := NULLIF(btrim(p_manufacturer), '');
  v_fingerprint text;
  v_replay jsonb;
  v_existing public.product_brands%ROWTYPE;
  v_saved public.product_brands%ROWTYPE;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: upsert_product_brand requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  -- Authorize before the receipt lookup, so a demoted or deactivated admin gets neither a replay
  -- nor a refusal that carries the saved result.
  IF NOT (SELECT public.is_admin()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: only an admin can change a product''s brands' USING ERRCODE = '42501';
  END IF;

  -- Input checks that never change between attempts run before the receipt lookup, so a bad input
  -- gets its own message rather than an intent mismatch.
  IF v_brand_name IS NULL OR v_brand_name = '' THEN
    RAISE EXCEPTION 'BRAND_NAME_REQUIRED: enter the brand name' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_brand_name) > 200 OR char_length(v_manufacturer) > 200 THEN
    RAISE EXCEPTION 'BRAND_TEXT_TOO_LONG: brand and manufacturer names are limited to 200 characters' USING ERRCODE = '22023';
  END IF;
  IF v_epa IS NOT NULL AND v_epa !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' THEN
    RAISE EXCEPTION 'EPA_REGISTRATION_INVALID: % is not an EPA registration number (like 524-475 or 100-1234-5905)', v_epa
      USING ERRCODE = '22023';
  END IF;
  IF p_is_currently_sourced IS NULL THEN
    RAISE EXCEPTION 'CURRENTLY_SOURCED_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_signal_word IS NOT NULL AND p_signal_word NOT IN ('Danger', 'Warning', 'Caution') THEN
    RAISE EXCEPTION 'SIGNAL_WORD_INVALID: %', p_signal_word USING ERRCODE = '22023';
  END IF;
  IF p_brand_id IS NULL AND p_expected_row_version IS NOT NULL THEN
    RAISE EXCEPTION 'ROW_VERSION_UNEXPECTED: a new brand has no version yet' USING ERRCODE = '22023';
  END IF;
  IF p_brand_id IS NOT NULL AND p_expected_row_version IS NULL THEN
    RAISE EXCEPTION 'ROW_VERSION_REQUIRED: an edit must name the version it read' USING ERRCODE = '22023';
  END IF;

  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'product_id', p_product_id,
    'brand_id', p_brand_id,
    'brand_name', p_brand_name,
    'epa_registration', p_epa_registration,
    'manufacturer', p_manufacturer,
    'is_currently_sourced', p_is_currently_sourced,
    'is_rup', p_is_rup,
    'signal_word', p_signal_word,
    'expected_row_version', p_expected_row_version
  ));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'upsert_product_brand', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  IF p_brand_id IS NULL THEN
    -- The foreign key also enforces this; checking first gives a plain message.
    IF NOT EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id) THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND: %', p_product_id USING ERRCODE = 'P0002';
    END IF;
    BEGIN
      INSERT INTO public.product_brands (
        product_id, brand_name, epa_registration, manufacturer, is_currently_sourced,
        is_rup, signal_word, created_by, updated_by
      ) VALUES (
        p_product_id, v_brand_name, v_epa, v_manufacturer, p_is_currently_sourced,
        p_is_rup, p_signal_word, v_actor, v_actor
      )
      RETURNING * INTO v_saved;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'BRAND_NAME_TAKEN: this product already lists a brand named %', v_brand_name
        USING ERRCODE = '23505';
    END;
  ELSE
    SELECT * INTO v_existing FROM public.product_brands WHERE id = p_brand_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'BRAND_NOT_FOUND: %', p_brand_id USING ERRCODE = 'P0002';
    END IF;
    -- A brand never moves to another product: its EPA number and later delivery records belong to this one.
    IF v_existing.product_id IS DISTINCT FROM p_product_id THEN
      RAISE EXCEPTION 'BRAND_PRODUCT_MISMATCH: brand % belongs to another product', p_brand_id USING ERRCODE = '22023';
    END IF;
    IF v_existing.row_version IS DISTINCT FROM p_expected_row_version THEN
      RAISE EXCEPTION 'BRAND_CHANGED: someone else changed this brand; reload and try again'
        USING ERRCODE = '40001',
              DETAIL = format('expected version %s, found %s', p_expected_row_version, v_existing.row_version);
    END IF;
    BEGIN
      UPDATE public.product_brands
         SET brand_name = v_brand_name,
             epa_registration = v_epa,
             manufacturer = v_manufacturer,
             is_currently_sourced = p_is_currently_sourced,
             is_rup = p_is_rup,
             signal_word = p_signal_word,
             row_version = v_existing.row_version + 1,
             updated_by = v_actor
       WHERE id = p_brand_id
      RETURNING * INTO v_saved;
    EXCEPTION WHEN unique_violation THEN
      RAISE EXCEPTION 'BRAND_NAME_TAKEN: this product already lists a brand named %', v_brand_name
        USING ERRCODE = '23505';
    END;
  END IF;

  v_result := to_jsonb(v_saved);
  PERFORM public.save_idempotency(p_idempotency_key, 'upsert_product_brand', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'upsert_product_brand', v_fingerprint);
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text) FROM PUBLIC, anon, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text) TO authenticated;

COMMENT ON FUNCTION public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text) IS
  'Admin-only add or edit of a product brand (product_brands). Retry key required and bound to caller + request; an edit must pass the row_version it read. Never deletes; retire with p_is_currently_sourced = false.';

-- POSTFLIGHT: prove the final shape and access, so a stray default privilege can't survive the apply.
DO $postflight$
BEGIN
  IF (SELECT relowner FROM pg_class WHERE oid = 'public.product_brands'::regclass) <> 'postgres'::regrole THEN
    RAISE EXCEPTION 'PRODUCT_BRANDS_POSTFLIGHT: table is not owned by postgres';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.product_brands'::regclass) THEN
    RAISE EXCEPTION 'PRODUCT_BRANDS_POSTFLIGHT: RLS is not enabled';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.product_brands'::regclass) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policy
                     WHERE polrelid = 'public.product_brands'::regclass
                       AND polname = 'product_brands_select' AND polcmd = 'r') THEN
    RAISE EXCEPTION 'PRODUCT_BRANDS_POSTFLIGHT: expected exactly one SELECT policy';
  END IF;
  IF has_table_privilege('authenticated', 'public.product_brands', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR NOT has_table_privilege('authenticated', 'public.product_brands', 'SELECT')
     OR has_table_privilege('anon', 'public.product_brands', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('service_role', 'public.product_brands', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     OR (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro')
         AND has_table_privilege('metabase_ro', 'public.product_brands', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')) THEN
    RAISE EXCEPTION 'PRODUCT_BRANDS_POSTFLIGHT: table privileges are not read-only for authenticated';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'upsert_product_brand'
         AND p.prosecdef AND p.proowner = 'postgres'::regrole
         AND p.proconfig = ARRAY['search_path=public, pg_temp']) <> 1
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'upsert_product_brand') <> 1 THEN
    RAISE EXCEPTION 'PRODUCT_BRANDS_POSTFLIGHT: expected exactly one upsert_product_brand, SECURITY DEFINER, owned by postgres, search_path public, pg_temp';
  END IF;
  -- EXECUTE exactly for the owner and authenticated.
  IF (SELECT array_agg(DISTINCT grantee::regrole::text ORDER BY grantee::regrole::text)
        FROM pg_proc p, aclexplode(p.proacl)
       WHERE p.oid = 'public.upsert_product_brand(uuid, text, text, text, boolean, boolean, text, uuid, integer, text)'::regprocedure
         AND privilege_type = 'EXECUTE')
     IS DISTINCT FROM ARRAY['authenticated', 'postgres'] THEN
    RAISE EXCEPTION 'PRODUCT_BRANDS_POSTFLIGHT: upsert_product_brand EXECUTE must be exactly postgres and authenticated';
  END IF;
END;
$postflight$;
