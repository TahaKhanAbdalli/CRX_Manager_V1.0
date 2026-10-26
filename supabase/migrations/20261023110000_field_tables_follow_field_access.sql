-- Written 2026-10-25. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 983).
--
-- WHAT (To-Do row 11.4, part B of the fix plan in docs/manual/KNOWN_ISSUES.md KI-01 and KI-73):
--   field roles read only the field rows of their own assignments through the TABLES too, not only
--   through the field functions part A (20261023090000, live 2026-10-26) fixed. Live on 2026-10-26
--   the one applicator still read all 5 `fields` rows directly, though the map functions gave it its
--   2 dispatched fields. Before this file:
--     fields_select, field_crop_history_select, field_obstacles_select,
--     field_app_locations_select, field_app_location_shares_select
--                                    every active applicator reads every customer's rows
--                                    (field_polygons follows fields_select: field_id IN fields)
--     fbd_select (field_billing_defaults), arf_select (application_record_fields)
--                                    every active profile, drivers included, reads every row
--                                    (billing splits with price overrides; spray-record acres)
--     job_fields_select_location_dispatchee
--                                    a per-field or crew assignee reads every job_fields row of the
--                                    job, not only the one their dispatch points at
--     get_job_fields_with_geojson, get_dispatch_board_jobs, get_job_billed_customers,
--     get_jobs_billed_customers      the same: after the job-level gate they return every field (and
--                                    every field's billed customer) of a split job
--     get_job_billed_customers       found by this part's proof: its gate was IF NOT (...), and on a
--                                    job with no whole-job applicator the applicator leg is NULL, so
--                                    it never refused an active applicator: any applicator holding a
--                                    job id got that job's billed customers (farm names, account
--                                    numbers). Drivers were refused (their leg is false, not NULL).
--
-- HOW: each of those reads keeps its office legs as they are and replaces the field-role leg with
--   public._can_see_field(field_id) (part A's helper, unchanged here): an active admin or sales rep
--   sees every field; the whole-job applicator the fields on their non-deleted job; a per-field or
--   crew assignee only the field of their own open (or completed within 7 days, never cancelled)
--   dispatch on a non-deleted job.
--   * fields, field_crop_history, field_obstacles, field_app_locations: the applicator leg becomes
--     is_applicator() AND _can_see_field(field id). field_app_location_shares follows its
--     location's field. field_polygons needs no change (it reads fields under fields_select).
--   * fbd_select and arf_select: is_admin() OR is_sales_rep() OR _can_see_field(field_id). They are
--     not made office-only, because Job Detail's grower-share banner reads field_billing_defaults and
--     the applicator sheet reads both for the job's own fields.
--   * job_fields_select_location_dispatchee: _is_dispatched_to_me(job_id) AND
--     _can_see_field(field_id). job_fields_select (office and the whole-job applicator) is unchanged.
--     This also closes the Job Detail weather-centroid edge left by part A: the assignee's first
--     job_fields row is now their own field, which get_field_geojson returns to them.
--   * The four functions add _can_see_field to the field rows they return. In both billed-customer
--     functions the "a job with no fields still has its primary customer" fallback now asks whether
--     the job has any field at all, not whether the caller sees one: a caller who sees the job but
--     none of its fields (a deleted job, until part C) gets no rows, which the compliance PDF already
--     treats as incomplete and refuses, instead of a primary-only list.
--   * get_job_billed_customers' gate becomes IF (...) IS NOT TRUE, so a NULL leg refuses.
--
-- SOURCE OF THE BODIES AND POLICIES: live, as pinned below (each pin also matches what a replay of
--   the checked-in baseline and migrations produces). Only the lines marked "row 11.4 part B" (and
--   the comment they correct) were changed; the prover checks each body's code diff line by line.
--
-- NOT CHANGED: what an active admin or sales rep reads; every INSERT/UPDATE/DELETE policy; policy
--   names, roles and commands; function return types, owner (postgres), ACLs, search_path,
--   volatility and SECURITY DEFINER; _can_see_field; no rows change. CREATE OR REPLACE keeps each
--   OID. Part C (the whole-job applicator's lifecycle window, jobs_select, start_job and
--   complete_job, and _is_dispatched_to_me's deleted-job test) is a later migration.
--
-- EXPECTED NARROWING (by design): an applicator's Record Book keeps their own application records,
--   but shows "-" as the field name once the assignment for that field ends, as it already does for
--   the customer name after customers_select's 7-day window.

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
  -- Part A's helper, exactly as it went live on 2026-10-26.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public._can_see_field(uuid)')
       AND p.prosecdef AND p.provolatile = 's'
       AND md5(replace(p.prosrc, chr(13), '')) = '0b7f544337f93adc79163cafe581222c') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: public._can_see_field(uuid) is missing or not the part A body (apply 20261023090000 first)';
  END IF;

  FOR v_pin IN
    SELECT * FROM (VALUES
      ('public.get_job_fields_with_geojson(uuid)',                'c42bf2515ec81fd9727da08757f5d790'),
      ('public.get_dispatch_board_jobs(uuid,text,date,date)',     '7a042e4597ff5cbf4910aec4d75ee11a'),
      ('public.get_job_billed_customers(uuid)',                   '84690ba2dd6708c962d117d9be5930f0'),
      ('public.get_jobs_billed_customers(uuid[])',                '258d9f5722a43de1b388931c99b22ee5')
    ) AS t(sig, live_md5)
  LOOP
    IF (SELECT count(*) FROM pg_proc
         WHERE proname = split_part(replace(v_pin.sig, 'public.', ''), '(', 1)
           AND pronamespace = 'public'::regnamespace) <> 1 THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: % must have exactly one overload', v_pin.sig;
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

  -- The eight SELECT policies, exactly as live has them (row security on, not forced).
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('fields',                    'fields_select',                         '{authenticated}', '(is_admin() OR is_sales_rep() OR is_applicator())'),
      ('field_crop_history',        'field_crop_history_select',             '{public}',        '(is_admin() OR is_sales_rep() OR is_applicator())'),
      ('field_obstacles',           'field_obstacles_select',                '{authenticated}', '(is_admin() OR is_sales_rep() OR is_applicator())'),
      ('field_app_locations',       'field_app_locations_select',            '{public}',        '(is_admin() OR is_sales_rep() OR is_applicator())'),
      ('field_app_location_shares', 'field_app_location_shares_select',      '{public}',        '(is_admin() OR is_sales_rep() OR is_applicator())'),
      ('field_billing_defaults',    'fbd_select',                            '{authenticated}', '( SELECT is_active_profile() AS is_active_profile)'),
      ('application_record_fields', 'arf_select',                            '{public}',        E'(EXISTS ( SELECT 1\n   FROM profiles p\n  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.is_active = true))))'),
      ('job_fields',                'job_fields_select_location_dispatchee', '{authenticated}', '_is_dispatched_to_me(job_id)')
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
    -- No other permissive SELECT policy on the table may re-admit what this one narrows.
    IF (SELECT count(*) FROM pg_policies pp
         WHERE pp.schemaname = 'public' AND pp.tablename = v_pin.tbl
           AND pp.cmd IN ('SELECT', 'ALL') AND pp.permissive = 'PERMISSIVE')
       <> (CASE WHEN v_pin.tbl = 'job_fields' THEN 2 ELSE 1 END) THEN
      RAISE EXCEPTION 'FIELD_TABLES_BASELINE_DRIFT: % has an unexpected number of SELECT policies', v_pin.tbl;
    END IF;
  END LOOP;
