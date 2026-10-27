-- Written 2026-10-25. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: a sent quote keeps the prices the customer saw (To-Do 1.2; pricing plan
--   docs/plans/2026-10-13-pricing-history-cost-tracking-and-quote-pricing-PLAN.md, slice 2).
--   Before this, every save_quote re-priced each line without a manual price to today's tier
--   price, including the save the screen ran on the way to Convert, so a price change between
--   send and accept reached the order (read live 2026-10-14 and 2026-10-25).
--   1. New public._assert_quote_prices_as_sent(uuid) (invoker rights, search_path public,
--      pg_temp, executable by no API role). The price authority is the quote's LAST sent
--      version (quote_versions, newest version_number). It refuses with QUOTE_RESEND_REQUIRED
--      (P0001) when the quote's customer differs from that version's, or a current line is not
--      a line of that version for the same product at the same price_per_unit. A quote that
--      was never sent passes (a draft, planned booking included, keeps its own prices: Mason,
--      2026-10-14). A last version from before the protected send workflow
--      (restore_trusted_at IS NULL) cannot vouch for its prices and is refused. Versions written
--      before this file carry no line ids; for them lines pair one to one by product and any
--      added, removed or repeated product needs a re-send (fails closed).
--   2. _save_quote_below_cost_impl_20260810 (behind save_quote): once a quote has a sent
--      version, a line the payload names by its saved id (same product) keeps its stored price
--      on every save; only a manual price (price_override) or the line's new use_todays_price
--      flag changes it. A new line, or a line matched only by the existing one-per-product
--      fallback, keeps that fallback's cost but takes today's tier price, so the quote screen
--      (which names every saved line) and the server agree; (1) then asks for a re-send if the
--      price moved. Editing a sent quote keeps its expires_at. The transition into 'accepted'
--      must pass (1); a quote already accepted can still be saved. The reply adds item_prices
--      (client_key -> stored price_per_unit; prices only, no cost).
--   3. _create_quote_version_owner_impl (behind create_quote_version, every send): each
--      snapshot line records quote_item_id and price_override, each section its field_id; every
--      send sets expires_at to the Chicago business date plus valid_days.
--   4. _restore_quote_version_owner_impl (behind restore_quote_version, the rewind): restores the
--      version's customer (when it still exists) and tier, each line under its own id with its
--      own manual price, and each section's field when that field still belongs to the quote's
--      customer, so a rewound quote matches the version as sent and converts without a re-send.
--   5. The routes from a sent quote to something billable call (1) before writing anything:
--      _convert_quote_to_order_below_cost_impl_20260810 (convert_quote_to_order; skipped only
--      where the owner implementation returns an existing order or refuses: an accepted quote
--      with an order, or a booking with draws; a quote reopened after its order was cancelled or
--      voided is checked again),
--      _draw_down_quote_intent_impl_20260819 (draw_down_quote) and
--      create_job_from_quote_section. The order, draw and job then copy the current quote line
--      prices, which (1) has just proven equal to the sent ones.
--   Every other line of the six re-emitted functions is their live body of 2026-10-25,
--   extracted from a replayed real-schema database whose md5s equal live (pinned below).
--
-- WHY (Mason, 2026-10-13/14, docs/manual/DECISION_LOG.md): a sent quote's prices stay locked;
--   locked means prices only (products, quantities and notes may still be revised); a revision
--   that changes a price must be re-sent before it is billed; rewind to the version last sent;
--   editing a sent quote no longer moves its expiry, only a send does; if cost rises above a
--   locked price, Convert honors the price but needs an admin's below-cost approval with a
--   reason (unchanged: the live order_items below-cost trigger already requires it, proven by
--   scripts/smoke/smoke-convert-sent-quote-in-one-step.sql).
--
-- NOT CHANGED: grants and policies on every table; the order, draw and job pricing arithmetic;
--   the draw-down provenance rules and QUOTE_RESTORE_BLOCKED_BY_DRAW (a booking ever drawn still
--   cannot be rewound, KNOWN_ISSUES.md); auto_expire_quotes; revert_quote_status; duplicate and
--   rollover (both start a new draft, the route to today's prices for an expired quote). Not
--   covered here and recorded as follow-ups: the blend-ticket and field-application invoice
--   paths read a quote line's current price directly. No rows change. CREATE OR REPLACE keeps
--   each function's OID, owner and ACL; the postflight proves it.
--
-- OVERLOADS: each re-emitted function has exactly one overload (read-only on live 2026-10-25);
--   the preflight and postflight refuse a second one.
--
-- ROLLBACK (if ever needed, as its own reviewed migration): re-emit the six functions from their
--   pre-image (the bodies pinned in the preflight; sources 20260812115236/20260812115237,
--   20260813080000, 20260816120000, 20260819232000 and 20260707060000) and
--   DROP FUNCTION public._assert_quote_prices_as_sent(uuid). Versions written meanwhile keep
--   their extra keys, which the old bodies ignore.
--
-- ORDERING: strict. Apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE quote_sent_price_lock_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.quote_sent_price_lock_tx') IS NULL THEN
    RAISE EXCEPTION 'QUOTE_SENT_PRICE_LOCK_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.quote_sent_price_lock_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'QUOTE_SENT_PRICE_LOCK_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- The six re-emitted functions, pinned to their live bodies, owner, mode, search_path and
  -- EXECUTE grants of 2026-10-25. Each has exactly one overload.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('_save_quote_below_cost_impl_20260810', 'public._save_quote_below_cost_impl_20260810(uuid,jsonb,jsonb,uuid,text)',
          '8c11384d8f251f11a1e0e219304944a9', ARRAY['postgres']),
        ('_create_quote_version_owner_impl', 'public._create_quote_version_owner_impl(uuid,uuid,text,text)',
          'ca6f39f06dceddfeaf46b3a91d1662e4', ARRAY['postgres', 'service_role']),
        ('_restore_quote_version_owner_impl', 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)',
          '04fff33386072ce9575f5f2960a064f1', ARRAY['postgres', 'service_role']),
        ('_convert_quote_to_order_below_cost_impl_20260810', 'public._convert_quote_to_order_below_cost_impl_20260810(uuid,uuid,text,bigint)',
          '2b10185e7be4f760c1b69cd479c0135d', ARRAY['postgres']),
        ('_draw_down_quote_intent_impl_20260819', 'public._draw_down_quote_intent_impl_20260819(uuid,jsonb,uuid,text,text)',
          '8e54d07fea898c79352489cecb00f024', ARRAY['postgres']),
        ('create_job_from_quote_section', 'public.create_job_from_quote_section(uuid,uuid,uuid,text)',
          '32bad5779fbac099f512f67805ea26a3', ARRAY['authenticated', 'postgres', 'service_role'])
      ) AS pin(fn, sig, body_md5, execs)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc o
             WHERE o.pronamespace = 'public'::regnamespace AND o.proname = pin.fn) <> 1
        OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
        OR p.proowner <> 'postgres'::regrole
        OR NOT p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM pin.execs
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_QUOTE_FUNCTION_DRIFT: a re-emitted quote function differs from its reviewed live body, owner, mode, search_path or grants';
  END IF;

  -- Columns the new bodies read or write.
  IF (SELECT count(*) FROM pg_attribute a
       WHERE NOT a.attisdropped AND (
            (a.attrelid = 'public.quote_items'::regclass AND a.attname IN ('id', 'price_override', 'price_per_unit')
              AND a.atttypid IN ('uuid'::regtype, 'numeric'::regtype))
         OR (a.attrelid = 'public.quote_sections'::regclass AND a.attname = 'field_id' AND a.atttypid = 'uuid'::regtype)
         OR (a.attrelid = 'public.quote_versions'::regclass AND a.attname IN ('snapshot_data', 'restore_trusted_at', 'version_number'))
         OR (a.attrelid = 'public.quotes'::regclass AND a.attname IN ('expires_at', 'valid_days', 'customer_id'))
       )) <> 10 THEN
    RAISE EXCEPTION 'PREFLIGHT_QUOTE_COLUMN_DRIFT: a quote column this file relies on is missing or retyped';
  END IF;

  -- Not re-runnable: the price authority check must not exist yet.
  IF EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace
              AND proname = '_assert_quote_prices_as_sent') THEN
    RAISE EXCEPTION 'PREFLIGHT_PRICE_LOCK_EXISTS: _assert_quote_prices_as_sent is already installed';
  END IF;
END
$preflight$;

-- 1. The price authority check.

