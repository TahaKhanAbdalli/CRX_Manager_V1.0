-- ============================================================================
-- SMOKE TEST (rolled back by design) for 20261026050000_field_tables_follow_field_access.
--
-- CONTAINER ONLY: run through scripts/smoke/prove-field-tables-follow-field-access-real-schema.mjs,
-- never against the live database: the chain plants [SMOKE] logins (auth.users rows), a customer,
-- fields, billing splits, a spray record, a job, a dispatch and a boundary part, which the LIVE-DATA
-- GUARD refuses.
--
-- Rule under test (To-Do row 11.4, part B; Mason 2026-10-25: field staff see the entire job): field
-- roles read the field rows of the jobs they are assigned to through the tables, and nothing else.
--   a. an applicator dispatched to ONE field of a two-field job reads both of that job's fields
--      (fields, field_billing_defaults) but not a third field that is on no job of theirs, and
--      cannot delete or add that job's boundary parts;
--   b. a driver reads no field_billing_defaults or application_record_fields rows;
--   c. the admin still reads all three fields and their billing splits.
--
-- Fail-first: before the migration the applicator reads all three fields (step a fails).
--
-- HOW TO RUN: as ONE statement inside a transaction that rolls back. It ALWAYS ends with RAISE
-- EXCEPTION 'SMOKE_PASS_ROLLBACK': that exact text = PASS; any other error = FAIL.
-- Auth: auth.uid() reads request.jwt.claims, set per call to a planted profile.
-- ============================================================================
DO $smoke$
DECLARE
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_admin uuid := gen_random_uuid();
  v_applicator uuid := gen_random_uuid();
  v_driver uuid := gen_random_uuid();
  v_customer uuid := gen_random_uuid();
  v_field_sent uuid := gen_random_uuid();
  v_field_same_job uuid := gen_random_uuid();
  v_field_elsewhere uuid := gen_random_uuid();
  v_job uuid := gen_random_uuid();
  v_jf_sent uuid := gen_random_uuid();
  v_record uuid := gen_random_uuid();
  v_count int;
  v_err text;
BEGIN
  -- 0. Fixtures: three logins (profiles from handle_new_user's direct-SQL path).
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
    (v_admin,      'smk-fta-admin-'  || v_suffix || '@example.invalid', jsonb_build_object('full_name', '[SMOKE] FTA admin '  || v_suffix, 'role', 'admin')),
    (v_applicator, 'smk-fta-app-'    || v_suffix || '@example.invalid', jsonb_build_object('full_name', '[SMOKE] FTA app '    || v_suffix, 'role', 'applicator')),
    (v_driver,     'smk-fta-driver-' || v_suffix || '@example.invalid', jsonb_build_object('full_name', '[SMOKE] FTA driver ' || v_suffix, 'role', 'driver'));
  IF (SELECT string_agg(role, ',' ORDER BY role) FROM public.profiles WHERE id IN (v_admin, v_applicator, v_driver) AND is_active)
     IS DISTINCT FROM 'admin,applicator,driver' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: the planted profiles are not an active admin, applicator and driver';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  INSERT INTO public.customers (id, farm_name, is_active) VALUES (v_customer, '[SMOKE] FTA Farm ' || v_suffix, true);
  INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
    (v_field_sent,      v_customer, '[SMOKE] FTA sent '      || v_suffix, 10, true),
    (v_field_same_job,  v_customer, '[SMOKE] FTA same job '  || v_suffix, 10, true),
    (v_field_elsewhere, v_customer, '[SMOKE] FTA elsewhere ' || v_suffix, 10, true);
  INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES
    (v_field_sent, v_customer, 100, true), (v_field_same_job, v_customer, 100, true), (v_field_elsewhere, v_customer, 100, true);
  INSERT INTO public.field_polygons (field_id, polygon_geojson, label, sort_order)
    VALUES (v_field_same_job, '{"type":"Polygon","coordinates":[]}', 'A', 1);
  INSERT INTO public.application_records (id, record_number, source_type, source_id, customer_id, application_date)
    VALUES (v_record, 'SMK-FTA-' || v_suffix, 'job', v_job, v_customer, current_date);
  INSERT INTO public.application_record_fields (application_record_id, field_id, acres) VALUES
    (v_record, v_field_sent, 10), (v_record, v_field_same_job, 10);
  INSERT INTO public.jobs (id, job_number, customer_id, job_date, status)
    VALUES (v_job, 'SMK-FTA-' || v_suffix, v_customer, current_date, 'scheduled');
  INSERT INTO public.job_fields (id, job_id, field_id) VALUES (v_jf_sent, v_job, v_field_sent), (gen_random_uuid(), v_job, v_field_same_job);
  INSERT INTO public.job_location_dispatches (job_field_id, job_id, applicator_id, dispatch_status)
    VALUES (v_jf_sent, v_job, v_applicator, 'dispatched');

  -- Every probe runs as a signed-in user would: role authenticated, so row security applies.
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- a. The applicator sent to one field reads the whole job, and nothing else.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_applicator, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_count FROM public.fields WHERE id IN (v_field_sent, v_field_same_job, v_field_elsewhere);
  IF v_count <> 2 OR EXISTS (SELECT 1 FROM public.fields WHERE id = v_field_elsewhere) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a. the dispatched applicator read % of the three fields, expected the two of their job', v_count;
  END IF;
  IF (SELECT count(*) FROM public.field_billing_defaults WHERE field_id IN (v_field_sent, v_field_same_job, v_field_elsewhere)) <> 2
     OR (SELECT count(*) FROM public.field_polygons WHERE field_id = v_field_same_job) <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a. billing splits or boundary parts do not follow the whole job';
  END IF;
  WITH d AS (DELETE FROM public.field_polygons WHERE field_id = v_field_same_job RETURNING 1)
  SELECT count(*) INTO v_count FROM d;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a. the applicator deleted % boundary parts', v_count;
  END IF;
  v_err := NULL;
  BEGIN
    INSERT INTO public.field_polygons (field_id, polygon_geojson, label, sort_order)
      VALUES (v_field_sent, '{"type":"Polygon","coordinates":[]}', 'B', 2);
  EXCEPTION WHEN OTHERS THEN v_err := SQLERRM;
  END;
  IF v_err IS NULL OR v_err NOT LIKE 'new row violates row-level security policy%' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a. the applicator added a boundary part (%)', COALESCE(v_err, 'no error');
  END IF;

  -- b. The driver reads no billing splits or spray-record fields.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  IF (SELECT count(*) FROM public.field_billing_defaults WHERE field_id IN (v_field_sent, v_field_same_job, v_field_elsewhere)) <> 0
     OR (SELECT count(*) FROM public.application_record_fields WHERE application_record_id = v_record) <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: b. the driver read billing splits or spray-record fields';
  END IF;

  -- c. The admin is unchanged.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  IF (SELECT count(*) FROM public.fields WHERE id IN (v_field_sent, v_field_same_job, v_field_elsewhere)) <> 3
     OR (SELECT count(*) FROM public.field_billing_defaults WHERE field_id IN (v_field_sent, v_field_same_job, v_field_elsewhere)) <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: c. the admin no longer reads all three fields and splits';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
