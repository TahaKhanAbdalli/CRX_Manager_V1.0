-- =====================================================================================================
-- 20261021141000_po_cost_columns_admin_only.sql
--
-- WHAT: purchase-order cost becomes unreadable through the Data API for everyone but the owner roles.
--   The four cost columns -- purchase_order_items.unit_cost / unit_cost_cents and
--   purchase_orders.total_cost / total_cost_cents -- are carved out of the SELECT and REFERENCES
--   grants of `authenticated` and the SELECT grant of `anon`. Every other column stays readable
--   exactly as today; row security (po_select / po_items_select: admins and sales reps) is unchanged.
--   Admins keep reading cost through get_admin_cost_fields (SECURITY DEFINER, admin-only,
--   20261019230000), which every purchase-order screen already uses; no screen reads a cost column
--   directly (src/lib/costFields.ts, guarded by costFields.test.ts).
--
-- WHY (Mason, 2026-10-20, "Add the lock now"): hiding cost in the screens does not stop a rep from
--   asking the Data API for it, and since 20261021140000 a rep's new line holds the product's catalog
--   cost. Sol (gate) and the Codex PR review both blocked 20261021140000 on this. This is the
--   purchase-order part of the cost column lock (Goal 1 part 3, step 3); the other tables' lock is
--   still step 3's.
--
-- DEPENDS ON 20261021140000 (adds purchase_order_items.cost_needs_review, granted here). Apply it first.
--
-- HOW: a table-level grant implies every column and REVOKE (col) cannot subtract from it, so each
--   privilege is revoked table-wide and re-granted on the explicit non-cost list. Each privilege carries
--   its OWN column list: `GRANT SELECT, REFERENCES (cols)` would column-scope only REFERENCES and leave
--   SELECT table-wide (the 20260729015706 trap). Live ACL read 2026-10-20 on both tables:
--   authenticated=rxtm, anon=rm, no column ACLs. INSERT/UPDATE/DELETE are not held by either API role
--   (writes go through SECURITY DEFINER functions), and TRIGGER/MAINTAIN are not column privileges, so
--   they are left alone. metabase_ro (read-only reporting role, not reachable through the Data API)
--   keeps its table-level SELECT.
--
-- STANDING CONSEQUENCE: once the grant is an explicit list, a NEW column on either table is invisible
--   to `authenticated` and `anon` until a migration grants it. Any ADD COLUMN on these tables must ship
--   with a GRANT SELECT (and REFERENCES for authenticated) for it -- unless it is another cost field.
--   The preflight below refuses to run if the column set is not the one this list was written for.
--
-- ROLLBACK (re-opens cost to reps; only with Mason's approval):
--   GRANT SELECT, REFERENCES ON public.purchase_orders, public.purchase_order_items TO authenticated;
--   GRANT SELECT ON public.purchase_orders, public.purchase_order_items TO anon;
--
-- Proof: node scripts/smoke/prove-po-cost-admin-only-and-corrections-real-schema.mjs
-- =====================================================================================================

SET LOCAL lock_timeout = '10s';

DO $preflight$
DECLARE
  v_items text;
  v_pos text;
BEGIN
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_items
    FROM pg_attribute WHERE attrelid = 'public.purchase_order_items'::regclass AND attnum > 0 AND NOT attisdropped;
  SELECT string_agg(attname, ',' ORDER BY attname) INTO v_pos
    FROM pg_attribute WHERE attrelid = 'public.purchase_orders'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_items IS DISTINCT FROM 'cost_needs_review,cost_provenance,cost_snapshot_at,id,inventory_unit_snapshot,'
       'inventory_units_per_supplier_unit_snapshot,notes,product_id,product_name,product_supplier_link_id,'
       'purchase_order_id,quantity_ordered,quantity_received,supplier_price_observation_id,unit_cost,'
       'unit_cost_cents,unit_size' THEN
    RAISE EXCEPTION 'PO_COST_LOCK_PREFLIGHT: purchase_order_items columns are not the ones this grant list covers (apply 20261021140000 first, or re-read the columns): %', v_items;
  END IF;
  IF v_pos IS DISTINCT FROM 'cancel_reason,cancelled_at,cancelled_by,created_at,created_by,expected_delivery_date,'
       'id,notes,po_number,status,submitted_date,total_cost,total_cost_cents,updated_at,vendor' THEN
    RAISE EXCEPTION 'PO_COST_LOCK_PREFLIGHT: purchase_orders columns are not the ones this grant list covers: %', v_pos;
  END IF;
  IF to_regprocedure('public.get_admin_cost_fields(text,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'PO_COST_LOCK_PREFLIGHT: get_admin_cost_fields(text, uuid[]) is missing; admins would lose purchase-order cost';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------------
-- purchase_order_items: everything but unit_cost and unit_cost_cents.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT, REFERENCES ON public.purchase_order_items FROM authenticated;
REVOKE SELECT ON public.purchase_order_items FROM anon;

GRANT
  SELECT (id, purchase_order_id, product_id, quantity_ordered, quantity_received, unit_size, notes, product_name,
          product_supplier_link_id, supplier_price_observation_id, inventory_units_per_supplier_unit_snapshot,
          cost_provenance, cost_snapshot_at, inventory_unit_snapshot, cost_needs_review),
  REFERENCES (id, purchase_order_id, product_id, quantity_ordered, quantity_received, unit_size, notes, product_name,
          product_supplier_link_id, supplier_price_observation_id, inventory_units_per_supplier_unit_snapshot,
          cost_provenance, cost_snapshot_at, inventory_unit_snapshot, cost_needs_review)
ON public.purchase_order_items TO authenticated;

GRANT SELECT (id, purchase_order_id, product_id, quantity_ordered, quantity_received, unit_size, notes, product_name,
              product_supplier_link_id, supplier_price_observation_id, inventory_units_per_supplier_unit_snapshot,
              cost_provenance, cost_snapshot_at, inventory_unit_snapshot, cost_needs_review)
ON public.purchase_order_items TO anon;

-- ---------------------------------------------------------------------------------------------------
-- purchase_orders: everything but total_cost and total_cost_cents.
-- ---------------------------------------------------------------------------------------------------
REVOKE SELECT, REFERENCES ON public.purchase_orders FROM authenticated;
REVOKE SELECT ON public.purchase_orders FROM anon;

GRANT
  SELECT (id, po_number, vendor, status, submitted_date, expected_delivery_date, notes, created_by, created_at,
          updated_at, cancelled_at, cancelled_by, cancel_reason),
  REFERENCES (id, po_number, vendor, status, submitted_date, expected_delivery_date, notes, created_by, created_at,
          updated_at, cancelled_at, cancelled_by, cancel_reason)
ON public.purchase_orders TO authenticated;

GRANT SELECT (id, po_number, vendor, status, submitted_date, expected_delivery_date, notes, created_by, created_at,
              updated_at, cancelled_at, cancelled_by, cancel_reason)
ON public.purchase_orders TO anon;

-- ---------------------------------------------------------------------------------------------------
-- VERIFY: cost columns closed, every other column open, for both API roles.
-- ---------------------------------------------------------------------------------------------------
DO $verify$
DECLARE
  r record;
  v_cost boolean;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tbl, a.attname, role.name AS rolname, priv.name AS privname
      FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      CROSS JOIN (VALUES ('authenticated'), ('anon')) AS role(name)
      CROSS JOIN (VALUES ('SELECT'), ('REFERENCES')) AS priv(name)
     WHERE c.oid IN ('public.purchase_orders'::regclass, 'public.purchase_order_items'::regclass)
       AND NOT (role.name = 'anon' AND priv.name = 'REFERENCES')
  LOOP
    v_cost := r.attname IN ('unit_cost', 'unit_cost_cents', 'total_cost', 'total_cost_cents');
    IF has_column_privilege(r.rolname, r.tbl, r.attname, r.privname) = v_cost THEN
      RAISE EXCEPTION 'PO_COST_LOCK_VERIFY: % % on %.% is %', r.rolname, r.privname, r.tbl, r.attname,
        CASE WHEN v_cost THEN 'still granted' ELSE 'not granted' END;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.purchase_order_items', 'SELECT')
     OR has_table_privilege('authenticated', 'public.purchase_orders', 'SELECT')
     OR has_table_privilege('anon', 'public.purchase_order_items', 'SELECT')
     OR has_table_privilege('anon', 'public.purchase_orders', 'SELECT') THEN
    RAISE EXCEPTION 'PO_COST_LOCK_VERIFY: a table-level SELECT survived';
  END IF;
  IF has_table_privilege('authenticated', 'public.purchase_order_items', 'INSERT')
     OR has_table_privilege('authenticated', 'public.purchase_order_items', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.purchase_orders', 'INSERT')
     OR has_table_privilege('authenticated', 'public.purchase_orders', 'UPDATE') THEN
    RAISE EXCEPTION 'PO_COST_LOCK_VERIFY: authenticated can write a purchase-order table directly';
  END IF;
END
$verify$;
