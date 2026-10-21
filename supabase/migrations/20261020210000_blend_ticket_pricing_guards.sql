-- Written 2026-10-20. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT (Goal 3, "Pricing", docs/plans/2026-10-13-direction-and-goals.md):
--   1. create_order_from_blend_ticket never prices a line at $0 because a tier price is missing.
--      Its renamed body, public._create_order_from_blend_ticket_replay_impl_20261015, read
--      COALESCE(tierN_price, 0) with no tier-1 fallback. Since every order line needs a cost, the
--      below-cost line guard then refused that $0 line (BELOW_COST_CONTEXT_REQUIRED), so staff got
--      a below-cost error and no order. It now uses the customer's tier price when it is above zero,
--      otherwise the tier-1 price, and refuses with BLEND_TICKET_PRICE_MISSING (naming the
--      products) when neither exists, before the order row is written. The public wrapper (replay
--      binding, 20261016140000) is not touched.
--   2. create_invoice_from_blend_ticket stops when the job's quote lists the same product more than
--      once at different prices, instead of billing whichever line sorts first
--      (ORDER BY qi.id LIMIT 1). It raises BLEND_TICKET_QUOTE_PRICE_CHOICE_REQUIRED with a JSON
--      DETAIL listing each such ticket line and its quoted prices, before any invoice number is
--      drawn or row written. Staff pick one; the pick is stored on the ticket line
--      (blend_ticket_products.unit_price_cents; no app code writes it and 0 live lines carry one)
--      and bills with price_source 'quoted' and its quoted_price_cents. A stored value counts only
--      while it still equals a usable price on the CURRENT job's quote section, for the line's
--      CURRENT product, on a live quote of the ticket's customer (_blend_quote_pick_valid_20261020);
--      otherwise it is ignored and the choice guard or tier pricing applies again, so editing the
--      product or job after a pick cannot bill the old price. (Before this change billing honoured
--      any unit_price_cents first as a 'manual' price; nothing set one.) Also in this body:
--      (a) a tier-priced line with no usable tier or tier-1 price is refused with
--      BLEND_TICKET_PRICE_MISSING instead of billed at $0, checked before any invoice number;
--      (b) a job pointed at another customer's quote, or a deleted quote, supplies no quoted price
--      (the automatic lookup trusted any section the job named); (c) only USABLE quote prices
--      count anywhere (zero or above, finite, whole cents); (d) a product the quote lists at $0
--      bills at $0 (Mason, 2026-10-20: "$0 of $0 but flag it in system and alert before save").
--      A $0 line is below cost, so it passes the existing below-cost wall: only an admin, with a
--      written reason in the new p_below_cost_reason, and the line trigger records each approval in
--      below_cost_approvals (operation 'create_invoice_from_blend_ticket'). The body asks first,
--      before any invoice number, with the trigger's own BELOW_COST_ADMIN_REQUIRED /
--      BELOW_COST_REASON_REQUIRED error shape, so the screen's approval window opens; only the $0
--      quoted line carries the below-cost context. Before, that $0 line was refused
--      (BELOW_COST_CONTEXT_REQUIRED) and no invoice could be made. Matching the
--      exact quoted line automatically is future work (Mason, 2026-10-15) and is not built here.
--   3. New public.set_blend_ticket_product_quote_price(p_blend_ticket_product_id uuid,
--      p_quote_item_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL): SECURITY
--      DEFINER, search_path public, pg_temp, EXECUTE for authenticated and service_role only. Admin
--      or sales rep; a rep only on a ticket that is theirs or unassigned (the billing test). The
--      quote item must be on this ticket's job quote section, for this line's product, on a live
--      quote of the ticket's customer, with a usable price; the ticket must be unbilled and not
--      linked to an order (the line triggers still refuse a live invoice or application record).
--      The key is required and bound to the caller and request (check_idempotency_intent +
--      _bind_replay_receipt_20261015).
--   4. New private helpers, executable only by postgres (every caller is definer-rights):
--      _blend_tier_price_cents_20261020(int, numeric, numeric, numeric), IMMUTABLE SQL, the
--      tier-or-tier-1 rule in whole cents (never rounds; a non-whole-cent price is no price), and
--      _blend_quote_pick_valid_20261020(uuid, uuid, uuid, bigint), STABLE SQL, the valid-pick rule,
--      so the pre-checks, the line pricing and the setter cannot disagree.
--   5. New column guard: trigger blend_ticket_products_price_pick_guard_20261020 (BEFORE INSERT OR
--      UPDATE OF unit_price_cents) running _guard_blend_ticket_price_pick_20261020() (SECURITY
--      INVOKER) refuses setting a non-NULL unit_price_cents unless the setter's transaction-local
--      flag app.crx_blend_quote_price_pick is '1' (BLEND_TICKET_PRICE_PICK_REQUIRED). The office
--      policy blend_ticket_products_office_all lets reps and admins update rows directly, which
--      would skip the setter's checks. Clearing a pick (NULL) stays allowed.
--
-- WHY (Mason): Goal 3 "Pricing" and the 2026-10-15 decision: "blend-ticket billing that
--   automatically uses the exact quoted line" is future work, "so Goal 3 adds a small guard: when
--   the quote lists that product more than once, the blend invoice stops and staff pick the price".
--   Same prices on both lines are not ambiguous and bill as before.
--
-- LIVE STATE (read-only, 2026-10-20): 0 quote sections list a product twice at different prices;
--   2 active products have no usable tier-1 price, 4 no tier-2, 8 no tier-3; 0 blend-ticket lines
--   carry unit_price_cents; every tier and quote price is whole cents.
--
-- NOT CHANGED: every other line of both bodies; the create_order_from_blend_ticket wrapper, its
--   receipt binding and the commit-time guard's operation list (the new setter binds its own
--   receipt, so the guard need not list it); save_blend_ticket (it never writes unit_price_cents);
--   every policy and grant on existing objects. No rows change. The order body is replaced in place
--   (CREATE OR REPLACE keeps its OID, owner and ACL); the invoice function is dropped and re-created
--   with one extra trailing argument and the same owner, settings and grants. The only table change
--   widens below_cost_approvals_operation_check to a superset (0 live rows, read 2026-10-20). The order path does not read quotes
--   or picks (it prices from tiers, as before).
--
-- OVERLOADS: each replaced function has exactly one overload (read live 2026-10-20); the preflight
--   and postflight refuse a second one, and the new names must not exist yet.
--
-- ROLLBACK (if ever needed, as its own reviewed migration): re-emit
--   _create_order_from_blend_ticket_replay_impl_20261015 from
--   20260812010000_blend_ticket_order_header_runtime_assert.sql (body only; keep the name and the
--   postgres-only ACL) and create_invoice_from_blend_ticket from
--   20261015130000_orders_blend_tickets_rep_own_name.sql (DROP the four-argument function first and
--   restore its grants), then DROP TRIGGER
--   blend_ticket_products_price_pick_guard_20261020 ON public.blend_ticket_products and DROP
--   FUNCTION public._guard_blend_ticket_price_pick_20261020(),
--   public.set_blend_ticket_product_quote_price(uuid, uuid, uuid, text),
--   public._blend_quote_pick_valid_20261020(uuid, uuid, uuid, bigint) and
--   public._blend_tier_price_cents_20261020(integer, numeric, numeric, numeric). Narrowing the
--   below_cost_approvals operation list again is possible only while no row uses the new value. Picked prices
--   already stored would then bill first as 'manual', as before this change.
--
-- ORDERING: independent of the pending 20261019235000 (cancel/void replay binding, PR #967): it
--   touches neither body. scripts/.staging-migrations/20260813020000_round_order_header_money.sql
--   names the order body's old md5 only in comments; it pins nothing this file changes.
--
-- actor-binding-check: exempt for create_invoice_from_blend_ticket, as in 20261015130000: its
--   verbatim live body binds p_created_by to auth.uid() ('p_created_by does not match
--   authenticated user') before any write. The order body and the new setter raise ACTOR_MISMATCH.

SET LOCAL lock_timeout = '5s';
-- The postflight compares pg_get_triggerdef text, which prints the trigger function unqualified only
-- while public is on the search_path.
SET LOCAL search_path = public, pg_temp;

CREATE TEMP TABLE blend_ticket_pricing_guards_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
       to_regprocedure('public._create_order_from_blend_ticket_replay_impl_20261015(uuid,text,date,text,uuid,text)')::oid AS order_oid;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.blend_ticket_pricing_guards_tx') IS NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRICING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.blend_ticket_pricing_guards_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRICING_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;

  -- The two bodies replaced here, exactly as reviewed (live md5s of 2026-10-20, carriage returns
  -- ignored), with their signatures, owners, settings and ACLs.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_invoice_from_blend_ticket') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) = 'p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text'
        AND md5(replace(p.prosrc, chr(13), '')) = '7be2aeab29bcd4ef50e74dd7a63bcfbc'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.create_invoice_from_blend_ticket(uuid,uuid,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_BLEND_TICKET_INVOICE_DRIFT: expected the exact reviewed public create_invoice_from_blend_ticket';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_create_order_from_blend_ticket_replay_impl_20261015') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'json'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) = 'p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text'
        AND md5(replace(p.prosrc, chr(13), '')) = '344532c6522cce26857ce4ffd9597125'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]
        FROM pg_proc p WHERE p.oid = to_regprocedure('public._create_order_from_blend_ticket_replay_impl_20261015(uuid,text,date,text,uuid,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_BLEND_TICKET_ORDER_DRIFT: expected the exact reviewed _create_order_from_blend_ticket_replay_impl_20261015';
  END IF;

  -- What the new code relies on, pinned to the live bodies of 2026-10-20: the role helpers, the
  -- order wrapper that calls the renamed body, and the replay helpers the setter uses.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.is_admin()', 'f76bf61116c3bd52bd9c6ea125079b73'),
        ('public.is_sales_rep()', 'fcb3133010fe3f4f56e3be31f709d102'),
        ('public.create_order_from_blend_ticket(uuid,text,date,text,uuid,text)', '8939753ffb18b5dc98528dbfd621cfb3'),
        ('public.check_idempotency_intent(text,text,uuid,text)', 'edc73be809069669e8441eba7acf443d'),
        ('public._bind_replay_receipt_20261015(text,text,text)', '722ddd3b5d9174c598735cb321088f73'),
        ('public._replay_fingerprint_20261015(jsonb)', '68d5c0c62579349ced47c89e6b65ccaf'),
        ('public.save_idempotency(text,text,jsonb)', 'f600171c426e48c995f204c4dac3ff8b'),
        ('public._enforce_below_cost_line()', '1cc52a9746b192e649367a44e9d63020')
      ) AS pin(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_DEPENDENCY_DRIFT: a role helper, the order wrapper, a replay helper or the below-cost line guard differs from its reviewed state';
  END IF;

  -- The below-cost approval log's operation list, exactly as live (2026-10-20); widened below.
  IF (SELECT count(*) FROM pg_constraint c
       WHERE c.conrelid = 'public.below_cost_approvals'::regclass
         AND c.conname = 'below_cost_approvals_operation_check'
         AND pg_get_constraintdef(c.oid) = 'CHECK ((operation = ANY (ARRAY[''create_direct_order''::text, ''create_rush_order''::text, ''bulk_import_order''::text, ''update_order_items''::text, ''price_order''::text, ''save_invoice''::text, ''save_quote''::text, ''convert_quote_to_order''::text, ''draw_down_quote''::text, ''restore_quote_version''::text, ''duplicate_quote''::text])))') <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_BELOW_COST_OPERATION_CHECK_DRIFT: below_cost_approvals_operation_check differs from its reviewed state';
  END IF;

  -- The columns the new code reads and writes, with their types.
  IF (SELECT count(*) FROM pg_attribute a
       WHERE NOT a.attisdropped AND (
             (a.attrelid = 'public.blend_ticket_products'::regclass AND a.attname = 'unit_price_cents' AND a.atttypid = 'bigint'::regtype AND NOT a.atthasdef)
          OR (a.attrelid = 'public.jobs'::regclass AND a.attname IN ('quote_section_id', 'quote_id') AND a.atttypid = 'uuid'::regtype)
          OR (a.attrelid = 'public.quote_items'::regclass AND a.attname IN ('section_id', 'product_id') AND a.atttypid = 'uuid'::regtype)
          OR (a.attrelid = 'public.quote_items'::regclass AND a.attname = 'price_per_unit' AND a.atttypid = 'numeric'::regtype)
          OR (a.attrelid = 'public.products'::regclass AND a.attname IN ('tier1_price', 'tier2_price', 'tier3_price') AND a.atttypid = 'numeric'::regtype)
          OR (a.attrelid = 'public.quote_sections'::regclass AND a.attname = 'quote_id' AND a.atttypid = 'uuid'::regtype)
          OR (a.attrelid = 'public.quotes'::regclass AND a.attname = 'customer_id' AND a.atttypid = 'uuid'::regtype)
          OR (a.attrelid = 'public.quotes'::regclass AND a.attname = 'deleted_at' AND a.atttypid = 'timestamptz'::regtype))) <> 12 THEN
    RAISE EXCEPTION 'PREFLIGHT_COLUMN_DRIFT: a pricing column is missing or has an unexpected type';
  END IF;

  -- Not re-runnable: the new names must not exist yet.
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('set_blend_ticket_product_quote_price', '_blend_tier_price_cents_20261020',
                                  '_blend_quote_pick_valid_20261020', '_guard_blend_ticket_price_pick_20261020'))
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'blend_ticket_products_price_pick_guard_20261020') THEN
    RAISE EXCEPTION 'PREFLIGHT_ALREADY_APPLIED: the blend-ticket pricing functions already exist';
  END IF;
