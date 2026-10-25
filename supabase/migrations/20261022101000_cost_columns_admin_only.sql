-- =====================================================================================================
-- 20261022101000_cost_columns_admin_only.sql
--
-- WHAT: Goal 1 part 3, step 3 -- the cost column lock on the remaining cost tables. Cost, profit and
--   margin become unreadable and unwritable through the Data API for every API role, admins included:
--     products            current_cost, cost_updated_date, tier1/2/3_margin, tier1/2/3_gross_margin
--     quotes              total_cost, total_profit, total_margin_pct
--     quote_items         current_cost, profit, net_margin, cost_at_quote_cents
--     quote_versions      snapshot_data (the sent quote's full snapshot, cost included)
--     orders              total_cost, total_profit, total_margin_pct
--     order_items         cost_per_unit, profit, net_margin, cost_at_time_cents
--     invoices            total_cost_cents
--     invoice_items       cost_cents, return_credit_cogs_cents
--     jobs                total_cost_cents
--     job_chemicals       cost_per_unit_cents
--     blend_ticket_products unit_cost_cents
--     commissions         order_profit
--   Every other column keeps exactly the privileges its table held before (live read 2026-10-22 ~02:10
--   UTC), except generated jobs.remaining_acres, which drops the INSERT/UPDATE it could never use.
--   Row security is unchanged. Admins keep reading cost through get_admin_cost_fields (SECURITY
--   DEFINER, admin-only, 20261019230000) and quote history through get_quote_versions (SECURITY DEFINER;
--   strips cost from a rep's snapshot). Purchase-order cost was locked by 20261021141000.
--
-- WHY (Mason, 2026-10-15: cost and margin are admin-only, including on a rep's own quotes and
--   invoices; docs/plans/2026-10-13-direction-and-goals.md Goal 1). Step 2 (20261019230000, PR #965)
--   made every screen list its columns and read cost only through the admin function, but the columns
--   themselves stayed readable: on 2026-10-22 00:05 UTC a rep could still read products.current_cost
--   through the Data API. Reps could also WRITE cost directly (table INSERT/UPDATE on quotes, orders,
--   jobs, job_chemicals, blend_ticket_products and commissions), so the writes are locked too.
--
-- SAFE TO LOCK (read-only inventory 2026-10-22, recorded in the PR): none of the 201 src/ reads of
--   these tables asks for a cost column or `*`; none of the 20 direct writes names a cost column; Edge
--   Functions read them only as service_role; every function or trigger that reads a cost column runs
--   SECURITY DEFINER or is an INVOKER helper only DEFINER functions call; INVOKER triggers only touch
--   NEW/OLD, which needs no column privilege; none of these tables is in a realtime publication.
--
-- HOW: a table-level grant implies every column and REVOKE (col) cannot subtract from it, so each
--   privilege is revoked table-wide and re-granted on the explicit non-cost list, each privilege with
--   its OWN list (`GRANT SELECT, REFERENCES (cols)` would scope only REFERENCES: the 20260729015706
--   trap). Only privileges a role held are re-granted: authenticated SELECT + REFERENCES (quote_versions:
--   SELECT only), anon SELECT where it had it (not quote_items, quote_versions), and authenticated
--   INSERT + UPDATE where it had them (generated jobs.remaining_acres is left out of the jobs write
--   lists; invoices has no write grants). products keeps its older column-level INSERT/UPDATE grants, which never
--   included cost. DELETE, TRUNCATE and TRIGGER are not column privileges and are left alone, as is
--   service_role and metabase_ro (read-only reporting, not reachable through the Data API).
--
-- STANDING CONSEQUENCE: a NEW column on any of these tables is invisible to (and unwritable by)
--   authenticated and anon until a migration grants it. Any ADD COLUMN on them must ship with its
--   grants -- unless it is another cost field. The preflight refuses to run on a changed column set.
--   The same holds for anything that reads a WHOLE row of these tables as an API role: a function
--   taking the table's row type (a PostgREST computed field), a security_invoker view, or `SELECT *`
--   in an INVOKER function. Postgres checks SELECT on every column for a whole-row reference, so each
--   would fail with "permission denied" for admins and reps alike. The preflight refuses to run while a
--   row-type function is executable by authenticated or anon, or while any view reads a cost column.
--   The one such function, #1018's invoice_post_version(public.invoices), is dropped first: the
--   screens read the version from invoices_postable (20261022090000, a view without cost) through
--   invoice_postable_version, and this file refuses unless that view and function are in place.
--
-- PREFLIGHT ALSO PINS (live read 2026-10-22, before this change): which of SELECT, REFERENCES, INSERT
--   and UPDATE each API role holds on each table or any of its columns (so nothing is re-granted that
--   was never held),
--   and the bodies, SECURITY DEFINER mode and grants of get_admin_cost_fields and get_quote_versions.
--
-- ROLLBACK (re-opens cost to reps; only with Mason's approval):
--   GRANT SELECT, REFERENCES ON public.products, public.quotes, public.quote_items, public.orders,
--     public.order_items, public.invoices, public.invoice_items, public.jobs, public.job_chemicals,
--     public.blend_ticket_products, public.commissions TO authenticated;
--   GRANT SELECT ON public.quote_versions TO authenticated;
--   GRANT SELECT ON public.products, public.quotes, public.orders, public.order_items, public.invoices,
--     public.invoice_items, public.jobs, public.job_chemicals, public.blend_ticket_products,
--     public.commissions TO anon;
--   GRANT INSERT, UPDATE ON public.quotes, public.orders, public.jobs, public.job_chemicals,
--     public.blend_ticket_products, public.commissions TO authenticated;
--   The dropped invoice_post_version(public.invoices) need not come back: the screens use the view's.
--
-- Proof: node scripts/smoke/prove-cost-columns-admin-only-real-schema.mjs
-- =====================================================================================================

SET LOCAL lock_timeout = '10s';

CREATE TEMP TABLE cost_columns_admin_only_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

-- The invoice posting version moved to invoices_postable (20261022090000), which carries no cost column.
-- #1018's whole-row invoice_post_version(public.invoices) would fail for everyone once total_cost_cents is
-- revoked, so it is dropped here, only after the view and invoice_postable_version are in place (the screens read
-- the view since that PR's deploy). Absent on a re-apply.
DO $postable$
BEGIN
  IF to_regclass('pg_temp.cost_columns_admin_only_tx') IS NULL THEN
    RAISE EXCEPTION 'COST_LOCK_NOT_IN_TRANSACTION: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.cost_columns_admin_only_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'COST_LOCK_NOT_IN_TRANSACTION: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF to_regclass('public.invoices_postable') IS NULL
     -- The screens read the version from it as authenticated (live 2026-10-25: SELECT for authenticated, none for anon).
     OR NOT has_table_privilege('authenticated', 'public.invoices_postable', 'SELECT')
     OR has_table_privilege('anon', 'public.invoices_postable', 'SELECT')
     OR NOT EXISTS (SELECT 1 FROM pg_class c, unnest(c.reloptions) o
                     WHERE c.oid = 'public.invoices_postable'::regclass AND o IN ('security_invoker=true', 'security_invoker=on'))
     OR (SELECT string_agg(attname, ',' ORDER BY attname) FROM pg_attribute
          WHERE attrelid = 'public.invoices_postable'::regclass AND attnum > 0 AND NOT attisdropped)
        IS DISTINCT FROM (SELECT string_agg(attname, ',' ORDER BY attname) FROM pg_attribute
                           WHERE attrelid = 'public.invoices'::regclass AND attnum > 0 AND NOT attisdropped
                             AND attname <> 'total_cost_cents') THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: 20261022090000 (invoices_postable) is not applied, or the view drifted';
  END IF;
  -- Both functions carry the same reviewed body (#1018's rule over _invoice_post_version(id)); the view's
  -- is SECURITY DEFINER owned by postgres with search_path = public, pg_temp (live 2026-10-23).
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.invoice_postable_version(public.invoices_postable)')), chr(13), ''))
       IS DISTINCT FROM 'f353b5c3078efb42544ea7b76c7b16e6'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.invoice_postable_version(public.invoices_postable)'))
     OR (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = to_regprocedure('public.invoice_postable_version(public.invoices_postable)'))
          IS DISTINCT FROM 'postgres'
     OR (SELECT proconfig FROM pg_proc WHERE oid = to_regprocedure('public.invoice_postable_version(public.invoices_postable)'))
          IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR NOT has_function_privilege('authenticated', 'public.invoice_postable_version(public.invoices_postable)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.invoice_postable_version(public.invoices_postable)', 'EXECUTE') THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: invoice_postable_version(invoices_postable) is missing or drifted';
  END IF;
  IF to_regprocedure('public.invoice_post_version(public.invoices)') IS NOT NULL THEN
    IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.invoice_post_version(public.invoices)')), chr(13), ''))
         IS DISTINCT FROM 'f353b5c3078efb42544ea7b76c7b16e6' THEN
      RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: invoice_post_version(invoices) drifted from 20261022022000; re-read it before dropping';
    END IF;
    DROP FUNCTION public.invoice_post_version(public.invoices);
  END IF;
END
$postable$;

DO $preflight$
DECLARE
  v_cols text;
  v_bad text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change, so a
  -- verify failure can never leave the REVOKEs committed without their re-grants.
  IF to_regclass('pg_temp.cost_columns_admin_only_tx') IS NULL THEN
    RAISE EXCEPTION 'COST_LOCK_NOT_IN_TRANSACTION: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.cost_columns_admin_only_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'COST_LOCK_NOT_IN_TRANSACTION: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- The privileges each API role holds now, on the table or on any of its columns (the same answer
  -- before this file and after it, so a re-apply still passes). The grants below re-grant exactly
  -- these on the non-cost columns, so a role that lost one outside a migration must not get it back
  -- from this file, and a role that gained one must be looked at before the lock is written over it.
  SELECT string_agg(format('%s %s %s: held %s, expected %s', e.rol, e.priv, e.tbl,
                           has_any_column_privilege(e.rol, ('public.' || e.tbl)::regclass, e.priv), e.held), '; ')
    INTO v_bad
    FROM (
      SELECT t.tbl, r.rol, p.priv,
             CASE
               WHEN r.rol = 'anon' THEN p.priv = 'SELECT' AND t.tbl NOT IN ('quote_items', 'quote_versions')
               WHEN p.priv = 'SELECT' THEN true
               WHEN p.priv = 'REFERENCES' THEN t.tbl <> 'quote_versions'
               -- products' INSERT/UPDATE are its older column-level grants (no cost column among them).
               ELSE t.tbl IN ('products', 'quotes', 'orders', 'jobs', 'job_chemicals', 'blend_ticket_products', 'commissions')
             END AS held
        FROM unnest(ARRAY['products', 'quotes', 'quote_items', 'quote_versions', 'orders', 'order_items', 'invoices',
                          'invoice_items', 'jobs', 'job_chemicals', 'blend_ticket_products', 'commissions']) AS t(tbl)
        CROSS JOIN (VALUES ('authenticated'), ('anon')) AS r(rol)
        CROSS JOIN (VALUES ('SELECT'), ('REFERENCES'), ('INSERT'), ('UPDATE')) AS p(priv)
    ) e
   WHERE has_any_column_privilege(e.rol, ('public.' || e.tbl)::regclass, e.priv) IS DISTINCT FROM e.held;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: table privileges are not the ones this file was written against (re-read them): %', v_bad;
  END IF;
  -- "Held" must mean held on EVERY non-cost column (table-wide before this file, column by column
  -- after it): a role narrowed to a few columns outside a migration would otherwise get the rest back
  -- from the grants below. Generated columns are checked for SELECT/REFERENCES (this file re-grants them)
  -- and skipped for INSERT/UPDATE (this file leaves jobs.remaining_acres out of the write lists);
  -- products' INSERT/UPDATE are not re-granted here, so they need only be held.
  SELECT string_agg(format('%s %s %s.%s', r.rol, p.priv, c.relname, a.attname), '; ' ORDER BY r.rol, p.priv, c.relname, a.attname)
    INTO v_bad
    FROM unnest(ARRAY['products', 'quotes', 'quote_items', 'quote_versions', 'orders', 'order_items', 'invoices',
                      'invoice_items', 'jobs', 'job_chemicals', 'blend_ticket_products', 'commissions']) AS t(tbl)
    JOIN pg_class c ON c.oid = ('public.' || t.tbl)::regclass
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    CROSS JOIN (VALUES ('authenticated'), ('anon')) AS r(rol)
    CROSS JOIN (VALUES ('SELECT'), ('REFERENCES'), ('INSERT'), ('UPDATE')) AS p(priv)
   WHERE (a.attgenerated = '' OR p.priv IN ('SELECT', 'REFERENCES'))
     AND CASE
           WHEN r.rol = 'anon' THEN p.priv = 'SELECT' AND t.tbl NOT IN ('quote_items', 'quote_versions')
           WHEN p.priv = 'SELECT' THEN true
           WHEN p.priv = 'REFERENCES' THEN t.tbl <> 'quote_versions'
           ELSE t.tbl IN ('quotes', 'orders', 'jobs', 'job_chemicals', 'blend_ticket_products', 'commissions')
         END
     AND (t.tbl, a.attname::text) NOT IN (VALUES
       ('products', 'current_cost'), ('products', 'cost_updated_date'), ('products', 'tier1_margin'),
       ('products', 'tier2_margin'), ('products', 'tier3_margin'), ('products', 'tier1_gross_margin'),
       ('products', 'tier2_gross_margin'), ('products', 'tier3_gross_margin'), ('quotes', 'total_cost'),
       ('quotes', 'total_profit'), ('quotes', 'total_margin_pct'), ('quote_items', 'current_cost'),
       ('quote_items', 'profit'), ('quote_items', 'net_margin'), ('quote_items', 'cost_at_quote_cents'),
       ('quote_versions', 'snapshot_data'), ('orders', 'total_cost'), ('orders', 'total_profit'),
       ('orders', 'total_margin_pct'), ('order_items', 'cost_per_unit'), ('order_items', 'profit'),
       ('order_items', 'net_margin'), ('order_items', 'cost_at_time_cents'), ('invoices', 'total_cost_cents'),
       ('invoice_items', 'cost_cents'), ('invoice_items', 'return_credit_cogs_cents'), ('jobs', 'total_cost_cents'),
       ('job_chemicals', 'cost_per_unit_cents'), ('blend_ticket_products', 'unit_cost_cents'),
       ('commissions', 'order_profit'))
     AND NOT has_column_privilege(r.rol, c.oid, a.attname, p.priv);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: a role holds a privilege on only some non-cost columns; this file would widen it (re-read them): %', v_bad;
  END IF;

  -- A whole-row reference needs SELECT on every column, so any API-executable function that takes one
  -- of these row types (a PostgREST computed field) or returns one would fail for everyone once a cost column
  -- is gone (an invoker body), or would keep handing out cost (a definer body).
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_bad
    FROM pg_proc p
   WHERE (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
     AND EXISTS (
       -- Arguments, OUT/TABLE columns and the result, each as a row or an array of rows.
       SELECT 1 FROM unnest(p.proargtypes::oid[] || coalesce(p.proallargtypes, '{}'::oid[]) || ARRAY[p.prorettype]) AS a(typ)
         JOIN pg_type ty ON ty.oid = a.typ
         LEFT JOIN pg_type el ON el.oid = ty.typelem AND ty.typcategory = 'A'
        WHERE coalesce(nullif(ty.typrelid, 0), el.typrelid) IN ('public.products'::regclass, 'public.quotes'::regclass, 'public.quote_items'::regclass,
                              'public.quote_versions'::regclass, 'public.orders'::regclass, 'public.order_items'::regclass,
                              'public.invoices'::regclass, 'public.invoice_items'::regclass, 'public.jobs'::regclass,
                              'public.job_chemicals'::regclass, 'public.blend_ticket_products'::regclass,
                              'public.commissions'::regclass));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: these API-executable functions take or return a whole locked row and would fail or leak once cost is revoked; move them to an id-based form first: %', v_bad;
  END IF;

  -- Column grants cannot close a SECURITY DEFINER function that reads cost and hands it back. Each such
  -- function an API role can execute was read live on 2026-10-25: it is admin-only, blanks cost for
  -- non-admins, or returns none. Refuse on one that is not on that reviewed list (read it first).
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.prosecdef AND p.prokind = 'f'
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE'))
     AND p.prosrc ~* '(current_cost|total_cost|unit_cost|cost_cents|cost_per|cost_at|profit|margin|snapshot_data|cogs)'
     AND regexp_replace(p.oid::regprocedure::text, '^public[.]', '') NOT IN (
       'admin_get_application_service_costs(uuid)', 'admin_save_application_service(uuid,text,bigint,bigint,boolean,integer,uuid,text)',
       'admin_set_application_service_cost(uuid,bigint,text)', 'approve_supplier_price_import(uuid,uuid[],uuid,text)',
       'bulk_import_order(text,uuid,text,numeric,numeric,numeric,numeric,date,jsonb,text,text)', 'consolidate_draft_invoices(uuid,uuid,text)',
       'correct_supplier_price_observation(uuid,text,text,uuid,text)', 'create_invoice_from_blend_ticket(uuid,uuid,text,text,jsonb)',
       'create_job_from_quote_section(uuid,uuid,uuid,text)', 'create_pricing_workbook_export(uuid[],uuid,text)',
       'create_quote_from_template(uuid,uuid,uuid,text)', 'create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)',
       'dashboard_summary()', 'financial_dashboard_summary()', 'get_admin_cost_fields(text,uuid[])', 'get_bottom_line_pnl(date,date)',
       'get_customer_year_end_summary(uuid,integer)', 'get_detailed_statement_data(uuid,date,text)', 'get_field_profitability(text)',
       'get_gross_sales_report(date,date,text)', 'get_inventory_cost_report()', 'get_inventory_position()', 'get_monthly_summary(date,date)',
       'get_product_cost_basis_workspace(uuid)', 'get_product_price_history(uuid)', 'get_profitability_report(text,date,date)',
       'get_quote_versions(uuid)', 'get_sales_detail_report(date,date,uuid,uuid[],uuid,text,integer)',
       'get_sales_summary_report(text,date,date,uuid,uuid[],uuid,text,integer)', 'get_season_comparison(integer,integer)',
       'get_supplier_market_evidence(uuid[])', 'get_supplier_price_import(uuid)', 'get_supplier_quote_sheet(uuid)',
       'load_recipe_into_job(uuid,uuid,text)', 'manual_inventory_add(uuid,text,numeric,text,uuid,text,numeric,text,numeric,numeric)',
       'match_quick_receive_items(jsonb,text)', 'preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)',
       'rollover_quote_to_season(uuid,integer,uuid,text)', 'save_purchase_order(uuid,jsonb,jsonb,uuid,text)',
       'save_quote(uuid,jsonb,jsonb,uuid,text)', 'set_purchase_order_item_costs(uuid,jsonb,text,uuid,text)',
       'stage_supplier_price_import(uuid,date,text,text,text,text,text,jsonb,uuid,text)', 'transfer_invoice_to_job(uuid,uuid,text)',
       'trg_recalc_order_totals()', 'update_vendor_bill(uuid,bigint,bigint,date,date,text,text,boolean,text)');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: API-executable SECURITY DEFINER functions read cost and were not reviewed for returning it (read them, then add them here): %', v_bad;
  END IF;

  -- No view or materialized view may read a cost column (a definer view would keep exposing it; an
  -- invoker view would start failing), and none may read a whole locked row.
  SELECT string_agg(DISTINCT format('%s reads %s.%s', v.relname, src.relname, coalesce(a.attname::text, '*')), '; ') INTO v_bad
    FROM pg_depend d
    JOIN pg_rewrite rw ON rw.oid = d.objid
    JOIN pg_class v ON v.oid = rw.ev_class AND v.relkind IN ('v', 'm')
    JOIN pg_class src ON src.oid = d.refobjid
    LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
   WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND v.oid <> src.oid
     AND src.oid IN ('public.products'::regclass, 'public.quotes'::regclass, 'public.quote_items'::regclass,
                     'public.quote_versions'::regclass, 'public.orders'::regclass, 'public.order_items'::regclass,
                     'public.invoices'::regclass, 'public.invoice_items'::regclass, 'public.jobs'::regclass,
                     'public.job_chemicals'::regclass, 'public.blend_ticket_products'::regclass,
                     'public.commissions'::regclass)
     AND (d.refobjsubid = 0 OR (src.relname, a.attname::text) IN (VALUES
       ('products', 'current_cost'), ('products', 'cost_updated_date'), ('products', 'tier1_margin'),
       ('products', 'tier2_margin'), ('products', 'tier3_margin'), ('products', 'tier1_gross_margin'),
       ('products', 'tier2_gross_margin'), ('products', 'tier3_gross_margin'), ('quotes', 'total_cost'),
       ('quotes', 'total_profit'), ('quotes', 'total_margin_pct'), ('quote_items', 'current_cost'),
       ('quote_items', 'profit'), ('quote_items', 'net_margin'), ('quote_items', 'cost_at_quote_cents'),
       ('quote_versions', 'snapshot_data'), ('orders', 'total_cost'), ('orders', 'total_profit'),
       ('orders', 'total_margin_pct'), ('order_items', 'cost_per_unit'), ('order_items', 'profit'),
       ('order_items', 'net_margin'), ('order_items', 'cost_at_time_cents'), ('invoices', 'total_cost_cents'),
       ('invoice_items', 'cost_cents'), ('invoice_items', 'return_credit_cogs_cents'), ('jobs', 'total_cost_cents'),
       ('job_chemicals', 'cost_per_unit_cents'), ('blend_ticket_products', 'unit_cost_cents'),
       ('commissions', 'order_profit')));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: a view reads a cost column or a whole locked row: %', v_bad;
  END IF;

  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.products'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'category,container_size,container_type,container_unit,cost_updated_date,created_at,current_cost,'
       'epa_registration,id,internal_notes,inventory_unit,is_active,is_full_tote_only,is_rup,manufacture'
       'r,max_label_rate,max_label_rate_unit,notes,packaging_variant,phi_days,pricing_version,product_fa'
       'mily_id,product_form,product_name,quoting_notes,rate_per_acre,rate_unit,rei_hours,return_policy,'
       'signal_word,sku,suggested_rate,tier1_gross_margin,tier1_margin,tier1_price,tier1_price_per_acre,'
       'tier2_gross_margin,tier2_margin,tier2_price,tier2_price_per_acre,tier3_gross_margin,tier3_margin'
       ',tier3_price,tier3_price_per_acre,unit_size,updated_at,use_timing,vendor' THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: products columns are not the ones this grant list covers (re-read them): %', v_cols;
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.quotes'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'commission_split,created_at,created_by,customer_id,deleted_at,expires_at,footer_notes,header_not'
       'es,id,is_planned,pdf_columns_override,pdf_template_id,quote_number,row_version,salesman_id,seaso'
       'n,sent_at,status,tier,total_cost,total_margin_pct,total_price,total_profit,updated_at,valid_days' THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: quotes columns are not the ones this grant list covers (re-read them): %', v_cols;
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.quote_items'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'acres,actual_rate,calc_mode,cost_at_quote_cents,current_cost,id,net_margin,notes,oz_per_acre,pri'
       'ce_override,price_per_acre,price_per_unit,price_unit,product_id,profit,quote_id,rate_unit,sectio'
       'n_id,sort_order,suggested_rate,total_price,total_units_needed,unit_size' THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: quote_items columns are not the ones this grant list covers (re-read them): %', v_cols;
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.quote_versions'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'id,notes,pdf_url,quote_id,restore_trusted_at,sent_at,sent_by,sent_method,snapshot_data,version_n'
       'umber' THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: quote_versions columns are not the ones this grant list covers (re-read them): %', v_cols;
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.orders'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'booking_draw,commission_split,created_at,customer_id,customer_po_number,deleted_at,id,is_planned'
       ',needs_split_billing,notes,order_date,order_name,order_number,pricing_escalation_sent_at,pricing'
       '_reminder_sent_at,pricing_status,program_notes,quote_id,salesman_id,season,status,total_cost,tot'
       'al_margin_pct,total_price,total_profit,updated_at' THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: orders columns are not the ones this grant list covers (re-read them): %', v_cols;
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.order_items'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'acres,actual_rate,cost_at_time_cents,cost_per_unit,id,net_margin,notes,order_id,price_per_unit,p'
       'ricing_pending,product_id,product_name,profit,quantity_delivered,quantity_remaining,quote_item_i'
       'd,rate_unit,section_name,sort_order,suggested_price,total_price,total_units_needed,unit_size' THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: order_items columns are not the ones this grant list covers (re-read them): %', v_cols;
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.invoices'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'application_date,application_service_id,applicator_name,balance_cents,blend_ticket_id,created_at'
       ',created_by,credit_applied_cents,crop_type,customer_id,deleted_at,delivery_id,diluent_rate_gpa,d'
       'iscount_date,discount_earned_cents,due_date,end_humidity_pct,end_temp_f,end_weather_source,end_w'
       'eather_time,end_wind_direction,end_wind_mph,field_app_billing_set_id,field_names,footer_notes,he'
       'ader_notes,id,internal_notes,invoice_date,invoice_group_id,invoice_number,invoice_type,is_quick_'
       'delivery,job_id,order_id,paid_amount_cents,parent_invoice_id,payment_terms,posted_at,posted_by,p'
       'repay_applied_cents,pricing_pending,purchase_order_ref,salesman_id,season,send_disposition,start'
       '_humidity_pct,start_temp_f,start_weather_source,start_weather_time,start_wind_direction,start_wi'
       'nd_mph,status,temperature_text,total_acres,total_amount_cents,total_cost_cents,updated_at,vehicl'
       'e_name,void_reason,voided_at,voided_by,weather_manual_override,wind_direction,write_off_cents' THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: invoices columns are not the ones this grant list covers (re-read them): %', v_cols;
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.invoice_items'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'acres,billing_line_id,charge_type,cost_cents,created_at,description,epa_registration,extended_ce'
       'nts,gl_lb_unit,id,invoice_id,is_application_fee,notes,order_item_id,price_source,product_form,pr'
       'oduct_id,quantity,quoted_price_cents,rate_per_acre,rate_unit,return_credit_cogs_cents,return_cre'
       'dit_source_item_id,sort_order,total_applied,total_applied_gl_lb,total_applied_unit,tote_number,u'
       'nit_price_cents,unit_size,updated_at,vendor,warehouse' THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: invoice_items columns are not the ones this grant list covers (re-read them): %', v_cols;
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.jobs'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'additional_info,application_service_id,applicator_id,applied_acres,batch_id,batch_ref,call_date,'
       'carrier_rate_gpa,commission_split,consultant_id,created_at,created_by,customer_id,date_expires,d'
       'ate_proposed,deleted_at,estimated_hours,ground_crew_id,id,internal_memo,invoice_id,job_date,job_'
       'number,last_printed_by,loader_comment,loader_tank_capacity,notes,printed_at,priority,quote_id,qu'
       'ote_section_id,recipe_id,remaining_acres,schedule_date,scheduled_time,season,status,tags,time_pr'
       'oposed,total_acres,total_cost_cents,total_price_cents,updated_at,updated_by,vehicle_id' THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: jobs columns are not the ones this grant list covers (re-read them): %', v_cols;
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.job_chemicals'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'cost_per_unit_cents,customer_supplied,diluent_rate,driver,id,job_id,phi_days,price_per_unit_cent'
       's,product_id,quantity,rate_per_acre,rate_unit,rei_hours,sort_order,unit,vendor,warehouse' THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: job_chemicals columns are not the ones this grant list covers (re-read them): %', v_cols;
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.blend_ticket_products'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'blend_ticket_id,confidence_score,created_at,id,lot_number,manually_corrected,product_id,product_'
       'name,quantity,rate_per_acre,rate_per_acre_unit,sequence_order,unit,unit_cost_cents,unit_price_ce'
       'nts' THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: blend_ticket_products columns are not the ones this grant list covers (re-read them): %', v_cols;
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.commissions'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM 'cancelled_amount_cents,cancelled_at,commission_amount,created_at,customer_id,customer_name,delet'
       'ed_at,id,invoice_id,job_id,order_date,order_id,order_number,order_profit,paid_date,paid_note,rec'
       'ipient,recipient_user_id,season,split_percentage,status' THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: commissions columns are not the ones this grant list covers (re-read them): %', v_cols;
  END IF;
  -- The two admin-checked readers this lock leaves as the only way to cost: the reviewed 20261019230000
  -- bodies (live md5 2026-10-22), SECURITY DEFINER owned by postgres with search_path = public, pg_temp
  -- (live 2026-10-23), executable by authenticated and not by anon.
  IF to_regprocedure('public.get_admin_cost_fields(text,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: get_admin_cost_fields(text, uuid[]) is missing; admins would lose cost';
  END IF;
  IF to_regprocedure('public.get_quote_versions(uuid)') IS NULL THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: get_quote_versions(uuid) is missing; quote history would lose its snapshot';
  END IF;
  SELECT string_agg(f.sig, ', ') INTO v_bad
    FROM (VALUES ('public.get_admin_cost_fields(text,uuid[])', 'cda5e9b6574e4eb1583c4d8812b9e51b'),
                 ('public.get_quote_versions(uuid)', '8f0592c4877da51eb5b9074b775ed0cc')) AS f(sig, body_md5)
    JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)
   WHERE md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM f.body_md5
      OR NOT p.prosecdef
      OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres'
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
      OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'COST_LOCK_PREFLIGHT: not the reviewed admin-checked SECURITY DEFINER bodies and grants: %', v_bad;
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------------
-- products: everything but current_cost, cost_updated_date, tier1_margin, tier2_margin, tier3_margin, tier1_gross_margin, tier2_gross_margin, tier3_gross_margin.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT, REFERENCES ON public.products FROM authenticated;
REVOKE SELECT ON public.products FROM anon;

GRANT SELECT (
  id, product_name, sku, category, vendor, manufacturer, container_size, unit_size, tier1_price, tier2_price,
  tier3_price, tier1_price_per_acre, tier2_price_per_acre, tier3_price_per_acre, suggested_rate,
  rate_per_acre, rate_unit, notes, is_active, created_at, updated_at, epa_registration, product_form,
  inventory_unit, container_unit, container_type, is_rup, signal_word, internal_notes, rei_hours, phi_days,
  max_label_rate, max_label_rate_unit, use_timing, pricing_version, quoting_notes, product_family_id,
  return_policy, packaging_variant, is_full_tote_only
) ON public.products TO authenticated;
GRANT REFERENCES (
  id, product_name, sku, category, vendor, manufacturer, container_size, unit_size, tier1_price, tier2_price,
  tier3_price, tier1_price_per_acre, tier2_price_per_acre, tier3_price_per_acre, suggested_rate,
  rate_per_acre, rate_unit, notes, is_active, created_at, updated_at, epa_registration, product_form,
  inventory_unit, container_unit, container_type, is_rup, signal_word, internal_notes, rei_hours, phi_days,
  max_label_rate, max_label_rate_unit, use_timing, pricing_version, quoting_notes, product_family_id,
  return_policy, packaging_variant, is_full_tote_only
) ON public.products TO authenticated;
GRANT SELECT (
  id, product_name, sku, category, vendor, manufacturer, container_size, unit_size, tier1_price, tier2_price,
  tier3_price, tier1_price_per_acre, tier2_price_per_acre, tier3_price_per_acre, suggested_rate,
  rate_per_acre, rate_unit, notes, is_active, created_at, updated_at, epa_registration, product_form,
  inventory_unit, container_unit, container_type, is_rup, signal_word, internal_notes, rei_hours, phi_days,
  max_label_rate, max_label_rate_unit, use_timing, pricing_version, quoting_notes, product_family_id,
  return_policy, packaging_variant, is_full_tote_only
) ON public.products TO anon;

-- ---------------------------------------------------------------------------------------------------
-- quotes: everything but total_cost, total_profit, total_margin_pct.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT, REFERENCES ON public.quotes FROM authenticated;
REVOKE SELECT ON public.quotes FROM anon;

GRANT SELECT (
  id, quote_number, customer_id, created_by, tier, status, commission_split, total_price, valid_days,
  expires_at, header_notes, footer_notes, created_at, updated_at, sent_at, is_planned, season, salesman_id,
  deleted_at, pdf_template_id, pdf_columns_override, row_version
) ON public.quotes TO authenticated;
GRANT REFERENCES (
  id, quote_number, customer_id, created_by, tier, status, commission_split, total_price, valid_days,
  expires_at, header_notes, footer_notes, created_at, updated_at, sent_at, is_planned, season, salesman_id,
  deleted_at, pdf_template_id, pdf_columns_override, row_version
) ON public.quotes TO authenticated;
GRANT SELECT (
  id, quote_number, customer_id, created_by, tier, status, commission_split, total_price, valid_days,
  expires_at, header_notes, footer_notes, created_at, updated_at, sent_at, is_planned, season, salesman_id,
  deleted_at, pdf_template_id, pdf_columns_override, row_version
) ON public.quotes TO anon;

REVOKE INSERT, UPDATE ON public.quotes FROM authenticated;
GRANT INSERT (
  id, quote_number, customer_id, created_by, tier, status, commission_split, total_price, valid_days,
  expires_at, header_notes, footer_notes, created_at, updated_at, sent_at, is_planned, season, salesman_id,
  deleted_at, pdf_template_id, pdf_columns_override, row_version
) ON public.quotes TO authenticated;
GRANT UPDATE (
  id, quote_number, customer_id, created_by, tier, status, commission_split, total_price, valid_days,
  expires_at, header_notes, footer_notes, created_at, updated_at, sent_at, is_planned, season, salesman_id,
  deleted_at, pdf_template_id, pdf_columns_override, row_version
) ON public.quotes TO authenticated;

-- ---------------------------------------------------------------------------------------------------
-- quote_items: everything but current_cost, profit, net_margin, cost_at_quote_cents.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT, REFERENCES ON public.quote_items FROM authenticated;

GRANT SELECT (
  id, quote_id, section_id, product_id, sort_order, notes, price_per_unit, suggested_rate, actual_rate,
  rate_unit, oz_per_acre, price_per_acre, acres, total_units_needed, unit_size, total_price, calc_mode,
  price_unit, price_override
) ON public.quote_items TO authenticated;
GRANT REFERENCES (
  id, quote_id, section_id, product_id, sort_order, notes, price_per_unit, suggested_rate, actual_rate,
  rate_unit, oz_per_acre, price_per_acre, acres, total_units_needed, unit_size, total_price, calc_mode,
  price_unit, price_override
) ON public.quote_items TO authenticated;

-- ---------------------------------------------------------------------------------------------------
-- quote_versions: everything but snapshot_data.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT ON public.quote_versions FROM authenticated;

GRANT SELECT (
  id, quote_id, version_number, sent_by, sent_at, sent_method, pdf_url, notes, restore_trusted_at
) ON public.quote_versions TO authenticated;

-- ---------------------------------------------------------------------------------------------------
-- orders: everything but total_cost, total_profit, total_margin_pct.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT, REFERENCES ON public.orders FROM authenticated;
REVOKE SELECT ON public.orders FROM anon;

GRANT SELECT (
  id, order_number, quote_id, customer_id, status, commission_split, total_price, order_date, notes,
  created_at, updated_at, season, salesman_id, deleted_at, order_name, customer_po_number, is_planned,
  program_notes, booking_draw, pricing_status, pricing_reminder_sent_at, pricing_escalation_sent_at,
  needs_split_billing
) ON public.orders TO authenticated;
GRANT REFERENCES (
  id, order_number, quote_id, customer_id, status, commission_split, total_price, order_date, notes,
  created_at, updated_at, season, salesman_id, deleted_at, order_name, customer_po_number, is_planned,
  program_notes, booking_draw, pricing_status, pricing_reminder_sent_at, pricing_escalation_sent_at,
  needs_split_billing
) ON public.orders TO authenticated;
GRANT SELECT (
  id, order_number, quote_id, customer_id, status, commission_split, total_price, order_date, notes,
  created_at, updated_at, season, salesman_id, deleted_at, order_name, customer_po_number, is_planned,
  program_notes, booking_draw, pricing_status, pricing_reminder_sent_at, pricing_escalation_sent_at,
  needs_split_billing
) ON public.orders TO anon;

REVOKE INSERT, UPDATE ON public.orders FROM authenticated;
GRANT INSERT (
  id, order_number, quote_id, customer_id, status, commission_split, total_price, order_date, notes,
  created_at, updated_at, season, salesman_id, deleted_at, order_name, customer_po_number, is_planned,
  program_notes, booking_draw, pricing_status, pricing_reminder_sent_at, pricing_escalation_sent_at,
  needs_split_billing
) ON public.orders TO authenticated;
GRANT UPDATE (
  id, order_number, quote_id, customer_id, status, commission_split, total_price, order_date, notes,
  created_at, updated_at, season, salesman_id, deleted_at, order_name, customer_po_number, is_planned,
  program_notes, booking_draw, pricing_status, pricing_reminder_sent_at, pricing_escalation_sent_at,
  needs_split_billing
) ON public.orders TO authenticated;

-- ---------------------------------------------------------------------------------------------------
-- order_items: everything but cost_per_unit, profit, net_margin, cost_at_time_cents.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT, REFERENCES ON public.order_items FROM authenticated;
REVOKE SELECT ON public.order_items FROM anon;

GRANT SELECT (
  id, order_id, product_id, quote_item_id, section_name, product_name, price_per_unit, actual_rate, rate_unit,
  acres, total_units_needed, unit_size, total_price, quantity_delivered, quantity_remaining, sort_order,
  notes, pricing_pending, suggested_price
) ON public.order_items TO authenticated;
GRANT REFERENCES (
  id, order_id, product_id, quote_item_id, section_name, product_name, price_per_unit, actual_rate, rate_unit,
  acres, total_units_needed, unit_size, total_price, quantity_delivered, quantity_remaining, sort_order,
  notes, pricing_pending, suggested_price
) ON public.order_items TO authenticated;
GRANT SELECT (
  id, order_id, product_id, quote_item_id, section_name, product_name, price_per_unit, actual_rate, rate_unit,
  acres, total_units_needed, unit_size, total_price, quantity_delivered, quantity_remaining, sort_order,
  notes, pricing_pending, suggested_price
) ON public.order_items TO anon;

-- ---------------------------------------------------------------------------------------------------
-- invoices: everything but total_cost_cents.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT, REFERENCES ON public.invoices FROM authenticated;
REVOKE SELECT ON public.invoices FROM anon;

GRANT SELECT (
  id, invoice_number, order_id, blend_ticket_id, customer_id, invoice_type, status, season, salesman_id,
  created_by, total_amount_cents, paid_amount_cents, prepay_applied_cents, posted_by, posted_at, voided_by,
  voided_at, void_reason, invoice_date, due_date, purchase_order_ref, header_notes, footer_notes,
  parent_invoice_id, deleted_at, created_at, updated_at, crop_type, field_names, total_acres, applicator_name,
  vehicle_name, application_date, job_id, is_quick_delivery, write_off_cents, invoice_group_id,
  application_service_id, delivery_id, wind_direction, temperature_text, pricing_pending, payment_terms,
  internal_notes, discount_earned_cents, discount_date, start_temp_f, start_wind_mph, start_wind_direction,
  start_humidity_pct, start_weather_time, start_weather_source, end_temp_f, end_wind_mph, end_wind_direction,
  end_humidity_pct, end_weather_time, end_weather_source, weather_manual_override, diluent_rate_gpa,
  credit_applied_cents, balance_cents, send_disposition, field_app_billing_set_id
) ON public.invoices TO authenticated;
GRANT REFERENCES (
  id, invoice_number, order_id, blend_ticket_id, customer_id, invoice_type, status, season, salesman_id,
  created_by, total_amount_cents, paid_amount_cents, prepay_applied_cents, posted_by, posted_at, voided_by,
  voided_at, void_reason, invoice_date, due_date, purchase_order_ref, header_notes, footer_notes,
  parent_invoice_id, deleted_at, created_at, updated_at, crop_type, field_names, total_acres, applicator_name,
  vehicle_name, application_date, job_id, is_quick_delivery, write_off_cents, invoice_group_id,
  application_service_id, delivery_id, wind_direction, temperature_text, pricing_pending, payment_terms,
  internal_notes, discount_earned_cents, discount_date, start_temp_f, start_wind_mph, start_wind_direction,
  start_humidity_pct, start_weather_time, start_weather_source, end_temp_f, end_wind_mph, end_wind_direction,
  end_humidity_pct, end_weather_time, end_weather_source, weather_manual_override, diluent_rate_gpa,
  credit_applied_cents, balance_cents, send_disposition, field_app_billing_set_id
) ON public.invoices TO authenticated;
GRANT SELECT (
  id, invoice_number, order_id, blend_ticket_id, customer_id, invoice_type, status, season, salesman_id,
  created_by, total_amount_cents, paid_amount_cents, prepay_applied_cents, posted_by, posted_at, voided_by,
  voided_at, void_reason, invoice_date, due_date, purchase_order_ref, header_notes, footer_notes,
  parent_invoice_id, deleted_at, created_at, updated_at, crop_type, field_names, total_acres, applicator_name,
  vehicle_name, application_date, job_id, is_quick_delivery, write_off_cents, invoice_group_id,
  application_service_id, delivery_id, wind_direction, temperature_text, pricing_pending, payment_terms,
  internal_notes, discount_earned_cents, discount_date, start_temp_f, start_wind_mph, start_wind_direction,
  start_humidity_pct, start_weather_time, start_weather_source, end_temp_f, end_wind_mph, end_wind_direction,
  end_humidity_pct, end_weather_time, end_weather_source, weather_manual_override, diluent_rate_gpa,
  credit_applied_cents, balance_cents, send_disposition, field_app_billing_set_id
) ON public.invoices TO anon;

-- ---------------------------------------------------------------------------------------------------
-- invoice_items: everything but cost_cents, return_credit_cogs_cents.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT, REFERENCES ON public.invoice_items FROM authenticated;
REVOKE SELECT ON public.invoice_items FROM anon;

GRANT SELECT (
  id, invoice_id, order_item_id, product_id, charge_type, description, quantity, unit_price_cents,
  extended_cents, sort_order, rate_per_acre, acres, unit_size, notes, created_at, updated_at, rate_unit,
  total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit, epa_registration, product_form,
  is_application_fee, tote_number, quoted_price_cents, price_source, warehouse, vendor, billing_line_id,
  return_credit_source_item_id
) ON public.invoice_items TO authenticated;
GRANT REFERENCES (
  id, invoice_id, order_item_id, product_id, charge_type, description, quantity, unit_price_cents,
  extended_cents, sort_order, rate_per_acre, acres, unit_size, notes, created_at, updated_at, rate_unit,
  total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit, epa_registration, product_form,
  is_application_fee, tote_number, quoted_price_cents, price_source, warehouse, vendor, billing_line_id,
  return_credit_source_item_id
) ON public.invoice_items TO authenticated;
GRANT SELECT (
  id, invoice_id, order_item_id, product_id, charge_type, description, quantity, unit_price_cents,
  extended_cents, sort_order, rate_per_acre, acres, unit_size, notes, created_at, updated_at, rate_unit,
  total_applied, total_applied_unit, total_applied_gl_lb, gl_lb_unit, epa_registration, product_form,
  is_application_fee, tote_number, quoted_price_cents, price_source, warehouse, vendor, billing_line_id,
  return_credit_source_item_id
) ON public.invoice_items TO anon;

-- ---------------------------------------------------------------------------------------------------
-- jobs: everything but total_cost_cents.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT, REFERENCES ON public.jobs FROM authenticated;
REVOKE SELECT ON public.jobs FROM anon;

GRANT SELECT (
  id, job_number, customer_id, status, job_date, scheduled_time, applicator_id, vehicle_id, recipe_id, notes,
  tags, batch_id, season, total_acres, total_price_cents, invoice_id, created_by, deleted_at, created_at,
  updated_at, priority, estimated_hours, quote_id, quote_section_id, application_service_id, call_date,
  date_proposed, time_proposed, schedule_date, date_expires, consultant_id, loader_comment, additional_info,
  internal_memo, applied_acres, updated_by, printed_at, remaining_acres, ground_crew_id, batch_ref,
  last_printed_by, carrier_rate_gpa, loader_tank_capacity, commission_split
) ON public.jobs TO authenticated;
GRANT REFERENCES (
  id, job_number, customer_id, status, job_date, scheduled_time, applicator_id, vehicle_id, recipe_id, notes,
  tags, batch_id, season, total_acres, total_price_cents, invoice_id, created_by, deleted_at, created_at,
  updated_at, priority, estimated_hours, quote_id, quote_section_id, application_service_id, call_date,
  date_proposed, time_proposed, schedule_date, date_expires, consultant_id, loader_comment, additional_info,
  internal_memo, applied_acres, updated_by, printed_at, remaining_acres, ground_crew_id, batch_ref,
  last_printed_by, carrier_rate_gpa, loader_tank_capacity, commission_split
) ON public.jobs TO authenticated;
GRANT SELECT (
  id, job_number, customer_id, status, job_date, scheduled_time, applicator_id, vehicle_id, recipe_id, notes,
  tags, batch_id, season, total_acres, total_price_cents, invoice_id, created_by, deleted_at, created_at,
  updated_at, priority, estimated_hours, quote_id, quote_section_id, application_service_id, call_date,
  date_proposed, time_proposed, schedule_date, date_expires, consultant_id, loader_comment, additional_info,
  internal_memo, applied_acres, updated_by, printed_at, remaining_acres, ground_crew_id, batch_ref,
  last_printed_by, carrier_rate_gpa, loader_tank_capacity, commission_split
) ON public.jobs TO anon;

REVOKE INSERT, UPDATE ON public.jobs FROM authenticated;
GRANT INSERT (
  id, job_number, customer_id, status, job_date, scheduled_time, applicator_id, vehicle_id, recipe_id, notes,
  tags, batch_id, season, total_acres, total_price_cents, invoice_id, created_by, deleted_at, created_at,
  updated_at, priority, estimated_hours, quote_id, quote_section_id, application_service_id, call_date,
  date_proposed, time_proposed, schedule_date, date_expires, consultant_id, loader_comment, additional_info,
  internal_memo, applied_acres, updated_by, printed_at, ground_crew_id, batch_ref, last_printed_by,
  carrier_rate_gpa, loader_tank_capacity, commission_split
) ON public.jobs TO authenticated;
GRANT UPDATE (
  id, job_number, customer_id, status, job_date, scheduled_time, applicator_id, vehicle_id, recipe_id, notes,
  tags, batch_id, season, total_acres, total_price_cents, invoice_id, created_by, deleted_at, created_at,
  updated_at, priority, estimated_hours, quote_id, quote_section_id, application_service_id, call_date,
  date_proposed, time_proposed, schedule_date, date_expires, consultant_id, loader_comment, additional_info,
  internal_memo, applied_acres, updated_by, printed_at, ground_crew_id, batch_ref, last_printed_by,
  carrier_rate_gpa, loader_tank_capacity, commission_split
) ON public.jobs TO authenticated;

-- ---------------------------------------------------------------------------------------------------
-- job_chemicals: everything but cost_per_unit_cents.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT, REFERENCES ON public.job_chemicals FROM authenticated;
REVOKE SELECT ON public.job_chemicals FROM anon;

GRANT SELECT (
  id, job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, sort_order,
  diluent_rate, rei_hours, phi_days, warehouse, vendor, customer_supplied, driver
) ON public.job_chemicals TO authenticated;
GRANT REFERENCES (
  id, job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, sort_order,
  diluent_rate, rei_hours, phi_days, warehouse, vendor, customer_supplied, driver
) ON public.job_chemicals TO authenticated;
GRANT SELECT (
  id, job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, sort_order,
  diluent_rate, rei_hours, phi_days, warehouse, vendor, customer_supplied, driver
) ON public.job_chemicals TO anon;

REVOKE INSERT, UPDATE ON public.job_chemicals FROM authenticated;
GRANT INSERT (
  id, job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, sort_order,
  diluent_rate, rei_hours, phi_days, warehouse, vendor, customer_supplied, driver
) ON public.job_chemicals TO authenticated;
GRANT UPDATE (
  id, job_id, product_id, quantity, unit, rate_per_acre, rate_unit, price_per_unit_cents, sort_order,
  diluent_rate, rei_hours, phi_days, warehouse, vendor, customer_supplied, driver
) ON public.job_chemicals TO authenticated;

-- ---------------------------------------------------------------------------------------------------
-- blend_ticket_products: everything but unit_cost_cents.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT, REFERENCES ON public.blend_ticket_products FROM authenticated;
REVOKE SELECT ON public.blend_ticket_products FROM anon;

GRANT SELECT (
  id, blend_ticket_id, product_id, product_name, quantity, unit, lot_number, sequence_order, confidence_score,
  manually_corrected, created_at, rate_per_acre, rate_per_acre_unit, unit_price_cents
) ON public.blend_ticket_products TO authenticated;
GRANT REFERENCES (
  id, blend_ticket_id, product_id, product_name, quantity, unit, lot_number, sequence_order, confidence_score,
  manually_corrected, created_at, rate_per_acre, rate_per_acre_unit, unit_price_cents
) ON public.blend_ticket_products TO authenticated;
GRANT SELECT (
  id, blend_ticket_id, product_id, product_name, quantity, unit, lot_number, sequence_order, confidence_score,
  manually_corrected, created_at, rate_per_acre, rate_per_acre_unit, unit_price_cents
) ON public.blend_ticket_products TO anon;

REVOKE INSERT, UPDATE ON public.blend_ticket_products FROM authenticated;
GRANT INSERT (
  id, blend_ticket_id, product_id, product_name, quantity, unit, lot_number, sequence_order, confidence_score,
  manually_corrected, created_at, rate_per_acre, rate_per_acre_unit, unit_price_cents
) ON public.blend_ticket_products TO authenticated;
GRANT UPDATE (
  id, blend_ticket_id, product_id, product_name, quantity, unit, lot_number, sequence_order, confidence_score,
  manually_corrected, created_at, rate_per_acre, rate_per_acre_unit, unit_price_cents
) ON public.blend_ticket_products TO authenticated;

-- ---------------------------------------------------------------------------------------------------
-- commissions: everything but order_profit.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT, REFERENCES ON public.commissions FROM authenticated;
REVOKE SELECT ON public.commissions FROM anon;

GRANT SELECT (
  id, order_id, customer_id, recipient, split_percentage, commission_amount, order_date, status, created_at,
  paid_date, paid_note, recipient_user_id, season, deleted_at, order_number, customer_name, job_id,
  invoice_id, cancelled_at, cancelled_amount_cents
) ON public.commissions TO authenticated;
GRANT REFERENCES (
  id, order_id, customer_id, recipient, split_percentage, commission_amount, order_date, status, created_at,
  paid_date, paid_note, recipient_user_id, season, deleted_at, order_number, customer_name, job_id,
  invoice_id, cancelled_at, cancelled_amount_cents
) ON public.commissions TO authenticated;
GRANT SELECT (
  id, order_id, customer_id, recipient, split_percentage, commission_amount, order_date, status, created_at,
  paid_date, paid_note, recipient_user_id, season, deleted_at, order_number, customer_name, job_id,
  invoice_id, cancelled_at, cancelled_amount_cents
) ON public.commissions TO anon;

REVOKE INSERT, UPDATE ON public.commissions FROM authenticated;
GRANT INSERT (
  id, order_id, customer_id, recipient, split_percentage, commission_amount, order_date, status, created_at,
  paid_date, paid_note, recipient_user_id, season, deleted_at, order_number, customer_name, job_id,
  invoice_id, cancelled_at, cancelled_amount_cents
) ON public.commissions TO authenticated;
GRANT UPDATE (
  id, order_id, customer_id, recipient, split_percentage, commission_amount, order_date, status, created_at,
  paid_date, paid_note, recipient_user_id, season, deleted_at, order_number, customer_name, job_id,
  invoice_id, cancelled_at, cancelled_amount_cents
) ON public.commissions TO authenticated;

DO $verify$
DECLARE
  r record;
  v_cost boolean;
  v_want boolean;
BEGIN
  -- Every column of every table: a cost column is granted to no API role, every other column keeps
  -- exactly the privileges the table held before this migration.
  FOR r IN
    SELECT e.tbl, ('public.' || e.tbl)::regclass AS rel, a.attname, role.name AS rolname, priv.name AS privname,
           e.auth_ref, e.anon_sel, e.writes
      FROM (VALUES
      ('products', true, true, false),
      ('quotes', true, true, true),
      ('quote_items', true, false, false),
      ('quote_versions', false, false, false),
      ('orders', true, true, true),
      ('order_items', true, true, false),
      ('invoices', true, true, false),
      ('invoice_items', true, true, false),
      ('jobs', true, true, true),
      ('job_chemicals', true, true, true),
      ('blend_ticket_products', true, true, true),
      ('commissions', true, true, true)
           ) AS e(tbl, auth_ref, anon_sel, writes)
      JOIN pg_attribute a ON a.attrelid = ('public.' || e.tbl)::regclass AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN (VALUES ('authenticated'), ('anon')) AS role(name)
      CROSS JOIN (VALUES ('SELECT'), ('REFERENCES'), ('INSERT'), ('UPDATE')) AS priv(name)
  LOOP
    v_cost := (r.tbl, r.attname::text) IN (VALUES
      ('products', 'current_cost'),
      ('products', 'cost_updated_date'),
      ('products', 'tier1_margin'),
      ('products', 'tier2_margin'),
      ('products', 'tier3_margin'),
      ('products', 'tier1_gross_margin'),
      ('products', 'tier2_gross_margin'),
      ('products', 'tier3_gross_margin'),
      ('quotes', 'total_cost'),
      ('quotes', 'total_profit'),
      ('quotes', 'total_margin_pct'),
      ('quote_items', 'current_cost'),
      ('quote_items', 'profit'),
      ('quote_items', 'net_margin'),
      ('quote_items', 'cost_at_quote_cents'),
      ('quote_versions', 'snapshot_data'),
      ('orders', 'total_cost'),
      ('orders', 'total_profit'),
      ('orders', 'total_margin_pct'),
      ('order_items', 'cost_per_unit'),
      ('order_items', 'profit'),
      ('order_items', 'net_margin'),
      ('order_items', 'cost_at_time_cents'),
      ('invoices', 'total_cost_cents'),
      ('invoice_items', 'cost_cents'),
      ('invoice_items', 'return_credit_cogs_cents'),
      ('jobs', 'total_cost_cents'),
      ('job_chemicals', 'cost_per_unit_cents'),
      ('blend_ticket_products', 'unit_cost_cents'),
      ('commissions', 'order_profit'));
    v_want := NOT v_cost AND CASE
      WHEN r.rolname = 'anon' THEN r.privname = 'SELECT' AND r.anon_sel
      WHEN r.privname = 'SELECT' THEN true
      WHEN r.privname = 'REFERENCES' THEN r.auth_ref
      ELSE r.writes AND (r.tbl, r.attname::text) NOT IN (VALUES
      ('invoices', 'balance_cents'),
      ('jobs', 'remaining_acres'))
    END;
    -- products keeps its older column-level INSERT/UPDATE grants (no cost column among them).
    CONTINUE WHEN r.tbl = 'products' AND r.rolname = 'authenticated' AND r.privname IN ('INSERT', 'UPDATE') AND NOT v_cost;
    IF has_column_privilege(r.rolname, r.rel, r.attname, r.privname) IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION 'COST_LOCK_VERIFY: % % on %.% is %', r.rolname, r.privname, r.tbl, r.attname,
        CASE WHEN v_want THEN 'not granted' ELSE 'still granted' END;
    END IF;
  END LOOP;
  -- No table-level SELECT, INSERT or UPDATE survives for either API role (each would imply every column).
  FOR r IN
    SELECT t.tbl, role.name AS rolname, priv.name AS privname
      FROM unnest(ARRAY['products', 'quotes', 'quote_items', 'quote_versions', 'orders', 'order_items', 'invoices', 'invoice_items', 'jobs', 'job_chemicals', 'blend_ticket_products', 'commissions']) AS t(tbl)
      CROSS JOIN (VALUES ('authenticated'), ('anon')) AS role(name)
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE')) AS priv(name)
  LOOP
    IF has_table_privilege(r.rolname, ('public.' || r.tbl)::regclass, r.privname) THEN
      RAISE EXCEPTION 'COST_LOCK_VERIFY: % still holds table-level % on %', r.rolname, r.privname, r.tbl;
    END IF;
  END LOOP;
END
$verify$;
