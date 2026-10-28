-- Written 2026-10-28. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 1000, after PR #1160's placeholder rows 996-999).
-- Stamp and row are PLACEHOLDERS from Taha's fork: the CRX Coordinator session should assign the
-- final stamp/row. Independent of PR #1160 (no shared object). Re-read the live ledger first.
--
-- idempotency-body-check: exempt -- internal implementation; the public wrapper
--   convert_quote_to_order(..., p_idempotency_key, ...) keeps its key and this body keeps every
--   idempotency step unchanged.
--
-- WHAT: any active admin or sales rep can convert any booking to an order (Mason 2026-10-27:
--   "any rep converts another rep's booking, and the commission stays with the booking's
--   salesperson"). _convert_quote_to_order_below_cost_impl_20260810 drops its two
--   NOT_QUOTE_OWNER checks (before the idempotency lookup and again under the row lock); the
--   first read becomes an existence check and the locked read keeps only row_version. This
--   matches draw_down_quote, where any rep may already draw any booking (decision 2026-08-16).
--   The rest of the body is byte-identical to 20261027040000 (#1105, live).
--
-- COMMISSION: unchanged code. _convert_quote_to_order_owner_impl copies the booking's
--   commission_split onto the order and mints commissions from it, never from the caller, and
--   orders.salesman_id is not set by the convert. So the commission stays with the booking's rep.
--
-- NOT CHANGED: the public wrapper convert_quote_to_order and its below-cost gate; AUTH_REQUIRED,
--   ACTOR_MISMATCH, INSUFFICIENT_ROLE (active admin or sales_rep only; drivers and switched-off
--   reps still refused); the stale-write, idempotency-replay and price-lock (#1105) checks;
--   _convert_quote_to_order_owner_impl; owner, SECURITY DEFINER, search_path, ACL. Editing a
--   booking stays owner-only (save_quote NOT_QUOTE_OWNER), as do create_quote_version and
--   restore_quote_version.
--
-- CALLERS (checked 2026-10-28 on main 51d212fa): only convert_quote_to_order. App paths:
--   src/pages/QuoteBuilder.tsx "Convert whole booking" and src/pages/Quotes.tsx act-from-list,
--   both through src/lib/quoteLifecycleRpc.ts; neither hides the action from a non-owner, so no
--   screen change. Frozen provers (scripts/smoke/prove-quote-customer-row-version-concurrency.mjs,
--   prove-quote-pricing-real-schema.mjs) read their own historical migration files and keep
--   describing those. scripts/db-invariant-sweeps/allowlist.json pins this function in the
--   convert_quote_to_order actor-forgery entry; that pin is already stale since #1105 (KNOWN_ISSUES
--   KI-85) and is re-pinned from this body (p_performed_by handling is unchanged).
--
-- EVIDENCE: read on a local replay of main 51d212fa (no live access from the fork); Mason to
--   re-read live before applying: owner postgres, SECURITY DEFINER, search_path=public, pg_temp,
--   ACL {postgres=X/postgres}, body md5 (CR stripped) 2ca6a730c8e7e89d3991a247403d82ec.
--
-- ROLLBACK: re-create the function with the 20261027040000_quote_sent_price_lock.sql body (md5
--   2ca6a730c8e7e89d3991a247403d82ec). Orders already converted stay valid. No data to restore.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE any_rep_converts_booking_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_fn record;
BEGIN
  IF to_regclass('pg_temp.any_rep_converts_booking_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.any_rep_converts_booking_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
         md5(replace(p.prosrc, chr(13), '')) AS body_md5
    INTO v_fn
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._convert_quote_to_order_below_cost_impl_20260810(uuid,uuid,text,bigint)');
  IF FOUND AND v_fn.body_md5 = 'b235027c4650936bad3c6b4701fc5249' THEN
    RAISE EXCEPTION 'ANY_REP_CONVERTS_BOOKING_ALREADY_APPLIED: this migration has already run';
  END IF;
  IF NOT FOUND OR NOT v_fn.prosecdef OR v_fn.owner <> 'postgres'
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.acl IS DISTINCT FROM '{postgres=X/postgres}'
     OR v_fn.body_md5 IS DISTINCT FROM '2ca6a730c8e7e89d3991a247403d82ec' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: public._convert_quote_to_order_below_cost_impl_20260810 is not as read 2026-10-28 (md5 %)', v_fn.body_md5;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public._convert_quote_to_order_below_cost_impl_20260810(
  p_quote_id uuid,
  p_performed_by uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text,
  p_expected_row_version bigint DEFAULT NULL::bigint
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_current_row_version bigint;
  v_post_row_version bigint;
  v_existing jsonb;
  v_result jsonb;
  v_existing_order_id uuid;
  v_cache_rows integer;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM public.profiles
  WHERE id = v_actor
    AND is_active = true
    AND role IN ('admin', 'sales_rep');
  IF v_actor_role IS NULL THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  -- Any active admin or sales rep may convert any booking, so reps can cover for one another
  -- (Mason 2026-10-27, matching draw_down_quote's 2026-08-16 rule). The order and its commissions
  -- take the booking's own commission split, so the commission stays with the booking's rep.
  -- Editing the booking stays owner-only (save_quote). Do not add a created_by predicate here
  -- without a fresh owner decision.
  PERFORM 1
  FROM public.quotes
  WHERE id = p_quote_id
    AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;

  IF p_expected_row_version IS NULL OR p_expected_row_version < 1 THEN
    RAISE EXCEPTION 'QUOTE_STALE_WRITE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'convert_quote_to_order');
  END IF;

  SELECT row_version
  INTO v_current_row_version
  FROM public.quotes
  WHERE id = p_quote_id
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;

  IF v_existing IS NOT NULL THEN
    IF jsonb_typeof(v_existing) IS DISTINCT FROM 'object'
       OR v_existing->>'_quote_id' IS DISTINCT FROM p_quote_id::text
       OR COALESCE(v_existing->>'_expected_row_version', '') !~ '^[1-9][0-9]*$'
       OR (v_existing->>'_expected_row_version')::bigint IS DISTINCT FROM p_expected_row_version
       OR COALESCE(v_existing->>'_post_row_version', '') !~ '^[1-9][0-9]*$'
       OR (v_existing->>'_post_row_version')::bigint IS DISTINCT FROM v_current_row_version THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
    END IF;

    v_existing_order_id := NULLIF(v_existing->>'order_id', '')::uuid;
    IF v_existing_order_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.orders
      WHERE id = v_existing_order_id
        AND quote_id = p_quote_id
    ) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
    END IF;
    RETURN v_existing
      - '_quote_id'
      - '_expected_row_version'
      - '_post_row_version';
  END IF;

  IF v_current_row_version IS DISTINCT FROM p_expected_row_version THEN
    RAISE EXCEPTION 'QUOTE_STALE_WRITE';
  END IF;

  -- PRICE LOCK (20261027040000): a conversion that creates an order does so only at the prices,
  -- lines and customer last sent. The check is skipped only where the owner implementation
  -- returns an existing order or refuses (an accepted quote that has an order, or a booking with
  -- draws), so a quote reopened after its order was cancelled or voided is checked again.
  IF NOT (
    EXISTS (SELECT 1 FROM public.quote_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0)
    OR EXISTS (SELECT 1 FROM public.job_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0)
    OR ((SELECT q.status FROM public.quotes q WHERE q.id = p_quote_id) = 'accepted'
        AND EXISTS (SELECT 1 FROM public.orders WHERE quote_id = p_quote_id))
  ) THEN
    PERFORM public._assert_quote_prices_as_sent(p_quote_id);
  END IF;

  v_result := public._convert_quote_to_order_owner_impl(
    p_quote_id,
    p_performed_by,
    p_idempotency_key
  );

  SELECT row_version INTO v_post_row_version
  FROM public.quotes
  WHERE id = p_quote_id;

  IF p_idempotency_key IS NOT NULL THEN
    UPDATE public.idempotency_keys
    SET result = v_result || jsonb_build_object(
      '_quote_id', p_quote_id,
      '_expected_row_version', p_expected_row_version,
      '_post_row_version', v_post_row_version
    )
    WHERE idempotency_key = p_idempotency_key
      AND operation = 'convert_quote_to_order';
    GET DIAGNOSTICS v_cache_rows = ROW_COUNT;
    IF v_cache_rows <> 1 THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CACHE_WRITE_FAILED';
    END IF;
  END IF;

  RETURN v_result;
END;
$$;

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  IF to_regclass('pg_temp.any_rep_converts_booking_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.any_rep_converts_booking_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
         md5(replace(p.prosrc, chr(13), '')) AS body_md5, p.prosrc
    INTO v_fn
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._convert_quote_to_order_below_cost_impl_20260810(uuid,uuid,text,bigint)');
  IF NOT FOUND OR NOT v_fn.prosecdef OR v_fn.owner <> 'postgres'
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.acl IS DISTINCT FROM '{postgres=X/postgres}'
     OR v_fn.body_md5 IS DISTINCT FROM 'b235027c4650936bad3c6b4701fc5249'
     OR position('NOT_QUOTE_OWNER' IN v_fn.prosrc) > 0
     OR position('INSUFFICIENT_ROLE' IN v_fn.prosrc) = 0
     OR position('ACTOR_MISMATCH' IN v_fn.prosrc) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: public._convert_quote_to_order_below_cost_impl_20260810 is not the expected body/attributes (md5 %, acl %)', v_fn.body_md5, v_fn.acl;
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: any active admin or sales rep converts any booking; commission follows the booking''s split';
END;
$postflight$;
