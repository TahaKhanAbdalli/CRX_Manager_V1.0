-- Written 2026-10-21. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: split billing can bill a field owner who is not the order's customer.
--   create_split_invoices_from_order bills each field owner its share of a field-allocated order
--   (one draft per customer, sharing an invoice_group_id), but the invoice trigger function
--   guard_invoice_terminal_order refused EVERY order-linked invoice whose customer differs from the
--   order's (INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID, since 20260721014858), on INSERT and on every
--   UPDATE. So a split onto another customer's field rolled back, and once
--   20261021120000 (PR #1006) makes create_invoice_from_order refuse a split order, such an order
--   had no invoice path at all (Sol on #1006, 2026-10-21). KNOWN_ISSUES.md records it as
--   "Splitting an order's bill to a landlord always fails" (Mason, 2026-10-13: it should work).
--
--   guard_invoice_terminal_order keeps the rule and admits exactly one exception, a governed split
--   invoice (invoice_group_id set):
--   * created, or re-totalled while being created, by create_split_invoices_from_order: inside its
--     split_invoice_creation_claims claim for this transaction and this order, with the invoice's
--     identity (customer, group) unchanged by an UPDATE, and only for a customer this order's field
--     split bills, resolved exactly as the split implementation resolves owners: a field's
--     field_billing_defaults customers, or the field's own customer when it has none;
--   * afterwards (posting, save_invoice edits, void, cancel, soft delete): only while its private
--     split_invoice_provenance row names that same invoice, order, customer and group, with the
--     customer and group unchanged by the UPDATE.
--   Both private tables are written only inside SECURITY DEFINER functions (RLS deny-all, no Data
--   API grant; pinned below), so no caller can manufacture either. Every other check in the guard
--   (terminal orders, delivery lineage, recovery capabilities) runs unchanged for these invoices.
--
-- WHY: Sol (final reviewer) on PR #1006, HIGH: the designated per-owner path must work before the
--   single-customer path refuses split orders. Requested by the merge coordinator 2026-10-21.
--
-- NOT CHANGED: the trigger itself (trg_guard_invoice_terminal_order, BEFORE INSERT OR UPDATE),
--   require_split_invoice_creation_claim (only the claimed split path can create a split invoice),
--   guard_split_invoice_provenance_identity (a governed split invoice's customer, order and group
--   can never change), and both split functions. The re-emitted function is its verbatim live body
--   of 2026-10-21 (live stores it with CRLF; this file is LF) plus only the two hunks marked
--   "Governed split". No rows change. No GRANT or REVOKE: CREATE OR REPLACE keeps the OID, owner
--   and exact ACL ({postgres} only), and the postflight proves it.
--
-- OVERLOADS: guard_invoice_terminal_order() has exactly one overload (read-only on live,
--   2026-10-21); the preflight and postflight refuse a second one.
--
-- ORDERING: strict. Apply after every older pending migration.

SET LOCAL lock_timeout = '5s';
-- pg_get_triggerdef omits a schema only when it is on the search_path; fix it for this
-- transaction so the preflight's definition pins read the same on every client.
SET LOCAL search_path = public, pg_temp;

CREATE TEMP TABLE split_invoice_lineage_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
       to_regprocedure('public.guard_invoice_terminal_order()')::oid AS guard_oid;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change
  -- (a client that stops on the first error, as every sanctioned apply path does, then stops).
  IF to_regclass('pg_temp.split_invoice_lineage_tx') IS NULL THEN
    RAISE EXCEPTION 'SPLIT_INVOICE_LINEAGE_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.split_invoice_lineage_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'SPLIT_INVOICE_LINEAGE_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- The function this file replaces, pinned CR-insensitively to its live body of 2026-10-21.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'guard_invoice_terminal_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'trigger'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) = ''
        AND md5(replace(p.prosrc, chr(13), '')) = 'd2ce62f92956ccd651f570a94ce3f1dc'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.guard_invoice_terminal_order()')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_INVOICE_LINEAGE_GUARD_DRIFT: expected the exact reviewed guard_invoice_terminal_order';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'trg_guard_invoice_terminal_order'
       AND t.tgrelid = 'public.invoices'::regclass
       AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER trg_guard_invoice_terminal_order BEFORE INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_invoice_terminal_order()'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_INVOICE_LINEAGE_TRIGGER_DRIFT: trg_guard_invoice_terminal_order differs from its reviewed form';
  END IF;
  -- What the exception relies on, pinned to the live bodies of 2026-10-21: only the claimed split
  -- path creates a split invoice, a governed split invoice's identity never changes, and the split
  -- functions open the claim, resolve owners and write the provenance this guard reads.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.require_split_invoice_creation_claim()', 'e73daae16c5ff5432644060f2b34f925'),
        ('public.guard_split_invoice_provenance_identity()', '639875d6641556c78c25d633c67821f1'),
        ('public.create_split_invoices_from_order(uuid,uuid,text,text)', '0f1e36e8536fc56f08fcf6071ea76da8'),
        ('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)', 'f671f1a3f5406cff52aedd8a5fb40b31')
      ) AS pin(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_DEPENDENCY_DRIFT: a split-invoice function differs from its reviewed body';
  END IF;
  -- Their triggers, by exact definition: the claim check on every INSERT, the identity lock on
  -- every UPDATE and DELETE (a narrower binding would let a column escape it).
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'require_split_invoice_creation_claim' AND t.tgrelid = 'public.invoices'::regclass AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER require_split_invoice_creation_claim BEFORE INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION require_split_invoice_creation_claim()'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'guard_split_invoice_provenance_identity' AND t.tgrelid = 'public.invoices'::regclass AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER guard_split_invoice_provenance_identity BEFORE DELETE OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_split_invoice_provenance_identity()'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_SPLIT_INVOICE_TRIGGER_DRIFT: the split creation-claim or provenance-identity trigger differs from its reviewed form';
  END IF;
  -- No caller may manufacture a claim or a provenance row: RLS on, and no Data API role may write.
  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY['public.split_invoice_creation_claims', 'public.split_invoice_provenance']) AS tbl
      CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS api_role
      CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS priv
     WHERE has_table_privilege(api_role, tbl, priv)
        -- A column-level grant is invisible to has_table_privilege.
        OR (priv IN ('INSERT', 'UPDATE') AND has_any_column_privilege(api_role, tbl, priv))
  ) OR EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid IN ('public.split_invoice_creation_claims'::regclass, 'public.split_invoice_provenance'::regclass)
       AND NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_SPLIT_PRIVATE_TABLE_EXPOSED: a Data API role can write a split claim or provenance row';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.guard_invoice_terminal_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_status text;
  v_order_number text;
  v_order_deleted_at timestamptz;
  v_order_customer_id uuid;
  v_canonical_cancel_cleanup boolean := false;
  v_canonical_void_cleanup boolean := false;
  v_canonical_delete_cleanup boolean := false;
  v_existing_accounting_update boolean := false;
  v_valid_delivery_lineage boolean := false;
  v_valid_completed_delivery boolean := false;
  v_has_writer_capability boolean := false;
  v_has_poster_capability boolean := false;
  -- Governed split (20261021150000): see the lineage test below.
  v_split_identity_kept boolean := false;
  v_governed_split_customer boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
  ) THEN
    RAISE EXCEPTION 'INVOICE_SOURCE_LINEAGE_IMMUTABLE: order_id and delivery_id cannot change after invoice creation';
  END IF;

  IF NEW.order_id IS NULL THEN
    IF NEW.delivery_id IS NOT NULL THEN
      RAISE EXCEPTION 'INVOICE_DELIVERY_ORDER_REQUIRED: a delivery-linked invoice must retain its source order';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT status, order_number, deleted_at, customer_id
      INTO v_order_status, v_order_number, v_order_deleted_at, v_order_customer_id
      FROM public.orders
     WHERE id = NEW.order_id
     FOR UPDATE;
  ELSE
    SELECT status, order_number, deleted_at, customer_id
      INTO v_order_status, v_order_number, v_order_deleted_at, v_order_customer_id
      FROM public.orders
     WHERE id = NEW.order_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot attach an invoice to missing order %', NEW.order_id;
  END IF;
  -- Governed split (20261021150000): a split invoice (invoice_group_id set) may name a field owner
  -- other than the customer of its order, and only that invoice. While the split RPC creates or
  -- totals it: inside its claim for this transaction and order, for a customer the field split of
  -- this order bills (the billing-default customers of a field, or the customer of the field when
  -- it has none, as the split implementation resolves them). Afterwards: only as the invoice its
  -- private provenance row names. Its customer and group never change through this exception.
  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id AND NEW.invoice_group_id IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      v_split_identity_kept := true;
    ELSE
      v_split_identity_kept := NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
        AND NEW.invoice_group_id IS NOT DISTINCT FROM OLD.invoice_group_id;
      v_governed_split_customer := v_split_identity_kept AND EXISTS (
        SELECT 1
          FROM public.split_invoice_provenance p
         WHERE p.invoice_id = NEW.id
           AND p.order_id = NEW.order_id
           AND p.customer_id = NEW.customer_id
           AND p.invoice_group_id = NEW.invoice_group_id
      );
    END IF;
    IF v_split_identity_kept AND NOT v_governed_split_customer THEN
      v_governed_split_customer := EXISTS (
        SELECT 1
          FROM public.split_invoice_creation_claims claim
         WHERE claim.transaction_id = pg_current_xact_id()
           AND claim.order_id = NEW.order_id
      ) AND EXISTS (
        SELECT 1
          FROM public.order_item_field_allocations oifa
          JOIN public.order_items oi ON oi.id = oifa.order_item_id
         WHERE oi.order_id = NEW.order_id
           AND (
             EXISTS (
               SELECT 1 FROM public.field_billing_defaults fbd
                WHERE fbd.field_id = oifa.field_id
                  AND fbd.customer_id = NEW.customer_id
             )
             OR (
               NOT EXISTS (SELECT 1 FROM public.field_billing_defaults fbd WHERE fbd.field_id = oifa.field_id)
               AND EXISTS (
                 SELECT 1 FROM public.fields f
                  WHERE f.id = oifa.field_id
                    AND f.customer_id = NEW.customer_id
               )
             )
           )
      );
    END IF;
  END IF;
  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id AND NOT v_governed_split_customer THEN
    RAISE EXCEPTION 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID: invoice and order customer must match';
  END IF;

  IF NEW.delivery_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.deliveries d
       WHERE d.id = NEW.delivery_id
         AND d.order_id = NEW.order_id
         AND d.customer_id = NEW.customer_id
         AND d.deleted_at IS NULL
    ), EXISTS (
      SELECT 1 FROM public.deliveries d
       WHERE d.id = NEW.delivery_id
         AND d.order_id = NEW.order_id
         AND d.customer_id = NEW.customer_id
         AND d.status = 'completed'
         AND d.deleted_at IS NULL
    ) INTO v_valid_delivery_lineage, v_valid_completed_delivery;
    IF NOT v_valid_delivery_lineage THEN
      RAISE EXCEPTION 'INVOICE_DELIVERY_LINEAGE_INVALID: delivery, order, and customer must match';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.invoice_delivery_recovery_capabilities c
     WHERE c.transaction_id = txid_current()
       AND c.purpose = 'writer'
       AND c.delivery_id = NEW.delivery_id
       AND c.actor_id = auth.uid()
  ), EXISTS (
    SELECT 1 FROM public.invoice_delivery_recovery_capabilities c
     WHERE c.transaction_id = txid_current()
       AND c.purpose = 'poster'
       AND c.delivery_id = NEW.delivery_id
       AND c.actor_id = auth.uid()
  ) INTO v_has_writer_capability, v_has_poster_capability;

  IF TG_OP = 'UPDATE' THEN
    v_canonical_cancel_cleanup :=
      OLD.status IN ('draft', 'unposted')
      AND NEW.status = 'cancelled'
      AND NEW.total_amount_cents = 0
      AND NEW.paid_amount_cents = 0
      AND NEW.prepay_applied_cents = 0
      AND NEW.write_off_cents = 0
      AND NEW.credit_applied_cents = 0
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

    v_canonical_void_cleanup :=
      OLD.status NOT IN ('cancelled', 'voided')
      AND NEW.status = 'voided'
      AND NEW.total_amount_cents = 0
      AND NEW.paid_amount_cents = 0
      AND NEW.prepay_applied_cents = 0
      AND NEW.write_off_cents = 0
      AND NEW.credit_applied_cents = 0
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

    v_canonical_delete_cleanup :=
      OLD.deleted_at IS NULL
      AND NEW.deleted_at IS NOT NULL
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_amount_cents IS NOT DISTINCT FROM OLD.total_amount_cents
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

    -- A posted invoice may legitimately survive an order cancellation. Keep
    -- payment state, due dates, and other accounting metadata maintainable,
    -- while forbidding a draft from being activated or any source/amount rewrite.
    v_existing_accounting_update :=
      OLD.status IN ('posted', 'overdue', 'paid')
      AND NEW.status IN ('posted', 'overdue', 'paid')
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_amount_cents IS NOT DISTINCT FROM OLD.total_amount_cents
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;
  END IF;

  -- Exact historical exception: only the canonical recovery writer/poster may
  -- touch a matching completed-delivery invoice on a soft-deleted, otherwise
  -- fulfilled order. Cancelled and voided orders never receive this bypass.
  IF v_order_deleted_at IS NOT NULL
     AND v_order_status IN ('fulfilled', 'partially_fulfilled')
     AND v_valid_completed_delivery
     AND auth.uid() IS NOT NULL
     AND (
       (TG_OP = 'INSERT' AND v_has_writer_capability)
       OR (TG_OP = 'UPDATE' AND (v_has_writer_capability OR v_has_poster_capability))
     ) THEN
    RETURN NEW;
  END IF;

  IF v_order_status IN ('cancelled', 'voided') OR v_order_deleted_at IS NOT NULL THEN
    IF v_canonical_cancel_cleanup
       OR v_canonical_void_cleanup
       OR v_canonical_delete_cleanup
       OR v_existing_accounting_update THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot attach or update a nonterminal invoice on cancelled, voided, or deleted order %',
      COALESCE(v_order_number, NEW.order_id::text);
  END IF;

  RETURN NEW;
