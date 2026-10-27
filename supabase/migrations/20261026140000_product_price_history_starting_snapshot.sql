-- Written 2026-10-26. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- idempotency-body-check: exempt -- no function is created or changed.
--
-- WHAT: sell-price history on the product page has a starting point, and deleting a product no
--   longer erases its history (To-Do 0.4, pricing plan slice 4; plan section 7, findings 4 and 7).
--   The screen half (an admin-only sell-price chart with a real date axis) reads cost_history
--   directly, which its admin-only policy already allows.
--
--   1. A dated STARTING SNAPSHOT for every product whose history records NO sell price: one cost_history row,
--      stamped now, recording its current cost, three tier prices, three tier margins and pricing
--      version as both old and new (no change). Live 2026-10-26: 578 of 604 products have no history
--      row at all, and 9 more have only rows with no tier price (older cost-only writers), so "what
--      was the price on date X" has no answer for them (587 in all). A product whose history already
--      records a tier price gets none: its earliest such row's old values say where it started, and a
--      snapshot dated today would sort after its real changes. A product created later needs none
--      either: every change after creation is logged by write_product_pricing_history, so its
--      creation prices are its first row's old values (or its current prices if it never changed).
--      - change_source 'starting_snapshot' (cost_history_change_source_check widened: a superset of
--        the four live values).
--      - changed_by is NULL on snapshot rows only: no person made this change, and naming one would
--        misattribute it. The column was NOT NULL; it becomes nullable with a CHECK that only a
--        starting_snapshot row may leave it empty. cost_history_starting_snapshot_unchanged makes a
--        starting_snapshot row name no person and carry old = new on every value, so a real change
--        can never be written as one. cost_history_tier_prices_whole_cents holds the six tier price
--        columns (plain numeric) to whole cents; live 2026-10-26 every one of the 33 rows already is.
--      - Re-runnable: a product with a snapshot, or with a row recording a tier price, gets no new one.
--   2. cost_history_product_id_fkey loses ON DELETE CASCADE (becomes NO ACTION): deleting a product
--      with history is refused instead of silently erasing that history. The app has no product
--      delete; 602 of 604 products are already undeletable through product_cost_basis (RESTRICT).
--
-- LIVE DATA: this INSERTs about 587 new cost_history rows (one per product with no sell-price history). It
--   changes or deletes no existing row.
--
-- ROLLBACK (new reviewed migration; the snapshot rows are history and should normally be kept):
--   ALTER TABLE public.cost_history DROP CONSTRAINT cost_history_product_id_fkey,
--     ADD CONSTRAINT cost_history_product_id_fkey FOREIGN KEY (product_id)
--       REFERENCES public.products(id) ON DELETE CASCADE;
--   (Removing the snapshot rows would be a data deletion: Mason's call.)

SET LOCAL lock_timeout = '10s';

DO $preflight$
BEGIN
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.cost_history'::regclass AND conname = 'cost_history_change_source_check')
     IS DISTINCT FROM 'CHECK ((change_source = ANY (ARRAY[''legacy_frontend''::text, ''pricing_worksheet''::text, ''product_page''::text, ''products_inline''::text])))' THEN
    RAISE EXCEPTION 'PRICE_HISTORY_SNAPSHOT_PREFLIGHT: cost_history_change_source_check changed since 2026-10-26; re-read it before applying';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.cost_history'::regclass AND conname = 'cost_history_product_id_fkey')
     IS DISTINCT FROM 'FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE' THEN
    RAISE EXCEPTION 'PRICE_HISTORY_SNAPSHOT_PREFLIGHT: cost_history_product_id_fkey changed since 2026-10-26; re-read it before applying';
  END IF;
  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'cost_history' AND column_name = 'changed_by') IS DISTINCT FROM 'NO'
     OR EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.cost_history'::regclass
                   AND conname IN ('cost_history_changed_by_required', 'cost_history_starting_snapshot_unchanged',
                                   'cost_history_tier_prices_whole_cents')) THEN
    RAISE EXCEPTION 'PRICE_HISTORY_SNAPSHOT_PREFLIGHT: cost_history.changed_by is not the live NOT NULL column of 2026-10-26';
  END IF;
