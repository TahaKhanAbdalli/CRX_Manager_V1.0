-- Written 2026-10-25. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- idempotency-body-check: exempt -- set_product_margin_floors requires a key and binds its receipt
--   to the caller and request (check_idempotency_intent, save_idempotency,
--   _bind_replay_receipt_20261015: the set_purchase_order_item_costs pattern). The append-only
--   trigger function is not callable. The hook only recognises check_idempotency().
--
-- WHAT: a margin floor per product (To-Do 0.2, pricing plan slice 8). Mason, 2026-10-14: "Margin
--   targets and floors are set per product, with no company-wide default." The floor feeds the price
--   sheet's low-margin warning (To-Do 0.1, a later migration); a product with no floor skips only
--   that warning.
--
--   The floor is a NET margin, (price - cost) / price, stored as a ratio exactly like
--   products.tier1_margin .. tier3_margin (the "Net Margin %" on the product page), so a tier is
--   under its floor when tierN_margin < margin_floor.
--
--   1. product_margin_floors: one row per product that has a floor (no row = no floor). Admin-read
--      only (margin is admin-only: Mason, 2026-10-15; PR #1089). No API role may write it; only the
--      function below does. Deleting a product deletes its floor (the change history stays).
--
--   2. product_margin_floor_changes: append-only history of every floor set, changed or cleared:
--      who, when, old and new floor, and the reason. Admin-read only. No foreign key: the history
--      outlives a deleted product. A trigger refuses UPDATE, DELETE and TRUNCATE.
--
--   3. NEW set_product_margin_floors(p_items [{product_id, margin_floor_percent}], p_reason,
--      p_performed_by, p_idempotency_key), admin-only. margin_floor_percent is a JSON number from 0
--      up to (not including) 100 with at most two decimals (12.5 = 12.5%), or null to clear the
--      floor. The percent is divided by 100 in numeric, never in the browser, so 14.3 stays exactly
--      0.143. An unchanged floor writes nothing. Reason optional (1-500 characters). Key required,
--      bound to the caller and request. Up to 1000 products per call (the catalog is about 600).
--
-- Nothing reads the floor yet except the Products list and the product page (admins). No existing
--   behavior changes: no price, cost, quote or order is touched.
--
-- COMMIT-TIME GUARD: the deferred trigger require_bound_replay_receipt_20261015 is not extended to
--   this operation, for the reasons 20261019220000 gives: only this function writes a
--   'set_product_margin_floors' receipt and binds it in the same call (_bind_replay_receipt_20261015
--   raises IDEMPOTENCY_RECEIPT_MISSING if none was written), save_idempotency is not executable by
--   authenticated, and recreating the trigger would race the replay-binding batches that own it.
--
-- KNOWN LIMITS (accepted): a hard delete of a product cascades its floor away without a "cleared"
--   history row (the app never hard-deletes products; products_delete is admin-only); two admins
--   editing one floor at once is last-writer-wins, each write recorded in the history.
--
-- caller-analysis: set_product_margin_floors :: NEW; src/lib/marginFloors.ts (Products.tsx inline edit, ProductDetail.tsx floor card; admin only)
--
-- GRANTS: set_product_margin_floors EXECUTE to authenticated only (revoked from PUBLIC, anon,
--   service_role, metabase_ro); SECURITY DEFINER, search_path = public, pg_temp. The trigger
--   function is executable by no API role. Both tables: SELECT to authenticated (RLS: admins only),
--   nothing to any other role (metabase_ro's default grant is revoked too).
--
-- ROLLBACK (loses only the floors and their history; nothing else uses them yet):
--   DROP FUNCTION public.set_product_margin_floors(jsonb, text, uuid, text);
--   DROP TABLE public.product_margin_floor_changes;   -- after exporting it if it matters
--   DROP TABLE public.product_margin_floors;
--   DROP FUNCTION public._product_margin_floor_changes_append_only();

SET LOCAL lock_timeout = '10s';

-- PREFLIGHT: the helpers this file relies on are exactly the ones read live on 2026-10-25 (md5 of
-- prosrc without carriage returns), and nothing it creates exists yet.
DO $preflight$
DECLARE
  r record;
  v_md5 text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.is_admin()', 'f76bf61116c3bd52bd9c6ea125079b73'),
      ('public.require_admin()', '83dbda095d67a37031d5cd093a605a78'),
      ('public.check_idempotency_intent(text,text,uuid,text)', 'edc73be809069669e8441eba7acf443d'),
      ('public.save_idempotency(text,text,jsonb)', 'f600171c426e48c995f204c4dac3ff8b'),
      ('public._bind_replay_receipt_20261015(text,text,text)', '722ddd3b5d9174c598735cb321088f73'),
      ('public._replay_fingerprint_20261015(jsonb)', '68d5c0c62579349ced47c89e6b65ccaf'),
      ('public._cost_step2_try_uuid(text)', '12ea72c00fcf4de75309060436f082b5'),
      ('public.update_updated_at()', '301a884953d37769916294bb60562e05')
    ) AS v(sig, md5)
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'MARGIN_FLOOR_PREFLIGHT: % is missing', r.sig;
    END IF;
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_md5 IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'MARGIN_FLOOR_PREFLIGHT: % changed since 2026-10-25 (md5 %); re-read it before applying', r.sig, v_md5;
    END IF;
  END LOOP;

  -- By name, every overload: to_regproc() is NULL when a name has several.
  IF to_regclass('public.product_margin_floors') IS NOT NULL
     OR to_regclass('public.product_margin_floor_changes') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace
                   AND p.proname IN ('set_product_margin_floors', '_product_margin_floor_changes_append_only')) THEN
    RAISE EXCEPTION 'MARGIN_FLOOR_PREFLIGHT: an object this migration creates already exists';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. The floors.
