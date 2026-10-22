-- Written 2026-10-22. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 969).
--
-- WHAT: the invoice posting version (20261021200000, PR #1018) moves onto a column-safe relation,
--   so it keeps working once the cost column lock (20261022030000, Goal 1 step 3) takes
--   invoices.total_cost_cents away from the API roles.
--   1. public.invoices_postable: a security_invoker view of every invoices column except the cost
--      column the lock revokes (total_cost_cents). Row security and column privileges are checked
--      as the CALLER, so a rep sees exactly the invoices (and columns) they see on the table. It
--      names its columns, so it never reads a whole invoices row. SELECT only, to authenticated.
--   2. invoice_post_version(public.invoices_postable): the same computed field, on the view. Same
--      access rule (an admin, or the rep the invoice is under: salesman_id = me, or no salesman and
--      created_by = me), re-read by id from public.invoices; the same _invoice_post_version(id), so
--      the hash and post_invoice / post_invoice_group / batch_post_invoices are unchanged.
--   The screens select `invoice_post_version` from invoices_postable in the SAME query as the rows
--   they show (one snapshot, as before), instead of from invoices.
--
-- WHY: a PostgREST computed field receives the whole row, and Postgres checks SELECT on EVERY
--   column for a whole-row reference. Once total_cost_cents is revoked, every select of
--   invoice_post_version(public.invoices) fails with "permission denied for table invoices", for
--   admins and reps alike, and invoices can be neither opened nor posted. The view's row has no cost
--   column, so the same computed field on it keeps working. (Proven in a local PostgREST v14.16:
--   embeds, filters, paging and row security all work through the view; see the PR.)
--
-- DEPLOY ORDER (agreed with PR #1018's owner, 2026-10-22):
--   (a) this file: the view and the new overload; the old overload stays, so the screens live
--       before this PR merges keep working;
--   (b) this PR's app switches the seven version-bearing reads to invoices_postable;
--   (c) the cost lock (20261022030000) then DROPS invoice_post_version(public.invoices), leaving
--       exactly this overload, and revokes cost. A browser still running a bundle from before (b)
--       (the PWA service worker) then cannot open an invoice screen until it reloads, so (c) waits
--       a while after (b) deploys.
--
-- STANDING CONSEQUENCE: a new invoices column is not in the view until a migration re-creates it.
--   src/lib/costFields.test.ts pins the view's columns to the schema registry minus cost.
--
-- ROLLBACK (as its own reviewed migration; only before the cost lock is applied):
--   revert the app first, then
--   DROP FUNCTION public.invoice_post_version(public.invoices_postable);
--   DROP VIEW public.invoices_postable;
--
-- Proof: node scripts/smoke/prove-post-binds-reviewed-invoice-version-real-schema.mjs

SET LOCAL lock_timeout = '10s';

CREATE TEMP TABLE invoices_postable_view_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_cols text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.invoices_postable_view_tx') IS NULL THEN
    RAISE EXCEPTION 'INVOICES_POSTABLE_NOT_IN_TRANSACTION: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.invoices_postable_view_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'INVOICES_POSTABLE_NOT_IN_TRANSACTION: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- The view lists every column but total_cost_cents: refuse on any other column set.
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
    RAISE EXCEPTION 'INVOICES_POSTABLE_PREFLIGHT: invoices columns are not the ones this view lists (re-read them): %', v_cols;
  END IF;

  -- PR #1018 (20261021200000) is live, with the reviewed bodies this file mirrors.
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public._invoice_post_version(uuid)')), chr(13), ''))
       IS DISTINCT FROM 'd351f2e930ff7196550c12bfca01dfbe'
     OR md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.invoice_post_version(public.invoices)')), chr(13), ''))
       IS DISTINCT FROM 'f353b5c3078efb42544ea7b76c7b16e6' THEN
    RAISE EXCEPTION 'INVOICES_POSTABLE_PREFLIGHT: 20261021200000 is not applied, or its version functions drifted';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'invoice_post_version') <> 1
     OR to_regclass('public.invoices_postable') IS NOT NULL THEN
    RAISE EXCEPTION 'INVOICES_POSTABLE_PREFLIGHT: invoices_postable or a second invoice_post_version already exists';
  END IF;
END
$preflight$;

-- 1. The view. security_invoker: the caller's row security and column privileges apply, so it
-- shows a rep exactly what the table shows them. It names its columns (never a whole row).
CREATE VIEW public.invoices_postable WITH (security_invoker = true) AS
SELECT id, invoice_number, order_id, blend_ticket_id, customer_id, invoice_type, status, season, salesman_id,
       created_by, total_amount_cents, paid_amount_cents, prepay_applied_cents, posted_by, posted_at, voided_by,
       voided_at, void_reason, invoice_date, due_date, purchase_order_ref, header_notes, footer_notes,
       parent_invoice_id, deleted_at, created_at, updated_at, crop_type, field_names, total_acres,
       applicator_name, vehicle_name, application_date, job_id, is_quick_delivery, write_off_cents,
       invoice_group_id, application_service_id, delivery_id, wind_direction, temperature_text, pricing_pending,
       payment_terms, internal_notes, discount_earned_cents, discount_date, start_temp_f, start_wind_mph,
       start_wind_direction, start_humidity_pct, start_weather_time, start_weather_source, end_temp_f,
       end_wind_mph, end_wind_direction, end_humidity_pct, end_weather_time, end_weather_source,
       weather_manual_override, diluent_rate_gpa, credit_applied_cents, balance_cents, send_disposition,
       field_app_billing_set_id
  FROM public.invoices;

COMMENT ON VIEW public.invoices_postable IS
  'Invoices without cost columns, for screens that post (20261022025000). security_invoker: the caller''s row security and column grants apply. Select invoice_post_version from here, in the same query as the rows shown. Read-only: SELECT to authenticated and service_role, nothing else to anyone.';

-- Supabase's default privileges grant a new view to anon, authenticated and service_role with every
-- privilege; the view is simple, so INSERT/UPDATE/DELETE would pass through to invoices. Take them
-- all back and give back only SELECT.
REVOKE ALL ON public.invoices_postable FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.invoices_postable TO authenticated, service_role;

-- 2. The computed field on the view: invoice_post_version(public.invoices)'s rule and helper,
-- re-read by id from public.invoices (a made-up row through the RPC endpoint answers nothing).
CREATE FUNCTION public.invoice_post_version(p_invoice public.invoices_postable)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT public._invoice_post_version(i.id)
    FROM public.invoices i
    JOIN public.profiles p ON p.id = auth.uid() AND p.is_active = true
   WHERE i.id = p_invoice.id
     AND (p.role = 'admin'
          OR (p.role = 'sales_rep'
              AND (i.salesman_id = p.id OR (i.salesman_id IS NULL AND i.created_by = p.id))))
$fn$;

COMMENT ON FUNCTION public.invoice_post_version(public.invoices_postable) IS
  'Version of the saved invoice for posting (20261022025000). Select it from invoices_postable with the rows shown and send it to post_invoice / post_invoice_group, which refuse INVOICE_CHANGED_SINCE_LOADED if the invoice changed since. Admins and the rep the invoice is under; carries no cost.';

REVOKE ALL ON FUNCTION public.invoice_post_version(public.invoices_postable) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_post_version(public.invoices_postable) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

-- POSTFLIGHT: the view's options, columns and grants, and both overloads with their grants.
DO $postflight$
DECLARE
  v_cols text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c, unnest(c.reloptions) o
                  WHERE c.oid = 'public.invoices_postable'::regclass AND o IN ('security_invoker=true', 'security_invoker=on')) THEN
    RAISE EXCEPTION 'INVOICES_POSTABLE_POSTFLIGHT: the view is not security_invoker';
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_cols
    FROM pg_attribute WHERE attrelid = 'public.invoices_postable'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_cols IS DISTINCT FROM (SELECT string_agg(attname, ',' ORDER BY attname) FROM pg_attribute
                               WHERE attrelid = 'public.invoices'::regclass AND attnum > 0 AND NOT attisdropped
                                 AND attname <> 'total_cost_cents') THEN
    RAISE EXCEPTION 'INVOICES_POSTABLE_POSTFLIGHT: the view columns are not every invoices column but total_cost_cents: %', v_cols;
  END IF;
  -- Every privilege of every API role (and PUBLIC), table-wide and on any column: SELECT for
  -- authenticated and service_role, nothing else for anyone.
  SELECT string_agg(format('%s %s', r.rol, p.priv), ', ' ORDER BY r.rol, p.priv) INTO v_cols
    FROM (VALUES ('authenticated'), ('service_role'), ('anon'), ('public')) AS r(rol)
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
   WHERE (has_table_privilege(r.rol, 'public.invoices_postable', p.priv)
          OR (p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              AND has_any_column_privilege(r.rol, 'public.invoices_postable', p.priv)))
         IS DISTINCT FROM (r.rol IN ('authenticated', 'service_role') AND p.priv = 'SELECT');
  IF v_cols IS NOT NULL THEN
    RAISE EXCEPTION 'INVOICES_POSTABLE_POSTFLIGHT: the view must be SELECT-only for authenticated and service_role and closed to anon; wrong: %', v_cols;
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'invoice_post_version') <> 2
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.invoice_post_version(public.invoices_postable)'::regprocedure)
     OR NOT has_function_privilege('authenticated', 'public.invoice_post_version(public.invoices_postable)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.invoice_post_version(public.invoices_postable)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.invoice_post_version(public.invoices)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.invoice_post_version(public.invoices)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._invoice_post_version(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._invoice_post_version(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'INVOICES_POSTABLE_POSTFLIGHT: expected both invoice_post_version overloads for authenticated only, and the helper closed';
  END IF;
END
$postflight$;
