-- RUP sales register: admins only (Goal 1, docs/plans/2026-10-13-direction-and-goals.md).
--
-- Rule: "Only admins can pull the restricted-use register." A sales rep, driver,
-- applicator, commission-recipient (entity_recipient) profile, deactivated
-- account and signed-out visitor are each refused.
--
-- Live state measured read-only immediately before this migration was written
-- (2026-10-14):
--   * public.get_rup_sales_register(date,date,uuid,uuid,text,boolean) is
--     SECURITY DEFINER, owned by postgres (so it reads past RLS), EXECUTE to
--     authenticated and service_role, and has no caller check at all. Any
--     signed-in profile, of any role, active or not while its access token is
--     still valid, can call it and read every register row.
--     md5(prosrc) = e7c680dd7aef368f9b2e9bc926328d47.
--   * public.rup_sales_records policy rup_sales_select lets an active admin OR
--     sales_rep read every row directly; anon holds a table-level SELECT and
--     MAINTAIN grant (matched by no policy, so 0 rows, but never needed).
--   * The table holds 0 rows today, so no register data has been exposed yet.
--
-- Change:
--   1. get_rup_sales_register first calls public.require_admin(), which raises
--      'Permission denied: requires admin role' unless auth.uid() is an ACTIVE
--      admin profile. Signature, return columns, SECURITY DEFINER and
--      search_path are unchanged; the body after the gate is verbatim.
--   2. rup_sales_select becomes public.is_admin() (active admin only).
--   3. anon loses every table privilege on rup_sales_records.
--
-- Not changed: generate_rup_sales_records (invoice posting by reps still writes
-- register rows; it returns only a count) and unpost_invoice's void path. Both
-- run as the table owner. The Compliance page stays open to sales reps for
-- licenses, RUP products and field listings; only the register tab is hidden.
--
-- Read-only function: no p_idempotency_key (the hard rule covers mutating RPCs).
-- Non-destructive: no row is changed or deleted. Access-changing (ALTER POLICY,
-- REVOKE on an existing table), so it needs Mason's own approval of this file.
-- Re-runnable: the preflight accepts the already-gated body, and the verify
-- block checks the final shape.
-- Rollback (restores the previous access exactly):
--   CREATE OR REPLACE the function from
--     supabase/migrations/20260630173050_parked_006_rup_sales_records_unpost_void.sql
--     (without the PERFORM public.require_admin() line);
--   ALTER POLICY rup_sales_select ON public.rup_sales_records USING ((
--     SELECT profiles.role FROM public.profiles
--     WHERE profiles.id = (SELECT auth.uid()) AND profiles.is_active = true
--   ) = ANY (ARRAY['admin'::text, 'sales_rep'::text]));
--   GRANT SELECT, MAINTAIN ON public.rup_sales_records TO anon;

-- Preflight: refuse to run against a definition that drifted since it was read.
DO $preflight$
DECLARE
  v_overloads int;
  v_src text;
  v_qual text;
