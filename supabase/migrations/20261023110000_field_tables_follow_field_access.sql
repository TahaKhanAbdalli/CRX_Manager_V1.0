-- Written 2026-10-25. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 983).
--
-- WHAT (To-Do row 11.4, part B of the fix plan in docs/manual/KNOWN_ISSUES.md KI-01 and KI-73):
--   field roles read only the fields of the jobs they are assigned to through the TABLES too, not
--   only through the field functions part A (20261023090000, live 2026-10-25 9:10 PM Central) fixed.
--   Live that night the one applicator still read all 5 `fields` rows directly. Before this file:
--     fields_select, field_crop_history_select, field_obstacles_select
--                                    every active applicator reads every customer's rows
--                                    (field_polygons follows fields_select: field_id IN fields)
--     field_polygons_insert/_update/_delete
--                                    the same test, so every active applicator could add, rewrite
--                                    or delete any field's boundary parts through the Data API
--                                    (the app writes them only through office-only functions)
--     field_app_locations_select, field_app_location_shares_select
--                                    every active applicator reads every field-application
--                                    invoice's locations and billed shares (amount_cents)
--     fbd_select (field_billing_defaults), arf_select (application_record_fields)
--                                    every active profile, drivers included, reads every row
--                                    (billing splits with price overrides; spray-record acres)
--     get_job_billed_customers       found by this part's proof: its gate was IF NOT (...), and on a
--                                    job with no whole-job applicator the applicator leg is NULL, so
--                                    it never refused an active applicator: any applicator holding a
--                                    job id got that job's billed customers (farm names, account
--                                    numbers). Drivers were refused (their leg is false, not NULL).
--
-- MASON'S DECISION (2026-10-25, in the part B session): someone sent to a job sees the entire job
--   and its ticket, every field of it, and nothing of the jobs they are not on. Part A's
--   _can_see_field showed a per-field or crew assignee only the one field their dispatch row points
--   at; on a split job that made their Chemical Application Report, applicator sheet and loader
--   worksheet list one field's acres beside the whole job's product totals. So this file widens
--   that leg to every field of a job the caller holds a current dispatch on, and leaves the
--   job-level reads (job_fields, the job map, the Dispatch Board, both billed-customer lookups)
--   job-wide as they are.
--
-- HOW:
--   * public._can_see_field(field_id), CREATE OR REPLACE (same signature, attributes and grants):
--     the dispatch leg matches any job_fields row of the dispatched job (jf.job_id = d.job_id)
--     instead of only the dispatch's own row (jf.id = d.job_field_id). Every other check stays: an
--     active profile; the dispatch open, or completed within 7 days, never cancelled; a crew
--     dispatch needs an active crew and an active membership; the job not soft-deleted. Office
--     staff and the whole-job applicator are unchanged. This also widens part A's two field-map
--     lookups (get_fields_geojson_by_ids, get_field_geojson) to the same set, and closes the Job
--     Detail weather-centroid edge part A left.
--   * fields, field_crop_history, field_obstacles: the applicator leg becomes
--     is_applicator() AND _can_see_field(field id); field_polygons_select follows fields_select.
--   * fbd_select and arf_select: is_admin() OR is_sales_rep() OR (is_applicator() AND
--     _can_see_field(field_id)), the same role test as fields_select, so a driver (even one in a
--     ground crew) no longer reads billing splits or spray-record fields. Not office-only: Job
--     Detail's grower-share banner and the applicator sheet read both for the job's fields.
--   * Office-only (is_admin() OR is_sales_rep()), because no field-role screen uses them:
--     field_app_locations_select and field_app_location_shares_select (read only by the invoice and
--     field-invoice pages), and field_polygons_insert/_update/_delete (the app writes boundary
--     parts only through save_field_polygons, set_field_boundary and save_field, all office-only).
--   * get_job_billed_customers' gate becomes IF (...) IS NOT TRUE, so a NULL leg refuses. Nothing
--     else in its body changes.
--
-- SOURCE OF THE BODIES AND POLICIES: live, as pinned below (each pin also matches what a replay of
--   the checked-in baseline and migrations produces). Only the lines marked "row 11.4 part B" (and
--   the comment they correct) were changed; the prover checks each body's code diff line by line.
--
-- NOT CHANGED: what an active admin or sales rep reads or writes; every other INSERT/UPDATE/DELETE
--   policy; job_fields, jobs, job_chemicals and the other job tables' policies; policy names, roles
--   and commands; function return types, owner (postgres), ACLs, search_path, volatility and
--   SECURITY DEFINER; no rows change. CREATE OR REPLACE keeps each OID. Part C (the whole-job
--   applicator's lifecycle window, jobs_select, start_job and complete_job, and
--   _is_dispatched_to_me's deleted-job test) is a later migration.
--
-- EXPECTED NARROWING (by design): an applicator's Record Book keeps their own application records,
--   but shows "-" as the field name once that job's assignment ends, as it already does for the
--   customer name after customers_select's 7-day window. FAILS CLOSED FOR anon: four of the
--   narrowed SELECT policies are TO public, and anon cannot run _can_see_field or is_sales_rep, so a
--   signed-out read of those tables now errors instead of returning no rows. The app never reads
--   them signed out.

SET LOCAL lock_timeout = '5s';
-- Policy expressions are printed relative to the search_path; fix it so the pinned texts compare.
SET LOCAL search_path = public, pg_temp;

CREATE TEMP TABLE field_tables_follow_field_access_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

CREATE TEMP TABLE field_tables_follow_field_access_attrs ON COMMIT DROP AS
SELECT p.oid AS fn_oid, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
       p.proconfig, p.prorettype, p.provolatile, p.prosecdef
  FROM pg_proc p
 WHERE false;

DO $preflight$
DECLARE
  v_pin record;
  v_md5 text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.field_tables_follow_field_access_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.field_tables_follow_field_access_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;

  -- The two functions this file replaces, exactly as live has them: part A's helper as it went
  -- live on 2026-10-25 (9:10 PM Central), and get_job_billed_customers.
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('public._can_see_field(uuid)',              '0b7f544337f93adc79163cafe581222c'),
      ('public.get_job_billed_customers(uuid)',    '84690ba2dd6708c962d117d9be5930f0')
    ) AS t(sig, live_md5)
  LOOP
    IF (SELECT count(*) FROM pg_proc
         WHERE proname = split_part(replace(v_pin.sig, 'public.', ''), '(', 1)
           AND pronamespace = 'public'::regnamespace) <> 1 THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % must have exactly one overload (apply 20261023090000 first)', v_pin.sig;
    END IF;
    SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(v_pin.sig);
    IF v_md5 IS DISTINCT FROM v_pin.live_md5 THEN
      -- Already applied, or live drifted from the body this file was written against.
      RAISE EXCEPTION 'FIELD_TABLES_BASELINE_DRIFT: % is %', v_pin.sig, v_md5;
    END IF;
    INSERT INTO pg_temp.field_tables_follow_field_access_attrs
    SELECT p.oid, pg_get_userbyid(p.proowner), p.proacl::text, p.proconfig, p.prorettype, p.provolatile, p.prosecdef
      FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig);
  END LOOP;
  -- Without EXECUTE for authenticated every read of the narrowed tables would error, office too.
  IF NOT has_function_privilege('authenticated', 'public._can_see_field(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: authenticated cannot execute public._can_see_field(uuid)';
  END IF;

  -- The seven SELECT policies, exactly as live has them (row security on, not forced), each the
  -- only permissive SELECT policy on its table, so none re-admits what this file narrows.
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('fields',                    'fields_select',                    '{authenticated}', '(is_admin() OR is_sales_rep() OR is_applicator())'),
      ('field_crop_history',        'field_crop_history_select',        '{public}',        '(is_admin() OR is_sales_rep() OR is_applicator())'),
      ('field_obstacles',           'field_obstacles_select',           '{authenticated}', '(is_admin() OR is_sales_rep() OR is_applicator())'),
      ('field_app_locations',       'field_app_locations_select',       '{public}',        '(is_admin() OR is_sales_rep() OR is_applicator())'),
      ('field_app_location_shares', 'field_app_location_shares_select', '{public}',        '(is_admin() OR is_sales_rep() OR is_applicator())'),
      ('field_billing_defaults',    'fbd_select',                       '{authenticated}', '( SELECT is_active_profile() AS is_active_profile)'),
      ('application_record_fields', 'arf_select',                       '{public}',        E'(EXISTS ( SELECT 1\n   FROM profiles p\n  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.is_active = true))))')
    ) AS t(tbl, pol, roles, live_qual)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies pp
        JOIN pg_class c ON c.relname = pp.tablename AND c.relnamespace = 'public'::regnamespace
       WHERE pp.schemaname = 'public' AND pp.tablename = v_pin.tbl AND pp.policyname = v_pin.pol
         AND pp.cmd = 'SELECT' AND pp.permissive = 'PERMISSIVE' AND pp.roles::text = v_pin.roles
         AND pp.qual = v_pin.live_qual AND pp.with_check IS NULL
         AND c.relrowsecurity AND NOT c.relforcerowsecurity) THEN
      RAISE EXCEPTION 'FIELD_TABLES_BASELINE_DRIFT: policy % on % is not the live one', v_pin.pol, v_pin.tbl;
    END IF;
    IF (SELECT count(*) FROM pg_policies pp
         WHERE pp.schemaname = 'public' AND pp.tablename = v_pin.tbl
           AND pp.cmd IN ('SELECT', 'ALL') AND pp.permissive = 'PERMISSIVE') <> 1 THEN
      RAISE EXCEPTION 'FIELD_TABLES_BASELINE_DRIFT: % has an unexpected number of SELECT policies', v_pin.tbl;
    END IF;
  END LOOP;

  -- field_polygons' write policies, exactly as live has them.
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('field_polygons_insert', 'INSERT', NULL::text, E'(field_id IN ( SELECT fields.id\n   FROM fields))'),
      ('field_polygons_update', 'UPDATE', E'(field_id IN ( SELECT fields.id\n   FROM fields))', NULL::text),
      ('field_polygons_delete', 'DELETE', E'(field_id IN ( SELECT fields.id\n   FROM fields))', NULL::text)
    ) AS t(pol, cmd, live_qual, live_check)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies pp
       WHERE pp.schemaname = 'public' AND pp.tablename = 'field_polygons' AND pp.policyname = v_pin.pol
         AND pp.cmd = v_pin.cmd AND pp.permissive = 'PERMISSIVE' AND pp.roles::text = '{public}'
         AND pp.qual IS NOT DISTINCT FROM v_pin.live_qual AND pp.with_check IS NOT DISTINCT FROM v_pin.live_check) THEN
      RAISE EXCEPTION 'FIELD_TABLES_BASELINE_DRIFT: policy % on field_polygons is not the live one', v_pin.pol;
    END IF;
  END LOOP;
  -- field_polygons has exactly its four policies, and its SELECT one follows fields_select.
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'field_polygons') <> 4
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'field_polygons'
                     AND policyname = 'field_polygons_select' AND cmd = 'SELECT' AND permissive = 'PERMISSIVE'
                     AND qual = E'(field_id IN ( SELECT fields.id\n   FROM fields))')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.field_polygons'::regclass
                     AND relrowsecurity AND NOT relforcerowsecurity) THEN
    RAISE EXCEPTION 'FIELD_TABLES_BASELINE_DRIFT: field_polygons policies are not the live ones';
  END IF;
