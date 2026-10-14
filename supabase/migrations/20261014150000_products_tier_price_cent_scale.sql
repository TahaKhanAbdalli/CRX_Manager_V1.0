-- Products: tier prices must be whole cents, as a table constraint.
--
-- public.products.current_cost already carries products_current_cost_cent_scale_chk
-- (20260812115237). tier1_price, tier2_price and tier3_price are unconstrained
-- numeric with only the `>= 0` checks chk_product_tier1/2/3. PostgREST returns
-- them as JSON numbers, so a browser-side parseDollarsToCents(String(price))
-- cannot detect a sub-cent value with more than ~17 significant digits (Luna
-- review on PR #908, 2026-10-14).
--
-- The BEFORE trigger guard_and_version_product_pricing() already raises
-- PRODUCT_PRICING_CENT_SCALE_INVALID for a sub-cent or non-finite tier price,
-- and no later trigger assigns tier prices (live pg_proc search, 2026-10-14),
-- so every write that succeeds today already satisfies these constraints. A
-- CHECK constraint is the stronger invariant: it holds even for a writer that
-- runs with triggers disabled or replication-role writes, and once the schema
-- registry is regenerated after apply, its reviewers can see it.
--
-- The predicate is the full finite whole-cent CHECK and the names follow
-- `<table>_<column>_whole_cents_chk` (docs/workflows/SAFE_DEVELOPMENT_RULES.md).
--
-- Live read-only measurement immediately before this migration was written
-- (2026-10-14): 604 products, 0 with a sub-cent, infinite or NaN tier1/2/3
-- price. NULL stays allowed (3/5/12 products carry a NULL tier1/2/3 price).
--
-- Non-destructive: adds three validated CHECK constraints; no row is changed.
-- Each ADD CONSTRAINT scans products once under a brief ACCESS EXCLUSIVE lock.
-- Re-runnable: a constraint that already exists is not re-added, and the verify
-- block below then checks its shape, so a stale definition fails closed.
-- Rollback:
--   ALTER TABLE public.products DROP CONSTRAINT products_tier1_price_whole_cents_chk;
--   ALTER TABLE public.products DROP CONSTRAINT products_tier2_price_whole_cents_chk;
--   ALTER TABLE public.products DROP CONSTRAINT products_tier3_price_whole_cents_chk;

DO $add$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.products'::regclass
      AND conname = 'products_tier1_price_whole_cents_chk'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_tier1_price_whole_cents_chk
      CHECK (tier1_price IS NULL OR (
        tier1_price = round(tier1_price, 2)
        AND tier1_price > '-Infinity'::numeric
        AND tier1_price < 'Infinity'::numeric
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.products'::regclass
      AND conname = 'products_tier2_price_whole_cents_chk'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_tier2_price_whole_cents_chk
      CHECK (tier2_price IS NULL OR (
        tier2_price = round(tier2_price, 2)
        AND tier2_price > '-Infinity'::numeric
        AND tier2_price < 'Infinity'::numeric
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.products'::regclass
      AND conname = 'products_tier3_price_whole_cents_chk'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_tier3_price_whole_cents_chk
      CHECK (tier3_price IS NULL OR (
        tier3_price = round(tier3_price, 2)
        AND tier3_price > '-Infinity'::numeric
        AND tier3_price < 'Infinity'::numeric
      ));
  END IF;
END
$add$;

-- Verify inside the same transaction: each constraint exists, is validated,
-- and its definition is EXACTLY the expected predicate. An exact comparison,
-- not a fragment search, because a same-named constraint that already existed
-- was not re-added above and could otherwise carry the right fragments in the
-- wrong logic. The expected text is pg_get_constraintdef's rendering, as read
-- live for products_current_cost_cent_scale_chk on 2026-10-14.
DO $verify$
DECLARE
  v_column text;
  v_name text;
BEGIN
  FOREACH v_column IN ARRAY ARRAY['tier1_price', 'tier2_price', 'tier3_price']
  LOOP
    v_name := 'products_' || v_column || '_whole_cents_chk';
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      WHERE c.conrelid = 'public.products'::regclass
        AND c.conname = v_name
        AND c.contype = 'c'
        AND c.convalidated = true
        AND pg_get_constraintdef(c.oid) = format(
          'CHECK (((%1$s IS NULL) OR ((%1$s = round(%1$s, 2)) AND (%1$s > ''-Infinity''::numeric) AND (%1$s < ''Infinity''::numeric))))',
          v_column)
    ) THEN
      RAISE EXCEPTION 'verify failed: % whole-cent constraint missing or incomplete', v_name;
    END IF;
  END LOOP;
END
$verify$;
