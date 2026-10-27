-- Written 2026-10-27. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 997). Stamp and row are PLACEHOLDERS from Taha's
-- fork: the CRX Coordinator session should assign the final stamp/row. Lands after
-- 20261027080000 (row 996). Re-read the live ledger first.
--
-- idempotency-body-check: exempt -- neither function takes p_idempotency_key; each only reads a
--   sequence and returns the next number (no row written).
--
-- WHAT: quote and order numbers come only from the people and server functions that use them
--   (Mason, 2026-10-26 and 2026-10-27: drivers do not take numbers).
--   1. EXECUTE on generate_quote_number() / generate_order_number() is revoked from PUBLIC and anon,
--      and anon's grants on quote_number_seq / order_number_seq are revoked.
--   2. A direct call from a signed-in account must come from an active account (PROFILE_INACTIVE)
--      that is an admin or a sales rep (NUMBER_ROLE_REQUIRED). The only app screens that call them,
--      Quote Builder and Blend Ticket Detail, are admin and sales-rep pages.
--   The 8 server functions that call these (convert, draw-down, direct/rush order, quick delivery,
--   duplicate, template, rollover) are SECURITY DEFINER, so inside them current_user is the owner
--   and neither check applies. The number format is unchanged.
--
-- NOT CHANGED: owner, SECURITY INVOKER, search_path=public, volatility, the returned number format,
--   authenticated and service_role EXECUTE, authenticated's sequence grants (the INVOKER nextval needs
--   them); global_search (a deactivated user already gets no rows: is_admin()/is_sales_rep() require
--   is_active); every other function, policy, grant and row.
--
-- CALLERS (checked 2026-10-27 on main fe258c2f):
-- caller-analysis: generate_quote_number :: anon/PUBLIC revoke + admin/sales-rep rule; app caller src/pages/QuoteBuilder.tsx (route roles admin, sales_rep) keeps working; DB callers are SECURITY DEFINER (run as postgres)
-- caller-analysis: generate_order_number :: anon/PUBLIC revoke + admin/sales-rep rule; app caller src/pages/BlendTicketDetail.tsx (openCreateOrderModal; route roles admin, sales_rep) keeps working; DB callers are SECURITY DEFINER (run as postgres); no cron job, view or policy references it
--
-- EVIDENCE: read on a local replay of main d5fd2bf8 (no live access from the fork); Mason to re-read
--   live before applying: both owner postgres, plpgsql, VOLATILE, not SECURITY DEFINER,
--   search_path=public, ACL {postgres=X/postgres,=X/postgres,anon=X/postgres,authenticated=X/postgres,
--   service_role=X/postgres}; body md5 (CR stripped) quote 6fa7163869f2b0c01e9665d258fc5587,
--   order df0e5440a3518ecf7fb6a21ad7a97aeb. quote_number_seq / order_number_seq: anon=rwU.
--
-- ROLLBACK: re-run the two prior bodies (pinned md5s above: RETURN 'Q-'|'ORD-' || year || '-' ||
--   lpad(nextval(seq)::text, 4, '0')); GRANT EXECUTE ON FUNCTION public.generate_quote_number(),
--   public.generate_order_number() TO PUBLIC, anon; GRANT USAGE, SELECT, UPDATE ON SEQUENCE
--   public.quote_number_seq, public.order_number_seq TO anon; (Mason only.) No data to restore.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE number_generators_active_signed_in_only_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_fn record;
BEGIN
  IF to_regclass('pg_temp.number_generators_active_signed_in_only_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.number_generators_active_signed_in_only_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('generate_quote_number', 'generate_order_number')) <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: expected exactly one overload each of generate_quote_number / generate_order_number';
  END IF;
  FOR v_fn IN
    SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
           md5(replace(p.prosrc, chr(13), '')) AS body_md5, position('PROFILE_INACTIVE' IN p.prosrc) > 0 AS guarded,
           CASE p.proname WHEN 'generate_quote_number' THEN '6fa7163869f2b0c01e9665d258fc5587'
                          ELSE 'df0e5440a3518ecf7fb6a21ad7a97aeb' END AS expected_md5
      FROM pg_proc p
     WHERE p.oid IN (to_regprocedure('public.generate_quote_number()'), to_regprocedure('public.generate_order_number()'))
  LOOP
    IF v_fn.guarded THEN
      RAISE EXCEPTION 'NUMBER_GENERATORS_ALREADY_GUARDED: this migration has already run';
    END IF;
    IF v_fn.prosecdef OR v_fn.owner <> 'postgres'
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public']
       OR v_fn.body_md5 IS DISTINCT FROM v_fn.expected_md5 THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: public.%() is not as read 2026-10-27 (md5 %)', v_fn.proname, v_fn.body_md5;
    END IF;
  END LOOP;
  IF to_regclass('public.quote_number_seq') IS NULL OR to_regclass('public.order_number_seq') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: quote_number_seq / order_number_seq missing';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.generate_quote_number()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- A direct app call needs an active admin or sales rep (Mason: drivers do not take numbers).
  -- SECURITY DEFINER callers run this as their owner, so the checks skip them.
  IF current_user = 'authenticated' AND NOT public.is_active_profile() THEN
    RAISE EXCEPTION 'PROFILE_INACTIVE: active profile required to take a quote number'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user = 'authenticated' AND NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'NUMBER_ROLE_REQUIRED: only an admin or sales rep can take a quote number'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN 'Q-' || extract(year FROM current_date)::text || '-' || lpad(nextval('quote_number_seq')::text, 4, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_order_number()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Same rule as generate_quote_number.
  IF current_user = 'authenticated' AND NOT public.is_active_profile() THEN
    RAISE EXCEPTION 'PROFILE_INACTIVE: active profile required to take an order number'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user = 'authenticated' AND NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'NUMBER_ROLE_REQUIRED: only an admin or sales rep can take an order number'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN 'ORD-' || extract(year FROM current_date)::text || '-' || lpad(nextval('order_number_seq')::text, 4, '0');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.generate_quote_number(), public.generate_order_number() FROM PUBLIC, anon;
REVOKE ALL ON SEQUENCE public.quote_number_seq, public.order_number_seq FROM anon;

DO $postflight$
DECLARE
  v_fn text;
BEGIN
  IF to_regclass('pg_temp.number_generators_active_signed_in_only_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.number_generators_active_signed_in_only_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.generate_quote_number()', 'public.generate_order_number()'] LOOP
    IF (SELECT NOT p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
               AND p.proconfig = ARRAY['search_path=public']
               AND position('is_active_profile()' IN p.prosrc) > 0
               AND position('PROFILE_INACTIVE' IN p.prosrc) > 0
               AND position('NUMBER_ROLE_REQUIRED' IN p.prosrc) > 0
          FROM pg_proc p WHERE p.oid = v_fn::regprocedure) IS NOT TRUE
       OR has_function_privilege('anon', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % body/attributes/grants not as expected', v_fn;
    END IF;
  END LOOP;
  IF has_sequence_privilege('anon', 'public.quote_number_seq', 'USAGE')
     OR has_sequence_privilege('anon', 'public.order_number_seq', 'USAGE')
     OR NOT has_sequence_privilege('authenticated', 'public.quote_number_seq', 'USAGE')
     OR NOT has_sequence_privilege('authenticated', 'public.order_number_seq', 'USAGE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: number sequence grants not as expected';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: quote/order numbers only for active admins, sales reps and server functions';
END;
$postflight$;
