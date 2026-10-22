-- Written 2026-10-20. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- idempotency-body-check: exempt -- set_purchase_order_item_costs requires a key and binds its
--   receipt to the caller and request (check_idempotency_intent, save_idempotency,
--   _bind_replay_receipt_20261015: the start_and_complete_delivery pattern). The two new trigger
--   functions are not callable. The hook only recognises check_idempotency().
--
-- WHAT: purchase-order cost becomes admin-only, with a cost history and a governed way to correct a
--   received cost (Mason, 2026-10-20, "Option B"; the purchase-order project KNOWN_ISSUES.md named
--   after Sol's three rounds on PR #965). Before this, a rep could enter and edit PO cost; any cost a
--   line had when it was first received was locked (save_purchase_order's
--   RECEIVED_PO_LINE_IMMUTABLE, and the cost-snapshot trigger on the supplier-cost-basis products);
--   the only fix was reversing the receipt, which takes the stock back out of inventory; and nothing
--   recorded who changed a cost, from what, to what, or why.
--
--   1. purchase_order_items.cost_needs_review (boolean, NOT NULL, default false: every existing line
--      was costed by an admin, live read 2026-10-20: all 34 purchase orders were created by admins and
--      no rep has ever saved one). TRUE means "a rep's line: the cost is the catalog cost and an
--      admin has not confirmed it". Readable by reps (it is not a cost).
--
--   2. Trigger trigger_a_po_item_rep_cost (BEFORE INSERT OR UPDATE OF unit_cost, product_id,
--      unit_size, cost_needs_review), the one rule every writer passes through:
--        * a signed-in NON-admin never sets cost: a new line, or a line switched to another product,
--          takes the product's catalog cost (products.current_cost, whole cents; 0 if none) and is
--          flagged for review; any other change keeps the stored cost (a unit change is flagged);
--        * an admin (or the database owner, auth.uid() NULL: migrations, provers) changing the
--          cost clears the flag (the change is logged); an admin product or unit change that keeps
--          the cost leaves the flag as it was, so a line is never confirmed without a record;
--        * the flag cannot be cleared without changing the cost except by
--          set_purchase_order_item_costs ("confirm"), which names the line in a transaction-local
--          setting, crx.po_cost_set_item.
--      It sorts before trigger_capture_purchase_order_item_cost_snapshot (BEFORE triggers fire in
--      name order), so the snapshot trigger sees the cost this trigger settled.
--
--   3. purchase_order_item_cost_changes: append-only history (RLS on; admins read; no API role may
--      write, update or delete; a trigger refuses UPDATE and DELETE even for the owner's API paths).
--      Trigger trigger_po_item_cost_change_log (AFTER INSERT OR UPDATE OF unit_cost, product_id) writes one row
--      per real cost change: who, when, old and new cents, the quantity already received, the
--      source (entered / edited by an admin's PO save, catalog_default for a rep's line,
--      set_by_admin from the function below, with its reason), and the reason. A confirm without a
--      change is written by the function as source "confirmed". No foreign keys: the history
--      outlives a deleted draft line.
--
--   4. capture_purchase_order_item_cost_snapshot gains one branch: an UPDATE that set_purchase_order_
--      item_costs named in crx.po_cost_set_item and that changes ONLY unit_cost on a RECEIVED line
--      is allowed (also on the supplier-cost-basis products, where it was refused). The unit
--      conversion snapshot stays (the unit did not change); the supplier link and observation ids
--      are cleared (they described the old cost) and provenance becomes 'manual' at now(). The rest
--      of the body is the live one, unchanged (pinned by md5 below).
--
--   5. NEW set_purchase_order_item_costs(p_po_id, p_items [{id, unit_cost_cents}], p_reason,
--      p_performed_by, p_idempotency_key), admin-only: sets or confirms unit cost on any line of a
--      purchase order that is not cancelled, INCLUDING received and fully received lines. It changes
--      only the cost and the purchase order's total: never a quantity, inventory, a receiving
--      record or the product's catalog cost (Mason, 2026-10-20: catalog cost changes only through
--      the pricing workbook). A reason (1-500 characters) is required when any line it changes has
--      been received (Mason, 2026-10-20). Same cost on a flagged line = confirm. A cost change is
--      refused (PO_COST_BASIS_EVIDENCE_IN_USE) on a line that supplier cost-basis evidence cites as
--      its actual purchase (live read 2026-10-20: none). Each cost must be a JSON number of cents.
--      Key required, bound to the caller and request; takes save_purchase_order's advisory lock
--      (73492009) first.
--
--   Inventory value and margins do not use purchase-order cost (live read 2026-10-20: inventory
--   value, the inventory cost report and the dashboard's floor inventory are quantity x
--   products.current_cost; sales margins use the catalog cost snapshots), so correcting a received
--   line's cost changes no inventory value. It does change the purchase order's total, the
--   dashboard's open purchase-order value, chemical history Purchase rows, Quick Receive's cheaper
--   line, and the purchase evidence admins read on the pricing screens -- the reason it exists.
--
--   Whole-cent CHECKs: set_purchase_order_item_costs and the rep trigger write the legacy
--   numeric-dollar columns purchase_order_items.unit_cost and purchase_orders.total_cost, so each
--   gains the house finite whole-cent CHECK (docs/workflows/SAFE_DEVELOPMENT_RULES.md: a new writer
--   uses the full predicate) ALONGSIDE its existing 2026-08-19 "mirror" CHECK
--   (*_whole_cents: >= 0 and equal to the generated cents column), which stays. The two overlap on
--   purpose; the mirror alone was the settled exception for the old writers. Live read 2026-10-20:
--   0 of 194 lines and 0 of 34 purchase orders would fail. Nothing is dropped.
--
-- save_purchase_order: section 6 replaces only its thin wrapper (same signature, same advisory
--   lock), which now strips unit_cost/unit_cost_cents from a non-admin's items before calling the
--   unchanged _section9_save_purchase_order_serialized. The app also stops sending cost for a
--   non-admin; any cost that still reaches a line is overruled by the trigger. The column
--   REVOKE (cost step 3) is separate. Once this is live, step 3 MUST also revoke the purchase-order
--   cost columns (purchase_order_items.unit_cost/unit_cost_cents, purchase_orders.total_cost/
--   total_cost_cents): a rep's line now holds the catalog cost, so leaving them readable would let a
--   rep read products.current_cost through a throwaway PO line after current_cost is locked.
--
-- DEPENDS ON cost step 2 (20261019230000, applied live 2026-10-20 19:36 UTC, ledger version
--   20261020193610): it calls that file's _cost_step2_try_uuid(text), pinned below; the preflight
--   refuses the apply if it is missing. The screens in this PR also need step 2's
--   get_admin_cost_fields. Re-read the live ledger before applying; this sorts above it.
--
-- caller-analysis: set_purchase_order_item_costs :: NEW; PurchaseOrderDetail.tsx (admin only)
-- caller-analysis: save_purchase_order :: wrapper strips a non-admin's item cost, inner body unchanged; NewPurchaseOrder.tsx, PurchaseOrderDetail.tsx, BulkPOImport.tsx now send no cost for a non-admin
--
-- GRANTS: set_purchase_order_item_costs EXECUTE to authenticated only (revoked from PUBLIC, anon,
--   service_role); SECURITY DEFINER, search_path = public, pg_temp. The trigger functions are
--   executable by no API role. The history table: SELECT to authenticated (RLS: admins only),
--   nothing else to any API role.
--
-- ROLLBACK (no data loss beyond the history rows written since):
--   DROP FUNCTION public.set_purchase_order_item_costs(uuid, jsonb, text, uuid, text);
--   DROP TRIGGER trigger_a_po_item_rep_cost ON public.purchase_order_items;
--   DROP TRIGGER trigger_po_item_cost_change_log ON public.purchase_order_items;
--   DROP FUNCTION public._po_item_rep_cost(), public._po_item_cost_change_log();
--   DROP TABLE public.purchase_order_item_cost_changes;   -- after exporting it if it matters
--   DROP FUNCTION public._po_item_cost_changes_append_only();
--   ALTER TABLE public.purchase_order_items DROP COLUMN cost_needs_review;
--   ALTER TABLE public.purchase_order_items DROP CONSTRAINT purchase_order_items_unit_cost_whole_cents_chk;
--   ALTER TABLE public.purchase_orders DROP CONSTRAINT purchase_orders_total_cost_whole_cents_chk;
--   and re-create capture_purchase_order_item_cost_snapshot from
--   20260722080226_lock_received_po_cost_snapshot_across_product_reassignment.sql (its live body),
--   and CREATE OR REPLACE save_purchase_order from 20260726190515_section9_po_ap_high_remediation.sql
--   (the wrapper that takes advisory lock 73492009 and passes p_items through unchanged).

SET LOCAL lock_timeout = '10s';

-- PREFLIGHT: the bodies this file replaces or relies on are exactly the ones read live on
-- 2026-10-20 (md5 of prosrc without carriage returns), and nothing it creates exists yet.
DO $preflight$
DECLARE
  r record;
  v_md5 text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- replaced below (only the correction branch is added)
      ('public.capture_purchase_order_item_cost_snapshot()', 'd898f248b20cbe217c6a3ad7a277bae8'),
      -- hydrates a line's stored cost when a request omits unit_cost/unit_cost_cents, and after the
      -- write recomputes purchase_orders.total_cost from the STORED lines -- which is what keeps a
      -- rep's PO total equal to the catalog costs the rep trigger writes (vendor bills read it)
      ('public._save_purchase_order_atomic_number_impl(uuid,jsonb,jsonb,uuid,text)', 'ebc897c7df1430fa3b6d828f2b431cd2'),
      -- refuses a changed cost on a received line (RECEIVED_PO_LINE_IMMUTABLE)
      ('public._save_purchase_order_cost_input_impl(uuid,jsonb,jsonb,uuid,text)', '6fa0f26553e3a562ca08e809b82aaa68'),
      ('public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)', 'd6161fc6c0c0402bdead9235d5466d5f'),
      ('public.is_admin()', 'f76bf61116c3bd52bd9c6ea125079b73'),
      ('public.require_admin()', '83dbda095d67a37031d5cd093a605a78'),
      ('public.check_idempotency_intent(text,text,uuid,text)', 'edc73be809069669e8441eba7acf443d'),
      ('public.save_idempotency(text,text,jsonb)', 'f600171c426e48c995f204c4dac3ff8b'),
      ('public._bind_replay_receipt_20261015(text,text,text)', '722ddd3b5d9174c598735cb321088f73'),
      ('public._replay_fingerprint_20261015(jsonb)', '68d5c0c62579349ced47c89e6b65ccaf'),
      ('public._purchase_order_item_unit_cost_cents(jsonb)', '0fa4a7fee34fc8d76ef605e44a0bebfa'),
      ('public._cost_step2_try_uuid(text)', '12ea72c00fcf4de75309060436f082b5'),
      ('public._supplier_cost_basis_enabled_for_product(uuid)', '6de9259b699ea2c8642cf8914b3590ac')
    ) AS v(sig, md5)
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'PO_COST_PREFLIGHT: % is missing', r.sig;
    END IF;
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_md5 IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'PO_COST_PREFLIGHT: % changed since 2026-10-20 (md5 %); re-read it before applying', r.sig, v_md5;
    END IF;
  END LOOP;

  -- By name, every overload: to_regproc() is NULL when a name has several.
  IF to_regclass('public.purchase_order_item_cost_changes') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace
                   AND p.proname IN ('set_purchase_order_item_costs', '_po_item_rep_cost',
                                     '_po_item_cost_change_log', '_po_item_cost_changes_append_only'))
     OR EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'purchase_order_items'
                   AND column_name = 'cost_needs_review') THEN
    RAISE EXCEPTION 'PO_COST_PREFLIGHT: an object this migration creates already exists';
  END IF;

  -- Exactly the two triggers read live 2026-10-20 sit on purchase_order_items.
  IF (SELECT array_agg(tgname::text ORDER BY tgname) FROM pg_trigger
       WHERE tgrelid = 'public.purchase_order_items'::regclass AND NOT tgisinternal)
     IS DISTINCT FROM ARRAY['trg_po_items_recompute_on_order', 'trigger_capture_purchase_order_item_cost_snapshot'] THEN
    RAISE EXCEPTION 'PO_COST_PREFLIGHT: the triggers on purchase_order_items changed since 2026-10-20';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- Whole-cent CHECKs on the two legacy numeric-dollar columns written here.