CREATE FUNCTION public._assert_quote_prices_as_sent(p_quote_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $assert$
DECLARE
  v_version_number integer;
  v_snapshot jsonb;
  v_trusted_at timestamptz;
  v_customer_id uuid;
  v_sent_items jsonb;
  v_problem text;
  v_resend text;
BEGIN
  -- The price authority is the version last sent to the customer (Mason, 2026-10-13/14): a sent
  -- quote's prices change only through a revision that is sent again. Callers hold the quote row
  -- lock. Not SECURITY DEFINER: it runs inside the definer-rights quote functions, and no API
  -- role may execute it.
  SELECT version_number, snapshot_data, restore_trusted_at
    INTO v_version_number, v_snapshot, v_trusted_at
  FROM quote_versions
  WHERE quote_id = p_quote_id
  ORDER BY version_number DESC
  LIMIT 1;
  -- Never sent: a draft (a planned booking included) keeps its own prices, as before.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_resend := format('Send the quote to the customer again (it becomes V%s), or rewind it to V%s, then try again.',
    v_version_number + 1, v_version_number);

  -- A version from before the protected send workflow (20260826220000) could have been written
  -- by hand, so it cannot vouch for what the customer saw.
  IF v_trusted_at IS NULL THEN
    RAISE EXCEPTION 'QUOTE_RESEND_REQUIRED: V% of this quote was saved before sent versions were protected, so its prices cannot be confirmed. Send the quote to the customer again, then try again.',
      v_version_number
      USING ERRCODE = 'P0001';
  END IF;

  SELECT customer_id INTO v_customer_id FROM quotes WHERE id = p_quote_id;
  IF (v_snapshot->'quote'->>'customer_id') IS DISTINCT FROM v_customer_id::text THEN
    RAISE EXCEPTION 'QUOTE_RESEND_REQUIRED: the customer changed after V% was sent. %', v_version_number, v_resend
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(jsonb_agg(i.item), '[]'::jsonb)
    INTO v_sent_items
  FROM jsonb_array_elements(COALESCE(v_snapshot->'sections', '[]'::jsonb)) AS s(section)
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.section->'items', '[]'::jsonb)) AS i(item);

  IF jsonb_array_length(v_sent_items) > 0
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_sent_items) AS i(item)
       WHERE NULLIF(i.item->>'quote_item_id', '') IS NULL
     ) THEN
    -- Each line must be a line that was sent, for the same product, at the same price. Lines
    -- removed in a revision, and quantity, rate, acre and note changes, need no re-send:
    -- the lock covers prices only (Mason, 2026-10-14).
    SELECT p.product_name INTO v_problem
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = p_quote_id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_sent_items) AS i(item)
        WHERE i.item->>'quote_item_id' = qi.id::text
          AND i.item->>'product_id' = qi.product_id::text
          AND (i.item->>'price_per_unit')::numeric = qi.price_per_unit
      )
    ORDER BY qi.sort_order, qi.id
    LIMIT 1;
  ELSE
    -- A version saved before versions recorded line ids: lines can be matched only one to one
    -- by product, so any added, removed or repeated product needs a re-send (fails closed).
    IF (SELECT count(*) FROM quote_items WHERE quote_id = p_quote_id) <> jsonb_array_length(v_sent_items)
       OR EXISTS (SELECT 1 FROM quote_items WHERE quote_id = p_quote_id GROUP BY product_id HAVING count(*) > 1)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_sent_items) AS i(item)
                  GROUP BY i.item->>'product_id' HAVING count(*) > 1) THEN
      RAISE EXCEPTION 'QUOTE_RESEND_REQUIRED: this quote''s lines no longer match V% as sent, and that version cannot tell its lines apart. %',
        v_version_number, v_resend
        USING ERRCODE = 'P0001';
    END IF;
    SELECT p.product_name INTO v_problem
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    WHERE qi.quote_id = p_quote_id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_sent_items) AS i(item)
        WHERE i.item->>'product_id' = qi.product_id::text
          AND (i.item->>'price_per_unit')::numeric = qi.price_per_unit
      )
    ORDER BY qi.sort_order, qi.id
    LIMIT 1;
  END IF;

  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_RESEND_REQUIRED: % has a price or line the customer was not sent in V%. %',
      v_problem, v_version_number, v_resend
      USING ERRCODE = 'P0001';
  END IF;
END
$assert$;

