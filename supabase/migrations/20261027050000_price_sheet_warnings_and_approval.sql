-- Written 2026-10-25. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- idempotency-body-check: exempt -- approve_pricing_change_set requires a key and binds its receipt to
--   the caller and request (check_idempotency_intent, save_idempotency, _bind_replay_receipt_20261015:
--   the set_purchase_order_item_costs pattern). preview_product_cost_basis_changes and
--   apply_product_cost_basis_change_set keep their live key handling unchanged (check_idempotency /
--   save_idempotency with an actor + request fingerprint, re-emitted from 20260722091359). The two
--   helpers are read-only and not callable by any API role.
--
-- WHAT: the price sheet is safe to use (To-Do 0.1, pricing plan slice 0; Sol review of the workbook
--   method, plan section 8). Every pricing change -- the workbook, the Products-list inline edit and
--   the product page -- already goes preview -> apply through preview_product_cost_basis_changes and
--   apply_product_cost_basis_change_set (the inner engines are not executable by any API role). This
--   adds, in the database so a stale or bypassed screen cannot skip it:
--
--   1. WARNINGS (Mason, 2026-10-14). For each product a change set re-prices, _pricing_change_set_warnings
--      computes, comparing the product's live values with the change set's outputs:
--        COST_MOVE_OVER_10_PERCENT   cost moves more than 10% up or down (or appears from $0)
--        PRICE_MOVE_OVER_10_PERCENT  any tier's price moves more than 10% (or appears from $0)
--        PRICE_BELOW_COST            any tier's price is below the new cost
--        MARGIN_UNDER_FLOOR          any tier's net margin is under the product's floor
--                                    (product_margin_floors, 20261025210000; no floor = no check)
--        OPEN_SENT_QUOTE             a price changes while a sent, revised or planned-accepted quote
--                                    with no sent version has this product on a line with no manual
--                                    price and the quote's own tier price changes: such a quote still
--                                    re-prices on its next save, at its tier (save_quote). A quote
--                                    with a sent version keeps its prices (the sent-quote price lock,
--                                    20261027040000, To-Do 1.2), so it raises nothing.
--      Tier prices are the ones customers pay: a blank or $0 tier 2/3 price falls back to tier 1.
--      The preview stores the exact set in pricing_change_set_warnings and returns it.
--
--   2. APPROVAL (the approval receipt). New approve_pricing_change_set(change set, fingerprint,
--      acknowledgements, source file, actor, key): admin-only, by the admin who previewed it, while
--      the preview is live. Every warned product needs one acknowledgement naming exactly its warning
--      codes, with a reason (1-500 characters); no acknowledgement for a product without warnings. A
--      workbook change set also names the uploaded file (name, SHA-256). It recomputes the warnings
--      and refuses (PRICING_WARNINGS_CHANGED) if their codes or details (a floor's value, which sent
--      quotes) differ from the preview's. The receipt
--      (pricing_change_set_approvals) keeps who, when, the acknowledgements, the warning codes and the
--      file (the details stay in pricing_change_set_warnings under the same change set).
--
--   3. APPLY requires that receipt: apply_product_cost_basis_change_set refuses
--      PRICING_APPROVAL_REQUIRED without an approval by the same admin of the same preview, and
--      PRICING_WARNINGS_CHANGED when the warnings recomputed at apply differ from the approved set,
--      or when a margin floor or the open sent quotes change while it applies (read again once the
--      inner engine holds the product locks; no product lock is taken earlier, which would reverse the
--      engine's lock order). Its body is otherwise the live one (20260722091359), as is the inner
--      engine it calls.
--
--   4. SOURCE AND REASON on every row that changes a price, the cost or the per-acre rate (plan
--      section 7, finding 6; section 8, gap 4): the preview marks such a row invalid
--      (PRICING_REASON_REQUIRED / PRICING_SOURCE_REQUIRED) when either is blank, and keeps both on the
--      change-set rows (new columns pricing_change_set_rows.price_source,
--      product_info_change_set_rows.change_reason / price_source). The app stops filling a generic
--      default reason. NOT COVERED (a named follow-up): the product page's Save Changes still edits
--      rate_per_acre / rate_unit directly (an admin-only column grant, 20260718190000), outside
--      preview and approval. Section 5 now logs that edit in cost_history with a fixed reason and no
--      source; before this file it left no history at all.
--
--   5. HISTORY: write_product_pricing_history (the live body from 20260717042803, otherwise
--      unchanged) also writes a cost_history row for a per-acre rate or rate-unit change (plan section
--      7, finding 5; previously the price moved with no history), records the row's own reason, and
--      fills the new cost_history columns price_source, old/new_rate_per_acre, old/new_rate_unit.
--
--   The preview wrapper is the live body (20260722091359) plus: the source/reason check (4), the
--   warnings insert (1) and a 'warnings' array in its result. Nothing else changes in it.
--
--   ROLLOUT GATE (plan section 8): this goes live immediately because it only adds checks; the
--   monthly price-sheet routine is not adopted for live price changes until the sent-quote price lock
--   (To-Do 1.2) is live and margin floors are set. OPEN_SENT_QUOTE makes the old hand check of the
--   Quotes list a hard, acknowledged warning for the quotes that lock does not cover (no sent version).
--
-- DEPENDS ON 20261025210000_product_margin_floors (product_margin_floors) and
--   20261027040000_quote_sent_price_lock (_assert_quote_prices_as_sent: OPEN_SENT_QUOTE leaves out the
--   quotes it locks); the preflight refuses without either.
--
-- caller-analysis: approve_pricing_change_set :: NEW; src/lib/productPricing.ts (applyProductPricingChangeSet calls it before apply; Products.tsx, ProductDetail.tsx)
-- caller-analysis: preview_product_cost_basis_changes :: body extended, same signature and grants; src/lib/productPricing.ts
-- caller-analysis: apply_product_cost_basis_change_set :: body extended, same signature and grants; src/lib/productPricing.ts
--
-- GRANTS: only the routine lock-down of objects this file creates: approve_pricing_change_set EXECUTE
--   to authenticated only; the three helpers and the two new tables to no API role (RPC-only, like the
--   other change-set tables). CREATE OR REPLACE keeps the three replaced functions' grants.
--
-- ROLLBACK (no data loss beyond the receipts and warnings written since):
--   re-run the three CREATE OR REPLACE FUNCTION statements for preview_product_cost_basis_changes and
--   apply_product_cost_basis_change_set from 20260722091359 and write_product_pricing_history from
--   20260717042803 (not those whole files);
--   DROP FUNCTION public.approve_pricing_change_set(uuid, text, jsonb, jsonb, uuid, text);
--   DROP FUNCTION public._pricing_change_set_warning_set(uuid);
--   DROP FUNCTION public._pricing_change_set_warning_inputs(uuid);
--   DROP FUNCTION public._pricing_change_set_warnings(uuid);
--   DROP TABLE public.pricing_change_set_approvals, public.pricing_change_set_warnings;
--   the new columns can stay (nullable, nothing else reads them).

SET LOCAL lock_timeout = '10s';

-- PREFLIGHT: the bodies this file replaces or relies on are exactly the ones read live on 2026-10-25
-- (md5 of prosrc without carriage returns), the floors table exists, and nothing it creates exists.
DO $preflight$
DECLARE
  r record;
  v_md5 text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- replaced below
      ('public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)', '052c43fcef6d48ba8e3461abe5e46d99'),
      ('public.apply_product_cost_basis_change_set(uuid,text,uuid,text)', '989066920a9c60e7d7fe42ab29a37c03'),
      ('public.write_product_pricing_history()', '90930912fe08ff935f5bc40cc2829f88'),
      -- called, unchanged
      ('public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)', 'cf93e5b93499e066dc74c3464ae7a6f4'),
      ('public._apply_product_cost_basis_change_set_serialized_inner(uuid,text,uuid,text)', '694620fb2a3b99f9572d3621ec034763'),
      ('public.apply_product_pricing_change_set(uuid,text,uuid,text)', 'ed143e0d7903f6979e643a8c99ceecae'),
      ('public._resolve_product_cost_basis_row(jsonb)', 'a32af747419947a746506e8b94703ae3'),
      ('public._product_cost_basis_row_required(text,text,jsonb,jsonb)', 'cfd9c96ed4ac2f96bc55beb3b3d75846'),
      ('public.is_admin()', 'f76bf61116c3bd52bd9c6ea125079b73'),
      ('public.check_idempotency_intent(text,text,uuid,text)', 'edc73be809069669e8441eba7acf443d'),
      ('public.save_idempotency(text,text,jsonb)', 'f600171c426e48c995f204c4dac3ff8b'),
      ('public._bind_replay_receipt_20261015(text,text,text)', '722ddd3b5d9174c598735cb321088f73'),
      ('public._replay_fingerprint_20261015(jsonb)', '68d5c0c62579349ced47c89e6b65ccaf'),
      ('public._cost_step2_try_uuid(text)', '12ea72c00fcf4de75309060436f082b5')
    ) AS v(sig, md5)
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'PRICE_SHEET_PREFLIGHT: % is missing', r.sig;
    END IF;
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_md5 IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'PRICE_SHEET_PREFLIGHT: % changed since 2026-10-25 (md5 %); re-read it before applying', r.sig, v_md5;
    END IF;
  END LOOP;

  IF to_regclass('public.product_margin_floors') IS NULL THEN
    RAISE EXCEPTION 'PRICE_SHEET_PREFLIGHT: product_margin_floors (20261025210000) must be applied first';
  END IF;
  IF to_regprocedure('public._assert_quote_prices_as_sent(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRICE_SHEET_PREFLIGHT: the sent-quote price lock (20261027040000) must be applied first';
  END IF;

  -- By name, every overload: to_regproc() is NULL when a name has several.
  IF to_regclass('public.pricing_change_set_warnings') IS NOT NULL
     OR to_regclass('public.pricing_change_set_approvals') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace
                   AND p.proname IN ('approve_pricing_change_set', '_pricing_change_set_warnings',
                                     '_pricing_change_set_warning_set',
                                     '_pricing_change_set_warning_inputs'))
     OR EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND ((table_name = 'cost_history' AND column_name IN ('price_source', 'old_rate_per_acre',
                          'new_rate_per_acre', 'old_rate_unit', 'new_rate_unit'))
                     OR (table_name = 'pricing_change_set_rows' AND column_name = 'price_source')
                     OR (table_name = 'product_info_change_set_rows' AND column_name IN ('change_reason', 'price_source')))) THEN
    RAISE EXCEPTION 'PRICE_SHEET_PREFLIGHT: an object this migration creates already exists';
  END IF;

  -- The history trigger this file re-bodies is the one AFTER UPDATE trigger on products.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.products'::regclass AND tgname = 'trigger_write_product_pricing_history'
                    AND tgfoid = 'public.write_product_pricing_history()'::regprocedure AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'PRICE_SHEET_PREFLIGHT: trigger_write_product_pricing_history is not the enabled history trigger';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- New columns (all nullable; existing rows keep NULL).