END;
$preflight$;

-- The tables. ----------------------------------------------------------------------------------------
-- Office legs unchanged; the applicator leg follows the caller's own assignments (row 11.4 part B).
ALTER POLICY fields_select ON public.fields
  USING (is_admin() OR is_sales_rep() OR (is_applicator() AND public._can_see_field(id)));

ALTER POLICY field_crop_history_select ON public.field_crop_history
  USING (is_admin() OR is_sales_rep() OR (is_applicator() AND public._can_see_field(field_id)));

ALTER POLICY field_obstacles_select ON public.field_obstacles
  USING (is_admin() OR is_sales_rep() OR (is_applicator() AND public._can_see_field(field_id)));

ALTER POLICY field_app_locations_select ON public.field_app_locations
  USING (is_admin() OR is_sales_rep() OR (is_applicator() AND public._can_see_field(field_id)));

-- A share follows its location's field.
ALTER POLICY field_app_location_shares_select ON public.field_app_location_shares
  USING (is_admin() OR is_sales_rep() OR (is_applicator() AND EXISTS (
    SELECT 1 FROM public.field_app_locations l
     WHERE l.id = field_app_location_shares.location_id
       AND public._can_see_field(l.field_id))));

-- Was any active profile (drivers included); now office staff and the field's own assignees.
ALTER POLICY fbd_select ON public.field_billing_defaults
  USING (is_admin() OR is_sales_rep() OR public._can_see_field(field_id));