REVOKE ALL ON FUNCTION public._assert_quote_prices_as_sent(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 2. save_quote: a sent quote keeps its prices and expiry; accepting needs the sent prices.

CREATE OR REPLACE FUNCTION public._save_quote_below_cost_impl_20260810(p_quote_id uuid, p_quote_payload jsonb, p_sections jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_quote_id uuid;
  v_section_id uuid;
  v_item jsonb;
  v_section jsonb;
  v_status text;
  v_old_status text;
  v_quote_owner uuid;
  v_old_commission_split jsonb;
  v_old_row_version bigint;
  v_expected_row_version bigint;
  v_tier int;
  v_server_totals record;
  v_drawn_guard record;
  v_allowed_transitions jsonb := '{
    "draft": ["sent"],
    "sent": ["revised","accepted","declined","expired"],
    "revised": ["sent","accepted","declined","expired"]
  }'::jsonb;
  v_cached_quote_id uuid;
  v_cached_row_version bigint;
  v_existing jsonb;
  v_result jsonb;
  v_request_fingerprint text;
  -- SNAPSHOT<<< prior-item cost map (id -> {p: product_id, c: cost}) captured
  -- before the delete+reinsert. Strictly id-keyed; no product_id fallback.
  v_prior_item_costs jsonb := '{}'::jsonb;
  -- Ids already claimed by an earlier payload row in THIS save. Each prior id
  -- may be consumed at most once (P1-B); a repeat is a hard domain error.
  v_consumed_item_ids jsonb := '{}'::jsonb;
  -- Per-row scratch for the reinsert loop.
  v_payload_item_id text;
  v_reuse_item_id uuid;
  v_preserved_cost bigint;
  v_consumed_prior_ids jsonb := '{}'::jsonb;
  v_fallback_prior_id text;
  v_fallback_distinct_costs int;
  v_idless_by_product jsonb := '{}'::jsonb;
  v_idless_count int;
  v_fallback_candidates int;
  -- The id actually written for this row, and the client-key -> id map returned
  -- to the caller. save_quote deletes and reinserts every line, so a browser
  -- that added new lines has no way to learn their ids; without this it keeps
  -- sending them id-less forever and the second save trips the ambiguity guard
  -- (two new lines of one product). client_key is an opaque caller-supplied
  -- string used only to address the response -- it is never an id and never
  -- influences which snapshot a row receives. (Codex round 28.)
  v_new_item_id uuid;
  v_client_key text;
  v_item_ids jsonb := '{}'::jsonb;
  -- >>>SNAPSHOT
  -- PRICE LOCK (20261027040000): a quote that has been sent (it has a quote_versions row) keeps
  -- each existing line's stored price on every save. Only a manual price (price_override) or the
  -- line's use_todays_price flag changes it; a new line takes today's tier price. A draft that was
  -- never sent follows the catalog as before (Mason, 2026-10-14).
  v_price_locked boolean := false;
  v_carry_prices jsonb := '{}'::jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = v_actor AND role IN ('admin','sales_rep') AND is_active = true
  ) THEN
    RAISE EXCEPTION 'Not authorized to save quotes';
  END IF;

  v_request_fingerprint := md5(jsonb_build_object(
    'quote_id', p_quote_id,
    'quote_payload', p_quote_payload,
    'sections', p_sections,
    'performed_by', p_performed_by
  )::text);

  -- Quote ownership is checked before the idempotency lookup so a SECURITY
  -- DEFINER replay cannot expose another rep's result. The check is deliberately
  -- non-locking here: every idempotent Quote writer must take the advisory lock
  -- before any Quote row lock. Ownership is checked again under the later row
  -- lock before a replay return or direct mutation.
  IF p_quote_id IS NOT NULL
     AND NOT public.is_admin()
     AND NOT EXISTS (
       SELECT 1 FROM quotes
       WHERE id = p_quote_id
         AND created_by = v_actor
     ) THEN
    RAISE EXCEPTION 'NOT_QUOTE_OWNER';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_quote');
    IF v_existing IS NOT NULL THEN
      -- A create replay has no p_quote_id to authorize before the lookup, so
      -- bind the cached result to its real target before releasing it. Existing
      -- saves must also reject a key cached for a different quote.
      v_cached_quote_id := NULLIF(v_existing->>'quote_id', '')::uuid;
      IF v_cached_quote_id IS NULL THEN
        RAISE EXCEPTION 'SAVE_QUOTE_RESULT_INVALID';
      END IF;
      IF p_quote_id IS NOT NULL
         AND p_quote_id IS DISTINCT FROM v_cached_quote_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      IF NOT public.is_admin()
         AND NOT EXISTS (
           SELECT 1 FROM quotes
           WHERE id = v_cached_quote_id
             AND created_by = v_actor
      ) THEN
        RAISE EXCEPTION 'NOT_QUOTE_OWNER';
      END IF;
      IF v_existing->>'_request_fingerprint' IS DISTINCT FROM v_request_fingerprint THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      IF jsonb_typeof(v_existing->'row_version') <> 'number'
         OR (v_existing->>'row_version') !~ '^(0|[1-9][0-9]*)$' THEN
        RAISE EXCEPTION 'SAVE_QUOTE_RESULT_INVALID';
      END IF;
      v_cached_row_version := (v_existing->>'row_version')::bigint;
      SELECT created_by, row_version
        INTO v_quote_owner, v_old_row_version
      FROM quotes
      WHERE id = v_cached_quote_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after the saved request completed — reload to review the current quote before continuing';
      END IF;
      IF NOT public.is_admin() AND v_quote_owner IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'NOT_QUOTE_OWNER';
      END IF;
      IF v_old_row_version IS DISTINCT FROM v_cached_row_version THEN
        RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after the saved request completed — reload to review the current quote before continuing';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  v_status := COALESCE(p_quote_payload->>'status', 'draft');
  v_tier := COALESCE((p_quote_payload->>'tier')::int, 1);

  IF p_quote_id IS NOT NULL THEN
    -- LAYER2-COORD (#5): lock the quote row up front (FOR UPDATE) so the unplan
    -- guard's job_product_draws check below can't be raced by a concurrent job
    -- schedule (_sync_quote_job_reservations locks the same row FOR UPDATE, so
    -- the two serialize). Was: SELECT status ... WHERE id = p_quote_id;
    SELECT created_by, status, commission_split, row_version
      INTO v_quote_owner, v_old_status, v_old_commission_split, v_old_row_version
    FROM quotes WHERE id = p_quote_id FOR UPDATE;
    IF v_old_status IS NULL THEN
      RAISE EXCEPTION 'Quote not found: %', p_quote_id;
    END IF;
    IF NOT public.is_admin() AND v_quote_owner IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'NOT_QUOTE_OWNER';
    END IF;

    -- Lost-update guard (2026-07-22): when the client passes the split it
    -- originally loaded (commission_split_expected), reject a split overwrite
    -- if a different value landed in between (stale-tab last-write-wins).
    -- Callers that omit commission_split_expected behave exactly as before.
    IF p_quote_payload ? 'commission_split_expected'
       AND p_quote_payload->'commission_split' IS NOT NULL
       AND COALESCE(v_old_commission_split, 'null'::jsonb) IS DISTINCT FROM COALESCE(p_quote_payload->'commission_split_expected', 'null'::jsonb)
       AND COALESCE(v_old_commission_split, 'null'::jsonb) IS DISTINCT FROM p_quote_payload->'commission_split' THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_CONFLICT: this quote''s commission split was changed elsewhere after you opened it — reload the quote and re-apply your change';
    END IF;

    IF NOT (p_quote_payload ? 'row_version_expected')
       OR jsonb_typeof(p_quote_payload->'row_version_expected') <> 'number'
       OR (p_quote_payload->>'row_version_expected') !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after this page opened — reload to review the current quote before saving';
    END IF;
    v_expected_row_version := (p_quote_payload->>'row_version_expected')::bigint;
    IF v_expected_row_version IS DISTINCT FROM v_old_row_version THEN
      RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after this page opened — reload to review the current quote before saving';
    END IF;

    IF v_status IS DISTINCT FROM v_old_status THEN
      IF NOT (
        v_allowed_transitions->v_old_status IS NOT NULL
        AND v_allowed_transitions->v_old_status ? v_status
      ) THEN
        RAISE EXCEPTION 'Invalid status transition: % -> %', v_old_status, v_status;
      END IF;
    END IF;

    -- LAYER2<<< block unplanning a booking a scheduled job is still drawing from
    -- (Codex final push-gate P1 #1): if is_planned would become false while a live
    -- job_product_draws row exists for this quote, the UPDATE below + trailing
    -- _sync_planned_holds release the quote's crop_program holds, and the next job
    -- re-sync drops the draw (quote no longer planned-open) — reopening the full
    -- booking balance while the job still consumes the stock (double-count). Clear the
    -- job reservation via the job lifecycle (cancel/reschedule) before unplanning.
    IF COALESCE((p_quote_payload->>'is_planned')::boolean,
                (SELECT is_planned FROM quotes WHERE id = p_quote_id)) = false
       AND EXISTS (
         SELECT 1 FROM job_product_draws
         WHERE quote_id = p_quote_id AND quantity_drawn > 0
       ) THEN
      RAISE EXCEPTION 'BOOKING_HAS_JOB_RESERVATION: cannot unplan this booking — a scheduled job is still reserving product from it; cancel or reschedule the job first';
    END IF;
    -- >>>LAYER2

    v_quote_id := p_quote_id;
    v_price_locked := EXISTS (SELECT 1 FROM quote_versions WHERE quote_id = p_quote_id);

    -- SNAPSHOT<<< capture the existing lines' immutable quote-time costs BEFORE
    -- the delete+reinsert wipes them. One map, keyed strictly by quote_item id,
    -- each entry carrying the prior line's product_id so the reinsert can
    -- require id AND product to match (an echoed id cannot attach another
    -- line's snapshot to a different product). Deliberately NO product_id
    -- fallback: a genuinely new line for a product already on the quote must
    -- get today's cost from the trigger, not inherit an old snapshot.
    -- The map also drives ID REUSE (P1-A), so it deliberately includes rows
    -- whose cost_at_quote_cents is NULL: their id must stay stable too (their
    -- 'c' is JSON null, so the reinsert passes NULL and the trigger stamps).
    SELECT COALESCE(
             jsonb_object_agg(
               id::text,
               jsonb_build_object('p', product_id::text, 'c', cost_at_quote_cents, 'pp', price_per_unit)
             ),
             '{}'::jsonb)
      INTO v_prior_item_costs
    FROM quote_items
    WHERE quote_id = v_quote_id;

    -- RESERVATION PASS (Codex round 13). Every valid echoed id must be claimed
    -- BEFORE any id-less row is allowed to take a product fallback, because the
    -- payload order is not controlled by us. Changing a line from product A to
    -- product B on a quote that already contains B clears that line's id; if the
    -- changed row happens to be processed first, a single pass would let it
    -- claim the EXISTING B row's uuid and snapshot, and the real B row -- whose
    -- echoed id is now already consumed -- would fall through to a fresh stamp
    -- at today's catalog cost. With different quantities on the two lines that
    -- silently changes stored cost, profit, the converted order and commissions.
    -- Reserving first makes the outcome independent of payload order.
    FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections)
    LOOP
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
      LOOP
        v_payload_item_id := NULLIF(v_item->>'id', '');
        IF v_payload_item_id IS NOT NULL
           AND v_prior_item_costs ? v_payload_item_id
           AND v_prior_item_costs->v_payload_item_id->>'p' = v_item->>'product_id'
           AND NOT (v_consumed_prior_ids ? v_payload_item_id) THEN
          v_consumed_prior_ids := v_consumed_prior_ids || jsonb_build_object(v_payload_item_id, true);
        ELSIF (v_item->>'product_id') IS NOT NULL THEN
          -- Count the rows that will need a fallback, keyed by product. Two or
          -- more competing for the same product is unresolvable (below).
          v_idless_by_product := jsonb_set(
            v_idless_by_product,
            ARRAY[v_item->>'product_id'],
            to_jsonb(COALESCE((v_idless_by_product->>(v_item->>'product_id'))::int, 0) + 1),
            true);
        END IF;
      END LOOP;
    END LOOP;
    -- >>>SNAPSHOT

    DELETE FROM quote_sections WHERE quote_id = v_quote_id;
  ELSE
    IF v_status <> 'draft' THEN
      RAISE EXCEPTION 'New quotes must start with status draft';
    END IF;

    INSERT INTO quotes (
      id, quote_number, customer_id, created_by, tier, status,
      commission_split, total_price, total_cost, total_profit, total_margin_pct,
      valid_days, expires_at, header_notes, footer_notes, is_planned, created_at, updated_at
    ) VALUES (
      gen_random_uuid(),
      p_quote_payload->>'quote_number',
      (p_quote_payload->>'customer_id')::uuid,
      v_actor,
      v_tier,
      'draft',
      COALESCE(p_quote_payload->'commission_split', '{"splits":[]}'::jsonb),
      0, 0, 0, 0,
      COALESCE((p_quote_payload->>'valid_days')::int, 15),
      COALESCE((p_quote_payload->>'expires_at')::date, current_date + 15),
      p_quote_payload->>'header_notes',
      p_quote_payload->>'footer_notes',
      COALESCE((p_quote_payload->>'is_planned')::boolean, false),
      now(), now()
    )
    RETURNING id INTO v_quote_id;
  END IF;

  -- SNAPSHOT<<< arm the trigger passthrough for THIS transaction only, right
  -- before the item reinsert loop. _snapshot_quote_item_cost otherwise stamps
  -- cost_at_quote_cents unconditionally from products (anti-forgery); this
  -- txn-local GUC (is_local => true, dies at COMMIT/ROLLBACK) is the trusted
  -- signal that the non-NULL values inserted below are the preserved
  -- quote-time snapshots. Direct PostgREST inserts cannot set it.
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '1', true);
  -- >>>SNAPSHOT

  FOR v_section IN SELECT * FROM jsonb_array_elements(p_sections)
  LOOP
    INSERT INTO quote_sections (
      id, quote_id, section_name, sort_order, section_notes,
      section_header_notes, needed_by_date, field_id
    ) VALUES (
      gen_random_uuid(),
      v_quote_id,
      COALESCE(v_section->>'section_name', 'Section'),
      COALESCE((v_section->>'sort_order')::int, 0),
      v_section->>'section_notes',
      v_section->>'section_header_notes',
      NULLIF(v_section->>'needed_by_date', '')::date,
      NULLIF(v_section->>'field_id', '')::uuid
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      -- SNAPSHOT<<< resolve this payload row's identity BEFORE the INSERT.
      -- (a) consume-once (P1-B): any id repeated within one save is rejected
      --     here, so the caller sees a clear domain error instead of the
      --     primary-key violation that id reuse (below) would raise.
      -- (b) id reuse (P1-A): when the echoed id belongs to a prior line of
      --     THIS quote and that prior line's product matches, the reinserted
      --     row keeps the same uuid, so ids the still-open QuoteBuilder page
      --     holds remain valid across repeated saves without a refetch.
      v_payload_item_id := NULLIF(v_item->>'id', '');
      v_reuse_item_id := NULL;
      v_preserved_cost := NULL;
      IF v_payload_item_id IS NOT NULL THEN
        IF v_consumed_item_ids ? v_payload_item_id THEN
          RAISE EXCEPTION 'QUOTE_ITEM_ID_DUPLICATE: quote item ids must be unique within a save'
            USING ERRCODE = 'P0001';
        END IF;
        v_consumed_item_ids := v_consumed_item_ids || jsonb_build_object(v_payload_item_id, true);
        -- No not-consumed test here: the reservation pass above already claimed
        -- this id for this payload row, and the duplicate check immediately
        -- above guarantees no second row can present the same id.
        IF v_prior_item_costs ? v_payload_item_id
           AND v_prior_item_costs->v_payload_item_id->>'p' = v_item->>'product_id' THEN
          v_reuse_item_id := v_payload_item_id::uuid;
          -- A legacy NULL is not a monetary basis. Leave it NULL so the trusted
          -- INSERT trigger must establish a fresh, positive catalog basis (or
          -- reject the save) instead of manufacturing zero cost and profit.
          v_preserved_cost := (v_prior_item_costs->v_payload_item_id->>'c')::bigint;
        END IF;
      END IF;

      -- SNAPSHOT<<< product fallback when the id did not resolve.
      --
      -- A browser running the pre-snapshot bundle sends no ids at all, and even
      -- a current page clears the id of a line whose product changed. Earlier
      -- attempts to detect that (counting echoed ids, then a caller-declared
      -- capability flag) were both wrong: the count locked users out of a
      -- legitimate replace-every-line save, and the flag was caller-controlled,
      -- so a rep could set it, omit every id, and have unchanged lines
      -- re-stamped at today's catalog cost -- lowering the recorded basis and
      -- inflating profit and commission whenever a product got cheaper.
      --
      -- Match on the line's OWN quote and product instead, consuming each prior
      -- row at most once. This is not forgeable: the map is built only inside
      -- the owner-checked existing-quote branch and scoped to this quote, so the
      -- only cost a caller can inherit is one this very quote already recorded
      -- for that same product. Omitting an id can therefore no longer lower a
      -- cost basis -- at worst it preserves the honest historical value.
      IF v_reuse_item_id IS NULL AND (v_item->>'product_id') IS NOT NULL THEN
        -- AMBIGUITY CHECK. Both tests below apply ONLY when at least one
        -- unconsumed prior line of this product actually exists. With zero
        -- candidates there is no history to allocate and nothing to get wrong:
        -- every unresolved row is genuinely new and takes a fresh id and today's
        -- stamp. Gating on that matters -- an earlier revision refused whenever
        -- two id-less rows shared a product, which blocked the ordinary act of
        -- adding two new lines of a product the quote never carried, and no
        -- reload could clear it because new lines have no ids to supply.
        -- (Codex round 20.)
        SELECT COUNT(*), COUNT(DISTINCT COALESCE(val->>'c', '~'))
          INTO v_fallback_candidates, v_fallback_distinct_costs
        FROM jsonb_each(v_prior_item_costs) AS e(k, val)
        WHERE val->>'p' = v_item->>'product_id'
          AND NOT (v_consumed_prior_ids ? e.k);

        IF v_fallback_candidates > 0 THEN
          -- (a) Several unresolved payload rows competing for the same product's
          -- history: nothing says which is the pre-existing line and which was
          -- just swapped onto it, so iteration order would decide who keeps the
          -- recorded cost.
          v_idless_count := COALESCE((v_idless_by_product->>(v_item->>'product_id'))::int, 0);
          IF v_idless_count > 1 THEN
            RAISE EXCEPTION 'QUOTE_ITEM_AMBIGUOUS_COST: this save sent more than one line of the same product without identifying which existing line each one is. Reload the quote and re-apply your changes so every line keeps its own recorded cost.'
              USING ERRCODE = 'P0001';
          END IF;

          -- (b) Several prior lines of this product recorded at DIFFERENT costs.
          -- Same costs are interchangeable -- any pick is identical, so refusing
          -- there would be a lock-out for no gain.
          IF v_fallback_distinct_costs > 1 THEN
            RAISE EXCEPTION 'QUOTE_ITEM_AMBIGUOUS_COST: this quote has more than one line of the same product recorded at different costs, and this save did not identify which line is which. Reload the quote and re-apply your changes so each line keeps its own recorded cost.'
              USING ERRCODE = 'P0001';
          END IF;
        END IF;

        SELECT k INTO v_fallback_prior_id
        FROM jsonb_each(v_prior_item_costs) AS e(k, val)
        WHERE val->>'p' = v_item->>'product_id'
          AND NOT (v_consumed_prior_ids ? e.k)
        ORDER BY e.k
        LIMIT 1;

        IF v_fallback_prior_id IS NOT NULL THEN
          v_reuse_item_id := v_fallback_prior_id::uuid;
          v_preserved_cost := (v_prior_item_costs->v_fallback_prior_id->>'c')::bigint;
          v_consumed_prior_ids := v_consumed_prior_ids || jsonb_build_object(v_fallback_prior_id, true);
          v_fallback_prior_id := NULL;
        END IF;
      END IF;
      -- SNAPSHOT<<< settle this row's id once, so the same value can be both
      -- written and reported back to the caller under its client key.
      v_new_item_id := COALESCE(v_reuse_item_id, gen_random_uuid());
      -- PRICE LOCK: a line the caller names by its saved id (same product) keeps its stored
      -- price unless the caller asks for today's price on it. A line matched only by the
      -- one-per-product fallback keeps its cost but takes today's price, so the screen (which
      -- names every saved line) and the server agree; the sent-price check then asks for a
      -- re-send if that price differs from the one sent.
      IF v_price_locked AND v_reuse_item_id IS NOT NULL
         AND v_reuse_item_id::text = v_payload_item_id
         AND COALESCE((v_item->>'use_todays_price')::boolean, false) = false THEN
        v_carry_prices := v_carry_prices
          || jsonb_build_object(v_new_item_id::text, v_prior_item_costs->(v_reuse_item_id::text)->'pp');
      END IF;
      v_client_key := NULLIF(v_item->>'client_key', '');
      IF v_client_key IS NOT NULL THEN
        v_item_ids := v_item_ids || jsonb_build_object(v_client_key, v_new_item_id::text);
      END IF;
      -- >>>SNAPSHOT
      INSERT INTO quote_items (
        id, quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, price_override, current_cost, suggested_rate, actual_rate,
        rate_unit, oz_per_acre, price_per_acre, acres,
        total_units_needed, unit_size, profit, total_price, net_margin,
        calc_mode, price_unit,
        cost_at_quote_cents -- SNAPSHOT: preserved value or NULL (trigger snapshots)
      ) VALUES (
        -- SNAPSHOT: reuse the echoed id when it matched a prior line of this
        -- quote (same product); otherwise mint a fresh one as before.
        v_new_item_id,
        v_quote_id,
        v_section_id,
        (v_item->>'product_id')::uuid,
        COALESCE((v_item->>'sort_order')::int, 0),
        v_item->>'notes',
        COALESCE((v_item->>'price_per_unit')::numeric, 0),
        (v_item->>'price_override')::numeric,
        COALESCE((v_item->>'current_cost')::numeric, 0),
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        -- Preserve 20260810150500 DELTA-B2: normalize transient client money
        -- before the already-live whole-cent constraints inspect the row.
        ROUND(COALESCE((v_item->>'profit')::numeric, 0), 2),
        ROUND(COALESCE((v_item->>'total_price')::numeric, 0), 2),
        COALESCE((v_item->>'net_margin')::numeric, 0),
        COALESCE(v_item->>'calc_mode', 'rate_acres'),
        v_item->>'price_unit',
        -- SNAPSHOT<<< carry the quote-time cost across the reinsert ONLY when
        -- the payload echoes a prior item id AND that prior line's product_id
        -- equals this row's product_id (id-echo forgery cannot move a snapshot
        -- onto a different product), and only once per prior id. Resolved into
        -- v_preserved_cost above; NULL here means the BEFORE INSERT trigger
        -- stamps today's products.current_cost — correct for genuinely new or
        -- changed-product lines (and for a prior line that never snapshotted).
        v_preserved_cost
        -- >>>SNAPSHOT
      );
    END LOOP;
  END LOOP;


  -- Disarm the passthrough the moment the reinsert loop closes (defense in
  -- depth: txn-local anyway, but nothing after this point may pass a supplied
  -- snapshot through the anti-forgery trigger).
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '0', true);

  WITH base AS (
    SELECT
      qi.id AS item_id,
      COALESCE(qi.calc_mode, 'rate_acres') AS calc_mode,
      COALESCE(qi.actual_rate, 0) AS ar,
      COALESCE(qi.acres, 0) AS ac,
      COALESCE(qi.total_units_needed, 0) AS client_units,
      COALESCE(qi.price_override, (v_carry_prices->>(qi.id::text))::numeric, CASE v_tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
        ELSE COALESCE(p.tier3_price, p.tier1_price, 0)
      END) AS ppu,
      -- SNAPSHOT<<< was: COALESCE(p.current_cost, 0). Price cost from the
      -- immutable quote-time snapshot; live catalog cost only for a row the
      -- trigger could not snapshot (product missing a cost).
      (qi.cost_at_quote_cents / 100.0) AS cc,
      -- >>>SNAPSHOT
      COALESCE(rate_conv.factor_oz, 1) AS rate_oz,
      COALESCE(inv_conv.factor_oz, 1) AS inv_oz
    FROM quote_items qi
    JOIN products p ON p.id = qi.product_id
    LEFT JOIN unit_conversions rate_conv
      ON LOWER(rate_conv.unit) = LOWER(qi.rate_unit)
    LEFT JOIN unit_conversions inv_conv
      ON LOWER(inv_conv.unit) = LOWER(COALESCE(p.inventory_unit, p.unit_size, 'Ea'))
    WHERE qi.quote_id = v_quote_id
  ),
  calc AS (
    SELECT
      item_id,
      ppu,
      cc,
      calc_mode,
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0 AND inv_oz > 0
          THEN ROUND((client_units * inv_oz) / ac, 2)
        WHEN calc_mode = 'rate_acres'
          THEN ROUND(ar * rate_oz, 2)
        ELSE 0
      END AS oz_per_acre,
      CASE
        WHEN calc_mode = 'units_direct' THEN ROUND(client_units, 2)
        WHEN inv_oz > 0 THEN ROUND((ac * ar * rate_oz) / inv_oz, 2)
        ELSE 0
      END AS total_units,
      CASE
        WHEN calc_mode = 'units_direct' AND ac > 0
          THEN ROUND(ppu * client_units / ac, 2)
        WHEN calc_mode = 'rate_acres' AND inv_oz > 0
          THEN ROUND(ppu * (ar * rate_oz / inv_oz), 2)
        ELSE 0
      END AS price_per_acre
    FROM base
  ),
  final AS (
    SELECT
      item_id,
      ppu,
      cc,
      oz_per_acre,
      total_units,
      price_per_acre,
      ROUND(ppu * total_units, 2) AS total_price,
      -- SNAPSHOT<<< profit is settled revenue MINUS settled extended cost, not
      -- a rounding of the margin per unit. The reports compute it the first
      -- way; rounding (price - cost) * qty as one expression disagrees with
      -- them by a cent on fractional quantities whose extensions land on a
      -- half-cent, and that cent then rides into the converted order and the
      -- commission. One boundary, applied to each side. (Codex round 33.)
      ROUND(ppu * total_units, 2) - ROUND(cc * total_units, 2) AS profit,
      CASE
        WHEN ROUND(ppu * total_units, 2) > 0
          THEN ROUND((ROUND(ppu * total_units, 2) - ROUND(cc * total_units, 2))
                     / ROUND(ppu * total_units, 2) * 100, 2)
        ELSE 0
      END AS net_margin
      -- >>>SNAPSHOT
    FROM calc
  )
  UPDATE quote_items qi SET
    price_per_unit = f.ppu,
    current_cost = f.cc,
    oz_per_acre = f.oz_per_acre,
    total_units_needed = f.total_units,
    price_per_acre = f.price_per_acre,
    total_price = f.total_price,
    profit = f.profit,
    net_margin = f.net_margin
  FROM final f
  WHERE qi.id = f.item_id;

  -- LAYER2<<< drawn-product guard counts ORDER + JOB draws (§6.5 / Codex round-2 P1):
  -- a line can't be reduced below what an order OR a scheduled job already drew from it.
  SELECT
    COALESCE(p.product_name, d.product_id::text) AS product_name,
    d.quantity_drawn,
    COALESCE(b.booked, 0) AS new_booked
  INTO v_drawn_guard
  FROM (
    SELECT product_id, SUM(qty) AS quantity_drawn
    FROM (
      SELECT product_id, quantity_drawn AS qty FROM quote_product_draws WHERE quote_id = v_quote_id AND quantity_drawn > 0
      UNION ALL
      SELECT product_id, quantity_drawn AS qty FROM job_product_draws WHERE quote_id = v_quote_id AND quantity_drawn > 0
    ) x
    GROUP BY product_id
  ) d
  LEFT JOIN (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items
    WHERE quote_id = v_quote_id
    GROUP BY product_id
  ) b ON b.product_id = d.product_id
  LEFT JOIN products p ON p.id = d.product_id
  WHERE d.quantity_drawn > 0
    AND COALESCE(b.booked, 0) < d.quantity_drawn
  ORDER BY d.quantity_drawn - COALESCE(b.booked, 0) DESC, d.product_id
  LIMIT 1;
  -- >>>LAYER2
  IF FOUND THEN
    IF v_drawn_guard.new_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot remove % — % already drawn',
        v_drawn_guard.product_name, v_drawn_guard.quantity_drawn;
    END IF;
    RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot reduce % below its already-drawn % (new total would be %)',
      v_drawn_guard.product_name, v_drawn_guard.quantity_drawn, v_drawn_guard.new_booked;
  END IF;

  SELECT
    COALESCE(SUM(total_price), 0) AS total_price,
    -- Settle each line's extended cost to cents BEFORE summing, matching the
    -- per-line profit boundary above. Summing raw current_cost * quantity let
    -- sub-cent extended costs into quotes.total_cost, so the header identity
    -- (revenue - cost = profit) broke on fractional quantities and the fraction
    -- rode into versions and conversion. (Codex round 41.)
    COALESCE(SUM(ROUND(current_cost * total_units_needed, 2)), 0) AS total_cost,
    COALESCE(SUM(profit), 0) AS total_profit
  INTO v_server_totals
  FROM quote_items
  WHERE quote_id = v_quote_id;

  -- One logical save must produce exactly one quote UPDATE. The row was
  -- already locked and its expected version checked before any children were
  -- replaced; combining header/status fields with the calculated totals keeps
  -- that lock order while ensuring the row-version trigger advances once.
  UPDATE quotes SET
    customer_id = (p_quote_payload->>'customer_id')::uuid,
    tier = v_tier,
    status = v_status,
    commission_split = CASE
      WHEN p_quote_payload->'commission_split' IS NOT NULL
      THEN p_quote_payload->'commission_split'
      ELSE commission_split
    END,
    valid_days = COALESCE((p_quote_payload->>'valid_days')::int, valid_days),
    -- PRICE LOCK: editing a sent quote keeps its expiry; only a send sets a new one.
    expires_at = CASE WHEN v_price_locked THEN expires_at
      ELSE COALESCE((p_quote_payload->>'expires_at')::date, expires_at) END,
    header_notes = p_quote_payload->>'header_notes',
    footer_notes = p_quote_payload->>'footer_notes',
    is_planned = COALESCE((p_quote_payload->>'is_planned')::boolean, is_planned),
    sent_at = CASE
      WHEN v_status = 'sent' AND sent_at IS NULL THEN now()
      WHEN v_status = 'sent' THEN sent_at
      ELSE sent_at
    END,
    total_price = v_server_totals.total_price,
    total_cost = v_server_totals.total_cost,
    total_profit = v_server_totals.total_profit,
    total_margin_pct = CASE
      WHEN v_server_totals.total_price > 0
      THEN ROUND(v_server_totals.total_profit / v_server_totals.total_price * 100, 2)
      ELSE 0
    END,
    updated_at = now()
  WHERE id = v_quote_id;

  -- PRICE LOCK: a quote becomes accepted only at the prices, lines and customer last sent.
  -- Only the transition is checked, so a quote accepted earlier (whose last version may predate
  -- line ids) can still be saved.
  IF v_status = 'accepted' AND v_old_status IS DISTINCT FROM 'accepted' THEN
    PERFORM public._assert_quote_prices_as_sent(v_quote_id);
  END IF;

  INSERT INTO activity_feed (id, event_type, description, performed_by, related_entity_type, related_entity_id, created_at)
  VALUES (
    gen_random_uuid(),
    CASE WHEN p_quote_id IS NOT NULL THEN 'quote_updated' ELSE 'quote_created' END,
    'Quote ' || COALESCE(p_quote_payload->>'quote_number', '') || ' saved',
    v_actor,
    'quote',
    v_quote_id,
    now()
  );

  -- LAYER2-COORD (#4): re-sync this quote's ACTIVE jobs to the edited booking,
  -- then resync crop_program holds. _sync_quote_job_reservations rebuilds every
  -- active job's draws+holds (so a grown line re-draws its job, a shrunk line
  -- reallocates siblings) and ends by calling _sync_planned_holds itself, so it
  -- is a strict superset of the prior trailing `_sync_planned_holds(v_quote_id)`
  -- (identical for a quote with no jobs). Was: PERFORM _sync_planned_holds(...).
  PERFORM _sync_quote_job_reservations(v_quote_id, v_actor);

  v_result := jsonb_build_object(
    'status', 'saved',
    'quote_id', v_quote_id,
    '_request_fingerprint', v_request_fingerprint,
    'commission_split', (SELECT commission_split FROM quotes WHERE id = v_quote_id),
    'row_version', (SELECT row_version FROM quotes WHERE id = v_quote_id),
    -- SNAPSHOT<<< client_key -> quote_items.id for every line written by this
    -- save, so the caller can install real ids without a refetch. Included in
    -- the idempotency-stored result, so a replayed save returns the same map
    -- rather than leaving a retrying client id-less. (Codex round 28.)
    'item_ids', v_item_ids,
    -- >>>SNAPSHOT
    -- PRICE LOCK (20261027040000): client_key -> the price_per_unit this save stored, so the
    -- quote screen keeps each saved line at the price the database holds. Prices only; no cost.
    'item_prices', (
      SELECT COALESCE(jsonb_object_agg(e.key, qi.price_per_unit), '{}'::jsonb)
      FROM jsonb_each_text(v_item_ids) AS e(key, value)
      JOIN quote_items qi ON qi.id = e.value::uuid
    ),
    'server_totals', jsonb_build_object(
      'total_price', (SELECT total_price FROM quotes WHERE id = v_quote_id),
      'total_cost', (SELECT total_cost FROM quotes WHERE id = v_quote_id),
      'total_profit', (SELECT total_profit FROM quotes WHERE id = v_quote_id),
      'total_margin_pct', (SELECT total_margin_pct FROM quotes WHERE id = v_quote_id)
    )
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_quote', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

-- 3. Sending: versions record each line's id, manual price and section field, and set the expiry.

CREATE OR REPLACE FUNCTION public._create_quote_version_owner_impl(p_quote_id uuid, p_performed_by uuid, p_method text DEFAULT 'presented'::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_quote quotes%ROWTYPE;
  v_version_number integer;
  v_snapshot jsonb;
  v_version_id uuid;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'create_quote_version';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
  END IF;

  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_version_number
  FROM quote_versions WHERE quote_id = p_quote_id;

  -- PRICE LOCK (20261027040000): every send starts a new validity window (Chicago business
  -- day); editing a sent quote no longer moves it (save_quote keeps it).
  v_quote.expires_at := (now() AT TIME ZONE 'America/Chicago')::date + COALESCE(v_quote.valid_days, 15);

  SELECT jsonb_build_object(
    'quote', jsonb_build_object(
      'quote_number', v_quote.quote_number,
      'customer_id', v_quote.customer_id,
      'tier', v_quote.tier,
      'status', v_quote.status,
      'total_price', v_quote.total_price,
      'total_cost', v_quote.total_cost,
      'total_profit', v_quote.total_profit,
      'total_margin_pct', v_quote.total_margin_pct,
      'valid_days', v_quote.valid_days,
      'expires_at', v_quote.expires_at,
      'header_notes', v_quote.header_notes,
      'footer_notes', v_quote.footer_notes,
      'is_planned', v_quote.is_planned,
      'commission_split', v_quote.commission_split
    ),
    'sections', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'section_name', qs.section_name,
          'sort_order', qs.sort_order,
          'section_notes', qs.section_notes,
          'section_header_notes', qs.section_header_notes,
          'needed_by_date', qs.needed_by_date,
          'field_id', qs.field_id,
          'items', (
            SELECT COALESCE(jsonb_agg(
              jsonb_build_object(
                -- PRICE LOCK: the sent version is the price authority, matched line by line.
                'quote_item_id', qi.id,
                'price_override', qi.price_override,
                'product_id', qi.product_id,
                'product_name', p.product_name,
                'sku', p.sku,
                'sort_order', qi.sort_order,
                'notes', qi.notes,
                'price_per_unit', qi.price_per_unit,
                'current_cost', qi.current_cost,
                'suggested_rate', qi.suggested_rate,
                'actual_rate', qi.actual_rate,
                'rate_unit', qi.rate_unit,
                'oz_per_acre', qi.oz_per_acre,
                'price_per_acre', qi.price_per_acre,
                'acres', qi.acres,
                'total_units_needed', qi.total_units_needed,
                'unit_size', qi.unit_size,
                'profit', qi.profit,
                'total_price', qi.total_price,
                'net_margin', qi.net_margin,
                'calc_mode', qi.calc_mode,
                'price_unit', qi.price_unit
              ) ORDER BY qi.sort_order
            ), '[]'::jsonb)
            FROM quote_items qi
            JOIN products p ON p.id = qi.product_id
            WHERE qi.section_id = qs.id
          )
        ) ORDER BY qs.sort_order
      ), '[]'::jsonb)
      FROM quote_sections qs
      WHERE qs.quote_id = p_quote_id
    )
  ) INTO v_snapshot;

  INSERT INTO quote_versions (quote_id, version_number, sent_by, sent_at, sent_method, snapshot_data)
  VALUES (p_quote_id, v_version_number, v_actor, now(), p_method, v_snapshot)
  RETURNING id INTO v_version_id;

  UPDATE quotes SET status = 'sent', sent_at = now(), expires_at = v_quote.expires_at, updated_at = now()
  WHERE id = p_quote_id;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_quote_version', to_jsonb(v_version_id))
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'status', 'created',
    'version_id', v_version_id,
    'version_number', v_version_number
  );
