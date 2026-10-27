-- Written 2026-10-26. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- idempotency-body-check: exempt -- get_last_charged_prices is a read (STABLE, writes nothing). The
--   trigger function only fills a column on the row being inserted and is callable by no API role.
--
-- WHAT: "What did we charge this customer before?" in the quote screen (To-Do 0.3, pricing plan
--   slice 3). Mason, 2026-10-14: sales reps "should see the last price we charged this customer";
--   price history itself stays admin-only.
--
--   1. price_tier_at_sale on order_items and invoice_items (smallint 1-3, nullable). The tier a line
--      was sold at was never stored, and customers.assigned_tier can change later, so a BEFORE INSERT
--      trigger stamps it on every new product line, whichever function writes it:
--        order line   -> the tier of the quote its quote line came from, else the order
--                        customer's assigned tier at that moment (a product added to a quote's
--                        order later is priced at the customer's tier);
--        invoice line -> billed from an order line: that line's stamped tier, else (an order line
--                        from before this file) its quote line's tier, else unknown -- never today's
--                        customer tier; not from an order line: the invoice customer's tier.
--      A value a writer sends is replaced: the database always decides. Charge lines (no product)
--      and return credits stay NULL.
--      The invoice editor's save re-inserts lines without their order link and restores it with an
--      UPDATE, so the trigger also fires on UPDATE OF order_item_id and then re-takes the order
--      line's tier. A line with no order link is re-stamped at the customer's tier on each save.
--      The tier says which tier was in effect, not that the price came from it (manual prices exist).
--      Existing rows are NOT backfilled: their tier at sale is unknown and the screen says so.
--      Both tables use column-level grants since the cost lock (20261022101000), and the house rule
--      (src/lib/costFields.test.ts) gives every new non-cost column the table's read grants: SELECT
--      and REFERENCES to authenticated, SELECT to anon; row-level security still decides which rows.
--      No write grant. The tier is not cost data (it is the customer's tier, already readable).
--
--   2. NEW get_last_charged_prices(p_customer_id, p_product_ids), admin or sales rep (active). For
--      each asked product, the latest charge to that customer: unit price in whole cents, the unit
--      size that line was sold in, tier at sale (NULL = unknown), the date and whether it came from
--      an invoice or an order. Nothing else:
--      no document number, quantity, cost, margin or salesperson. It deliberately reads across reps
--      (SECURITY DEFINER): invoice_items_select lets a rep see only invoices they created or are the
--      salesperson on, so a customer last billed by another rep would otherwise show blank.
--
--      What counts as a charge (plan slice 3 asks this file to define it):
--        - an invoice product line on a posted, paid or overdue chemical-sale or field-application
--          invoice billed to the customer, not deleted, not voided, not awaiting pricing, quantity
--          and price above 0. Draft, unposted, cancelled and voided invoices do not count, nor do
--          credit memos or misc-charge invoices. Return-credit lines, charge-only lines, application
--          fees and $0 no-charge lines do not count. An invoice made from a spray job
--          (transfer_job_to_invoice: job_id set, no billing set) does not count: it stores each
--          chemical as quantity 1 at the line total. Date: invoice_date.
--        - an order product line on a confirmed, partly delivered or delivered order for the
--          customer, not deleted, priced (not "needs pricing", line not pricing-pending, price above
--          0), units above 0, that no counted invoice line bills. Cancelled and voided orders do not
--          count. An order
--          is the agreed price the customer will be billed, and almost all of 2026 was billed outside
--          CRX, so without orders the panel would be empty until January. Date: order_date.
--        - quotes never count: an unaccepted quote is not a charge (plan section 2, item 3).
--      Credits and returns do not change the price we charged, so they are left out rather than
--      netted. Ties on the same date prefer the invoice, then the later line (created_at, then
--      sort_order, then id).
--
--   3. _split_invoice_content_claim leaves the new column out of the split-invoice provenance claim
--      it builds from each whole invoice line, so the claims already stored stay byte-identical and
--      split-billing invoices keep posting. Its body is otherwise the live one; owner and grants are
--      kept by CREATE OR REPLACE.
--
-- No price, cost, quote, order or invoice value is changed. The triggers only fill the new column.
--   KNOWN ONE-TIME EFFECT (accepted): _invoice_post_content_version hashes whole invoice lines, so an
--   invoice loaded on screen before the apply and posted after it is refused once as "changed since
--   loaded" and posts after a reload. Nothing is stored; the post-binds proof pins that function, so
--   it is left as is.
--
-- caller-analysis: get_last_charged_prices :: NEW; src/lib/lastChargedPrices.ts (QuoteBuilder.tsx "Last charged" card; admin and sales rep)
--
-- GRANTS: get_last_charged_prices EXECUTE to authenticated only (revoked from PUBLIC, anon,
--   service_role, metabase_ro); SECURITY DEFINER, search_path = public, pg_temp. The trigger
--   function is executable by no API role. ACCESS CHANGE (needs Mason's approval at apply): column
--   grants on the new price_tier_at_sale columns of two existing tables, SELECT + REFERENCES to
--   authenticated and SELECT to anon, the same read grants every other non-cost column there has.
--   _split_invoice_content_claim keeps its live owner (postgres) and EXECUTE (postgres only).
--
-- ROLLBACK (loses only the stamped tiers; nothing else reads them). The claim function may keep its
--   extra excluded key: excluding a key that does not exist changes nothing, so stored claims match
--   before and after the columns go.
--   DROP FUNCTION public.get_last_charged_prices(uuid, uuid[]);
--   DROP TRIGGER trg_stamp_price_tier_at_sale ON public.order_items;
--   DROP TRIGGER trg_stamp_price_tier_at_sale ON public.invoice_items;
--   DROP FUNCTION public._stamp_price_tier_at_sale_20261026();
--   DROP FUNCTION public._order_line_price_tier_20261026(uuid, uuid);
--   DROP FUNCTION public._invoice_line_order_tier_20261026(uuid);
--   ALTER TABLE public.order_items DROP COLUMN price_tier_at_sale;
--   ALTER TABLE public.invoice_items DROP COLUMN price_tier_at_sale;

SET LOCAL lock_timeout = '10s';

-- PREFLIGHT: the two bodies this file relies on or re-emits are exactly the ones read live on
-- 2026-10-26 (md5 of prosrc without carriage returns), and nothing it creates exists yet. Run as one
-- transaction (the apply script and psql -1 do).
DO $preflight$
DECLARE
  v_md5 text;
BEGIN
  IF to_regprocedure('public.require_admin_or_sales_rep()') IS NULL THEN
    RAISE EXCEPTION 'LAST_CHARGED_PREFLIGHT: public.require_admin_or_sales_rep() is missing';
  END IF;
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.require_admin_or_sales_rep()');
  IF v_md5 IS DISTINCT FROM '958c994aeabcb9f53b6cef316019a219' THEN
    RAISE EXCEPTION 'LAST_CHARGED_PREFLIGHT: require_admin_or_sales_rep() changed since 2026-10-26 (md5 %); re-read it before applying', v_md5;
  END IF;
  -- Re-emitted below with one more excluded key; its owner and grants must be the live ones.
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc p WHERE p.oid = to_regprocedure('public._split_invoice_content_claim(uuid)');
  IF v_md5 IS DISTINCT FROM 'b9fb02bee41aa5c57702edc231d03644' THEN
    RAISE EXCEPTION 'LAST_CHARGED_PREFLIGHT: _split_invoice_content_claim(uuid) changed since 2026-10-26 (md5 %); re-read it before applying', v_md5;
  END IF;
  IF (SELECT pg_get_userbyid(p.proowner) <> 'postgres' OR NOT p.prosecdef
             OR array_to_string(p.proacl, ',') IS DISTINCT FROM 'postgres=X/postgres'
        FROM pg_proc p WHERE p.oid = 'public._split_invoice_content_claim(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'LAST_CHARGED_PREFLIGHT: _split_invoice_content_claim(uuid) owner, mode or grants changed since 2026-10-26';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name IN ('order_items', 'invoice_items')
                AND column_name = 'price_tier_at_sale')
     OR EXISTS (SELECT 1 FROM pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace
                   AND p.proname IN ('get_last_charged_prices', '_stamp_price_tier_at_sale_20261026',
                                     '_order_line_price_tier_20261026', '_invoice_line_order_tier_20261026'))
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_stamp_price_tier_at_sale') THEN
    RAISE EXCEPTION 'LAST_CHARGED_PREFLIGHT: an object this migration creates already exists';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. The tier a line was sold at.
-- ---------------------------------------------------------------------------
ALTER TABLE public.order_items
  ADD COLUMN price_tier_at_sale smallint,
  ADD CONSTRAINT order_items_price_tier_at_sale_range
    CHECK (price_tier_at_sale IS NULL OR price_tier_at_sale BETWEEN 1 AND 3);
ALTER TABLE public.invoice_items
  ADD COLUMN price_tier_at_sale smallint,
  ADD CONSTRAINT invoice_items_price_tier_at_sale_range
    CHECK (price_tier_at_sale IS NULL OR price_tier_at_sale BETWEEN 1 AND 3);

-- Since the cost lock (20261022101000) these tables carry per-column grants, and every new non-cost
-- column gets the read privileges the table's other columns have (src/lib/costFields.test.ts): SELECT
-- and REFERENCES to authenticated, SELECT to anon. Row-level security still decides which rows. No
-- write grant: only the trigger writes the column.
GRANT SELECT (price_tier_at_sale) ON public.order_items TO authenticated;
GRANT REFERENCES (price_tier_at_sale) ON public.order_items TO authenticated;
GRANT SELECT (price_tier_at_sale) ON public.order_items TO anon;
GRANT SELECT (price_tier_at_sale) ON public.invoice_items TO authenticated;
GRANT REFERENCES (price_tier_at_sale) ON public.invoice_items TO authenticated;
GRANT SELECT (price_tier_at_sale) ON public.invoice_items TO anon;

COMMENT ON COLUMN public.order_items.price_tier_at_sale IS
  'Price tier (1-3) in effect when this line was written: its quote''s tier, else the customer''s assigned tier then. NULL = unknown (lines written before 20261027060000). Read by get_last_charged_prices.';
COMMENT ON COLUMN public.invoice_items.price_tier_at_sale IS
  'Price tier (1-3) in effect when this line was written: its order line''s tier, else the invoice customer''s assigned tier then. NULL = unknown (lines written before 20261027060000) or not a product line. Read by get_last_charged_prices.';

-- An order line's tier: its own quote line's quote tier, else the order customer's now. Not the
-- order's quote tier: the converter and draw-down always link each quote-priced line to its quote
-- line, and a product added to the order later (update_order_items, no quote line) is priced at the
-- customer's tier (Codex App P2, PR #1119).
CREATE FUNCTION public._order_line_price_tier_20261026(p_order_id uuid, p_quote_item_id uuid)
RETURNS smallint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(
    (SELECT q.tier FROM public.quote_items qi JOIN public.quotes q ON q.id = qi.quote_id
      WHERE qi.id = p_quote_item_id),
    (SELECT c.assigned_tier FROM public.orders o JOIN public.customers c ON c.id = o.customer_id
      WHERE o.id = p_order_id)
  )::smallint;
$function$;
ALTER FUNCTION public._order_line_price_tier_20261026(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._order_line_price_tier_20261026(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- The tier an invoice line billed from an order line was sold at: the order line's stamp, else (an
-- order line written before this file) its quote's tier. Never the customer's current tier: that
-- would guess a past sale's tier from today's customer, so an unquoted older line stays unknown.
CREATE FUNCTION public._invoice_line_order_tier_20261026(p_order_item_id uuid)
RETURNS smallint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(
    oi.price_tier_at_sale,
    (SELECT q.tier FROM public.quote_items qi JOIN public.quotes q ON q.id = qi.quote_id
      WHERE qi.id = oi.quote_item_id)
  )::smallint
  FROM public.order_items oi
  WHERE oi.id = p_order_item_id;
$function$;
ALTER FUNCTION public._invoice_line_order_tier_20261026(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public._invoice_line_order_tier_20261026(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

-- SECURITY DEFINER so the lookups see the quote and customer whatever the writer's own read access.
CREATE FUNCTION public._stamp_price_tier_at_sale_20261026()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- The invoice editor's save deletes and re-inserts every line without order_item_id, then puts
  -- order_item_id back with an UPDATE (the save_invoice lineage wrapper, 20260827041500), so the
  -- insert stamped the customer's tier. Restoring the order link re-takes the order line's tier.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.order_item_id IS NOT NULL AND NEW.order_item_id IS DISTINCT FROM OLD.order_item_id
       AND NEW.product_id IS NOT NULL AND NEW.return_credit_source_item_id IS NULL THEN
      NEW.price_tier_at_sale := public._invoice_line_order_tier_20261026(NEW.order_item_id);
    END IF;
    RETURN NEW;
  END IF;

  -- The database always decides the tier: a value a writer sends is replaced, so a line can never
  -- claim a tier it was not sold at. Lines with no product and return credits carry none.
  NEW.price_tier_at_sale := NULL;
  IF NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'order_items' THEN
    NEW.price_tier_at_sale := public._order_line_price_tier_20261026(NEW.order_id, NEW.quote_item_id);
  ELSIF NEW.return_credit_source_item_id IS NULL THEN
    IF NEW.order_item_id IS NOT NULL THEN
      -- Billed from an order line: the order line's tier, never today's customer tier (an order
      -- line from before this file with no quote stays unknown).
      NEW.price_tier_at_sale := public._invoice_line_order_tier_20261026(NEW.order_item_id);
    ELSIF NEW.price_source = 'quoted' THEN
      -- Priced from a quote with no order line to trace it (create_invoice_from_blend_ticket bills
      -- a quote's price this way): the quote's tier cannot be recovered reliably, and the
      -- customer's tier may not be the one that priced it, so the tier stays unknown (Codex App
      -- P2, PR #1119).
      NULL;
    ELSE
      SELECT c.assigned_tier::smallint INTO NEW.price_tier_at_sale
        FROM public.invoices i JOIN public.customers c ON c.id = i.customer_id
       WHERE i.id = NEW.invoice_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
ALTER FUNCTION public._stamp_price_tier_at_sale_20261026() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._stamp_price_tier_at_sale_20261026() FROM PUBLIC, anon, authenticated, service_role, metabase_ro;

CREATE TRIGGER trg_stamp_price_tier_at_sale
  BEFORE INSERT ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public._stamp_price_tier_at_sale_20261026();
CREATE TRIGGER trg_stamp_price_tier_at_sale
  BEFORE INSERT OR UPDATE OF order_item_id ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._stamp_price_tier_at_sale_20261026();

-- ---------------------------------------------------------------------------
-- 1b. Split-invoice content claims ignore the new column.
-- ---------------------------------------------------------------------------
-- split_invoice_provenance.content_claim stores this function's result and posting compares a fresh
-- one with =, so a new invoice_items key would make every stored claim mismatch (posting refused
-- with SPLIT_INVOICE_GROUP_PROVENANCE_REQUIRED). The tier label is not billing content: leave it out,
-- and every stored claim stays byte-identical. Otherwise the live body (20260719044912) unchanged.
CREATE OR REPLACE FUNCTION public._split_invoice_content_claim(p_invoice_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT jsonb_build_object(
    'contract_version', 'split_invoice_provenance_v1',
    'invoice', jsonb_build_object(
      'invoice_id', i.id,
      'invoice_number', i.invoice_number,
      'order_id', i.order_id,
      'customer_id', i.customer_id,
      'invoice_type', i.invoice_type,
      'season', i.season,
      'salesman_id', i.salesman_id,
      'created_by', i.created_by,
      'total_amount_cents', i.total_amount_cents,
      'invoice_date', i.invoice_date,
      'invoice_group_id', i.invoice_group_id,
      'header_notes', i.header_notes,
      'pricing_pending', i.pricing_pending
    ),
    'items', COALESCE((
      SELECT jsonb_agg(
               to_jsonb(ii) - ARRAY['created_at', 'updated_at', 'price_tier_at_sale']::text[]
               ORDER BY ii.sort_order, ii.id
             )
        FROM public.invoice_items ii
       WHERE ii.invoice_id = i.id
    ), '[]'::jsonb)
  )
  FROM public.invoices i
  WHERE i.id = p_invoice_id;
$function$;

-- ---------------------------------------------------------------------------
-- 2. get_last_charged_prices: the latest charge per product for one customer.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.get_last_charged_prices(p_customer_id uuid, p_product_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  -- Reps see the last price charged (Mason, 2026-10-14); drivers and applicators do not.
  PERFORM public.require_admin_or_sales_rep();

  IF p_customer_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id) THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
  END IF;
  IF COALESCE(cardinality(p_product_ids), 0) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;
  IF cardinality(p_product_ids) > 500 THEN
    RAISE EXCEPTION 'LAST_CHARGED_TOO_MANY_PRODUCTS: ask for at most 500 products at a time';
  END IF;

  WITH wanted AS (
    SELECT DISTINCT w.product_id FROM unnest(p_product_ids) AS w(product_id) WHERE w.product_id IS NOT NULL
  ),
  charges AS (
    -- Product lines only: charge lines carry no product (invoice_items_charge_line_shape_chk), so
    -- the product filter leaves them out; an application fee may name a product, so it is left out
    -- by is_application_fee. A $0 line is a no-charge line (split billing keeps them), not a price
    -- we charged.
    SELECT ii.product_id, ii.unit_price_cents, ii.price_tier_at_sale AS price_tier, ii.unit_size,
           i.invoice_date AS charged_on, 'invoice'::text AS source, 0 AS source_rank,
           ii.created_at, ii.sort_order, ii.id
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
     WHERE i.customer_id = p_customer_id
       AND ii.product_id IN (SELECT product_id FROM wanted)
       AND i.status IN ('posted', 'paid', 'overdue')
       AND i.invoice_type IN ('chemical_sale', 'field_application')
       AND i.deleted_at IS NULL
       AND i.voided_at IS NULL
       AND i.pricing_pending IS NOT TRUE
       -- An invoice made from a spray job (transfer_job_to_invoice) stores each chemical line as
       -- quantity 1 at the line total, so its unit_price_cents is not a per-unit price. Left out
       -- (Codex App P2, PR #1119); the job's product then shows its last per-unit charge instead.
       -- A split-billing child of a job (_save_field_app_split_invoice_impl) also carries job_id,
       -- but always with field_app_billing_set_id and per-unit lines, so it counts; the job
       -- transfer never sets a billing set.
       AND (i.job_id IS NULL OR i.field_app_billing_set_id IS NOT NULL)
       AND ii.return_credit_source_item_id IS NULL
       AND ii.is_application_fee IS NOT TRUE
       AND ii.quantity > 0
       AND ii.unit_price_cents > 0
    UNION ALL
    -- Order prices are stored in dollars at whole cents (order_items_price_per_unit_cent_scale_chk),
    -- so round() is exact. Order lines have no timestamp of their own: the order's is used, and
    -- sort_order and id break ties between lines of one order.
    SELECT oi.product_id, round(oi.price_per_unit * 100)::bigint, oi.price_tier_at_sale, oi.unit_size,
           o.order_date, 'order'::text, 1, o.created_at, oi.sort_order, oi.id
      FROM public.order_items oi
      JOIN public.orders o ON o.id = oi.order_id
     WHERE o.customer_id = p_customer_id
       AND oi.product_id IN (SELECT product_id FROM wanted)
       AND o.status IN ('confirmed', 'partially_fulfilled', 'fulfilled')
       AND o.deleted_at IS NULL
       AND o.pricing_status IS DISTINCT FROM 'needs_pricing'
       AND oi.pricing_pending IS NOT TRUE
       AND oi.price_per_unit > 0
       AND oi.total_units_needed > 0
       -- Once a counted invoice line bills this order line, the invoice line is the charge.
       AND NOT EXISTS (
         SELECT 1
           FROM public.invoice_items bi
           JOIN public.invoices b ON b.id = bi.invoice_id
          WHERE bi.order_item_id = oi.id
            -- This customer's own invoice: a split-payer invoice billed to someone else is not
            -- this customer's charge, so it must not hide their order line either.
            AND b.customer_id = p_customer_id
            AND b.status IN ('posted', 'paid', 'overdue')
            AND b.invoice_type IN ('chemical_sale', 'field_application')
            AND b.deleted_at IS NULL
            AND b.voided_at IS NULL
            AND b.pricing_pending IS NOT TRUE
            AND bi.return_credit_source_item_id IS NULL
            AND bi.quantity > 0
            AND bi.unit_price_cents > 0)
  ),
  latest AS (
    SELECT DISTINCT ON (c.product_id) c.*
      FROM charges c
     ORDER BY c.product_id, c.charged_on DESC, c.source_rank, c.created_at DESC,
              c.sort_order DESC NULLS LAST, c.id DESC
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', l.product_id,
           'unit_price_cents', l.unit_price_cents,
           'price_tier', l.price_tier,
           'unit_size', l.unit_size,
           'charged_on', l.charged_on,
           'source', l.source
         ) ORDER BY l.product_id), '[]'::jsonb)
    INTO v_result
    FROM latest l;

  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.get_last_charged_prices(uuid, uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_last_charged_prices(uuid, uuid[]) FROM PUBLIC, anon, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION public.get_last_charged_prices(uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.get_last_charged_prices(uuid, uuid[]) IS
  'Admin or sales rep: for each product, the latest price charged to this customer (posted/paid/overdue invoice line, not from a spray-job transfer invoice, else a priced confirmed/delivered order line not yet on such an invoice): unit price cents, tier at sale (NULL = unknown), date, source. Reads across reps by design (To-Do 0.3; Mason, 2026-10-14).';

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  r text;
BEGIN
  IF has_function_privilege('anon', 'public.get_last_charged_prices(uuid,uuid[])', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.get_last_charged_prices(uuid,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_last_charged_prices(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'LAST_CHARGED_VERIFY: get_last_charged_prices grants are wrong';
  END IF;
  IF (SELECT p.prosecdef IS NOT TRUE OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
        FROM pg_proc p WHERE p.oid = 'public.get_last_charged_prices(uuid,uuid[])'::regprocedure) THEN
    RAISE EXCEPTION 'LAST_CHARGED_VERIFY: get_last_charged_prices is not SECURITY DEFINER with search_path public, pg_temp';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(r, 'public._stamp_price_tier_at_sale_20261026()', 'EXECUTE')
       OR has_function_privilege(r, 'public._order_line_price_tier_20261026(uuid,uuid)', 'EXECUTE')
       OR has_function_privilege(r, 'public._invoice_line_order_tier_20261026(uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'LAST_CHARGED_VERIFY: a helper is executable by %', r;
    END IF;
  END LOOP;
  -- The new columns carry the read grants and no write grant for the browser roles.
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF NOT has_column_privilege(r, 'public.order_items', 'price_tier_at_sale', 'SELECT')
       OR NOT has_column_privilege(r, 'public.invoice_items', 'price_tier_at_sale', 'SELECT')
       OR has_column_privilege(r, 'public.order_items', 'price_tier_at_sale', 'INSERT')
       OR has_column_privilege(r, 'public.order_items', 'price_tier_at_sale', 'UPDATE')
       OR has_column_privilege(r, 'public.invoice_items', 'price_tier_at_sale', 'INSERT')
       OR has_column_privilege(r, 'public.invoice_items', 'price_tier_at_sale', 'UPDATE') THEN
      RAISE EXCEPTION 'LAST_CHARGED_VERIFY: % has the wrong privileges on price_tier_at_sale', r;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_stamp_price_tier_at_sale' AND tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION 'LAST_CHARGED_VERIFY: the two tier-stamp triggers are not both enabled';
  END IF;
  IF (SELECT pg_get_userbyid(p.proowner) <> 'postgres' OR NOT p.prosecdef
             OR array_to_string(p.proacl, ',') IS DISTINCT FROM 'postgres=X/postgres'
             OR position('''price_tier_at_sale''' IN p.prosrc) = 0
        FROM pg_proc p WHERE p.oid = 'public._split_invoice_content_claim(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'LAST_CHARGED_VERIFY: _split_invoice_content_claim lost its owner, mode or grants, or does not exclude price_tier_at_sale';
  END IF;
  IF has_function_privilege('metabase_ro', 'public.get_last_charged_prices(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'LAST_CHARGED_VERIFY: metabase_ro can execute get_last_charged_prices';
  END IF;
END
$verify$;