ALTER POLICY arf_select ON public.application_record_fields
  USING (is_admin() OR is_sales_rep() OR public._can_see_field(field_id));

-- A per-field or crew assignee reads only the job_fields rows of a field they may see, not the
-- job's other fields.
ALTER POLICY job_fields_select_location_dispatchee ON public.job_fields
  USING (_is_dispatched_to_me(job_id) AND public._can_see_field(field_id));

-- The functions. -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_job_fields_with_geojson(p_job_id uuid)
 RETURNS TABLE(id uuid, customer_id uuid, field_name text, total_acres numeric, measured_acres numeric, override_acres numeric, centroid_geojson text, boundary_geojson text, sort_order integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  SELECT
    f.id, f.customer_id, f.field_name, f.total_acres,
    -- Two-acre model (migration 20260623120000): the map's billable-acre label uses
    -- override ?? measured ?? total. Carry both so the label isn't stale legacy acres.
    f.measured_acres, f.override_acres,
    ST_AsGeoJSON(f.centroid)::text  AS centroid_geojson,
    -- Codex post-fix P2: fields.boundary_geom is the CANONICAL full-field MultiPolygon
    -- (set by set_field_boundary; multi-part fields union all field_polygons parts into
    -- it). The legacy geography(POLYGON) `boundary` holds only the first/single part, so
    -- using it would silently drop the other parts of a multi-part field on the map.
    -- Prefer boundary_geom; fall back to the legacy boundary only when geom is absent.
    ST_AsGeoJSON(COALESCE(f.boundary_geom, f.boundary::geometry))::text AS boundary_geojson,
    jf.sort_order
  FROM public.job_fields jf
  JOIN public.fields f ON f.id = jf.field_id
  WHERE jf.job_id = p_job_id
    -- Same visibility gate as the jobs SELECT policies: admin / sales_rep / the
    -- assigned applicator (jobs_select) OR a location-dispatched crew member
    -- (jobs_select_location_dispatchee).
    AND EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = p_job_id
        AND (
          is_admin()
          OR is_sales_rep()
          OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
          OR _is_dispatched_to_me(j.id)
        )
    )
    -- Only the fields this caller may see: a per-field or crew assignee gets the field their
    -- own dispatch points at, not the job's other fields (row 11.4 part B).
    AND public._can_see_field(f.id)
  ORDER BY jf.sort_order NULLS LAST, f.field_name;
$function$;

