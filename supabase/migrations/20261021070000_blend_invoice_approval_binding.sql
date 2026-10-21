-- Written 2026-10-21. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md; this header is not updated after an apply.
--
-- WHAT (Goal 3 follow-ups to 20261020210000, blend-ticket invoices; Mason 2026-10-21: "perform all
-- follow ups"): create_invoice_from_blend_ticket is DROPPED and re-created with one new trailing
-- argument, p_approved_zero_lines jsonb DEFAULT NULL, and the same grants. Its body is the live
-- body verbatim (md5 aae1f885847766f6510426cc164a6eed) plus four changes:
--   1. A ticket line with no product (unmatched) is refused with BLEND_TICKET_PRODUCT_UNMATCHED
--      before any invoice number or row. Before, it billed $0 with no approval. The order path
--      already refuses it.
--   2. A product line billed inside a grower-share override goes on the invoice at $0 ("included
--      in grower share"). It now joins the $0 approval: admin only, with a written reason, listed
--      in the approval window, and recorded in below_cost_approvals by the line trigger. Before,
--      the line trigger refused it with no approval context, so such a ticket could not be invoiced.
--   3. The approval is bound to the lines it was shown: the caller sends back the zero_lines it
--      approved (line and product). If the $0 lines are different when it arrives (a re-pick or an
--      edited line in between), it is refused with BELOW_COST_APPROVAL_STALE and nothing is written.
--   4. The included-in-grower-share insert sets, and then clears, the below-cost context, exactly
--      as the $0 quoted line already does. Either insert gets the context only when its line (and
--      product) is one of the approved $0 lines; a line that became below cost after the check
--      fails closed in the line trigger. Each listed $0 line carries a 'kind' ('quoted_zero',
--      'grower_share' or 'quoted_zero_and_grower_share') so the window can say why it is $0.
--   5. The ticket's lines are locked (FOR UPDATE) with the ticket, so a direct line edit cannot
--      land between the $0 check and the billing loop.
--
-- actor-binding-check: exempt for create_invoice_from_blend_ticket, as in 20261020210000: its
--   body (the live body plus the changes above) binds p_created_by to auth.uid() ('p_created_by
--   does not match authenticated user') before any write.
--
-- DEPLOY ORDER: apply immediately before the merge (ship.md). Until the new screen loads, an
-- admin's $0 approval from the old screen is refused (BELOW_COST_APPROVAL_STALE, fails closed);
-- 0 unbilled tickets had a $0 quoted line on 2026-10-21. A product with no cost (or a cost that is
-- not whole cents) is still refused by the line trigger (COST_BASIS_REQUIRED), as before.
--
-- WHY: the three follow-ups reported when PR #982 shipped (each unverified then, verified here):
-- grower-share override tickets could not be invoiced; an unmatched line billed $0 with no
-- approval; a re-pick between the approval window and Approve billed lines the admin never saw.
--
-- LIVE STATE (read-only, 2026-10-21): 0 field_billing_defaults rows carry a price override, 0
-- invoice lines were ever "included in grower share", and 0 blend ticket lines (billed or not) lack
-- a product, so no existing ticket changes behaviour except through change 3.
--
-- NOT CHANGED: every other line of the body (the $0 pre-check is rewritten for change 2: its outer
-- quote-section test moved inside, unchanged in effect for $0 quoted lines); the line trigger; the
-- order path; the setter.
--   6. A retry key is now required (IDEMPOTENCY_KEY_REQUIRED, 22023): without one a lost reply could
--      not be replayed. The only caller (the Blend Ticket screen) always sends one.
--   7. An approval (a reason, a line list or both) when no line is $0 any more (a price changed in
--      between) is refused with BELOW_COST_APPROVAL_STALE instead of billing a price the window
--      never showed.
--   8. The job's quote section is locked (FOR UPDATE) and its items (FOR SHARE) before the $0
--      check, so a quote edit cannot change a price between the check and the billing loop.
--   9. An "included in grower share" chemical line records the chemical's catalog cost
--      (cost_cents) and adds it to the invoice's total_cost_cents; before, it recorded $0 cost,
--      overstating margin. The ticket's product rows are locked FOR SHARE before the $0 check, so
--      the catalog cost an approval is bound to cannot change before the line trigger records
--      it. Known and kept: a $0 QUOTED line (like every per-unit line, unchanged from the live
--      body) records the ticket line's cost copy (unit_cost_cents) when set, so its cost_cents
--      can differ from the catalog cost the approval showed (margin reporting only; follow-up).
--  10. Each approved line is bound to its kind and cost as well as its line and product: an
--      admin's detail lists each $0 line's cost_cents, the screen sends the lines back as shown,
--      and a change in cost or in why a line is $0 is refused as stale. A non-admin's detail
--      still carries no cost. Each line also carries a 'basis' (md5 of its rate per acre and rate
--      unit, the product's rate unit, inventory unit, unit size and form, and every field's acres
--      and per-acre price), so a change to the billed quantity or the grower-share charge while
--      the window is open is refused as stale too.
--  11. The invoice is dated with the Chicago business day ((now() AT TIME ZONE 'America/Chicago')
--      ::date) instead of CURRENT_DATE (the session's UTC date), so an evening invoice is not
--      dated tomorrow. A ticket with no season takes the season of that same Chicago date
--      (compute_season), for the invoice and for the application-rate lookup, instead of
--      current_season()'s UTC date.
--
-- ROLLBACK (if ever needed, as its own reviewed migration): drop the 5-argument function and
-- re-create the 4-argument one from 20261020210000 with the same grants.
--
-- ORDERING: after 20261020210000 (row 958), which this re-emits.

CREATE TEMP TABLE blend_invoice_approval_binding_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.blend_invoice_approval_binding_tx') IS NULL THEN
    RAISE EXCEPTION 'BLEND_INVOICE_APPROVAL_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.blend_invoice_approval_binding_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'BLEND_INVOICE_APPROVAL_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_invoice_from_blend_ticket') <> 1
     OR to_regprocedure('public.create_invoice_from_blend_ticket(uuid,uuid,text,text)') IS NULL
     OR md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.create_invoice_from_blend_ticket(uuid,uuid,text,text)')), chr(13), '')) IS DISTINCT FROM 'aae1f885847766f6510426cc164a6eed'
     OR pg_get_function_arguments(to_regprocedure('public.create_invoice_from_blend_ticket(uuid,uuid,text,text)'))
          IS DISTINCT FROM 'p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text, p_below_cost_reason text DEFAULT NULL::text' THEN
    RAISE EXCEPTION 'PREFLIGHT_BLEND_INVOICE_APPROVAL_BINDING_DRIFT: create_invoice_from_blend_ticket is not the reviewed 20261020210000 body';
  END IF;
  -- The line trigger the new context reaches, and the share helper the new pre-check reads.
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public._enforce_below_cost_line()')), chr(13), '')) IS DISTINCT FROM '1cc52a9746b192e649367a44e9d63020'
     OR md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.derive_customer_shares_from_fields(uuid[],jsonb)')), chr(13), '')) IS DISTINCT FROM '6c0dc7a1e2f43a7fad03e5a248cdd9bb'
     OR to_regprocedure('public._blend_quote_pick_valid_20261020(uuid,uuid,uuid,bigint)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_BLEND_INVOICE_APPROVAL_BINDING_DEPENDENCY_DRIFT';
  END IF;
  IF (SELECT count(*) FROM pg_constraint c
       WHERE c.conrelid = 'public.below_cost_approvals'::regclass
         AND c.conname = 'below_cost_approvals_operation_check'
         AND pg_get_constraintdef(c.oid) LIKE '%''create_invoice_from_blend_ticket''::text%') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_BLEND_INVOICE_APPROVAL_BINDING_OPERATION_CHECK';
  END IF;
END
$preflight$;

DROP FUNCTION public.create_invoice_from_blend_ticket(uuid, uuid, text, text);
CREATE FUNCTION public.create_invoice_from_blend_ticket(p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text, p_below_cost_reason text DEFAULT NULL::text, p_approved_zero_lines jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
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
  -- Goal 3 pricing (20261020210000)
  v_price_choices       jsonb;
  v_unpriced            text;
  v_zero_line           jsonb;
  v_zero_lines          jsonb;
  v_zero_quoted         boolean;
  -- Blend invoice approval binding (20261021070000)
  v_unmatched           int;
  v_zero_grower         boolean;
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

  -- 20261021070000: a retry key is required, so a lost reply can always be replayed instead of
  -- refused as already billed (the screen always sends one).
  IF NULLIF(btrim(COALESCE(p_idempotency_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_invoice_from_blend_ticket requires p_idempotency_key' USING ERRCODE = '22023';
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
  -- 20261021070000: hold the ticket's lines too, so a line edited between the $0 approval
  -- check below and the billing loop cannot bill something the approval never covered (the
  -- office policy lets staff update these rows directly).
  PERFORM 1 FROM blend_ticket_products btp WHERE btp.blend_ticket_id = p_blend_ticket_id FOR UPDATE;
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

  -- 20261021070000: every line must be a catalog product. A line with no product has no price or
  -- cost to check, so it billed $0 with no approval; refuse it, as the order path
  -- (create_order_from_blend_ticket) already does, before any invoice number or row.
  SELECT count(*) INTO v_unmatched
    FROM blend_ticket_products btp
   WHERE btp.blend_ticket_id = p_blend_ticket_id
     AND btp.product_id IS NULL;
  IF v_unmatched > 0 THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRODUCT_UNMATCHED: % line(s) are not matched to a product; match them before invoicing', v_unmatched;
  END IF;

  v_quote_section_id := NULL;
  IF v_ticket.job_id IS NOT NULL THEN
    SELECT j.quote_section_id INTO v_quote_section_id FROM jobs j WHERE j.id = v_ticket.job_id;
  END IF;
  -- Goal 3 pricing (20261020210000): a job pointed at another customer's quote, at a deleted
  -- quote, or at a section of a quote other than the job's own quote, supplies no quoted price (and
  -- no choices); the lines bill their tier prices instead.
  IF v_quote_section_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM quote_sections qs JOIN quotes q ON q.id = qs.quote_id
        WHERE qs.id = v_quote_section_id
          AND q.customer_id = v_ticket.customer_id
          AND q.deleted_at IS NULL
          AND q.id = (SELECT j.quote_id FROM jobs j WHERE j.id = v_ticket.job_id)) THEN
    v_quote_section_id := NULL;
  END IF;
  -- 20261021070000: hold the quote prices still until this invoice commits, so the $0 check
  -- below and the billing loop read the same prices (an approval covers only what it showed).
  IF v_quote_section_id IS NOT NULL THEN
    PERFORM 1 FROM quote_sections WHERE id = v_quote_section_id FOR UPDATE;
    PERFORM 1 FROM quote_items WHERE section_id = v_quote_section_id FOR SHARE;
  END IF;
  -- 20261021070000: hold the ticket's product costs still too (FOR SHARE, as the below-cost line
  -- trigger takes them; in id order), so the cost an approval was bound to is the cost billed.
  PERFORM 1 FROM products p
   WHERE p.id IN (SELECT btp.product_id FROM blend_ticket_products btp
                   WHERE btp.blend_ticket_id = p_blend_ticket_id AND btp.product_id IS NOT NULL)
   ORDER BY p.id
     FOR SHARE OF p;

  -- Goal 3 pricing (20261020210000), both before any invoice number or row:
  -- (1) The job's quote lists a product more than once at different prices. Taking one at
  --     random breaks "sent quotes keep their prices", so stop and hand the screen the choices;
  --     staff pick one with set_blend_ticket_product_quote_price, which stores it on the line.
  --     A stored pick counts only while it still matches a usable price on THIS job's quote for
  --     the line's CURRENT product and the ticket's customer (_blend_quote_pick_valid_20261020),
  --     so editing the product or the job asks again. Only usable quote prices count (finite,
  --     zero or above, whole cents), each price offered once, and only when some billed share is
  --     priced per unit (a line billed wholly inside grower-share overrides never uses it).
  IF v_quote_section_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
                  WHERE (r.value->>'price_override_cents') IS NULL
                    AND (r.value->>'share_acres')::numeric > 0) THEN
    SELECT jsonb_agg(jsonb_build_object(
             'blend_ticket_product_id', btp.id,
             'product_id', btp.product_id,
             'product_name', btp.product_name,
             'options', (
               SELECT jsonb_agg(jsonb_build_object(
                        'quote_item_id', o.id,
                        'price_cents', o.price_cents)
                      ORDER BY o.sort_order, o.id)
                 FROM (SELECT DISTINCT ON (ROUND(qi.price_per_unit * 100))
                              qi.id, qi.sort_order, ROUND(qi.price_per_unit * 100)::bigint AS price_cents
                         FROM quote_items qi
                        WHERE qi.section_id = v_quote_section_id
                          AND qi.product_id = btp.product_id
                          AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2)
                        ORDER BY ROUND(qi.price_per_unit * 100), qi.sort_order, qi.id) o))
           ORDER BY btp.sequence_order, btp.id)
      INTO v_price_choices
      FROM blend_ticket_products btp
     WHERE btp.blend_ticket_id = p_blend_ticket_id
       AND btp.product_id IS NOT NULL
       AND NOT public._blend_quote_pick_valid_20261020(
             v_quote_section_id, v_ticket.customer_id, btp.product_id, btp.unit_price_cents)
       AND (SELECT count(DISTINCT ROUND(qi.price_per_unit * 100))
              FROM quote_items qi
             WHERE qi.section_id = v_quote_section_id
               AND qi.product_id = btp.product_id
               AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2)) > 1;
    IF v_price_choices IS NOT NULL THEN
      RAISE EXCEPTION 'BLEND_TICKET_QUOTE_PRICE_CHOICE_REQUIRED: the quote lists a product more than once at different prices; pick the price to bill'
        USING DETAIL = jsonb_build_object('products', v_price_choices)::text;
    END IF;
  END IF;
  -- (2) A product billed at its tier price (no valid pick, no usable quote price) for a
  --     customer with a priced share uses that customer's tier price when it is above zero,
  --     otherwise the tier-1 price; a product with neither is refused instead of billed at $0.
  SELECT string_agg(DISTINCT COALESCE(btp.full_product_name, btp.product_name), ', ')
    INTO v_unpriced
    FROM (SELECT b.*, p.product_name AS full_product_name, p.tier1_price, p.tier2_price, p.tier3_price
            FROM blend_ticket_products b
            JOIN products p ON p.id = b.product_id
           WHERE b.blend_ticket_id = p_blend_ticket_id
             AND NOT public._blend_quote_pick_valid_20261020(
                   v_quote_section_id, v_ticket.customer_id, b.product_id, b.unit_price_cents)) btp
    CROSS JOIN LATERAL (
      SELECT DISTINCT COALESCE((c.value->>'tier')::int, 1) AS tier
        FROM jsonb_array_elements(v_customers) AS c(value)
       WHERE EXISTS (
         SELECT 1 FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
          WHERE (r.value->>'customer_id')::uuid = (c.value->>'customer_id')::uuid
            AND (r.value->>'price_override_cents') IS NULL
            AND (r.value->>'share_acres')::numeric > 0)
    ) cust
   WHERE NOT EXISTS (
           SELECT 1 FROM quote_items qi
            WHERE v_quote_section_id IS NOT NULL
              AND qi.section_id = v_quote_section_id
              AND qi.product_id = btp.product_id
              AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2))
     AND public._blend_tier_price_cents_20261020(cust.tier, btp.tier1_price, btp.tier2_price, btp.tier3_price) IS NULL;
  IF v_unpriced IS NOT NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRICE_MISSING: product(s) have no price on the price list: %', v_unpriced;
  END IF;
  -- (3) A product the job's quote lists at $0 bills at $0 (Mason, 2026-10-20: "$0 of $0 but
  --     flag it in system and alert before save"). A $0 line is below cost, so it goes through
  --     the below-cost wall: only an admin, with a written reason (p_below_cost_reason), and the
  --     line trigger records each approval in below_cost_approvals. This asks first, with the same
  --     error shape the trigger uses, so the screen shows its approval window before any invoice
  --     number is drawn. It finds the price exactly as the line pricing below does (a valid pick,
  --     else the first usable quote line), for a line some priced share will bill per unit.
  --     The detail names the first $0 line in the trigger's fields and lists EVERY $0 line in
  --     zero_lines (Mason, 2026-10-20: "list every $0 line"), so the approval window shows
  --     every line the one reason approves.
  --     (20261021070000) A product line billed inside a grower-share override goes on the
  --     invoice at $0 ("included in grower share": the per-acre override carries the price), so it
  --     is below cost too and takes the same approval. Before, it reached the line trigger with no
  --     approval context and was refused, so such a ticket could not be invoiced at all.
  --     The approval also names the exact lines it covers (p_approved_zero_lines: each line and
  --     product as the screen showed them). If the $0 lines changed in between (a re-pick, an
  --     edited line), nothing is invoiced and the screen asks again.
  SELECT jsonb_agg(jsonb_build_object(
           'line_id', z.id,
           'product_id', z.product_id,
           'product_name', z.product_name,
           'cost_cents', z.cost_cents,
           'kind', CASE WHEN z.quoted_zero AND z.in_grower_share THEN 'quoted_zero_and_grower_share'
                        WHEN z.quoted_zero THEN 'quoted_zero' ELSE 'grower_share' END,
           -- What sets this line's billed quantity and the grower-share charge: its rate and rate
           -- unit, the product's units and form (the quantity conversion), and every field's acres
           -- and per-acre price. The approval must send it back unchanged.
           'basis', md5(format('%L|%L|%L|%L|%L|%L|%L', z.rate_per_acre, z.rate_per_acre_unit,
                      z.p_rate_unit, z.p_inventory_unit, z.p_unit_size, z.p_product_form,
                      (SELECT string_agg(r.value::text, ',' ORDER BY r.value::text)
                         FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)))))
         ORDER BY z.sequence_order, z.id)
    INTO v_zero_lines
    FROM (SELECT y.*,
                 COALESCE(y.price_cents = 0
                          AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
                                       WHERE (r.value->>'price_override_cents') IS NULL
                                         AND (r.value->>'share_acres')::numeric > 0), false) AS quoted_zero,
                 EXISTS (SELECT 1 FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
                          WHERE (r.value->>'price_override_cents') IS NOT NULL
                            AND (r.value->>'share_acres')::numeric > 0) AS in_grower_share
            FROM (SELECT btp.id, btp.product_id, btp.sequence_order, btp.rate_per_acre, btp.rate_per_acre_unit,
                         p.rate_unit AS p_rate_unit, p.inventory_unit AS p_inventory_unit,
                         p.unit_size AS p_unit_size, p.product_form AS p_product_form,
                         COALESCE(p.product_name, btp.product_name) AS product_name,
                         ROUND(p.current_cost * 100)::bigint AS cost_cents,
                         CASE WHEN v_quote_section_id IS NULL THEN NULL
                              WHEN public._blend_quote_pick_valid_20261020(
                                     v_quote_section_id, v_ticket.customer_id, btp.product_id, btp.unit_price_cents)
                              THEN btp.unit_price_cents
                              ELSE (SELECT ROUND(qi.price_per_unit * 100)::bigint
                                      FROM quote_items qi
                                     WHERE qi.section_id = v_quote_section_id
                                       AND qi.product_id = btp.product_id
                                       AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2)
                                     ORDER BY qi.id LIMIT 1)
                         END AS price_cents
                    FROM blend_ticket_products btp
                    JOIN products p ON p.id = btp.product_id
                   WHERE btp.blend_ticket_id = p_blend_ticket_id
                     AND COALESCE(btp.rate_per_acre, 0) > 0
                     AND p.current_cost > 0 AND p.current_cost < 'Infinity'::numeric) y) z
   WHERE z.quoted_zero OR z.in_grower_share;
  IF v_zero_lines IS NOT NULL THEN
    v_zero_line := jsonb_build_object(
      'operation', 'create_invoice_from_blend_ticket',
      'entity_type', 'blend_ticket',
      'entity_id', p_blend_ticket_id,
      'line_id', v_zero_lines -> 0 -> 'line_id',
      'product_id', v_zero_lines -> 0 -> 'product_id',
      'product_name', v_zero_lines -> 0 -> 'product_name',
      'unit_price_cents', 0,
      'locked_unit_cost_cents', v_zero_lines -> 0 -> 'cost_cents',
      'zero_lines', v_zero_lines);
    IF NOT public.is_admin() THEN
      -- Cost is admin-only (Mason, 2026-10-15): a non-admin's detail never carries it.
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'BELOW_COST_ADMIN_REQUIRED:' || jsonb_set(v_zero_line - 'locked_unit_cost_cents', '{zero_lines}',
          (SELECT jsonb_agg(e.value - 'cost_cents' ORDER BY e.ord)
             FROM jsonb_array_elements(v_zero_lines) WITH ORDINALITY AS e(value, ord)))::text;
    END IF;
    IF NULLIF(btrim(COALESCE(p_below_cost_reason, '')), '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'BELOW_COST_REASON_REQUIRED:' || v_zero_line::text;
    END IF;
    IF jsonb_typeof(p_approved_zero_lines) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'BELOW_COST_APPROVAL_STALE:' || v_zero_line::text;
    END IF;
    -- Each approved line is bound to what the window showed for it: line, product, why it is $0
    -- (kind) and its cost; a change to any of them asks again.
    IF ARRAY(SELECT DISTINCT lower(e.value->>'line_id') || ':' || lower(e.value->>'product_id') || ':' || COALESCE(e.value->>'kind', '') || ':' || COALESCE(e.value->>'cost_cents', '') || ':' || COALESCE(e.value->>'basis', '')
               FROM jsonb_array_elements(p_approved_zero_lines) AS e(value) ORDER BY 1)
       IS DISTINCT FROM ARRAY(SELECT DISTINCT lower(e.value->>'line_id') || ':' || lower(e.value->>'product_id') || ':' || COALESCE(e.value->>'kind', '') || ':' || COALESCE(e.value->>'cost_cents', '') || ':' || COALESCE(e.value->>'basis', '')
               FROM jsonb_array_elements(v_zero_lines) AS e(value) ORDER BY 1) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'BELOW_COST_APPROVAL_STALE:' || v_zero_line::text;
    END IF;
  ELSIF p_approved_zero_lines IS NOT NULL OR NULLIF(btrim(COALESCE(p_below_cost_reason, '')), '') IS NOT NULL THEN
    -- An approval (a reason or a line list) arrived but no line is $0 any more (a price changed
    -- in between): bill nothing the window did not show; the screen asks again. The reason is
    -- only ever used for $0 lines, so nothing legitimate sends one here. No cost in this detail.
    RAISE EXCEPTION USING ERRCODE = 'P0001',
      MESSAGE = 'BELOW_COST_APPROVAL_STALE:' || jsonb_build_object(
        'operation', 'create_invoice_from_blend_ticket',
        'entity_type', 'blend_ticket',
        'entity_id', p_blend_ticket_id,
        'zero_lines', '[]'::jsonb)::text;
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
      COALESCE(v_ticket.season, public.compute_season((now() AT TIME ZONE 'America/Chicago')::date)),
      v_invoice_number, v_ticket.salesman_id, p_created_by,
      0, 0,
      (now() AT TIME ZONE 'America/Chicago')::date, v_invoice_group_id, v_ticket.application_service_id
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
        -- 20261021070000: the included line is $0, below cost; it carries the admin's reason (asked
        -- for above) to the line trigger, which re-checks it and records the approval. Only this
        -- insert gets the context.
        v_zero_grower := v_btp.product_id IS NOT NULL
                         AND COALESCE(v_zero_lines @> jsonb_build_array(jsonb_build_object('line_id', v_btp.id, 'product_id', v_btp.product_id)), false);
        IF v_zero_grower THEN
          PERFORM set_config('app.crx_below_cost_operation', 'create_invoice_from_blend_ticket', true);
          PERFORM set_config('app.crx_below_cost_reason', COALESCE(btrim(p_below_cost_reason), ''), true);
        END IF;
        -- 20261021070000: the chemical is billed inside the per-acre price, but it still costs
        -- money; record its catalog cost (locked above: the cost the approval showed and the line
        -- trigger records, not the ticket line's editable copy) so the invoice margin is right.
        v_unit_cost := ROUND(COALESCE(v_btp.product_cost, 0) * 100)::bigint;
        INSERT INTO invoice_items (
          invoice_id, product_id, description, quantity, unit_size,
          unit_price_cents, extended_cents, cost_cents,
          sort_order, rate_per_acre, rate_unit,
          is_application_fee, price_source
        ) VALUES (
          v_invoice_id, v_btp.product_id,
          COALESCE(v_btp.full_product_name, v_btp.product_name) || ' — included in grower share',
          ROUND(v_chem_qty_a_conv, 4), v_inv_unit_line,
          0, 0, v_unit_cost,
          v_btp.sequence_order, v_rate, v_rate_unit_line,
          false, 'manual'
        );
        IF v_zero_grower THEN
          PERFORM set_config('app.crx_below_cost_operation', '', true);
          PERFORM set_config('app.crx_below_cost_reason', '', true);
        END IF;
        v_invoice_cost := v_invoice_cost + safe_cents_qty(v_unit_cost, v_chem_qty_a_conv);
      END IF;

      IF v_chem_qty_b > 0 THEN
        v_unit_price   := NULL;
        v_quoted_price := NULL;
        v_price_source := NULL;

        -- Goal 3 pricing: a price staff picked from this job's quote bills as quoted, but only
        -- while it still matches the current quote, product and customer; a stale or hand-set
        -- value is ignored (the pre-checks above already asked again or tier-priced the line).
        IF public._blend_quote_pick_valid_20261020(
             v_quote_section_id, v_ticket.customer_id, v_btp.product_id, v_btp.unit_price_cents) THEN
          v_unit_price   := v_btp.unit_price_cents;
          v_quoted_price := v_unit_price;
          v_price_source := 'quoted';
        ELSIF v_quote_section_id IS NOT NULL AND v_btp.product_id IS NOT NULL THEN
          SELECT qi.price_per_unit INTO v_qi_price
            FROM quote_items qi
           WHERE qi.section_id = v_quote_section_id
             AND qi.product_id = v_btp.product_id
             AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2)
           ORDER BY qi.id LIMIT 1;
          IF v_qi_price IS NOT NULL THEN
            v_unit_price   := ROUND(v_qi_price * 100)::bigint;
            v_quoted_price := v_unit_price;
            v_price_source := 'quoted';
          END IF;
        END IF;

        IF v_unit_price IS NULL THEN
          IF v_btp.product_id IS NOT NULL THEN
            -- Goal 3 pricing: the tier price, else the tier-1 price, never a missing price as $0.
            v_unit_price := public._blend_tier_price_cents_20261020(
              v_customer_tier, v_btp.tier1_price, v_btp.tier2_price, v_btp.tier3_price);
            IF v_unit_price IS NULL THEN
              RAISE EXCEPTION 'BLEND_TICKET_PRICE_MISSING: product(s) have no price on the price list: %',
                COALESCE(v_btp.full_product_name, v_btp.product_name);
            END IF;
          ELSE
            v_unit_price := 0;
          END IF;
          IF v_price_source IS NULL THEN v_price_source := 'tier'; END IF;
        END IF;

        v_unit_cost := COALESCE(v_btp.unit_cost_cents,
                                ROUND(COALESCE(v_btp.product_cost, 0) * 100)::bigint, 0);
        v_extended := safe_cents_qty(v_unit_price, v_chem_qty_b_conv);
        -- Goal 3 pricing: a $0 quoted line carries the admin's below-cost reason to the line
        -- trigger, which re-checks it and records the approval. Only this line gets the context;
        -- every other line keeps the fail-closed default.
        v_zero_quoted := v_price_source = 'quoted' AND v_unit_price = 0 AND v_btp.product_id IS NOT NULL
                         AND COALESCE(v_zero_lines @> jsonb_build_array(jsonb_build_object('line_id', v_btp.id, 'product_id', v_btp.product_id)), false);
        IF v_zero_quoted THEN
          PERFORM set_config('app.crx_below_cost_operation', 'create_invoice_from_blend_ticket', true);
          PERFORM set_config('app.crx_below_cost_reason', COALESCE(btrim(p_below_cost_reason), ''), true);
        END IF;

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
        IF v_zero_quoted THEN
          PERFORM set_config('app.crx_below_cost_operation', '', true);
          PERFORM set_config('app.crx_below_cost_reason', '', true);
        END IF;
        v_invoice_total := v_invoice_total + v_extended;
        v_invoice_cost  := v_invoice_cost + safe_cents_qty(v_unit_cost, v_chem_qty_b_conv);
      END IF;
    END LOOP;

    IF v_has_app_service THEN
      SELECT car.rate_per_acre_cents INTO v_fee_rate
        FROM customer_application_rates car
       WHERE car.customer_id            = v_customer_id
         AND car.application_service_id = v_ticket.application_service_id
         AND car.season                 = COALESCE(v_ticket.season, public.compute_season((now() AT TIME ZONE 'America/Chicago')::date))
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

