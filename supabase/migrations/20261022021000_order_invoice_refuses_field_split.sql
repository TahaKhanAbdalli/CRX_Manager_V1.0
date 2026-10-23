-- Written 2026-10-21; restamped 2026-10-22 from 20261021120000 (then 20261021160000) to 20261022021000 and re-pinned to the live
-- bodies after PR #1010. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: create_invoice_from_order refuses an order whose lines are split across fields.
--   An order with any order_item_field_allocations row is billed per field owner, only through
--   create_split_invoices_from_order. create_invoice_from_order (granted to authenticated) and its
--   private implementations never looked at those rows, so a direct Data API call, or an Order page
--   whose allocation read failed or went stale, billed the order's own customer for every field
--   owner's share. Its idempotency layer, _create_invoice_from_order_idem_impl_20260721, now raises
--   ORDER_HAS_FIELD_SPLIT (SQLSTATE 23514) before the billing core runs, so nothing is written and
--   no invoice number is drawn.
--
-- WHERE: after the replay lookup and after the order lock and terminal-order test, never before
--   them. An exact retry of an invoice created before the order was split still returns its
--   original id (a replay must answer what the first call did, not re-judge today's order); a
--   reused key with different arguments is still IDEMPOTENCY_ARGUMENT_MISMATCH. The order's lines
--   are locked FOR UPDATE first, in id order as create_split_invoices_from_order locks them: a new
--   allocation row KEY SHARE-locks its line (explicitly in trg_oifa_lock_when_posted, then through
--   order_item_field_allocations_order_item_id_fkey), and a new line KEY SHARE-locks the order,
--   which the public wrapper already holds FOR UPDATE, so no allocation can commit between this
--   test and the invoice insert. The other order (invoice first, allocation after) was already
--   closed: that trigger refuses an allocation while an active invoice covers the order
--   (ORDER_ALLOCATION_INVOICE_CONFLICT). Before the line lock it raises the billing core's own
--   live-delivery refusal (same words, same condition), so it never waits on complete_delivery,
--   which locks an order's lines before the order. Cost of the line lock: a transaction that edits
--   an order line and then (through after_order_items_change) the order's totals, at the same
--   moment as an invoice call on that same order, can deadlock with it; PostgreSQL rolls one side
--   back (40P01) with nothing written and no key saved. create_split_invoices_from_order takes the
--   same order-then-lines locks and the same exposure.
--
-- WHY: Sol (final reviewer) on PR #993, twice, 2026-10-21: the page-side guard is not enough;
--   financial invariants belong in PostgreSQL (AGENTS.md, CRX Hard Rules).
--
-- NOT CHANGED: create_invoice_from_order itself (its key requirement, type allow-list, order lock
--   and own-name test), the billing core _create_invoice_from_order_impl_20260718, and
--   create_split_invoices_from_order. The split path is unaffected: its implementation calls
--   create_invoice_from_order only when the order has NO allocation row (pinned below), a fallback
--   that already fails before reaching this layer (it sends a NULL key, IDEMPOTENCY_KEY_REQUIRED
--   since 2026-07-21; rpc-functions.md, KNOWN_ISSUES.md). The
--   re-emitted function is its verbatim live body of 2026-10-21 (live stores it with CRLF; this
--   file is LF) plus only the hunk marked "Field split". No rows change. No GRANT or REVOKE:
--   CREATE OR REPLACE keeps the OID, owner and exact ACL ({postgres} only), and the postflight
--   proves it.
--
-- OVERLOADS: _create_invoice_from_order_idem_impl_20260721 has exactly one overload (read-only on
--   live, 2026-10-21), so CREATE OR REPLACE replaces the live OID; the preflight and postflight
--   refuse a second one.
--
-- ORDERING: strict. Apply after every older pending migration.

SET LOCAL lock_timeout = '5s';
-- pg_get_constraintdef and pg_get_triggerdef omit a schema only when it is on the search_path;
-- fix it for this transaction so the preflight's definition pins read the same on every client.
SET LOCAL search_path = public, pg_temp;

CREATE TEMP TABLE order_invoice_field_split_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
       to_regprocedure('public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)')::oid AS idem_oid;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change
  -- (a client that stops on the first error, as every sanctioned apply path does, then stops).
  IF to_regclass('pg_temp.order_invoice_field_split_tx') IS NULL THEN
    RAISE EXCEPTION 'ORDER_INVOICE_FIELD_SPLIT_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.order_invoice_field_split_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'ORDER_INVOICE_FIELD_SPLIT_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- The function this file replaces, pinned CR-insensitively to its live body of 2026-10-21.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_create_invoice_from_order_idem_impl_20260721') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(replace(p.prosrc, chr(13), '')) = '3d393fb8639dbcb2aa38574ca9679eee'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]
        FROM pg_proc p WHERE p.oid = to_regprocedure('public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_ORDER_INVOICE_IDEM_DRIFT: expected the exact reviewed _create_invoice_from_order_idem_impl_20260721';
  END IF;
  -- What the placement relies on, pinned to the live bodies of 2026-10-21: the public wrapper
  -- locks the order and then calls this layer; the billing core is reached only from it; the
  -- split implementation calls the wrapper only for an order with no allocation row.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.create_invoice_from_order(uuid,uuid,text,text)', 'c97b2be8bee9dd8baaaab92bc24b92e7'),
        ('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)', '454e04c4e199549a4f5be9975e397e17'),
        ('public.create_split_invoices_from_order(uuid,uuid,text,text)', '0f1e36e8536fc56f08fcf6071ea76da8'),
        ('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)', 'ccde51261dd8c5270b6dbd24f28981bd')
      ) AS pin(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_DEPENDENCY_DRIFT: an order-invoice function differs from its reviewed body';
  END IF;
  -- Only the public wrapper may reach this layer: no Data API role may execute it or the core.
  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY[
        to_regprocedure('public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)'),
        to_regprocedure('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)')
      ]::oid[]) AS impl
      CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS api_role
     WHERE has_function_privilege(api_role, impl, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_PRIVATE_IMPL_EXPOSED: an order-invoice implementation is executable by a Data API role';
  END IF;
  -- What the line lock relies on. Allocation first: the allocation trigger and its foreign key
  -- KEY SHARE-lock the line, so the FOR UPDATE waits for that commit. Invoice first: that trigger
  -- waits on the line lock, then sees the invoice and refuses (ORDER_ALLOCATION_INVOICE_CONFLICT).
  -- A new or moved line: the order_items foreign key KEY SHARE-locks the order, held FOR UPDATE.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'trg_oifa_lock_when_posted'
       AND t.tgrelid = 'public.order_item_field_allocations'::regclass
       AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER trg_oifa_lock_when_posted BEFORE INSERT OR DELETE OR UPDATE ON public.order_item_field_allocations FOR EACH ROW EXECUTE FUNCTION prevent_oifa_edit_after_post()'
  ) OR (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
         WHERE p.oid = to_regprocedure('public.prevent_oifa_edit_after_post()'))
       IS DISTINCT FROM '90a83898c13b7273d6e895691c619b88' THEN
    RAISE EXCEPTION 'PREFLIGHT_ALLOCATION_TRIGGER_DRIFT: trg_oifa_lock_when_posted / prevent_oifa_edit_after_post differ from their reviewed form';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conname = 'order_items_order_id_fkey'
       AND c.contype = 'f'
       AND c.conrelid = 'public.order_items'::regclass
       AND c.confrelid = 'public.orders'::regclass
       AND pg_get_constraintdef(c.oid) = 'FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_ORDER_ITEM_FK_DRIFT: order_items.order_id must reference orders(id)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conname = 'order_item_field_allocations_order_item_id_fkey'
       AND c.contype = 'f'
       AND c.conrelid = 'public.order_item_field_allocations'::regclass
       AND c.confrelid = 'public.order_items'::regclass
       AND pg_get_constraintdef(c.oid) = 'FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_ALLOCATION_FK_DRIFT: order_item_field_allocations.order_item_id must reference order_items(id)';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public._create_invoice_from_order_idem_impl_20260721(
  p_order_id uuid,
  p_salesman_id uuid DEFAULT NULL,
  p_invoice_type text DEFAULT 'chemical_sale',
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_request jsonb;
  v_invoice_id uuid;
  v_order_status text;
  v_order_deleted_at timestamptz;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  v_request := jsonb_build_object(
    'version', 1,
    'order_id', p_order_id,
    'salesman_id', p_salesman_id,
    'invoice_type', p_invoice_type,
    'actor_id', v_actor
  );

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'create_invoice_from_order');
    IF v_existing IS NOT NULL THEN
      IF NOT (v_existing ? 'request' AND v_existing ? 'response') THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_FORMAT_INVALID: create_invoice_from_order';
      END IF;
      IF v_existing->'request' IS DISTINCT FROM v_request THEN
        RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: create_invoice_from_order key was already used for different order, salesman, invoice type, or actor arguments';
      END IF;
      RETURN NULLIF(v_existing->'response'->>'invoice_id', '')::uuid;
    END IF;
  END IF;

  SELECT status, deleted_at
    INTO v_order_status, v_order_deleted_at
    FROM public.orders
   WHERE id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;
  IF v_order_deleted_at IS NOT NULL OR v_order_status IN ('cancelled', 'voided') THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot create an invoice for a cancelled, voided, or deleted order';
  END IF;

  -- Field split (20261022021000): an order split across fields is billed per field owner, only
  -- through create_split_invoices_from_order. After the replay lookup above, so an exact retry of
  -- an invoice created before the split still returns its id. The lines are locked first: a new
  -- allocation row KEY SHARE-locks its line, so none can commit between this test and the insert.
  -- The billing core refuses any order with a live delivery; refuse it here first, with the core's
  -- own words, so the line lock never waits on complete_delivery (lines first, then the order).
  IF EXISTS (
    SELECT 1 FROM public.deliveries d
     WHERE d.order_id = p_order_id AND d.status NOT IN ('cancelled', 'voided')
  ) THEN
    RAISE EXCEPTION 'Cannot create an order-level invoice for order % — it has % active delivery(ies); invoices are created per delivery on completion. Cancel/void those deliveries first to bill the whole order manually.',
      (SELECT o.order_number FROM public.orders o WHERE o.id = p_order_id),
      (SELECT count(*) FROM public.deliveries d
        WHERE d.order_id = p_order_id AND d.status NOT IN ('cancelled', 'voided'));
  END IF;
  PERFORM 1
    FROM public.order_items oi
   WHERE oi.order_id = p_order_id
   ORDER BY oi.id
   FOR UPDATE;
  IF EXISTS (
    SELECT 1
      FROM public.order_item_field_allocations oifa
      JOIN public.order_items oi ON oi.id = oifa.order_item_id
     WHERE oi.order_id = p_order_id
  ) THEN
    RAISE EXCEPTION 'ORDER_HAS_FIELD_SPLIT: this order is split across fields; bill it per field owner through create_split_invoices_from_order'
      USING ERRCODE = 'check_violation';
  END IF;

  v_invoice_id := public._create_invoice_from_order_impl_20260718(
    p_order_id, p_salesman_id, p_invoice_type, NULL
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'create_invoice_from_order',
      jsonb_build_object(
        'request', v_request,
        'response', jsonb_build_object('invoice_id', v_invoice_id)
      )
    );
  END IF;
  RETURN v_invoice_id;
END;
$function$;

DO $postflight$
BEGIN
  IF to_regclass('pg_temp.order_invoice_field_split_tx') IS NULL THEN
    RAISE EXCEPTION 'ORDER_INVOICE_FIELD_SPLIT_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.order_invoice_field_split_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'ORDER_INVOICE_FIELD_SPLIT_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF to_regprocedure('public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)')::oid
       IS DISTINCT FROM (SELECT idem_oid FROM pg_temp.order_invoice_field_split_tx) THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_INVOICE_IDEM_IDENTITY: the replace must preserve the function OID';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_create_invoice_from_order_idem_impl_20260721') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(replace(p.prosrc, chr(13), '')) = 'c43e09ca4310594cabff83bed4b8cd20'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_INVOICE_IDEM_CONTRACT: _create_invoice_from_order_idem_impl_20260721 body, signature or access drifted';
  END IF;
  -- Nothing else moved: the wrapper, the core and both split functions keep their bodies.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.create_invoice_from_order(uuid,uuid,text,text)', 'c97b2be8bee9dd8baaaab92bc24b92e7'),
        ('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)', '454e04c4e199549a4f5be9975e397e17'),
        ('public.create_split_invoices_from_order(uuid,uuid,text,text)', '0f1e36e8536fc56f08fcf6071ea76da8'),
        ('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)', 'ccde51261dd8c5270b6dbd24f28981bd')
      ) AS pin(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_DEPENDENCY_DRIFT: an order-invoice function other than the idempotency layer changed';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: create_invoice_from_order refuses an order split across fields (ORDER_HAS_FIELD_SPLIT) after its replay lookup';
END
$postflight$;