CREATE OR REPLACE FUNCTION public.get_dispatch_board_jobs(p_applicator_id uuid, p_status text DEFAULT NULL::text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date)
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- A dispatch row is VISIBLE to the caller (mirrors job_location_dispatches_select):
  --   admin/sales see all; the job's whole-job applicator sees every row on their job;
  --   otherwise a field user sees a row where they are the assignee or an active member
  --   of the assigned active crew.
  WITH matched AS (
    SELECT j.*
      FROM public.jobs j
     WHERE j.deleted_at IS NULL
       AND p_applicator_id IS NOT NULL
       AND (p_status IS NULL OR j.status = p_status)
       AND (p_start_date IS NULL OR j.job_date >= p_start_date)
       AND (p_end_date IS NULL OR j.job_date <= p_end_date)
       AND (
         -- (a) a CURRENT per-location dispatch to this applicator the CALLER can see
         EXISTS (
           SELECT 1 FROM public.job_location_dispatches d
            WHERE d.job_id = j.id
              AND d.dispatch_status = 'dispatched'
              AND d.applicator_id = p_applicator_id
              AND (
                is_admin()
                OR is_sales_rep()
                OR (is_applicator() AND j.applicator_id = (select auth.uid()))
                OR d.applicator_id = (select auth.uid())
              )
         )
         OR (
           -- (b) whole-job applicator = this one AND the job has NO per-location dispatch
           j.applicator_id = p_applicator_id
           AND NOT EXISTS (
             SELECT 1 FROM public.job_location_dispatches d2
              WHERE d2.job_id = j.id
                AND d2.dispatch_status = 'dispatched'
           )
         )
       )
       -- VISIBILITY GATE — the live jobs SELECT predicate. Never return a hidden job.
       AND (
         is_admin()
         OR is_sales_rep()
         OR (is_applicator() AND j.applicator_id = (select auth.uid()))
         OR public._is_dispatched_to_me(j.id)
       )
     ORDER BY j.job_date DESC NULLS LAST
     LIMIT 500
  )
  SELECT
    to_jsonb(m)
    || jsonb_build_object(
         -- CUSTOMER NAME — RLS-equivalent (Codex re-review-3 P2): this function is
         -- SECURITY DEFINER, so a raw `customers` read would bypass customers_select and
         -- could leak a farm_name the caller can't otherwise see (a sales_rep is limited
         -- to assigned customers; an applicator/driver to a time-windowed set). Return the
         -- name ONLY when the caller would pass customers_select OR
         -- customers_select_location_dispatchee for THIS job's customer; else farm_name
         -- is null (the board renders 'Unknown', exactly as the unfiltered RLS embed would).
         'customer',
         (SELECT jsonb_build_object(
                   'farm_name',
                   CASE WHEN (
                     is_admin()
                     OR is_sales_rep()  -- any customer since 20261013220000 (Mason, 2026-10-13)
                     OR (is_driver() AND EXISTS (
                           SELECT 1 FROM public.deliveries d
                            WHERE d.customer_id = c.id
                              AND d.assigned_driver = (select auth.uid())
                              AND d.scheduled_date >= (CURRENT_DATE - interval '1 day')))
                     OR (is_applicator() AND EXISTS (
                           SELECT 1 FROM public.jobs j2
                            WHERE j2.customer_id = c.id
                              AND j2.applicator_id = (select auth.uid())
                              AND j2.job_date >= (CURRENT_DATE - interval '7 days')))
                     OR EXISTS (
                           SELECT 1 FROM public.jobs j3
                            WHERE j3.customer_id = c.id
                              AND public._is_dispatched_to_me(j3.id))
                   ) THEN c.farm_name ELSE NULL END)
            FROM public.customers c WHERE c.id = m.customer_id),
         -- JOB_FIELDS — only the rows of fields the caller may see (_can_see_field, row 11.4
         -- part B): office staff and the whole-job applicator get every field of the job, a
         -- per-field or crew assignee only the field their own dispatch points at, as
         -- job_fields_select_location_dispatchee now allows. field_name is
         -- gated to the fields_select predicate (admin/sales_rep/applicator) so a dispatched
         -- crew member whose role is NOT applicator doesn't get a field name they couldn't
         -- read under RLS (null → the board falls back to 'Field'). (Codex re-review-3 P2.)
         'job_fields',
         coalesce((
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', jf.id,
                      'field_id', jf.field_id,
                      'acres_to_treat', jf.acres_to_treat,
                      'sort_order', jf.sort_order,
                      'field', jsonb_build_object(
                        'id', f.id,
                        'field_name', CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                                           THEN f.field_name ELSE NULL END)
                    ) ORDER BY jf.sort_order
                  )
             FROM public.job_fields jf
             JOIN public.fields f ON f.id = jf.field_id
            WHERE jf.job_id = m.id
              AND public._can_see_field(jf.field_id)
         ), '[]'::jsonb),
         -- per-location dispatch rows the CALLER can see, for client-side label aggregation
         '_dispatches',
         coalesce((
           SELECT jsonb_agg(jsonb_build_object('applicator_id', d.applicator_id, 'crew_id', d.crew_id))
             FROM public.job_location_dispatches d
            WHERE d.job_id = m.id
              AND d.dispatch_status = 'dispatched'
              AND (
                is_admin()
                OR is_sales_rep()
                OR (is_applicator() AND m.applicator_id = (select auth.uid()))
                OR d.applicator_id = (select auth.uid())
                OR (
                  d.crew_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM public.ground_crew_members gcm
                      JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                     WHERE gcm.crew_id = d.crew_id
                       AND gcm.profile_id = (select auth.uid())
                       AND gcm.is_active
                       AND gc.is_active
                  )
                )
              )
         ), '[]'::jsonb)
       )
    FROM matched m;