END;
$preflight$;

-- The field helper: an assignee sees the entire job. --------------------------------------------------
CREATE OR REPLACE FUNCTION public._can_see_field(p_field_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  -- Who may see one field (its row, boundary and map lookups). Every leg needs an ACTIVE profile.
  SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.is_active)
  AND (
    -- Office staff see every field.
    public.is_admin() OR public.is_sales_rep()
    -- The whole-job applicator (jobs.applicator_id) sees the fields on that job, never on a
    -- soft-deleted job. Part C of row 11.4 adds the job's lifecycle window here and in jobs_select.
    OR (public.is_applicator() AND EXISTS (
          SELECT 1
            FROM public.job_fields jf
            JOIN public.jobs j ON j.id = jf.job_id
           WHERE jf.field_id = p_field_id
             AND j.applicator_id = (SELECT auth.uid())
             AND j.deleted_at IS NULL))
    -- A per-field or crew assignee sees every field of a job they are dispatched on, as the
    -- whole-job applicator does (Mason, 2026-10-25: field staff see the entire job; row 11.4
    -- part B). Same checks as _is_dispatched_to_me: open, or completed within 7 days, never
    -- cancelled; a crew dispatch needs an active crew and an active membership. Plus: the job
    -- is not soft-deleted.
    OR EXISTS (
          SELECT 1
            FROM public.job_location_dispatches d
            JOIN public.job_fields jf ON jf.job_id = d.job_id
            JOIN public.jobs j ON j.id = d.job_id
           WHERE jf.field_id = p_field_id
             AND j.deleted_at IS NULL
             AND (
               d.dispatch_status = 'dispatched'
               OR (d.dispatch_status = 'completed' AND d.updated_at >= now() - interval '7 days')
             )
             AND (
               d.applicator_id = (SELECT auth.uid())
               OR (
                 d.crew_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM public.ground_crew_members gcm
                     JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                    WHERE gcm.crew_id = d.crew_id
                      AND gcm.profile_id = (SELECT auth.uid())
                      AND gcm.is_active
                      AND gc.is_active
                 )
               )
             ))
  );
