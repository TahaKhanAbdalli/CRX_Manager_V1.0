-- Written 2026-10-20. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- idempotency-body-check: exempt -- the only mutating function replaced here is the save_invoice
--   writer body, which keeps its own check_idempotency/save_idempotency unchanged; the new trigger
--   function only refuses.
--
-- WHAT: Goal 3 "Invoices made from scratch" (docs/plans/2026-10-13-direction-and-goals.md; Mason,
--   2026-10-14 decision 6e and 2026-10-15). An invoice made from scratch is a misc_charge or
--   chemical_sale invoice with NO order and NO delivery behind it. It carries no product lines,
--   only charge lines: staff pick a type (freight, application fee, service, other), then add a
--   description and a dollar amount, with no product, cost or tax.
--
--   1. invoice_items.charge_type (new, nullable text): freight | application_fee | service | other.
--      A charge line (charge_type set) has no product, no order line, no return-credit source,
--      a non-blank description, quantity exactly 1, cost 0, is not a field-application machine fee, and a positive amount
--      equal to its extended amount (CHECK invoice_items_charge_line_shape_chk). Existing rows all
--      have charge_type NULL, so both CHECKs validate instantly.
--   2. trg_refuse_from_scratch_invoice_product_lines on invoice_items (insert, or a change of
--      product_id / invoice_id / charge_type) and trg_refuse_from_scratch_invoice_product_lines_header on
--      invoices (a real change of invoice_type, order_id, delivery_id, status or deleted_at):
--      refuses FROM_SCRATCH_INVOICE_PRODUCT_LINE_REFUSED whenever a from-scratch invoice that is
--      not deleted, cancelled or voided would hold a product line. A line write locks its invoice
--      row (FOR SHARE) so it serializes with a concurrent header change. This covers
--      every create, edit and import path, direct table writes, and posting (single, group and
--      batch posting all flip invoices.status). SECURITY DEFINER so RLS can never hide the rows
--      it must see. Cancelled and voided invoices are left alone so they can always be closed.
--   2b. trg_type_from_scratch_invoice_charge_lines (BEFORE, invoice_items): a product-less, untyped
--      line written onto such an invoice by any writer other than save_invoice (today only
--      generate_finance_charges) is typed 'other', so the shape CHECK applies to it; the
--      after-write check also refuses an untyped line (FROM_SCRATCH_INVOICE_CHARGE_TYPE_REQUIRED).
--      So on every path such an invoice holds only typed, single-amount charge lines.
--   3. The save_invoice writer (_save_invoice_lineage_unaware_impl_20260827) stores charge_type,
--      zeroes a charge line's cost, and on a from-scratch invoice refuses a product line
--      (FROM_SCRATCH_INVOICE_PRODUCT_LINE_REFUSED) and an untyped line
--      (FROM_SCRATCH_INVOICE_CHARGE_TYPE_REQUIRED) before it touches the stored lines. Its body is
--      otherwise the live body unchanged (md5 pinned below, read live 2026-10-20).
--
-- "From scratch" means no order_id and no delivery_id, exactly the Goal 3 text. A blend_ticket_id
--   alone does not count as a source here (blend-ticket invoices are field_application; none of
--   type misc_charge or chemical_sale exist live). Naming an unrelated open order on a new
--   invoice through a direct save_invoice call is the order-level quantity cap's job (Goal 3
--   "Quantity caps"), not this file's.
--
-- NOT COVERED, by design (Goal 3 text): field-application invoices (direct field-app, blend-ticket
--   and job invoices, all invoice_type = 'field_application') keep their chemical lines; return
--   credit memos (credit_memo, issued only by issue_return_credit) keep their negative product
--   lines; every order- or delivery-backed invoice is unchanged. Finance charges
--   (generate_finance_charges) are from-scratch misc_charge invoices whose single line (no product,
--   quantity 1, no cost) is now typed 'other' on insert; the function itself is unchanged.
--
-- LIVE DATA (read 2026-10-20): no misc_charge invoice exists, and every chemical_sale invoice has
--   an order, so no stored row is from scratch and nothing live changes meaning.
--
-- CALLERS (every app caller of a function whose behaviour changes here, checked 2026-10-20):
-- caller-analysis: save_invoice :: InvoiceDetail.tsx; order-backed and field invoices unchanged, a from-scratch invoice now sends typed charge lines
-- caller-analysis: post_invoice, post_invoice_group, batch_post_invoices :: InvoiceDetail.tsx, Invoices.tsx, OfficeCockpit, OrderDetail; refused only for a from-scratch invoice holding a product line (none exist live)
--
-- ROLLBACK: revert the app first (its screens and PDFs select invoice_items.charge_type), then
--   DROP TRIGGER trg_refuse_from_scratch_invoice_product_lines ON public.invoice_items;
--   DROP TRIGGER trg_refuse_from_scratch_invoice_product_lines_header ON public.invoices;
--   DROP TRIGGER trg_type_from_scratch_invoice_charge_lines ON public.invoice_items;
--   DROP FUNCTION public._refuse_from_scratch_invoice_product_lines();
--   DROP FUNCTION public._type_from_scratch_invoice_charge_lines();
--   replay only the CREATE OR REPLACE FUNCTION _save_invoice_lineage_unaware_impl_20260827 block of
--   20260904180000_invoice_season_follows_invoice_date.sql (md5 e3fc9bd9c1da4b2eb8082e91781e4915;
--   not that whole file, whose own preflight and postflight belong to its run);
--   ALTER TABLE public.invoice_items DROP COLUMN charge_type (loses only the charge types).