END
$preflight$;

-- Lock products before cost_history (statement 2 needs both): a pricing save updates products and
-- then writes cost_history, so taking them in that same order cannot deadlock with one.
LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;

-- 1. Room for snapshot rows.
ALTER TABLE public.cost_history
  DROP CONSTRAINT cost_history_change_source_check,
  ADD CONSTRAINT cost_history_change_source_check CHECK (change_source = ANY (ARRAY[
    'legacy_frontend'::text, 'pricing_worksheet'::text, 'product_page'::text, 'products_inline'::text,
    'starting_snapshot'::text
  ])),
  ALTER COLUMN changed_by DROP NOT NULL,
  ADD CONSTRAINT cost_history_changed_by_required
    CHECK (changed_by IS NOT NULL OR change_source = 'starting_snapshot'),
  -- A snapshot records no change and no person, so a real change can never pass as one.
  ADD CONSTRAINT cost_history_starting_snapshot_unchanged
    CHECK (change_source IS DISTINCT FROM 'starting_snapshot' OR (
      changed_by IS NULL
      AND old_cost IS NOT DISTINCT FROM new_cost
      AND old_tier1_price IS NOT DISTINCT FROM new_tier1_price
      AND old_tier2_price IS NOT DISTINCT FROM new_tier2_price
      AND old_tier3_price IS NOT DISTINCT FROM new_tier3_price
      AND old_tier1_margin IS NOT DISTINCT FROM new_tier1_margin
      AND old_tier2_margin IS NOT DISTINCT FROM new_tier2_margin
      AND old_tier3_margin IS NOT DISTINCT FROM new_tier3_margin
      AND old_pricing_version IS NOT DISTINCT FROM new_pricing_version)),
  -- The six tier prices are plain numeric; hold them to whole cents (live 2026-10-26: 0 of 33 rows are not).
  -- The bounds also refuse NaN and the infinities, which equal their own round().
  ADD CONSTRAINT cost_history_tier_prices_whole_cents CHECK (
    (old_tier1_price IS NULL OR (old_tier1_price = round(old_tier1_price, 2) AND old_tier1_price > -1e10 AND old_tier1_price < 1e10))
    AND (new_tier1_price IS NULL OR (new_tier1_price = round(new_tier1_price, 2) AND new_tier1_price > -1e10 AND new_tier1_price < 1e10))
    AND (old_tier2_price IS NULL OR (old_tier2_price = round(old_tier2_price, 2) AND old_tier2_price > -1e10 AND old_tier2_price < 1e10))
    AND (new_tier2_price IS NULL OR (new_tier2_price = round(new_tier2_price, 2) AND new_tier2_price > -1e10 AND new_tier2_price < 1e10))
    AND (old_tier3_price IS NULL OR (old_tier3_price = round(old_tier3_price, 2) AND old_tier3_price > -1e10 AND old_tier3_price < 1e10))
    AND (new_tier3_price IS NULL OR (new_tier3_price = round(new_tier3_price, 2) AND new_tier3_price > -1e10 AND new_tier3_price < 1e10)));

-- 2. Deleting a product keeps (refuses over) its history.
ALTER TABLE public.cost_history
  DROP CONSTRAINT cost_history_product_id_fkey,
  ADD CONSTRAINT cost_history_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);

-- 3. The starting snapshot.
INSERT INTO public.cost_history (
  product_id, changed_by, change_source, change_reason, change_note, changed_at,
  old_cost, new_cost,
  old_tier1_price, new_tier1_price, old_tier2_price, new_tier2_price, old_tier3_price, new_tier3_price,
  old_tier1_margin, new_tier1_margin, old_tier2_margin, new_tier2_margin, old_tier3_margin, new_tier3_margin,
  old_pricing_version, new_pricing_version
)
SELECT p.id, NULL, 'starting_snapshot', 'Prices when price history started',
       'Prices and cost as they stood when price history started (20261026140000); not a change.', now(),
       p.current_cost, p.current_cost,
       p.tier1_price, p.tier1_price, p.tier2_price, p.tier2_price, p.tier3_price, p.tier3_price,
       p.tier1_margin, p.tier1_margin, p.tier2_margin, p.tier2_margin, p.tier3_margin, p.tier3_margin,
       p.pricing_version, p.pricing_version
  FROM public.products p
 WHERE NOT EXISTS (SELECT 1 FROM public.cost_history h
                    WHERE h.product_id = p.id
                      AND (h.change_source = 'starting_snapshot' OR num_nonnulls(h.old_tier1_price, h.new_tier1_price, h.old_tier2_price, h.new_tier2_price, h.old_tier3_price, h.new_tier3_price) > 0));

