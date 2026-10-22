-- Rollback-only live chain for 20261021200000 (Goal 3, "Post uses what was saved and reviewed").
-- It plants no rows. Every posting call below is refused before it writes anything; the
-- full matrix (real posts, two users, a second tab, races, mutations) runs in the container
-- prover scripts/smoke/prove-post-binds-reviewed-invoice-version-real-schema.mjs.

DO $smoke$
DECLARE
  v_admin uuid;
  v_key text := 'smoke-post-version-' || gen_random_uuid()::text;
  v_missing uuid := gen_random_uuid();
  v_draft uuid;
  v_any uuid;
  v_version text;
  v_message text;
  v_result jsonb;
BEGIN
  IF to_regprocedure('public.invoice_post_version(public.invoices)') IS NULL
     OR to_regprocedure('public.post_invoice(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'SMOKE_PREREQ: 20261021200000 is not applied on this database';
  END IF;

  -- The old signatures, which take no version, are gone.
  IF to_regprocedure('public.post_invoice(uuid,text)') IS NOT NULL
     OR to_regprocedure('public.post_invoice_group(uuid,uuid,text)') IS NOT NULL
     OR to_regprocedure('public.batch_post_invoices(uuid[],text)') IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an old posting signature without a version still exists';
  END IF;

  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY id LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  -- post_invoice: key, then version, then the invoice.
  BEGIN
    PERFORM public.post_invoice(v_missing, 'v1:x', NULL);
    RAISE EXCEPTION 'SMOKE_FAIL: post_invoice accepted a NULL key';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'IDEMPOTENCY_KEY_REQUIRED: post_invoice' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.post_invoice(v_missing, '  ', v_key || '-a');
    RAISE EXCEPTION 'SMOKE_FAIL: post_invoice accepted a blank version';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE 'INVOICE_VERSION_REQUIRED:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.post_invoice(v_missing, 'v1:x', v_key || '-b');
    RAISE EXCEPTION 'SMOKE_FAIL: post_invoice posted a missing invoice';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message LIKE 'SMOKE_FAIL:%' OR v_message <> 'INVOICE_NOT_FOUND' THEN RAISE; END IF;
  END;

  -- post_invoice_group: the map must name every member with a version.
  BEGIN
    PERFORM public.post_invoice_group(v_missing, v_admin, '{}'::jsonb, v_key || '-c');
    RAISE EXCEPTION 'SMOKE_FAIL: post_invoice_group accepted an empty version map';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE 'INVOICE_VERSION_REQUIRED:%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.post_invoice_group(v_missing, v_admin, jsonb_build_object(v_missing::text, 'v1:x'), v_key || '-d');
    RAISE EXCEPTION 'SMOKE_FAIL: post_invoice_group posted a missing group';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message LIKE 'SMOKE_FAIL:%' OR v_message NOT LIKE 'No invoices found in group %' THEN RAISE; END IF;
  END;

  -- batch_post_invoices: every item needs a version.
  BEGIN
    PERFORM public.batch_post_invoices(jsonb_build_array(jsonb_build_object('invoice_id', v_missing)), v_key || '-e');
    RAISE EXCEPTION 'SMOKE_FAIL: batch_post_invoices accepted an item without a version';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message NOT LIKE 'INVOICE_VERSION_REQUIRED:%' THEN RAISE; END IF;
  END;

  -- The computed field on a real invoice: a SHA-256 version for an admin, equal to the helper.
  SELECT id INTO v_any FROM public.invoices WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;
  IF v_any IS NOT NULL THEN
    SELECT public.invoice_post_version(i) INTO v_version FROM public.invoices i WHERE i.id = v_any;
    IF v_version !~ '^v1:[0-9a-f]{64}$' OR v_version IS DISTINCT FROM public._invoice_post_version(v_any) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: invoice_post_version returned % for an admin', v_version;
    END IF;
  END IF;

  -- A real draft posted with a stale version is refused before anything is written.
  SELECT id INTO v_draft FROM public.invoices
   WHERE deleted_at IS NULL AND status IN ('draft', 'unposted') AND invoice_group_id IS NULL
   ORDER BY created_at DESC LIMIT 1;
  IF v_draft IS NOT NULL THEN
    BEGIN
      PERFORM public.post_invoice(v_draft, 'v1:stale', v_key || '-f');
      RAISE EXCEPTION 'SMOKE_FAIL: post_invoice posted a draft with a stale version';
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
      IF v_message LIKE 'SMOKE_FAIL:%' OR v_message NOT LIKE 'INVOICE_CHANGED_SINCE_LOADED:%' THEN RAISE; END IF;
    END;
    IF (SELECT status FROM public.invoices WHERE id = v_draft) NOT IN ('draft', 'unposted') THEN
      RAISE EXCEPTION 'SMOKE_FAIL: the refused draft changed status';
    END IF;
  END IF;

  -- Grants: API roles reach only the four public entry points.
  IF has_function_privilege('anon', 'public.post_invoice(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._invoice_post_version(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._lock_invoice_post_inputs(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.invoice_post_version(public.invoices)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: posting grants are wrong';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