END
$preflight$;

-- 4. The tier-or-tier-1 rule, shared by both bodies' pre-checks and line pricing.
CREATE FUNCTION public._blend_tier_price_cents_20261020(p_tier integer, p_tier1 numeric, p_tier2 numeric, p_tier3 numeric)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
  -- The customer's tier price when it is above zero, otherwise the tier-1 price, in whole cents;
  -- NULL when neither is a usable price (missing, zero or below, not whole cents). NaN and
  -- Infinity sort above every number, so "< Infinity" refuses them too. Never rounds.
  SELECT CASE
    WHEN p_tier IN (2, 3)
         AND (CASE p_tier WHEN 2 THEN p_tier2 ELSE p_tier3 END) > 0
         AND (CASE p_tier WHEN 2 THEN p_tier2 ELSE p_tier3 END) < 'Infinity'::numeric
         AND (CASE p_tier WHEN 2 THEN p_tier2 ELSE p_tier3 END)
             = ROUND((CASE p_tier WHEN 2 THEN p_tier2 ELSE p_tier3 END), 2)
      THEN ((CASE p_tier WHEN 2 THEN p_tier2 ELSE p_tier3 END) * 100)::bigint
    WHEN p_tier1 > 0 AND p_tier1 < 'Infinity'::numeric AND p_tier1 = ROUND(p_tier1, 2)
      THEN (p_tier1 * 100)::bigint
  END;