END;
$function$;

DO $postflight$
BEGIN
  IF to_regclass('pg_temp.split_invoice_lineage_tx') IS NULL THEN
    RAISE EXCEPTION 'SPLIT_INVOICE_LINEAGE_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.split_invoice_lineage_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'SPLIT_INVOICE_LINEAGE_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF to_regprocedure('public.guard_invoice_terminal_order()')::oid
       IS DISTINCT FROM (SELECT guard_oid FROM pg_temp.split_invoice_lineage_tx) THEN
    RAISE EXCEPTION 'POSTFLIGHT_INVOICE_LINEAGE_IDENTITY: the replace must preserve the function OID';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'guard_invoice_terminal_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'trigger'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) = ''
        AND md5(replace(p.prosrc, chr(13), '')) = '3ce8e2202d902ed90ba3370dfc829e47'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
        AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.guard_invoice_terminal_order()')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_INVOICE_LINEAGE_GUARD_CONTRACT: guard_invoice_terminal_order body, signature or access drifted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'trg_guard_invoice_terminal_order'
       AND t.tgrelid = 'public.invoices'::regclass
       AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER trg_guard_invoice_terminal_order BEFORE INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_invoice_terminal_order()'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_INVOICE_LINEAGE_TRIGGER: trg_guard_invoice_terminal_order changed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'require_split_invoice_creation_claim' AND t.tgrelid = 'public.invoices'::regclass AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER require_split_invoice_creation_claim BEFORE INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION require_split_invoice_creation_claim()'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'guard_split_invoice_provenance_identity' AND t.tgrelid = 'public.invoices'::regclass AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER guard_split_invoice_provenance_identity BEFORE DELETE OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_split_invoice_provenance_identity()'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_INVOICE_TRIGGER: the split creation-claim or provenance-identity trigger changed';
  END IF;
  -- Nothing else moved.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.require_split_invoice_creation_claim()', 'e73daae16c5ff5432644060f2b34f925'),
        ('public.guard_split_invoice_provenance_identity()', '639875d6641556c78c25d633c67821f1'),
        ('public.create_split_invoices_from_order(uuid,uuid,text,text)', '0f1e36e8536fc56f08fcf6071ea76da8'),
        ('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)', 'f671f1a3f5406cff52aedd8a5fb40b31')
      ) AS pin(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_DEPENDENCY_DRIFT: a split-invoice function other than the guard changed';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: a governed split invoice may name a field owner other than the order''s customer, only inside its creation claim or under its provenance';
END
$postflight$;
