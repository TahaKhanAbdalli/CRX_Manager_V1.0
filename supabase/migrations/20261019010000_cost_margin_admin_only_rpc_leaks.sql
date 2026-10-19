-- Written 2026-10-18. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: Goal 1 part 3, step 1 of 3 (docs/plans/2026-10-13-direction-and-goals.md): product cost
--   and margin are ADMIN-ONLY (Mason, 2026-10-15) -- sales reps, drivers and applicators may not
--   read them anywhere, including on a rep's own quotes and invoices. This step closes the places
--   a database FUNCTION hands cost, profit or margin to a non-admin. It changes no table grant and
--   no stored money; step 2 (screens) and step 3 (column lock on the tables) follow.
--
--   1. _enforce_below_cost_line: a below-cost refusal returned the locked product cost inside the
--      error message (BELOW_COST_ADMIN_REQUIRED:{... "locked_unit_cost_cents": N}). Non-admins are
--      always refused a below-cost line, so a rep could type a one-cent price and read the exact
--      cost of any product. The detail now carries the cost only for an active admin. Nothing else
--      in the body changes (the existing role lookup moves above the detail).
--   2. Cost-only reports become admin-only: get_gross_sales_report, get_inventory_cost_report,
--      get_field_profitability, get_profitability_report and get_bottom_line_pnl. The last one had
--      NO role check at all and was executable by anon. dashboard_summary() (no app caller since the
--      dashboard moved to operational_dashboard_summary) had no role check either and handed every
--      signed-in account, drivers and applicators included, company-wide profit and margin.
--   3. Sales reports keep revenue for reps but return NULL cost, profit and margin to non-admins:
--      get_sales_detail_report, get_sales_summary_report.
--   4. get_inventory_position (inventory, ordering, receiving screens) drops current_cost from
--      each row for non-admins.
--   5. save_quote drops total_cost / total_profit / total_margin_pct from its reply for non-admins.
--
--   Items 2-4 use the house rename-and-wrap pattern (20260811130000, 20261016060000): each live
--   body is RENAMED unchanged to _<name>_cost_impl_20261019, every API role loses EXECUTE on it,
--   and a public wrapper with the identical signature, defaults and return type takes its name.
--   The wrapper is SECURITY DEFINER (search_path = public, pg_temp) so it can call the impl, and
--   the impl's own role checks still run (auth.uid() reads the caller's JWT inside nested calls).
--   Two impls (get_gross_sales_report, get_bottom_line_pnl) are SECURITY INVOKER: reached through
--   the definer wrapper they read as the owner, i.e. without RLS. That is the row set an active
--   admin already sees under RLS (the orders, order_items, invoices, invoice_items and commissions select policies all start
--   is_admin() OR ..., and returns is USING (true)), and the wrapper refuses everyone else before the impl runs.
--
-- NOT HERE (deliberately): purchase-order cost (get_chemical_history, match_quick_receive_items)
--   waits on Mason's purchase-order decision; table and column grants are step 3; quote_versions
--   snapshots and the admin cost-read function come with the screens in step 2. anon loses
--   EXECUTE on get_chemical_history here because no signed-out caller has any use for it.
--
-- CALLERS (every app caller of a function whose grants change here, checked 2026-10-18):
-- caller-analysis: get_gross_sales_report :: Reports.tsx Gross Sales tab; this branch shows that tab to admins only
-- caller-analysis: get_inventory_cost_report :: Reports.tsx inventory cost report; this branch shows it to admins only
-- caller-analysis: get_field_profitability :: FieldProfitability.tsx; this branch makes the route and nav link admin-only
-- caller-analysis: get_bottom_line_pnl :: Reports.tsx P&L tab; this branch shows that tab to admins only
-- caller-analysis: get_sales_detail_report :: SalesReports.tsx; reps keep the report, this branch hides its cost/profit/margin columns for non-admins (values arrive NULL)
-- caller-analysis: get_sales_summary_report :: SalesReports.tsx; same as get_sales_detail_report
-- caller-analysis: get_inventory_position :: 7 callers; only InventoryPage reads current_cost (cost columns and, in this branch, the Inventory Value card, both admin-only); the rest never read current_cost; anon never called it
-- caller-analysis: get_chemical_history :: Reports.tsx chemical history; only PUBLIC/anon lose EXECUTE, authenticated keeps its own explicit grant (live ACL read 2026-10-18), so signed-in callers are unchanged
-- caller-analysis: dashboard_summary :: no app caller in src/ (the dashboard uses operational_dashboard_summary and financial_dashboard_summary); it becomes admin-only
--
-- ROLLBACK: re-create the 20260812115237 bodies of _enforce_below_cost_line and save_quote
--   (both pinned by md5 in the preflight); for each wrapped function DROP the wrapper, RENAME the impl back and
--   re-GRANT EXECUTE TO authenticated and service_role. Do NOT re-grant PUBLIC or anon: signed-out
--   callers had no use for get_bottom_line_pnl or get_chemical_history. No data changes.

SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 0. Preflight: every body this file replaces or renames is the one read live on 2026-10-18.
--    A re-run (each impl already renamed) skips the rename checks and reinstalls identical
--    wrapper bodies.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.get_gross_sales_report(date,date,text)', 'get_gross_sales_report', 'eec9b549faefe622baefb88a00f90843'),
      ('public.get_inventory_cost_report()', 'get_inventory_cost_report', 'ae5899cb4c27fe0ea28a39ced278265b'),
      ('public.get_field_profitability(text)', 'get_field_profitability', 'a5b236b3ed59ab8143dd8c7f588c8a8f'),
      ('public.get_profitability_report(text,date,date)', 'get_profitability_report', '2844268affacb636370b9525bde4e1ba'),
      ('public.get_bottom_line_pnl(date,date)', 'get_bottom_line_pnl', 'cae7e3fd7bf50ab75243351cbd45ca7c'),
      ('public.get_sales_detail_report(date,date,uuid,uuid[],uuid,text,integer)', 'get_sales_detail_report', 'f593dc52b3248b8f7d8d6911d7d21eb9'),
      ('public.get_sales_summary_report(text,date,date,uuid,uuid[],uuid,text,integer)', 'get_sales_summary_report', '3360945856296ac10a661e21c0b0ff83'),
      ('public.get_inventory_position()', 'get_inventory_position', 'd05f13e24acd32425bb76b4114b60859'),
      ('public.dashboard_summary()', 'dashboard_summary', 'fd47d9a4e3ab48e8356efc13c7cd7ca2')
    ) AS v(sig, name, md5)
  LOOP
    IF to_regproc('public._' || r.name || '_cost_impl_20261019') IS NOT NULL THEN
      -- Renamed by an earlier run of this file: the impl must BE the pinned live body (the
      -- rename keeps it byte-identical), so a stale or hand-made impl of that name is refused
      -- instead of being wired behind the wrapper.
      IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
           WHERE p.oid = to_regproc('public._' || r.name || '_cost_impl_20261019')) IS DISTINCT FROM r.md5 THEN
        RAISE EXCEPTION 'COST_ADMIN_ONLY_PREFLIGHT: public._%_cost_impl_20261019 exists but is not the pinned body', r.name;
      END IF;
      CONTINUE;
    END IF;
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.name) <> 1 THEN
      RAISE EXCEPTION 'COST_ADMIN_ONLY_PREFLIGHT: expected exactly one public.% overload', r.name;
    END IF;
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
         WHERE p.oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'COST_ADMIN_ONLY_PREFLIGHT: % is missing or drifted from its 2026-10-18 body', r.sig;
    END IF;
  END LOOP;

  -- The below-cost trigger body of 20260812115237, or this file's own (a re-run).
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._enforce_below_cost_line()'))
     NOT IN ('1723ae58d9a60e2e45be4b1a5ea46022', '1cc52a9746b192e649367a44e9d63020') THEN
    RAISE EXCEPTION 'COST_ADMIN_ONLY_PREFLIGHT: _enforce_below_cost_line drifted from its 2026-08-12 body';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.save_quote(uuid,jsonb,jsonb,uuid,text)'))
     NOT IN ('e71e3fb75b7b1fa870d51391926c31c7', '058fef4284792b775c17789841263bf0') THEN
    RAISE EXCEPTION 'COST_ADMIN_ONLY_PREFLIGHT: save_quote drifted from its 2026-10-18 body';
  END IF;

  -- save_quote's strip relies on this impl's reply shape (cost totals inside server_totals,
  -- 20260812115236); pin it so a changed shape cannot slip past the strip.
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public._save_quote_below_cost_impl_20260810(uuid,jsonb,jsonb,uuid,text)'))
     IS DISTINCT FROM '8c11384d8f251f11a1e0e219304944a9' THEN
    RAISE EXCEPTION 'COST_ADMIN_ONLY_PREFLIGHT: _save_quote_below_cost_impl_20260810 is missing or drifted';
  END IF;

  -- The gates below are only as strong as these helpers: pin them to the live bodies (both
  -- require profiles.id = auth.uid(), role = 'admin' and is_active = true).
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.is_admin()')) IS DISTINCT FROM 'f76bf61116c3bd52bd9c6ea125079b73' THEN
    RAISE EXCEPTION 'COST_ADMIN_ONLY_PREFLIGHT: public.is_admin() is missing or drifted';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.require_admin()')) IS DISTINCT FROM '83dbda095d67a37031d5cd093a605a78' THEN
    RAISE EXCEPTION 'COST_ADMIN_ONLY_PREFLIGHT: public.require_admin() is missing or drifted';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. Rename each live body unchanged; no API role may call it directly.
