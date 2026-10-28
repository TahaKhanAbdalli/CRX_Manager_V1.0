-- Written 2026-10-27. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 998). Stamp and row are PLACEHOLDERS from Taha's
-- fork: the CRX Coordinator session should assign the final stamp/row. Lands after
-- 20261027080100 (row 997). Re-read the live ledger first.
--
-- idempotency-body-check: exempt -- trigger function; it takes no p_idempotency_key and writes no row.
--
-- WHAT: only an admin sets or changes a customer's default commission split (DECISION_LOG
--   2026-10-14 "Only admins change commission splits", which names COMMISSION_SPLIT_ADMIN_OR_ASSIGNED_REP
--   from PR #907 as the rule to tighten; Mason 2026-10-26, and 2026-10-27 for new customers).
--   guard_customer_rep_edit_20261013() changes in two places, with the new token
--   COMMISSION_SPLIT_ADMIN_ONLY:
--   1. UPDATE: a sales rep changing the split is refused whoever the assigned rep is (the condition
--      OLD.assigned_sales_rep IS DISTINCT FROM auth.uid() is removed).
--   2. INSERT: a sales rep's new customer carries no split (NULL or JSON null); an admin sets it.
--   The rest of the body is byte-identical. The Customer screen shows the split editor only to
--   admins, on new customers too, and a rep's create sends no split.
--
-- NOT CHANGED: owner, SECURITY INVOKER, search_path, ACL, the trigger (customers_guard_rep_edit_20261013
--   and its column list); admins; a rep re-saving an unchanged split (compared after recipient
--   stamping, so never refused); a rep creating a customer without a split; job/quote/order splits
--   (Goal 2 follow-up); every other guard in this function.
--
-- CALLERS (checked 2026-10-27 on main fe258c2f): fires on customers INSERT and on UPDATE OF
--   assigned_sales_rep, default_commission_split, is_active, prepay_balance_cents. App paths:
--   src/pages/CustomerDetail.tsx (save_customer, the only database path that creates customers)
--   shows the split editor only to admins after this change; src/components/customers/
--   BulkCustomerImport.tsx inserts customers without a split (unaffected); src/lib/errorSanitizer.ts
--   maps the new token. The frozen container prover
--   scripts/smoke/prove-reps-work-any-customer-real-schema.mjs proves 20261013220000 as its LAST
--   replayed migration, so it keeps describing that migration's rule.
--
-- EVIDENCE: read on a local replay of main d5fd2bf8 (no live access from the fork); Mason to re-read
--   live before applying: guard_customer_rep_edit_20261013() owner postgres, plpgsql trigger, not
--   SECURITY DEFINER, search_path=public, pg_temp, ACL {postgres=X/postgres}, body md5 (CR stripped)
--   1a06d41564958d5d29d64afffcf4b4e2.
--
-- ROLLBACK: re-create the function with the 20261013220000_reps_work_any_customer.sql body (md5
--   1a06d41564958d5d29d64afffcf4b4e2). No data to restore.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE commission_split_admin_only_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_fn record;
BEGIN
  IF to_regclass('pg_temp.commission_split_admin_only_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.commission_split_admin_only_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
         md5(replace(p.prosrc, chr(13), '')) AS body_md5
    INTO v_fn
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.guard_customer_rep_edit_20261013()');
  IF FOUND AND v_fn.body_md5 = '8792615a90e69e2c2ecdf90706fed532' THEN
    RAISE EXCEPTION 'COMMISSION_SPLIT_ADMIN_ONLY_ALREADY_APPLIED: this migration has already run';
  END IF;
  IF NOT FOUND OR v_fn.prosecdef OR v_fn.owner <> 'postgres'
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.acl IS DISTINCT FROM '{postgres=X/postgres}'
     OR v_fn.body_md5 IS DISTINCT FROM '1a06d41564958d5d29d64afffcf4b4e2' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: public.guard_customer_rep_edit_20261013 is not as read 2026-10-27 (md5 %)', v_fn.body_md5;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'customers_guard_rep_edit_20261013'
                   AND tgrelid = 'public.customers'::regclass
                   AND tgfoid = 'public.guard_customer_rep_edit_20261013()'::regprocedure AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: trigger customers_guard_rep_edit_20261013 missing or disabled';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.guard_customer_rep_edit_20261013()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF public.is_admin() OR NOT public.is_sales_rep() THEN
    RETURN NEW;
  END IF;
  -- A customer a rep creates directly starts with no prepay balance (prepayments add it later).
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.prepay_balance_cents, 0) <> 0 AND current_user = 'authenticated' THEN
      RAISE EXCEPTION 'PREPAY_BALANCE_SERVER_ONLY: a prepay balance changes only through prepayments and payments';
    END IF;
    -- Only an admin sets a new customer's split too (Mason 2026-10-27); a rep's create carries none.
    IF COALESCE(NEW.default_commission_split, 'null'::jsonb) <> 'null'::jsonb THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_ADMIN_ONLY: only an admin can set a customer''s default commission split';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.assigned_sales_rep IS DISTINCT FROM OLD.assigned_sales_rep THEN
    RAISE EXCEPTION 'REP_CANNOT_REASSIGN';
  END IF;
  -- Only an admin changes a split, even the customer's own rep (Mason 2026-10-14, 2026-10-26).
  -- Compared after canonical recipient stamping on both sides, so a rep re-saving a split they
  -- did not change (with or without stamped recipient ids) is never refused.
  -- SQL NULL and JSON null both mean "no split".
  IF COALESCE(NEW.default_commission_split, 'null'::jsonb) IS DISTINCT FROM COALESCE(OLD.default_commission_split, 'null'::jsonb)
     AND COALESCE(public.commission_split_with_recipient_ids(NEW.default_commission_split), 'null'::jsonb)
         IS DISTINCT FROM COALESCE(public.commission_split_with_recipient_ids(OLD.default_commission_split), 'null'::jsonb) THEN
    RAISE EXCEPTION 'COMMISSION_SPLIT_ADMIN_ONLY: only an admin can change a customer''s default commission split';
  END IF;
  IF OLD.is_active IS TRUE AND NEW.is_active IS NOT TRUE
     AND public._customer_has_open_invoice_20261013(OLD.id) THEN
    RAISE EXCEPTION 'CUSTOMER_HAS_OPEN_INVOICES: this customer has posted or overdue invoices; resolve them before deactivating it';
  END IF;
  IF NEW.prepay_balance_cents IS DISTINCT FROM OLD.prepay_balance_cents
     AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'PREPAY_BALANCE_SERVER_ONLY: a prepay balance changes only through prepayments and payments';
  END IF;
  RETURN NEW;
END;
$$;

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  IF to_regclass('pg_temp.commission_split_admin_only_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.commission_split_admin_only_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
         md5(replace(p.prosrc, chr(13), '')) AS body_md5
    INTO v_fn
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.guard_customer_rep_edit_20261013()');
  IF NOT FOUND OR v_fn.prosecdef OR v_fn.owner <> 'postgres'
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.acl IS DISTINCT FROM '{postgres=X/postgres}'
     OR v_fn.body_md5 IS DISTINCT FROM '8792615a90e69e2c2ecdf90706fed532' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: public.guard_customer_rep_edit_20261013 is not the expected body/attributes (md5 %, acl %)', v_fn.body_md5, v_fn.acl;
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: only an admin changes a customer''s default commission split';
END;
$postflight$;
