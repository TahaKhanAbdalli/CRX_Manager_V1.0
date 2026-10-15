-- Written 2026-10-15. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: a sales rep records only their own name as a quote's salesperson; admins are
--   unrestricted. Season rollover keeps the original rep on the new season's quote.
--   1. New trigger function public.guard_rep_quote_salesman_20261015() (SECURITY INVOKER,
--      search_path public, pg_temp, executable by no API role) and one trigger that runs it:
--        quotes_guard_rep_salesman_20261015  BEFORE INSERT OR UPDATE OF salesman_id ON quotes
--      For an active sales rep who is not an admin (is_admin()/is_sales_rep(), read from auth.uid()):
--        * INSERT: salesman_id must be NULL or the rep, except the season-rollover case below;
--        * UPDATE: salesman_id may change only from NULL to the rep. Another person's name is never
--          replaced (not even with the rep's own), never cleared, and a blank is never filled with
--          someone else's name.
--      Refused with SALESMAN_SCOPE_DENIED (P0001), the code the order, blend-ticket and invoice
--      own-name checks use. An UPDATE that leaves salesman_id unchanged is never refused, so every
--      definer-rights quote RPC that updates a quote while a rep is signed in is unaffected.
--      Admins, service-side callers with no auth.uid() (auto_expire_quotes) and every other role
--      pass straight through. It covers a rep's direct Data API INSERT or UPDATE of a quote
--      (quotes_insert/quotes_update have no salesperson test) as well as every RPC.
--   2. Season rollover (Mason, 2026-10-15: "On season rollover, keep the original rep on the new
--      quote"). rollover_quote_to_season (admins and active reps) copies the source quote's
--      salesman_id onto the new season's quote, so a rep rolling over another rep's quote would be
--      refused by (1). It is re-emitted as its verbatim live body plus two set_config lines (and a
--      three-line comment) around its one quotes INSERT: set_config('crx.quote_rollover_source',
--      <source quote id>, true) before it and set_config(..., '', true) after it. The preflight
--      refuses if any function already references that marker; the postflight requires that only
--      the rollover and the guard do. The guard accepts another person's name on INSERT only
--      while that transaction-local marker is set and the new row's salesman_id equals the marked
--      source quote's (locked FOR UPDATE by the function). The Data API cannot set that marker
--      (PostgREST sets only its own request.* settings, set_config is not exposed, and every
--      request is its own transaction), the same reasoning 20261014210000 used for
--      crx.order_invoice_autosplit. Pre md5 931a2be1b6c831afc527b1fa10c6d303 (live 2026-10-15,
--      identical to 20260702180000), post md5 eb9b65e556f3054d0751f3a7c08dce3f.
--
-- WHY (Mason): the own-name rule since 2026-10-06, narrowed 2026-10-13 to "reps bill any customer,
--   but only under their own name; admins unrestricted"; 2026-10-15 in chat: "Yes — quotes follow
--   the own-name rule. On season rollover, keep the original rep on the new quote."
--   (KNOWN_ISSUES.md, "Quote salesperson").
--
-- NO SCREEN CHANGES BEHAVIOR (read live 2026-10-15): no screen writes quotes.salesman_id; of the
--   live functions that write quotes, only rollover_quote_to_season names salesman_id; all 4 live
--   quotes have it NULL.
--
-- NOT CHANGED: every policy and grant on quotes (the trigger adds the test without widening or
--   narrowing access); rollover's commission_split copy (Goal 2 "Quote splits" is separate work);
--   rollover's key-only idempotency replay (the system-wide receipt-binding task); every other
--   line of rollover_quote_to_season. No rows change. CREATE OR REPLACE keeps that function's OID,
--   owner and exact ACL, and the postflight proves it; the only REVOKE is the routine lock-down of
--   the new trigger function.
--
-- OVERLOADS: rollover_quote_to_season has exactly one overload, (uuid,integer,uuid,text)
--   (read-only on live 2026-10-15); the preflight and postflight refuse a second one.
--
-- ROLLBACK (if ever needed, as its own reviewed migration): DROP TRIGGER
--   quotes_guard_rep_salesman_20261015 ON public.quotes; DROP FUNCTION
--   public.guard_rep_quote_salesman_20261015(); and re-emit rollover_quote_to_season from
--   20260702180000_layer2_rollover_settlement_job_aware.sql.
--
-- ORDERING: strict. Apply after every older pending migration. PR #929's
--   20261015170000_staff_photo_storage_access shares no object with this file; if this file
--   applies first, #929's must be re-stamped above it.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE quote_salesman_own_name_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
       to_regprocedure('public.rollover_quote_to_season(uuid,integer,uuid,text)')::oid AS rollover_oid;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change
  -- (a client that stops on the first error, as every sanctioned apply path does, then stops).
  IF to_regclass('pg_temp.quote_salesman_own_name_tx') IS NULL THEN
    RAISE EXCEPTION 'QUOTE_SALESMAN_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.quote_salesman_own_name_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'QUOTE_SALESMAN_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'rollover_quote_to_season') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_quote_id uuid, p_new_season integer, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text'
        AND md5(replace(p.prosrc, chr(13), '')) = '931a2be1b6c831afc527b1fa10c6d303'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.rollover_quote_to_season(uuid,integer,uuid,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_ROLLOVER_DRIFT: expected the exact reviewed public rollover_quote_to_season';
  END IF;
  -- What the guard relies on, pinned to the live bodies of 2026-10-15: is_admin()/is_sales_rep()
  -- mean an ACTIVE admin/rep read from auth.uid().
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.is_admin()', 'f76bf61116c3bd52bd9c6ea125079b73'),
        ('public.is_sales_rep()', 'fcb3133010fe3f4f56e3be31f709d102')
      ) AS pin(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_DEPENDENCY_DRIFT: is_admin() or is_sales_rep() differs from its reviewed body';
  END IF;
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid = 'public.quotes'::regclass
         AND a.attname = 'salesman_id' AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype) <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_SALESMAN_COLUMN_DRIFT: quotes.salesman_id must be uuid';
  END IF;
  -- Only this file may introduce the rollover marker: no existing function may read or set it.
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.prosrc LIKE '%crx.quote_rollover_source%') THEN
    RAISE EXCEPTION 'PREFLIGHT_ROLLOVER_MARKER_IN_USE: another function already references crx.quote_rollover_source';
  END IF;
  -- Not re-runnable: the guard must not exist yet.
  IF to_regprocedure('public.guard_rep_quote_salesman_20261015()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'quotes_guard_rep_salesman_20261015') THEN
    RAISE EXCEPTION 'PREFLIGHT_GUARD_EXISTS: the quote salesperson guard is already installed';
  END IF;
END
$preflight$;

-- 1. The guard. Deliberately NOT SECURITY DEFINER: it reads only auth.uid(), the role helpers and,
--    inside rollover_quote_to_season (which runs as its owner), the marked source quote.
CREATE FUNCTION public.guard_rep_quote_salesman_20261015()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
DECLARE
  v_source text;
BEGIN
  -- Own name (Mason, 2026-10-06, narrowed 2026-10-13, quotes 2026-10-15): a sales rep records only
  -- themselves as salesperson; an admin may name anyone. Admins, service-side callers with no
  -- auth.uid() and every non-rep role pass through.
  IF public.is_admin() OR NOT public.is_sales_rep() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.salesman_id IS NOT NULL AND NEW.salesman_id IS DISTINCT FROM (SELECT auth.uid()) THEN
      -- Season rollover keeps the original rep (Mason, 2026-10-15). Only rollover_quote_to_season
      -- sets this marker, to its source quote, and only that quote's salesperson is accepted.
      v_source := current_setting('crx.quote_rollover_source', true);
      IF v_source ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         AND NEW.salesman_id = (SELECT q.salesman_id FROM public.quotes q WHERE q.id = v_source::uuid) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: an unchanged salesperson is never refused, so definer RPCs that update another rep's
  -- quote for other reasons keep working. A change is allowed only from blank to the rep.
  IF NEW.salesman_id IS DISTINCT FROM OLD.salesman_id
     AND (OLD.salesman_id IS NOT NULL OR NEW.salesman_id IS DISTINCT FROM (SELECT auth.uid())) THEN
    RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
  END IF;
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION public.guard_rep_quote_salesman_20261015() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER quotes_guard_rep_salesman_20261015
  BEFORE INSERT OR UPDATE OF salesman_id
  ON public.quotes
  FOR EACH ROW EXECUTE FUNCTION public.guard_rep_quote_salesman_20261015();

-- 2. rollover_quote_to_season: verbatim live body plus the two rollover-marker lines and their comment.
CREATE OR REPLACE FUNCTION public.rollover_quote_to_season(p_quote_id uuid, p_new_season integer, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_old_quote quotes%ROWTYPE;
  v_new_quote_id uuid;
  v_new_quote_number text;
  v_section RECORD;
  v_new_section_id uuid;
  v_item RECORD;
  v_tier_price numeric;
  v_current_cost numeric;
  v_has_draws boolean := false;
  v_total_remainder numeric;
  v_drawn numeric;
  v_cum_before numeric;
  v_item_tun numeric;
  v_new_tun numeric;
  v_new_acres numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'rollover_quote_to_season' AND created_at > now() - interval '24 hours'
    ) THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'rollover_quote_to_season', to_jsonb(p_quote_id));
  END IF;

  SELECT * INTO v_old_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;

  -- A5 draw-awareness, GATED to OPEN bookings. LAYER2: "draws" now means BOTH order
  -- draws (quote_product_draws) AND job draws (job_product_draws) — a booking consumed
  -- by a job rolls over only its truly-undrawn remainder (§6.5). The gate includes
  -- 'draft' because a job can be scheduled from a DRAFT planned quote (A4 gates the
  -- reserve on is_planned + non-terminal, which includes draft), so a draft with a live
  -- job draw must NOT clone the job-consumed units into the next season (Codex round-3
  -- P2). Order draws only ever exist on sent/revised, so adding 'draft' only affects
  -- job-draw detection.
  IF v_old_quote.status IN ('draft', 'sent', 'revised') THEN
    SELECT
      EXISTS (SELECT 1 FROM quote_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0)
      -- LAYER2<<< job draws also count as "drawn"
      OR EXISTS (SELECT 1 FROM job_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0)
      -- >>>LAYER2
    INTO v_has_draws;
    IF v_has_draws THEN
      -- LAYER2<<< remainder subtracts order + job draws per product
      SELECT COALESCE(SUM(GREATEST(b.booked - COALESCE(d.quantity_drawn, 0) - COALESCE(jd.qty, 0), 0)), 0)
      INTO v_total_remainder
      FROM (
        SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
        FROM quote_items WHERE quote_id = p_quote_id
        GROUP BY product_id
      ) b
      LEFT JOIN quote_product_draws d
        ON d.quote_id = p_quote_id AND d.product_id = b.product_id
      LEFT JOIN (
        SELECT product_id, SUM(quantity_drawn) AS qty
        FROM job_product_draws WHERE quote_id = p_quote_id
        GROUP BY product_id
      ) jd ON jd.product_id = b.product_id;
      -- >>>LAYER2
      IF v_total_remainder <= 0 THEN
        RAISE EXCEPTION 'BOOKING_FULLY_DRAWN: quote % has no undrawn balance to roll over — every booked quantity is already on orders or jobs', v_old_quote.quote_number;
      END IF;
    END IF;
  END IF;

  SELECT generate_quote_number() INTO v_new_quote_number;

  -- Own name (Mason, 2026-10-15): the new season's quote keeps the original rep. The quote
  -- salesperson guard accepts another rep's name only while this transaction-local marker names
  -- the source quote, and only that quote's salesperson; it is cleared right after the insert.
  PERFORM set_config('crx.quote_rollover_source', p_quote_id::text, true);
  INSERT INTO quotes (
    quote_number, customer_id, created_by, tier, status, is_planned,
    commission_split, valid_days, header_notes, footer_notes, season, salesman_id
  ) VALUES (
    v_new_quote_number, v_old_quote.customer_id, v_actor, v_old_quote.tier,
    'draft', v_old_quote.is_planned, v_old_quote.commission_split,
    v_old_quote.valid_days, v_old_quote.header_notes, v_old_quote.footer_notes,
    p_new_season, v_old_quote.salesman_id
  ) RETURNING id INTO v_new_quote_id;
  PERFORM set_config('crx.quote_rollover_source', '', true);

  FOR v_section IN
    SELECT * FROM quote_sections WHERE quote_id = p_quote_id ORDER BY sort_order
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes)
    VALUES (v_new_quote_id, v_section.section_name, v_section.sort_order,
      v_section.section_notes, v_section.section_header_notes)
    RETURNING id INTO v_new_section_id;

    FOR v_item IN
      SELECT * FROM quote_items WHERE section_id = v_section.id ORDER BY sort_order
    LOOP
      v_drawn := 0;
      v_new_tun := NULL;
      v_new_acres := NULL;
      IF v_has_draws THEN
        -- LAYER2<<< consumed quantity = order draws + job draws for this product
        SELECT
          COALESCE((SELECT quantity_drawn FROM quote_product_draws
                    WHERE quote_id = p_quote_id AND product_id = v_item.product_id), 0)
          + COALESCE((SELECT SUM(quantity_drawn) FROM job_product_draws
                      WHERE quote_id = p_quote_id AND product_id = v_item.product_id), 0)
        INTO v_drawn;
        v_drawn := COALESCE(v_drawn, 0);
        -- >>>LAYER2
        IF v_drawn > 0 THEN
          v_item_tun := COALESCE(v_item.total_units_needed, 0);
          SELECT COALESCE(SUM(COALESCE(qi2.total_units_needed, 0)), 0) INTO v_cum_before
          FROM quote_items qi2
          JOIN quote_sections qs2 ON qs2.id = qi2.section_id
          WHERE qi2.quote_id = p_quote_id
            AND qi2.product_id = v_item.product_id
            AND (qs2.sort_order, qs2.id, qi2.sort_order, qi2.id)
              < (v_section.sort_order, v_section.id, v_item.sort_order, v_item.id);
          v_new_tun := LEAST(v_item_tun, GREATEST(v_cum_before + v_item_tun - v_drawn, 0));
          IF v_new_tun <= 0 THEN
            CONTINUE;
          END IF;
          IF v_new_tun = v_item_tun THEN
            v_new_acres := v_item.acres;
          ELSIF v_item.acres IS NOT NULL AND v_item_tun > 0 THEN
            v_new_acres := ROUND(v_item.acres * v_new_tun / v_item_tun, 2);
          ELSE
            v_new_acres := v_item.acres;
          END IF;
        END IF;
      END IF;

      SELECT CASE v_old_quote.tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
        WHEN 3 THEN COALESCE(p.tier3_price, p.tier1_price, 0)
        ELSE COALESCE(p.tier1_price, 0)
      END, p.current_cost
      INTO v_tier_price, v_current_cost
      FROM products p WHERE p.id = v_item.product_id;

      IF v_has_draws AND v_drawn > 0 THEN
        INSERT INTO quote_items (
          quote_id, section_id, product_id, sort_order, notes,
          price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
          acres, calc_mode, price_unit, total_units_needed
        ) VALUES (
          v_new_quote_id, v_new_section_id, v_item.product_id, v_item.sort_order,
          v_item.notes, v_tier_price, v_current_cost, v_item.suggested_rate,
          v_item.actual_rate, v_item.rate_unit, v_new_acres,
          v_item.calc_mode, v_item.price_unit, v_new_tun
        );
      ELSE
        INSERT INTO quote_items (
          quote_id, section_id, product_id, sort_order, notes,
          price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
          acres, calc_mode, price_unit
        ) VALUES (
          v_new_quote_id, v_new_section_id, v_item.product_id, v_item.sort_order,
          v_item.notes, v_tier_price, v_current_cost, v_item.suggested_rate,
          v_item.actual_rate, v_item.rate_unit, v_item.acres,
          v_item.calc_mode, v_item.price_unit
        );
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'created',
    'quote_id', v_new_quote_id,
    'quote_number', v_new_quote_number,
    'season', p_new_season,
    'remainder_rollover', v_has_draws
  );
