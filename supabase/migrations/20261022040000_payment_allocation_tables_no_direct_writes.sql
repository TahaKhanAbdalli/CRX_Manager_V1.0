-- =====================================================================================================
-- 20261022040000_payment_allocation_tables_no_direct_writes.sql
--
-- WHAT: the three payment-allocation tables -- allocation_sets, invoice_line_allocations and
--   order_line_allocations -- can no longer be written through the Data API. `anon`, `authenticated`
--   and PUBLIC lose INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on them, and
--   the five write policies are dropped: the three INSERT policies (admin or sales rep, from
--   20260213100000) and allocation_sets' admin UPDATE and DELETE policies. SELECT is unchanged: the
--   SELECT grants, the three SELECT policies (admin or sales rep) and row security stay exactly as
--   they are, so Payment History and the reconciliation check read the same rows. service_role and
--   metabase_ro keep their grants.
--
-- WHY: these rows are payment truth. invoice_line_allocations.amount_cents is what reconciliation
--   (src/lib/reconciliation.ts) and Payment History read as "paid", and void_invoice / unpost_invoice
--   refuse when an invoice has an active allocation. Before this, any active sales rep could POST a row
--   straight to the table with any allocation_set_id, invoice_id, bill_to_customer_id or amount_cents:
--   a fake payment, or a block on voiding an invoice. Live read 2026-10-22 03:50 UTC: 1, 1 and 0 rows,
--   no sign of misuse.
--
-- WHO STILL WRITES: only these SECURITY DEFINER functions, owned by postgres (the table owner, with
--   BYPASSRLS; row security is not FORCEd on these tables), each with search_path = public, pg_temp
--   (live read 2026-10-22):
--     allocate_payment                              -> allocation_sets, invoice_line_allocations
--     _void_payment_replay_impl_20261015            -> allocation_sets
--     _void_invoice_split_provenance_impl_20260719  -> allocation_sets, invoice_line_allocations
--     _update_order_items_impl                      -> order_line_allocations
--   They do not use the API roles' table privileges, so revoking them changes nothing for these
--   paths. No screen and no Edge Function writes these tables (src/ only SELECTs them), no SECURITY
--   INVOKER function, view, cron job or other table's policy names them (all schemas; the invoker
--   trigger _enforce_allocation_not_over_payment on allocation_sets reads only NEW and fires under
--   the definer writers), and the
--   foreign keys into them cascade only from allocation_sets, which only the functions above delete.
--   The preflight refuses to run if row security is forced or postgres lost BYPASSRLS, if any
--   function in any schema that may write or row-lock these tables is not SECURITY DEFINER owned by
--   postgres with a fixed search_path (it would break here), or if the writers are not exactly the
--   four above (re-review first).
--
-- E2E: tests/e2e/fixtures/teardown-fixtures.ts no longer deletes these rows (it could only through
--   the dropped admin DELETE policy); the E2E suite is disabled until a staging project exists.
--
-- Not destructive: no row is read, changed or deleted. Re-applying is harmless.
--
-- ROLLBACK (re-opens direct writes; only with Mason's approval):
--   GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
--     ON public.allocation_sets, public.invoice_line_allocations, public.order_line_allocations
--     TO authenticated;
--   GRANT MAINTAIN ON public.allocation_sets, public.invoice_line_allocations,
--     public.order_line_allocations TO anon;
--   CREATE POLICY allocation_sets_insert ON public.allocation_sets FOR INSERT
--     WITH CHECK (is_admin() OR is_sales_rep());
--   CREATE POLICY allocation_sets_update ON public.allocation_sets FOR UPDATE USING (is_admin());
--   CREATE POLICY allocation_sets_admin_delete ON public.allocation_sets FOR DELETE TO authenticated
--     USING (is_admin());
--   CREATE POLICY invoice_line_alloc_insert ON public.invoice_line_allocations FOR INSERT
--     WITH CHECK (is_admin() OR is_sales_rep());
--   CREATE POLICY order_line_alloc_insert ON public.order_line_allocations FOR INSERT
--     WITH CHECK (is_admin() OR is_sales_rep());
--
-- Proof: node scripts/smoke/prove-payment-allocation-no-direct-writes-real-schema.mjs
-- =====================================================================================================

SET LOCAL lock_timeout = '10s';

DO $preflight$
DECLARE
  v_table regclass;
  v_bad text;
  v_writers text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'public.allocation_sets'::regclass,
    'public.invoice_line_allocations'::regclass,
    'public.order_line_allocations'::regclass
  ]
  LOOP
    -- The definer writers below rely on their owner skipping row security: postgres owns the table
    -- and has BYPASSRLS (live 2026-10-22), and row security is not FORCEd on it.
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
       WHERE c.oid = v_table AND c.relrowsecurity AND NOT c.relforcerowsecurity
         AND pg_get_userbyid(c.relowner) = 'postgres'
    ) THEN
      RAISE EXCEPTION 'ALLOCATION_WRITE_LOCK_PREFLIGHT: % must have row security on, not forced, and be owned by postgres', v_table;
    END IF;
  END LOOP;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'postgres') THEN
    RAISE EXCEPTION 'ALLOCATION_WRITE_LOCK_PREFLIGHT: postgres lacks BYPASSRLS; the definer writers would be refused once the write policies are gone';
  END IF;

  -- Any function, in any schema, that names one of the three tables and could write or row-lock it
  -- (INSERT, UPDATE, DELETE, MERGE, TRUNCATE, FOR UPDATE / SHARE, LOCK) must run as postgres with a
  -- fixed search_path; anything else would lose its access here. Deliberately broad: a false match
  -- only stops the migration for a re-check.
  SELECT string_agg(format('%s.%s(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), ', ' ORDER BY n.nspname, p.proname)
    INTO v_bad
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND (coalesce(p.prosrc, '') || coalesce(p.prosqlbody::text, '')) ~* '(allocation_sets|invoice_line_allocations|order_line_allocations)'
     AND (coalesce(p.prosrc, '') || coalesce(p.prosqlbody::text, '')) ~* '\m(insert|update|delete|merge|truncate|share|lock)\M'
     AND (NOT p.prosecdef
          OR pg_get_userbyid(p.proowner) <> 'postgres'
          OR NOT coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=public, pg_temp']);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ALLOCATION_WRITE_LOCK_PREFLIGHT: these functions may write or lock the allocation tables and are not SECURITY DEFINER owned by postgres with search_path = public, pg_temp, so they would break: %', v_bad;
  END IF;

  -- The functions, in any schema, that write the three tables, by the write statements themselves.
  SELECT string_agg(format('%s.%s', n.nspname, p.proname), ',' ORDER BY n.nspname, p.proname)
    INTO v_writers
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND (coalesce(p.prosrc, '') || coalesce(p.prosqlbody::text, ''))
         ~* '(insert\s+into|update(\s+only)?|delete\s+from(\s+only)?|merge\s+into(\s+only)?|truncate(\s+table)?(\s+only)?)\s+("?public"?\.)?"?(allocation_sets|invoice_line_allocations|order_line_allocations)\M';
  IF v_writers IS DISTINCT FROM 'public._update_order_items_impl,public._void_invoice_split_provenance_impl_20260719,public._void_payment_replay_impl_20261015,public.allocate_payment' THEN
    RAISE EXCEPTION 'ALLOCATION_WRITE_LOCK_PREFLIGHT: the writers of the allocation tables are not the four this migration was reviewed for (re-check them first): %', v_writers;
  END IF;
END
$preflight$;

-- A table-level REVOKE also clears column-level grants of the same privilege. PostgreSQL's REVOKE
-- reference: "When revoking privileges on a table, the corresponding column privileges (if any) are
-- automatically revoked on each column of the table, as well." Live holds no column grants on these
-- tables; the verify block below fails closed if any INSERT, UPDATE or REFERENCES column grant survives,
-- and the prover's columnGrantCleared case pre-grants column INSERT/UPDATE and watches this REVOKE clear them.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.allocation_sets, public.invoice_line_allocations, public.order_line_allocations
  FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS allocation_sets_insert ON public.allocation_sets;
DROP POLICY IF EXISTS allocation_sets_update ON public.allocation_sets;
DROP POLICY IF EXISTS allocation_sets_admin_delete ON public.allocation_sets;
DROP POLICY IF EXISTS invoice_line_alloc_insert ON public.invoice_line_allocations;
DROP POLICY IF EXISTS order_line_alloc_insert ON public.order_line_allocations;

-- ---------------------------------------------------------------------------------------------------
-- VERIFY: no API role can write, reads are unchanged, the operational roles keep their access.
-- ---------------------------------------------------------------------------------------------------
DO $verify$
DECLARE
  v_table regclass;
  v_role text;
  v_priv text;
  v_policies text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'public.allocation_sets'::regclass,
    'public.invoice_line_allocations'::regclass,
    'public.order_line_allocations'::regclass
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
       CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
       WHERE c.oid = v_table AND acl.grantee = 0
    ) THEN
      RAISE EXCEPTION 'ALLOCATION_WRITE_LOCK_VERIFY: PUBLIC holds a privilege on %', v_table;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
        IF has_table_privilege(v_role, v_table, v_priv) THEN
          RAISE EXCEPTION 'ALLOCATION_WRITE_LOCK_VERIFY: % still holds % on %', v_role, v_priv, v_table;
        END IF;
      END LOOP;
      IF EXISTS (
        SELECT 1 FROM pg_attribute a
         WHERE a.attrelid = v_table AND a.attnum > 0 AND NOT a.attisdropped
           AND has_column_privilege(v_role, v_table, a.attname, 'INSERT, UPDATE, REFERENCES')
      ) THEN
        RAISE EXCEPTION 'ALLOCATION_WRITE_LOCK_VERIFY: % still holds a column write privilege on %', v_role, v_table;
      END IF;
    END LOOP;
    -- Reads are unchanged: the screens read these tables as signed-in users.
    IF NOT has_table_privilege('authenticated', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'ALLOCATION_WRITE_LOCK_VERIFY: authenticated lost SELECT on %', v_table;
    END IF;
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('service_role', v_table, v_priv) THEN
        RAISE EXCEPTION 'ALLOCATION_WRITE_LOCK_VERIFY: service_role lost % on %', v_priv, v_table;
      END IF;
    END LOOP;
    -- No migration creates metabase_ro (it exists live), so a fresh or preview database may lack it.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro')
       AND NOT has_table_privilege('metabase_ro', v_table, 'SELECT') THEN
      RAISE EXCEPTION 'ALLOCATION_WRITE_LOCK_VERIFY: metabase_ro lost SELECT on %', v_table;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v_table AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'ALLOCATION_WRITE_LOCK_VERIFY: row security is off on %', v_table;
    END IF;
    -- replace(): pg_get_expr qualifies the functions as public.* when public is not on the search_path.
    -- name:command:permissive:roles (0 = PUBLIC):USING:WITH CHECK
    SELECT string_agg(format('%s:%s:%s:%s:%s:%s', pol.polname, pol.polcmd, pol.polpermissive, pol.polroles::text,
             replace(pg_get_expr(pol.polqual, pol.polrelid), 'public.', ''),
             coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')), ';' ORDER BY pol.polname)
      INTO v_policies
      FROM pg_policy pol WHERE pol.polrelid = v_table;
    IF v_policies IS DISTINCT FROM (CASE v_table
         WHEN 'public.allocation_sets'::regclass THEN 'allocation_sets_select:r:t:{0}:(is_admin() OR is_sales_rep()):'
         WHEN 'public.invoice_line_allocations'::regclass THEN 'invoice_line_alloc_select:r:t:{0}:(is_admin() OR is_sales_rep()):'
         ELSE 'order_line_alloc_select:r:t:{0}:(is_admin() OR is_sales_rep()):'
       END) THEN
      RAISE EXCEPTION 'ALLOCATION_WRITE_LOCK_VERIFY: % policies are not just its unchanged SELECT policy: %', v_table, v_policies;
    END IF;
  END LOOP;
END
$verify$;
