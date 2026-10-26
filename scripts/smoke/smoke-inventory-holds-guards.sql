-- Smoke chain: inventory holds and retired-product on-order guards
-- (REQUIRES 20261025090000; To-Do rows 0.13, 0.14 and the holds half of 6.9).
-- One DO block; it plants [E2E] rows and always ends in SMOKE_PASS_ROLLBACK, so nothing persists.
-- Proves, signed in as a real active admin (role authenticated with the profile's claims):
--   (a) a retired [E2E] product with an open (submitted) [E2E] purchase order line appears in
--       get_inventory_position() with its on-order quantity, and drops out again once the PO is
--       cancelled;
--   (b) create_inventory_hold refuses 'crop_program', 'job' and a NULL hold type with
--       HOLD_TYPE_NOT_ALLOWED and writes nothing, while a 'manual' hold (admin force with a reason,
--       so it does not depend on live stock) is still created;
--   (c) run_data_integrity_sweep() (as the cron runs it: no signed-in user) reports 0 new
--       stuck_job_hold and 0 new orphan_quote_hold on the real data, then exactly 1 of each once an
--       [E2E] job hold on a missing job and an [E2E] program hold on a missing quote are planted
--       (a real stuck hold on live makes the first step fail: that is the detector finding data,
--       and the error names the counts);
--   (d) deleting an [E2E] product that has a hold is refused by inventory_holds_product_id_fkey.
DO $$
DECLARE
  v_admin uuid;
  v_retired uuid;
  v_plain uuid;
  v_po uuid;
  v_rows jsonb;
  v_row jsonb;
  v_result jsonb;
  v_hold_id uuid;
  v_type text;
  v_refused text;
  v_holds_before bigint;
  v_sweep jsonb;
  v_constraint text;
BEGIN
  SELECT p.id INTO v_admin FROM public.profiles p WHERE p.role = 'admin' AND p.is_active ORDER BY p.created_at LIMIT 1;
  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: no active admin profile to sign in with';
  END IF;

  -- Fixtures, as the owner: a retired product with an open PO line, and a plain active product.
  INSERT INTO public.products (product_name, is_active)
  VALUES ('[E2E] smoke retired on-order product', false) RETURNING id INTO v_retired;
  INSERT INTO public.products (product_name, is_active)
  VALUES ('[E2E] smoke hold product', true) RETURNING id INTO v_plain;
  INSERT INTO public.purchase_orders (po_number, vendor, status, created_by)
  VALUES ('[E2E]-SMOKE-HOLDS-GUARDS', '[E2E] smoke vendor', 'submitted', v_admin) RETURNING id INTO v_po;
  INSERT INTO public.purchase_order_items (purchase_order_id, product_id, quantity_ordered, quantity_received)
  VALUES (v_po, v_retired, 10, 0);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- (a) The retired product is on order.
  v_rows := public.get_inventory_position();
  SELECT e INTO v_row FROM jsonb_array_elements(v_rows) e WHERE e ->> 'product_id' = v_retired::text;
  IF v_row IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) the retired product with an open PO line is missing from get_inventory_position';
  END IF;
  IF (v_row ->> 'quantity_on_order')::numeric IS DISTINCT FROM 10
     OR (v_row ->> 'net_position')::numeric IS DISTINCT FROM 10
     OR (v_row ->> 'is_low_stock')::boolean IS DISTINCT FROM false
     OR v_row ? 'is_active' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) wrong retired-product row: %', v_row;
  END IF;
  IF jsonb_array_length(v_rows) <> (SELECT count(*) FROM (
       SELECT DISTINCT e ->> 'product_id', e ->> 'inventory_id' FROM jsonb_array_elements(v_rows) e) d) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) get_inventory_position returned duplicate rows';
  END IF;

  -- (b) Only manual holds through the public path.
  SELECT count(*) INTO v_holds_before FROM public.inventory_holds WHERE product_id = v_plain;
  FOREACH v_type IN ARRAY ARRAY['crop_program', 'job', NULL] LOOP
    v_refused := NULL;
    BEGIN
      PERFORM public.create_inventory_hold(v_plain, NULL, 1, v_type, NULL, '[E2E] smoke hold', v_admin,
        true, '[E2E] smoke', '[E2E]-smoke-holds-guards-' || COALESCE(v_type, 'null'));
    EXCEPTION WHEN OTHERS THEN
      v_refused := SQLERRM;
    END;
    IF v_refused IS NULL OR v_refused NOT LIKE 'HOLD_TYPE_NOT_ALLOWED:%' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: (b) hold type % was not refused with HOLD_TYPE_NOT_ALLOWED (got %)', COALESCE(v_type, 'NULL'), v_refused;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.inventory_holds WHERE product_id = v_plain) <> v_holds_before
     OR EXISTS (SELECT 1 FROM public.idempotency_keys WHERE idempotency_key LIKE '[E2E]-smoke-holds-guards-%') THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (b) a refused hold type still wrote a hold';
  END IF;
  v_result := public.create_inventory_hold(v_plain, NULL, 1, 'manual', NULL, '[E2E] smoke hold', v_admin,
    true, '[E2E] smoke', '[E2E]-smoke-holds-guards-manual');
  v_hold_id := (v_result ->> 'hold_id')::uuid;
  IF v_hold_id IS NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (b) a manual hold was not created: %', v_result;
  END IF;
  EXECUTE 'RESET ROLE';
  IF NOT EXISTS (SELECT 1 FROM public.inventory_holds
                  WHERE id = v_hold_id AND hold_type = 'manual' AND product_id = v_plain AND is_active) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (b) the manual hold row is not there';
  END IF;

  -- (a, continued) Once nothing is on order the retired product drops out again.
  UPDATE public.purchase_orders SET status = 'cancelled' WHERE id = v_po;
  EXECUTE 'SET LOCAL ROLE authenticated';
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(public.get_inventory_position()) e
              WHERE e ->> 'product_id' = v_retired::text) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (a) the retired product is still listed with nothing on order';
  END IF;
  EXECUTE 'RESET ROLE';

  -- (c) The sweep, as the cron runs it (no signed-in user).
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_sweep := public.run_data_integrity_sweep();
  IF (v_sweep ->> 'new_stuck_job_holds') IS DISTINCT FROM '0' OR (v_sweep ->> 'new_orphan_quote_holds') IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) the new checks should find 0 on the real data: %', v_sweep;
  END IF;
  -- The sweep counts only NEW alerts; an older unresolved one would hide a stuck hold.
  IF EXISTS (SELECT 1 FROM public.integrity_alerts
              WHERE resolved_at IS NULL AND alert_type IN ('stuck_job_hold', 'orphan_quote_hold')) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) an unresolved stuck_job_hold / orphan_quote_hold alert already exists';
  END IF;
  INSERT INTO public.inventory_holds (product_id, quantity, hold_type, source_id, notes, created_by, is_active)
  VALUES (v_plain, 2, 'job', gen_random_uuid(), '[E2E] smoke stuck job hold', v_admin, true),
         (v_plain, 3, 'crop_program', gen_random_uuid(), '[E2E] smoke orphan program hold', v_admin, true);
  v_sweep := public.run_data_integrity_sweep();
  IF (v_sweep ->> 'new_stuck_job_holds') IS DISTINCT FROM '1' OR (v_sweep ->> 'new_orphan_quote_holds') IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) the planted stuck job hold and orphan program hold were not each reported once: %', v_sweep;
  END IF;
  IF (SELECT count(*) FROM public.integrity_alerts a JOIN public.inventory_holds h ON h.id = a.entity_id
       WHERE a.resolved_at IS NULL AND h.product_id = v_plain
         AND a.alert_type = 'stuck_job_hold' AND h.hold_type = 'job') <> 1
     OR (SELECT count(*) FROM public.integrity_alerts a JOIN public.inventory_holds h ON h.id = a.entity_id
       WHERE a.resolved_at IS NULL AND h.product_id = v_plain
         AND a.alert_type = 'orphan_quote_hold' AND h.hold_type = 'crop_program') <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (c) each alert is not recorded against the planted hold of its own type';
  END IF;

  -- (d) A product with a hold cannot be deleted (its holds are not wiped).
  v_constraint := NULL;
  BEGIN
    DELETE FROM public.products WHERE id = v_plain AND product_name = '[E2E] smoke hold product';
  EXCEPTION WHEN foreign_key_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
  END;
  IF v_constraint IS DISTINCT FROM 'inventory_holds_product_id_fkey' THEN
    RAISE EXCEPTION 'SMOKE_FAIL: (d) deleting a product with holds was not refused by inventory_holds_product_id_fkey (got %)', v_constraint;
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK: inventory holds guards — retired on-order row shown, non-manual holds refused, sweep 0 then 1+1, product delete refused';
END
$$;