-- PREFLIGHT: the writer must still be the body this file was written against, and no active
-- from-scratch invoice may already hold a product line. The lock (released at commit) keeps a
-- concurrent writer from adding one between this check and the triggers below.
LOCK TABLE public.invoices, public.invoice_items IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public._save_invoice_lineage_unaware_impl_20260827(jsonb,jsonb,text)');
  IF v_md5 IS DISTINCT FROM 'e3fc9bd9c1da4b2eb8082e91781e4915' THEN
    RAISE EXCEPTION 'PREFLIGHT: _save_invoice_lineage_unaware_impl_20260827 body drifted (md5 %), re-read it before applying', v_md5;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'invoice_items' AND column_name = 'charge_type'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: invoice_items.charge_type already exists';
  END IF;
  -- The triggers below judge each later write against the whole invoice; an invoice that already
  -- breaks the rule would make every later write to it fail, so refuse to apply over one.
  IF EXISTS (
    SELECT 1
      FROM public.invoices i
      JOIN public.invoice_items ii ON ii.invoice_id = i.id
     WHERE i.invoice_type IN ('misc_charge', 'chemical_sale')
       AND i.order_id IS NULL
       AND i.delivery_id IS NULL
       AND i.deleted_at IS NULL
       AND i.status NOT IN ('cancelled', 'voided')
       AND ii.product_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: an active invoice with no order or delivery already holds a product line; resolve it before applying';
  END IF;
  -- charge_type does not exist yet, so every product-less line on such an invoice would be untyped
  -- (a finance charge made since the 2026-10-20 read, for example); type them first.
  IF EXISTS (
    SELECT 1
      FROM public.invoices i
      JOIN public.invoice_items ii ON ii.invoice_id = i.id
     WHERE i.invoice_type IN ('misc_charge', 'chemical_sale')
       AND i.order_id IS NULL
       AND i.delivery_id IS NULL
       AND i.deleted_at IS NULL
       AND i.status NOT IN ('cancelled', 'voided')
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: an active invoice with no order or delivery already holds lines that would be untyped; re-read live data and add a typing step before applying';
  END IF;
END
$preflight$;

-- 1. The charge line.
ALTER TABLE public.invoice_items ADD COLUMN charge_type text;

COMMENT ON COLUMN public.invoice_items.charge_type IS
  'Charge line type (Goal 3, Mason 2026-10-15): freight, application_fee, service or other. Set only on a charge line: no product, a description, quantity 1, cost 0, positive amount. save_invoice requires one on every line of an invoice made from scratch (misc_charge or chemical_sale with no order and no delivery); the database refuses a product line on such an invoice on every path.';

ALTER TABLE public.invoice_items
  ADD CONSTRAINT invoice_items_charge_type_check
  CHECK (charge_type IS NULL OR charge_type IN ('freight', 'application_fee', 'service', 'other'));

ALTER TABLE public.invoice_items
  ADD CONSTRAINT invoice_items_charge_line_shape_chk
  CHECK (
    charge_type IS NULL
    OR (
      product_id IS NULL
      AND order_item_id IS NULL
      AND return_credit_source_item_id IS NULL
      AND description ~ '[^[:space:]]'  -- any real character; one-argument btrim strips spaces only, not tabs or newlines
      AND quantity = 1
      AND cost_cents = 0
      AND is_application_fee IS NOT TRUE
      AND unit_price_cents > 0
      AND extended_cents = unit_price_cents
    )
  );

-- 2. No product line on an active invoice made from scratch, on any path.
CREATE FUNCTION public._refuse_from_scratch_invoice_product_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_invoice_id uuid;
BEGIN
  -- Fired from invoices (the header) or invoice_items (a line); NEW has a different shape on each.
  IF TG_TABLE_NAME = 'invoices' THEN
    v_invoice_id := NEW.id;
  ELSE
    v_invoice_id := NEW.invoice_id;
    -- Serialize with a concurrent header change (a restore, a status or order change): a line
    -- write holds the invoice row, so the header trigger of the other transaction runs after this
    -- one commits and sees this line, or this check runs after that change and sees it. The
    -- foreign key's KEY SHARE lock does not conflict with a header UPDATE, so lock explicitly.
    PERFORM 1 FROM public.invoices WHERE id = v_invoice_id FOR SHARE;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.invoices i
     WHERE i.id = v_invoice_id
       AND i.invoice_type IN ('misc_charge', 'chemical_sale')
       AND i.order_id IS NULL
       AND i.delivery_id IS NULL
       AND i.deleted_at IS NULL
       AND i.status NOT IN ('cancelled', 'voided')
       AND EXISTS (
         SELECT 1 FROM public.invoice_items ii
          WHERE ii.invoice_id = i.id
            AND ii.product_id IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'FROM_SCRATCH_INVOICE_PRODUCT_LINE_REFUSED: an invoice with no order or delivery cannot carry product lines; sell product through an order or a quick delivery'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.invoices i
      JOIN public.invoice_items ii ON ii.invoice_id = i.id
     WHERE i.id = v_invoice_id
       AND i.invoice_type IN ('misc_charge', 'chemical_sale')
       AND i.order_id IS NULL
       AND i.delivery_id IS NULL
       AND i.deleted_at IS NULL
       AND i.status NOT IN ('cancelled', 'voided')
       AND ii.charge_type IS NULL
  ) THEN
    RAISE EXCEPTION 'FROM_SCRATCH_INVOICE_CHARGE_TYPE_REQUIRED: every line on an invoice with no order or delivery must be a charge line with a type (freight, application fee, service, other)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public._refuse_from_scratch_invoice_product_lines() FROM PUBLIC, anon, authenticated, service_role;

-- charge_type is listed too: clearing a line's type on a soft-deleted invoice while another
-- transaction restores it must take the same invoice lock and recheck, or both commit and leave an
-- active from-scratch invoice holding an untyped line (Codex connector P2 on PR #983).
CREATE TRIGGER trg_refuse_from_scratch_invoice_product_lines
  AFTER INSERT OR UPDATE OF product_id, invoice_id, charge_type ON public.invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION public._refuse_from_scratch_invoice_product_lines();

CREATE TRIGGER trg_refuse_from_scratch_invoice_product_lines_header
  AFTER UPDATE OF invoice_type, order_id, delivery_id, status, deleted_at ON public.invoices
  FOR EACH ROW
  -- Only on a real change: save_invoice's header UPDATE names invoice_type even when it keeps it,
  -- and must not be refused before it replaces an old product line with charge lines.
  WHEN (
    NEW.status NOT IN ('cancelled', 'voided')
    AND NEW.deleted_at IS NULL
    AND (OLD.invoice_type, OLD.order_id, OLD.delivery_id, OLD.status, OLD.deleted_at)
        IS DISTINCT FROM (NEW.invoice_type, NEW.order_id, NEW.delivery_id, NEW.status, NEW.deleted_at)
  )
  EXECUTE FUNCTION public._refuse_from_scratch_invoice_product_lines();

-- 2b. Every product-less line on a from-scratch invoice is a typed charge line, on every path.
-- save_invoice refuses an untyped line outright (below); any other writer (generate_finance_charges
-- is the one today) gets its line typed 'other', and invoice_items_charge_line_shape_chk then
-- refuses a line that is not a single charge (quantity 1, no cost, not a machine fee, a positive
-- amount, a description), so an untyped line can never carry a quantity-times-price sale.
CREATE FUNCTION public._type_from_scratch_invoice_charge_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.product_id IS NULL
     AND NEW.charge_type IS NULL
     AND EXISTS (
       SELECT 1
         FROM public.invoices i
        WHERE i.id = NEW.invoice_id
          AND i.invoice_type IN ('misc_charge', 'chemical_sale')
          AND i.order_id IS NULL
          AND i.delivery_id IS NULL
          AND i.deleted_at IS NULL
          AND i.status NOT IN ('cancelled', 'voided')
     ) THEN
    NEW.charge_type := 'other';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public._type_from_scratch_invoice_charge_lines() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_type_from_scratch_invoice_charge_lines
  BEFORE INSERT OR UPDATE OF product_id, charge_type ON public.invoice_items
  FOR EACH ROW
  EXECUTE FUNCTION public._type_from_scratch_invoice_charge_lines();

-- 3. The save_invoice writer: the live body plus charge lines (search "Goal 3").
CREATE OR REPLACE FUNCTION public._save_invoice_lineage_unaware_impl_20260827(p_invoice jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_invoice_id uuid; v_is_new boolean := false; v_item jsonb;
  v_total_cents bigint := 0; v_qty numeric; v_unit_price bigint; v_extended bigint;
  v_cost_cents bigint; v_product record; v_order_id uuid; v_blend_id uuid; v_existing jsonb;
  v_total_cost bigint := 0;
  v_is_field boolean := false;
  v_is_fee boolean;
  v_from_scratch boolean := false;  -- Goal 3 (20261021050000)
  v_charge_type text;               -- Goal 3 (20261021050000)
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to save invoices';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_invoice');
    IF v_existing IS NOT NULL THEN RETURN (v_existing->>'invoice_id')::uuid; END IF;
  END IF;

  v_invoice_id := (p_invoice->>'id')::uuid;
  v_order_id := (p_invoice->>'order_id')::uuid;
  v_blend_id := (p_invoice->>'blend_ticket_id')::uuid;

  IF v_invoice_id IS NULL THEN
    -- PARKED-002 (codex-driven cycle 1 #1 MED): credit memos must come exclusively
    -- from issue_return_credit (the ONLY caller that derives the credit from a
    -- 'received' return and gates on check_period_open). save_invoice's NEW-invoice
    -- branch otherwise allows an admin/sales-rep to forge a posted credit memo by
    -- riding on the enforce_invoice_draft_on_insert credit_memo exemption. Reject
    -- BEFORE the order/blend check so the error surfaced is the intent-mismatch one.
    IF (p_invoice->>'invoice_type') = 'credit_memo' THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;
    -- Manual miscellaneous charges are the one controlled orderless invoice
    -- type. Chemical sales still require a source order/blend ticket.
    IF v_order_id IS NULL
       AND v_blend_id IS NULL
       AND COALESCE(NULLIF(p_invoice->>'invoice_type', ''), 'chemical_sale') <> 'misc_charge' THEN
      RAISE EXCEPTION 'Invoices must link to an order or blend ticket. Provide order_id or blend_ticket_id in p_invoice payload.';
    END IF;
    IF COALESCE(NULLIF(p_invoice->>'invoice_type', ''), 'chemical_sale') = 'misc_charge'
       AND COALESCE(NULLIF(p_invoice->>'status', ''), 'draft') <> 'draft' THEN
      RAISE EXCEPTION 'MISC_CHARGE_MUST_START_DRAFT: orderless miscellaneous charges must be reviewed before posting';
    END IF;
    v_is_new := true;
    INSERT INTO invoices (order_id, blend_ticket_id, customer_id, invoice_type, status, season, salesman_id,
      invoice_date, due_date, payment_terms, purchase_order_ref, header_notes, footer_notes, total_amount_cents, created_by)
    VALUES (v_order_id, v_blend_id, (p_invoice->>'customer_id')::uuid,
      COALESCE(p_invoice->>'invoice_type', 'chemical_sale'),
      COALESCE(p_invoice->>'status', 'draft'),
      -- Season follows the SAME date this row is stamped with (2026-09-04). It previously read
      -- the current-season helper, which is compute_season of the UTC current-date built-in --
      -- an INDEPENDENT clock read of the UTC calendar day. From 7 pm America/Chicago on 2026-09-30
      -- the helper returns 2027 while the line below stamps invoice_date 2026-09-30 (season 2026),
      -- and season drives customer_application_rates lookups and year-end statements.
      -- A caller-supplied season still wins; only the fallback changes. This is the INSERT path:
      -- the UPDATE path below still keeps whatever season the row already carries.
      COALESCE((p_invoice->>'season')::int,
               compute_season(COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date))),
      (p_invoice->>'salesman_id')::uuid,
      COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date),  -- fallback is the America/Chicago business date, never UTC (2026-09-03)
      (p_invoice->>'due_date')::date,
      NULLIF(btrim(COALESCE(p_invoice->>'payment_terms', '')), ''),
      p_invoice->>'purchase_order_ref',
      p_invoice->>'header_notes',
      p_invoice->>'footer_notes',
      0, v_actor) RETURNING id INTO v_invoice_id;
  ELSE
    -- An orderless miscellaneous charge must remain a miscellaneous charge.
    -- The edit payload does not carry source IDs, so enforce this against the
    -- stored invoice rather than trusting the client to keep the type locked.
    IF EXISTS (
      SELECT 1
       FROM invoices
       WHERE id = v_invoice_id
         AND invoice_type = 'misc_charge'
         AND order_id IS NULL
         AND blend_ticket_id IS NULL
         AND COALESCE(NULLIF(p_invoice->>'invoice_type', ''), invoice_type) <> 'misc_charge'
    ) THEN
      RAISE EXCEPTION 'ORDERLESS_INVOICE_TYPE_LOCKED: an orderless miscellaneous charge cannot be reclassified';
    END IF;

    -- PARKED-002 (Codex r3): EXPLICIT pre-UPDATE guard on the credit_memo boundary.
    -- A silent CASE-keep would swallow an attempted chemical_sale -> credit_memo flip
    -- (other payload fields still save) so the caller never sees the rejection. Fail
    -- LOUDLY with CREDIT_MEMO_VIA_SAVE_INVOICE whenever OLD or NEW crosses 'credit_memo'.
    -- Mirrors how enforce_field_application_type_lock errors on its boundary cross,
    -- except this is RPC-side because credit_memo is born 'posted' and the trigger only
    -- fires on UPDATE OF invoice_type (a posted credit_memo never gets here at all).
    -- PARKED-002 (Codex r4): drop the status filter — surface the boundary cross even
    -- when the target invoice is posted/voided/etc. The existing post-UPDATE
    -- "NOT EXISTS ... status IN ('draft','unposted')" path would otherwise silently
    -- no-op a posted-invoice credit_memo attempt; the caller deserves a clear error.
    IF EXISTS (
      SELECT 1 FROM invoices
       WHERE id = v_invoice_id
         AND (
              invoice_type = 'credit_memo'
           OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
         )
         AND invoice_type IS DISTINCT FROM COALESCE(p_invoice->>'invoice_type', invoice_type)
    ) THEN
      RAISE EXCEPTION 'CREDIT_MEMO_VIA_SAVE_INVOICE: credit memos can only be created via issue_return_credit (from a received Return)';
    END IF;

    UPDATE invoices SET
      customer_id = CASE WHEN invoice_type = 'field_application'
                         THEN customer_id
                         ELSE COALESCE((p_invoice->>'customer_id')::uuid, customer_id) END,
      -- PARKED-002 (Codex r2): symmetric lock — credit_memo is a SEGREGATION boundary like
      -- field_application. The pre-UPDATE guard above ALREADY rejected any cross-boundary
      -- attempt with CREDIT_MEMO_VIA_SAVE_INVOICE; this CASE is the second-line invariant
      -- so a bug in the guard can't silently let the column flip. Stacks on top of DELTA-F.
      invoice_type = CASE
        WHEN invoice_type = 'field_application'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'field_application'
        THEN invoice_type
        WHEN invoice_type = 'credit_memo'
          OR COALESCE(p_invoice->>'invoice_type', invoice_type) = 'credit_memo'
        THEN invoice_type
        ELSE COALESCE(p_invoice->>'invoice_type', invoice_type) END,
      season = COALESCE((p_invoice->>'season')::int, season),
      salesman_id = (p_invoice->>'salesman_id')::uuid,
      invoice_date = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
      due_date = CASE WHEN p_invoice ? 'due_date' THEN (p_invoice->>'due_date')::date ELSE due_date END,
      payment_terms = CASE WHEN p_invoice ? 'payment_terms' THEN NULLIF(btrim(p_invoice->>'payment_terms'), '') ELSE payment_terms END,
      purchase_order_ref = p_invoice->>'purchase_order_ref',
      header_notes = p_invoice->>'header_notes',
      footer_notes = p_invoice->>'footer_notes',
      updated_at = now()
    WHERE id = v_invoice_id AND status IN ('draft', 'unposted');
  END IF;

  IF NOT v_is_new THEN
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = v_invoice_id AND status IN ('draft', 'unposted')) THEN
      IF p_idempotency_key IS NOT NULL THEN
        PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'no_op', true));
      END IF;
      RETURN v_invoice_id;
    END IF;
  END IF;

  v_is_field := (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application';

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE v_share_n int; v_has_ovr boolean;
    BEGIN
      SELECT count(*), COALESCE(bool_or(price_per_acre_cents IS NOT NULL), false)
        INTO v_share_n, v_has_ovr
        FROM invoice_shares WHERE invoice_id = v_invoice_id;
      IF v_share_n > 1 OR v_has_ovr THEN
        RAISE EXCEPTION 'FIELD_INVOICE_SPLIT_LOCKED: this field invoice is split across growers (or has a fixed-price grower) — void and reissue to change it';
      END IF;
    END;
  END IF;

  -- Goal 3 (Mason, 2026-10-14 6e; 2026-10-15): an invoice made from scratch -- a misc_charge or
  -- chemical_sale invoice with no order and no delivery behind it -- carries no product lines.
  -- Each of its lines is a typed charge line (freight, application fee, service, other) with a
  -- description and an amount. Judged on the stored row after the header write above, so a new
  -- and an edited invoice are treated alike. The invoice_items trigger
  -- trg_refuse_from_scratch_invoice_product_lines enforces the product half on every other path.
  SELECT i.invoice_type IN ('misc_charge', 'chemical_sale')
         AND i.order_id IS NULL
         AND i.delivery_id IS NULL
    INTO v_from_scratch
    FROM invoices i
   WHERE i.id = v_invoice_id;
  IF v_from_scratch THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_items) AS line(item)
       WHERE NULLIF(btrim(line.item->>'product_id'), '') IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'FROM_SCRATCH_INVOICE_PRODUCT_LINE_REFUSED: an invoice with no order or delivery cannot carry product lines; sell product through an order or a quick delivery'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_items) AS line(item)
       WHERE NULLIF(btrim(line.item->>'charge_type'), '') IS NULL
    ) THEN
      RAISE EXCEPTION 'FROM_SCRATCH_INVOICE_CHARGE_TYPE_REQUIRED: every line on an invoice with no order or delivery must be a charge line with a type (freight, application fee, service, other)'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  DELETE FROM invoice_items WHERE invoice_id = v_invoice_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    v_qty := COALESCE((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'Invoice line item quantity must be greater than zero'; END IF;
    v_unit_price := COALESCE((v_item->>'unit_price_cents')::bigint, 0);
    v_is_fee := COALESCE((v_item->>'is_application_fee')::boolean, false) AND (v_item->>'product_id') IS NULL;
    v_extended := ROUND(v_qty * v_unit_price)::bigint;
    IF v_is_fee
       AND (v_item->>'extended_cents') IS NOT NULL
       AND ABS((v_item->>'extended_cents')::bigint - v_extended) <= CEIL(v_qty)::bigint + 1 THEN
      v_extended := (v_item->>'extended_cents')::bigint;
    END IF;
    v_cost_cents := COALESCE((v_item->>'cost_cents')::bigint, 0);
    IF (v_item->>'product_id') IS NOT NULL AND NOT v_is_field THEN
      SELECT * INTO v_product FROM products WHERE id = (v_item->>'product_id')::uuid;
      IF FOUND AND v_product.current_cost IS NOT NULL THEN
        v_cost_cents := (v_product.current_cost * 100)::bigint;
      END IF;
    END IF;
    -- A charge line carries no cost (Mason, 2026-10-15); the shape CHECK refuses anything else.
    v_charge_type := NULLIF(btrim(v_item->>'charge_type'), '');
    IF v_charge_type IS NOT NULL THEN
      v_cost_cents := 0;
    END IF;
    INSERT INTO invoice_items (invoice_id, product_id, description, quantity, unit_price_cents, extended_cents,
      cost_cents, sort_order, rate_per_acre, acres, unit_size, notes,
      rate_unit, is_application_fee, total_applied, total_applied_unit,
      total_applied_gl_lb, gl_lb_unit, epa_registration, product_form,
      price_source, quoted_price_cents, charge_type)
    VALUES (v_invoice_id, (v_item->>'product_id')::uuid,
      COALESCE(v_item->>'description', ''),
      v_qty, v_unit_price, v_extended, v_cost_cents,
      COALESCE((v_item->>'sort_order')::int, 0),
      (v_item->>'rate_per_acre')::numeric, (v_item->>'acres')::numeric,
      v_item->>'unit_size', v_item->>'notes',
      v_item->>'rate_unit',
      v_is_fee,
      (v_item->>'total_applied')::numeric,
      v_item->>'total_applied_unit',
      (v_item->>'total_applied_gl_lb')::numeric,
      v_item->>'gl_lb_unit',
      v_item->>'epa_registration',
      v_item->>'product_form',
      CASE WHEN v_item->>'price_source' IN ('quoted','tier','manual') THEN v_item->>'price_source' ELSE NULL END,
      (v_item->>'quoted_price_cents')::bigint,
      v_charge_type);
    v_total_cents := v_total_cents + v_extended;
    v_total_cost := v_total_cost + CASE
      WHEN v_is_fee THEN v_cost_cents
      ELSE ROUND(v_cost_cents * v_qty)::bigint END;
  END LOOP;

  UPDATE invoices SET total_amount_cents = v_total_cents,
    total_cost_cents = CASE WHEN invoice_type = 'field_application' THEN v_total_cost ELSE total_cost_cents END,
    updated_at = now()
  WHERE id = v_invoice_id AND status IN ('draft', 'unposted');

  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    WITH s AS (
      SELECT id, COALESCE(amount_cents, 0) AS amount_cents,
             row_number() OVER (ORDER BY is_primary DESC, sort_order, id) AS rn,
             SUM(COALESCE(amount_cents, 0)) OVER () AS tot
      FROM invoice_shares WHERE invoice_id = v_invoice_id
    ),
    alloc AS (
      SELECT id, rn,
             CASE WHEN tot > 0 THEN ROUND(v_total_cents * amount_cents / tot)::bigint
                  WHEN rn = 1 THEN v_total_cents ELSE 0 END AS part
      FROM s
    ),
    recon AS (
      SELECT id, rn, part, v_total_cents - COALESCE(SUM(part) OVER (), 0) AS rem
      FROM alloc
    )
    UPDATE invoice_shares isr
       SET amount_cents = r.part + CASE WHEN r.rn = 1 THEN r.rem ELSE 0 END
      FROM recon r WHERE isr.id = r.id;
  END IF;

  -- U8<<< (Codex R2 P1): a job-born field_application invoice stays editable while
  -- draft/unposted, and the items rewrite above changes chemical-line profit without
  -- touching the pending job commissions minted at transfer time. Recompute them from
  -- the just-written lines — the exact mirror of update_order_items' commission-
  -- recompute-on-edit (20260617040000), including its batch-freeze guard. Scoped by
  -- commissions.invoice_id (generation-precise): order-channel rows and other
  -- generations are untouched, and a non-job invoice simply matches zero rows.
  IF (SELECT invoice_type FROM invoices WHERE id = v_invoice_id) = 'field_application' THEN
    DECLARE
      v_u8_profit numeric;
    BEGIN
      -- Codex R6 P2: an edit while any of this generation's pending commissions sit
      -- in an active payout batch would leave that batch stale (post_commission_payment
      -- pays the OLD amount) — block, mirroring the reversal paths' guard.
      IF EXISTS (
        SELECT 1 FROM commissions c
        JOIN commission_payment_items cpi ON cpi.commission_id = c.id
        JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL
          AND c.status = 'pending' AND cp.status <> 'voided'
      ) THEN
        RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this invoice''s pending commissions are in an active payout batch — void that commission payment before editing';
      END IF;
      -- Codex R7 P1: commissions already PAID against this still-unposted invoice
      -- must also block the edit — the recompute below only touches pending rows,
      -- so an edit would silently strand the paid ledger on the old profit. Fully
      -- recoverable: void the commission payment (rows reset to pending because
      -- this invoice is live), edit, then re-batch.
      IF EXISTS (
        SELECT 1 FROM commissions c
        WHERE c.invoice_id = v_invoice_id AND c.job_id IS NOT NULL AND c.status = 'paid'
      ) THEN
        RAISE EXCEPTION 'JOB_COMMISSIONS_PAID: this invoice''s commissions were already paid out — void that commission payment before editing the invoice';
      END IF;

      -- Codex R6 P2: COGS per line is cost_cents × quantity (save_invoice stores
      -- per-unit cost — the SAME math its own v_total_cost uses); transfer-minted
      -- lines carry quantity=1 with line-total cost, so ×1 is identical there.
      SELECT COALESCE(SUM(COALESCE(ii.extended_cents, 0) - ROUND(COALESCE(ii.cost_cents, 0) * COALESCE(ii.quantity, 1))::bigint), 0)::numeric / 100.0
        INTO v_u8_profit
      FROM invoice_items ii
      WHERE ii.invoice_id = v_invoice_id
        AND COALESCE(ii.is_application_fee, false) = false
        AND ii.product_id IS NOT NULL;

      UPDATE commissions c
         SET order_profit      = ROUND(COALESCE(v_u8_profit, 0), 2),
             commission_amount = calc.new_amount
        FROM (
          SELECT x.id,
                 -- Codex R5 P2: mirror the mint's last-row penny reconciliation so the
                 -- recomputed rows sum EXACTLY to the rounded profit (a 33.33/33.33/33.34
                 -- split of $0.02 must not round up to $0.03). Only safe when the eligible
                 -- pending rows ARE the whole generation (x.cnt = x.cnt_all, and cnt_all
                 -- counts EVERY non-deleted row of the generation regardless of status —
                 -- drift-review R6 H1: a sibling already PAID via a posted batch must
                 -- force the per-row fallback, or the last pending row would absorb the
                 -- paid recipient's entire share, not a penny). The mixed case keeps the
                 -- per-row math (update_order_items parity).
                 CASE WHEN x.rn = x.cnt AND x.cnt = x.cnt_all THEN
                     GREATEST(ROUND(COALESCE(v_u8_profit, 0), 2), 0)
                     - COALESCE(SUM(compute_commission_amount(v_u8_profit, x.split_percentage))
                         OVER (ORDER BY x.rn ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
                   ELSE compute_commission_amount(v_u8_profit, x.split_percentage)
                 END AS new_amount
          FROM (
            SELECT c2.id, c2.split_percentage,
                   row_number() OVER (ORDER BY c2.id) AS rn,
                   count(*) OVER () AS cnt,
                   (SELECT count(*) FROM commissions c3
                     WHERE c3.invoice_id = v_invoice_id AND c3.job_id IS NOT NULL
                       AND c3.deleted_at IS NULL) AS cnt_all
            FROM commissions c2
            WHERE c2.invoice_id = v_invoice_id
              AND c2.job_id IS NOT NULL
              AND c2.status = 'pending'
              AND c2.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM commission_payment_items cpi
                JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
                WHERE cpi.commission_id = c2.id AND cp.status <> 'voided'
              )
          ) x
        ) calc
       WHERE c.id = calc.id;
    END;
  END IF;
  -- >>>U8

  IF v_is_new THEN
    INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
    VALUES ('invoice_created',
      'Invoice ' || (SELECT invoice_number FROM invoices WHERE id = v_invoice_id) || ' created',
      v_actor, 'invoice', v_invoice_id, (p_invoice->>'customer_id')::uuid);
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_invoice', jsonb_build_object('invoice_id', v_invoice_id, 'is_new', v_is_new));
  END IF;

  RETURN v_invoice_id;
END;
$function$;