-- ---------------------------------------------------------------------------
ALTER TABLE public.cost_history
  ADD COLUMN price_source text,
  ADD COLUMN old_rate_per_acre numeric,
  ADD COLUMN new_rate_per_acre numeric,
  ADD COLUMN old_rate_unit text,
  ADD COLUMN new_rate_unit text;
COMMENT ON COLUMN public.cost_history.price_source IS
  'Where the new number came from (supplier, document, date), entered with the change (20261027050000). NULL for rows written before.';

ALTER TABLE public.pricing_change_set_rows
  ADD COLUMN price_source text;
ALTER TABLE public.product_info_change_set_rows
  ADD COLUMN change_reason text,
  ADD COLUMN price_source text;

-- ---------------------------------------------------------------------------
-- 1. Warnings.
-- ---------------------------------------------------------------------------
CREATE TABLE public.pricing_change_set_warnings (
  change_set_id uuid NOT NULL REFERENCES public.pricing_change_sets(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  warning_codes text[] NOT NULL CHECK (cardinality(warning_codes) > 0),
  details jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (change_set_id, product_id)
);
COMMENT ON TABLE public.pricing_change_set_warnings IS
  'The warnings a pricing preview showed, per product (20261027050000). Written once by preview_product_cost_basis_changes; RPC-only. No updated_at: rows never change.';
ALTER TABLE public.pricing_change_set_warnings ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_change_set_warnings_rpc_only ON public.pricing_change_set_warnings
  FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.pricing_change_set_warnings FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE TABLE public.pricing_change_set_approvals (
  change_set_id uuid PRIMARY KEY REFERENCES public.pricing_change_sets(id) ON DELETE CASCADE,
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  request_fingerprint text NOT NULL,
  -- {product_id: [codes]} exactly as acknowledged; '{}' when the change set had no warnings.
  warning_codes jsonb NOT NULL CHECK (jsonb_typeof(warning_codes) = 'object'),
  -- [{product_id, warning_codes, reason}] in product order.
  acknowledgements jsonb NOT NULL CHECK (jsonb_typeof(acknowledgements) = 'array'),
  source_file_name text CHECK (source_file_name IS NULL OR char_length(source_file_name) BETWEEN 1 AND 255),
  source_file_sha256 text CHECK (source_file_sha256 IS NULL OR source_file_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pricing_change_set_approvals IS
  'Approval receipt for a pricing change set (20261027050000): who approved which preview, when, every warning acknowledged with its reason, and (workbook) the uploaded file''s name and SHA-256. Apply requires it. RPC-only.';
ALTER TABLE public.pricing_change_set_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY pricing_change_set_approvals_rpc_only ON public.pricing_change_set_approvals
  FOR ALL TO PUBLIC USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.pricing_change_set_approvals FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
CREATE TRIGGER set_pricing_change_set_approvals_updated_at
  BEFORE UPDATE ON public.pricing_change_set_approvals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- One row per product in the change set whose new cost or prices need an acknowledgement.
CREATE FUNCTION public._pricing_change_set_warnings(p_change_set_id uuid)
RETURNS TABLE (product_id uuid, warning_codes text[], details jsonb)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  WITH changed AS (
    SELECT r.product_id,
           round(p.current_cost * 100)::bigint AS cost_before,
           r.output_cost_cents AS cost_after,
           -- What each tier's customer pays, as quotes price it (getQuoteTierPrice, save_quote): only a
           -- blank tier 2/3 price falls back to tier 1; a stated $0 is a real price, so a move to $0 warns.
           ARRAY[
             round(p.tier1_price * 100)::bigint,
             COALESCE(round(p.tier2_price * 100)::bigint, round(p.tier1_price * 100)::bigint),
             COALESCE(round(p.tier3_price * 100)::bigint, round(p.tier1_price * 100)::bigint)
           ] AS price_before,
           ARRAY[
             r.output_tier1_price_cents,
             COALESCE(r.output_tier2_price_cents, r.output_tier1_price_cents),
             COALESCE(r.output_tier3_price_cents, r.output_tier1_price_cents)
           ] AS price_after,
           -- The stored net margin the floor is defined against (20261025210000: under when
           -- tierN_margin < floor), not one recomputed from cent-rounded prices, which would flag a
           -- tier set exactly at its floor. Only a blank tier, which falls back to tier 1, takes tier 1's margin.
           ARRAY[
             r.output_tier1_margin,
             CASE WHEN r.output_tier2_price_cents IS NULL THEN r.output_tier1_margin ELSE r.output_tier2_margin END,
             CASE WHEN r.output_tier3_price_cents IS NULL THEN r.output_tier1_margin ELSE r.output_tier3_margin END
           ] AS margin_after,
           f.margin_floor
    FROM public.pricing_change_set_rows r
    JOIN public.products p ON p.id = r.product_id
    LEFT JOIN public.product_margin_floors f ON f.product_id = r.product_id
    WHERE r.change_set_id = p_change_set_id
  ), tiers AS (
    SELECT c.product_id, c.cost_before, c.cost_after, c.margin_floor, t.tier,
           c.price_before[t.tier] AS before_cents,
           c.price_after[t.tier] AS after_cents,
           c.margin_after[t.tier] AS margin_after
    FROM changed c CROSS JOIN generate_series(1, 3) AS t(tier)
  ), flags AS (
    SELECT t.product_id,
           max(t.cost_before) AS cost_before,
           max(t.cost_after) AS cost_after,
           max(t.margin_floor) AS margin_floor,
           -- More than 10% up or down, or a price appearing from nothing (exact numeric, no rounding or overflow).
           bool_or(t.after_cents IS DISTINCT FROM t.before_cents AND (
             COALESCE(t.before_cents, 0) = 0
             OR abs(COALESCE(t.after_cents, 0)::numeric - t.before_cents) * 10 > t.before_cents)) AS price_move,
           bool_or(t.after_cents IS NOT NULL AND t.after_cents < t.cost_after) AS below_cost,
           bool_or(t.margin_floor IS NOT NULL AND t.margin_after < t.margin_floor) AS under_floor,
           bool_or(t.after_cents IS DISTINCT FROM t.before_cents) AS price_changed,
           -- Cents go out as text, like the rest of the pricing boundary: a JSON number above 2^53 loses digits.
           jsonb_agg(jsonb_build_object(
             'tier', t.tier, 'before_cents', t.before_cents::text, 'after_cents', t.after_cents::text,
             'margin', t.margin_after
           ) ORDER BY t.tier) AS tiers
    FROM tiers t
    GROUP BY t.product_id
  ), open_quotes AS (
    -- The quotes that still re-price on their next save. A quote with a sent version keeps each saved
    -- line's price (the sent-quote price lock, 20261027040000: save_quote's v_price_locked), so it is out.
    -- save_quote prices a line at the quote's tier (CASE v_tier: 1, 2, anything else tier 3; blank = 1),
    -- so only a quote whose own tier's price moves counts: a tier 2 change cannot reach a tier 1 quote.
    SELECT qi.product_id,
           count(DISTINCT q.id) AS quote_count,
           (array_agg(DISTINCT q.quote_number ORDER BY q.quote_number))[1:10] AS quote_numbers
    FROM public.quote_items qi
    JOIN public.quotes q ON q.id = qi.quote_id
    JOIN tiers t ON t.product_id = qi.product_id
                AND t.tier = CASE COALESCE(q.tier, 1) WHEN 1 THEN 1 WHEN 2 THEN 2 ELSE 3 END
                AND t.after_cents IS DISTINCT FROM t.before_cents
    WHERE q.deleted_at IS NULL
      AND (q.status IN ('sent', 'revised') OR (q.status = 'accepted' AND q.is_planned))
      AND qi.price_override IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.quote_versions qv WHERE qv.quote_id = q.id)
    GROUP BY qi.product_id
  ), coded AS (
    SELECT f.*, q.quote_count, q.quote_numbers,
           array_remove(ARRAY[
             CASE WHEN f.cost_after IS DISTINCT FROM f.cost_before AND (
                    COALESCE(f.cost_before, 0) = 0
                    OR abs(f.cost_after::numeric - f.cost_before) * 10 > f.cost_before)
                  THEN 'COST_MOVE_OVER_10_PERCENT' END,
             CASE WHEN f.price_move THEN 'PRICE_MOVE_OVER_10_PERCENT' END,
             CASE WHEN f.below_cost THEN 'PRICE_BELOW_COST' END,
             CASE WHEN f.under_floor THEN 'MARGIN_UNDER_FLOOR' END,
             CASE WHEN f.price_changed AND COALESCE(q.quote_count, 0) > 0 THEN 'OPEN_SENT_QUOTE' END
           ], NULL) AS codes
    FROM flags f
    LEFT JOIN open_quotes q ON q.product_id = f.product_id
  )
  SELECT c.product_id, c.codes,
         jsonb_build_object(
           'cost_before_cents', c.cost_before::text,
           'cost_after_cents', c.cost_after::text,
           'margin_floor', c.margin_floor,
           'tiers', c.tiers,
           'open_quote_count', COALESCE(c.quote_count, 0),
           'open_quote_numbers', COALESCE(to_jsonb(c.quote_numbers), '[]'::jsonb)
         )
  FROM coded c
  WHERE cardinality(c.codes) > 0
  ORDER BY c.product_id
$function$;
REVOKE ALL ON FUNCTION public._pricing_change_set_warnings(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- The warning set as {product_id: {warning_codes, details}}, the form approval and apply compare with
-- the preview's: a floor raised from 15% to 50%, or a second sent quote, keeps the codes but is a change.
CREATE FUNCTION public._pricing_change_set_warning_set(p_change_set_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(jsonb_object_agg(w.product_id::text,
           jsonb_build_object('warning_codes', to_jsonb(w.warning_codes), 'details', w.details)), '{}'::jsonb)
  FROM public._pricing_change_set_warnings(p_change_set_id) w
$function$;
REVOKE ALL ON FUNCTION public._pricing_change_set_warning_set(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- What the warnings read besides the change set and the product row: each product's margin floor and
-- the open sent quotes holding it (the open_quotes rule above) with each quote's tier, as
-- {product_id: {margin_floor, open_quotes: [[quote id, tier], ...]}}. Apply reads it before and after
-- the pricing engine locks the products. Which tiers move is not re-derived here: by the second read
-- the engine has written the new prices. Every open quote is listed with its tier instead, so a quote
-- added, removed or moved to another tier in that moment refuses (fails safe: preview again).
CREATE FUNCTION public._pricing_change_set_warning_inputs(p_change_set_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(jsonb_object_agg(r.product_id::text, jsonb_build_object(
           'margin_floor', f.margin_floor,
           'open_quotes', COALESCE((
             SELECT jsonb_agg(DISTINCT jsonb_build_array(q.id, COALESCE(q.tier, 1))
                              ORDER BY jsonb_build_array(q.id, COALESCE(q.tier, 1)))
               FROM public.quote_items qi
               JOIN public.quotes q ON q.id = qi.quote_id
              WHERE qi.product_id = r.product_id
                AND q.deleted_at IS NULL
                AND (q.status IN ('sent', 'revised') OR (q.status = 'accepted' AND q.is_planned))
                AND qi.price_override IS NULL
                AND NOT EXISTS (SELECT 1 FROM public.quote_versions qv WHERE qv.quote_id = q.id)), '[]'::jsonb))), '{}'::jsonb)
  FROM (SELECT DISTINCT cr.product_id FROM public.pricing_change_set_rows cr
         WHERE cr.change_set_id = p_change_set_id) r
  LEFT JOIN public.product_margin_floors f ON f.product_id = r.product_id
$function$;
REVOKE ALL ON FUNCTION public._pricing_change_set_warning_inputs(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- ---------------------------------------------------------------------------
-- 4 + 1. The preview wrapper: the live body plus the source/reason check and the warnings.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_product_cost_basis_changes(
  p_source text,
  p_export_id uuid DEFAULT NULL,
  p_rows jsonb DEFAULT '[]'::jsonb,
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
  v_existing jsonb;
  v_request_fp text;
  v_pricing_result jsonb;
  v_change_set_id uuid;
  v_row record;
  v_product public.products%ROWTYPE;
  v_manifest public.pricing_workbook_export_rows%ROWTYPE;
  v_resolved jsonb;
  v_before jsonb;
  v_after jsonb;
  v_changes jsonb;
  v_rate_per_acre numeric;
  v_rate_unit text;
  v_required_basis_count integer;
  v_basis_change_count integer;
  v_info_change_count integer;
  v_ready_count integer;
  v_unchanged_count integer;
  v_conflict_count integer;
  v_invalid_count integer;
  v_final_status text;
  v_error_message text;
  v_error_code text;
  v_reason text;
  v_price_source text;
  v_needs_source boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'COST_BASIS_ROWS_REQUIRED';
  END IF;

  v_request_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'source', p_source,
    'export_id', p_export_id,
    'rows', p_rows
  )::text);
  v_existing := public.check_idempotency(
    p_idempotency_key, 'preview_product_cost_basis_changes'
  );
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_request_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  IF p_source = 'pricing_worksheet' AND NOT EXISTS (
    SELECT 1
    FROM public.pricing_workbook_exports e
    WHERE e.id = p_export_id
      AND e.created_by = v_actor
      AND e.status = 'active'
      AND e.expires_at > now()
      AND e.format_version = 'crx-product-pricing-phase2-v2'
  ) THEN
    RAISE EXCEPTION 'WORKBOOK_V2_EXPORT_REQUIRED';
  END IF;

  v_pricing_result := public.preview_product_pricing_changes(
    p_source,
    p_export_id,
    p_rows,
    v_actor,
    p_idempotency_key || ':pricing'
  );
  v_change_set_id := (v_pricing_result->>'change_set_id')::uuid;

  -- The Phase 1a engine remains the pricing authority. Mark its effects before
  -- layering the independent Product-information diff onto worksheet rows.
  UPDATE public.pricing_change_set_preview_rows preview_row
  SET effect = preview_row.effect || jsonb_build_object(
    'pricing_changed', preview_row.row_status = 'ready',
    'product_info_changes', '{}'::jsonb
  )
  WHERE preview_row.change_set_id = v_change_set_id
    AND preview_row.row_status IN ('ready', 'unchanged');

  IF p_source = 'pricing_worksheet' THEN
    FOR v_row IN
      SELECT submitted.value AS submitted_row, submitted.sequence,
             preview_row.product_id, preview_row.row_status
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY
        AS submitted(value, sequence)
      JOIN public.pricing_change_set_preview_rows preview_row
        ON preview_row.change_set_id = v_change_set_id
       AND preview_row.sequence = submitted.sequence
      WHERE preview_row.row_status IN ('ready', 'unchanged')
      ORDER BY submitted.sequence
    LOOP
      BEGIN
        IF NOT (
          v_row.submitted_row ? 'suggested_rate'
          AND v_row.submitted_row ? 'rate_per_acre'
          AND v_row.submitted_row ? 'rate_unit'
          AND v_row.submitted_row ? 'use_timing'
          AND v_row.submitted_row ? 'internal_notes'
          AND v_row.submitted_row ? 'quoting_notes'
        ) THEN
          RAISE EXCEPTION 'PRODUCT_INFO_FIELDS_REQUIRED';
        END IF;

        SELECT * INTO STRICT v_manifest
        FROM public.pricing_workbook_export_rows r
        WHERE r.export_id = p_export_id
          AND r.product_id = v_row.product_id;
        IF v_row.submitted_row->>'row_token' IS DISTINCT FROM v_manifest.row_token
           OR (v_row.submitted_row->>'row_version')::bigint
              IS DISTINCT FROM v_manifest.row_version THEN
          RAISE EXCEPTION 'WORKBOOK_IDENTITY_OR_BASELINE_TAMPERED';
        END IF;

        SELECT * INTO STRICT v_product
        FROM public.products p
        WHERE p.id = v_row.product_id;
        IF v_product.pricing_version IS DISTINCT FROM v_manifest.row_version THEN
          RAISE EXCEPTION 'PRICING_ROW_CONFLICT';
        END IF;

        IF NULLIF(btrim(v_row.submitted_row->>'rate_per_acre'), '') IS NULL THEN
          v_rate_per_acre := NULL;
        ELSE
          v_rate_per_acre := (v_row.submitted_row->>'rate_per_acre')::numeric;
          IF v_rate_per_acre::text IN ('NaN', 'Infinity', '-Infinity')
             OR v_rate_per_acre < 0 THEN
            RAISE EXCEPTION 'PRODUCT_RATE_PER_ACRE_INVALID';
          END IF;
        END IF;
        v_rate_unit := NULLIF(btrim(v_row.submitted_row->>'rate_unit'), '');

        -- An unchanged legacy unit is grandfathered. Every new value must be a
        -- live frozen unit key compatible with the Product form (or type both).
        IF v_rate_unit IS DISTINCT FROM v_manifest.rate_unit_snapshot
           AND v_rate_unit IS NOT NULL
           AND NOT EXISTS (
             SELECT 1
             FROM public.unit_conversions uc
             WHERE lower(uc.unit) = lower(v_rate_unit)
               AND (
                 v_product.product_form IS NULL
                 OR uc.unit_type = v_product.product_form
                 OR uc.unit_type = 'both'
               )
           ) THEN
          RAISE EXCEPTION 'PRODUCT_RATE_UNIT_INVALID';
        END IF;

        v_before := jsonb_build_object(
          'suggested_rate', NULLIF(btrim(v_manifest.suggested_rate_snapshot), ''),
          'rate_per_acre', v_manifest.rate_per_acre_snapshot,
          'rate_unit', NULLIF(btrim(v_manifest.rate_unit_snapshot), ''),
          'use_timing', NULLIF(btrim(v_manifest.use_timing_snapshot), ''),
          'internal_notes', NULLIF(btrim(v_manifest.internal_notes_snapshot), ''),
          'quoting_notes', NULLIF(btrim(v_manifest.quoting_notes_snapshot), '')
        );
        v_after := jsonb_build_object(
          'suggested_rate', NULLIF(btrim(v_row.submitted_row->>'suggested_rate'), ''),
          'rate_per_acre', v_rate_per_acre,
          'rate_unit', v_rate_unit,
          'use_timing', NULLIF(btrim(v_row.submitted_row->>'use_timing'), ''),
          'internal_notes', NULLIF(btrim(v_row.submitted_row->>'internal_notes'), ''),
          'quoting_notes', NULLIF(btrim(v_row.submitted_row->>'quoting_notes'), '')
        );
        v_changes := '{}'::jsonb;
        IF v_before->'suggested_rate' IS DISTINCT FROM v_after->'suggested_rate' THEN
          v_changes := v_changes || jsonb_build_object(
            'suggested_rate', jsonb_build_object(
              'before', v_before->'suggested_rate', 'after', v_after->'suggested_rate'
            )
          );
        END IF;
        IF v_before->'rate_per_acre' IS DISTINCT FROM v_after->'rate_per_acre' THEN
          v_changes := v_changes || jsonb_build_object(
            'rate_per_acre', jsonb_build_object(
              'before', v_before->'rate_per_acre', 'after', v_after->'rate_per_acre'
            )
          );
        END IF;
        IF v_before->'rate_unit' IS DISTINCT FROM v_after->'rate_unit' THEN
          v_changes := v_changes || jsonb_build_object(
            'rate_unit', jsonb_build_object(
              'before', v_before->'rate_unit', 'after', v_after->'rate_unit'
            )
          );
        END IF;
        IF v_before->'use_timing' IS DISTINCT FROM v_after->'use_timing' THEN
          v_changes := v_changes || jsonb_build_object(
            'use_timing', jsonb_build_object(
              'before', v_before->'use_timing', 'after', v_after->'use_timing'
            )
          );
        END IF;
        IF v_before->'internal_notes' IS DISTINCT FROM v_after->'internal_notes' THEN
          v_changes := v_changes || jsonb_build_object(
            'internal_notes', jsonb_build_object(
              'before', v_before->'internal_notes', 'after', v_after->'internal_notes'
            )
          );
        END IF;
        IF v_before->'quoting_notes' IS DISTINCT FROM v_after->'quoting_notes' THEN
          v_changes := v_changes || jsonb_build_object(
            'quoting_notes', jsonb_build_object(
              'before', v_before->'quoting_notes', 'after', v_after->'quoting_notes'
            )
          );
        END IF;

        IF v_changes <> '{}'::jsonb THEN
          INSERT INTO public.product_info_change_set_rows(
            change_set_id, product_id, expected_version,
            before_values, after_values, changes, output_fingerprint
          ) VALUES (
            v_change_set_id, v_product.id, v_manifest.row_version,
            v_before, v_after, v_changes, md5(v_after::text)
          );

          -- Rate edits alter the trigger-derived per-acre display even when
          -- cost and tier dollars are unchanged. Rebind the retained pricing
          -- output and preview effect to the approved after-rate values.
          UPDATE public.pricing_change_set_rows pricing_row
          SET output_tier1_price_per_acre_cents = CASE
                WHEN public.product_price_per_acre(
                  pricing_row.output_tier1_price_cents::numeric / 100,
                  v_rate_per_acre, v_rate_unit,
                  v_product.inventory_unit, v_product.unit_size
                ) IS NULL THEN NULL
                ELSE round(public.product_price_per_acre(
                  pricing_row.output_tier1_price_cents::numeric / 100,
                  v_rate_per_acre, v_rate_unit,
                  v_product.inventory_unit, v_product.unit_size
                ) * 100)::bigint END,
              output_tier2_price_per_acre_cents = CASE
                WHEN public.product_price_per_acre(
                  COALESCE(NULLIF(pricing_row.output_tier2_price_cents, 0),
                           pricing_row.output_tier1_price_cents)::numeric / 100,
                  v_rate_per_acre, v_rate_unit,
                  v_product.inventory_unit, v_product.unit_size
                ) IS NULL THEN NULL
                ELSE round(public.product_price_per_acre(
                  COALESCE(NULLIF(pricing_row.output_tier2_price_cents, 0),
                           pricing_row.output_tier1_price_cents)::numeric / 100,
                  v_rate_per_acre, v_rate_unit,
                  v_product.inventory_unit, v_product.unit_size
                ) * 100)::bigint END,
              output_tier3_price_per_acre_cents = CASE
                WHEN public.product_price_per_acre(
                  COALESCE(NULLIF(pricing_row.output_tier3_price_cents, 0),
                           pricing_row.output_tier1_price_cents)::numeric / 100,
                  v_rate_per_acre, v_rate_unit,
                  v_product.inventory_unit, v_product.unit_size
                ) IS NULL THEN NULL
                ELSE round(public.product_price_per_acre(
                  COALESCE(NULLIF(pricing_row.output_tier3_price_cents, 0),
                           pricing_row.output_tier1_price_cents)::numeric / 100,
                  v_rate_per_acre, v_rate_unit,
                  v_product.inventory_unit, v_product.unit_size
                ) * 100)::bigint END
          WHERE pricing_row.change_set_id = v_change_set_id
            AND pricing_row.product_id = v_product.id;

          UPDATE public.pricing_change_set_rows pricing_row
          SET output_fingerprint = md5(jsonb_build_object(
            'cost_cents', pricing_row.output_cost_cents,
            'tier1_margin', pricing_row.output_tier1_margin,
            'tier2_margin', pricing_row.output_tier2_margin,
            'tier3_margin', pricing_row.output_tier3_margin,
            'tier1_price_cents', pricing_row.output_tier1_price_cents,
            'tier2_price_cents', pricing_row.output_tier2_price_cents,
            'tier3_price_cents', pricing_row.output_tier3_price_cents,
            'tier1_gross_margin', pricing_row.output_tier1_gross_margin,
            'tier2_gross_margin', pricing_row.output_tier2_gross_margin,
            'tier3_gross_margin', pricing_row.output_tier3_gross_margin,
            'tier1_price_per_acre_cents', pricing_row.output_tier1_price_per_acre_cents,
            'tier2_price_per_acre_cents', pricing_row.output_tier2_price_per_acre_cents,
            'tier3_price_per_acre_cents', pricing_row.output_tier3_price_per_acre_cents
          )::text)
          WHERE pricing_row.change_set_id = v_change_set_id
            AND pricing_row.product_id = v_product.id;

          -- Bind the information row to the derived per-acre values shown in
          -- preview too. This detects conversion-factor drift even when the row
          -- has no pricing delta (and therefore no pricing output fingerprint).
          UPDATE public.product_info_change_set_rows info_row
          SET output_fingerprint = md5(jsonb_build_object(
            'after_values', info_row.after_values,
            'tier1_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
              COALESCE(pricing_row.output_tier1_price_cents::numeric / 100,
                       v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
              COALESCE(pricing_row.output_tier1_price_cents::numeric / 100,
                       v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) * 100)::bigint END,
            'tier2_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
              COALESCE(NULLIF(pricing_row.output_tier2_price_cents, 0)::numeric / 100,
                       NULLIF(pricing_row.output_tier1_price_cents, 0)::numeric / 100,
                       NULLIF(v_product.tier2_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
              COALESCE(NULLIF(pricing_row.output_tier2_price_cents, 0)::numeric / 100,
                       NULLIF(pricing_row.output_tier1_price_cents, 0)::numeric / 100,
                       NULLIF(v_product.tier2_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) * 100)::bigint END,
            'tier3_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
              COALESCE(NULLIF(pricing_row.output_tier3_price_cents, 0)::numeric / 100,
                       NULLIF(pricing_row.output_tier1_price_cents, 0)::numeric / 100,
                       NULLIF(v_product.tier3_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
              COALESCE(NULLIF(pricing_row.output_tier3_price_cents, 0)::numeric / 100,
                       NULLIF(pricing_row.output_tier1_price_cents, 0)::numeric / 100,
                       NULLIF(v_product.tier3_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) * 100)::bigint END
          )::text)
          FROM public.pricing_change_set_rows pricing_row
          WHERE info_row.change_set_id = v_change_set_id
            AND info_row.product_id = v_product.id
            AND pricing_row.change_set_id = info_row.change_set_id
            AND pricing_row.product_id = info_row.product_id;

          -- Info-only rows have no pricing row to join; bind their currently
          -- approved tier prices through the same fingerprint shape.
          UPDATE public.product_info_change_set_rows info_row
          SET output_fingerprint = md5(jsonb_build_object(
            'after_values', info_row.after_values,
            'tier1_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
              v_product.tier1_price, v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
              v_product.tier1_price, v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) * 100)::bigint END,
            'tier2_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
              COALESCE(NULLIF(v_product.tier2_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
              COALESCE(NULLIF(v_product.tier2_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) * 100)::bigint END,
            'tier3_price_per_acre_cents', CASE WHEN public.product_price_per_acre(
              COALESCE(NULLIF(v_product.tier3_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) IS NULL THEN NULL ELSE round(public.product_price_per_acre(
              COALESCE(NULLIF(v_product.tier3_price, 0), v_product.tier1_price),
              v_rate_per_acre, v_rate_unit,
              v_product.inventory_unit, v_product.unit_size
            ) * 100)::bigint END
          )::text)
          WHERE info_row.change_set_id = v_change_set_id
            AND info_row.product_id = v_product.id
            AND NOT EXISTS (
              SELECT 1 FROM public.pricing_change_set_rows pricing_row
              WHERE pricing_row.change_set_id = info_row.change_set_id
                AND pricing_row.product_id = info_row.product_id
            );

          UPDATE public.pricing_change_set_preview_rows
          SET row_status = 'ready',
              effect = effect || jsonb_build_object(
                'product_info_changes', v_changes,
                'tier1_price_per_acre_cents', CASE
                  WHEN public.product_price_per_acre(
                    (effect->>'tier1_price')::numeric,
                    v_rate_per_acre, v_rate_unit,
                    v_product.inventory_unit, v_product.unit_size
                  ) IS NULL THEN NULL
                  ELSE round(public.product_price_per_acre(
                    (effect->>'tier1_price')::numeric,
                    v_rate_per_acre, v_rate_unit,
                    v_product.inventory_unit, v_product.unit_size
                  ) * 100)::bigint END,
                'tier2_price_per_acre_cents', CASE
                  WHEN public.product_price_per_acre(
                    COALESCE(NULLIF((effect->>'tier2_price')::numeric, 0),
                             (effect->>'tier1_price')::numeric),
                    v_rate_per_acre, v_rate_unit,
                    v_product.inventory_unit, v_product.unit_size
                  ) IS NULL THEN NULL
                  ELSE round(public.product_price_per_acre(
                    COALESCE(NULLIF((effect->>'tier2_price')::numeric, 0),
                             (effect->>'tier1_price')::numeric),
                    v_rate_per_acre, v_rate_unit,
                    v_product.inventory_unit, v_product.unit_size
                  ) * 100)::bigint END,
                'tier3_price_per_acre_cents', CASE
                  WHEN public.product_price_per_acre(
                    COALESCE(NULLIF((effect->>'tier3_price')::numeric, 0),
                             (effect->>'tier1_price')::numeric),
                    v_rate_per_acre, v_rate_unit,
                    v_product.inventory_unit, v_product.unit_size
                  ) IS NULL THEN NULL
                  ELSE round(public.product_price_per_acre(
                    COALESCE(NULLIF((effect->>'tier3_price')::numeric, 0),
                             (effect->>'tier1_price')::numeric),
                    v_rate_per_acre, v_rate_unit,
                    v_product.inventory_unit, v_product.unit_size
                  ) * 100)::bigint END
              )
          WHERE change_set_id = v_change_set_id
            AND sequence = v_row.sequence;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
        v_error_code := CASE
          WHEN v_error_message ~ '^[A-Z0-9_]+$' THEN v_error_message
          ELSE 'PRODUCT_INFO_ROW_INVALID'
        END;
        UPDATE public.pricing_change_set_preview_rows
        SET row_status = CASE WHEN v_error_code = 'PRICING_ROW_CONFLICT'
                              THEN 'conflict' ELSE 'invalid' END,
            error_code = v_error_code,
            effect = NULL
        WHERE change_set_id = v_change_set_id
          AND sequence = v_row.sequence;
      END;
    END LOOP;
  END IF;

  -- Every row that changes a price, the cost or the per-acre rate must say where the new number came
  -- from and why (To-Do 0.1; pricing plan section 8, gap 4): no generic default. Both are kept on the
  -- change-set rows, and the history trigger copies them into cost_history.
  FOR v_row IN
    SELECT preview_row.sequence, preview_row.product_id, preview_row.submitted_row
    FROM public.pricing_change_set_preview_rows preview_row
    WHERE preview_row.change_set_id = v_change_set_id
      AND preview_row.row_status = 'ready'
    ORDER BY preview_row.sequence
  LOOP
    v_reason := NULLIF(btrim(v_row.submitted_row->>'change_reason'), '');
    v_price_source := NULLIF(btrim(v_row.submitted_row->>'price_source'), '');
    v_needs_source := EXISTS (
        SELECT 1 FROM public.pricing_change_set_rows r
        WHERE r.change_set_id = v_change_set_id AND r.product_id = v_row.product_id
      ) OR EXISTS (
        SELECT 1 FROM public.product_info_change_set_rows i
        WHERE i.change_set_id = v_change_set_id AND i.product_id = v_row.product_id
          AND (i.changes ? 'rate_per_acre' OR i.changes ? 'rate_unit')
      );
    v_error_code := CASE
      WHEN v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN 'PRICING_REASON_TOO_LONG'
      WHEN v_price_source IS NOT NULL AND char_length(v_price_source) > 200 THEN 'PRICING_SOURCE_TOO_LONG'
      WHEN v_needs_source AND v_reason IS NULL THEN 'PRICING_REASON_REQUIRED'
      WHEN v_needs_source AND v_price_source IS NULL THEN 'PRICING_SOURCE_REQUIRED'
    END;
    IF v_error_code IS NOT NULL THEN
      UPDATE public.pricing_change_set_preview_rows
      SET row_status = 'invalid', error_code = v_error_code, effect = NULL
      WHERE change_set_id = v_change_set_id AND sequence = v_row.sequence;
    ELSE
      UPDATE public.pricing_change_set_rows
      SET change_reason = v_reason, price_source = v_price_source
      WHERE change_set_id = v_change_set_id AND product_id = v_row.product_id;
      UPDATE public.product_info_change_set_rows
      SET change_reason = v_reason, price_source = v_price_source
      WHERE change_set_id = v_change_set_id AND product_id = v_row.product_id;
    END IF;
  END LOOP;

  -- Resolve cost basis only for actual pricing changes or an explicit basis
  -- selection. Info-only rows create no synthetic/no-op basis record.
  FOR v_row IN
    SELECT submitted.value AS submitted_row, preview_row.*
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY
      AS submitted(value, sequence)
    JOIN public.pricing_change_set_preview_rows preview_row
      ON preview_row.change_set_id = v_change_set_id
     AND preview_row.sequence = submitted.sequence
    WHERE public._product_cost_basis_row_required(
      p_source,
      preview_row.row_status,
      submitted.value,
      preview_row.effect
    )
    ORDER BY submitted.sequence
  LOOP
    v_resolved := public._resolve_product_cost_basis_row(v_row.submitted_row);
    INSERT INTO public.product_cost_basis_change_rows(
      pricing_change_set_id, product_id, expected_version,
      expected_active_basis_id, basis_type,
      cost_cents, supplier_price_observation_id, purchase_order_item_id,
      selection_source, reason, force_selection
    ) VALUES (
      v_change_set_id,
      (v_resolved->>'product_id')::uuid,
      (v_resolved->>'expected_version')::bigint,
      (SELECT active.id
       FROM public.product_cost_basis active
       WHERE active.product_id = (v_resolved->>'product_id')::uuid
         AND active.effective_to IS NULL),
      v_resolved->>'basis_type',
      (v_resolved->>'cost_cents')::bigint,
      NULLIF(v_resolved->>'supplier_price_observation_id', '')::uuid,
      NULLIF(v_resolved->>'purchase_order_item_id', '')::uuid,
      v_resolved->>'selection_source',
      v_resolved->>'reason',
      (v_resolved->>'force_selection')::boolean
    )
    ON CONFLICT (pricing_change_set_id, product_id) DO NOTHING;
  END LOOP;

  SELECT count(*)::integer INTO v_required_basis_count
  FROM public.pricing_change_set_preview_rows preview_row
  WHERE preview_row.change_set_id = v_change_set_id
    AND public._product_cost_basis_row_required(
      p_source,
      preview_row.row_status,
      preview_row.submitted_row,
      preview_row.effect
    );
  IF (SELECT count(*) FROM public.product_cost_basis_change_rows
      WHERE pricing_change_set_id = v_change_set_id)
     IS DISTINCT FROM v_required_basis_count THEN
    RAISE EXCEPTION 'COST_BASIS_CHANGE_SET_SHAPE_INVALID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_cost_basis_change_rows r
    JOIN public.pricing_change_set_preview_rows preview_row
      ON preview_row.change_set_id = r.pricing_change_set_id
     AND preview_row.product_id = r.product_id
    WHERE r.pricing_change_set_id = v_change_set_id
      AND public._resolve_product_cost_basis_row(preview_row.submitted_row)
          IS DISTINCT FROM jsonb_build_object(
            'product_id', r.product_id,
            'expected_version', r.expected_version,
            'basis_type', r.basis_type,
            'cost_cents', r.cost_cents,
            'supplier_price_observation_id', r.supplier_price_observation_id,
            'purchase_order_item_id', r.purchase_order_item_id,
            'selection_source', r.selection_source,
            'reason', r.reason,
            'force_selection', r.force_selection
          )
  ) THEN
    RAISE EXCEPTION 'COST_BASIS_CHANGE_SET_DRIFT';
  END IF;

  SELECT count(*)::integer INTO v_basis_change_count
  FROM public.product_cost_basis_change_rows r
  JOIN public.products p ON p.id = r.product_id
  LEFT JOIN public.product_cost_basis active
    ON active.product_id = r.product_id AND active.effective_to IS NULL
  WHERE r.pricing_change_set_id = v_change_set_id
    AND (
      round(p.current_cost::numeric * 100)::bigint IS DISTINCT FROM r.cost_cents
      OR r.force_selection
      OR active.id IS NULL
    );

  SELECT count(*)::integer INTO v_info_change_count
  FROM public.product_info_change_set_rows
  WHERE change_set_id = v_change_set_id;
  SELECT
    count(*) FILTER (WHERE row_status = 'ready')::integer,
    count(*) FILTER (WHERE row_status = 'unchanged')::integer,
    count(*) FILTER (WHERE row_status = 'conflict')::integer,
    count(*) FILTER (WHERE row_status = 'invalid')::integer
  INTO v_ready_count, v_unchanged_count, v_conflict_count, v_invalid_count
  FROM public.pricing_change_set_preview_rows
  WHERE change_set_id = v_change_set_id;

  v_final_status := CASE
    WHEN v_conflict_count > 0 OR v_invalid_count > 0 THEN 'invalid'
    WHEN v_ready_count > 0 THEN 'previewed'
    ELSE 'no_changes'
  END;
  UPDATE public.pricing_change_sets
  SET row_count = v_ready_count, status = v_final_status
  WHERE id = v_change_set_id;

  -- The exact warning set this preview showed; approval must acknowledge each one, and the
  -- approval and apply steps recompute it and refuse if it changed (To-Do 0.1).
  IF v_final_status = 'previewed' THEN
    INSERT INTO public.pricing_change_set_warnings (change_set_id, product_id, warning_codes, details)
    SELECT v_change_set_id, w.product_id, w.warning_codes, w.details
    FROM public._pricing_change_set_warnings(v_change_set_id) w
    ON CONFLICT (change_set_id, product_id) DO NOTHING;
  END IF;

  SELECT jsonb_build_object(
    'change_set_id', c.id,
    'request_fingerprint', c.request_fingerprint,
    'source', c.source,
    'status', c.status,
    'expires_at', c.expires_at,
    'submitted_row_count', c.submitted_row_count,
    'ready_count', v_ready_count,
    'unchanged_count', v_unchanged_count,
    'conflict_count', v_conflict_count,
    'invalid_count', v_invalid_count,
    'pricing_change_count', (
      SELECT count(*) FROM public.pricing_change_set_rows r
      WHERE r.change_set_id = c.id
    ),
    'product_info_change_count', v_info_change_count,
    'basis_change_count', v_basis_change_count,
    'warnings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'product_id', w.product_id, 'warning_codes', to_jsonb(w.warning_codes), 'details', w.details
      ) ORDER BY w.product_id)
      FROM public.pricing_change_set_warnings w
      WHERE w.change_set_id = c.id
    ), '[]'::jsonb),
    'apply_allowed', (
      c.status = 'previewed'
      OR (c.status = 'no_changes' AND v_basis_change_count > 0)
    ),
    'rows', (
      SELECT jsonb_agg(to_jsonb(r) - 'change_set_id' ORDER BY r.sequence)
      FROM public.pricing_change_set_preview_rows r
      WHERE r.change_set_id = c.id
    )
  ) INTO v_pricing_result
  FROM public.pricing_change_sets c
  WHERE c.id = v_change_set_id;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'preview_product_cost_basis_changes',
    jsonb_build_object(
      'actor_id', v_actor,
      'request_fingerprint', v_request_fp,
      'response', v_pricing_result
    )
  );
  RETURN v_pricing_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. approve_pricing_change_set: the approval receipt.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.approve_pricing_change_set(
  p_change_set_id uuid,
  p_request_fingerprint text,
  p_acknowledgements jsonb DEFAULT '[]'::jsonb,
  p_source_file jsonb DEFAULT NULL,
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
  v_fingerprint text;
  v_replay jsonb;
  v_change_set public.pricing_change_sets%ROWTYPE;
  v_stored jsonb;
  v_stored_set jsonb;
  v_ack jsonb;
  v_product_id uuid;
  v_codes jsonb;
  v_reason text;
  v_acks jsonb := '[]'::jsonb;
  v_file_name text;
  v_file_sha text;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: approve_pricing_change_set requires p_idempotency_key'
      USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()' USING ERRCODE = 'P0001';
  END IF;
  -- The sibling pricing functions' admin gate and token.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'ADMIN_REQUIRED';
  END IF;
  IF p_request_fingerprint IS NULL OR btrim(p_request_fingerprint) = '' THEN
    RAISE EXCEPTION 'CHANGE_SET_FINGERPRINT_REQUIRED';
  END IF;
  IF jsonb_typeof(COALESCE(p_acknowledgements, 'null'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'PRICING_ACK_INVALID: acknowledgements must be a list';
  END IF;

  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'change_set_id', p_change_set_id,
    'request_fingerprint', p_request_fingerprint,
    'acknowledgements', p_acknowledgements,
    'source_file', p_source_file
  ));
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'approve_pricing_change_set', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  SELECT * INTO v_change_set FROM public.pricing_change_sets WHERE id = p_change_set_id FOR UPDATE;
  IF NOT FOUND OR v_change_set.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'CHANGE_SET_NOT_FOUND';
  END IF;
  IF v_change_set.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
    RAISE EXCEPTION 'CHANGE_SET_FINGERPRINT_MISMATCH';
  END IF;
  IF v_change_set.status = 'applied' THEN
    RAISE EXCEPTION 'CHANGE_SET_ALREADY_APPLIED';
  END IF;
  IF v_change_set.status NOT IN ('previewed', 'no_changes') OR v_change_set.expires_at <= now() THEN
    RAISE EXCEPTION 'CHANGE_SET_INVALID_OR_EXPIRED';
  END IF;
  -- Every pricing row, and every info row that changes the per-acre rate, of a preview made under this
  -- file carries a source (the preview refuses one without), so a row with none was previewed before
  -- this migration: it must be previewed again.
  IF EXISTS (SELECT 1 FROM public.pricing_change_set_rows r
             WHERE r.change_set_id = p_change_set_id AND r.price_source IS NULL)
     OR EXISTS (SELECT 1 FROM public.product_info_change_set_rows i
                WHERE i.change_set_id = p_change_set_id AND i.price_source IS NULL
                  AND (i.changes ? 'rate_per_acre' OR i.changes ? 'rate_unit')) THEN
    RAISE EXCEPTION 'PRICING_SOURCE_REQUIRED: this preview was made before sources were required; preview it again';
  END IF;

  -- The warnings must be the ones the preview showed, codes and details: a floor or an open quote may
  -- have changed since.
  SELECT COALESCE(jsonb_object_agg(w.product_id::text, to_jsonb(w.warning_codes)), '{}'::jsonb),
         COALESCE(jsonb_object_agg(w.product_id::text, jsonb_build_object(
           'warning_codes', to_jsonb(w.warning_codes), 'details', w.details)), '{}'::jsonb)
    INTO v_stored, v_stored_set
    FROM public.pricing_change_set_warnings w
   WHERE w.change_set_id = p_change_set_id;
  IF public._pricing_change_set_warning_set(p_change_set_id) IS DISTINCT FROM v_stored_set THEN
    RAISE EXCEPTION 'PRICING_WARNINGS_CHANGED: the warnings for this change set changed after the preview; preview it again';
  END IF;

  -- Exactly one acknowledgement per warned product, naming exactly its codes, with a reason.
  FOR v_ack IN SELECT e.value FROM jsonb_array_elements(p_acknowledgements) AS e(value)
  LOOP
    IF jsonb_typeof(v_ack) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_ack->'warning_codes') IS DISTINCT FROM 'array'
       OR jsonb_typeof(v_ack->'reason') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'PRICING_ACK_INVALID: each acknowledgement is {product_id, warning_codes, reason}';
    END IF;
    v_product_id := public._cost_step2_try_uuid(v_ack->>'product_id');
    IF v_product_id IS NULL OR NOT (v_stored ? v_product_id::text) THEN
      RAISE EXCEPTION 'PRICING_ACK_INVALID: an acknowledgement names a product without warnings';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_acks) AS a(value) WHERE a.value->>'product_id' = v_product_id::text) THEN
      RAISE EXCEPTION 'PRICING_ACK_INVALID: each product is acknowledged once';
    END IF;
    -- Order-insensitive: the same codes in any order.
    SELECT COALESCE(jsonb_agg(c.value ORDER BY c.value), '[]'::jsonb) INTO v_codes
      FROM (SELECT DISTINCT e.value FROM jsonb_array_elements_text(v_ack->'warning_codes') AS e(value)) c;
    IF v_codes IS DISTINCT FROM (
         SELECT jsonb_agg(c.value ORDER BY c.value)
           FROM jsonb_array_elements_text(v_stored->(v_product_id::text)) AS c(value)) THEN
      RAISE EXCEPTION 'PRICING_ACK_INVALID: an acknowledgement does not name exactly that product''s warnings';
    END IF;
    v_reason := NULLIF(btrim(v_ack->>'reason'), '');
    IF v_reason IS NULL OR char_length(v_reason) > 500 THEN
      RAISE EXCEPTION 'PRICING_ACK_REASON_REQUIRED: say why each warning is acceptable (1-500 characters)';
    END IF;
    v_acks := v_acks || jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id, 'warning_codes', v_stored->(v_product_id::text), 'reason', v_reason));
  END LOOP;
  IF jsonb_array_length(v_acks) <> (SELECT count(*) FROM jsonb_object_keys(v_stored)) THEN
    RAISE EXCEPTION 'PRICING_WARNINGS_UNACKNOWLEDGED: every warning must be acknowledged with a reason';
  END IF;
  SELECT COALESCE(jsonb_agg(a.value ORDER BY a.value->>'product_id'), '[]'::jsonb) INTO v_acks
    FROM jsonb_array_elements(v_acks) AS a(value);

  -- A workbook change set names the file that was reviewed.
  IF p_source_file IS NOT NULL THEN
    IF jsonb_typeof(p_source_file) IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_source_file->'name') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_source_file->'sha256') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'PRICING_SOURCE_FILE_INVALID: the file is {name, sha256}';
    END IF;
    v_file_name := NULLIF(btrim(p_source_file->>'name'), '');
    v_file_sha := lower(p_source_file->>'sha256');
    IF v_file_name IS NULL OR char_length(v_file_name) > 255 OR v_file_sha !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'PRICING_SOURCE_FILE_INVALID: the file is {name, sha256}';
    END IF;
  END IF;
  IF v_change_set.source = 'pricing_worksheet' AND v_file_name IS NULL THEN
    RAISE EXCEPTION 'PRICING_SOURCE_FILE_REQUIRED: a workbook approval names the uploaded file';
  END IF;

  -- Re-approving an unapplied preview (a corrected reason) replaces its receipt.
  INSERT INTO public.pricing_change_set_approvals (
    change_set_id, approved_by, approved_at, request_fingerprint, warning_codes, acknowledgements,
    source_file_name, source_file_sha256
  ) VALUES (
    p_change_set_id, v_actor, now(), p_request_fingerprint, v_stored, v_acks, v_file_name, v_file_sha
  )
  ON CONFLICT (change_set_id) DO UPDATE
    SET approved_by = EXCLUDED.approved_by,
        approved_at = EXCLUDED.approved_at,
        request_fingerprint = EXCLUDED.request_fingerprint,
        warning_codes = EXCLUDED.warning_codes,
        acknowledgements = EXCLUDED.acknowledgements,
        source_file_name = EXCLUDED.source_file_name,
        source_file_sha256 = EXCLUDED.source_file_sha256;

  v_result := jsonb_build_object(
    'success', true, 'status', 'approved', 'change_set_id', p_change_set_id,
    'acknowledged_count', jsonb_array_length(v_acks));
  PERFORM public.save_idempotency(p_idempotency_key, 'approve_pricing_change_set', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'approve_pricing_change_set', v_fingerprint);
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.approve_pricing_change_set(uuid, text, jsonb, jsonb, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.approve_pricing_change_set(uuid, text, jsonb, jsonb, uuid, text) FROM PUBLIC, anon, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.approve_pricing_change_set(uuid, text, jsonb, jsonb, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.approve_pricing_change_set(uuid, text, jsonb, jsonb, uuid, text) IS
  'Admin-only approval receipt for a pricing preview: every warning acknowledged with a reason, the workbook file named; apply_product_cost_basis_change_set requires it. Key required, bound to caller + request.';

-- ---------------------------------------------------------------------------
-- 3. The apply wrapper: the live body plus the approval check.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_product_cost_basis_change_set(
  p_change_set_id uuid,
  p_request_fingerprint text,
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
  v_existing jsonb;
  v_idem_fp text;
  v_result jsonb;
  v_status text;
  v_approval public.pricing_change_set_approvals%ROWTYPE;
  v_stored_set jsonb;
  v_inputs jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_request_fingerprint IS NULL OR btrim(p_request_fingerprint) = '' THEN
    RAISE EXCEPTION 'CHANGE_SET_FINGERPRINT_REQUIRED';
  END IF;

  v_idem_fp := md5(jsonb_build_object(
    'actor_id', v_actor,
    'change_set_id', p_change_set_id,
    'request_fingerprint', p_request_fingerprint
  )::text);
  v_existing := public.check_idempotency(
    p_idempotency_key, 'apply_product_cost_basis_change_set'
  );
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'actor_id' IS DISTINCT FROM v_actor::text
       OR v_existing->>'request_fingerprint' IS DISTINCT FROM v_idem_fp THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_MISMATCH';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- One transaction-scoped lock is intentionally coarse: pricing workbooks are
  -- an admin batch workflow, and deterministic correctness is worth serializing
  -- the rare apply operation.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx_apply_product_cost_basis_change_set', 0)
  );
  -- Applies only as approved (To-Do 0.1): an approval by this admin of this exact preview, whose
  -- warnings (codes and details, which approval matched to the preview's) still equal the warnings
  -- recomputed now (a margin floor or an open sent quote can change after the preview). An
  -- already-applied set goes on to the inner engine, which replays its stored result or refuses a
  -- different key; a missing one gets its CHANGE_SET_NOT_FOUND.
  -- The products are not locked before this check: that would reverse the inner engine's
  -- evidence-before-product lock order (20260722064814) and could deadlock a supplier-price correction
  -- or a receipt. Instead the warnings' other inputs (floors, open sent quotes) are read again after the
  -- engine has locked and updated the products. A floor writer locks the product row
  -- (set_product_margin_floors, FOR NO KEY UPDATE), so a floor change either shows in that second read
  -- or waits for this commit. The second read covers every product of the set, so an unrelated floor
  -- or quote change in that moment also refuses (fails safe: preview again). KNOWN GAP, accepted: a
  -- quote change between that read and the commit is not seen, since none takes a product lock
  -- (sent, revised, planned-accepted, restored, or a line's manual price cleared); nor is a floor
  -- written outside set_product_margin_floors. The sent-quote price lock (20261027040000) narrows the quote
  -- half to quotes with no sent version; a quote sent in that moment drops out, which only removes a warning.
  -- FOR UPDATE: the change set before the receipt, the order approve uses, so an approve and an apply of
  -- the same set cannot deadlock (the inner engine takes this row lock again, before any other).
  SELECT status INTO v_status FROM public.pricing_change_sets WHERE id = p_change_set_id FOR UPDATE;
  IF v_status IS NOT NULL AND v_status IS DISTINCT FROM 'applied' THEN
    -- FOR SHARE: a same-admin re-approval cannot replace the receipt between this check and commit.
    SELECT * INTO v_approval
    FROM public.pricing_change_set_approvals
    WHERE change_set_id = p_change_set_id
    FOR SHARE;
    IF NOT FOUND
       OR v_approval.approved_by IS DISTINCT FROM v_actor
       OR v_approval.request_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RAISE EXCEPTION 'PRICING_APPROVAL_REQUIRED: approve this preview, acknowledging every warning, before applying it';
    END IF;
    v_inputs := public._pricing_change_set_warning_inputs(p_change_set_id);
    SELECT COALESCE(jsonb_object_agg(w.product_id::text, jsonb_build_object(
             'warning_codes', to_jsonb(w.warning_codes), 'details', w.details)), '{}'::jsonb)
      INTO v_stored_set
      FROM public.pricing_change_set_warnings w
     WHERE w.change_set_id = p_change_set_id;
    IF public._pricing_change_set_warning_set(p_change_set_id) IS DISTINCT FROM v_stored_set THEN
      RAISE EXCEPTION 'PRICING_WARNINGS_CHANGED: the warnings for this change set changed after it was approved; preview it again';
    END IF;
  END IF;

  v_result := public._apply_product_cost_basis_change_set_serialized_inner(
    p_change_set_id,
    p_request_fingerprint,
    p_performed_by,
    p_idempotency_key
  );
  -- The second read (see above): the products are locked by now, so a changed floor or a quote sent
  -- since the check rolls the whole apply back.
  IF v_inputs IS NOT NULL
     AND public._pricing_change_set_warning_inputs(p_change_set_id) IS DISTINCT FROM v_inputs THEN
    RAISE EXCEPTION 'PRICING_WARNINGS_CHANGED: a margin floor or an open sent quote changed while this change set was applying; preview it again';
  END IF;
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. The history trigger: the live body plus rate changes, the row's reason and its source.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.write_product_pricing_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := NULLIF(current_setting('crx.pricing_actor', true), '')::uuid;
  v_source text := NULLIF(current_setting('crx.pricing_source', true), '');
  v_reason text := NULLIF(current_setting('crx.pricing_reason', true), '');
  v_change_set_id uuid := NULLIF(current_setting('crx.pricing_change_set_id', true), '')::uuid;
  v_row_reason text;
  v_price_source text;
BEGIN
  IF NOT (
    OLD.current_cost IS DISTINCT FROM NEW.current_cost
    OR OLD.tier1_margin IS DISTINCT FROM NEW.tier1_margin
    OR OLD.tier2_margin IS DISTINCT FROM NEW.tier2_margin
    OR OLD.tier3_margin IS DISTINCT FROM NEW.tier3_margin
    OR OLD.tier1_price IS DISTINCT FROM NEW.tier1_price
    OR OLD.tier2_price IS DISTINCT FROM NEW.tier2_price
    OR OLD.tier3_price IS DISTINCT FROM NEW.tier3_price
    OR OLD.tier1_gross_margin IS DISTINCT FROM NEW.tier1_gross_margin
    OR OLD.tier2_gross_margin IS DISTINCT FROM NEW.tier2_gross_margin
    OR OLD.tier3_gross_margin IS DISTINCT FROM NEW.tier3_gross_margin
    -- A rate change moves the per-acre price without touching the per-unit prices (plan section 7,
    -- finding 5): it is a price change and gets a history row too.
    OR OLD.rate_per_acre IS DISTINCT FROM NEW.rate_per_acre
    OR OLD.rate_unit IS DISTINCT FROM NEW.rate_unit
  ) THEN
    RETURN NEW;
  END IF;

  -- Until cutover, the deployed frontend remains the writer for legacy direct
  -- changes. Skip those here so its explicit history INSERT stays exactly-once.
  IF current_setting('crx.pricing_authorized', true) IS DISTINCT FROM 'phase1a' THEN
    -- Outside the governed path only the rate can change (require_governed_product_pricing refuses
    -- cost, margin and price writes): the product page's Save Changes edits it directly. Log that too,
    -- since it moves the per-acre price (20261027050000); a migration with no signed-in user is skipped.
    -- A blank and a NULL unit are the same unit, so picking the form's blank option logs nothing.
    IF (OLD.rate_per_acre IS DISTINCT FROM NEW.rate_per_acre
        OR NULLIF(btrim(OLD.rate_unit), '') IS DISTINCT FROM NULLIF(btrim(NEW.rate_unit), ''))
       AND auth.uid() IS NOT NULL THEN
      INSERT INTO public.cost_history(
        product_id, changed_by,
        old_cost, new_cost,
        old_tier1_price, new_tier1_price,
        old_tier2_price, new_tier2_price,
        old_tier3_price, new_tier3_price,
        old_tier1_margin, new_tier1_margin,
        old_tier2_margin, new_tier2_margin,
        old_tier3_margin, new_tier3_margin,
        change_note, change_source, change_reason,
        old_pricing_version, new_pricing_version,
        old_rate_per_acre, new_rate_per_acre, old_rate_unit, new_rate_unit
      ) VALUES (
        NEW.id, auth.uid(),
        OLD.current_cost, NEW.current_cost,
        OLD.tier1_price, NEW.tier1_price,
        OLD.tier2_price, NEW.tier2_price,
        OLD.tier3_price, NEW.tier3_price,
        OLD.tier1_margin, NEW.tier1_margin,
        OLD.tier2_margin, NEW.tier2_margin,
        OLD.tier3_margin, NEW.tier3_margin,
        'Rate per acre changed in product details', 'product_page', 'Rate per acre changed in product details',
        OLD.pricing_version, NEW.pricing_version,
        OLD.rate_per_acre, NEW.rate_per_acre, OLD.rate_unit, NEW.rate_unit
      );
    END IF;
    RETURN NEW;
  END IF;

  IF v_actor IS NULL OR v_actor IS DISTINCT FROM auth.uid()
     OR v_source NOT IN ('pricing_worksheet', 'product_page', 'products_inline')
     OR NOT public.is_admin()
     OR v_change_set_id IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_PRICING_HISTORY_CONTEXT_INVALID';
  END IF;

  -- The row's own reason and source, recorded at preview (20261027050000); the session reason is
  -- the change set's fallback for rows written before then.
  SELECT r.change_reason, r.price_source INTO v_row_reason, v_price_source
  FROM public.pricing_change_set_rows r
  WHERE r.change_set_id = v_change_set_id AND r.product_id = NEW.id;
  IF NOT FOUND THEN
    SELECT i.change_reason, i.price_source INTO v_row_reason, v_price_source
    FROM public.product_info_change_set_rows i
    WHERE i.change_set_id = v_change_set_id AND i.product_id = NEW.id;
  END IF;
  v_reason := COALESCE(v_row_reason, v_reason);

  INSERT INTO public.cost_history(
    product_id, changed_by,
    old_cost, new_cost,
    old_tier1_price, new_tier1_price,
    old_tier2_price, new_tier2_price,
    old_tier3_price, new_tier3_price,
    old_tier1_margin, new_tier1_margin,
    old_tier2_margin, new_tier2_margin,
    old_tier3_margin, new_tier3_margin,
    change_note, change_source, change_reason, change_set_id,
    old_pricing_version, new_pricing_version,
    price_source, old_rate_per_acre, new_rate_per_acre, old_rate_unit, new_rate_unit
  ) VALUES (
    NEW.id, v_actor,
    OLD.current_cost, NEW.current_cost,
    OLD.tier1_price, NEW.tier1_price,
    OLD.tier2_price, NEW.tier2_price,
    OLD.tier3_price, NEW.tier3_price,
    OLD.tier1_margin, NEW.tier1_margin,
    OLD.tier2_margin, NEW.tier2_margin,
    OLD.tier3_margin, NEW.tier3_margin,
    v_reason, v_source, v_reason, v_change_set_id,
    OLD.pricing_version, NEW.pricing_version,
    v_price_source, OLD.rate_per_acre, NEW.rate_per_acre, OLD.rate_unit, NEW.rate_unit
  );
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  t text;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.pricing_change_set_warnings', 'public.pricing_change_set_approvals'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN
      RAISE EXCEPTION 'PRICE_SHEET_VERIFY: RLS is off on %', t;
    END IF;
    IF EXISTS (
         SELECT 1
           FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role),
                unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(priv)
          WHERE has_table_privilege(r.role, t, p.priv))
       OR (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro')
           AND has_table_privilege('metabase_ro', t, 'SELECT')) THEN
      RAISE EXCEPTION 'PRICE_SHEET_VERIFY: an API role can reach %', t;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public._pricing_change_set_warnings(uuid)', 'public._pricing_change_set_warning_set(uuid)',
                          'public._pricing_change_set_warning_inputs(uuid)'] LOOP
    IF EXISTS (SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
                WHERE has_function_privilege(r.role, f, 'EXECUTE'))
       OR (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro')
           AND has_function_privilege('metabase_ro', f, 'EXECUTE')) THEN
      RAISE EXCEPTION 'PRICE_SHEET_VERIFY: % is executable by an API role', f;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.approve_pricing_change_set(uuid,text,jsonb,jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.approve_pricing_change_set(uuid,text,jsonb,jsonb,uuid,text)', 'EXECUTE')
     OR (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro')
         AND has_function_privilege('metabase_ro', 'public.approve_pricing_change_set(uuid,text,jsonb,jsonb,uuid,text)', 'EXECUTE'))
     OR NOT has_function_privilege('authenticated', 'public.approve_pricing_change_set(uuid,text,jsonb,jsonb,uuid,text)', 'EXECUTE')
     OR (SELECT p.prosecdef IS NOT TRUE OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
           FROM pg_proc p WHERE p.oid = 'public.approve_pricing_change_set(uuid,text,jsonb,jsonb,uuid,text)'::regprocedure) THEN
    RAISE EXCEPTION 'PRICE_SHEET_VERIFY: approve_pricing_change_set grants or attributes are wrong';
  END IF;

  -- The replaced functions keep their grants (CREATE OR REPLACE).
  IF NOT has_function_privilege('authenticated', 'public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.apply_product_cost_basis_change_set(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.apply_product_cost_basis_change_set(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.write_product_pricing_history()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.preview_product_pricing_changes(text,uuid,jsonb,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.apply_product_pricing_change_set(uuid,text,uuid,text)', 'EXECUTE')
     -- The approval gate lives in the wrapper: the engine under it must stay out of the API's reach.
     OR has_function_privilege('authenticated', 'public._apply_product_cost_basis_change_set_serialized_inner(uuid,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._apply_product_cost_basis_change_set_serialized_inner(uuid,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PRICE_SHEET_VERIFY: a replaced or inner pricing function changed who can execute it';
  END IF;
  IF position('PRICING_APPROVAL_REQUIRED' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.apply_product_cost_basis_change_set(uuid,text,uuid,text)'::regprocedure)) = 0
     OR position('PRICING_SOURCE_REQUIRED' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.preview_product_cost_basis_changes(text,uuid,jsonb,uuid,text)'::regprocedure)) = 0
     OR position('new_rate_per_acre' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.write_product_pricing_history()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PRICE_SHEET_VERIFY: a replaced function is not the new body';
  END IF;
END
$verify$;