$function$;

COMMENT ON FUNCTION public._can_see_field(uuid) IS
  'Row 11.4: may the caller see this field? Active office staff: any. Whole-job applicator: fields on their non-deleted job. Dispatch or crew assignee: every field of a non-deleted job they hold an open (or completed within 7 days, never cancelled) dispatch on (Mason, 2026-10-25: they see the entire job).';

-- The tables. ----------------------------------------------------------------------------------------
-- Office legs unchanged; field roles see the fields of the jobs they are assigned to (row 11.4 part B).
ALTER POLICY fields_select ON public.fields
  USING (is_admin() OR is_sales_rep() OR (is_applicator() AND public._can_see_field(id)));

ALTER POLICY field_crop_history_select ON public.field_crop_history
  USING (is_admin() OR is_sales_rep() OR (is_applicator() AND public._can_see_field(field_id)));

ALTER POLICY field_obstacles_select ON public.field_obstacles
  USING (is_admin() OR is_sales_rep() OR (is_applicator() AND public._can_see_field(field_id)));

-- Was any active profile (drivers included); now office staff and the applicators of the job.
ALTER POLICY fbd_select ON public.field_billing_defaults
  USING (is_admin() OR is_sales_rep() OR (is_applicator() AND public._can_see_field(field_id)));