-- ---------------------------------------------------------------------------
ALTER TABLE public.purchase_order_items
  ADD CONSTRAINT purchase_order_items_unit_cost_whole_cents_chk
  CHECK (unit_cost IS NULL OR (unit_cost = ROUND(unit_cost, 2) AND unit_cost > '-Infinity' AND unit_cost < 'Infinity'
    AND unit_cost >= 0
    AND unit_cost = unit_cost_cents::numeric / 100.0));

ALTER TABLE public.purchase_orders
  ADD CONSTRAINT purchase_orders_total_cost_whole_cents_chk
  CHECK (total_cost IS NULL OR (total_cost = ROUND(total_cost, 2) AND total_cost > '-Infinity' AND total_cost < 'Infinity'
    AND total_cost >= 0
    AND total_cost = total_cost_cents::numeric / 100.0));

-- ---------------------------------------------------------------------------
-- 1. The review flag.
-- ---------------------------------------------------------------------------
ALTER TABLE public.purchase_order_items
  ADD COLUMN cost_needs_review boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.purchase_order_items.cost_needs_review IS
  'TRUE: a non-admin''s line; its unit cost is the catalog cost and an admin has not confirmed it (set_purchase_order_item_costs). Maintained by trigger_a_po_item_rep_cost.';

-- ---------------------------------------------------------------------------
-- 3. The cost history (created before the triggers that write it).
-- ---------------------------------------------------------------------------
CREATE TABLE public.purchase_order_item_cost_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL,
  purchase_order_item_id uuid NOT NULL,
  product_id uuid,
  old_unit_cost_cents bigint,
  new_unit_cost_cents bigint NOT NULL,
  quantity_received_at_change numeric NOT NULL DEFAULT 0,
  source text NOT NULL,
  reason text,
  changed_by uuid,
  -- clock_timestamp, not now(): several changes in one transaction keep their real order.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT po_item_cost_changes_source_check
    CHECK (source IN ('entered', 'edited', 'catalog_default', 'set_by_admin', 'confirmed')),
  CONSTRAINT po_item_cost_changes_cents_check
    CHECK (new_unit_cost_cents >= 0 AND (old_unit_cost_cents IS NULL OR old_unit_cost_cents >= 0)),
  CONSTRAINT po_item_cost_changes_reason_length
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  -- A change an admin makes to a received line must say why (Mason, 2026-10-20).
  CONSTRAINT po_item_cost_changes_received_reason
    CHECK (source <> 'set_by_admin' OR quantity_received_at_change = 0 OR reason IS NOT NULL)
);

