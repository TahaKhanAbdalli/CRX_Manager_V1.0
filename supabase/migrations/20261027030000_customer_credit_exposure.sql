-- Written 2026-10-26. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: NEW read-only customer_credit_exposure(p_customer_id) for the client credit-limit check
--   (PR #1132). It returns, in exact bigint cents, everything a customer owes or is about to owe:
--     { customer_id, credit_limit_cents (bigint or null), exposure_cents (bigint) }
--   exposure_cents = SUM(GREATEST(balance_cents, 0)) over the customer's invoices whose status is
--   draft, unposted, posted or overdue and that are not soft-deleted. A negative balance (a credit
--   memo, an overpayment) counts as 0, never as a reduction. Paid, voided and cancelled invoices are
--   not exposure.
--   credit_limit_cents is null when the customer has no limit. customers.credit_limit_cents defaults
--   to 0 and every existing check (check_customer_credit_limit, _check_credit_limit, the dashboard)
--   reads 0 or less as "no limit", so this function returns null for a stored 0, a negative or a
--   null limit, and a positive limit as stored. A caller never has to know the 0 convention.
--
-- WHY SECURITY DEFINER: invoice RLS (invoices_select) lets a sales rep read only invoices they
--   created or sell. The check must count EVERY rep's drafts for the customer: Rep A's $9,000 draft
--   plus Rep B's $2,000 order under a $10,000 limit has to fail, and Rep B cannot see Rep A's draft
--   through RLS. The function therefore reads as its owner and enforces the role itself:
--   require_admin_or_sales_rep() (an active admin or sales rep; every other account, an inactive one
--   or one with no profile is refused), the same gate check_customer_credit_limit uses. It returns
--   only two totals, no invoice rows. Compared with check_customer_credit_limit, a rep additionally
--   learns the cross-rep draft total and, for a customer with no limit, the open total (that
--   function answers 0 there); both are what the check needs, and reps work with any customer
--   since 20261013220000.
--
-- An unknown customer id raises CUSTOMER_NOT_FOUND (it never answers 0, which would read as
--   "no exposure"). The role check runs first, so a refused caller learns nothing about which ids
--   exist.
--
-- Nothing else changes: check_customer_credit_limit, _check_credit_limit and every other function
--   are untouched. No table, policy or row is written.
--
-- caller-analysis: customer_credit_exposure :: NEW; src/lib/creditLimitGuard.ts switches to it in
--   PR #1132 after this lands (no caller in this PR)
--
-- GRANTS: EXECUTE to authenticated and service_role only (revoked from PUBLIC, anon, metabase_ro).
--   SECURITY DEFINER, STABLE, search_path = public, pg_temp.
--
-- ROLLBACK (nothing depends on it until #1132 ships):
--   DROP FUNCTION public.customer_credit_exposure(uuid);

SET LOCAL lock_timeout = '10s';

-- PREFLIGHT: the role gate is exactly the one read live on 2026-10-26 (md5 of prosrc without
-- carriage returns), and no function of this name exists yet (any overload).
DO $preflight$
DECLARE
  v_md5 text;
BEGIN
  IF to_regprocedure('public.require_admin_or_sales_rep()') IS NULL THEN
    RAISE EXCEPTION 'CREDIT_EXPOSURE_PREFLIGHT: public.require_admin_or_sales_rep() is missing';
  END IF;
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.require_admin_or_sales_rep()');
  IF v_md5 IS DISTINCT FROM '958c994aeabcb9f53b6cef316019a219' THEN
    RAISE EXCEPTION 'CREDIT_EXPOSURE_PREFLIGHT: require_admin_or_sales_rep() changed since 2026-10-26 (md5 %); re-read it before applying', v_md5;
  END IF;
  IF (SELECT p.prosecdef IS NOT TRUE OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.require_admin_or_sales_rep()')) THEN
    RAISE EXCEPTION 'CREDIT_EXPOSURE_PREFLIGHT: require_admin_or_sales_rep() is no longer SECURITY DEFINER with search_path public, pg_temp';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace
                AND p.proname = 'customer_credit_exposure') THEN
    RAISE EXCEPTION 'CREDIT_EXPOSURE_PREFLIGHT: public.customer_credit_exposure already exists';
  END IF;
END
$preflight$;

CREATE FUNCTION public.customer_credit_exposure(p_customer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_credit_limit_cents bigint;
  v_exposure_cents bigint;
BEGIN
  -- Office staff only (active admin or sales rep), before anything is read.
  PERFORM public.require_admin_or_sales_rep();

  SELECT c.credit_limit_cents
    INTO v_credit_limit_cents
    FROM public.customers c
   WHERE c.id = p_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND: no customer with id %', p_customer_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Every rep's invoices, not only the caller's: this is why the function is SECURITY DEFINER.
  SELECT COALESCE(SUM(GREATEST(i.balance_cents, 0)), 0)::bigint
    INTO v_exposure_cents
    FROM public.invoices i
   WHERE i.customer_id = p_customer_id
     AND i.status IN ('draft', 'unposted', 'posted', 'overdue')
     AND i.deleted_at IS NULL;

  RETURN jsonb_build_object(
    'customer_id', p_customer_id,
    -- 0 or less means "no limit" everywhere else in the database; say so with null.
    'credit_limit_cents', CASE WHEN v_credit_limit_cents > 0 THEN v_credit_limit_cents END,
    'exposure_cents', v_exposure_cents
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.customer_credit_exposure(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.customer_credit_exposure(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.customer_credit_exposure(uuid) IS
  'Admin or sales rep: a customer''s credit limit (null = no limit, including a stored 0 or less) and whole open exposure in bigint cents (draft, unposted, posted and overdue invoice balances, negatives as 0, every rep''s invoices). Raises CUSTOMER_NOT_FOUND for an unknown id. Read-only.';

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
DO $verify$
BEGIN
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'customer_credit_exposure') <> 1 THEN
    RAISE EXCEPTION 'CREDIT_EXPOSURE_VERIFY: expected exactly one customer_credit_exposure';
  END IF;
  IF (SELECT p.prosecdef IS NOT TRUE
             OR p.provolatile <> 's'
             OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
             OR p.prorettype <> 'jsonb'::regtype
        FROM pg_proc p WHERE p.oid = 'public.customer_credit_exposure(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'CREDIT_EXPOSURE_VERIFY: customer_credit_exposure is not STABLE SECURITY DEFINER jsonb with search_path public, pg_temp';
  END IF;
  IF has_function_privilege('anon', 'public.customer_credit_exposure(uuid)', 'EXECUTE')
     OR (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro')
         AND has_function_privilege('metabase_ro', 'public.customer_credit_exposure(uuid)', 'EXECUTE'))
     OR NOT has_function_privilege('authenticated', 'public.customer_credit_exposure(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.customer_credit_exposure(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CREDIT_EXPOSURE_VERIFY: customer_credit_exposure grants are wrong';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK customer_credit_exposure';
END
$verify$;