END;
$function$;

DO $postflight$
BEGIN
  IF to_regclass('pg_temp.quote_salesman_own_name_tx') IS NULL THEN
    RAISE EXCEPTION 'QUOTE_SALESMAN_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.quote_salesman_own_name_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'QUOTE_SALESMAN_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF to_regprocedure('public.rollover_quote_to_season(uuid,integer,uuid,text)')::oid
       IS DISTINCT FROM (SELECT rollover_oid FROM pg_temp.quote_salesman_own_name_tx) THEN
    RAISE EXCEPTION 'POSTFLIGHT_ROLLOVER_IDENTITY: the replace must preserve the function OID';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'rollover_quote_to_season') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_quote_id uuid, p_new_season integer, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text'
        AND md5(replace(p.prosrc, chr(13), '')) = 'eb9b65e556f3054d0751f3a7c08dce3f'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.rollover_quote_to_season(uuid,integer,uuid,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_ROLLOVER_CONTRACT: public rollover_quote_to_season body, signature or access drifted';
  END IF;
  -- The guard runs with the caller's rights, a pinned search_path, and no API role may call it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.guard_rep_quote_salesman_20261015()')
       AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef
       AND p.prorettype = 'trigger'::regtype
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
  ) OR EXISTS (
    SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS api_role
     WHERE has_function_privilege(api_role, 'public.guard_rep_quote_salesman_20261015()', 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_GUARD_FUNCTION_CONTRACT: guard_rep_quote_salesman_20261015 must be SECURITY INVOKER, search_path public, pg_temp, executable by no API role';
  END IF;
  -- Exactly two functions reference the rollover marker: the rollover that sets it and the guard
  -- that reads it.
  IF (SELECT array_agg(p.oid ORDER BY p.oid) FROM pg_proc p
       WHERE p.prosrc LIKE '%crx.quote_rollover_source%')
     IS DISTINCT FROM (SELECT array_agg(o ORDER BY o) FROM unnest(ARRAY[
       to_regprocedure('public.rollover_quote_to_season(uuid,integer,uuid,text)')::oid,
       to_regprocedure('public.guard_rep_quote_salesman_20261015()')::oid]) AS o) THEN
    RAISE EXCEPTION 'POSTFLIGHT_ROLLOVER_MARKER_SCOPE: only rollover_quote_to_season and the quote guard may reference crx.quote_rollover_source';
  END IF;
  -- The trigger is enabled, ROW level, BEFORE, on INSERT and on UPDATE OF salesman_id only.
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.quotes'::regclass
         AND t.tgname = 'quotes_guard_rep_salesman_20261015'
         AND t.tgfoid = to_regprocedure('public.guard_rep_quote_salesman_20261015()')
         AND t.tgenabled = 'O'
         AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(t.tgattr) k
                JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k) = ARRAY['salesman_id']
         AND (t.tgtype::int & 3) = 3       -- ROW level, BEFORE
         AND (t.tgtype::int & 4) <> 0      -- fires on INSERT
         AND (t.tgtype::int & 16) <> 0     -- and on UPDATE
         AND (t.tgtype::int & 8) = 0       -- not on DELETE
     ) <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_GUARD_TRIGGER: the quote salesperson guard trigger must be installed as reviewed';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: a sales rep records only themselves (or no one) as a quote''s salesperson; season rollover keeps the original rep; admins unrestricted';
END
$postflight$;