-- VERIFY
DO $verify$
BEGIN
  -- Every product now has history; a snapshot only where no other row of it records a sell price.
  IF EXISTS (SELECT 1 FROM public.products p
              WHERE NOT EXISTS (SELECT 1 FROM public.cost_history h WHERE h.product_id = p.id)) THEN
    RAISE EXCEPTION 'PRICE_HISTORY_SNAPSHOT_VERIFY: a product still has no history row';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cost_history s
              WHERE s.change_source = 'starting_snapshot'
                AND EXISTS (SELECT 1 FROM public.cost_history h
                             WHERE h.product_id = s.product_id AND h.id <> s.id
                               AND (h.change_source = 'starting_snapshot' OR num_nonnulls(h.old_tier1_price, h.new_tier1_price, h.old_tier2_price, h.new_tier2_price, h.old_tier3_price, h.new_tier3_price) > 0))) THEN
    RAISE EXCEPTION 'PRICE_HISTORY_SNAPSHOT_VERIFY: a snapshot was added to a product whose history already records a sell price';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cost_history h JOIN public.products p ON p.id = h.product_id
              WHERE h.change_source = 'starting_snapshot'
                AND (h.new_cost IS DISTINCT FROM p.current_cost OR h.old_cost IS DISTINCT FROM p.current_cost
                     OR h.new_tier1_price IS DISTINCT FROM p.tier1_price
                     OR h.new_tier2_price IS DISTINCT FROM p.tier2_price
                     OR h.new_tier3_price IS DISTINCT FROM p.tier3_price
                     OR h.new_tier1_margin IS DISTINCT FROM p.tier1_margin
                     OR h.new_tier2_margin IS DISTINCT FROM p.tier2_margin
                     OR h.new_tier3_margin IS DISTINCT FROM p.tier3_margin
                     OR h.new_pricing_version IS DISTINCT FROM p.pricing_version
                     OR h.changed_by IS NOT NULL)) THEN
    RAISE EXCEPTION 'PRICE_HISTORY_SNAPSHOT_VERIFY: a snapshot does not match its product';
  END IF;
  IF (SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'public.cost_history'::regclass AND conname = 'cost_history_product_id_fkey') IS DISTINCT FROM 'a' THEN
    RAISE EXCEPTION 'PRICE_HISTORY_SNAPSHOT_VERIFY: cost_history_product_id_fkey still cascades';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cost_history WHERE changed_by IS NULL AND change_source <> 'starting_snapshot') THEN
    RAISE EXCEPTION 'PRICE_HISTORY_SNAPSHOT_VERIFY: a real change has no changed_by';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.cost_history'::regclass
                    AND conname = 'cost_history_starting_snapshot_unchanged' AND convalidated)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conrelid = 'public.cost_history'::regclass
                       AND conname = 'cost_history_tier_prices_whole_cents' AND convalidated) THEN
    RAISE EXCEPTION 'PRICE_HISTORY_SNAPSHOT_VERIFY: a new cost_history CHECK is missing';
  END IF;
  -- RLS and grants are untouched: admins only read cost_history; no browser role writes it.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.cost_history'::regclass)
     OR has_table_privilege('anon', 'public.cost_history', 'SELECT')
     OR has_table_privilege('authenticated', 'public.cost_history', 'INSERT')
     OR has_table_privilege('authenticated', 'public.cost_history', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.cost_history', 'DELETE') THEN
    RAISE EXCEPTION 'PRICE_HISTORY_SNAPSHOT_VERIFY: cost_history access is not what it was';
  END IF;
END
$verify$;