$function$;

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
    -- Every field on the job (field_id is the unit of billing precedence) that the caller
    -- may see: a per-field or crew assignee gets only their own field's billed customers
    -- (row 11.4 part B).
    SELECT DISTINCT jf.field_id
    FROM job_fields jf
    WHERE jf.job_id = p_job_id AND jf.field_id IS NOT NULL
      AND public._can_see_field(jf.field_id)
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
    --    (mirrors the frontend "if custMap empty → add primary" fallback). It asks
    --    about the job's fields, not the ones the caller sees, so a caller who sees
    --    none of them gets no rows (refused as incomplete), never a primary-only list.
    SELECT v_primary_customer_id
    WHERE NOT EXISTS (
        SELECT 1 FROM job_fields jf WHERE jf.job_id = p_job_id AND jf.field_id IS NOT NULL
      )
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

CREATE OR REPLACE FUNCTION public.get_jobs_billed_customers(p_job_ids uuid[])
 RETURNS TABLE(job_id uuid, customer_id uuid, farm_name text, account_number text, is_primary boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_job_ids IS NULL OR array_length(p_job_ids, 1) IS NULL THEN
    RETURN;  -- empty input -> empty set
  END IF;

  RETURN QUERY
  WITH input_jobs AS (
    SELECT DISTINCT v.job_id FROM unnest(p_job_ids) AS v(job_id)
  ),
  -- VISIBLE jobs only: self-gate per job on the FULL live jobs visibility — BOTH
  -- SELECT policies OR'd together, so we never under-resolve a job the caller can
  -- actually see:
  --   jobs_select:                     is_admin OR is_sales_rep OR (is_applicator AND applicator_id = auth.uid())
  --   jobs_select_location_dispatchee: _is_dispatched_to_me(job_id)  (per-location / crew dispatch)
  -- Without the dispatch leg, a per-location-dispatched applicator's /jobs row would
  -- fall back to primary-only and HIDE co-billed split owners — the exact bug FIX 2
  -- closes (Codex). A job the caller can't view is SKIPPED (fail-soft), never raised on.
  visible_jobs AS (
    SELECT j.id AS job_id, j.customer_id AS primary_customer_id
    FROM jobs j
    JOIN input_jobs ij ON ij.job_id = j.id
    WHERE is_admin()
       OR is_sales_rep()
       OR (is_applicator() AND j.applicator_id = (SELECT auth.uid()))
       OR _is_dispatched_to_me(j.id)
  ),
  job_field_ids AS (
    -- Every field on each visible job (the unit of billing precedence) that the caller may
    -- see: a per-field or crew assignee gets only their own field's billed customers
    -- (row 11.4 part B).
    SELECT vj.job_id, jf.field_id
    FROM visible_jobs vj
    JOIN job_fields jf ON jf.job_id = vj.job_id AND jf.field_id IS NOT NULL
    WHERE public._can_see_field(jf.field_id)
  ),
  fields_with_share AS (
    -- Shares whose field is ACTUALLY on the job (ignore an orphan share row).
    SELECT DISTINCT jfs.job_id, jfs.field_id
    FROM job_field_shares jfs
    JOIN job_field_ids jfi ON jfi.job_id = jfs.job_id AND jfi.field_id = jfs.field_id
  ),
  resolved AS (
    -- 1. Saved per-field shares (explicit split) — only for fields on the job.
    SELECT jfs.job_id, jfs.customer_id
    FROM job_field_shares jfs
    JOIN job_field_ids jfi ON jfi.job_id = jfs.job_id AND jfi.field_id = jfs.field_id
    WHERE jfs.customer_id IS NOT NULL

    UNION ALL

    -- 2. field_billing_defaults for fields WITHOUT a saved share.
    SELECT jfi.job_id, fbd.customer_id
    FROM job_field_ids jfi
    JOIN field_billing_defaults fbd ON fbd.field_id = jfi.field_id
    WHERE NOT EXISTS (
            SELECT 1 FROM fields_with_share fws
            WHERE fws.job_id = jfi.job_id AND fws.field_id = jfi.field_id
          )
      AND fbd.customer_id IS NOT NULL

    UNION ALL

    -- 3. The job's PRIMARY customer for fields with neither a share nor a default.
    SELECT jfi.job_id, vj.primary_customer_id
    FROM job_field_ids jfi
    JOIN visible_jobs vj ON vj.job_id = jfi.job_id
    WHERE NOT EXISTS (
            SELECT 1 FROM fields_with_share fws
            WHERE fws.job_id = jfi.job_id AND fws.field_id = jfi.field_id
          )
      AND NOT EXISTS (
            SELECT 1 FROM field_billing_defaults fbd WHERE fbd.field_id = jfi.field_id
          )
      AND vj.primary_customer_id IS NOT NULL

    UNION ALL

    -- 4. SAFETY FALLBACK: a visible job with NO fields still has a primary customer.
    --    It asks about the job's fields, not the ones the caller sees (row 11.4 part B).
    SELECT vj.job_id, vj.primary_customer_id
    FROM visible_jobs vj
    WHERE NOT EXISTS (
            SELECT 1 FROM job_fields jf WHERE jf.job_id = vj.job_id AND jf.field_id IS NOT NULL
          )
      AND vj.primary_customer_id IS NOT NULL
  ),
  distinct_pairs AS (
    SELECT DISTINCT r.job_id, r.customer_id FROM resolved r
  )
  -- LEFT JOIN so a since-removed customer_id still surfaces (NULL farm_name); the
  -- client treats a NULL name as INCOMPLETE for compliance docs, but for the LIST
  -- it just shows whatever resolves. is_primary = the job's primary customer.
  SELECT
    d.job_id,
    d.customer_id,
    c.farm_name,
    c.account_number,
    (d.customer_id = vj.primary_customer_id) AS is_primary
  FROM distinct_pairs d
  JOIN visible_jobs vj ON vj.job_id = d.job_id
  LEFT JOIN customers c ON c.id = d.customer_id
  ORDER BY d.job_id, (d.customer_id = vj.primary_customer_id) DESC, c.farm_name NULLS LAST;
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
      ('public.get_job_fields_with_geojson(uuid)',                '1415dc063e43969b6f647a18df5f745c'),
      ('public.get_dispatch_board_jobs(uuid,text,date,date)',     'd93066303f3e7c1d30a948d627f401dc'),
      ('public.get_job_billed_customers(uuid)',                   '94138236eaec6ff594498994b48ac348'),
      ('public.get_jobs_billed_customers(uuid[])',                'b56bba826d92d390c6793dd476a4a8fe')
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
  IF (SELECT count(*) FROM pg_temp.field_tables_follow_field_access_attrs) <> 4 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not every pinned function was snapshotted';
  END IF;

  FOR v_pol IN
    SELECT * FROM (VALUES
      ('fields',                    'fields_select',                         '{authenticated}', '(is_admin() OR is_sales_rep() OR (is_applicator() AND _can_see_field(id)))'),
      ('field_crop_history',        'field_crop_history_select',             '{public}',        '(is_admin() OR is_sales_rep() OR (is_applicator() AND _can_see_field(field_id)))'),
      ('field_obstacles',           'field_obstacles_select',                '{authenticated}', '(is_admin() OR is_sales_rep() OR (is_applicator() AND _can_see_field(field_id)))'),
      ('field_app_locations',       'field_app_locations_select',            '{public}',        '(is_admin() OR is_sales_rep() OR (is_applicator() AND _can_see_field(field_id)))'),
      ('field_app_location_shares', 'field_app_location_shares_select',      '{public}',        E'(is_admin() OR is_sales_rep() OR (is_applicator() AND (EXISTS ( SELECT 1\n   FROM field_app_locations l\n  WHERE ((l.id = field_app_location_shares.location_id) AND _can_see_field(l.field_id))))))'),
      ('field_billing_defaults',    'fbd_select',                            '{authenticated}', '(is_admin() OR is_sales_rep() OR _can_see_field(field_id))'),
      ('application_record_fields', 'arf_select',                            '{public}',        '(is_admin() OR is_sales_rep() OR _can_see_field(field_id))'),
      ('job_fields',                'job_fields_select_location_dispatchee', '{authenticated}', '(_is_dispatched_to_me(job_id) AND _can_see_field(field_id))')
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
  RAISE NOTICE 'POSTFLIGHT_OK: field tables follow field access (row 11.4 part B)';
END;
$postflight$;