BEGIN
  SELECT count(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_rup_sales_register';
  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'RUP_REGISTER_PREFLIGHT: expected 1 get_rup_sales_register overload, found %', v_overloads;
  END IF;

  SELECT p.prosrc INTO v_src
  FROM pg_proc p
  WHERE p.oid = 'public.get_rup_sales_register(date,date,uuid,uuid,text,boolean)'::regprocedure;
  -- The live body of 2026-10-14, or this file's own body (a re-run).
  IF md5(replace(v_src, chr(13), '')) NOT IN ('e7c680dd7aef368f9b2e9bc926328d47', '01a56f57845ccc8fcc0bc91cfd114045') THEN
    RAISE EXCEPTION 'RUP_REGISTER_PREFLIGHT: get_rup_sales_register drifted from the 2026-10-14 body (md5 %)', md5(replace(v_src, chr(13), ''));
  END IF;

  -- The live policy of 2026-10-14 (admin or sales rep), or this file's own (a re-run).
  SELECT md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '')) INTO v_qual
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'rup_sales_records' AND policyname = 'rup_sales_select';
  IF v_qual IS NULL OR v_qual NOT IN ('d382425513fedb4d62d8adba408cea49', '470addb13f16dc0be2235f1027a560db') THEN
    RAISE EXCEPTION 'RUP_REGISTER_PREFLIGHT: policy rup_sales_select is missing or drifted from the 2026-10-14 definition (md5 %)', v_qual;
  END IF;

  -- The gate is only as strong as these two helpers: pin them to the live bodies read
  -- 2026-10-14 (both require profiles.id = auth.uid(), role = 'admin' and is_active = true).
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.require_admin()')) IS DISTINCT FROM '83dbda095d67a37031d5cd093a605a78' THEN
    RAISE EXCEPTION 'RUP_REGISTER_PREFLIGHT: public.require_admin() is missing or drifted from the 2026-10-14 body';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.is_admin()')) IS DISTINCT FROM 'f76bf61116c3bd52bd9c6ea125079b73' THEN
    RAISE EXCEPTION 'RUP_REGISTER_PREFLIGHT: public.is_admin() is missing or drifted from the 2026-10-14 body';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.get_rup_sales_register(
  p_start_date date DEFAULT NULL::date,
  p_end_date date DEFAULT NULL::date,
  p_product_id uuid DEFAULT NULL::uuid,
  p_customer_id uuid DEFAULT NULL::uuid,
  p_compliance_status text DEFAULT NULL::text,
  p_include_voided boolean DEFAULT false
)
RETURNS TABLE(
  id uuid, sale_date date, invoice_id uuid, customer_id uuid,
  buyer_name text, product_name text, epa_registration text,
  quantity numeric, unit text, unit_price_cents bigint, total_cents bigint,
  buyer_certification_number text, buyer_certification_type text,
  buyer_certification_expiry date, signal_word text,
  compliance_status text, compliance_notes text, season integer,
  voided_at timestamp with time zone, voided_by uuid, void_reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Admins only: refuses non-admins, deactivated profiles and calls with no
  -- signed-in user (auth.uid() IS NULL) before any row is read.
  PERFORM public.require_admin();

  RETURN QUERY
  SELECT
    r.id, r.sale_date, r.invoice_id, r.customer_id,
    r.buyer_name, r.product_name, r.epa_registration,
    r.quantity, r.unit, r.unit_price_cents, r.total_cents,
    r.buyer_certification_number, r.buyer_certification_type,
    r.buyer_certification_expiry, r.signal_word,
    r.compliance_status, r.compliance_notes, r.season,
    r.voided_at, r.voided_by, r.void_reason
  FROM rup_sales_records r
  WHERE (p_start_date IS NULL OR r.sale_date >= p_start_date)
    AND (p_end_date   IS NULL OR r.sale_date <= p_end_date)
    AND (p_product_id IS NULL OR r.product_id = p_product_id)
    AND (p_customer_id IS NULL OR r.customer_id = p_customer_id)
    AND (p_compliance_status IS NULL OR r.compliance_status = p_compliance_status)
    AND (p_include_voided OR r.voided_at IS NULL)
  ORDER BY r.sale_date DESC, r.buyer_name;
END;
$function$;

-- CREATE OR REPLACE keeps the existing ACL; restate it so the final grants do
-- not depend on history. Only PUBLIC and anon lose EXECUTE (anon never had it
-- live); authenticated keeps it and the body's require_admin() does the gating.
-- caller-analysis: get_rup_sales_register :: the only caller is src/pages/Compliance.tsx (RUP Sales Register tab), which runs as authenticated and keeps EXECUTE; this branch shows that tab only to admins, and require_admin() refuses everyone else in the database. No edge function, cron or other SQL function calls it (grep of src, supabase/functions, scripts, and live pg_proc bodies, 2026-10-14).
REVOKE ALL ON FUNCTION public.get_rup_sales_register(date, date, uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_rup_sales_register(date, date, uuid, uuid, text, boolean) TO authenticated, service_role;

ALTER POLICY rup_sales_select ON public.rup_sales_records
  USING ((SELECT public.is_admin()));

REVOKE ALL ON TABLE public.rup_sales_records FROM anon;

-- Verify inside the same transaction; any mismatch rolls the whole file back.
DO $verify$
DECLARE
  v_proc regprocedure := 'public.get_rup_sales_register(date,date,uuid,uuid,text,boolean)'::regprocedure;
  v_src text;
  v_secdef boolean;
  v_config text[];
  v_qual text;
BEGIN
  SELECT p.prosrc, p.prosecdef, p.proconfig INTO v_src, v_secdef, v_config
  FROM pg_proc p WHERE p.oid = v_proc;

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'RUP_REGISTER_VERIFY: get_rup_sales_register is no longer SECURITY DEFINER';
  END IF;
  IF v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'RUP_REGISTER_VERIFY: unexpected proconfig %', v_config;
  END IF;
  -- The exact body this file installs (the gate first, then the live query verbatim).
  IF md5(replace(v_src, chr(13), '')) <> '01a56f57845ccc8fcc0bc91cfd114045' THEN
    RAISE EXCEPTION 'RUP_REGISTER_VERIFY: get_rup_sales_register body is not the gated body (md5 %)', md5(replace(v_src, chr(13), ''));
  END IF;

  IF has_function_privilege('anon', v_proc, 'EXECUTE') THEN
    RAISE EXCEPTION 'RUP_REGISTER_VERIFY: anon can still execute get_rup_sales_register';
  END IF;
  IF NOT has_function_privilege('authenticated', v_proc, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_proc, 'EXECUTE') THEN
    RAISE EXCEPTION 'RUP_REGISTER_VERIFY: authenticated/service_role lost EXECUTE on get_rup_sales_register';
  END IF;

  SELECT qual INTO v_qual
  FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'rup_sales_records' AND policyname = 'rup_sales_select'
    AND cmd = 'SELECT' AND permissive = 'PERMISSIVE' AND roles = '{authenticated}'::name[];
  IF v_qual IS DISTINCT FROM '( SELECT is_admin() AS is_admin)' THEN
    RAISE EXCEPTION 'RUP_REGISTER_VERIFY: rup_sales_select is not the admin-only SELECT policy: %', v_qual;
  END IF;
  -- A policy only binds while row-level security is on for the table.
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.rup_sales_records'::regclass) THEN
    RAISE EXCEPTION 'RUP_REGISTER_VERIFY: row-level security is not enabled on rup_sales_records';
  END IF;
  -- Permissive policies add up: no other read policy may widen the table again.
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'rup_sales_records'
      AND cmd IN ('SELECT', 'ALL') AND policyname <> 'rup_sales_select'
  ) THEN
    RAISE EXCEPTION 'RUP_REGISTER_VERIFY: another SELECT/ALL policy exists on rup_sales_records';
  END IF;

  IF has_table_privilege('anon', 'public.rup_sales_records', 'SELECT')
     OR has_table_privilege('anon', 'public.rup_sales_records', 'INSERT')
     OR has_table_privilege('anon', 'public.rup_sales_records', 'UPDATE')
     OR has_table_privilege('anon', 'public.rup_sales_records', 'DELETE')
     OR has_table_privilege('anon', 'public.rup_sales_records', 'TRUNCATE')
     OR has_table_privilege('anon', 'public.rup_sales_records', 'REFERENCES')
     OR has_table_privilege('anon', 'public.rup_sales_records', 'TRIGGER')
     OR has_table_privilege('anon', 'public.rup_sales_records', 'MAINTAIN') THEN
    RAISE EXCEPTION 'RUP_REGISTER_VERIFY: anon still holds a privilege on rup_sales_records';
  END IF;
END
$verify$;
