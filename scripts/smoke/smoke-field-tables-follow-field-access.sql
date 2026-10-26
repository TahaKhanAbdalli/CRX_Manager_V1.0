-- ============================================================================
-- SMOKE TEST (rolled back by design) for 20261023110000_field_tables_follow_field_access.
--
-- CONTAINER ONLY: run through scripts/smoke/prove-field-tables-follow-field-access-real-schema.mjs,
-- never against the live database: the chain plants [SMOKE] logins (auth.users rows), two customers,
-- fields, billing splits, a spray record, a job and a dispatch, which the LIVE-DATA GUARD refuses.
--
-- Rule under test (To-Do row 11.4, part B): field roles read only the field rows of their own
-- assignments through the tables, and the job functions return only those fields.
--   a. an applicator dispatched to one field of a two-field job reads only that field from fields,
--      field_billing_defaults and job_fields, and gets only it from get_job_fields_with_geojson and
--      only its billed customer from get_job_billed_customers;
--   b. a driver reads no field_billing_defaults or application_record_fields rows;
--   c. the admin still reads both fields, both billing splits and both billed customers.
--
-- Fail-first: before the migration the applicator reads both fields (step a fails).
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
  v_other_customer uuid := gen_random_uuid();
  v_field_mine uuid := gen_random_uuid();
  v_field_other uuid := gen_random_uuid();
  v_job uuid := gen_random_uuid();
  v_jf_mine uuid := gen_random_uuid();
  v_record uuid := gen_random_uuid();
  v_count int;
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
  INSERT INTO public.customers (id, farm_name, is_active) VALUES
    (v_customer, '[SMOKE] FTA Farm ' || v_suffix, true),
    (v_other_customer, '[SMOKE] FTA Other ' || v_suffix, true);
  INSERT INTO public.fields (id, customer_id, field_name, total_acres, is_active) VALUES
    (v_field_mine,  v_customer, '[SMOKE] FTA mine '  || v_suffix, 10, true),
    (v_field_other, v_customer, '[SMOKE] FTA other ' || v_suffix, 10, true);
  -- The other field bills a second customer, so its billed customer is visible only with it.
  INSERT INTO public.field_billing_defaults (field_id, customer_id, split_pct, is_primary) VALUES
    (v_field_mine, v_customer, 100, true), (v_field_other, v_other_customer, 100, true);
  INSERT INTO public.application_records (id, record_number, source_type, source_id, customer_id, application_date)
    VALUES (v_record, 'SMK-FTA-' || v_suffix, 'job', v_job, v_customer, current_date);
  INSERT INTO public.application_record_fields (application_record_id, field_id, acres) VALUES
    (v_record, v_field_mine, 10), (v_record, v_field_other, 10);
  INSERT INTO public.jobs (id, job_number, customer_id, job_date, status)
    VALUES (v_job, 'SMK-FTA-' || v_suffix, v_customer, current_date, 'scheduled');
  INSERT INTO public.job_fields (id, job_id, field_id) VALUES (v_jf_mine, v_job, v_field_mine), (gen_random_uuid(), v_job, v_field_other);
  INSERT INTO public.job_location_dispatches (job_field_id, job_id, applicator_id, dispatch_status)
    VALUES (v_jf_mine, v_job, v_applicator, 'dispatched');

  -- Every probe runs as a signed-in user would: role authenticated, so row security applies.
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- a. The dispatched applicator reads only their own field, by every route.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_applicator, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_count FROM public.fields WHERE id IN (v_field_mine, v_field_other);
  IF v_count <> 1 OR NOT EXISTS (SELECT 1 FROM public.fields WHERE id = v_field_mine) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a. the dispatched applicator read % of the two fields, expected only their own', v_count;
  END IF;
  IF (SELECT count(*) FROM public.field_billing_defaults WHERE field_id IN (v_field_mine, v_field_other)) <> 1
     OR (SELECT count(*) FROM public.job_fields WHERE job_id = v_job) <> 1
     OR (SELECT count(*) FROM public.get_job_fields_with_geojson(v_job)) <> 1
     OR (SELECT string_agg(customer_id::text, ',') FROM public.get_job_billed_customers(v_job)) IS DISTINCT FROM v_customer::text THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a. billing splits, job_fields, the job map or the billed customers still reach the other field';
  END IF;

  -- b. The driver reads no billing splits or spray-record fields.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  IF (SELECT count(*) FROM public.field_billing_defaults WHERE field_id IN (v_field_mine, v_field_other)) <> 0
     OR (SELECT count(*) FROM public.application_record_fields WHERE application_record_id = v_record) <> 0 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: b. the driver read billing splits or spray-record fields';
  END IF;

  -- c. The admin is unchanged.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  IF (SELECT count(*) FROM public.fields WHERE id IN (v_field_mine, v_field_other)) <> 2
     OR (SELECT count(*) FROM public.field_billing_defaults WHERE field_id IN (v_field_mine, v_field_other)) <> 2
     OR (SELECT count(*) FROM public.get_job_fields_with_geojson(v_job)) <> 2
     OR (SELECT count(*) FROM public.get_job_billed_customers(v_job)) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: c. the admin no longer reads both fields, splits and billed customers';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