-- ---------------------------------------------------------------------------
CREATE TABLE public.product_margin_floors (
  product_id uuid PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  -- A net-margin ratio like products.tier1_margin: 0.15 = 15%. Two decimals of percent at most.
  margin_floor numeric NOT NULL,
  set_by uuid,
  set_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_margin_floors_range
    CHECK (margin_floor >= 0 AND margin_floor < 1 AND margin_floor = round(margin_floor, 4)),
  CONSTRAINT product_margin_floors_reason_length
    CHECK (set_reason IS NULL OR char_length(set_reason) BETWEEN 1 AND 500)
);

COMMENT ON TABLE public.product_margin_floors IS
  'Per-product net-margin floor (ratio, like products.tier1_margin). No row = no floor (Mason, 2026-10-14: per product, no company-wide default). Admin-read only; written only by set_product_margin_floors.';

ALTER TABLE public.product_margin_floors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.product_margin_floors FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_margin_floors TO authenticated;

-- Margin is admin-only (Mason, 2026-10-15; PR #1089).
CREATE POLICY product_margin_floors_admin_select ON public.product_margin_floors
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

CREATE TRIGGER set_product_margin_floors_updated_at
  BEFORE UPDATE ON public.product_margin_floors
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ---------------------------------------------------------------------------
-- 2. The floor history.
-- ---------------------------------------------------------------------------
CREATE TABLE public.product_margin_floor_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  old_margin_floor numeric,
  new_margin_floor numeric,
  reason text,
  changed_by uuid,
  -- clock_timestamp, not now(): several changes in one transaction keep their real order.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT product_margin_floor_changes_is_change
    CHECK (old_margin_floor IS DISTINCT FROM new_margin_floor),
  CONSTRAINT product_margin_floor_changes_range
    CHECK ((old_margin_floor IS NULL OR (old_margin_floor >= 0 AND old_margin_floor < 1))
       AND (new_margin_floor IS NULL OR (new_margin_floor >= 0 AND new_margin_floor < 1))),
  CONSTRAINT product_margin_floor_changes_reason_length
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500)
);

COMMENT ON TABLE public.product_margin_floor_changes IS
  'Append-only history of product margin floors: every set, change or clear (NULL new_margin_floor) with who, when, old/new and reason. Admin-read only. No updated_at: rows never change. No foreign key: outlives a deleted product.';

CREATE INDEX idx_product_margin_floor_changes_product
  ON public.product_margin_floor_changes (product_id, created_at);

ALTER TABLE public.product_margin_floor_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.product_margin_floor_changes FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
GRANT SELECT ON TABLE public.product_margin_floor_changes TO authenticated;

CREATE POLICY product_margin_floor_changes_admin_select ON public.product_margin_floor_changes
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin()));