ALTER POLICY arf_select ON public.application_record_fields
  USING (is_admin() OR is_sales_rep() OR (is_applicator() AND public._can_see_field(field_id)));

-- Field-application invoice locations and their billed shares (amount_cents): office only. Only
-- the invoice and field-invoice pages, both office-only, read them.
ALTER POLICY field_app_locations_select ON public.field_app_locations
  USING (is_admin() OR is_sales_rep());

ALTER POLICY field_app_location_shares_select ON public.field_app_location_shares
  USING (is_admin() OR is_sales_rep());

-- Boundary parts are written only through office-only functions; the direct table writes were open
-- to every applicator through fields_select.
ALTER POLICY field_polygons_insert ON public.field_polygons
  WITH CHECK (is_admin() OR is_sales_rep());

ALTER POLICY field_polygons_update ON public.field_polygons
  USING (is_admin() OR is_sales_rep());

ALTER POLICY field_polygons_delete ON public.field_polygons
  USING (is_admin() OR is_sales_rep());

-- The billed-customer gate. --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_job_billed_customers(p_job_id uuid)
 RETURNS TABLE(customer_id uuid, farm_name text, account_number text, is_primary boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_primary_customer_id uuid;
  v_applicator_id uuid;
BEGIN
  -- Load the job's gate columns (definer-privileged read).
  SELECT j.customer_id, j.applicator_id
    INTO v_primary_customer_id, v_applicator_id
  FROM jobs j
  WHERE j.id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job not found' USING ERRCODE = 'no_data_found';
  END IF;

  -- SELF-GATE: mirror the FULL live jobs visibility — BOTH SELECT policies OR'd:
  --   jobs_select:                     is_admin OR is_sales_rep OR (is_applicator AND applicator_id = auth.uid())
  --   jobs_select_location_dispatchee: _is_dispatched_to_me(job_id)  (per-location / crew dispatch)
  -- Without the dispatch leg a per-location-dispatched applicator (who CAN see the
  -- job) is refused here and their compliance PDF is blocked — the exact bug FIX 5
  -- closes. The dispatch helper is SECURITY DEFINER + re-checks active profile / active
  -- crew, so it never widens visibility beyond the live policy. Reject a caller who
  -- can't view the job (do NOT return a partial set — compliance is complete-or-refused).
  -- IS NOT TRUE, not NOT (...): on a job with no whole-job applicator the applicator leg is
  -- NULL, and NOT NULL never refused, so any active applicator got any such job's billed
  -- customers (row 11.4 part B).
  IF (
    is_admin()
    OR is_sales_rep()
    OR (is_applicator() AND v_applicator_id = (SELECT auth.uid()))
    OR _is_dispatched_to_me(p_job_id)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Not authorized to view this job''s billed customers'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH job_field_ids AS (
    -- Every field on the job (field_id is the unit of billing precedence).
    SELECT DISTINCT jf.field_id
    FROM job_fields jf
    WHERE jf.job_id = p_job_id AND jf.field_id IS NOT NULL
  ),
  fields_with_share AS (
    -- Only shares whose field is ACTUALLY on the job (guard against an orphan
    -- job_field_shares row for a field no longer on the job).
    SELECT DISTINCT jfs.field_id
    FROM job_field_shares jfs
    JOIN job_field_ids jfi ON jfi.field_id = jfs.field_id
    WHERE jfs.job_id = p_job_id
  ),
  resolved AS (
    -- 1. Saved per-field shares (explicit split) — only for fields on the job, so an
    --    orphan share (field removed from the job) never adds a customer (Codex LOW).
    SELECT jfs.customer_id
    FROM job_field_shares jfs
    JOIN job_field_ids jfi ON jfi.field_id = jfs.field_id
    WHERE jfs.job_id = p_job_id AND jfs.customer_id IS NOT NULL

    UNION ALL

    -- 2. field_billing_defaults for fields WITHOUT a saved share.
    SELECT fbd.customer_id
    FROM job_field_ids jfi
    JOIN field_billing_defaults fbd ON fbd.field_id = jfi.field_id
    WHERE jfi.field_id NOT IN (SELECT field_id FROM fields_with_share)
      AND fbd.customer_id IS NOT NULL

    UNION ALL

    -- 3. The job's PRIMARY customer for fields that have neither a saved share
    --    nor a billing default.
    SELECT v_primary_customer_id
    FROM job_field_ids jfi
    WHERE jfi.field_id NOT IN (SELECT field_id FROM fields_with_share)
      AND NOT EXISTS (
        SELECT 1 FROM field_billing_defaults fbd WHERE fbd.field_id = jfi.field_id
      )
      AND v_primary_customer_id IS NOT NULL

    UNION ALL

    -- 4. SAFETY FALLBACK: a job with NO fields at all still has a primary customer
    --    — surface it so the resolver never returns an empty set for a real job
    --    (mirrors the frontend "if custMap empty → add primary" fallback).
    SELECT v_primary_customer_id
    WHERE NOT EXISTS (SELECT 1 FROM job_field_ids)
      AND v_primary_customer_id IS NOT NULL
  )
  -- LEFT JOIN (not INNER) so a billed customer_id that does NOT resolve to a
  -- customers row (e.g. a since-removed customer) still surfaces — as a row with a
  -- NULL farm_name. The frontend resolver treats a NULL/blank name as an INCOMPLETE
  -- resolution and ABORTS the compliance PDF, rather than silently omitting that
  -- billed party.
  SELECT
    d.customer_id,
    c.farm_name,
    c.account_number,
    (d.customer_id = v_primary_customer_id) AS is_primary
  FROM (SELECT DISTINCT r.customer_id FROM resolved r) d
  LEFT JOIN customers c ON c.id = d.customer_id
  ORDER BY (d.customer_id = v_primary_customer_id) DESC, c.farm_name NULLS LAST;
END;
$function$;

DO $postflight$
DECLARE
  v_fn record;
  v_pol record;
BEGIN
  IF to_regclass('pg_temp.field_tables_follow_field_access_tx') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.field_tables_follow_field_access_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;

  FOR v_fn IN
    SELECT t.sig, t.new_md5, md5(replace(p.prosrc, chr(13), '')) AS body_md5,
           pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
           a.owner AS was_owner, a.acl AS was_acl, a.proconfig AS was_config, a.prorettype AS was_rettype,
           a.provolatile AS was_volatile, a.prosecdef AS was_secdef
      FROM (VALUES
      ('public._can_see_field(uuid)',              '32cf69a9a79a6d62a9ba255777de199a'),
      ('public.get_job_billed_customers(uuid)',    'f5d065a4d29205511e38a099d9680a86')
      ) AS t(sig, new_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
      -- CREATE OR REPLACE keeps each OID, so the preflight snapshot is matched by OID.
      LEFT JOIN pg_temp.field_tables_follow_field_access_attrs a ON a.fn_oid = p.oid
  LOOP
    IF v_fn.body_md5 IS DISTINCT FROM v_fn.new_md5
       OR v_fn.was_owner IS NULL
       OR v_fn.owner IS DISTINCT FROM v_fn.was_owner
       OR v_fn.acl IS DISTINCT FROM v_fn.was_acl
       OR v_fn.proconfig IS DISTINCT FROM v_fn.was_config
       OR v_fn.prorettype IS DISTINCT FROM v_fn.was_rettype
       OR v_fn.provolatile IS DISTINCT FROM v_fn.was_volatile
       OR v_fn.prosecdef IS DISTINCT FROM v_fn.was_secdef
       OR NOT v_fn.prosecdef THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % is not the expected body/attributes (md5 %)', v_fn.sig, v_fn.body_md5;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_temp.field_tables_follow_field_access_attrs) <> 2 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not every pinned function was snapshotted';
  END IF;

  FOR v_pol IN
    SELECT * FROM (VALUES
      ('fields',                    'fields_select',                    '{authenticated}', '(is_admin() OR is_sales_rep() OR (is_applicator() AND _can_see_field(id)))'),
      ('field_crop_history',        'field_crop_history_select',        '{public}',        '(is_admin() OR is_sales_rep() OR (is_applicator() AND _can_see_field(field_id)))'),
      ('field_obstacles',           'field_obstacles_select',           '{authenticated}', '(is_admin() OR is_sales_rep() OR (is_applicator() AND _can_see_field(field_id)))'),
      ('field_app_locations',       'field_app_locations_select',       '{public}',        '(is_admin() OR is_sales_rep())'),
      ('field_app_location_shares', 'field_app_location_shares_select', '{public}',        '(is_admin() OR is_sales_rep())'),
      ('field_billing_defaults',    'fbd_select',                       '{authenticated}', '(is_admin() OR is_sales_rep() OR (is_applicator() AND _can_see_field(field_id)))'),
      ('application_record_fields', 'arf_select',                       '{public}',        '(is_admin() OR is_sales_rep() OR (is_applicator() AND _can_see_field(field_id)))')
    ) AS t(tbl, pol, roles, new_qual)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies pp
       WHERE pp.schemaname = 'public' AND pp.tablename = v_pol.tbl AND pp.policyname = v_pol.pol
         AND pp.cmd = 'SELECT' AND pp.permissive = 'PERMISSIVE' AND pp.roles::text = v_pol.roles
         AND pp.qual = v_pol.new_qual AND pp.with_check IS NULL) THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: policy % on % is not the expected one', v_pol.pol, v_pol.tbl;
    END IF;
  END LOOP;
  FOR v_pol IN
    SELECT * FROM (VALUES
      ('field_polygons_insert', 'INSERT', NULL::text,                       '(is_admin() OR is_sales_rep())'),
      ('field_polygons_update', 'UPDATE', '(is_admin() OR is_sales_rep())', NULL::text),
      ('field_polygons_delete', 'DELETE', '(is_admin() OR is_sales_rep())', NULL::text)
    ) AS t(pol, cmd, new_qual, new_check)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies pp
       WHERE pp.schemaname = 'public' AND pp.tablename = 'field_polygons' AND pp.policyname = v_pol.pol
         AND pp.cmd = v_pol.cmd AND pp.permissive = 'PERMISSIVE' AND pp.roles::text = '{public}'
         AND pp.qual IS NOT DISTINCT FROM v_pol.new_qual AND pp.with_check IS NOT DISTINCT FROM v_pol.new_check) THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: policy % on field_polygons is not the expected one', v_pol.pol;
    END IF;
  END LOOP;
  RAISE NOTICE 'POSTFLIGHT_OK: field tables follow field access (row 11.4 part B)';
END;
$postflight$;
