-- Written 2026-10-27. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 996). Stamp and row are PLACEHOLDERS from Taha's
-- fork: the CRX Coordinator session should assign the final stamp/row. Lands after
-- 20261027070000. Re-read the live ledger first.
--
-- idempotency-body-check: exempt -- this file changes no function body; it only changes table grants.
--
-- WHAT: stock tables take writes only through the stock functions (Mason 2026-10-26: "stock history
--   never takes bypass entries"). Every real stock movement already goes through SECURITY DEFINER
--   RPCs (adjust_inventory, receiving, delivery, draw-down, cycle counts), which run as postgres and
--   are unaffected. This removes INSERT/UPDATE/DELETE/TRUNCATE on inventory_transactions and inventory
--   from PUBLIC, anon and authenticated, and gives authenticated back UPDATE on only the columns the
--   Stock screen's bulk edit sets (reorder_point, min_stock_level, updated_at; RLS policy
--   inventory_update still limits it to admins).
--
-- NOT CHANGED: SELECT on both tables; every policy (inv_tx_insert, inventory_insert and
--   inventory_delete become unreachable without the grant and are left in place); triggers; every
--   function; postgres, service_role and metabase_ro grants; every row.
--
-- CALLERS (checked 2026-10-27 on main fe258c2f):
--   src/: the only table write is src/pages/InventoryPage.tsx handleBulkSave, which updates
--   inventory with reorder_point / min_stock_level (BULK_EDITABLE_INVENTORY_FIELDS) + updated_at and
--   keeps working. Every other src/ use of either table is a SELECT. No Edge Function writes them
--   with the user's token. DB: no SECURITY INVOKER function or trigger writes either table (both
--   inventory triggers are SECURITY DEFINER).
--
-- EVIDENCE: read on a local replay of main d5fd2bf8 (no live access from the fork); Mason to re-read
--   live before applying. authenticated held arwdDxtm on inventory_transactions and arwdxtm on
--   inventory; anon held rm on both.
--
-- ROLLBACK: GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.inventory_transactions TO authenticated;
--   GRANT INSERT, UPDATE, DELETE ON public.inventory TO authenticated; (Mason only; re-opens the
--   direct writes.) No data to restore.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE stock_tables_governed_writes_only_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.stock_tables_governed_writes_only_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.stock_tables_governed_writes_only_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.inventory_transactions', 'INSERT')
     AND NOT has_table_privilege('authenticated', 'public.inventory', 'INSERT') THEN
    RAISE EXCEPTION 'STOCK_TABLES_ALREADY_LOCKED: this migration has already run';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.inventory_transactions', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.inventory', 'UPDATE')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'inventory'
                     AND policyname = 'inventory_update' AND qual = 'is_admin()' AND with_check = 'is_admin()') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: inventory / inventory_transactions grants or the inventory_update policy are not as read 2026-10-27';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.inventory_transactions', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.inventory', 'UPDATE') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: service_role is expected to keep its writes';
  END IF;
END;
$preflight$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.inventory_transactions FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.inventory FROM PUBLIC, anon, authenticated;
GRANT UPDATE (reorder_point, min_stock_level, updated_at) ON public.inventory TO authenticated;

DO $postflight$
DECLARE
  v_role text;
  v_priv text;
BEGIN
  IF to_regclass('pg_temp.stock_tables_governed_writes_only_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.stock_tables_governed_writes_only_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF has_table_privilege(v_role, 'public.inventory_transactions', v_priv)
         OR has_table_privilege(v_role, 'public.inventory', v_priv) THEN
        RAISE EXCEPTION 'POSTFLIGHT_FAIL: % still holds % on a stock table', v_role, v_priv;
      END IF;
    END LOOP;
  END LOOP;
  IF has_column_privilege('authenticated', 'public.inventory', 'quantity_available', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.inventory', 'quantity_prebooked', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.inventory', 'reorder_point', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.inventory', 'min_stock_level', 'UPDATE')
     OR NOT has_column_privilege('authenticated', 'public.inventory', 'updated_at', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.inventory', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.inventory_transactions', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.inventory_transactions', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.inventory', 'UPDATE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: stock table grants are not as expected';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: stock moves only through the governed RPCs; the bulk edit keeps reorder_point / min_stock_level';
END;
$postflight$;