$function$;

REVOKE ALL ON FUNCTION public._blend_tier_price_cents_20261020(integer, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated, service_role;

-- 4. The valid-pick rule, shared by the invoice's guards, its line pricing and the setter.
CREATE FUNCTION public._blend_quote_pick_valid_20261020(p_section_id uuid, p_customer_id uuid, p_product_id uuid, p_price_cents bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  -- A ticket line's stored pick counts only while it equals a usable price (zero or above, finite, whole cents)
  -- on THIS section, for THIS product, on a live quote of THIS customer. Anything else (no pick,
  -- a stale pick after the product or job changed, a hand-set value) is no pick.
  SELECT p_section_id IS NOT NULL
     AND p_product_id IS NOT NULL
     AND p_price_cents IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM quote_items qi
         JOIN quote_sections qs ON qs.id = qi.section_id
         JOIN quotes q ON q.id = qs.quote_id
        WHERE qi.section_id = p_section_id
          AND qi.product_id = p_product_id
          AND qi.price_per_unit >= 0 AND qi.price_per_unit < 'Infinity'::numeric AND qi.price_per_unit = ROUND(qi.price_per_unit, 2)
          AND (qi.price_per_unit * 100)::bigint = p_price_cents
          AND q.customer_id = p_customer_id
          AND q.deleted_at IS NULL);
$function$;

REVOKE ALL ON FUNCTION public._blend_quote_pick_valid_20261020(uuid, uuid, uuid, bigint) FROM PUBLIC, anon, authenticated, service_role;

-- 5. Only the setter writes a picked price.
CREATE FUNCTION public._guard_blend_ticket_price_pick_20261020()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- Goal 3 pricing (20261020210000): a ticket line's picked price is written only by
  -- set_blend_ticket_product_quote_price, which sets this transaction-local flag around its one
  -- UPDATE. A direct Data API write (the office policy allows reps and admins to update the row)
  -- would otherwise skip that function's own-name, quote and customer checks. Clearing a pick
  -- (setting NULL) is always allowed: billing then simply asks again. A line whose product changes,
  -- or that moves to another ticket, drops its pick, so an old pick never carries over even when
  -- the new product happens to be quoted at the same price.
  IF TG_OP = 'UPDATE'
     AND (NEW.product_id IS DISTINCT FROM OLD.product_id
          OR NEW.blend_ticket_id IS DISTINCT FROM OLD.blend_ticket_id) THEN
    NEW.unit_price_cents := NULL;
    RETURN NEW;
  END IF;
  IF NEW.unit_price_cents IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.unit_price_cents IS NOT DISTINCT FROM OLD.unit_price_cents THEN
    RETURN NEW;
  END IF;
  -- Both conditions: the flag, and running as the table owner (current_user is postgres only inside
  -- a definer function; a Data API write runs as authenticated). A caller who somehow set the flag
  -- in their own session still cannot write the column.
  IF COALESCE(current_setting('app.crx_blend_quote_price_pick', true), '') = '1'
     AND current_user = 'postgres' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'BLEND_TICKET_PRICE_PICK_REQUIRED: a blend-ticket line price is set only by picking a quoted price';
END;
$function$;

REVOKE ALL ON FUNCTION public._guard_blend_ticket_price_pick_20261020() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON COLUMN public.blend_ticket_products.unit_price_cents IS
  'Quoted price (cents) staff picked for this line when the job''s quote lists its product at more than one price (set only by set_blend_ticket_product_quote_price, Goal 3 2026-10-20). Billing honours it only while it still matches a usable price on the current job''s quote, for the line''s current product, on a live quote of the ticket''s customer. Cleared when the line''s product or ticket changes.';

CREATE TRIGGER blend_ticket_products_price_pick_guard_20261020
  BEFORE INSERT OR UPDATE OF unit_price_cents, product_id, blend_ticket_id ON public.blend_ticket_products
  FOR EACH ROW EXECUTE FUNCTION public._guard_blend_ticket_price_pick_20261020();

-- 1. The order body: verbatim live body plus the pre-check and the tier-1 fallback.
CREATE OR REPLACE FUNCTION public._create_order_from_blend_ticket_replay_impl_20261015(p_blend_ticket_id uuid, p_order_number text, p_order_date date DEFAULT CURRENT_DATE, p_notes text DEFAULT NULL::text, p_performed_by uuid DEFAULT auth.uid(), p_idempotency_key text DEFAULT NULL::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor       uuid := auth.uid();
  v_ticket      blend_tickets%ROWTYPE;
  v_order_id    uuid;
  v_customer    customers%ROWTYPE;
  v_product     blend_ticket_products%ROWTYPE;
  v_db_product  products%ROWTYPE;
  v_item_id     uuid;
  v_tier        int;
  v_price       numeric;
  -- Goal 3 pricing (20261020210000): the products with no usable price.
  v_unpriced    text;
  v_cost        numeric;
  v_total_price numeric := 0;
  v_total_cost  numeric := 0;
  v_total_profit numeric := 0;
  v_total_margin_pct numeric := 0;
  v_expected_total_price numeric;
  v_expected_total_cost  numeric;
  v_expected_total_profit numeric;
  v_expected_margin_pct  numeric;
  v_item_count  int := 0;
  v_invalid_count int;
  v_link_result json;
  v_cached      jsonb;
  v_result      jsonb;
  -- A5: quantity converted to the product's inventory unit + the unit label to store
  v_qty_conv    numeric;
  v_unit_out    text;
  -- Per-blend-line mappings retain the ticket quantity/unit truth. The order
  -- line and inventory transaction may use a converted inventory-unit value.
  v_mappings    jsonb := '[]'::jsonb;
BEGIN
  -- A5-actor: reject a forged actor / non-admin up front, mirroring the two sibling
  -- blend-ticket RPCs (create_invoice_/create_application_record_from_blend_ticket).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required to create orders from blend tickets';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_cached := check_idempotency(p_idempotency_key, 'create_order_from_blend_ticket');
    IF v_cached IS NOT NULL THEN
      RETURN v_cached::json;
    END IF;
  END IF;

  SELECT * INTO v_ticket FROM blend_tickets WHERE id = p_blend_ticket_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket not found');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.invoices
     WHERE blend_ticket_id = p_blend_ticket_id
       AND deleted_at IS NULL
       AND COALESCE(status, '') NOT IN ('voided', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'BLEND_TICKET_ACTIVE_INVOICE_ORDER_LOCKED';
  END IF;
  IF v_ticket.order_link_status = 'linked' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket is already linked to an order');
  END IF;
  IF v_ticket.customer_id IS NULL THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket has no customer assigned');
  END IF;
  IF v_ticket.status <> 'completed' OR v_ticket.review_status <> 'approved' THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket must be completed and approved before creating an order');
  END IF;
  IF v_ticket.payment_status <> 'unbilled' THEN
    RETURN json_build_object('success', false, 'error', 'Only an unbilled blend ticket can create an order');
  END IF;

  SELECT count(*) FILTER (
           WHERE btp.product_id IS NULL
              OR btp.quantity <= 0
              OR btp.quantity::text IN ('NaN', 'Infinity', '-Infinity')
              OR p.id IS NULL
              OR p.is_active IS DISTINCT FROM true
         )
    INTO v_invalid_count
    FROM blend_ticket_products btp
    LEFT JOIN products p ON p.id = btp.product_id
   WHERE btp.blend_ticket_id = p_blend_ticket_id;

  IF NOT EXISTS (
    SELECT 1 FROM blend_ticket_products
     WHERE blend_ticket_id = p_blend_ticket_id
  ) THEN
    RETURN json_build_object('success', false, 'error', 'Blend ticket has no products');
  END IF;
  IF v_invalid_count > 0 THEN
    RETURN json_build_object('success', false, 'error', 'Every blend-ticket product must be matched to an active catalog product with a positive quantity');
  END IF;

  SELECT * INTO v_customer FROM customers WHERE id = v_ticket.customer_id AND is_active = true;
  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Customer not found');
  END IF;
  v_tier := COALESCE(v_customer.assigned_tier, 1);

  -- Goal 3 pricing (20261020210000): an order line is never priced at $0 because a tier price
  -- is missing. The customer's tier price is used when it is above zero, otherwise the tier-1
  -- price (_blend_tier_price_cents_20261020); a product with neither is refused here, before
  -- any row is written.
  SELECT string_agg(DISTINCT p.product_name, ', ' ORDER BY p.product_name)
    INTO v_unpriced
    FROM blend_ticket_products btp
    JOIN products p ON p.id = btp.product_id
   WHERE btp.blend_ticket_id = p_blend_ticket_id
     AND public._blend_tier_price_cents_20261020(v_tier, p.tier1_price, p.tier2_price, p.tier3_price) IS NULL;
  IF v_unpriced IS NOT NULL THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRICE_MISSING: product(s) have no price on the price list: %', v_unpriced;
  END IF;

  -- CHANGED: Removed total_paid and balance_due from INSERT (AR tracked via invoices)
  v_order_id := gen_random_uuid();
  INSERT INTO orders (id, order_number, customer_id, status, order_date, notes, season, salesman_id, total_price, total_cost, total_profit, total_margin_pct)
  VALUES (
    v_order_id,
    p_order_number,
    v_ticket.customer_id,
    'confirmed',
    p_order_date,
    COALESCE(p_notes, 'Created from blend ticket ' || v_ticket.ticket_number),
    v_ticket.season,
    v_ticket.salesman_id,
    0, 0, 0, 0
  );

  FOR v_product IN
    SELECT * FROM blend_ticket_products
    WHERE blend_ticket_id = p_blend_ticket_id
    ORDER BY sequence_order
  LOOP
    v_price := 0;
    v_cost := 0;
    -- A5: default for an unmatched product (no product row) — no price, no conversion.
    v_qty_conv := v_product.quantity;
    v_unit_out := COALESCE(v_product.unit, 'ea');

    IF v_product.product_id IS NOT NULL THEN
      SELECT * INTO v_db_product FROM products WHERE id = v_product.product_id;
      IF FOUND THEN
        -- Goal 3 pricing: the tier price, else the tier-1 price, never a missing price as $0.
        v_price := ROUND(public._blend_tier_price_cents_20261020(
          v_tier, v_db_product.tier1_price, v_db_product.tier2_price, v_db_product.tier3_price) / 100.0, 2);
        IF v_price IS NULL THEN
          RAISE EXCEPTION 'BLEND_TICKET_PRICE_MISSING: product(s) have no price on the price list: %', v_product.product_name;
        END IF;
        v_cost := COALESCE(v_db_product.current_cost, 0);
        -- A5: convert the stored quantity (in v_product.unit) to the inventory unit
        -- so total_price, prebook, and the inventory txn all use the pricing/stock unit.
        v_qty_conv := field_app_priced_quantity(
                        v_product.quantity,
                        normalize_rate_unit(NULLIF(btrim(v_product.unit), '')),
                        normalize_rate_unit(COALESCE(NULLIF(btrim(v_db_product.inventory_unit), ''), v_db_product.unit_size)),
                        v_db_product.product_form);
        IF v_qty_conv IS NULL
           OR v_qty_conv <= 0
           OR v_qty_conv::text IN ('NaN', 'Infinity', '-Infinity') THEN
          RAISE EXCEPTION 'BLEND_TICKET_UNIT_UNCONVERTIBLE: product % quantity unit "%" cannot convert to inventory unit "%"',
            v_product.product_name, v_product.unit, COALESCE(v_db_product.inventory_unit, v_db_product.unit_size);
        END IF;
        v_unit_out := COALESCE(NULLIF(btrim(v_db_product.inventory_unit), ''), v_db_product.unit_size, v_product.unit, 'ea');
      END IF;
    END IF;

    v_item_id := gen_random_uuid();
    INSERT INTO order_items (
      id, order_id, product_id, product_name, price_per_unit, cost_per_unit,
      actual_rate, rate_unit, acres, total_units_needed, unit_size,
      total_price, profit, net_margin, quantity_delivered, quantity_remaining, sort_order
    )
    VALUES (
      v_item_id,
      v_order_id,
      v_product.product_id,
      v_product.product_name,
      v_price,
      v_cost,
      v_product.rate_per_acre,
      v_product.rate_per_acre_unit,
      v_ticket.total_acres,
      v_qty_conv,
      v_unit_out,
      v_price * v_qty_conv,
      (v_price - v_cost) * v_qty_conv,
      CASE WHEN v_price > 0 THEN ((v_price - v_cost) / v_price * 100) ELSE 0 END,
      0,
      v_qty_conv,
      v_product.sequence_order
    );

    -- Preserve exact blend-line identity and source quantity for link validation.
    IF v_product.product_id IS NOT NULL THEN
      v_mappings := v_mappings || jsonb_build_object(
        'blend_product_id', v_product.id,
        'order_item_id', v_item_id,
        'quantity_applied', v_product.quantity
      );
    END IF;

    IF v_product.product_id IS NOT NULL AND v_qty_conv > 0 THEN
      INSERT INTO inventory (
        product_id, location, quantity_available,
        quantity_prebooked, quantity_on_order, unit_size, updated_at
      ) VALUES (
        v_product.product_id, 'Main Warehouse', 0,
        v_qty_conv, 0, v_unit_out, now()
      )
      ON CONFLICT (product_id, location) DO UPDATE
        SET quantity_prebooked = COALESCE(inventory.quantity_prebooked, 0)
                                 + EXCLUDED.quantity_prebooked,
            updated_at = now();

      INSERT INTO inventory_transactions (
        product_id, transaction_type, quantity, to_location,
        order_id, performed_by, notes
      ) VALUES (
        v_product.product_id, 'booked', v_qty_conv, 'Main Warehouse',
        v_order_id, p_performed_by,
        'Prebooked for blend ticket order ' || p_order_number
      );
    END IF;

    v_item_count := v_item_count + 1;
  END LOOP;

  -- The AFTER-ROW trigger has already written all four header columns. Read
  -- the stored values first so v_total_price remains the value returned to the
  -- caller after the assertion proves it agrees with the inserted lines.
  SELECT COALESCE(o.total_price, 0),
         COALESCE(o.total_cost, 0),
         COALESCE(o.total_profit, 0),
         COALESCE(o.total_margin_pct, 0)
    INTO v_total_price, v_total_cost, v_total_profit, v_total_margin_pct
  FROM orders o
  WHERE o.id = v_order_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_HEADER_UNREADABLE';
  END IF;

  -- Mirror trg_recalc_order_totals exactly: round each line before summing,
  -- then derive profit and margin from those rounded sums.
  SELECT COALESCE(SUM(ROUND(total_price,2)),0),
         COALESCE(SUM(ROUND(COALESCE(cost_per_unit,0)*COALESCE(total_units_needed,0),2)),0)
    INTO v_expected_total_price, v_expected_total_cost
    FROM order_items WHERE order_id = v_order_id;
  v_expected_total_profit := v_expected_total_price - v_expected_total_cost;
  v_expected_margin_pct := CASE WHEN v_expected_total_price > 0
                                THEN ROUND((v_expected_total_profit / v_expected_total_price) * 100, 2) ELSE 0 END;

  -- PostgreSQL numeric NaN equals itself, so exact equality alone would let a
  -- NaN header pass. Reject non-finite values explicitly, and require every
  -- computed money total to be exact whole cents before comparing the stored
  -- header with exact numeric equality (no tolerance).
  IF v_expected_total_price::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_expected_total_cost::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_expected_total_profit::text IN ('NaN', 'Infinity', '-Infinity')
     OR v_expected_total_price IS DISTINCT FROM ROUND(v_expected_total_price, 2)
     OR v_expected_total_cost IS DISTINCT FROM ROUND(v_expected_total_cost, 2)
     OR v_expected_total_profit IS DISTINCT FROM ROUND(v_expected_total_profit, 2)
     OR v_total_price IS DISTINCT FROM v_expected_total_price
     OR v_total_cost IS DISTINCT FROM v_expected_total_cost
     OR v_total_profit IS DISTINCT FROM v_expected_total_profit
     OR v_total_margin_pct IS DISTINCT FROM v_expected_margin_pct THEN
    RAISE EXCEPTION 'ORDER_HEADER_NOT_RECALCULATED: observed total_price=%, total_cost=%, total_profit=%, total_margin_pct=%; expected total_price=%, total_cost=%, total_profit=%, total_margin_pct=%',
      v_total_price, v_total_cost, v_total_profit, v_total_margin_pct,
      v_expected_total_price, v_expected_total_cost, v_expected_total_profit, v_expected_margin_pct;
  END IF;

  v_link_result := link_blend_ticket_to_order(p_blend_ticket_id, v_order_id, v_mappings, p_performed_by);
  IF COALESCE((v_link_result->>'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'BLEND_TICKET_ORDER_LINK_FAILED: %', COALESCE(v_link_result->>'error', 'unknown link failure');
  END IF;

  INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'order_created_from_blend_ticket',
    'Order ' || p_order_number || ' created from blend ticket ' || v_ticket.ticket_number,
    p_performed_by,
    'order',
    v_order_id
  );

  v_result := jsonb_build_object(
     'success', true,
     'order_id', v_order_id,
     'order_number', p_order_number,
     'items_created', v_item_count,
     'total_price', v_total_price
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(
      p_idempotency_key,
      'create_order_from_blend_ticket',
      v_result
    );
  END IF;

  RETURN v_result::json;
END;
$function$;

-- 2. The invoice body: verbatim live body plus the choice guard, the missing-price pre-check, the
--    picked-price provenance, the unpriced-quote-line skip and the tier-1 fallback.
--    It gains p_below_cost_reason (the admin's reason for billing a $0 quoted line), so the old
--    three-argument function is dropped and the new one created with the same owner, settings
--    and EXECUTE grants (authenticated, service_role; never PUBLIC or anon). Nothing in the
--    database calls it; the screen calls it by argument name, so the old call shape still works.
DROP FUNCTION public.create_invoice_from_blend_ticket(uuid, uuid, text);
CREATE FUNCTION public.create_invoice_from_blend_ticket(p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text, p_below_cost_reason text DEFAULT NULL::text)
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
  IF v_quote_section_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_shares -> 'rows') AS r(value)
                  WHERE (r.value->>'price_override_cents') IS NULL
                    AND (r.value->>'share_acres')::numeric > 0) THEN
    SELECT jsonb_agg(jsonb_build_object(
             'line_id', z.id,
             'product_id', z.product_id,
             'product_name', z.product_name,
             'cost_cents', z.cost_cents)
           ORDER BY z.sequence_order, z.id)
      INTO v_zero_lines
      FROM (SELECT btp.id, btp.product_id, btp.sequence_order,
                   COALESCE(p.product_name, btp.product_name) AS product_name,
                   ROUND(p.current_cost * 100)::bigint AS cost_cents,
                   CASE WHEN public._blend_quote_pick_valid_20261020(
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
               AND p.current_cost > 0 AND p.current_cost < 'Infinity'::numeric) z
     WHERE z.price_cents = 0;
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
        'zero_lines', (SELECT jsonb_agg(e.value - 'cost_cents' ORDER BY e.ord)
                         FROM jsonb_array_elements(v_zero_lines) WITH ORDINALITY AS e(value, ord)));
      IF NOT public.is_admin() THEN
        -- Cost is admin-only (Mason, 2026-10-15): a non-admin's detail never carries it.
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = 'BELOW_COST_ADMIN_REQUIRED:' || (v_zero_line - 'locked_unit_cost_cents')::text;
      END IF;
      IF NULLIF(btrim(COALESCE(p_below_cost_reason, '')), '') IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = 'BELOW_COST_REASON_REQUIRED:' || v_zero_line::text;
      END IF;
    END IF;
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
        v_zero_quoted := v_price_source = 'quoted' AND v_unit_price = 0 AND v_btp.product_id IS NOT NULL;
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

REVOKE ALL ON FUNCTION public.create_invoice_from_blend_ticket(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invoice_from_blend_ticket(uuid, uuid, text, text) TO authenticated, service_role;

-- 6. The below-cost approval log accepts this operation (a superset of the live list).
ALTER TABLE public.below_cost_approvals
  DROP CONSTRAINT below_cost_approvals_operation_check,
  ADD CONSTRAINT below_cost_approvals_operation_check CHECK (operation = ANY (ARRAY['create_direct_order'::text, 'create_rush_order'::text, 'bulk_import_order'::text, 'update_order_items'::text, 'price_order'::text, 'save_invoice'::text, 'save_quote'::text, 'convert_quote_to_order'::text, 'draw_down_quote'::text, 'restore_quote_version'::text, 'duplicate_quote'::text, 'create_invoice_from_blend_ticket'::text]));

-- 3. Staff pick a quoted price for a ticket line.
CREATE FUNCTION public.set_blend_ticket_product_quote_price(
  p_blend_ticket_product_id uuid,
  p_quote_item_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor        uuid := auth.uid();
  v_ticket       public.blend_tickets%ROWTYPE;
  v_line         public.blend_ticket_products%ROWTYPE;
  v_section      uuid;
  v_quote_item   public.quote_items%ROWTYPE;
  v_price_cents  bigint;
  v_fingerprint  text;
  v_replay       jsonb;
  v_result       jsonb;
  v_rows         int;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: set_blend_ticket_product_quote_price requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin or sales role required to pick a blend-ticket price';
  END IF;

  -- Lock the ticket first, as billing does, so a pick and a bill of the same ticket serialize.
  SELECT bt.* INTO v_ticket
    FROM public.blend_tickets bt
    JOIN public.blend_ticket_products btp ON btp.blend_ticket_id = bt.id
   WHERE btp.id = p_blend_ticket_product_id
     AND bt.deleted_at IS NULL
   FOR UPDATE OF bt;
  IF NOT FOUND THEN RAISE EXCEPTION 'BLEND_TICKET_PRODUCT_NOT_FOUND'; END IF;

  -- Own name (Mason, 2026-10-06, narrowed 2026-10-13), the same test billing applies, and before
  -- the replay lookup: a sales rep picks prices only on a ticket that is theirs or unassigned.
  IF NOT public.is_admin()
     AND v_ticket.salesman_id IS NOT NULL
     AND v_ticket.salesman_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
  END IF;

  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor,
    'blend_ticket_product_id', p_blend_ticket_product_id,
    'quote_item_id', p_quote_item_id
  ));
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'set_blend_ticket_product_quote_price', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  IF v_ticket.payment_status IS DISTINCT FROM 'unbilled' OR v_ticket.order_link_status = 'linked' THEN
    RAISE EXCEPTION 'BLEND_TICKET_QUOTE_PRICE_LOCKED: only an unbilled blend ticket that is not linked to an order can take a picked price';
  END IF;

  SELECT * INTO v_line FROM public.blend_ticket_products WHERE id = p_blend_ticket_product_id FOR UPDATE;
  -- The line must still belong to the ticket locked above (a concurrent edit could have moved it).
  IF NOT FOUND OR v_line.blend_ticket_id IS DISTINCT FROM v_ticket.id THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRODUCT_NOT_FOUND';
  END IF;
  IF v_ticket.job_id IS NOT NULL THEN
    -- The job's section counts only when it belongs to the job's own quote (as billing requires).
    SELECT j.quote_section_id INTO v_section
      FROM public.jobs j
      JOIN public.quote_sections qs ON qs.id = j.quote_section_id
     WHERE j.id = v_ticket.job_id
       AND qs.quote_id = j.quote_id;
  END IF;
  SELECT * INTO v_quote_item FROM public.quote_items WHERE id = p_quote_item_id;
  -- The picked line must be on this ticket's job quote section, for this line's product, on a
  -- live quote of the ticket's own customer, with a usable price (zero or above, finite, whole
  -- cents). The same rule decides at billing whether the stored pick still counts.
  IF NOT FOUND
     OR v_quote_item.section_id IS DISTINCT FROM v_section
     OR v_quote_item.product_id IS DISTINCT FROM v_line.product_id
     OR NOT (v_quote_item.price_per_unit >= 0
             AND v_quote_item.price_per_unit < 'Infinity'::numeric
             AND v_quote_item.price_per_unit = ROUND(v_quote_item.price_per_unit, 2))
     OR NOT public._blend_quote_pick_valid_20261020(
              v_section, v_ticket.customer_id, v_line.product_id, (v_quote_item.price_per_unit * 100)::bigint) THEN
    RAISE EXCEPTION 'BLEND_TICKET_QUOTE_PRICE_INVALID_CHOICE: that price is not on this ticket''s quote for this product';
  END IF;
  v_price_cents := (v_quote_item.price_per_unit * 100)::bigint;

  -- The line triggers still refuse a ticket with a live invoice, an order link or an
  -- application record; this changes the one price column and nothing else. The flag lets the
  -- column guard (_guard_blend_ticket_price_pick_20261020) accept this one write.
  PERFORM set_config('app.crx_blend_quote_price_pick', '1', true);
  UPDATE public.blend_ticket_products
     SET unit_price_cents = v_price_cents
   WHERE id = v_line.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM set_config('app.crx_blend_quote_price_pick', '', true);
  IF v_rows <> 1 THEN RAISE EXCEPTION 'BLEND_TICKET_PRODUCT_NOT_UPDATED'; END IF;

  INSERT INTO public.activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id)
  VALUES (
    'blend_ticket_price_picked',
    'Quoted price $' || to_char(v_price_cents / 100.0, 'FM999999990.00') || ' picked for '
      || COALESCE(v_line.product_name, 'a product') || ' on blend ticket ' || COALESCE(v_ticket.ticket_number, ''),
    v_actor, 'blend_ticket', v_ticket.id
  );

  v_result := jsonb_build_object(
    'success', true,
    'blend_ticket_id', v_ticket.id,
    'blend_ticket_product_id', v_line.id,
    'quote_item_id', v_quote_item.id,
    'unit_price_cents', v_price_cents
  );
  PERFORM public.save_idempotency(p_idempotency_key, 'set_blend_ticket_product_quote_price', v_result);
  PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'set_blend_ticket_product_quote_price', v_fingerprint);
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_blend_ticket_product_quote_price(uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_blend_ticket_product_quote_price(uuid, uuid, uuid, text) TO authenticated, service_role;

DO $postflight$
BEGIN
  IF to_regclass('pg_temp.blend_ticket_pricing_guards_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.blend_ticket_pricing_guards_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'BLEND_TICKET_PRICING_NOT_IN_TRANSACTION: stop: apply this file as one transaction';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.create_invoice_from_blend_ticket(uuid,uuid,text,text)', 'create_invoice_from_blend_ticket', 'aae1f885847766f6510426cc164a6eed', 'jsonb', ARRAY['authenticated', 'postgres', 'service_role'], true, 'plpgsql'),
        ('public._create_order_from_blend_ticket_replay_impl_20261015(uuid,text,date,text,uuid,text)', '_create_order_from_blend_ticket_replay_impl_20261015', '4b5ea386b9be7c70c240ffb8efae08e6', 'json', ARRAY['postgres'], true, 'plpgsql'),
        ('public.set_blend_ticket_product_quote_price(uuid,uuid,uuid,text)', 'set_blend_ticket_product_quote_price', '0fb39fc92185c02645a1e3b877c5a63e', 'jsonb', ARRAY['authenticated', 'postgres', 'service_role'], true, 'plpgsql'),
        ('public._blend_tier_price_cents_20261020(integer,numeric,numeric,numeric)', '_blend_tier_price_cents_20261020', '44e3957c991c1ce20961713051d58e5d', 'bigint', ARRAY['postgres'], false, 'sql'),
        ('public._blend_quote_pick_valid_20261020(uuid,uuid,uuid,bigint)', '_blend_quote_pick_valid_20261020', '1c6d054540071835fdf145185cc46f5c', 'boolean', ARRAY['postgres'], false, 'sql'),
        ('public._guard_blend_ticket_price_pick_20261020()', '_guard_blend_ticket_price_pick_20261020', '92155bb50d09deab206c4ed79caf8a79', 'trigger', ARRAY['postgres'], false, 'plpgsql')
      ) AS pin(sig, name, body_md5, ret, acl, definer, lang)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc q JOIN pg_namespace n ON n.oid = q.pronamespace
             WHERE n.nspname = 'public' AND q.proname = pin.name) <> 1
        OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
        OR p.proowner <> 'postgres'::regrole
        OR p.prosecdef IS DISTINCT FROM pin.definer
        OR p.prorettype <> pin.ret::regtype
        OR p.prolang <> (SELECT oid FROM pg_language WHERE lanname = pin.lang)
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM pin.acl
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_BLEND_TICKET_PRICING_DRIFT: a pricing function is not exactly as reviewed';
  END IF;
  -- CREATE OR REPLACE kept the order body's identity; the invoice function has exactly the new
  -- argument list (the old three-argument one is gone: the per-name count above is 1).
  IF pg_get_function_arguments(to_regprocedure('public.create_invoice_from_blend_ticket(uuid,uuid,text,text)'))
       IS DISTINCT FROM 'p_blend_ticket_id uuid, p_created_by uuid, p_idempotency_key text DEFAULT NULL::text, p_below_cost_reason text DEFAULT NULL::text'
     OR (SELECT order_oid FROM pg_temp.blend_ticket_pricing_guards_tx)
       IS DISTINCT FROM to_regprocedure('public._create_order_from_blend_ticket_replay_impl_20261015(uuid,text,date,text,uuid,text)')::oid THEN
    RAISE EXCEPTION 'POSTFLIGHT_BLEND_TICKET_PRICING_OID_CHANGED';
  END IF;
  IF (SELECT count(*) FROM pg_constraint c
       WHERE c.conrelid = 'public.below_cost_approvals'::regclass
         AND c.conname = 'below_cost_approvals_operation_check'
         AND c.convalidated
         AND pg_get_constraintdef(c.oid) = 'CHECK ((operation = ANY (ARRAY[''create_direct_order''::text, ''create_rush_order''::text, ''bulk_import_order''::text, ''update_order_items''::text, ''price_order''::text, ''save_invoice''::text, ''save_quote''::text, ''convert_quote_to_order''::text, ''draw_down_quote''::text, ''restore_quote_version''::text, ''duplicate_quote''::text, ''create_invoice_from_blend_ticket''::text])))') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_BELOW_COST_OPERATION_CHECK';
  END IF;
  -- Exactly one enabled guard trigger, as written.
  IF (SELECT count(*) FROM pg_trigger t
       WHERE t.tgrelid = 'public.blend_ticket_products'::regclass
         AND t.tgname = 'blend_ticket_products_price_pick_guard_20261020'
         AND t.tgenabled = 'O'
         AND t.tgfoid = to_regprocedure('public._guard_blend_ticket_price_pick_20261020()')
         AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER blend_ticket_products_price_pick_guard_20261020 BEFORE INSERT OR UPDATE OF unit_price_cents, product_id, blend_ticket_id ON public.blend_ticket_products FOR EACH ROW EXECUTE FUNCTION _guard_blend_ticket_price_pick_20261020()') <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_BLEND_TICKET_PRICE_PICK_GUARD';
  END IF;
  -- The rule itself, on fixed inputs.
  IF public._blend_tier_price_cents_20261020(2, 10.00, NULL, NULL) IS DISTINCT FROM 1000::bigint
     OR public._blend_tier_price_cents_20261020(3, 10.00, 9.00, 8.50) IS DISTINCT FROM 850::bigint
     OR public._blend_tier_price_cents_20261020(2, 10.00, 0, NULL) IS DISTINCT FROM 1000::bigint
     OR public._blend_tier_price_cents_20261020(1, NULL, 9.00, 8.00) IS NOT NULL
     OR public._blend_tier_price_cents_20261020(2, 0, NULL, NULL) IS NOT NULL
     OR public._blend_tier_price_cents_20261020(1, 'NaN', NULL, NULL) IS NOT NULL
     OR public._blend_tier_price_cents_20261020(1, 0.004, NULL, NULL) IS NOT NULL
     OR public._blend_tier_price_cents_20261020(1, 10.004, NULL, NULL) IS NOT NULL
     OR public._blend_tier_price_cents_20261020(2, 10.00, 9.005, NULL) IS DISTINCT FROM 1000::bigint THEN
    RAISE EXCEPTION 'POSTFLIGHT_BLEND_TIER_PRICE_RULE';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END
$postflight$;