COMMENT ON TABLE public.purchase_order_item_cost_changes IS
  'Append-only history of purchase-order line unit cost: every change (and every admin confirm) with who, when, old/new cents, quantity received and reason. Admin-read only. No updated_at: rows never change.';

CREATE INDEX idx_po_item_cost_changes_item ON public.purchase_order_item_cost_changes (purchase_order_item_id, created_at);
CREATE INDEX idx_po_item_cost_changes_po ON public.purchase_order_item_cost_changes (purchase_order_id, created_at);

ALTER TABLE public.purchase_order_item_cost_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.purchase_order_item_cost_changes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.purchase_order_item_cost_changes TO authenticated;

-- Purchase cost is admin-only (Mason, 2026-10-15 and 2026-10-20).
CREATE POLICY po_item_cost_changes_admin_select ON public.purchase_order_item_cost_changes
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

CREATE OR REPLACE FUNCTION public._po_item_cost_changes_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'PO_COST_HISTORY_APPEND_ONLY: purchase-order cost history cannot be changed or deleted';
END;
$function$;
REVOKE ALL ON FUNCTION public._po_item_cost_changes_append_only() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trigger_po_item_cost_changes_append_only
  BEFORE UPDATE OR DELETE ON public.purchase_order_item_cost_changes
  FOR EACH ROW EXECUTE FUNCTION public._po_item_cost_changes_append_only();