END;
$function$;

-- 4. Rewind: a version restores its lines under their own ids, manual prices and fields.

CREATE OR REPLACE FUNCTION public._restore_quote_version_owner_impl(p_quote_id uuid, p_version_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_snapshot jsonb;
  v_section jsonb;
  v_item jsonb;
  v_section_id uuid;
  v_version_number integer;
  v_actor uuid;
  v_drawn_guard record; -- drawn-version guard (20260611120100)
BEGIN
  -- Strict-actor auth (function previously had NO auth check). Before idempotency.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
      AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- Idempotency check — operation-scoped so a key minted for a different operation
  -- can't short-circuit a legitimate restore (was: matched idempotency_key alone).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM 1 FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key
        AND operation = 'restore_quote_version';
    IF FOUND THEN
      RETURN jsonb_build_object('status', 'duplicate', 'message', 'Already processed');
    END IF;
  END IF;

  -- Get snapshot data
  SELECT snapshot_data, version_number INTO v_snapshot, v_version_number
  FROM quote_versions
  WHERE id = p_version_id AND quote_id = p_quote_id;

  IF v_snapshot IS NULL THEN
    RAISE EXCEPTION 'Version not found: %', p_version_id;
  END IF;

  -- Preserve the newer live restore safeguard from
  -- 20260812011000_restore_quote_version_whole_cent_money. This pricing
  -- migration re-emits the same owner implementation to add quote-time cost
  -- snapshots, so it must reject non-finite constrained money before the first
  -- destructive restore write rather than silently replacing that live guard.
  IF (v_snapshot->'quote'->>'total_price')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quotes.total_price in version % is non-finite', p_version_id;
  END IF;
  IF (v_snapshot->'quote'->>'total_profit')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quotes.total_profit in version % is non-finite', p_version_id;
  END IF;
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_snapshot->'sections')
  LOOP
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      IF (v_item->>'profit')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quote_items.profit in version % is non-finite', p_version_id;
      END IF;
      IF (v_item->>'total_price')::numeric::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'QUOTE_SNAPSHOT_MONEY_NOT_FINITE: field quote_items.total_price in version % is non-finite', p_version_id;
      END IF;
    END LOOP;
  END LOOP;

  -- PROVENANCE: refuse the restore outright if this booking has been drawn.
  --
  -- order_items.quote_item_id records which booked quote line each drawn order
  -- line was billed from. This migration makes that FK NO ACTION DEFERRABLE
  -- INITIALLY DEFERRED so an ordinary save_quote edit -- which deletes and
  -- reinserts the SAME ids -- keeps the stamp. A version RESTORE is different:
  -- it rebuilds the quote from a snapshot and mints a brand-new id for every
  -- line (the INSERT below names no id column), so the old ids never come back
  -- and every stamp would dangle at COMMIT.
  --
  -- An earlier draft RELEASED the stamps here (UPDATE ... SET quote_item_id =
  -- NULL) instead of refusing. Codex review 2026-08-19 found that silently
  -- overbills, and it was REPRODUCED on PostgreSQL 17.6: two 0.5-unit lines at
  -- $1.01, draw 0.5, restore to a single 1-unit version, draw the rest -- the
  -- customer is billed $1.02 against a booking whose own arithmetic says
  -- $1.01. Releasing the stamp discards the telescoping rounding basis, and
  -- DRAW_MIXED_TIER_UNMATCHED_LINE cannot catch it because that guard only
  -- fires when the product carries MORE THAN ONE distinct (price, cost) -- and
  -- after the restore it carries exactly one. The release also fired
  -- after_order_items_change -> trg_recalc_order_totals, which locks the order
  -- row while this function already holds the quote row, crossing the lock
  -- order that cancel/void takes.
  --
  -- So restore fails CLOSED instead.
  --
  -- SCOPE, STATED ACCURATELY -- an earlier draft of this comment called the
  -- guard "narrow: only a booking actually drawn into an order is blocked".
  -- That was wrong, and Codex review 2026-08-19 caught it. The join below is
  -- UNFILTERED by order status, so the real rule is: once a booking has EVER
  -- been drawn, it can never restore a version again -- even if every draw
  -- order was afterwards cancelled or voided, the quantity returned to
  -- quote_product_draws and the booking reopened. Those reversed order_items
  -- rows are retained for audit and still carry their stamp, so the join stays
  -- true forever.
  --
  -- That over-breadth is DELIBERATE and Mason accepted it on 2026-08-20 rather
  -- than narrow it. Narrowing means letting a reversed line past the guard,
  -- and its stamp would then dangle at COMMIT exactly as before -- so restore
  -- would have to RELEASE the stamps on those dead lines. Releasing is
  -- money-neutral for them (a voided line is filtered out of billed_stamped and
  -- v_unmatched entirely, and a cancelled line contributes only its delivered
  -- quantity, which is zero here), but it puts back an UPDATE on order_items,
  -- which fires after_order_items_change -> trg_recalc_order_totals and locks
  -- the order row under the quote lock. That is the deadlock this rework just
  -- removed. Trading a rare capability for a reintroduced lock cycle is the
  -- wrong trade, so the limitation is recorded instead of fixed.
  --
  -- Recorded in docs/manual/KNOWN_ISSUES.md and pinned by a regression case in
  -- scripts/smoke/smoke-restore-version-drawn-guard.sql, so a later narrowing
  -- has to change the recorded decision consciously rather than by accident.
  --
  -- What is unaffected: a booking never drawn restores freely, and editing the
  -- quote directly still works on ANY booking, because save_quote reuses the
  -- same line ids and the deferred FK keeps the stamps.
  --
  -- Doing this properly -- carrying the line-level billing basis across a
  -- restore so the money stays exact -- means giving restore a real identity
  -- mapping from snapshot lines to live lines. That is the same missing
  -- capability QUOTE_ITEM_AMBIGUOUS_COST is about, and it gets its own PR.
  IF EXISTS (
    SELECT 1
    FROM order_items oi
    JOIN quote_items qi ON qi.id = oi.quote_item_id
    WHERE qi.quote_id = p_quote_id
  ) THEN
    RAISE EXCEPTION 'QUOTE_RESTORE_BLOCKED_BY_DRAW: this booking has already been drawn down into an order, so restoring an earlier version would change what the customer has already been billed. Edit the quote directly instead -- ordinary edits are still allowed and keep the billing history intact.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Delete existing sections (cascades to items via ON DELETE CASCADE)
  DELETE FROM quote_sections WHERE quote_id = p_quote_id;

  -- Restore quote-level fields. Bracket the status write with the admin override so
  -- the enforcer permits restore->revised from any source state (accepted/declined/etc.).
  PERFORM set_config('app.admin_override', 'true', true);
  UPDATE quotes SET
    header_notes = v_snapshot->'quote'->>'header_notes',
    footer_notes = v_snapshot->'quote'->>'footer_notes',
    -- Historical snapshots may predate the live whole-cent constraints from
    -- 20260810151000. Normalize the replay boundary so restoring one cannot
    -- fail or reintroduce fractional stored money.
    total_price = ROUND((v_snapshot->'quote'->>'total_price')::numeric, 2),
    total_cost = ROUND((v_snapshot->'quote'->>'total_cost')::numeric, 2),
    total_profit = ROUND((v_snapshot->'quote'->>'total_profit')::numeric, 2),
    total_margin_pct = (v_snapshot->'quote'->>'total_margin_pct')::numeric,
    -- PRICE LOCK (20261027040000): a rewind also puts back the version's customer (when that
    -- customer still exists) and tier, so a rewound quote matches the version as sent.
    customer_id = COALESCE(
      (SELECT c.id FROM customers c WHERE c.id = NULLIF(v_snapshot->'quote'->>'customer_id', '')::uuid),
      customer_id),
    tier = COALESCE(NULLIF(v_snapshot->'quote'->>'tier', '')::integer, tier),
    status = 'revised',
    updated_at = now()
  WHERE id = p_quote_id;
  PERFORM set_config('app.admin_override', 'false', true);

  -- SNAPSHOT<<< arm the trusted passthrough for this transaction so the rows
  -- reinserted below carry the version's own quote-time cost. Same mechanism
  -- save_quote uses: transaction-local, so a PostgREST caller cannot set it.
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '1', true);
  -- >>>SNAPSHOT

  -- Restore sections and items from snapshot
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_snapshot->'sections')
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes, needed_by_date, field_id)
    VALUES (
      p_quote_id,
      v_section->>'section_name',
      (v_section->>'sort_order')::integer,
      v_section->>'section_notes',
      v_section->>'section_header_notes',
      (v_section->>'needed_by_date')::date,
      -- PRICE LOCK (20261027040000): a rewind keeps the section's field when the version
      -- recorded it and the field still exists for the quote's (restored) customer.
      (SELECT f.id FROM fields f
        WHERE f.id = NULLIF(v_section->>'field_id', '')::uuid
          AND f.customer_id = (SELECT q.customer_id FROM quotes q WHERE q.id = p_quote_id))
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      IF NULLIF(v_item->>'current_cost', '') IS NULL
         OR (v_item->>'current_cost')::numeric <= 0 THEN
        RAISE EXCEPTION 'COST_BASIS_REQUIRED:%', v_item->>'product_id';
      END IF;
      -- PRICE LOCK (20261027040000): a version that recorded its line ids restores each line
      -- under its own id with its own manual price, so the rewound quote still matches the
      -- version as sent. An id already in use (impossible after the delete above) gets a new one.
      INSERT INTO quote_items (
        id, price_override,
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
        oz_per_acre, price_per_acre, acres, total_units_needed, unit_size,
        profit, total_price, net_margin, calc_mode, price_unit,
        cost_at_quote_cents -- SNAPSHOT
      )
      VALUES (
        CASE WHEN NULLIF(v_item->>'quote_item_id', '') IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM quote_items WHERE id = (v_item->>'quote_item_id')::uuid)
          THEN (v_item->>'quote_item_id')::uuid
          ELSE gen_random_uuid() END,
        (v_item->>'price_override')::numeric,
        p_quote_id, v_section_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'sort_order')::integer,
        v_item->>'notes',
        (v_item->>'price_per_unit')::numeric,
        (v_item->>'current_cost')::numeric,
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        ROUND((v_item->>'profit')::numeric, 2),
        ROUND((v_item->>'total_price')::numeric, 2),
        (v_item->>'net_margin')::numeric,
        v_item->>'calc_mode',
        v_item->>'price_unit',
        -- SNAPSHOT: the version stored the cost this quote was priced with.
        -- Without it the BEFORE INSERT trigger stamps todays catalog cost, and
        -- the next ordinary save preserves that stamp and recomputes the line
        -- from it, silently repricing the restored version.
        --
        -- A version without a positive historical basis is rejected above.
        -- Unknown money must not become a real zero-cost quote line.
        ROUND((v_item->>'current_cost')::numeric * 100)::bigint
      );
    END LOOP;
  END LOOP;

  -- SNAPSHOT<<< disarm immediately once the reinsert loop closes.
  PERFORM set_config('crx.quote_cost_snapshot_passthrough', '0', true);
  -- >>>SNAPSHOT

  -- BEGIN drawn-version guard (20260611120100)
  -- Codex round-2 MED (2026-06-11): a restore must never under-book the drawn
  -- ledger (quote_product_draws deliberately survives the section delete +
  -- re-insert above). Validates the FINAL persisted quote_items — the same
  -- invariant, token, and block shape as save_quote's drawn-product guard
  -- (20260610184230). A violation rolls back the entire restore atomically,
  -- including the section DELETE.
  -- LAYER2<<< drawn guard counts ORDER + JOB draws (§6.5 / Codex round-2 P1).
  SELECT
    COALESCE(p.product_name, d.product_id::text) AS product_name,
    d.quantity_drawn,
    COALESCE(b.booked, 0) AS new_booked
  INTO v_drawn_guard
  FROM (
    SELECT product_id, SUM(qty) AS quantity_drawn
    FROM (
      SELECT product_id, quantity_drawn AS qty FROM quote_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0
      UNION ALL
      SELECT product_id, quantity_drawn AS qty FROM job_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0
    ) x
    GROUP BY product_id
  ) d
  LEFT JOIN (
    SELECT product_id, SUM(COALESCE(total_units_needed, 0)) AS booked
    FROM quote_items
    WHERE quote_id = p_quote_id
    GROUP BY product_id
  ) b ON b.product_id = d.product_id
  LEFT JOIN products p ON p.id = d.product_id
  WHERE d.quantity_drawn > 0
    AND COALESCE(b.booked, 0) < d.quantity_drawn
  ORDER BY d.quantity_drawn - COALESCE(b.booked, 0) DESC, d.product_id
  LIMIT 1;
  -- >>>LAYER2
  IF FOUND THEN
    IF v_drawn_guard.new_booked <= 0 THEN
      RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot restore this version — it removes %, which already has % drawn',
        v_drawn_guard.product_name, v_drawn_guard.quantity_drawn;
    END IF;
    RAISE EXCEPTION 'BOOKING_OVERDRAWN: cannot restore this version — % would fall below its already-drawn % (restored total would be %)',
      v_drawn_guard.product_name, v_drawn_guard.quantity_drawn, v_drawn_guard.new_booked;
  END IF;
  -- END drawn-version guard (20260611120100)

  -- BEGIN planned-hold + job-reservation sync (20260611132115 + Layer2 A3.12)
  -- Codex round-2 #3: restores rewrite quote_items wholesale — rebuild the
  -- planned reservation (booked − drawn) to match the restored state.
  -- LAYER2-CHAN (push-gate #C): a restore that changes booked quantity must ALSO
  -- re-sync the quote's ACTIVE jobs (draws + shed holds), exactly as save_quote now
  -- does — else a restored-larger booking leaves stale job draws and reopens balance
  -- the job still needs. _sync_quote_job_reservations rebuilds the jobs THEN calls
  -- _sync_planned_holds itself (strict superset). Was: PERFORM _sync_planned_holds(...).
  PERFORM _sync_quote_job_reservations(p_quote_id, v_actor);
  -- END planned-hold + job-reservation sync

  -- Save idempotency key (result stored as a valid jsonb object — was a bare ::text UUID).
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'restore_quote_version', jsonb_build_object('quote_id', p_quote_id))
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object(
    'status', 'restored',
    'restored_from_version', v_version_number,
    'quote_id', p_quote_id
  );