REVOKE ALL ON FUNCTION public.create_invoice_from_blend_ticket(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_from_blend_ticket(uuid, uuid, text, text, jsonb) TO authenticated, service_role;

DO $postflight$
DECLARE
  v_fn oid := to_regprocedure('public.create_invoice_from_blend_ticket(uuid,uuid,text,text,jsonb)');
BEGIN
  IF to_regclass('pg_temp.blend_invoice_approval_binding_tx') IS NULL THEN
    RAISE EXCEPTION 'BLEND_INVOICE_APPROVAL_BINDING_NOT_IN_TRANSACTION: stop: apply this file as one transaction';
  END IF;
  IF v_fn IS NULL
     OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'create_invoice_from_blend_ticket') <> 1
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM '51ee478f1fd43f2001647dff1d8d38e2'
     OR pg_get_function_arguments(v_fn) IS DISTINCT FROM 'p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text, p_below_cost_reason text DEFAULT NULL::text, p_approved_zero_lines jsonb DEFAULT NULL::jsonb'
     OR (SELECT proowner FROM pg_proc WHERE oid = v_fn) <> 'postgres'::regrole
     OR (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM true
     OR (SELECT prorettype FROM pg_proc WHERE oid = v_fn) <> 'jsonb'::regtype
     OR (SELECT proconfig FROM pg_proc WHERE oid = v_fn) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM pg_proc p, aclexplode(p.proacl) a
               WHERE p.oid = v_fn AND a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role'] THEN
    RAISE EXCEPTION 'POSTFLIGHT_BLEND_INVOICE_APPROVAL_BINDING_DRIFT: create_invoice_from_blend_ticket is not exactly as reviewed';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$postflight$;