CREATE FUNCTION public._product_margin_floor_changes_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'MARGIN_FLOOR_HISTORY_APPEND_ONLY: margin floor history cannot be changed or deleted';
END;
$function$;
REVOKE ALL ON FUNCTION public._product_margin_floor_changes_append_only() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE TRIGGER trigger_product_margin_floor_changes_append_only
  BEFORE UPDATE OR DELETE ON public.product_margin_floor_changes
  FOR EACH ROW EXECUTE FUNCTION public._product_margin_floor_changes_append_only();

CREATE TRIGGER trigger_product_margin_floor_changes_no_truncate
  BEFORE TRUNCATE ON public.product_margin_floor_changes
  FOR EACH STATEMENT EXECUTE FUNCTION public._product_margin_floor_changes_append_only();

-- ---------------------------------------------------------------------------
-- 3. set_product_margin_floors: admin sets, changes or clears floors.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.set_product_margin_floors(
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
  v_item jsonb;
  v_product_id uuid;
  v_percent numeric;
  v_new numeric;
  v_old numeric;
  v_changed integer := 0;
  v_unchanged integer := 0;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: set_product_margin_floors requires p_idempotency_key'
      USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()' USING ERRCODE = 'P0001';
  END IF;
  -- Margin is admin-only (Mason, 2026-10-15).
  PERFORM public.require_admin();

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'MARGIN_FLOOR_ITEMS_REQUIRED';
  END IF;
  IF jsonb_array_length(p_items) > 1000 THEN
    RAISE EXCEPTION 'MARGIN_FLOOR_ITEMS_TOO_MANY: at most 1000 products at a time';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) AS e(value) WHERE jsonb_typeof(e.value) <> 'object') THEN
    RAISE EXCEPTION 'MARGIN_FLOOR_ITEM_INVALID: each item is {product_id, margin_floor_percent}';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) AS e(value)
              WHERE public._cost_step2_try_uuid(e.value->>'product_id') IS NULL) THEN
    RAISE EXCEPTION 'MARGIN_FLOOR_ITEM_INVALID: each item needs a valid product_id';
  END IF;
  -- Compared as uuids: the same product spelled in upper and lower case is one product.
  IF (SELECT count(*) <> count(DISTINCT public._cost_step2_try_uuid(e.value->>'product_id'))
        FROM jsonb_array_elements(p_items) AS e(value)) THEN
    RAISE EXCEPTION 'MARGIN_FLOOR_PRODUCT_DUPLICATE: each product must appear once';
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'MARGIN_FLOOR_REASON_TOO_LONG: keep the reason to 500 characters';
  END IF;

  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'items', p_items,
    'reason', v_reason
  ));
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'set_product_margin_floors', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- One product at a time, in id order, so two admins saving overlapping lists never deadlock.
  FOR v_item IN
    SELECT e.value FROM jsonb_array_elements(p_items) AS e(value)
     ORDER BY public._cost_step2_try_uuid(e.value->>'product_id')
  LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' OR NOT (v_item ? 'margin_floor_percent') THEN
      RAISE EXCEPTION 'MARGIN_FLOOR_PERCENT_REQUIRED: send margin_floor_percent (a number, or null to clear)';
    END IF;
    v_product_id := public._cost_step2_try_uuid(v_item->>'product_id');

    IF jsonb_typeof(v_item->'margin_floor_percent') = 'null' THEN
      v_new := NULL;
    ELSIF jsonb_typeof(v_item->'margin_floor_percent') = 'number' THEN
      v_percent := (v_item->>'margin_floor_percent')::numeric;
      IF v_percent < 0 OR v_percent >= 100 OR v_percent IS DISTINCT FROM round(v_percent, 2) THEN
        RAISE EXCEPTION 'MARGIN_FLOOR_PERCENT_INVALID: a floor is 0 to 99.99 percent, at most two decimals'
          USING ERRCODE = '22023';
      END IF;
      -- trim_scale: 15 stores as 0.15, not 0.15000000000000000000 (numeric division widens the scale).
      v_new := trim_scale(v_percent / 100);
    ELSE
      RAISE EXCEPTION 'MARGIN_FLOOR_PERCENT_INVALID: a floor is 0 to 99.99 percent, at most two decimals'
        USING ERRCODE = '22023';
    END IF;

    -- Serializes floor writers per product (and a delete of the product). NO KEY UPDATE, not
    -- UPDATE: it must not block the key-share locks that quote, order and invoice line inserts take
    -- on products for their foreign keys (a bulk floor save would otherwise stall, or deadlock, them).
    PERFORM 1 FROM public.products p WHERE p.id = v_product_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MARGIN_FLOOR_PRODUCT_NOT_FOUND: %', v_product_id;
    END IF;
    SELECT f.margin_floor INTO v_old FROM public.product_margin_floors f WHERE f.product_id = v_product_id;
    IF NOT FOUND THEN
      v_old := NULL;
    END IF;

    IF v_old IS NOT DISTINCT FROM v_new THEN
      v_unchanged := v_unchanged + 1;
      CONTINUE;
    END IF;

    IF v_new IS NULL THEN
      DELETE FROM public.product_margin_floors WHERE product_id = v_product_id;
    ELSE
      INSERT INTO public.product_margin_floors (product_id, margin_floor, set_by, set_reason)
      VALUES (v_product_id, v_new, v_actor, v_reason)
      ON CONFLICT (product_id) DO UPDATE
        SET margin_floor = EXCLUDED.margin_floor,
            set_by = EXCLUDED.set_by,
            set_reason = EXCLUDED.set_reason;
    END IF;

    INSERT INTO public.product_margin_floor_changes (product_id, old_margin_floor, new_margin_floor, reason, changed_by)
    VALUES (v_product_id, v_old, v_new, v_reason, v_actor);
    v_changed := v_changed + 1;
  END LOOP;

  IF v_changed > 0 THEN
    -- No margins and no product here: the activity feed is readable by every signed-in user.
    INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
    VALUES ('product_margin_floors_updated',
            v_changed || ' product margin floor(s) updated',
            v_actor, 'product', NULL);
  END IF;

  v_result := jsonb_build_object('success', true, 'status', 'saved',
    'changed_count', v_changed, 'unchanged_count', v_unchanged);
  PERFORM public.save_idempotency(p_idempotency_key, 'set_product_margin_floors', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_product_margin_floors', v_fingerprint);
  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.set_product_margin_floors(jsonb, text, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_product_margin_floors(jsonb, text, uuid, text) FROM PUBLIC, anon, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.set_product_margin_floors(jsonb, text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.set_product_margin_floors(jsonb, text, uuid, text) IS
  'Admin-only: set, change or clear (null) per-product net-margin floors, given as percent (0-99.99, two decimals). Writes the append-only history. Key required, bound to caller + request.';

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.product_margin_floors', 'public.product_margin_floor_changes'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN
      RAISE EXCEPTION 'MARGIN_FLOOR_VERIFY: RLS is off on %', t;
    END IF;
    IF has_table_privilege('anon', t, 'SELECT') OR has_table_privilege('service_role', t, 'SELECT')
       OR (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro')
           AND has_table_privilege('metabase_ro', t, 'SELECT')) THEN
      RAISE EXCEPTION 'MARGIN_FLOOR_VERIFY: anon, service_role or metabase_ro can read %', t;
    END IF;
    IF EXISTS (
         SELECT 1
           FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role),
                unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(priv)
          WHERE has_table_privilege(r.role, t, p.priv)) THEN
      RAISE EXCEPTION 'MARGIN_FLOOR_VERIFY: an API role can write %', t;
    END IF;
    IF (SELECT count(*) FROM pg_policy WHERE polrelid = t::regclass) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = t::regclass AND polcmd = 'r') THEN
      RAISE EXCEPTION 'MARGIN_FLOOR_VERIFY: % must have exactly its one admin SELECT policy', t;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.set_product_margin_floors(jsonb,text,uuid,text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.set_product_margin_floors(jsonb,text,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_product_margin_floors(jsonb,text,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'MARGIN_FLOOR_VERIFY: set_product_margin_floors grants are wrong';
  END IF;
  IF (SELECT p.prosecdef IS NOT TRUE OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
        FROM pg_proc p WHERE p.oid = 'public.set_product_margin_floors(jsonb,text,uuid,text)'::regprocedure) THEN
    RAISE EXCEPTION 'MARGIN_FLOOR_VERIFY: set_product_margin_floors is not SECURITY DEFINER with search_path public, pg_temp';
  END IF;
  IF EXISTS (
       SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS r(role)
        WHERE has_function_privilege(r.role, 'public._product_margin_floor_changes_append_only()', 'EXECUTE')) THEN
    RAISE EXCEPTION 'MARGIN_FLOOR_VERIFY: the append-only trigger function is executable by an API role';
  END IF;
END
$verify$;