END;
$function$;

-- 5. The routes from a sent quote to something billable check the sent prices.

CREATE OR REPLACE FUNCTION public._convert_quote_to_order_below_cost_impl_20260810(p_quote_id uuid, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_expected_row_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_quote_owner uuid;
  v_current_row_version bigint;
  v_post_row_version bigint;
  v_existing jsonb;
  v_result jsonb;
  v_existing_order_id uuid;
  v_cache_rows integer;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM public.profiles
  WHERE id = v_actor
    AND is_active = true
    AND role IN ('admin', 'sales_rep');
  IF v_actor_role IS NULL THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  SELECT created_by INTO v_quote_owner
  FROM public.quotes
  WHERE id = p_quote_id
    AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;
  IF v_actor_role <> 'admin' AND v_quote_owner IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'NOT_QUOTE_OWNER';
  END IF;

  IF p_expected_row_version IS NULL OR p_expected_row_version < 1 THEN
    RAISE EXCEPTION 'QUOTE_STALE_WRITE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'convert_quote_to_order');
  END IF;

  SELECT created_by, row_version
  INTO v_quote_owner, v_current_row_version
  FROM public.quotes
  WHERE id = p_quote_id
    AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;
  IF v_actor_role <> 'admin' AND v_quote_owner IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'NOT_QUOTE_OWNER';
  END IF;

  IF v_existing IS NOT NULL THEN
    IF jsonb_typeof(v_existing) IS DISTINCT FROM 'object'
       OR v_existing->>'_quote_id' IS DISTINCT FROM p_quote_id::text
       OR COALESCE(v_existing->>'_expected_row_version', '') !~ '^[1-9][0-9]*$'
       OR (v_existing->>'_expected_row_version')::bigint IS DISTINCT FROM p_expected_row_version
       OR COALESCE(v_existing->>'_post_row_version', '') !~ '^[1-9][0-9]*$'
       OR (v_existing->>'_post_row_version')::bigint IS DISTINCT FROM v_current_row_version THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
    END IF;

    v_existing_order_id := NULLIF(v_existing->>'order_id', '')::uuid;
    IF v_existing_order_id IS NULL OR NOT EXISTS (
      SELECT 1
      FROM public.orders
      WHERE id = v_existing_order_id
        AND quote_id = p_quote_id
    ) THEN
      RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
    END IF;
    RETURN v_existing
      - '_quote_id'
      - '_expected_row_version'
      - '_post_row_version';
  END IF;

  IF v_current_row_version IS DISTINCT FROM p_expected_row_version THEN
    RAISE EXCEPTION 'QUOTE_STALE_WRITE';
  END IF;

  -- PRICE LOCK (20261027040000): a conversion that creates an order does so only at the prices,
  -- lines and customer last sent. The check is skipped only where the owner implementation
  -- returns an existing order or refuses (an accepted quote that has an order, or a booking with
  -- draws), so a quote reopened after its order was cancelled or voided is checked again.
  IF NOT (
    EXISTS (SELECT 1 FROM public.quote_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0)
    OR EXISTS (SELECT 1 FROM public.job_product_draws WHERE quote_id = p_quote_id AND quantity_drawn > 0)
    OR ((SELECT q.status FROM public.quotes q WHERE q.id = p_quote_id) = 'accepted'
        AND EXISTS (SELECT 1 FROM public.orders WHERE quote_id = p_quote_id))
  ) THEN
    PERFORM public._assert_quote_prices_as_sent(p_quote_id);
  END IF;

  v_result := public._convert_quote_to_order_owner_impl(
    p_quote_id,
    p_performed_by,
    p_idempotency_key
  );

  SELECT row_version INTO v_post_row_version
  FROM public.quotes
  WHERE id = p_quote_id;

  IF p_idempotency_key IS NOT NULL THEN
    UPDATE public.idempotency_keys
    SET result = v_result || jsonb_build_object(
      '_quote_id', p_quote_id,
      '_expected_row_version', p_expected_row_version,
      '_post_row_version', v_post_row_version
    )
    WHERE idempotency_key = p_idempotency_key
      AND operation = 'convert_quote_to_order';
    GET DIAGNOSTICS v_cache_rows = ROW_COUNT;
    IF v_cache_rows <> 1 THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CACHE_WRITE_FAILED';
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public._draw_down_quote_intent_impl_20260819(p_quote_id uuid, p_draws jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_below_cost_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Cutover barrier. TRY, not a waiting lock: a draw that waits here resumes
  -- with the pre-cutover implementation still in its plan cache and writes an
  -- averaged line the cutover has already declared impossible. See the header
  -- of 20260816110000 for the measured evidence. Refusing costs a retry;
  -- waiting costs money.
  --
  -- This is the first statement in the function on purpose. Nothing has been
  -- written, no other lock has been taken, and the below-cost approval gate
  -- has not run, so a refusal here leaves no trace beyond the rolled-back
  -- transaction -- and every draw takes this lock before any table lock, which
  -- is what keeps the lock ordering consistent with the cutover migration.
  IF NOT pg_try_advisory_xact_lock_shared(20260816, 1) THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CUTOVER_IN_PROGRESS: a draw-down maintenance change is being applied right now, so this draw was not recorded. Nothing was changed. Please try again in a moment.';
  END IF;

  -- PRICE LOCK (20261027040000): a booking is drawn only at the prices, lines and customer it
  -- was last sent with (draw_down_quote holds the quote row lock).
  PERFORM public._assert_quote_prices_as_sent(p_quote_id);

  PERFORM public._begin_below_cost_money_write(
    'draw_down_quote', p_performed_by,
    jsonb_build_object('below_cost_reason', p_below_cost_reason)
  );
  RETURN public._draw_down_quote_below_cost_impl_20260810(
    p_quote_id, p_draws, p_performed_by, p_idempotency_key
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_job_from_quote_section(p_quote_id uuid, p_section_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_existing jsonb; v_quote RECORD; v_section RECORD; v_item RECORD;
  v_job_id uuid; v_job_number text; v_job_date date; v_season integer;
  v_total_acres numeric := 0; v_total_cost_cents bigint := 0;
  v_total_price_cents bigint := 0; v_sort integer := 0;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing FROM idempotency_keys WHERE idempotency_key = p_idempotency_key AND operation = 'create_job_from_quote_section';
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  -- U5 (Codex P2): lock the quote BEFORE the status checks so a concurrent
  -- convert/close (each takes this same row lock first) serializes with job
  -- scheduling — a plain read could pass the guards on a booking another
  -- transaction is mid-way through accepting or closing.
  SELECT q.* INTO v_quote FROM quotes q WHERE q.id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;
  IF NOT v_quote.is_planned THEN RAISE EXCEPTION 'Quote must be marked as planned to schedule a job'; END IF;

  -- U5<<< #103: an 'accepted' booking was converted to a chemical SALE (order +
  -- delivery). Scheduling a job from it would re-reserve/double-count the same
  -- product. Block with a distinct token so the UI can point the user to a
  -- standalone job instead. (finding #103, CONFIRMED 2026-07-05)
  IF v_quote.status = 'accepted' THEN
    RAISE EXCEPTION 'QUOTE_ALREADY_CONVERTED: quote % was accepted and converted to a chemical sale (order) — create a standalone job instead of scheduling from this booking', v_quote.quote_number;
  END IF;
  -- >>>U5

  IF v_quote.status IN ('declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short') THEN
    RAISE EXCEPTION 'Cannot schedule job from quote with status: %', v_quote.status;
  END IF;

  -- PRICE LOCK (20261027040000): a job copies the section's prices into job_chemicals, so a
  -- sent booking schedules only at the prices, lines and customer it was last sent with. A
  -- planned draft that was never sent may still be scheduled at its own prices (Mason, 2026-10-14).
  PERFORM public._assert_quote_prices_as_sent(p_quote_id);

  SELECT qs.* INTO v_section FROM quote_sections qs WHERE qs.id = p_section_id AND qs.quote_id = p_quote_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Section not found or does not belong to quote'; END IF;

  IF EXISTS (SELECT 1 FROM jobs WHERE quote_section_id = p_section_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'A job already exists for this quote section. Delete or cancel the existing job first.';
  END IF;

  v_job_date := COALESCE(v_section.needed_by_date, CURRENT_DATE);
  v_season := CASE WHEN EXTRACT(MONTH FROM v_job_date) >= 10
    THEN EXTRACT(YEAR FROM v_job_date)::integer + 1 ELSE EXTRACT(YEAR FROM v_job_date)::integer END;
  v_job_number := next_job_number();

  INSERT INTO jobs (
    job_number, customer_id, status, job_date, notes, season, quote_id, quote_section_id,
    total_acres, total_cost_cents, total_price_cents, created_by,
    -- U8 (#99): snapshot the booking's commission split onto the job so pay attribution
    -- is locked at scheduling time (the same snapshot rule orders follow — a later quote
    -- or customer split edit must not re-attribute an already-scheduled job).
    commission_split
  ) VALUES (
    v_job_number, v_quote.customer_id, 'scheduled', v_job_date,
    COALESCE(v_section.section_name, 'Untitled') || COALESCE(': ' || v_section.section_header_notes, ''),
    v_season, p_quote_id, p_section_id, 0, 0, 0, v_actor,
    -- Codex R4 P1: a quote with no split locks the empty sentinel (no commission,
    -- order-channel parity) — NULL is reserved for pre-U8 jobs.
    COALESCE(v_quote.commission_split, '{"splits":[]}'::jsonb)
  ) RETURNING id INTO v_job_id;

  IF v_section.field_id IS NOT NULL THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres FROM quote_items qi WHERE qi.section_id = p_section_id;
    INSERT INTO job_fields (job_id, field_id, acres_to_treat, sort_order) VALUES (v_job_id, v_section.field_id, v_total_acres, 1);
  END IF;

  FOR v_item IN
    SELECT qi.product_id, qi.total_units_needed, qi.price_unit, qi.actual_rate, qi.rate_unit,
           qi.price_per_unit, qi.current_cost, qi.acres, qi.sort_order, p.unit_size
    FROM quote_items qi JOIN products p ON p.id = qi.product_id
    WHERE qi.section_id = p_section_id ORDER BY qi.sort_order
  LOOP
    v_sort := v_sort + 1;
    INSERT INTO job_chemicals (job_id, product_id, quantity, unit, rate_per_acre, rate_unit,
      cost_per_unit_cents, price_per_unit_cents, sort_order
    ) VALUES (v_job_id, v_item.product_id, COALESCE(v_item.total_units_needed, 0),
      COALESCE(v_item.price_unit, v_item.unit_size), v_item.actual_rate, v_item.rate_unit,
      ROUND(COALESCE(v_item.current_cost, 0) * 100)::bigint,
      ROUND(COALESCE(v_item.price_per_unit, 0) * 100)::bigint, v_sort);
    v_total_cost_cents := v_total_cost_cents + ROUND(COALESCE(v_item.current_cost, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
    v_total_price_cents := v_total_price_cents + ROUND(COALESCE(v_item.price_per_unit, 0) * COALESCE(v_item.total_units_needed, 0) * 100)::bigint;
  END LOOP;

  IF v_total_acres = 0 THEN
    SELECT COALESCE(MAX(qi.acres), 0) INTO v_total_acres FROM quote_items qi WHERE qi.section_id = p_section_id;
  END IF;
  UPDATE jobs SET total_acres = v_total_acres, total_cost_cents = v_total_cost_cents, total_price_cents = v_total_price_cents WHERE id = v_job_id;

  -- F1<<< 42P01 fix (plpgsql_check, 2026-06-10): the logging INSERT targeted
  -- the old log relation (named in the migration header; deliberately NOT
  -- spelled here — this comment lands in prosrc, and the self-verification
  -- block asserts the old relation name appears NOWHERE in the deployed
  -- body), which does not exist — every call aborted here at runtime.
  -- Re-pointed to activity_feed using its live column shape, the exact
  -- pattern draw_down_quote logs with; the old jsonb details payload
  -- (job_number / quote_id / quote_number / section_name) is folded into the
  -- description text. Event token 'job_created_from_quote' kept.
  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('job_created_from_quote',
    'Job ' || v_job_number || ' scheduled from quote ' || v_quote.quote_number ||
    COALESCE(' — section ' || v_section.section_name, ''),
    v_actor, 'job', v_job_id, v_quote.customer_id);
  -- >>>F1

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_job_from_quote_section', jsonb_build_object('job_id', v_job_id));
  END IF;

  RETURN jsonb_build_object('job_id', v_job_id);
END;
$function$;

DO $postflight$
BEGIN
  -- Owner, mode, search_path and grants survived CREATE OR REPLACE; one overload each.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('_save_quote_below_cost_impl_20260810', 'public._save_quote_below_cost_impl_20260810(uuid,jsonb,jsonb,uuid,text)',
          ARRAY['postgres'], true),
        ('_create_quote_version_owner_impl', 'public._create_quote_version_owner_impl(uuid,uuid,text,text)',
          ARRAY['postgres', 'service_role'], false),
        ('_restore_quote_version_owner_impl', 'public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)',
          ARRAY['postgres', 'service_role'], false),
        ('_convert_quote_to_order_below_cost_impl_20260810', 'public._convert_quote_to_order_below_cost_impl_20260810(uuid,uuid,text,bigint)',
          ARRAY['postgres'], true),
        ('_draw_down_quote_intent_impl_20260819', 'public._draw_down_quote_intent_impl_20260819(uuid,jsonb,uuid,text,text)',
          ARRAY['postgres'], true),
        ('create_job_from_quote_section', 'public.create_job_from_quote_section(uuid,uuid,uuid,text)',
          ARRAY['authenticated', 'postgres', 'service_role'], true)
      ) AS pin(fn, sig, execs, calls_check)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc o
             WHERE o.pronamespace = 'public'::regnamespace AND o.proname = pin.fn) <> 1
        OR p.proowner <> 'postgres'::regrole
        OR NOT p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM pin.execs
        OR has_function_privilege('anon', p.oid, 'EXECUTE')
        OR (pin.calls_check AND position('public._assert_quote_prices_as_sent(' IN p.prosrc) = 0)
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_QUOTE_FUNCTION_DRIFT: a re-emitted quote function lost its owner, mode, search_path or grants, or does not call the price check';
  END IF;

  -- The check: invoker rights, fixed search_path, executable by no API role.
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
       AND proname = '_assert_quote_prices_as_sent') <> 1
     OR (SELECT NOT p.prosecdef
          AND p.proowner = 'postgres'::regrole
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
          AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
          AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
         FROM pg_proc p WHERE p.oid = to_regprocedure('public._assert_quote_prices_as_sent(uuid)'))
        IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRICE_CHECK_DRIFT: _assert_quote_prices_as_sent must be invoker-rights, owned by postgres, path-pinned and executable by no API role';
  END IF;

  -- Versions now record line ids and manual prices; restore and save use them.
  IF position('''quote_item_id'', qi.id' IN (SELECT prosrc FROM pg_proc
       WHERE oid = to_regprocedure('public._create_quote_version_owner_impl(uuid,uuid,text,text)'))) = 0
     OR position('v_item->>''quote_item_id''' IN (SELECT prosrc FROM pg_proc
       WHERE oid = to_regprocedure('public._restore_quote_version_owner_impl(uuid,uuid,uuid,text)'))) = 0
     OR position('v_carry_prices' IN (SELECT prosrc FROM pg_proc
       WHERE oid = to_regprocedure('public._save_quote_below_cost_impl_20260810(uuid,jsonb,jsonb,uuid,text)'))) = 0 THEN
    RAISE EXCEPTION 'POSTFLIGHT_PRICE_LOCK_BODY_MISSING: a re-emitted body lacks its price-lock change';
  END IF;

  RAISE NOTICE 'POSTFLIGHT_OK quote sent-price lock installed';
END
$postflight$;
