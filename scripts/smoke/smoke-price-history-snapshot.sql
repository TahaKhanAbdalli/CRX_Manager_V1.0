-- ============================================================================
-- SMOKE CHAIN (rolled back by design): the cost_history starting snapshot and the history-keeping
-- product FK (20261026140000_product_price_history_starting_snapshot.sql). Run after apply, as ONE
-- statement. Live, rollback-only, plants one [SMOKE] product.
--
--   1. Every product that existed when the snapshot ran has a history row; each snapshot row is its
--      product's only row from that time or earlier, with no changed_by and old = new. (Products
--      created later need no snapshot: their first logged change records their starting prices.)
--   2. Re-running the snapshot INSERT over those products adds nothing (idempotent).
--   3. A real change with no changed_by is refused (cost_history_changed_by_required).
--   4. Deleting a product that has history is refused by cost_history_product_id_fkey, and its
--      history is still there.
--   5. Access is unchanged: an active sales rep reads no history; an active admin reads it.
-- Always ends in SMOKE_PASS_ROLLBACK, so nothing persists.
-- ============================================================================

DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_product uuid := gen_random_uuid();
  v_bad bigint;
  v_before bigint;
  v_after bigint;
  v_seen bigint;
  v_snapshot_at timestamptz;
BEGIN
  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM public.profiles WHERE role = 'sales_rep' AND is_active ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: need an active admin and an active sales rep';
  END IF;

  SELECT min(changed_at) INTO v_snapshot_at FROM public.cost_history WHERE change_source = 'starting_snapshot';
  IF v_snapshot_at IS NULL THEN RAISE EXCEPTION 'SMOKE_FAIL 1: no starting snapshot rows'; END IF;

  -- 1. Every product that existed then has history; a snapshot only where nothing came before it.
  SELECT count(*) INTO v_bad FROM public.products p
   WHERE p.created_at <= v_snapshot_at
     AND NOT EXISTS (SELECT 1 FROM public.cost_history h WHERE h.product_id = p.id);
  IF v_bad <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL 1: % products that existed at the snapshot have no history', v_bad; END IF;
  SELECT count(*) INTO v_bad FROM public.cost_history s
   WHERE s.change_source = 'starting_snapshot'
     AND (SELECT count(*) FROM public.cost_history h
           WHERE h.product_id = s.product_id AND h.changed_at <= s.changed_at) <> 1;
  IF v_bad <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL 1: % snapshot rows sit on a product that already had history', v_bad; END IF;
  SELECT count(*) INTO v_bad FROM public.cost_history
   WHERE change_source = 'starting_snapshot'
     AND (changed_by IS NOT NULL OR old_cost IS DISTINCT FROM new_cost
          OR old_tier1_price IS DISTINCT FROM new_tier1_price OR old_tier2_price IS DISTINCT FROM new_tier2_price
          OR old_tier3_price IS DISTINCT FROM new_tier3_price);
  IF v_bad <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL 1: % snapshot rows are attributed or record a change', v_bad; END IF;

  -- 2. Idempotent.
  SELECT count(*) INTO v_before FROM public.cost_history;
  INSERT INTO public.cost_history (product_id, changed_by, change_source, change_reason, changed_at, old_cost, new_cost)
  SELECT p.id, NULL, 'starting_snapshot', 'smoke re-run', now(), p.current_cost, p.current_cost
    FROM public.products p
   WHERE p.created_at <= v_snapshot_at
     AND NOT EXISTS (SELECT 1 FROM public.cost_history h WHERE h.product_id = p.id);
  SELECT count(*) INTO v_after FROM public.cost_history;
  IF v_after <> v_before THEN RAISE EXCEPTION 'SMOKE_FAIL 2: a re-run added % rows', v_after - v_before; END IF;

  -- A throwaway product with one snapshot row, for 3 and 4.
  INSERT INTO public.products (id, product_name, is_active) VALUES (v_product, '[SMOKE] price history', false);
  INSERT INTO public.cost_history (product_id, changed_by, change_source, change_reason)
  VALUES (v_product, NULL, 'starting_snapshot', 'smoke');

  -- 3. A real change must name who made it.
  BEGIN
    INSERT INTO public.cost_history (product_id, changed_by, change_source) VALUES (v_product, NULL, 'product_page');
    RAISE EXCEPTION 'SMOKE_FAIL 3: an unattributed real change was accepted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%cost_history_changed_by_required%' THEN RAISE EXCEPTION 'SMOKE_FAIL 3: %', SQLERRM; END IF;
  END;

  -- 4. Deleting a product with history is refused; the history stays.
  BEGIN
    DELETE FROM public.products WHERE id = v_product;
    RAISE EXCEPTION 'SMOKE_FAIL 4: a product with history was deleted';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%cost_history_product_id_fkey%' THEN RAISE EXCEPTION 'SMOKE_FAIL 4: %', SQLERRM; END IF;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.cost_history WHERE product_id = v_product) THEN
    RAISE EXCEPTION 'SMOKE_FAIL 4: the history is gone';
  END IF;

  -- 5. Access unchanged (cost_history_select: admins only).
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM public.cost_history WHERE product_id = v_product;
  RESET ROLE;
  IF v_seen <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL 5: a sales rep read % history rows', v_seen; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_seen FROM public.cost_history WHERE product_id = v_product;
  RESET ROLE;
  IF v_seen <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL 5: an admin read % history rows, expected 1', v_seen; END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END;
$smoke$;
