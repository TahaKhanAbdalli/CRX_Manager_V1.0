-- Written 2026-10-15. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: a sales rep records only their own name as salesperson on orders and blend tickets, and
--   bills a blend ticket only when it is theirs or has no salesperson. Admins are unrestricted.
--   This is the rest of Goal 2's "own-name everywhere" after 20261014210000 (order invoices).
--   1. New trigger function public.guard_rep_salesman_20261015() (SECURITY INVOKER, search_path
--      public, pg_temp, executable by no API role) and two triggers that run it:
--        orders_guard_rep_salesman_20261015        BEFORE INSERT OR UPDATE OF salesman_id ON orders
--        blend_tickets_guard_rep_salesman_20261015 BEFORE INSERT OR UPDATE OF salesman_id ON blend_tickets
--      For an active sales rep who is not an admin (is_admin()/is_sales_rep(), read from auth.uid()):
--        * INSERT: salesman_id must be NULL or the rep;
--        * UPDATE: salesman_id may change only from NULL to the rep. Another person's name is never
--          replaced (not even with the rep's own), never cleared, and a blank is never filled with
--          someone else's name.
--      Refused with SALESMAN_SCOPE_DENIED (P0001), the code save_invoice and the order-invoice RPCs
--      use. An UPDATE that leaves salesman_id unchanged is never refused, whoever's row it is, so
--      the definer-rights RPCs that update orders and tickets while a rep is signed in (complete
--      delivery, cancel/void, pricing, line edits, draw-down, link/unlink, approve/reject, billing
--      status, soft delete) are unaffected. Admins, service-side callers with no auth.uid() and
--      every other role pass straight through. Because the triggers see every path, they also
--      cover:
--        * a rep's direct Data API INSERT of an order naming another rep (orders_insert is
--          is_admin() OR is_sales_rep() with no salesperson test);
--        * a rep's direct UPDATE of blend_tickets.salesman_id (blend_tickets_office_update is
--          is_admin() OR is_sales_rep(); authenticated holds UPDATE on that column);
--        * create_order_from_blend_ticket, which copies the ticket's salesperson onto the new
--          order: a rep converting a ticket that names another rep is refused.
--   2. create_invoice_from_blend_ticket (granted to authenticated; admits admins and reps) wrote the
--      ticket's salesman_id onto every invoice it creates with no own-name test, and
--      invoices.salesman_id is a read-access key. It now refuses a non-admin caller whose ticket
--      names someone else, with SALESMAN_SCOPE_DENIED, after locking the ticket row and before its
--      replay lookup, so no invoice number is drawn. Its replay lookup (check_idempotency) matches
--      on the key alone, so a stored result is now returned only when every invoice in it belongs
--      to this ticket and was created by this caller; otherwise IDEMPOTENCY_INTENT_MISMATCH (a
--      reused key can no longer return another ticket's or another person's invoices). Re-emitted
--      as its verbatim live body plus those two hunks (pre md5 CR-insensitive
--      c520a7301f88f3e96ed7bbc33101c4ef, post 7be2aeab29bcd4ef50e74dd7a63bcfbc).
--
-- WHY (Mason): the own-name rule since 2026-10-06, narrowed 2026-10-13 to "reps bill any customer,
--   but only under their own name; admins unrestricted"; 2026-10-15 in chat: "do the docs follow up
--   and then lets work on remaining items" (KNOWN_ISSUES.md, "Order and blend-ticket salesperson").
--
-- NO SCREEN CHANGES BEHAVIOR (read live 2026-10-15): no screen writes orders.salesman_id or
--   blend_tickets.salesman_id; every order RPC except create_order_from_blend_ticket inserts it as
--   NULL; all live orders have it NULL and no blend tickets exist.
--
-- NOT CHANGED: quotes.salesman_id (quote-to-order does not copy it; season rollover does, so a
--   quote rule needs its own decision; KNOWN_ISSUES.md); every policy and grant on orders and
--   blend_tickets (the triggers add the test without widening or narrowing access);
--   enforce_linked_blend_ticket_header_lock (it still freezes a linked or billed ticket's
--   salesperson for everyone); every other line of create_invoice_from_blend_ticket. No rows
--   change. CREATE OR REPLACE keeps that function's OID, owner and exact ACL, and the postflight
--   proves it; the only REVOKE is the routine lock-down of the new trigger function.
--
-- OVERLOADS: create_invoice_from_blend_ticket has exactly one overload, (uuid,uuid,text) (read-only
--   on live 2026-10-15); the preflight and postflight refuse a second one.
--
-- ROLLBACK (if ever needed, as its own reviewed migration): DROP TRIGGER
--   orders_guard_rep_salesman_20261015 ON public.orders; DROP TRIGGER
--   blend_tickets_guard_rep_salesman_20261015 ON public.blend_tickets; DROP FUNCTION
--   public.guard_rep_salesman_20261015(); and re-emit create_invoice_from_blend_ticket from
--   20260714230200_blend_ticket_order_lifecycle.sql.
--
-- ORDERING: strict. Apply after every older pending migration.
--
-- actor-binding-check: exempt. create_invoice_from_blend_ticket does bind p_created_by: its
--   verbatim live body sets v_actor := auth.uid() and raises 'p_created_by does not match
--   authenticated user' when they differ, before any write. Only the wording differs from the
--   ACTOR_MISMATCH code, and this migration keeps the live wording.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE rep_salesman_own_name_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
       to_regprocedure('public.create_invoice_from_blend_ticket(uuid,uuid,text)')::oid AS blend_invoice_oid;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change
  -- (a client that stops on the first error, as every sanctioned apply path does, then stops).
  IF to_regclass('pg_temp.rep_salesman_own_name_tx') IS NULL THEN
    RAISE EXCEPTION 'REP_SALESMAN_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.rep_salesman_own_name_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'REP_SALESMAN_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Live stores this body with CRLF line ends; the pin ignores carriage returns.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_invoice_from_blend_ticket') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text'
        AND md5(replace(p.prosrc, chr(13), '')) = 'c520a7301f88f3e96ed7bbc33101c4ef'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.create_invoice_from_blend_ticket(uuid,uuid,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_BLEND_TICKET_INVOICE_DRIFT: expected the exact reviewed public create_invoice_from_blend_ticket';
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
  -- Both guarded columns exist as uuid.
  IF (SELECT count(*) FROM pg_attribute a
       WHERE a.attrelid IN ('public.orders'::regclass, 'public.blend_tickets'::regclass)
         AND a.attname = 'salesman_id' AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype) <> 2 THEN
    RAISE EXCEPTION 'PREFLIGHT_SALESMAN_COLUMN_DRIFT: orders.salesman_id and blend_tickets.salesman_id must both be uuid';
  END IF;
  -- Not re-runnable: the guard must not exist yet.
  IF to_regprocedure('public.guard_rep_salesman_20261015()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgname IN ('orders_guard_rep_salesman_20261015', 'blend_tickets_guard_rep_salesman_20261015')) THEN
    RAISE EXCEPTION 'PREFLIGHT_GUARD_EXISTS: the rep salesperson guard is already installed';
  END IF;
END
$preflight$;

-- 1. The guard. Deliberately NOT SECURITY DEFINER: it reads only auth.uid() and the role helpers,
--    which it can call with the caller's rights, and it must not lend its owner's rights to anyone.
CREATE FUNCTION public.guard_rep_salesman_20261015()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
BEGIN
  -- Own name (Mason, 2026-10-06, narrowed 2026-10-13): a sales rep records only themselves as
  -- salesperson; an admin may name anyone. Admins, service-side callers with no auth.uid() and
  -- every non-rep role pass through.
  IF public.is_admin() OR NOT public.is_sales_rep() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.salesman_id IS NOT NULL AND NEW.salesman_id IS DISTINCT FROM (SELECT auth.uid()) THEN
      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: an unchanged salesperson is never refused, so definer RPCs that update another rep's
  -- row for other reasons keep working. A change is allowed only from blank to the rep.
  IF NEW.salesman_id IS DISTINCT FROM OLD.salesman_id
     AND (OLD.salesman_id IS NOT NULL OR NEW.salesman_id IS DISTINCT FROM (SELECT auth.uid())) THEN
    RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
  END IF;
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION public.guard_rep_salesman_20261015() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER orders_guard_rep_salesman_20261015
  BEFORE INSERT OR UPDATE OF salesman_id
  ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_rep_salesman_20261015();

CREATE TRIGGER blend_tickets_guard_rep_salesman_20261015
  BEFORE INSERT OR UPDATE OF salesman_id
  ON public.blend_tickets
  FOR EACH ROW EXECUTE FUNCTION public.guard_rep_salesman_20261015();

-- 2. create_invoice_from_blend_ticket: verbatim live body plus the own-name test.
CREATE OR REPLACE FUNCTION public.create_invoice_from_blend_ticket(
  p_blend_ticket_id uuid,
  p_created_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor               uuid := auth.uid();
  v_existing            jsonb;
  v_ticket              record;
  v_field_ids           uuid[];
  v_applied_acres_map   jsonb := '{}'::jsonb;
  v_btf                 record;
  v_field_acres         numeric;
  v_shares              jsonb;
  v_customers           jsonb;
  v_customer            jsonb;
  v_customer_id         uuid;
  v_customer_name       text;
  v_customer_tier       int;
  v_is_primary          boolean;
  v_has_override        boolean;
  v_invoice_id          uuid;
  v_invoice_number      text;
  v_invoice_group_id    uuid;
  v_invoice_ids         uuid[] := '{}';
  v_app_service         record;
  v_has_app_service     boolean := false;
  v_fee_rate            bigint;
  v_btp                 record;
  v_share_row           jsonb;
  v_share_acres         numeric;
  v_field_override      bigint;
  v_field_pricing_note  text;
  v_unit_price          bigint;
  v_unit_cost           bigint;
  v_qi_price            numeric;
  v_quoted_price        bigint;
  v_quote_section_id    uuid;
  v_price_source        text;
  v_extended            bigint;
  v_invoice_total       bigint;
  v_invoice_cost        bigint;
  v_total_share_acres   numeric;
  v_grower_share_amount bigint;
  v_fee_acres           numeric;
  v_fee_extended        bigint;
  v_fee_cost            bigint;
  v_result              jsonb;
  v_customer_count      int;
  v_chem_qty_a          numeric;
  v_chem_qty_b          numeric;
  v_rate                numeric;
  -- A5: unit-conversion + pre-billing validation locals
  v_rate_unit_line      text;
  v_inv_unit_line       text;
  v_chem_qty_a_conv     numeric;
  v_chem_qty_b_conv     numeric;
  v_bad_rate            text;
  v_bad_unit            text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_created_by does not match authenticated user';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create blend ticket invoices';
  END IF;

  -- Own name (Mason, 2026-10-06, narrowed 2026-10-13): a sales rep bills any customer but only
  -- under their own name; an admin may name anyone. Every invoice below carries the ticket's
  -- salesperson, so a non-admin may bill a ticket only when it is theirs or has no salesperson.
  -- The ticket is locked first, so an admin reassigning it cannot change that salesperson between
  -- this test and the inserts, and the test runs before the replay lookup and any invoice number.
  IF NOT public.is_admin() THEN
    PERFORM 1 FROM public.blend_tickets bt WHERE bt.id = p_blend_ticket_id FOR UPDATE;
    IF EXISTS (
      SELECT 1 FROM public.blend_tickets bt
       WHERE bt.id = p_blend_ticket_id
         AND bt.salesman_id IS NOT NULL
         AND bt.salesman_id IS DISTINCT FROM v_actor
    ) THEN
      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
    END IF;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(
      p_idempotency_key,
      'create_invoice_from_blend_ticket'
    );
    IF v_existing IS NOT NULL THEN
      -- The receipt is keyed by the key alone. Replay it only to the person who billed this
      -- ticket under that key, so a reused key never returns another ticket's or another
      -- person's invoices.
      IF jsonb_typeof(v_existing->'invoice_ids') IS DISTINCT FROM 'array'
         OR jsonb_array_length(v_existing->'invoice_ids') = 0
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(v_existing->'invoice_ids') AS r(invoice_id)
             LEFT JOIN public.invoices i ON i.id = r.invoice_id::uuid
            WHERE i.id IS NULL
               OR i.blend_ticket_id IS DISTINCT FROM p_blend_ticket_id
               OR i.created_by IS DISTINCT FROM v_actor
         ) THEN
        RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  SELECT * INTO v_ticket
    FROM blend_tickets
   WHERE id = p_blend_ticket_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Blend ticket not found: %', p_blend_ticket_id; END IF;
  IF v_ticket.review_status != 'approved' THEN
    RAISE EXCEPTION 'Blend ticket must be approved (status: %)', v_ticket.review_status;
  END IF;
  IF v_ticket.payment_status IS DISTINCT FROM 'unbilled' THEN
    RAISE EXCEPTION 'Blend ticket cannot be billed (payment_status: %); only an unbilled ticket can generate an invoice', v_ticket.payment_status;
  END IF;

  -- A linked sales-order path and a direct blend-ticket invoice are mutually
  -- exclusive billing provenance. The ticket row is already locked, and these
  -- checks run before field derivation, invoice numbering, commissions, or writes.
  IF v_ticket.order_link_status = 'linked'
     OR EXISTS (
       SELECT 1 FROM public.blend_ticket_to_order_items
        WHERE blend_ticket_id = p_blend_ticket_id
     ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_LINKED_ORDER_INVOICE_LOCKED';
  END IF;

  -- Do not trust the cached payment flag alone: an active invoice may exist
  -- while payment_status is stale/unbilled. Terminal invoices release the lock.
  IF EXISTS (
    SELECT 1 FROM public.invoices i
     WHERE i.blend_ticket_id = p_blend_ticket_id
       AND i.deleted_at IS NULL
       AND COALESCE(i.status, '') NOT IN ('voided', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_ACTIVE_INVOICE_EXISTS';
  END IF;

  -- U6 #91a: refuse to bill the blend ticket if its linked job has ALREADY been
  -- invoiced (job.status='invoiced', or job.invoice_id points at a still-active
  -- invoice). The blend ticket and the job invoice bill the SAME application, so
  -- letting both through double-bills the customer. Block, do not warn.
  IF v_ticket.job_id IS NOT NULL THEN
    -- U6 (Codex P1): lock the JOB row first — transfer_job_to_invoice locks this
    -- same row (FOR UPDATE) before ITS blend-ticket guard, so the two paths
    -- serialize on it; without the lock both guards could read pre-commit state
    -- concurrently and both invoices would land (the exact double-bill this
    -- guard exists to stop). Lock order is safe: neither path row-locks
    -- blend_tickets after jobs.
    PERFORM 1 FROM jobs WHERE id = v_ticket.job_id FOR UPDATE;
    -- Codex R2 P2: test for a LIVE invoice directly (invoices.job_id, non-void/
    -- cancel, not deleted) instead of trusting jobs.status — a job stranded as
    -- 'invoiced' by a PRE-U6 void (dead invoice, status never reverted) must not
    -- block billing the ticket forever.
    IF EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.job_id = v_ticket.job_id
        AND i.status NOT IN ('voided', 'cancelled')
        AND i.deleted_at IS NULL
    ) THEN
      RAISE EXCEPTION 'JOB_ALREADY_INVOICED: this blend ticket''s job has already been invoiced; billing the ticket too would double-bill the customer. Void the job invoice first if you meant to re-bill.';
    END IF;
  END IF;

  -- A5 BEGIN: refuse to bill blend lines that can't be priced correctly.
  -- (1) A billable product line with no per-acre rate would silently bill $0.
  SELECT string_agg(DISTINCT btp.product_name, ', ')
    INTO v_bad_rate
    FROM blend_ticket_products btp
   WHERE btp.blend_ticket_id = p_blend_ticket_id
     AND btp.product_id IS NOT NULL
     AND (btp.rate_per_acre IS NULL OR btp.rate_per_acre <= 0);
  IF v_bad_rate IS NOT NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_ZERO_RATE: product(s) have no per-acre rate and cannot be billed: %', v_bad_rate;
  END IF;
  -- (2) A billable line whose rate unit cannot convert to the product's inventory
  --     (pricing) unit would mis-bill by the unit ratio (the oz-vs-gal 128x class).
  SELECT string_agg(DISTINCT btp.product_name, ', ')
    INTO v_bad_unit
    FROM blend_ticket_products btp
    JOIN products p ON p.id = btp.product_id
   WHERE btp.blend_ticket_id = p_blend_ticket_id
     AND btp.product_id IS NOT NULL
     AND field_app_priced_quantity(
           1,
           normalize_rate_unit(COALESCE(NULLIF(btrim(btp.rate_per_acre_unit), ''), p.rate_unit)),
           normalize_rate_unit(COALESCE(NULLIF(btrim(p.inventory_unit), ''), p.unit_size)),
           p.product_form
         ) IS NULL;
  IF v_bad_unit IS NOT NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_UNIT_UNCONVERTIBLE: product(s) have a rate unit that cannot convert to the inventory unit: %', v_bad_unit;
  END IF;
  -- A5 END

  FOR v_btf IN
    SELECT btf.field_id,
           COALESCE(btf.actual_acres, btf.planned_acres, f.total_acres, 0) AS field_acres
      FROM blend_ticket_fields btf
      JOIN fields f ON f.id = btf.field_id
     WHERE btf.blend_ticket_id = p_blend_ticket_id
  LOOP
    v_field_ids := array_append(v_field_ids, v_btf.field_id);
    v_applied_acres_map := v_applied_acres_map || jsonb_build_object(v_btf.field_id::text, v_btf.field_acres);
  END LOOP;

  IF v_field_ids IS NULL OR array_length(v_field_ids, 1) IS NULL THEN
    IF v_ticket.field_id IS NOT NULL THEN
      v_field_ids := ARRAY[v_ticket.field_id];
      SELECT COALESCE(v_ticket.total_acres, f.total_acres, 0) INTO v_field_acres
        FROM fields f WHERE f.id = v_ticket.field_id;
      v_applied_acres_map := jsonb_build_object(v_ticket.field_id::text, v_field_acres);
    ELSE
      RAISE EXCEPTION 'Blend ticket has no fields';
    END IF;
  END IF;

  v_shares    := derive_customer_shares_from_fields(v_field_ids, v_applied_acres_map);
  v_customers := v_shares -> 'customers';
  v_customer_count := jsonb_array_length(v_customers);

  IF v_customer_count = 0 THEN
    RAISE EXCEPTION 'No billing customers derived from blend ticket fields';
  END IF;

  IF v_ticket.application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = v_ticket.application_service_id;
    v_has_app_service := FOUND
                         AND (v_app_service IS NOT NULL)
                         AND COALESCE(v_app_service.is_active, false);
  END IF;

  v_quote_section_id := NULL;
  IF v_ticket.job_id IS NOT NULL THEN
    SELECT j.quote_section_id INTO v_quote_section_id FROM jobs j WHERE j.id = v_ticket.job_id;
  END IF;

  IF v_customer_count > 1 THEN
    v_invoice_group_id := gen_random_uuid();
  ELSE
    v_invoice_group_id := NULL;
  END IF;

  FOR v_customer IN SELECT * FROM jsonb_array_elements(v_customers)
  LOOP
    v_customer_id   := (v_customer->>'customer_id')::uuid;
    v_customer_name := v_customer->>'customer_name';
    v_customer_tier := COALESCE((v_customer->>'tier')::int, 1);
    v_is_primary    := COALESCE((v_customer->>'is_primary')::boolean, false);
    v_has_override  := COALESCE((v_customer->>'has_override')::boolean, false);

    v_invoice_total := 0;
    v_invoice_cost  := 0;
    v_invoice_number := next_invoice_number();

    INSERT INTO invoices (
      blend_ticket_id, customer_id, invoice_type, status, season,
      invoice_number, salesman_id, created_by,
      total_amount_cents, total_cost_cents,
      invoice_date, invoice_group_id, application_service_id
    ) VALUES (
      p_blend_ticket_id, v_customer_id, 'field_application', 'draft',
      COALESCE(v_ticket.season, current_season()),
      v_invoice_number, v_ticket.salesman_id, p_created_by,
      0, 0,
      CURRENT_DATE, v_invoice_group_id, v_ticket.application_service_id
    ) RETURNING id INTO v_invoice_id;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);

    FOR v_share_row IN
      SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
      WHERE (value ->> 'customer_id')::uuid = v_customer_id
        AND (value ->> 'price_override_cents') IS NOT NULL
    LOOP
      v_share_acres        := (v_share_row->>'share_acres')::numeric;
      v_field_override     := (v_share_row->>'price_override_cents')::bigint;
      v_field_pricing_note := v_share_row->>'pricing_note';
      v_grower_share_amount := safe_cents_qty(v_field_override, v_share_acres);

      INSERT INTO invoice_items (
        invoice_id, description, quantity, unit_size,
        unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_per_acre, rate_unit,
        is_application_fee, price_source
      ) VALUES (
        v_invoice_id,
        (v_share_row->>'field_name') || ' — grower share @ $' ||
          (v_field_override / 100.0)::numeric(12,2) || '/ac' ||
          CASE WHEN v_field_pricing_note IS NOT NULL AND v_field_pricing_note <> ''
               THEN ' (' || v_field_pricing_note || ')' ELSE '' END,
        v_share_acres, 'acre',
        v_field_override, v_grower_share_amount, 0,
        0, v_share_acres, v_field_override, 'acre',
        false, 'manual'
      );
      v_invoice_total := v_invoice_total + v_grower_share_amount;
    END LOOP;

    FOR v_btp IN
      SELECT btp.*, p.tier1_price, p.tier2_price, p.tier3_price,
             p.product_name AS full_product_name, p.current_cost AS product_cost,
             p.unit_size, p.rate_unit,
             -- A5: inventory unit + form drive the rate->pricing-unit conversion
             p.inventory_unit, p.product_form
        FROM blend_ticket_products btp
        LEFT JOIN products p ON p.id = btp.product_id
       WHERE btp.blend_ticket_id = p_blend_ticket_id
       ORDER BY btp.sequence_order
    LOOP
      v_chem_qty_a := 0;
      v_chem_qty_b := 0;
      v_rate := COALESCE(v_btp.rate_per_acre, 0);

      FOR v_share_row IN
        SELECT * FROM jsonb_array_elements(v_shares -> 'rows') AS value
        WHERE (value ->> 'customer_id')::uuid = v_customer_id
      LOOP
        v_share_acres := (v_share_row->>'share_acres')::numeric;
        IF (v_share_row->>'price_override_cents') IS NOT NULL THEN
          v_chem_qty_a := v_chem_qty_a + (v_rate * v_share_acres);
        ELSE
          v_chem_qty_b := v_chem_qty_b + (v_rate * v_share_acres);
        END IF;
      END LOOP;

      -- A5: convert the accumulated rate-unit quantities to the product's inventory
      -- (pricing) unit so money = price/inventory-unit x qty/inventory-unit. Unmatched
      -- products (no product row) keep the raw quantity (no price, nothing to convert).
      -- Convertibility was pre-validated above, so the helper is non-NULL here.
      -- Display units keep their original casing; the helper gets normalized units
      -- (strips /ac + maps plural/spelled aliases) so oz/ac, gallons, etc. convert.
      v_rate_unit_line := COALESCE(NULLIF(btrim(v_btp.rate_per_acre_unit), ''), v_btp.rate_unit);
      v_inv_unit_line  := COALESCE(NULLIF(btrim(v_btp.inventory_unit), ''), v_btp.unit_size);
      IF v_btp.product_id IS NOT NULL THEN
        v_chem_qty_a_conv := field_app_priced_quantity(v_chem_qty_a, normalize_rate_unit(v_rate_unit_line), normalize_rate_unit(v_inv_unit_line), v_btp.product_form);
        v_chem_qty_b_conv := field_app_priced_quantity(v_chem_qty_b, normalize_rate_unit(v_rate_unit_line), normalize_rate_unit(v_inv_unit_line), v_btp.product_form);
      ELSE
        v_chem_qty_a_conv := v_chem_qty_a;
        v_chem_qty_b_conv := v_chem_qty_b;
      END IF;

      IF v_chem_qty_a > 0 THEN
        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size,
          unit_price_cents, extended_cents, cost_cents,
          sort_order, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_btp.product_id,
          COALESCE(v_btp.full_product_name, v_btp.product_name) || ' — included in grower share',
          ROUND(v_chem_qty_a_conv, 4), v_inv_unit_line,
          0, 0, 0,
          v_btp.sequence_order, v_rate, v_rate_unit_line,
          false, 'manual'
        );
      END IF;

      IF v_chem_qty_b > 0 THEN
        v_unit_price   := NULL;
        v_quoted_price := NULL;
        v_price_source := NULL;

        IF v_btp.unit_price_cents IS NOT NULL THEN
          v_unit_price   := v_btp.unit_price_cents;
          v_price_source := 'manual';
        ELSIF v_quote_section_id IS NOT NULL AND v_btp.product_id IS NOT NULL THEN
          SELECT qi.price_per_unit INTO v_qi_price
            FROM quote_items qi
           WHERE qi.section_id = v_quote_section_id
             AND qi.product_id = v_btp.product_id
           ORDER BY qi.id LIMIT 1;
          IF v_qi_price IS NOT NULL THEN
            v_unit_price   := ROUND(v_qi_price * 100)::bigint;
            v_quoted_price := v_unit_price;
            v_price_source := 'quoted';
          END IF;
        END IF;

        IF v_unit_price IS NULL THEN
          IF v_btp.product_id IS NOT NULL THEN
            v_unit_price := CASE v_customer_tier
              WHEN 1 THEN COALESCE(ROUND(v_btp.tier1_price * 100), 0)
              WHEN 2 THEN COALESCE(ROUND(v_btp.tier2_price * 100), ROUND(v_btp.tier1_price * 100), 0)
              WHEN 3 THEN COALESCE(ROUND(v_btp.tier3_price * 100), ROUND(v_btp.tier1_price * 100), 0)
              ELSE COALESCE(ROUND(v_btp.tier1_price * 100), 0)
            END;
          ELSE
            v_unit_price := 0;
          END IF;
          IF v_price_source IS NULL THEN v_price_source := 'tier'; END IF;
        END IF;

        v_unit_cost := COALESCE(v_btp.unit_cost_cents,
                                ROUND(COALESCE(v_btp.product_cost, 0) * 100)::bigint, 0);
        v_extended := safe_cents_qty(v_unit_price, v_chem_qty_b_conv);

        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size,
          unit_price_cents, extended_cents, cost_cents,
          sort_order, rate_per_acre, rate_unit,
          quoted_price_cents, is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_btp.product_id,
          COALESCE(v_btp.full_product_name, v_btp.product_name),
          ROUND(v_chem_qty_b_conv, 4), v_inv_unit_line,
          v_unit_price, v_extended, v_unit_cost,
          v_btp.sequence_order, v_rate, v_rate_unit_line,
          v_quoted_price, false, v_price_source
        );
        v_invoice_total := v_invoice_total + v_extended;
        v_invoice_cost  := v_invoice_cost + safe_cents_qty(v_unit_cost, v_chem_qty_b_conv);
      END IF;
    END LOOP;

    IF v_has_app_service THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id            = v_customer_id
         AND car.application_service_id = v_ticket.application_service_id
         AND car.season                 = COALESCE(v_ticket.season, current_season())
       LIMIT 1;
      IF v_fee_rate IS NULL THEN v_fee_rate := v_app_service.default_rate_per_acre_cents; END IF;

      SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_fee_acres
        FROM jsonb_array_elements(v_shares -> 'rows') AS value
       WHERE (value->>'customer_id')::uuid = v_customer_id
         AND (value->>'price_override_cents') IS NULL;

      IF v_fee_rate > 0 AND v_fee_acres > 0 THEN
        v_fee_extended := safe_cents_qty(v_fee_rate, v_fee_acres);
        v_fee_cost     := safe_cents_qty(v_app_service.cost_per_acre_cents, v_fee_acres);
        INSERT INTO invoice_items (
          invoice_id, description, quantity, unit_price_cents, extended_cents,
          cost_cents, sort_order, acres, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_app_service.name, v_fee_acres,
          v_fee_rate, v_fee_extended, v_fee_cost,
          9999, v_fee_acres, v_fee_rate, 'acre',
          true, 'tier'
        );
        v_invoice_total := v_invoice_total + v_fee_extended;
        v_invoice_cost  := v_invoice_cost + v_fee_cost;
      END IF;
    END IF;

    UPDATE invoices SET
      total_amount_cents = v_invoice_total,
      total_cost_cents   = v_invoice_cost
    WHERE id = v_invoice_id;

    INSERT INTO financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description
    ) VALUES (
      'invoice_created', 'invoice', v_invoice_id,
      (SELECT role FROM profiles WHERE id = v_actor),
      jsonb_build_object(
        'invoice_number', v_invoice_number,
        'blend_ticket_number', v_ticket.ticket_number,
        'customer_id', v_customer_id,
        'total_cents', v_invoice_total
      ),
      v_invoice_total,
      'Invoice created from blend ticket ' || v_ticket.ticket_number
    );

    SELECT COALESCE(SUM((value->>'share_acres')::numeric), 0) INTO v_total_share_acres
      FROM jsonb_array_elements(v_shares -> 'rows') AS value
     WHERE (value->>'customer_id')::uuid = v_customer_id;

    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order,
      price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_total_share_acres, v_invoice_total,
      v_is_primary, 0,
      CASE WHEN v_has_override THEN
        (SELECT (value->>'price_override_cents')::bigint
         FROM jsonb_array_elements(v_shares -> 'rows') AS value
         WHERE (value->>'customer_id')::uuid = v_customer_id
           AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
      ELSE NULL END,
      CASE WHEN v_has_override THEN
        (SELECT (value->>'pricing_note')
         FROM jsonb_array_elements(v_shares -> 'rows') AS value
         WHERE (value->>'customer_id')::uuid = v_customer_id
           AND (value->>'price_override_cents') IS NOT NULL LIMIT 1)
      ELSE NULL END
    );
  END LOOP;

  UPDATE blend_tickets SET payment_status = 'billed' WHERE id = p_blend_ticket_id;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
  VALUES ('invoice_created',
          'Invoice(s) created from blend ticket ' || v_ticket.ticket_number ||
            CASE WHEN v_invoice_group_id IS NOT NULL
                 THEN ' (group of ' || v_customer_count || ')' ELSE '' END,
          p_created_by, 'invoice', v_invoice_ids[1], v_ticket.customer_id);

  v_result := jsonb_build_object(
    'invoice_ids',      to_jsonb(v_invoice_ids),
    'invoice_group_id', v_invoice_group_id
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(
      p_idempotency_key,
      'create_invoice_from_blend_ticket',
      v_result
    );
  END IF;

  RETURN v_result;
END;
$function$;

DO $postflight$
BEGIN
  IF to_regclass('pg_temp.rep_salesman_own_name_tx') IS NULL THEN
    RAISE EXCEPTION 'REP_SALESMAN_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.rep_salesman_own_name_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'REP_SALESMAN_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF to_regprocedure('public.create_invoice_from_blend_ticket(uuid,uuid,text)')::oid
       IS DISTINCT FROM (SELECT blend_invoice_oid FROM pg_temp.rep_salesman_own_name_tx) THEN
    RAISE EXCEPTION 'POSTFLIGHT_BLEND_TICKET_INVOICE_IDENTITY: the replace must preserve the function OID';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_invoice_from_blend_ticket') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) = '7be2aeab29bcd4ef50e74dd7a63bcfbc'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.create_invoice_from_blend_ticket(uuid,uuid,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_BLEND_TICKET_INVOICE_CONTRACT: public create_invoice_from_blend_ticket body, signature or access drifted';
  END IF;
  -- The guard runs with the caller's rights, a pinned search_path, and no API role may call it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.guard_rep_salesman_20261015()')
       AND p.proowner = 'postgres'::regrole AND NOT p.prosecdef
       AND p.prorettype = 'trigger'::regtype
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
  ) OR EXISTS (
    SELECT 1 FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS api_role
     WHERE has_function_privilege(api_role, 'public.guard_rep_salesman_20261015()', 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_GUARD_FUNCTION_CONTRACT: guard_rep_salesman_20261015 must be SECURITY INVOKER, search_path public, pg_temp, executable by no API role';
  END IF;
  -- Each table carries exactly its reviewed trigger: enabled, ROW level, BEFORE, on INSERT and on
  -- UPDATE OF salesman_id only.
  IF (SELECT count(*) FROM pg_trigger t
       WHERE (t.tgrelid, t.tgname) IN (('public.orders'::regclass, 'orders_guard_rep_salesman_20261015'),
                                       ('public.blend_tickets'::regclass, 'blend_tickets_guard_rep_salesman_20261015'))
         AND t.tgfoid = to_regprocedure('public.guard_rep_salesman_20261015()')
         AND t.tgenabled = 'O'
         AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(t.tgattr) k
                JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k) = ARRAY['salesman_id']
         AND (t.tgtype::int & 3) = 3       -- ROW level, BEFORE
         AND (t.tgtype::int & 4) <> 0      -- fires on INSERT
         AND (t.tgtype::int & 16) <> 0     -- and on UPDATE
         AND (t.tgtype::int & 8) = 0       -- not on DELETE
     ) <> 2 THEN
    RAISE EXCEPTION 'POSTFLIGHT_GUARD_TRIGGERS: both salesperson guard triggers must be installed as reviewed';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: a sales rep records only themselves (or no one) as salesperson on orders and blend tickets, and bills only their own or an unassigned blend ticket; admins unrestricted';
END
$postflight$;