CREATE TRIGGER trigger_po_item_cost_changes_no_truncate
  BEFORE TRUNCATE ON public.purchase_order_item_cost_changes
  FOR EACH STATEMENT EXECUTE FUNCTION public._po_item_cost_changes_append_only();

-- ---------------------------------------------------------------------------
-- 2. The rule every writer passes through.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._po_item_rep_cost()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  -- Anyone who is not an active admin, except the database owner connected directly (no JWT:
  -- migrations, provers), who is treated as an admin. A request with no user that arrives through
  -- the API (session_user authenticator) is treated as a rep: fail closed.
  v_rep boolean := NOT public.is_admin()
    AND (auth.uid() IS NOT NULL OR session_user NOT IN ('postgres', 'supabase_admin'));
  v_catalog_cents bigint;
BEGIN
  IF v_rep AND (TG_OP = 'INSERT' OR NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    SELECT round(COALESCE(p.current_cost, 0) * 100)::bigint INTO v_catalog_cents
      FROM public.products p WHERE p.id = NEW.product_id;
    NEW.unit_cost := COALESCE(v_catalog_cents, 0)::numeric / 100.0;
    NEW.cost_needs_review := true;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.cost_needs_review := false;
    RETURN NEW;
  END IF;

  IF v_rep THEN
    -- A rep never changes cost; a unit change makes the stored cost questionable.
    NEW.unit_cost := OLD.unit_cost;
    NEW.cost_needs_review := OLD.cost_needs_review OR NEW.unit_size IS DISTINCT FROM OLD.unit_size;
  ELSIF NEW.unit_cost IS DISTINCT FROM OLD.unit_cost THEN
    -- An admin changed the cost: the line's cost is the admin's, and the change is logged.
    NEW.cost_needs_review := false;
  ELSIF NEW.cost_needs_review IS DISTINCT FROM OLD.cost_needs_review
     AND current_setting('crx.po_cost_set_item', true) IS DISTINCT FROM NEW.id::text THEN
    -- Only set_purchase_order_item_costs confirms a line without changing its cost.
    NEW.cost_needs_review := OLD.cost_needs_review;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public._po_item_rep_cost() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trigger_a_po_item_rep_cost
  BEFORE INSERT OR UPDATE OF unit_cost, product_id, unit_size, cost_needs_review
  ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public._po_item_rep_cost();

CREATE OR REPLACE FUNCTION public._po_item_cost_change_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_set boolean := current_setting('crx.po_cost_set_item', true) IS NOT DISTINCT FROM NEW.id::text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.unit_cost IS NOT DISTINCT FROM OLD.unit_cost THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.purchase_order_item_cost_changes (
    purchase_order_id, purchase_order_item_id, product_id,
    old_unit_cost_cents, new_unit_cost_cents, quantity_received_at_change,
    source, reason, changed_by
  ) VALUES (
    NEW.purchase_order_id, NEW.id, NEW.product_id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.unit_cost_cents END,
    NEW.unit_cost_cents,
    COALESCE(CASE WHEN TG_OP = 'UPDATE' THEN OLD.quantity_received END, NEW.quantity_received, 0),
    CASE
      WHEN v_set THEN 'set_by_admin'
      WHEN NEW.cost_needs_review THEN 'catalog_default'
      WHEN TG_OP = 'INSERT' THEN 'entered'
      ELSE 'edited'
    END,
    CASE WHEN v_set THEN NULLIF(current_setting('crx.po_cost_set_reason', true), '') END,
    auth.uid()
  );
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public._po_item_cost_change_log() FROM PUBLIC, anon, authenticated, service_role;

-- OF product_id too: a column trigger fires on the columns the UPDATE names, not on a change a
-- BEFORE trigger makes, and the rep trigger re-prices a line whose product changes. The function
-- writes nothing when the cost did not change.
CREATE TRIGGER trigger_po_item_cost_change_log
  AFTER INSERT OR UPDATE OF unit_cost, product_id ON public.purchase_order_items
  FOR EACH ROW EXECUTE FUNCTION public._po_item_cost_change_log();

-- ---------------------------------------------------------------------------
-- 4. The cost-snapshot trigger: the live body plus the governed correction branch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.capture_purchase_order_item_cost_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inventory_unit text;
  v_phase2_enabled boolean;
BEGIN
  -- Governed correction (set_purchase_order_item_costs, 20261021140000): that function names the
  -- line in crx.po_cost_set_item and changes ONLY unit_cost. On a received line the conversion
  -- snapshot stays (the unit did not change); the supplier ids no longer describe the cost.
  IF TG_OP = 'UPDATE'
     AND COALESCE(OLD.quantity_received, 0) > 0
     AND current_setting('crx.po_cost_set_item', true) IS NOT DISTINCT FROM NEW.id::text
     AND NEW.unit_cost IS DISTINCT FROM OLD.unit_cost
     AND NEW.purchase_order_id IS NOT DISTINCT FROM OLD.purchase_order_id
     AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
     AND NEW.unit_size IS NOT DISTINCT FROM OLD.unit_size
     AND NEW.quantity_received IS NOT DISTINCT FROM OLD.quantity_received
     AND NEW.product_supplier_link_id IS NOT DISTINCT FROM OLD.product_supplier_link_id
     AND NEW.supplier_price_observation_id IS NOT DISTINCT FROM OLD.supplier_price_observation_id
     AND NEW.inventory_units_per_supplier_unit_snapshot IS NOT DISTINCT FROM
         OLD.inventory_units_per_supplier_unit_snapshot
     AND NEW.inventory_unit_snapshot IS NOT DISTINCT FROM OLD.inventory_unit_snapshot
     AND NEW.cost_provenance IS NOT DISTINCT FROM OLD.cost_provenance
     AND NEW.cost_snapshot_at IS NOT DISTINCT FROM OLD.cost_snapshot_at THEN
    NEW.product_supplier_link_id := NULL;
    NEW.supplier_price_observation_id := NULL;
    -- 'manual' only alongside a conversion snapshot, as every other writer sets it.
    IF OLD.inventory_units_per_supplier_unit_snapshot IS NOT NULL THEN
      NEW.cost_provenance := 'manual';
      NEW.cost_snapshot_at := now();
    ELSE
      NEW.cost_provenance := NULL;
      NEW.cost_snapshot_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  v_phase2_enabled := public._supplier_cost_basis_enabled_for_product(NEW.product_id);

  IF TG_OP = 'UPDATE' THEN
    v_phase2_enabled := v_phase2_enabled
      OR public._supplier_cost_basis_enabled_for_product(OLD.product_id);
  END IF;

  SELECT COALESCE(
    NULLIF(btrim(p.inventory_unit), ''),
    NULLIF(btrim(p.unit_size), '')
  ) INTO v_inventory_unit
  FROM public.products p
  WHERE p.id = NEW.product_id;

  IF TG_OP = 'INSERT' THEN
    -- Snapshot provenance is server-derived. Direct callers cannot preload a
    -- conversion factor on either an open or already-received line.
    NEW.product_supplier_link_id := NULL;
    NEW.supplier_price_observation_id := NULL;
    NEW.inventory_units_per_supplier_unit_snapshot := NULL;
    NEW.inventory_unit_snapshot := NULL;
    NEW.cost_provenance := NULL;
    NEW.cost_snapshot_at := NULL;

    IF NEW.quantity_received > 0
       AND NULLIF(btrim(NEW.unit_size), '') IS NOT NULL
       AND NULLIF(btrim(v_inventory_unit), '') IS NOT NULL
       AND lower(btrim(NEW.unit_size)) = lower(btrim(v_inventory_unit)) THEN
      NEW.inventory_units_per_supplier_unit_snapshot := 1;
      NEW.inventory_unit_snapshot := v_inventory_unit;
      NEW.cost_provenance := 'manual';
      NEW.cost_snapshot_at := now();
    END IF;

    RETURN NEW;
  END IF;

  IF OLD.quantity_received > 0 AND (
    NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.unit_cost IS DISTINCT FROM OLD.unit_cost
    OR NEW.unit_size IS DISTINCT FROM OLD.unit_size
    OR NEW.product_supplier_link_id IS DISTINCT FROM OLD.product_supplier_link_id
    OR NEW.supplier_price_observation_id IS DISTINCT FROM OLD.supplier_price_observation_id
    OR NEW.inventory_units_per_supplier_unit_snapshot IS DISTINCT FROM
       OLD.inventory_units_per_supplier_unit_snapshot
    OR NEW.inventory_unit_snapshot IS DISTINCT FROM OLD.inventory_unit_snapshot
    OR NEW.cost_provenance IS DISTINCT FROM OLD.cost_provenance
    OR NEW.cost_snapshot_at IS DISTINCT FROM OLD.cost_snapshot_at
  ) AND NOT COALESCE((
    current_setting('crx.cost_basis_backfill', true) = 'phase2'
    AND
    OLD.inventory_units_per_supplier_unit_snapshot IS NULL
    AND NEW.inventory_units_per_supplier_unit_snapshot = 1
    AND OLD.inventory_unit_snapshot IS NULL
    AND lower(btrim(NEW.inventory_unit_snapshot)) = lower(btrim(v_inventory_unit))
    AND NEW.purchase_order_id IS NOT DISTINCT FROM OLD.purchase_order_id
    AND NEW.product_id IS NOT DISTINCT FROM OLD.product_id
    AND NEW.unit_cost IS NOT DISTINCT FROM OLD.unit_cost
    AND NEW.unit_size IS NOT DISTINCT FROM OLD.unit_size
    AND NEW.product_supplier_link_id IS NOT DISTINCT FROM OLD.product_supplier_link_id
    AND NEW.supplier_price_observation_id IS NOT DISTINCT FROM OLD.supplier_price_observation_id
    AND NEW.cost_provenance IS NOT DISTINCT FROM COALESCE(OLD.cost_provenance, 'legacy')
    AND NEW.cost_snapshot_at IS NOT NULL
    AND NULLIF(btrim(NEW.unit_size), '') IS NOT NULL
    AND NULLIF(btrim(v_inventory_unit), '') IS NOT NULL
    AND lower(btrim(NEW.unit_size)) = lower(btrim(v_inventory_unit))
  ), false) THEN
    IF v_phase2_enabled THEN
      RAISE EXCEPTION 'RECEIVED_PO_COST_SNAPSHOT_IMMUTABLE';
    END IF;

    -- While Phase 2 is disabled, preserve the existing partially-received PO
    -- correction workflow but discard provenance that no longer describes the
    -- edited cost. A later governed receipt/selection must capture fresh facts.
    NEW.product_supplier_link_id := NULL;
    NEW.supplier_price_observation_id := NULL;
    NEW.inventory_units_per_supplier_unit_snapshot := NULL;
    NEW.inventory_unit_snapshot := NULL;
    NEW.cost_provenance := NULL;
    NEW.cost_snapshot_at := NULL;
  END IF;

  IF COALESCE(OLD.quantity_received, 0) <= 0 THEN
    -- An open line carries no trusted purchase evidence. Clear any direct
    -- caller input, including values pre-seeded on a first-receipt update.
    NEW.product_supplier_link_id := NULL;
    NEW.supplier_price_observation_id := NULL;
    NEW.inventory_units_per_supplier_unit_snapshot := NULL;
    NEW.inventory_unit_snapshot := NULL;
    NEW.cost_provenance := NULL;
    NEW.cost_snapshot_at := NULL;
  END IF;

  IF COALESCE(OLD.quantity_received, 0) <= 0
     AND NEW.quantity_received > 0 THEN
    IF NULLIF(btrim(NEW.unit_size), '') IS NOT NULL
       AND NULLIF(btrim(v_inventory_unit), '') IS NOT NULL
       AND lower(btrim(NEW.unit_size)) = lower(btrim(v_inventory_unit)) THEN
      NEW.inventory_units_per_supplier_unit_snapshot := 1;
      NEW.inventory_unit_snapshot := v_inventory_unit;
      NEW.cost_provenance := COALESCE(NEW.cost_provenance, 'manual');
      NEW.cost_snapshot_at := COALESCE(NEW.cost_snapshot_at, now());
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. set_purchase_order_item_costs: admin sets, corrects or confirms line cost.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.set_purchase_order_item_costs(
  p_po_id uuid,
  p_items jsonb,
  p_reason text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := NULLIF(btrim(p_reason), '');
  v_fingerprint text;
  v_replay jsonb;
  v_status text;
  v_po_number text;
  v_item jsonb;
  v_item_id uuid;
  v_cents bigint;
  v_line record;
  v_changed integer := 0;
  v_confirmed integer := 0;
  v_result jsonb;
  v_old_total bigint;
  v_new_total bigint;
  v_billed bigint;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: set_purchase_order_item_costs requires p_idempotency_key'
      USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()' USING ERRCODE = 'P0001';
  END IF;
  -- Purchase cost is admin-only (Mason, 2026-10-15 and 2026-10-20).
  PERFORM public.require_admin();

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'PO_ITEMS_REQUIRED';
  END IF;
  IF jsonb_array_length(p_items) > 500 THEN
    RAISE EXCEPTION 'PO_ITEMS_TOO_MANY: at most 500 lines at a time';
  END IF;
  -- Compared as uuids: the same line spelled in upper and lower case is one line.
  IF (SELECT count(*) <> count(DISTINCT public._cost_step2_try_uuid(e.value->>'id'))
             OR bool_or(public._cost_step2_try_uuid(e.value->>'id') IS NULL)
        FROM jsonb_array_elements(p_items) AS e(value)) THEN
    RAISE EXCEPTION 'PO_ITEM_ID_DUPLICATE: each line must appear once, by a valid id';
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'PO_COST_REASON_TOO_LONG: keep the reason to 500 characters';
  END IF;

  -- save_purchase_order's advisory lock, taken first as it takes it.
  PERFORM pg_advisory_xact_lock(73492009);

  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'po_id', p_po_id,
    'items', p_items,
    'reason', v_reason
  ));
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'set_purchase_order_item_costs', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- Item first, then parent PO: the receiving/reversal and cost-basis apply lock order, so a
  -- correction never deadlocks with them.
  PERFORM 1 FROM public.purchase_order_items poi
   WHERE poi.purchase_order_id = p_po_id ORDER BY poi.id FOR UPDATE;
  SELECT status, po_number, total_cost_cents INTO v_status, v_po_number, v_old_total
    FROM public.purchase_orders WHERE id = p_po_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase order not found: %', p_po_id;
  END IF;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION 'PO_CANCELLED: cannot change cost on a cancelled purchase order';
  END IF;

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_items) AS e(value)
  LOOP
    -- A JSON number: null or "" would otherwise read as no cost, which the parser treats as $0.
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_item->'unit_cost_cents') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'PO_UNIT_COST_REQUIRED';
    END IF;
    -- An integer: 10.5 cents is refused by name, never cast or rounded.
    IF (v_item->>'unit_cost_cents')::numeric IS DISTINCT FROM trunc((v_item->>'unit_cost_cents')::numeric) THEN
      RAISE EXCEPTION 'PO_UNIT_COST_FRACTIONAL_CENT: unit cost must resolve to whole cents'
        USING ERRCODE = '22003';
    END IF;
    v_item_id := public._cost_step2_try_uuid(v_item->>'id');
    -- Whole cents, not negative (the PO writer's own parser); cents only, never dollars.
    v_cents := public._purchase_order_item_unit_cost_cents(v_item - 'unit_cost');
    IF v_cents > 9007199254740991 THEN
      RAISE EXCEPTION 'PO_UNIT_COST_TOO_LARGE' USING ERRCODE = '22003';
    END IF;

    SELECT poi.id, poi.unit_cost_cents, poi.quantity_received, poi.cost_needs_review INTO v_line
      FROM public.purchase_order_items poi
     WHERE poi.id = v_item_id AND poi.purchase_order_id = p_po_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PO_ITEM_ID_NOT_IN_PURCHASE_ORDER';
    END IF;

    PERFORM set_config('crx.po_cost_set_item', v_item_id::text, true);
    PERFORM set_config('crx.po_cost_set_reason', COALESCE(v_reason, ''), true);

    IF v_line.unit_cost_cents IS NOT DISTINCT FROM v_cents THEN
      -- Same cost: on a rep's line this is the admin confirming the catalog cost.
      IF v_line.cost_needs_review THEN
        UPDATE public.purchase_order_items SET cost_needs_review = false WHERE id = v_item_id;
        INSERT INTO public.purchase_order_item_cost_changes (
          purchase_order_id, purchase_order_item_id, product_id,
          old_unit_cost_cents, new_unit_cost_cents, quantity_received_at_change,
          source, reason, changed_by
        )
        SELECT poi.purchase_order_id, poi.id, poi.product_id, v_cents, v_cents,
               COALESCE(poi.quantity_received, 0), 'confirmed', v_reason, v_actor
          FROM public.purchase_order_items poi WHERE poi.id = v_item_id;
        v_confirmed := v_confirmed + 1;
      END IF;
    ELSE
      -- A received line is purchase evidence: changing it needs a reason (Mason, 2026-10-20).
      IF v_reason IS NULL AND (
           COALESCE(v_line.quantity_received, 0) > 0
           OR EXISTS (SELECT 1 FROM public.receiving_records rr WHERE rr.po_item_id = v_item_id)) THEN
        RAISE EXCEPTION 'PO_COST_REASON_REQUIRED: say why the cost of a received line is changing'
          USING ERRCODE = 'P0001';
      END IF;
      -- A supplier cost-basis row (or a pending change row) that cites this line as its actual
      -- purchase was checked against the line's cost; changing it would leave that evidence
      -- silently wrong. Refuse; the basis must be replaced first (live read 2026-10-20: none exist).
      IF EXISTS (SELECT 1 FROM public.product_cost_basis b WHERE b.purchase_order_item_id = v_item_id)
         OR EXISTS (SELECT 1 FROM public.product_cost_basis_change_rows c WHERE c.purchase_order_item_id = v_item_id) THEN
        RAISE EXCEPTION 'PO_COST_BASIS_EVIDENCE_IN_USE: supplier cost-basis evidence cites this line; replace that basis before changing its cost'
          USING ERRCODE = 'P0001';
      END IF;
      UPDATE public.purchase_order_items
         SET unit_cost = v_cents::numeric / 100.0
       WHERE id = v_item_id;
      v_changed := v_changed + 1;
    END IF;

    PERFORM set_config('crx.po_cost_set_item', '', true);
    PERFORM set_config('crx.po_cost_set_reason', '', true);
  END LOOP;

  IF v_changed > 0 THEN
    UPDATE public.purchase_orders po
       SET total_cost = COALESCE((
             SELECT SUM(round(poi.quantity_ordered * poi.unit_cost_cents)::bigint)
               FROM public.purchase_order_items poi
              WHERE poi.purchase_order_id = po.id), 0)::numeric / 100.0,
           updated_at = now()
     WHERE po.id = p_po_id
    RETURNING total_cost_cents INTO v_new_total;

    -- The vendor-bill control (bills over 105% of the PO total need a confirmed reason) runs when a
    -- bill is created; a correction that LOWERS the total must not create that overage silently.
    -- The PO row lock above serializes this with bill creation, which locks the PO too (Sol, 2026-10-21).
    SELECT COALESCE(SUM(vb.total_cents), 0)::bigint INTO v_billed
      FROM public.vendor_bills vb
     WHERE vb.purchase_order_id = p_po_id AND vb.deleted_at IS NULL AND vb.status <> 'voided';
    IF v_new_total < v_old_total AND v_billed > 0 AND v_billed * 100 > v_new_total * 105 THEN
      RAISE EXCEPTION 'PO_COST_BELOW_BILLED: this correction would leave the active vendor bills more than 5%% over the purchase order total; void or adjust the bill first'
        USING ERRCODE = '22023',
              DETAIL = jsonb_build_object('po_total_cents', v_new_total, 'active_billed_cents', v_billed)::text;
    END IF;
  END IF;

  IF v_changed > 0 OR v_confirmed > 0 THEN
    -- No amounts here: the activity feed is not admin-only.
    INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
    VALUES ('po_updated',
            'PO ' || COALESCE(v_po_number, '') || CASE WHEN v_changed > 0 THEN ' unit cost changed' ELSE ' unit cost confirmed' END,
            v_actor, 'purchase_order', p_po_id);
  END IF;

  v_result := jsonb_build_object(
    'status', 'saved', 'po_id', p_po_id,
    'lines_changed', v_changed, 'lines_confirmed', v_confirmed);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_purchase_order_item_costs', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_purchase_order_item_costs', v_fingerprint);
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.set_purchase_order_item_costs(uuid, jsonb, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_purchase_order_item_costs(uuid, jsonb, text, uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_purchase_order_item_costs(uuid, jsonb, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.set_purchase_order_item_costs(uuid, jsonb, text, uuid, text) IS
  'Admin-only: set, correct or confirm purchase-order line unit cost (cents), received lines included (reason required). Changes only cost and the PO total; never inventory or catalog cost. Key required, bound to caller + request.';

-- ---------------------------------------------------------------------------
-- 6. save_purchase_order: the live wrapper (md5-pinned above) plus one step. A non-admin never sets
--    cost (the rep trigger overrules it) and must not learn a stored cost either: the received-line
--    check further down compares a SENT cost with the stored one, so a rep's guess would come back
--    as "saved" or RECEIVED_PO_LINE_IMMUTABLE. Strip the cost keys a non-admin sends before that
--    check, so the writer hydrates the stored cost and a guess reveals nothing (Sol, 2026-10-21).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_purchase_order(
  p_po_id uuid, p_po_payload jsonb, p_items jsonb, p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $function$
DECLARE
  v_items jsonb := p_items;
BEGIN
  PERFORM pg_advisory_xact_lock(73492009);
  IF NOT public.is_admin() AND jsonb_typeof(p_items) = 'array' THEN
    SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(t.e) = 'object' THEN t.e - 'unit_cost' - 'unit_cost_cents' ELSE t.e END
                              ORDER BY t.o), '[]'::jsonb)
      INTO v_items
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(e, o);
  END IF;
  RETURN public._section9_save_purchase_order_serialized(
    p_po_id, p_po_payload, v_items, p_performed_by, p_idempotency_key
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
DO $verify$
BEGIN
  IF position('unit_cost_cents' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure)) = 0
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)'::regprocedure)
     OR has_function_privilege('anon', 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.save_purchase_order(uuid,jsonb,jsonb,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PO_COST_VERIFY: save_purchase_order is not the cost-stripping wrapper with its grants';
  END IF;
  IF (SELECT array_agg(tgname::text ORDER BY tgname) FROM pg_trigger
       WHERE tgrelid = 'public.purchase_order_items'::regclass AND NOT tgisinternal)
     IS DISTINCT FROM ARRAY['trg_po_items_recompute_on_order', 'trigger_a_po_item_rep_cost',
                            'trigger_capture_purchase_order_item_cost_snapshot', 'trigger_po_item_cost_change_log'] THEN
    RAISE EXCEPTION 'PO_COST_VERIFY: unexpected triggers on purchase_order_items';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.purchase_order_item_cost_changes'::regclass) THEN
    RAISE EXCEPTION 'PO_COST_VERIFY: RLS is off on purchase_order_item_cost_changes';
  END IF;
  IF has_table_privilege('anon', 'public.purchase_order_item_cost_changes', 'SELECT')
     OR has_table_privilege('authenticated', 'public.purchase_order_item_cost_changes', 'INSERT')
     OR has_table_privilege('authenticated', 'public.purchase_order_item_cost_changes', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.purchase_order_item_cost_changes', 'DELETE') THEN
    RAISE EXCEPTION 'PO_COST_VERIFY: an API role can write the cost history, or anon can read it';
  END IF;
  IF has_function_privilege('anon', 'public.set_purchase_order_item_costs(uuid,jsonb,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.set_purchase_order_item_costs(uuid,jsonb,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_purchase_order_item_costs(uuid,jsonb,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PO_COST_VERIFY: set_purchase_order_item_costs grants are wrong';
  END IF;
  IF EXISTS (
       SELECT 1
         FROM unnest(ARRAY['public._po_item_rep_cost()', 'public._po_item_cost_change_log()',
                           'public._po_item_cost_changes_append_only()']) AS f(sig),
              unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
        WHERE has_function_privilege(r.role, f.sig, 'EXECUTE')) THEN
    RAISE EXCEPTION 'PO_COST_VERIFY: a trigger function is executable by an API role';
  END IF;
  IF EXISTS (
       SELECT 1
         FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role),
              unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(priv)
        WHERE has_table_privilege(r.role, 'public.purchase_order_item_cost_changes', p.priv)) THEN
    RAISE EXCEPTION 'PO_COST_VERIFY: an API role can write the cost history';
  END IF;
  IF (SELECT p.prosecdef IS NOT TRUE OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
        FROM pg_proc p WHERE p.oid = 'public.set_purchase_order_item_costs(uuid,jsonb,text,uuid,text)'::regprocedure) THEN
    RAISE EXCEPTION 'PO_COST_VERIFY: set_purchase_order_item_costs is not SECURITY DEFINER with search_path public, pg_temp';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.purchase_order_item_cost_changes'::regclass) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.purchase_order_item_cost_changes'::regclass
                     AND polname = 'po_item_cost_changes_admin_select' AND polcmd = 'r') THEN
    RAISE EXCEPTION 'PO_COST_VERIFY: the cost history must have exactly its one admin SELECT policy';
  END IF;
  -- CREATE OR REPLACE keeps the snapshot trigger function's owner and ACL; prove they are unchanged.
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.capture_purchase_order_item_cost_snapshot()'::regprocedure)
     OR has_function_privilege('anon', 'public.capture_purchase_order_item_cost_snapshot()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.capture_purchase_order_item_cost_snapshot()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PO_COST_VERIFY: capture_purchase_order_item_cost_snapshot is not SECURITY DEFINER or an API role can execute it';
  END IF;
  IF EXISTS (SELECT 1 FROM public.purchase_order_items WHERE cost_needs_review) THEN
    RAISE EXCEPTION 'PO_COST_VERIFY: an existing line was flagged';
  END IF;
END
$verify$;
