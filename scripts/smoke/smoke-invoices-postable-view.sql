-- Rollback-only live chain for 20261022025000 (the posting version on invoices_postable).
-- It plants no rows and writes nothing. The full matrix (every posting path through the view,
-- the view's rules, and a simulated cost column lock) runs in the container prover
-- scripts/smoke/prove-post-binds-reviewed-invoice-version-real-schema.mjs.

DO $smoke$
DECLARE
  v_admin uuid;
  v_any uuid;
  v_version text;
  v_bad text;
BEGIN
  IF to_regclass('public.invoices_postable') IS NULL
     OR to_regprocedure('public.invoice_post_version(public.invoices_postable)') IS NULL THEN
    RAISE EXCEPTION 'SMOKE_PREREQ: 20261022025000 is not applied on this database';
  END IF;

  -- security_invoker, and every invoices column except the cost column.
  IF NOT EXISTS (SELECT 1 FROM pg_class c, unnest(c.reloptions) o
                  WHERE c.oid = 'public.invoices_postable'::regclass AND o IN ('security_invoker=true', 'security_invoker=on')) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoices_postable is not security_invoker';
  END IF;
  IF (SELECT string_agg(attname, ',' ORDER BY attname) FROM pg_attribute
       WHERE attrelid = 'public.invoices_postable'::regclass AND attnum > 0 AND NOT attisdropped)
     IS DISTINCT FROM (SELECT string_agg(attname, ',' ORDER BY attname) FROM pg_attribute
       WHERE attrelid = 'public.invoices'::regclass AND attnum > 0 AND NOT attisdropped AND attname <> 'total_cost_cents') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoices_postable columns are not every invoices column but total_cost_cents';
  END IF;

  -- SELECT-only for authenticated and service_role; nothing for anon or PUBLIC.
  SELECT string_agg(format('%s %s', r.rol, p.priv), ', ') INTO v_bad
    FROM (VALUES ('authenticated'), ('service_role'), ('anon'), ('public')) AS r(rol)
    CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
   WHERE (has_table_privilege(r.rol, 'public.invoices_postable', p.priv)
          OR (p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
              AND has_any_column_privilege(r.rol, 'public.invoices_postable', p.priv)))
         IS DISTINCT FROM (r.rol IN ('authenticated', 'service_role') AND p.priv = 'SELECT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoices_postable privileges are wrong: %', v_bad;
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.invoice_post_version(public.invoices_postable)'::regprocedure)
     OR NOT has_function_privilege('authenticated', 'public.invoice_post_version(public.invoices_postable)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.invoice_post_version(public.invoices_postable)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public._invoice_post_version(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: invoice_post_version(invoices_postable) is not SECURITY DEFINER for authenticated only';
  END IF;

  -- On a real invoice, an admin's version from the view equals the posting helper's.
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY id LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'SMOKE_SETUP: no active admin profile'; END IF;
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SELECT id INTO v_any FROM public.invoices WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1;
  IF v_any IS NOT NULL THEN
    SELECT public.invoice_post_version(i) INTO v_version FROM public.invoices_postable i WHERE i.id = v_any;
    IF v_version !~ '^v1:[0-9a-f]{64}$' OR v_version IS DISTINCT FROM public._invoice_post_version(v_any) THEN
      RAISE EXCEPTION 'SMOKE_FAIL: invoice_post_version from invoices_postable returned % for an admin', v_version;
    END IF;
  ELSE
    RAISE NOTICE 'SMOKE_SKIP: no invoice exists, so the view version was not compared live (the container prover covers it)';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
