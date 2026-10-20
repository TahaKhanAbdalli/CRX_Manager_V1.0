-- Written 2026-10-19. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- idempotency-body-check: exempt -- the three save wrappers delegate to their renamed bodies, which
--   keep their own idempotency unchanged; this file adds no other mutating function. The hook only
--   recognises check_idempotency().
--
-- WHAT: Goal 1 part 3, step 2 of 3 (docs/plans/2026-10-13-direction-and-goals.md): product cost
--   and margin are ADMIN-ONLY (Mason, 2026-10-15). Step 1 (20261019010000, live) closed the
--   functions that handed cost to non-admins. This step gives the screens what they need so that
--   step 3 can revoke the cost COLUMNS from the API roles without breaking anything:
--
--   1. get_admin_cost_fields(table, ids): the ONLY way the app reads cost columns after step 3.
--      Admin-only (require_admin), a fixed allow-list of thirteen tables, static SQL per table.
--   2. get_quote_versions(quote_id): quote history for admins and reps. A rep gets every snapshot
--      with each cost, profit or margin value set to NULL (any key whose name contains cost,
--      profit or margin, at any depth: the live rows carry two snapshot shapes). Admins get the
--      stored snapshot unchanged. Step 3 then revokes quote_versions.snapshot_data.
--   3. Three saves stop trusting the browser's cost for non-admins and work it out here, because
--      after step 3 a rep's screen cannot read cost and would send 0:
--        save_job              job_chemicals.cost_per_unit_cents: the stored cost of the same
--                              product + unit on this job if there is one, else the product's
--                              current cost converted from its stock unit (unit_size) to the line's
--                              unit -- the same rule JobDetail applies for admins
--                              (reconcileChemAutofillUnits), via field_app_priced_quantity.
--        save_field_app_invoice  chemical cost_cents: on an existing invoice, the cost already stored
--                              for the same product in this invoice's group (same position first),
--                              which is what the screen sends back for an admin; otherwise the
--                              product's current cost per its sold unit, exactly what the screen
--                              fills in for an admin; a line with no product carries 0 (a rep
--                              cannot enter a cost).
--        save_invoice          a product line on a sale invoice: the product's current cost (the
--                              writer re-derives it from the product anyway, and restores
--                              order-linked lines). A field-application line or a manual line: the
--                              stored cost of the same line on this invoice (by id, else by product
--                              + fee flag + description + position; a fee line scales with its
--                              acres), else the product's current cost, else 0.
--      A lost-response retry rebuilds the identical payload (the stored-cost lookups find the
--      rows the first attempt wrote, with the costs it wrote), unless an admin changed that
--      product's catalog cost in between: then the fingerprint-bound writers refuse the retry as a
--      changed request, which the screens already explain as "the earlier save completed".
--   4. Purchase cost on two read paths reps use:
--        get_chemical_history  now admin-or-sales-rep (everyone else gets no rows, as RLS gave them
--                              before) and a non-admin sees no purchase cost (unit price and total
--                              are NULL on Purchase rows). SECURITY DEFINER so step 3's column lock
--                              does not break it for admins.
--        match_quick_receive_items  a non-admin's reply carries no unit_cost on any allocation; every
--                              allocation gains is_no_return (cheaper than the product's dearest
--                              open line), which the receiving screen's NO-RETURN badge needs.
--
--   The changed functions use the house rename-and-wrap pattern (20261019010000): each live body is
--   RENAMED unchanged to _<name>_cost_step2_impl, every API role loses EXECUTE on it, and a public
--   wrapper with the identical signature, defaults and return type takes its name. Admins pass
--   straight through; the wrapper rewrites only a non-admin's request (or reply).
--
-- NOT HERE (deliberately): purchase orders (Mason, 2026-10-20, option 1 "for now"). Purchase order
--   screens and save_purchase_order stay exactly as they are; reps still see and enter purchase cost
--   there. Three review rounds showed any cost a rep's line is given can be wrong and then locked
--   at receipt, so purchase orders become their own project together with a governed way to correct
--   or track a received cost (docs/manual/KNOWN_ISSUES.md). The column REVOKE itself (step 3, applied
--   only after these screens are live; it must leave the purchase order cost columns alone until
--   that project lands). create_order_from_blend_ticket, manual_inventory_add, complete_delivery and complete_job
--   belong to the replay-binding batches (PR #954 is open). compute_application_service_fee needs
--   nothing: only postgres and service_role may execute it (live ACL read 2026-10-19), so no browser
--   ever received its cost. dashboard_summary is already admin-only (step 1, verified live
--   2026-10-19).
--
-- CALLERS (every app caller of a function whose behaviour or grants change here, checked 2026-10-19):
-- caller-analysis: save_job :: JobDetail.tsx; admins unchanged, a rep's chemical cost is derived here
-- caller-analysis: save_field_app_invoice :: FieldApplicationInvoice.tsx; admins unchanged, a rep's chemical cost is derived here
-- caller-analysis: save_invoice :: InvoiceDetail.tsx; admins unchanged, a rep's line cost is derived here
-- caller-analysis: get_chemical_history :: Reports.tsx chemical history; admins unchanged, reps lose purchase cost, other roles already got no rows
-- caller-analysis: match_quick_receive_items :: QuickReceivePanel.tsx, offlineSync.ts; admins unchanged, a rep's reply has no unit_cost
-- caller-analysis: get_admin_cost_fields :: NEW; src/lib/costFields.ts (admin screens only)
-- caller-analysis: get_quote_versions :: NEW; QuoteBuilder.tsx version history
--
-- ROLLBACK: DROP the two new functions; for each wrapped function DROP the wrapper, RENAME
--   _<name>_cost_step2_impl back to <name> and GRANT EXECUTE TO authenticated, service_role (the
--   live grants on 2026-10-19; never PUBLIC or anon). DROP the six private helpers. No data changes.

-- LIVE EVIDENCE (read-only, 2026-10-20 14:24 UTC): each function this file renames has exactly ONE
--   live overload -- save_job(uuid,jsonb,jsonb,jsonb,uuid,text), save_field_app_invoice(uuid,jsonb,
--   jsonb,jsonb,uuid,uuid,text), save_invoice(jsonb,jsonb,text), get_chemical_history(uuid,date,date),
--   match_quick_receive_items(jsonb,text). The older five-argument save_job declared in 20260215200000
--   no longer exists live, and the preflight below refuses to run if a second overload of any of them
--   ever appears. Live ledger: 1037 rows, max(version) 20261020022222 from
--   20261019220000_start_and_complete_delivery, so this file's stamp sorts above the live high-water.

SET LOCAL lock_timeout = '10s';

-- ---------------------------------------------------------------------------
-- 0. Preflight: every body this file renames is the one read live on 2026-10-19, and so is every
--    body whose behaviour the rewrites rely on. A re-run (impls already renamed) checks the impls.
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)', 'save_job', '8acf34542105a90212ddb0a5e7c5d272'),
      ('public.save_field_app_invoice(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)', 'save_field_app_invoice', '8700762576625bd06a833845d57ddbb6'),
      ('public.save_invoice(jsonb,jsonb,text)', 'save_invoice', 'cb932dc51a680442affde5aeba2eaee3'),
      ('public.get_chemical_history(uuid,date,date)', 'get_chemical_history', 'a625bbe0eeded3089671740002554624'),
      ('public.match_quick_receive_items(jsonb,text)', 'match_quick_receive_items', '2f674b20b0eefaa13a894d82d87c3abe')
    ) AS v(sig, name, md5)
  LOOP
    IF to_regproc('public._' || r.name || '_cost_step2_impl') IS NOT NULL THEN
      IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
           WHERE p.oid = to_regproc('public._' || r.name || '_cost_step2_impl')) IS DISTINCT FROM r.md5 THEN
        RAISE EXCEPTION 'COST_STEP2_PREFLIGHT: public._%_cost_step2_impl exists but is not the pinned body', r.name;
      END IF;
      -- A re-run: the public name is this file's wrapper, and must still be the only overload.
      IF (SELECT count(*) FROM pg_proc p
           WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.name) > 1 THEN
        RAISE EXCEPTION 'COST_STEP2_PREFLIGHT: expected at most one public.% overload', r.name;
      END IF;
      CONTINUE;
    END IF;
    IF (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.name) <> 1 THEN
      RAISE EXCEPTION 'COST_STEP2_PREFLIGHT: expected exactly one public.% overload', r.name;
    END IF;
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
         WHERE p.oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'COST_STEP2_PREFLIGHT: % is missing or drifted from its 2026-10-19 body', r.sig;
    END IF;
  END LOOP;

  -- Bodies whose behaviour the rewrites depend on.
  FOR r IN
    SELECT * FROM (VALUES
      -- reads chemical cost_cents per the product's sold unit
      ('public._save_field_app_invoice_impl_20260714(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)', '29d699a8b0698424345a78e9aac9dcd1'),
      -- takes a field line's cost_cents from the request; re-derives sale lines from the product
      ('public._save_invoice_lineage_unaware_impl_20260827(jsonb,jsonb,text)', 'e3fc9bd9c1da4b2eb8082e91781e4915'),
      -- the unit conversion the job rewrite uses
      ('public.field_app_priced_quantity(numeric,text,text,text)', 'bc91a52577840973f18f1710e47edf2b'),
      ('public.is_admin()', 'f76bf61116c3bd52bd9c6ea125079b73'),
      ('public.is_sales_rep()', 'fcb3133010fe3f4f56e3be31f709d102'),
      ('public.require_admin()', '83dbda095d67a37031d5cd093a605a78')
    ) AS v(sig, md5)
  LOOP
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
         WHERE p.oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'COST_STEP2_PREFLIGHT: % is missing or drifted', r.sig;
    END IF;
  END LOOP;

  -- The new names must be free on a first run; on a re-run (this file's renamed bodies exist)
  -- each may be only this file's own function, with exactly its signature.
  FOR r IN
    SELECT * FROM (VALUES
      ('get_admin_cost_fields', 'get_admin_cost_fields(text,uuid[])'),
      ('get_quote_versions', 'get_quote_versions(uuid)')
    ) AS v(name, sig)
  LOOP
    IF to_regproc('public._save_job_cost_step2_impl') IS NULL THEN
      IF EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.name) THEN
        RAISE EXCEPTION 'COST_STEP2_PREFLIGHT: public.% already exists', r.name;
      END IF;
    ELSIF EXISTS (SELECT 1 FROM pg_proc p
                   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.name
                     AND p.oid IS DISTINCT FROM to_regprocedure('public.' || r.sig)) THEN
      RAISE EXCEPTION 'COST_STEP2_PREFLIGHT: public.% has an overload this file did not create', r.name;
    END IF;
  END LOOP;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. Rename each live body unchanged; no API role may call it directly. (Literal statements so
--    the repo's body-resolution tests can follow each rename.)
-- ---------------------------------------------------------------------------
DO $rename$
BEGIN
  IF to_regproc('public._save_job_cost_step2_impl') IS NULL THEN
    ALTER FUNCTION public.save_job(uuid, jsonb, jsonb, jsonb, uuid, text) RENAME TO _save_job_cost_step2_impl;
  END IF;
  IF to_regproc('public._save_field_app_invoice_cost_step2_impl') IS NULL THEN
    ALTER FUNCTION public.save_field_app_invoice(uuid, jsonb, jsonb, jsonb, uuid, uuid, text) RENAME TO _save_field_app_invoice_cost_step2_impl;
  END IF;
  IF to_regproc('public._save_invoice_cost_step2_impl') IS NULL THEN
    ALTER FUNCTION public.save_invoice(jsonb, jsonb, text) RENAME TO _save_invoice_cost_step2_impl;
  END IF;
  IF to_regproc('public._get_chemical_history_cost_step2_impl') IS NULL THEN
    ALTER FUNCTION public.get_chemical_history(uuid, date, date) RENAME TO _get_chemical_history_cost_step2_impl;
  END IF;
  IF to_regproc('public._match_quick_receive_items_cost_step2_impl') IS NULL THEN
    ALTER FUNCTION public.match_quick_receive_items(jsonb, text) RENAME TO _match_quick_receive_items_cost_step2_impl;
  END IF;
END
$rename$;

REVOKE ALL ON FUNCTION public._save_job_cost_step2_impl(uuid, jsonb, jsonb, jsonb, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._save_field_app_invoice_cost_step2_impl(uuid, jsonb, jsonb, jsonb, uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._save_invoice_cost_step2_impl(jsonb, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._get_chemical_history_cost_step2_impl(uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._match_quick_receive_items_cost_step2_impl(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Private helpers (no API role may execute them; the wrappers run as their owner).
-- ---------------------------------------------------------------------------
-- Every spelling the writers' own ::uuid cast accepts (hyphenated, compact, braced, any case), so a
-- line the writer stores is never one this file failed to recognise (Sol, 2026-10-20); anything else
-- is NULL.
CREATE OR REPLACE FUNCTION public._cost_step2_try_uuid(p_text text)
RETURNS uuid
LANGUAGE plpgsql IMMUTABLE
SET search_path = public, pg_temp
AS $function$
BEGIN
  RETURN p_text::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$function$;

-- A product's current cost in whole cents per its stock unit; NULL when the product does not exist.
CREATE OR REPLACE FUNCTION public._cost_step2_product_cost_cents(p_product_id uuid)
RETURNS bigint
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(round(p.current_cost * 100)::bigint, 0)
    FROM public.products p
   WHERE p.id = p_product_id;
$function$;

-- save_job (non-admin): cost_per_unit_cents for every chemical line.
CREATE OR REPLACE FUNCTION public._cost_step2_job_chemicals(p_job_id uuid, p_chemicals jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_out jsonb := '[]'::jsonb;
  v_chem jsonb;
  v_product_id uuid;
  v_unit text;
  v_sort integer;
  v_cost bigint;
  v_current_cost numeric;
  v_stock text;
  v_form text;
  v_found boolean;
  v_factor numeric;
BEGIN
  IF jsonb_typeof(p_chemicals) IS DISTINCT FROM 'array' THEN
    RETURN p_chemicals;  -- the writer refuses a malformed payload itself
  END IF;

  FOR v_chem IN SELECT e.value FROM jsonb_array_elements(p_chemicals) WITH ORDINALITY AS e(value, ord) ORDER BY e.ord
  LOOP
    IF jsonb_typeof(v_chem) IS DISTINCT FROM 'object' THEN
      v_out := v_out || jsonb_build_array(v_chem);
      CONTINUE;
    END IF;

    v_product_id := public._cost_step2_try_uuid(v_chem->>'product_id');
    v_unit := lower(btrim(COALESCE(v_chem->>'unit', '')));
    v_sort := CASE WHEN (v_chem->>'sort_order') ~ '^-?[0-9]{1,9}$' THEN (v_chem->>'sort_order')::integer END;
    v_cost := NULL;

    -- Keep the cost already stored on this job for the same product and unit (an admin may have
    -- corrected it); the same position wins, so a retry reads back exactly what it wrote.
    IF p_job_id IS NOT NULL AND v_product_id IS NOT NULL THEN
      SELECT jc.cost_per_unit_cents INTO v_cost
        FROM public.job_chemicals jc
       WHERE jc.job_id = p_job_id
         AND jc.product_id = v_product_id
         AND lower(btrim(COALESCE(jc.unit, ''))) = v_unit
       ORDER BY (jc.sort_order IS NOT DISTINCT FROM v_sort) DESC, jc.sort_order, jc.id
       LIMIT 1;
    END IF;

    -- Otherwise the product's cost per stock unit, converted to the line's unit when both units
    -- are known in the product's form (reconcileChemAutofillUnits; unknown units keep the stock
    -- cost, exactly as the screen does).
    IF v_cost IS NULL AND v_product_id IS NOT NULL THEN
      v_found := false;
      SELECT p.current_cost, lower(btrim(COALESCE(p.unit_size, ''))), p.product_form::text, true
        INTO v_current_cost, v_stock, v_form, v_found
        FROM public.products p
       WHERE p.id = v_product_id;
      IF v_found THEN
        v_cost := COALESCE(round(v_current_cost * 100)::bigint, 0);
        IF v_unit <> '' AND v_stock <> '' AND v_unit <> v_stock THEN
          v_form := COALESCE(v_form, CASE WHEN v_stock IN ('lb', 'lbs', 'pound', 'pounds', 'ton', 'tons') THEN 'dry' END);
          v_factor := public.field_app_priced_quantity(1, v_unit, v_stock, v_form);
          IF v_factor IS NOT NULL THEN
            v_cost := round(v_cost * v_factor)::bigint;
          END IF;
        END IF;
      END IF;
    END IF;

    v_out := v_out || jsonb_build_array(v_chem || jsonb_build_object('cost_per_unit_cents', COALESCE(v_cost, 0)));
  END LOOP;

  RETURN v_out;
END;
$function$;

-- save_field_app_invoice (non-admin): cost_cents per the product's sold unit. On an existing
-- invoice the cost already stored for that product in the invoice's group wins (an admin may have
-- corrected it, and the screen sends it back for an admin); otherwise the product's current cost;
-- 0 without a product.
CREATE OR REPLACE FUNCTION public._cost_step2_field_app_chemicals(p_invoice_id uuid, p_chemicals jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_group_id uuid;
  v_out jsonb := '[]'::jsonb;
  v_chem jsonb;
  v_product_id uuid;
  v_sort integer;
  v_cost bigint;
BEGIN
  IF jsonb_typeof(p_chemicals) IS DISTINCT FROM 'array' THEN
    RETURN p_chemicals;  -- the writer refuses a malformed payload itself
  END IF;
  IF p_invoice_id IS NOT NULL THEN
    SELECT i.invoice_group_id INTO v_group_id FROM public.invoices i WHERE i.id = p_invoice_id;
  END IF;

  FOR v_chem IN SELECT e.value FROM jsonb_array_elements(p_chemicals) WITH ORDINALITY AS e(value, ord) ORDER BY e.ord
  LOOP
    IF jsonb_typeof(v_chem) IS DISTINCT FROM 'object' THEN
      v_out := v_out || jsonb_build_array(v_chem);
      CONTINUE;
    END IF;
    v_product_id := public._cost_step2_try_uuid(v_chem->>'product_id');
    v_sort := CASE WHEN (v_chem->>'sort_order') ~ '^-?[0-9]{1,9}$' THEN (v_chem->>'sort_order')::integer END;
    v_cost := NULL;
    IF p_invoice_id IS NOT NULL AND v_product_id IS NOT NULL THEN
      SELECT ii.cost_cents INTO v_cost
        FROM public.invoice_items ii
        JOIN public.invoices i ON i.id = ii.invoice_id
       WHERE (i.id = p_invoice_id OR (v_group_id IS NOT NULL AND i.invoice_group_id = v_group_id))
         AND i.deleted_at IS NULL
         AND ii.product_id = v_product_id
         AND COALESCE(ii.is_application_fee, false) = false
       ORDER BY (i.id = p_invoice_id) DESC, (ii.sort_order IS NOT DISTINCT FROM v_sort) DESC, ii.sort_order, ii.id
       LIMIT 1;
    END IF;
    IF v_cost IS NULL AND v_product_id IS NOT NULL THEN
      v_cost := public._cost_step2_product_cost_cents(v_product_id);
    END IF;
    v_out := v_out || jsonb_build_array(v_chem || jsonb_build_object('cost_cents', COALESCE(v_cost, 0)));
  END LOOP;
  RETURN v_out;
END;
$function$;

-- save_invoice (non-admin): cost_cents for every line.
CREATE OR REPLACE FUNCTION public._cost_step2_invoice_items(p_invoice jsonb, p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice_id uuid := public._cost_step2_try_uuid(p_invoice->>'id');
  v_is_field boolean;
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_product_id uuid;
  v_is_fee boolean;
  v_sort integer;
  v_qty numeric;
  v_cost bigint;
  v_old_cost bigint;
  v_old_qty numeric;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RETURN p_items;  -- the writer refuses a malformed payload itself
  END IF;
  -- A new invoice is never field_application here (save_invoice refuses that).
  v_is_field := v_invoice_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.invoices i WHERE i.id = v_invoice_id AND i.invoice_type = 'field_application');

  FOR v_item IN SELECT e.value FROM jsonb_array_elements(p_items) WITH ORDINALITY AS e(value, ord) ORDER BY e.ord
  LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      v_out := v_out || jsonb_build_array(v_item);
      CONTINUE;
    END IF;

    v_product_id := public._cost_step2_try_uuid(v_item->>'product_id');
    -- The same truth values the writer's ::boolean cast accepts.
    v_is_fee := lower(btrim(COALESCE(v_item->>'is_application_fee', 'false'))) IN ('true', 't', 'yes', 'y', 'on', '1')
                AND v_product_id IS NULL;
    v_sort := CASE WHEN (v_item->>'sort_order') ~ '^-?[0-9]{1,9}$' THEN (v_item->>'sort_order')::integer END;
    v_qty := CASE WHEN (v_item->>'quantity') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (v_item->>'quantity')::numeric END;
    v_cost := NULL;
    v_old_cost := NULL;
    v_old_qty := NULL;

    IF NOT v_is_field AND v_product_id IS NOT NULL THEN
      -- A sale line: the writer stamps the product's cost itself, so send exactly that (a
      -- stored-line lookup here would make a retry differ once the writer re-stamped the line).
      v_cost := public._cost_step2_product_cost_cents(v_product_id);
    ELSIF v_invoice_id IS NOT NULL THEN
      -- The same stored line: by id, else by product + fee flag + description + position (a
      -- retry finds the rows its first attempt wrote, so it rebuilds the same request).
      SELECT ii.cost_cents, ii.quantity INTO v_old_cost, v_old_qty
        FROM public.invoice_items ii
       WHERE ii.invoice_id = v_invoice_id
         AND ii.id = public._cost_step2_try_uuid(v_item->>'id')
         AND ii.product_id IS NOT DISTINCT FROM v_product_id;
      IF NOT FOUND THEN
        SELECT ii.cost_cents, ii.quantity INTO v_old_cost, v_old_qty
          FROM public.invoice_items ii
         WHERE ii.invoice_id = v_invoice_id
           AND ii.product_id IS NOT DISTINCT FROM v_product_id
           AND COALESCE(ii.is_application_fee, false) = v_is_fee
           AND COALESCE(ii.description, '') = COALESCE(v_item->>'description', '')
           AND ii.sort_order IS NOT DISTINCT FROM v_sort
         ORDER BY ii.id
         LIMIT 1;
      END IF;
      IF v_old_cost IS NOT NULL THEN
        -- A fee line carries an EXTENDED cost (per-acre cost x acres): it follows the acres.
        IF v_is_fee AND v_qty IS NOT NULL AND COALESCE(v_old_qty, 0) > 0 AND v_qty <> v_old_qty THEN
          v_cost := round(v_old_cost * v_qty / v_old_qty)::bigint;
        ELSE
          v_cost := v_old_cost;
        END IF;
      END IF;
    END IF;

    IF v_cost IS NULL AND v_product_id IS NOT NULL THEN
      v_cost := public._cost_step2_product_cost_cents(v_product_id);
    END IF;

    v_out := v_out || jsonb_build_array(v_item || jsonb_build_object('cost_cents', COALESCE(v_cost, 0)));
  END LOOP;

  RETURN v_out;
END;
$function$;

-- Quote snapshots for a non-admin: every value under a key naming cost, profit or margin, at any
-- depth, becomes NULL. Keys are kept so the screen still recognises the snapshot's shape.
CREATE OR REPLACE FUNCTION public._cost_step2_snapshot_without_cost(p_value jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  IF jsonb_typeof(p_value) = 'object' THEN
    SELECT COALESCE(jsonb_object_agg(
             e.key,
             CASE WHEN e.key ~* '(cost|profit|margin)' THEN 'null'::jsonb
                  ELSE public._cost_step2_snapshot_without_cost(e.value) END), '{}'::jsonb)
      INTO v_out
      FROM jsonb_each(p_value) AS e;
    RETURN v_out;
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    SELECT COALESCE(jsonb_agg(public._cost_step2_snapshot_without_cost(e.value) ORDER BY e.ord), '[]'::jsonb)
      INTO v_out
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS e(value, ord);
    RETURN v_out;
  END IF;
  RETURN p_value;
END;
$function$;

REVOKE ALL ON FUNCTION public._cost_step2_try_uuid(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._cost_step2_product_cost_cents(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._cost_step2_job_chemicals(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._cost_step2_field_app_chemicals(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._cost_step2_invoice_items(jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._cost_step2_snapshot_without_cost(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The three saves: a non-admin's cost is worked out here.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_job(
  p_job_id uuid, p_job_payload jsonb, p_fields jsonb, p_chemicals jsonb,
  p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL OR p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()' USING ERRCODE = 'P0001';
  END IF;
  -- Cost is admin-only (Mason, 2026-10-15): a non-admin's chemical cost comes from the server.
  -- The impl keeps every check it had (actor, role, units, totals, idempotency).
  IF public.is_admin() THEN
    RETURN public._save_job_cost_step2_impl(
      p_job_id, p_job_payload, p_fields, p_chemicals, p_performed_by, p_idempotency_key);
  END IF;
  RETURN public._save_job_cost_step2_impl(
    p_job_id, p_job_payload, p_fields,
    public._cost_step2_job_chemicals(p_job_id, p_chemicals),
    p_performed_by, p_idempotency_key);
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_field_app_invoice(
  p_invoice_id uuid, p_invoice jsonb, p_locations jsonb, p_chemicals jsonb,
  p_performed_by uuid, p_application_service_id uuid DEFAULT NULL::uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL OR p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()' USING ERRCODE = 'P0001';
  END IF;
  -- Cost is admin-only (Mason, 2026-10-15): a non-admin's chemical cost comes from the server.
  IF public.is_admin() THEN
    RETURN public._save_field_app_invoice_cost_step2_impl(
      p_invoice_id, p_invoice, p_locations, p_chemicals, p_performed_by,
      p_application_service_id, p_idempotency_key);
  END IF;
  RETURN public._save_field_app_invoice_cost_step2_impl(
    p_invoice_id, p_invoice, p_locations,
    public._cost_step2_field_app_chemicals(p_invoice_id, p_chemicals),
    p_performed_by, p_application_service_id, p_idempotency_key);
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_invoice(
  p_invoice jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Cost is admin-only (Mason, 2026-10-15): a non-admin's line cost comes from the server.
  IF public.is_admin() THEN
    RETURN public._save_invoice_cost_step2_impl(p_invoice, p_items, p_idempotency_key);
  END IF;
  RETURN public._save_invoice_cost_step2_impl(
    p_invoice, public._cost_step2_invoice_items(p_invoice, p_items), p_idempotency_key);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Purchase cost on two read paths reps use (purchase orders themselves are not changed here).
-- ---------------------------------------------------------------------------
-- Row scope is unchanged by running as definer: the body reads orders, order_items, customers,
-- purchase_orders and purchase_order_items, whose SELECT policies (read live 2026-10-19) all let an
-- admin or a sales rep see every row, and this wrapper answers only admins and sales reps.
CREATE OR REPLACE FUNCTION public.get_chemical_history(p_product_id uuid, p_start_date date, p_end_date date)
RETURNS TABLE(transaction_date text, transaction_type text, reference_number text, customer_name text,
              quantity numeric, unit text, unit_price numeric, total_amount numeric, notes text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin boolean := public.is_admin();
BEGIN
  -- Orders and purchase orders are readable by admins and sales reps only (RLS); every other
  -- role got no rows from the old SECURITY INVOKER body and still gets none.
  IF NOT (v_admin OR public.is_sales_rep()) THEN
    RETURN;
  END IF;
  -- Purchase cost is admin-only (Mason, 2026-10-15 and 2026-10-18).
  RETURN QUERY
  SELECT r.transaction_date, r.transaction_type, r.reference_number, r.customer_name, r.quantity, r.unit,
         CASE WHEN v_admin OR r.transaction_type IS DISTINCT FROM 'Purchase' THEN r.unit_price END,
         CASE WHEN v_admin OR r.transaction_type IS DISTINCT FROM 'Purchase' THEN r.total_amount END,
         r.notes
    FROM public._get_chemical_history_cost_step2_impl(p_product_id, p_start_date, p_end_date) AS r
   ORDER BY r.transaction_date DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.match_quick_receive_items(p_items jsonb, p_vendor text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result jsonb;
  v_admin boolean := public.is_admin();
BEGIN
  -- The impl keeps its own admin-or-sales-rep check.
  v_result := public._match_quick_receive_items_cost_step2_impl(p_items, p_vendor);
  IF jsonb_typeof(v_result) IS DISTINCT FROM 'array' THEN
    RETURN v_result;
  END IF;
  -- Each allocation says whether it is a cheaper (no-return) line of its product, which the
  -- receiving screen badges; purchase cost itself is admin-only (Mason, 2026-10-18), so only an
  -- admin's reply keeps unit_cost.
  RETURN COALESCE((
    SELECT jsonb_agg(
             CASE WHEN jsonb_typeof(m.value) = 'object' AND jsonb_typeof(m.value->'allocations') = 'array' THEN
               jsonb_set(m.value, '{allocations}', COALESCE((
                 SELECT jsonb_agg(
                          CASE WHEN jsonb_typeof(a.value) = 'object' THEN
                            (CASE WHEN v_admin THEN a.value ELSE a.value - 'unit_cost' END)
                            || jsonb_build_object('is_no_return',
                                 COALESCE((a.value->>'unit_cost')::numeric < mx.max_cost, false))
                          ELSE a.value END
                          ORDER BY a.ord)
                   FROM jsonb_array_elements(m.value->'allocations') WITH ORDINALITY AS a(value, ord)
                   CROSS JOIN LATERAL (
                     SELECT max((x.value->>'unit_cost')::numeric) AS max_cost
                       FROM jsonb_array_elements(m.value->'allocations') AS x(value)
                      WHERE jsonb_typeof(x.value) = 'object'
                   ) AS mx
               ), '[]'::jsonb))
             ELSE m.value END
             ORDER BY m.ord)
      FROM jsonb_array_elements(v_result) WITH ORDINALITY AS m(value, ord)
  ), '[]'::jsonb);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Reads for the screens.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_quote_versions(p_quote_id uuid)
RETURNS TABLE(id uuid, quote_id uuid, version_number integer, sent_by uuid, sent_at timestamptz,
              sent_method text, snapshot_data jsonb, pdf_url text, notes text,
              restore_trusted_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_admin boolean := public.is_admin();
BEGIN
  -- The quote_versions select policy: admins and sales reps.
  IF NOT (v_admin OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT qv.id, qv.quote_id, qv.version_number, qv.sent_by, qv.sent_at, qv.sent_method,
         CASE WHEN v_admin THEN qv.snapshot_data
              ELSE public._cost_step2_snapshot_without_cost(qv.snapshot_data) END,
         qv.pdf_url, qv.notes, qv.restore_trusted_at
    FROM public.quote_versions qv
   WHERE qv.quote_id = p_quote_id
   ORDER BY qv.version_number DESC;
END;
$function$;

-- Admin screens read cost here, by row id, after step 3 revokes the cost columns.
CREATE OR REPLACE FUNCTION public.get_admin_cost_fields(p_table text, p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  -- Cost and margin are admin-only (Mason, 2026-10-15).
  PERFORM public.require_admin();
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN '{}'::jsonb;
  END IF;
  IF cardinality(p_ids) > 5000 THEN
    RAISE EXCEPTION 'COST_FIELDS_TOO_MANY_IDS: ask for at most 5000 rows at a time';
  END IF;

  CASE p_table
    WHEN 'products' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object(
               'current_cost', t.current_cost, 'cost_updated_date', t.cost_updated_date,
               'tier1_margin', t.tier1_margin, 'tier2_margin', t.tier2_margin, 'tier3_margin', t.tier3_margin,
               'tier1_gross_margin', t.tier1_gross_margin, 'tier2_gross_margin', t.tier2_gross_margin,
               'tier3_gross_margin', t.tier3_gross_margin))
        INTO v_out FROM public.products t WHERE t.id = ANY(p_ids);
    WHEN 'quotes' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object(
               'total_cost', t.total_cost, 'total_profit', t.total_profit, 'total_margin_pct', t.total_margin_pct))
        INTO v_out FROM public.quotes t WHERE t.id = ANY(p_ids);
    WHEN 'quote_items' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object(
               'current_cost', t.current_cost, 'profit', t.profit, 'net_margin', t.net_margin,
               'cost_at_quote_cents', t.cost_at_quote_cents))
        INTO v_out FROM public.quote_items t WHERE t.id = ANY(p_ids);
    WHEN 'orders' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object(
               'total_cost', t.total_cost, 'total_profit', t.total_profit, 'total_margin_pct', t.total_margin_pct))
        INTO v_out FROM public.orders t WHERE t.id = ANY(p_ids);
    WHEN 'order_items' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object(
               'cost_per_unit', t.cost_per_unit, 'profit', t.profit, 'net_margin', t.net_margin,
               'cost_at_time_cents', t.cost_at_time_cents))
        INTO v_out FROM public.order_items t WHERE t.id = ANY(p_ids);
    WHEN 'invoices' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('total_cost_cents', t.total_cost_cents))
        INTO v_out FROM public.invoices t WHERE t.id = ANY(p_ids);
    WHEN 'invoice_items' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object(
               'cost_cents', t.cost_cents, 'return_credit_cogs_cents', t.return_credit_cogs_cents))
        INTO v_out FROM public.invoice_items t WHERE t.id = ANY(p_ids);
    WHEN 'jobs' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('total_cost_cents', t.total_cost_cents))
        INTO v_out FROM public.jobs t WHERE t.id = ANY(p_ids);
    WHEN 'job_chemicals' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('cost_per_unit_cents', t.cost_per_unit_cents))
        INTO v_out FROM public.job_chemicals t WHERE t.id = ANY(p_ids);
    WHEN 'purchase_orders' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('total_cost', t.total_cost, 'total_cost_cents', t.total_cost_cents))
        INTO v_out FROM public.purchase_orders t WHERE t.id = ANY(p_ids);
    WHEN 'purchase_order_items' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('unit_cost', t.unit_cost, 'unit_cost_cents', t.unit_cost_cents))
        INTO v_out FROM public.purchase_order_items t WHERE t.id = ANY(p_ids);
    WHEN 'blend_ticket_products' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('unit_cost_cents', t.unit_cost_cents))
        INTO v_out FROM public.blend_ticket_products t WHERE t.id = ANY(p_ids);
    WHEN 'commissions' THEN
      SELECT jsonb_object_agg(t.id, jsonb_build_object('order_profit', t.order_profit))
        INTO v_out FROM public.commissions t WHERE t.id = ANY(p_ids);
    ELSE
      RAISE EXCEPTION 'COST_FIELDS_UNKNOWN_TABLE: %', p_table;
  END CASE;

  RETURN COALESCE(v_out, '{}'::jsonb);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Grants: signed-in callers only, never anon; the new functions gate the role themselves.
-- ---------------------------------------------------------------------------
DO $grants$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('save_job', 'uuid,jsonb,jsonb,jsonb,uuid,text'),
      ('save_field_app_invoice', 'uuid,jsonb,jsonb,jsonb,uuid,uuid,text'),
      ('save_invoice', 'jsonb,jsonb,text'),
      ('get_chemical_history', 'uuid,date,date'),
      ('match_quick_receive_items', 'jsonb,text'),
      ('get_quote_versions', 'uuid'),
      ('get_admin_cost_fields', 'text,uuid[]')
    ) AS v(name, args)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC, anon', r.name, r.args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO authenticated, service_role', r.name, r.args);
  END LOOP;
END
$grants$;

-- ---------------------------------------------------------------------------
-- 7. Verify.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)', 'public._cost_step2_job_chemicals(p_job_id, p_chemicals)'),
      ('public.save_field_app_invoice(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)', 'public._cost_step2_field_app_chemicals(p_invoice_id, p_chemicals)'),
      ('public.save_invoice(jsonb,jsonb,text)', 'public._cost_step2_invoice_items(p_invoice, p_items)'),
      ('public.get_chemical_history(uuid,date,date)', 'CASE WHEN v_admin OR r.transaction_type IS DISTINCT FROM ''Purchase'' THEN r.unit_price END'),
      ('public.match_quick_receive_items(jsonb,text)', 'a.value - ''unit_cost'''),
      ('public.get_quote_versions(uuid)', 'public._cost_step2_snapshot_without_cost(qv.snapshot_data)'),
      ('public.get_admin_cost_fields(text,uuid[])', 'PERFORM public.require_admin();')
    ) AS v(sig, needle)
  LOOP
    IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp']
              FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)) THEN
      RAISE EXCEPTION 'COST_STEP2_VERIFY: % is not SECURITY DEFINER with the pinned search_path', r.sig;
    END IF;
    IF NOT has_function_privilege('authenticated', to_regprocedure(r.sig), 'EXECUTE')
       OR has_function_privilege('anon', to_regprocedure(r.sig), 'EXECUTE') THEN
      RAISE EXCEPTION 'COST_STEP2_VERIFY: % has the wrong EXECUTE grants', r.sig;
    END IF;
    IF position(r.needle IN (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig))) = 0 THEN
      RAISE EXCEPTION 'COST_STEP2_VERIFY: % does not contain its cost gate', r.sig;
    END IF;
  END LOOP;

  -- Five renamed bodies, unchanged, and no API role may call them or the helpers.
  FOR r IN
    SELECT * FROM (VALUES
      ('public._save_job_cost_step2_impl(uuid,jsonb,jsonb,jsonb,uuid,text)', '8acf34542105a90212ddb0a5e7c5d272'),
      ('public._save_field_app_invoice_cost_step2_impl(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)', '8700762576625bd06a833845d57ddbb6'),
      ('public._save_invoice_cost_step2_impl(jsonb,jsonb,text)', 'cb932dc51a680442affde5aeba2eaee3'),
      ('public._get_chemical_history_cost_step2_impl(uuid,date,date)', 'a625bbe0eeded3089671740002554624'),
      ('public._match_quick_receive_items_cost_step2_impl(jsonb,text)', '2f674b20b0eefaa13a894d82d87c3abe')
    ) AS v(sig, md5)
  LOOP
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_proc p
         WHERE p.oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.md5 THEN
      RAISE EXCEPTION 'COST_STEP2_VERIFY: % is not the renamed live body', r.sig;
    END IF;
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND (p.proname LIKE '\_%\_cost\_step2\_impl' OR p.proname LIKE '\_cost\_step2\_%')
  LOOP
    IF has_function_privilege('authenticated', r.sig, 'EXECUTE')
       OR has_function_privilege('anon', r.sig, 'EXECUTE')
       OR has_function_privilege('service_role', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'COST_STEP2_VERIFY: % is callable by an API role', r.sig;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname LIKE '\_%\_cost\_step2\_impl') <> 5 THEN
    RAISE EXCEPTION 'COST_STEP2_VERIFY: expected 5 renamed impls';
  END IF;

  -- Each wrapper keeps its body's exact signature, defaults and return type.
  FOR r IN
    SELECT * FROM (VALUES
      ('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)', 'public._save_job_cost_step2_impl(uuid,jsonb,jsonb,jsonb,uuid,text)'),
      ('public.save_field_app_invoice(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)', 'public._save_field_app_invoice_cost_step2_impl(uuid,jsonb,jsonb,jsonb,uuid,uuid,text)'),
      ('public.save_invoice(jsonb,jsonb,text)', 'public._save_invoice_cost_step2_impl(jsonb,jsonb,text)'),
      ('public.get_chemical_history(uuid,date,date)', 'public._get_chemical_history_cost_step2_impl(uuid,date,date)'),
      ('public.match_quick_receive_items(jsonb,text)', 'public._match_quick_receive_items_cost_step2_impl(jsonb,text)')
    ) AS v(wrapper, impl)
  LOOP
    IF pg_get_function_arguments(to_regprocedure(r.wrapper)) IS DISTINCT FROM pg_get_function_arguments(to_regprocedure(r.impl))
       OR pg_get_function_result(to_regprocedure(r.wrapper)) IS DISTINCT FROM pg_get_function_result(to_regprocedure(r.impl)) THEN
      RAISE EXCEPTION 'COST_STEP2_VERIFY: % does not keep the signature of %', r.wrapper, r.impl;
    END IF;
  END LOOP;

END
$verify$;

NOTIFY pgrst, 'reload schema';