-- ---------------------------------------------------------------------------
DO $rename$
DECLARE
  r record;
  v_impl text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('get_gross_sales_report', 'date,date,text'),
      ('get_inventory_cost_report', ''),
      ('get_field_profitability', 'text'),
      ('get_profitability_report', 'text,date,date'),
      ('get_bottom_line_pnl', 'date,date'),
      ('get_sales_detail_report', 'date,date,uuid,uuid[],uuid,text,integer'),
      ('get_sales_summary_report', 'text,date,date,uuid,uuid[],uuid,text,integer'),
      ('get_inventory_position', ''),
      ('dashboard_summary', '')
    ) AS v(name, args)
  LOOP
    v_impl := '_' || r.name || '_cost_impl_20261019';
    IF to_regproc('public.' || v_impl) IS NULL THEN
      EXECUTE format('ALTER FUNCTION public.%I(%s) RENAME TO %I', r.name, r.args, v_impl);
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon, authenticated, service_role', v_impl, r.args);
  END LOOP;
END
$rename$;

-- ---------------------------------------------------------------------------
-- 2. Admin-only wrappers for the cost reports.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_gross_sales_report(
  p_start_date date, p_end_date date, p_group_by text DEFAULT 'product'::text
)
RETURNS TABLE(group_name text, total_revenue numeric, total_cost numeric, gross_profit numeric,
              margin_pct numeric, units_sold numeric, order_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Cost and margin are admin-only (Mason, 2026-10-15).
  PERFORM public.require_admin();
  RETURN QUERY SELECT * FROM public._get_gross_sales_report_cost_impl_20261019(p_start_date, p_end_date, p_group_by);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_inventory_cost_report()
RETURNS TABLE(product_id uuid, product_name text, sku text, category text, vendor text,
              quantity_available numeric, quantity_prebooked numeric, net_available numeric,
              unit_cost numeric, total_cost_value numeric, reorder_point numeric, below_reorder boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Cost and margin are admin-only (Mason, 2026-10-15).
  PERFORM public.require_admin();
  RETURN QUERY SELECT * FROM public._get_inventory_cost_report_cost_impl_20261019();
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_field_profitability(p_season text DEFAULT NULL::text)
RETURNS TABLE(field_id uuid, field_name text, customer_id uuid, customer_name text, season text,
              total_acres_applied numeric, revenue_cents bigint, cost_cents bigint,
              margin_cents bigint, margin_per_acre_cents bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Cost and margin are admin-only (Mason, 2026-10-15).
  PERFORM public.require_admin();
  RETURN QUERY SELECT * FROM public._get_field_profitability_cost_impl_20261019(p_season);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_profitability_report(
  p_group_by text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date
)
RETURNS TABLE(group_key text, total_revenue numeric, total_cost numeric, total_profit numeric,
              margin_pct numeric, order_count bigint, units_sold numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Cost and margin are admin-only (Mason, 2026-10-15).
  PERFORM public.require_admin();
  RETURN QUERY SELECT * FROM public._get_profitability_report_cost_impl_20261019(p_group_by, p_start_date, p_end_date);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_bottom_line_pnl(p_start_date date, p_end_date date)
RETURNS TABLE(line_item text, amount numeric, pct_of_revenue numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Cost and margin are admin-only (Mason, 2026-10-15). This report had no role check at all.
  PERFORM public.require_admin();
  RETURN QUERY SELECT * FROM public._get_bottom_line_pnl_cost_impl_20261019(p_start_date, p_end_date);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Sales reports: revenue stays for reps; cost, profit and margin are NULL for non-admins.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_sales_detail_report(
  p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date,
  p_product_id uuid DEFAULT NULL::uuid, p_customer_ids uuid[] DEFAULT NULL::uuid[],
  p_sales_rep_id uuid DEFAULT NULL::uuid, p_category text DEFAULT NULL::text,
  p_season integer DEFAULT NULL::integer
)
RETURNS TABLE(order_date date, order_number text, customer_name text, customer_id uuid,
              product_name text, product_id uuid, sku text, category text, quantity numeric,
              unit text, unit_price numeric, total_price numeric, cost numeric, profit numeric,
              margin_pct numeric, sales_rep_name text, invoice_number text, season integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin boolean := public.is_admin();
BEGIN
  -- Cost and margin are admin-only (Mason, 2026-10-15); the impl keeps its own
  -- admin-or-sales-rep check.
  RETURN QUERY
  SELECT r.order_date, r.order_number, r.customer_name, r.customer_id, r.product_name,
         r.product_id, r.sku, r.category, r.quantity, r.unit, r.unit_price, r.total_price,
         CASE WHEN v_admin THEN r.cost END,
         CASE WHEN v_admin THEN r.profit END,
         CASE WHEN v_admin THEN r.margin_pct END,
         r.sales_rep_name, r.invoice_number, r.season
  FROM public._get_sales_detail_report_cost_impl_20261019(
    p_start_date, p_end_date, p_product_id, p_customer_ids, p_sales_rep_id, p_category, p_season
  ) r;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_sales_summary_report(
  p_group_by text DEFAULT 'product'::text, p_start_date date DEFAULT NULL::date,
  p_end_date date DEFAULT NULL::date, p_product_id uuid DEFAULT NULL::uuid,
  p_customer_ids uuid[] DEFAULT NULL::uuid[], p_sales_rep_id uuid DEFAULT NULL::uuid,
  p_category text DEFAULT NULL::text, p_season integer DEFAULT NULL::integer
)
RETURNS TABLE(group_key text, group_id uuid, total_quantity numeric, total_revenue numeric,
              total_cost numeric, total_profit numeric, margin_pct numeric, order_count bigint,
              line_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin boolean := public.is_admin();
BEGIN
  -- Cost and margin are admin-only (Mason, 2026-10-15); the impl keeps its own
  -- admin-or-sales-rep check.
  RETURN QUERY
  SELECT r.group_key, r.group_id, r.total_quantity, r.total_revenue,
         CASE WHEN v_admin THEN r.total_cost END,
         CASE WHEN v_admin THEN r.total_profit END,
         CASE WHEN v_admin THEN r.margin_pct END,
         r.order_count, r.line_count
  FROM public._get_sales_summary_report_cost_impl_20261019(
    p_group_by, p_start_date, p_end_date, p_product_id, p_customer_ids, p_sales_rep_id,
    p_category, p_season
  ) r;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Inventory position: same rows and order, no current_cost for non-admins.
--    VOLATILE like the impl.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_inventory_position()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_rows jsonb := public._get_inventory_position_cost_impl_20261019();
BEGIN
  IF public.is_admin() THEN
    RETURN v_rows;
  END IF;
  -- Cost is admin-only (Mason, 2026-10-15). Keep the impl's row order.
  RETURN COALESCE((
    SELECT jsonb_agg(e.row_value - 'current_cost' ORDER BY e.ord)
    FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS e(row_value, ord)
  ), '[]'::jsonb);
END;
$function$;

-- dashboard_summary: admin-only; VOLATILE and jsonb like the impl.
CREATE OR REPLACE FUNCTION public.dashboard_summary()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Company-wide profit and margin are admin-only (Mason, 2026-10-15). This had no role check.
  PERFORM public.require_admin();
  RETURN public._dashboard_summary_cost_impl_20261019();
END;
$function$;

REVOKE ALL ON FUNCTION public.get_gross_sales_report(date,date,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_inventory_cost_report() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_field_profitability(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_profitability_report(text,date,date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_bottom_line_pnl(date,date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_sales_detail_report(date,date,uuid,uuid[],uuid,text,integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_sales_summary_report(text,date,date,uuid,uuid[],uuid,text,integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_inventory_position() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dashboard_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gross_sales_report(date,date,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_inventory_cost_report() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_field_profitability(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_profitability_report(text,date,date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_bottom_line_pnl(date,date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_sales_detail_report(date,date,uuid,uuid[],uuid,text,integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_sales_summary_report(text,date,date,uuid,uuid[],uuid,text,integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_inventory_position() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dashboard_summary() TO authenticated, service_role;

-- No signed-out caller has any use for this invoker history function.
REVOKE EXECUTE ON FUNCTION public.get_chemical_history(uuid,date,date) FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- 5. save_quote: the 2026-10-18 body, plus a reply without cost/profit/margin for non-admins.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_quote(
  p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public._begin_below_cost_money_write('save_quote', p_performed_by, p_sections);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.check_idempotency(p_idempotency_key, 'save_quote');
  END IF;
  v_result := public._save_quote_below_cost_impl_20260810(
    p_quote_id, p_quote_payload, p_sections, p_performed_by, p_idempotency_key
  );
  -- Cost and margin are admin-only (Mason, 2026-10-15). The impl reports them
  -- inside server_totals, on a fresh save and on a replayed one; strip them
  -- there (and at the top level, in case a later impl moves them).
  IF NOT public.is_admin() AND jsonb_typeof(v_result) = 'object' THEN
    v_result := v_result - 'total_cost' - 'total_profit' - 'total_margin_pct';
    IF jsonb_typeof(v_result -> 'server_totals') = 'object' THEN
      v_result := jsonb_set(v_result, '{server_totals}',
        (v_result -> 'server_totals') - 'total_cost' - 'total_profit' - 'total_margin_pct');
    END IF;
  END IF;
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Below-cost refusal detail without cost for non-admins (20260812115237 body otherwise).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._enforce_below_cost_line()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_operation text := current_setting('app.crx_below_cost_operation', true);
  v_reason text := NULLIF(btrim(current_setting('app.crx_below_cost_reason', true)), '');
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_product_name text;
  v_cost numeric;
  v_cost_cents bigint;
  v_price_cents bigint;
  v_quantity numeric;
  v_entity_type text;
  v_entity_id uuid;
  v_line_id uuid;
  v_product_id uuid;
  v_is_application_fee boolean;
  v_detail jsonb;
BEGIN
  IF TG_TABLE_NAME = 'order_items' THEN
    -- Delivery completion and cancellation update fulfillment counters on an
    -- already-approved sale. They do not make a new pricing decision. Let
    -- context-free bookkeeping (and exposure-reducing quantity corrections)
    -- proceed, while a product/price change or quantity increase still reaches
    -- the fail-closed approval wall below.
    IF TG_OP = 'UPDATE'
       AND COALESCE(v_operation, '') = ''
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.price_per_unit IS NOT DISTINCT FROM OLD.price_per_unit
       AND COALESCE(NEW.total_units_needed, 0)
           <= COALESCE(OLD.total_units_needed, 0) THEN
      RETURN NEW;
    END IF;
    -- Rush orders intentionally carry zero prices until price_order. They are
    -- not sales decisions yet, so defer the wall to the pricing RPC.
    IF NEW.pricing_pending = true AND NEW.price_per_unit = 0 THEN
      RETURN NEW;
    END IF;
    IF NEW.price_per_unit IS NULL
       OR NEW.price_per_unit::text IN ('NaN', 'Infinity', '-Infinity')
       OR NEW.price_per_unit <> round(NEW.price_per_unit, 2) THEN
      RAISE EXCEPTION 'INVALID_UNIT_PRICE_CENTS';
    END IF;
    v_entity_type := 'order';
    v_entity_id := NEW.order_id;
    v_line_id := NEW.id;
    v_product_id := NEW.product_id;
    v_price_cents := round(NEW.price_per_unit * 100)::bigint;
    v_quantity := NEW.total_units_needed;
  ELSIF TG_TABLE_NAME = 'invoice_items' THEN
    -- complete_delivery can materialize an invoice line from an already-made
    -- order pricing decision. Permit only an exact, exposure-bounded descendant
    -- of that governed order line; a caller cannot use this hatch to substitute
    -- another Product, price, cost snapshot, or larger quantity. Browser roles
    -- also have no direct INSERT privilege on invoice_items.
    IF TG_OP = 'INSERT'
       AND COALESCE(v_operation, '') = ''
       AND NEW.order_item_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM public.order_items oi
         WHERE oi.id = NEW.order_item_id
           AND oi.product_id IS NOT DISTINCT FROM NEW.product_id
           AND round(oi.price_per_unit * 100)::bigint = NEW.unit_price_cents
           AND round(COALESCE(oi.cost_per_unit, 0) * 100)::bigint = NEW.cost_cents
           AND COALESCE(NEW.quantity, 0) >= 0
           AND COALESCE(NEW.quantity, 0) <= COALESCE(oi.total_units_needed, 0)
       ) THEN
      RETURN NEW;
    END IF;
    -- Partial delivery can reduce a draft invoice line and tote-copy updates
    -- bookkeeping only. Neither increases the approved below-cost exposure.
    IF TG_OP = 'UPDATE'
       AND COALESCE(v_operation, '') = ''
       AND NEW.product_id IS NOT NULL
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.order_item_id IS NOT DISTINCT FROM OLD.order_item_id
       AND NEW.unit_price_cents IS NOT DISTINCT FROM OLD.unit_price_cents
       AND NEW.cost_cents IS NOT DISTINCT FROM OLD.cost_cents
       AND COALESCE(NEW.is_application_fee, false)
           IS NOT DISTINCT FROM COALESCE(OLD.is_application_fee, false)
       AND COALESCE(NEW.quantity, 0) <= COALESCE(OLD.quantity, 0) THEN
      RETURN NEW;
    END IF;
    v_is_application_fee := COALESCE(NEW.is_application_fee, false);
    IF v_is_application_fee AND NEW.product_id IS NOT NULL THEN
      RAISE EXCEPTION 'APPLICATION_FEE_PRODUCT_INVALID';
    END IF;
    v_entity_type := 'invoice';
    v_entity_id := NEW.invoice_id;
    v_line_id := NEW.id;
    v_product_id := NEW.product_id;
    IF v_product_id IS NULL THEN
      -- A non-product line has no catalog row to lock, but save_invoice lets a
      -- caller supply cost_cents. Zero-cost fees/miscellaneous charges are not
      -- below cost. Positive-cost lines compare their total stored revenue to
      -- total stored cost and use quantity=1 in the approval audit so neither
      -- an application fee nor a null-product misc line can bypass the wall.
      IF COALESCE(NEW.cost_cents, 0) < 0 THEN
        RAISE EXCEPTION 'INVALID_COST';
      END IF;
      IF NEW.quantity IS NULL
         OR NEW.quantity::text IN ('NaN', 'Infinity', '-Infinity')
         OR NEW.quantity <= 0 THEN
        RAISE EXCEPTION 'INVALID_QUANTITY';
      END IF;
      IF COALESCE(NEW.cost_cents, 0) = 0 THEN
        RETURN NEW;
      END IF;
      v_product_name := COALESCE(
        NULLIF(btrim(NEW.description), ''),
        CASE WHEN v_is_application_fee
          THEN 'Application fee'
          ELSE 'Non-product invoice line'
        END
      );
      v_price_cents := COALESCE(
        NEW.extended_cents,
        round(COALESCE(NEW.unit_price_cents, 0) * COALESCE(NEW.quantity, 0))::bigint
      );
      v_cost_cents := CASE
        WHEN v_is_application_fee THEN NEW.cost_cents
        ELSE round(NEW.cost_cents * COALESCE(NEW.quantity, 0))::bigint
      END;
      v_quantity := 1;
    ELSE
      v_price_cents := NEW.unit_price_cents;
      v_quantity := NEW.quantity;
    END IF;
  ELSIF TG_TABLE_NAME = 'quote_items' THEN
    -- save_quote first inserts the client shape and then, in the same
    -- transaction, recomputes every line from the locked Product row. App
    -- roles cannot insert quote_items directly. Defer this private transient
    -- INSERT so the authoritative UPDATE below is the single enforcement and
    -- approval-audit point; any failure there rolls the entire save back.
    IF TG_OP = 'INSERT' AND v_operation = 'save_quote' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND COALESCE(v_operation, '') = ''
       AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
       AND NEW.price_per_unit IS NOT DISTINCT FROM OLD.price_per_unit
       AND COALESCE(NEW.total_units_needed, 0)
           <= COALESCE(OLD.total_units_needed, 0) THEN
      RETURN NEW;
    END IF;
    IF NEW.price_per_unit IS NULL
       OR NEW.price_per_unit::text IN ('NaN', 'Infinity', '-Infinity')
       OR NEW.price_per_unit <> round(NEW.price_per_unit, 2) THEN
      RAISE EXCEPTION 'INVALID_UNIT_PRICE_CENTS';
    END IF;
    v_entity_type := 'quote';
    v_entity_id := NEW.quote_id;
    v_line_id := NEW.id;
    v_product_id := NEW.product_id;
    v_price_cents := round(NEW.price_per_unit * 100)::bigint;
    v_quantity := COALESCE(NEW.total_units_needed, 0);
  ELSE
    RAISE EXCEPTION 'BELOW_COST_TRIGGER_TABLE_INVALID';
  END IF;

  IF v_price_cents < 0 THEN RAISE EXCEPTION 'INVALID_PRICE'; END IF;

  IF v_product_id IS NOT NULL THEN
    -- FOR SHARE prevents products.current_cost from changing between the check
    -- and the line write, while allowing unrelated product rows to proceed.
    SELECT p.product_name, p.current_cost
      INTO v_product_name, v_cost
    FROM public.products p
    WHERE p.id = v_product_id
    FOR SHARE;

    IF NOT FOUND THEN RAISE EXCEPTION 'PRODUCT_NOT_FOUND'; END IF;
    IF v_cost IS NULL
       OR v_cost::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_cost <= 0 THEN
      RAISE EXCEPTION 'COST_BASIS_REQUIRED:%', v_product_id;
    END IF;
    IF v_cost <> round(v_cost, 2) THEN
      RAISE EXCEPTION 'COST_BASIS_CENTS_REQUIRED:%', v_product_id;
    END IF;

    v_cost_cents := round(v_cost * 100)::bigint;
  END IF;

  -- update_order_items previously trusted p_items.cost_per_unit, and
  -- price_order previously reused an older snapshot. Both must write the same
  -- locked current cost used by this guard, including every dependent amount.
  IF TG_TABLE_NAME = 'order_items'
     AND v_operation IN (
       'create_direct_order', 'bulk_import_order',
       'update_order_items', 'price_order'
     ) THEN
    NEW.cost_per_unit := v_cost_cents::numeric / 100;
    NEW.cost_at_time_cents := v_cost_cents;
    -- This trigger sorts after trg_order_items_round_money, so it must preserve
    -- that canonical whole-cent invariant after replacing caller/stale cost.
    NEW.total_price := round(NEW.price_per_unit * NEW.total_units_needed, 2);
    NEW.profit := NEW.total_price
                  - round(NEW.cost_per_unit * NEW.total_units_needed, 2);
    NEW.net_margin := CASE
      WHEN NEW.price_per_unit > 0
        THEN round(((NEW.price_per_unit - NEW.cost_per_unit) / NEW.price_per_unit) * 100, 2)
      ELSE 0
    END;
  END IF;

  IF v_price_cents >= v_cost_cents THEN
    RETURN NEW;
  END IF;

  -- Cost is admin-only (Mason, 2026-10-15). Look the caller up BEFORE the
  -- refusal detail is built: the detail travels back to the browser in the
  -- error message, so it may carry the locked cost only for an active admin.
  -- Without this, a sales rep could type a one-cent price and read the exact
  -- product cost out of BELOW_COST_ADMIN_REQUIRED.
  SELECT p.role INTO v_actor_role
  FROM public.profiles p
  WHERE p.id = v_actor
    AND p.is_active = true;

  v_detail := jsonb_build_object(
    'operation', v_operation,
    'entity_type', v_entity_type,
    'entity_id', v_entity_id,
    'line_id', v_line_id,
    'product_id', v_product_id,
    'product_name', v_product_name,
    'unit_price_cents', v_price_cents,
    'locked_unit_cost_cents', v_cost_cents
  );
  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    v_detail := v_detail - 'locked_unit_cost_cents';
  END IF;

  -- There are many owner-run RPCs and triggers that can write these shared line
  -- tables. A missing context may proceed above cost, but it can never create a
  -- below-cost sale. Known customer-facing paths declare context through thin
  -- wrappers below; any missed future path fails closed here automatically.
  IF v_operation IS NULL OR v_operation = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_CONTEXT_REQUIRED:' || v_detail::text;
  END IF;

  IF v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_ADMIN_REQUIRED:' || v_detail::text;
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_REASON_REQUIRED:' || v_detail::text;
  END IF;

  INSERT INTO public.below_cost_approvals (
    operation, entity_type, entity_id, line_id, product_id, actor_user_id,
    reason, unit_price_cents, locked_unit_cost_cents, quantity,
    total_shortfall_cents
  ) VALUES (
    v_operation, v_entity_type, v_entity_id, v_line_id, v_product_id, v_actor,
    left(v_reason, 1000), v_price_cents, v_cost_cents, v_quantity,
    round((v_cost_cents - v_price_cents) * v_quantity)::bigint
  );

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Verify.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.get_gross_sales_report(date,date,text)'),
      ('public.get_inventory_cost_report()'),
      ('public.get_field_profitability(text)'),
      ('public.get_profitability_report(text,date,date)'),
      ('public.get_bottom_line_pnl(date,date)'),
      ('public.get_sales_detail_report(date,date,uuid,uuid[],uuid,text,integer)'),
      ('public.get_sales_summary_report(text,date,date,uuid,uuid[],uuid,text,integer)'),
      ('public.get_inventory_position()'),
      ('public.dashboard_summary()'),
      ('public.save_quote(uuid,jsonb,jsonb,uuid,text)')
    ) AS v(sig)
  LOOP
    IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']
              FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)) THEN
      RAISE EXCEPTION 'COST_ADMIN_ONLY_VERIFY: % is not SECURITY DEFINER with the pinned search_path', r.sig;
    END IF;
    IF NOT has_function_privilege('authenticated', to_regprocedure(r.sig), 'EXECUTE')
       OR has_function_privilege('anon', to_regprocedure(r.sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'COST_ADMIN_ONLY_VERIFY: % has the wrong EXECUTE grants', r.sig;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname LIKE '\_%\_cost\_impl\_20261019') <> 9 THEN
    RAISE EXCEPTION 'COST_ADMIN_ONLY_VERIFY: expected 9 renamed impls';
  END IF;
  FOR r IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '\_%\_cost\_impl\_20261019'
  LOOP
    IF has_function_privilege('authenticated', r.sig, 'EXECUTE')
       OR has_function_privilege('anon', r.sig, 'EXECUTE')
       OR has_function_privilege('service_role', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'COST_ADMIN_ONLY_VERIFY: % is callable by an API role', r.sig;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.get_chemical_history(uuid,date,date)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'COST_ADMIN_ONLY_VERIFY: anon can still run get_chemical_history';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.get_chemical_history(uuid,date,date)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'COST_ADMIN_ONLY_VERIFY: signed-in users lost get_chemical_history';
  END IF;

  -- The wrappers' bodies: the six admin-only reports call require_admin() before anything else,
  -- and the null/strip wrappers test is_admin().
  FOR r IN
    SELECT * FROM (VALUES
      ('public.get_gross_sales_report(date,date,text)', 'PERFORM public.require_admin();'),
      ('public.get_inventory_cost_report()', 'PERFORM public.require_admin();'),
      ('public.get_field_profitability(text)', 'PERFORM public.require_admin();'),
      ('public.get_profitability_report(text,date,date)', 'PERFORM public.require_admin();'),
      ('public.get_bottom_line_pnl(date,date)', 'PERFORM public.require_admin();'),
      ('public.dashboard_summary()', 'PERFORM public.require_admin();'),
      ('public.get_sales_detail_report(date,date,uuid,uuid[],uuid,text,integer)', 'CASE WHEN v_admin THEN r.cost END'),
      ('public.get_sales_summary_report(text,date,date,uuid,uuid[],uuid,text,integer)', 'CASE WHEN v_admin THEN r.total_cost END'),
      ('public.get_inventory_position()', 'e.row_value - ''current_cost''')
    ) AS v(sig, needle)
  LOOP
    IF position(r.needle IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig))) = 0 THEN
      RAISE EXCEPTION 'COST_ADMIN_ONLY_VERIFY: % does not contain its cost gate', r.sig;
    END IF;
  END LOOP;

  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = 'public._enforce_below_cost_line()'::regprocedure) <> '1cc52a9746b192e649367a44e9d63020' THEN
    RAISE EXCEPTION 'COST_ADMIN_ONLY_VERIFY: _enforce_below_cost_line is not the installed body';
  END IF;
  IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
       WHERE p.oid = 'public.save_quote(uuid,jsonb,jsonb,uuid,text)'::regprocedure) <> '058fef4284792b775c17789841263bf0' THEN
    RAISE EXCEPTION 'COST_ADMIN_ONLY_VERIFY: save_quote is not the installed body';
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
