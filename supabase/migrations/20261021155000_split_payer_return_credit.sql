-- Written 2026-10-21. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: a field owner billed through a split (a customer other than the order's, such as a
--   landlord) can return goods and get its own return credit, and no payer can return another
--   payer's share.
--   20261021150000 lets create_split_invoices_from_order bill a field owner who is not the order's
--   customer. The return path still required the return's customer to equal the order's
--   (RETURN_ORDER_CUSTOMER_MISMATCH in create_return, receive_return and issue_return_credit), and
--   guard_invoice_terminal_order refused a credit memo for that customer on that order, so such a
--   customer had no return credit at all (Sol on PR #1010, BLOCKER; Mason 2026-10-21: "Build split
--   returns first").
--   * create_return, receive_return, issue_return_credit (their private intent bodies, renamed in
--     20260812130145): the returner may be the order's customer or a customer a posted governed
--     split invoice of the order bills (_return_customer_is_split_payer).
--   * Share mode (_return_customer_line_share): when the returner is not the order's customer, or
--     the order has split-billing evidence (needs_split_billing, a field allocation, or a governed
--     split invoice), every payer, the order's customer included, may return only the quantity it
--     was billed on that line (posted, overdue or paid; not a credit memo) minus its other open
--     returns, and its credit is what is left of its own billed cents for that quantity, so
--     returning its whole share credits exactly what it was billed. Otherwise the line keeps
--     today's rule (delivered quantity, order price) unchanged.
--   * receive_return and issue_return_credit re-check, under the per-order-line advisory locks the
--     credit implementation takes (a source void or edit try-takes the same locks), that each share
--     line's stored credit is still exactly what create_return would price it at now; when an earlier
--     return of the line was cancelled or rejected after it was created, it is not, and they refuse
--     (RETURN_SPLIT_SHARE_REPRICED: cancel and recreate the return) instead of crediting a stale price.
--   * issue_return_credit re-checks every line's share under the same locks, opens a private
--     claim around the unchanged credit implementation for every order-linked return, and on a
--     share-mode return refuses any credited unit without source lineage
--     (RETURN_SPLIT_CREDIT_UNBACKED).
--   * guard_invoice_terminal_order admits that customer's credit memo only inside the claim, and
--     afterwards (apply, unapply, void) only as the credit memo of a return for that order and
--     customer, with its customer unchanged and never as a split invoice.
--   * The split invoice writer (_create_split_invoices_from_order_provenance_impl_20260719) bills an
--     order line with no unit as 'ea', the unit its return carries: it copied the empty unit, and the
--     credit (_issue_return_credit_impl) refuses a source line whose unit differs from the return's
--     (RETURN_CREDIT_UNIT_MISMATCH), so such a split payer could never be credited (Sol on PR #1010).
--     create_return also refuses a split line whose posted sale lines carry another unit with that
--     same code, up front, before anything is restocked.
--   * guard_mono_invoice_split_billing_post refused every posted invoice without a split group on an
--     order with split-billing evidence, so no return on a split order could be credited, even the
--     order customer's. It now admits a credit memo created posted inside issue_return_credit's
--     claim for this transaction, order and customer (issue_return_credit opens the claim for every
--     order-linked return credit, after capping each line at the returner's billed share).
--
-- NOT CHANGED: the six public return wrappers (actor and intent binding, 20260812130145), the credit
--   implementation _issue_return_credit_impl and its header helper (COGS lineage already follows the
--   returner's own invoice lines), _receive_return_impl_20260714 (restock), apply_credit_memo_to_invoice
--   (it already requires the memo's and the invoice's customer to match), every trigger, and the public
--   split function create_split_invoices_from_order. Each re-emitted function is its verbatim current body plus only the hunks marked
--   "Split-payer return". No rows change. CREATE OR REPLACE keeps each OID, owner and exact ACL; the
--   postflight proves it.
--
-- NEW: public.return_credit_customer_claims (RLS deny-all, no Data API grant), the STABLE helpers
--   _return_customer_is_split_payer and _return_customer_line_share (EXECUTE for no Data API role),
--   and two read-only lookups for the Returns screen, get_split_payer_return_orders and
--   get_return_line_allowances (STABLE SECURITY DEFINER, admin or sales_rep, EXECUTE for
--   authenticated), because a sales rep cannot read another customer's invoices; on a split order
--   they answer only a caller who may read the payer's invoice under invoices_select (an admin, or
--   the rep who created it or is its salesperson), so they reveal nothing that policy hides.
--
-- ORDERING: strict. Apply after 20261021150000_split_invoice_cross_customer_lineage (the guard body
--   replaced here is that migration's).

SET LOCAL lock_timeout = '5s';
-- pg_get_triggerdef omits a schema only when it is on the search_path; fix it for this
-- transaction so the definition pins read the same on every client.
SET LOCAL search_path = public, pg_temp;

CREATE TEMP TABLE split_payer_return_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
       to_regprocedure('public._create_return_intent_impl_20260812(jsonb,jsonb,text)')::oid AS create_oid,
       to_regprocedure('public._receive_return_intent_impl_20260812(uuid,uuid,text)')::oid AS receive_oid,
       to_regprocedure('public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)')::oid AS issue_oid,
       to_regprocedure('public.guard_invoice_terminal_order()')::oid AS guard_oid,
       to_regprocedure('public.guard_mono_invoice_split_billing_post()')::oid AS mono_oid,
       to_regprocedure('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)')::oid AS split_oid;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.split_payer_return_tx') IS NULL THEN
    RAISE EXCEPTION 'SPLIT_PAYER_RETURN_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.split_payer_return_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'SPLIT_PAYER_RETURN_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- A re-run finds the new objects and stops.
  IF to_regclass('public.return_credit_customer_claims') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public'
                   AND p.proname IN ('_return_customer_is_split_payer', '_return_customer_line_share',
                                     'get_split_payer_return_orders', 'get_return_line_allowances')) THEN
    RAISE EXCEPTION 'PREFLIGHT_SPLIT_PAYER_RETURN_ALREADY_APPLIED: the claims table or a share helper already exists';
  END IF;
  -- The six functions this file replaces, pinned CR-insensitively to their current bodies, with
  -- one overload each, owner, SECURITY DEFINER, search_path and an EXECUTE ACL of postgres only.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('_create_return_intent_impl_20260812', 'public._create_return_intent_impl_20260812(jsonb,jsonb,text)', '80b3f9fd43c3ab3e56eae2935c525dcd'),
        ('_receive_return_intent_impl_20260812', 'public._receive_return_intent_impl_20260812(uuid,uuid,text)', 'c43084461f30b9305bd0bb19f6605d89'),
        ('_issue_return_credit_intent_impl_20260812', 'public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)', '1e9647da071aa1a53f3add5e38515da8'),
        ('guard_invoice_terminal_order', 'public.guard_invoice_terminal_order()', '3ce8e2202d902ed90ba3370dfc829e47'),
        ('guard_mono_invoice_split_billing_post', 'public.guard_mono_invoice_split_billing_post()', 'e643f573e529a7117c10ff1e8b89fad0'),
        ('_create_split_invoices_from_order_provenance_impl_20260719', 'public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)', 'f671f1a3f5406cff52aedd8a5fb40b31')
      ) AS pin(name, sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc q JOIN pg_namespace n ON n.oid = q.pronamespace
             WHERE n.nspname = 'public' AND q.proname = pin.name) <> 1
        OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
        OR p.proowner <> 'postgres'::regrole
        OR NOT p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM ARRAY['postgres']::text[]
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_SPLIT_PAYER_RETURN_DRIFT: a function this file replaces differs from its reviewed form (apply 20261021150000 first)';
  END IF;
  -- What the change relies on, pinned to the bodies read live on 2026-10-21: the public return
  -- wrappers that call the intent bodies, the credit and receive implementations, the credit-memo
  -- application, and the split functions and triggers that create and protect governed split invoices.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.create_return(jsonb,jsonb,text)', 'd535f68ffd3ee478d0516a0eb65830f9'),
        ('public.receive_return(uuid,uuid,text)', 'bd4c4e9975c059301e0b3ee21678012f'),
        ('public.issue_return_credit(uuid,uuid,text)', 'f3fcab7980d1640501fc038b0c8ac902'),
        ('public._issue_return_credit_impl(uuid,uuid,text)', 'a1e3183c3b962501b810e64333313a7c'),
        ('public._issue_return_credit_header_only_impl_20260825(uuid,uuid,text)', '4b32da9a350ca22e9dece371b1985493'),
        ('public._receive_return_impl_20260714(uuid,uuid,text)', '731471d04684bb5897c57dffdd329272'),
        ('public.apply_credit_memo_to_invoice(uuid,uuid,bigint,uuid,text)', 'bcc242c8715aaed81b9455fbc905237f'),
        ('public.require_split_invoice_creation_claim()', 'e73daae16c5ff5432644060f2b34f925'),
        ('public.guard_split_invoice_provenance_identity()', '639875d6641556c78c25d633c67821f1'),
        ('public.create_split_invoices_from_order(uuid,uuid,text,text)', '0f1e36e8536fc56f08fcf6071ea76da8')
      ) AS pin(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_SPLIT_PAYER_RETURN_DEPENDENCY_DRIFT: a return or split function differs from its reviewed body';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'trg_guard_invoice_terminal_order' AND t.tgrelid = 'public.invoices'::regclass AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER trg_guard_invoice_terminal_order BEFORE INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_invoice_terminal_order()'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'require_split_invoice_creation_claim' AND t.tgrelid = 'public.invoices'::regclass AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER require_split_invoice_creation_claim BEFORE INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION require_split_invoice_creation_claim()'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'guard_split_invoice_provenance_identity' AND t.tgrelid = 'public.invoices'::regclass AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER guard_split_invoice_provenance_identity BEFORE DELETE OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_split_invoice_provenance_identity()'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'guard_mono_invoice_split_billing_post' AND t.tgrelid = 'public.invoices'::regclass AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER guard_mono_invoice_split_billing_post BEFORE INSERT OR UPDATE OF status, order_id, invoice_group_id ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_mono_invoice_split_billing_post()'
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_SPLIT_PAYER_RETURN_TRIGGER_DRIFT: an invoice trigger differs from its reviewed form';
  END IF;
  -- The governed-split facts this change trusts cannot be manufactured by a caller.
  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY['public.split_invoice_creation_claims', 'public.split_invoice_provenance']) AS tbl
      CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS api_role
      CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS priv
     WHERE has_table_privilege(api_role, tbl, priv)
        OR (priv IN ('INSERT', 'UPDATE') AND has_any_column_privilege(api_role, tbl, priv))
  ) OR EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid IN ('public.split_invoice_creation_claims'::regclass, 'public.split_invoice_provenance'::regclass)
       AND NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_SPLIT_PRIVATE_TABLE_EXPOSED: a Data API role can write a split claim or provenance row';
  END IF;
END
$preflight$;

-- The claim issue_return_credit opens, for one transaction, around the credit for a field owner who
-- is not the order's customer. Written and deleted only inside that SECURITY DEFINER function.
CREATE TABLE public.return_credit_customer_claims (
  return_id      uuid PRIMARY KEY REFERENCES public.returns(id) ON DELETE RESTRICT,
  order_id       uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  customer_id    uuid NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.return_credit_customer_claims ENABLE ROW LEVEL SECURITY;

CREATE POLICY return_credit_customer_claims_deny_all
ON public.return_credit_customer_claims
FOR ALL TO PUBLIC
USING (false)
WITH CHECK (false);

REVOKE ALL ON TABLE public.return_credit_customer_claims FROM PUBLIC, anon, authenticated, service_role;

-- True when a posted (or overdue or paid) governed split invoice of this order bills this customer:
-- the invoice names the customer and the order, and its private provenance row names that same
-- invoice, order, customer and group.
CREATE FUNCTION public._return_customer_is_split_payer(p_order_id uuid, p_customer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.split_invoice_provenance p
      JOIN public.invoices i
        ON i.id = p.invoice_id
       AND i.order_id = p.order_id
       AND i.customer_id = p.customer_id
       AND i.invoice_group_id = p.invoice_group_id
     WHERE p.order_id = p_order_id
       AND p.customer_id = p_customer_id
       AND i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL
       AND i.status IN ('posted', 'overdue', 'paid')
  );
$function$;

-- One order line, one returning customer. share_mode: the returner is not the order's customer, or
-- the order has split-billing evidence (needs_split_billing, a field allocation, or a governed split
-- invoice in any status), so every payer, the order's customer included, returns only what it was
-- billed. billed_qty / billed_cents: what the returner was billed for the line (same product and
-- unit, as the credit's source lots match them) on this order's posted (or overdue or paid)
-- invoices, not credit memos; for a customer other than the order's, only its governed split
-- invoices count. other_returned_*: the returner's open returns of the line (not rejected,
-- cancelled or deleted), except p_exclude_return_id.
CREATE FUNCTION public._return_customer_line_share(
  p_order_id uuid, p_order_item_id uuid, p_customer_id uuid, p_exclude_return_id uuid
)
RETURNS TABLE (
  share_mode boolean,
  billed_qty numeric,
  billed_cents bigint,
  other_returned_qty numeric,
  other_returned_cents bigint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  WITH ord AS (
    SELECT o.customer_id,
           COALESCE(o.needs_split_billing, false)
             OR EXISTS (
               SELECT 1 FROM public.order_item_field_allocations oifa
                 JOIN public.order_items alloc_oi ON alloc_oi.id = oifa.order_item_id
                WHERE alloc_oi.order_id = o.id
             )
             OR EXISTS (SELECT 1 FROM public.split_invoice_provenance p WHERE p.order_id = o.id)
             AS split_evidence
      FROM public.orders o WHERE o.id = p_order_id
  ), billed AS (
    SELECT i.id AS invoice_id, i.customer_id, i.invoice_group_id, ii.quantity, ii.extended_cents
      FROM public.invoice_items ii
      JOIN public.invoices i ON i.id = ii.invoice_id
      JOIN public.order_items oi ON oi.id = ii.order_item_id
     WHERE ii.order_item_id = p_order_item_id
       AND ii.product_id = oi.product_id
       AND ii.unit_size IS NOT DISTINCT FROM coalesce(oi.unit_size, 'ea')
       AND ii.quantity > 0
       AND i.order_id = p_order_id
       AND i.invoice_type <> 'credit_memo'
       AND i.deleted_at IS NULL
       AND i.status IN ('posted', 'overdue', 'paid')
  ), own AS (
    SELECT b.quantity, b.extended_cents
      FROM billed b
     WHERE b.customer_id = p_customer_id
       AND (
         p_customer_id IS NOT DISTINCT FROM (SELECT customer_id FROM ord)
         OR EXISTS (
           SELECT 1 FROM public.split_invoice_provenance p
            WHERE p.invoice_id = b.invoice_id
              AND p.order_id = p_order_id
              AND p.customer_id = p_customer_id
              AND p.invoice_group_id = b.invoice_group_id
         )
       )
  ), other_returns AS (
    SELECT ri.quantity, ri.extended_cents
      FROM public.return_items ri
      JOIN public.returns r ON r.id = ri.return_id
     WHERE ri.order_item_id = p_order_item_id
       AND r.order_id = p_order_id
       AND r.customer_id = p_customer_id
       AND r.deleted_at IS NULL
       AND r.status NOT IN ('rejected', 'cancelled')
       AND r.id IS DISTINCT FROM p_exclude_return_id
  )
  SELECT
    p_customer_id IS DISTINCT FROM (SELECT customer_id FROM ord)
      OR COALESCE((SELECT split_evidence FROM ord), false),
    coalesce((SELECT sum(quantity) FROM own), 0),
    coalesce((SELECT sum(extended_cents) FROM own), 0)::bigint,
    coalesce((SELECT sum(quantity) FROM other_returns), 0),
    coalesce((SELECT sum(extended_cents) FROM other_returns), 0)::bigint;
$function$;

REVOKE ALL ON FUNCTION public._return_customer_is_split_payer(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._return_customer_line_share(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Read-only lookups for the Returns screen, which create_return's staff (admin and sales_rep) use: a
-- sales rep cannot read another customer's invoices, so the screen asks the server which orders a
-- customer was split-billed on and how much of each delivered line that customer may still return,
-- by the same rule create_return enforces. They read and return nothing else.
CREATE FUNCTION public.get_split_payer_return_orders(p_customer_id uuid)
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  -- Only orders on which every active (posted, overdue or paid) invoice billing this customer is
  -- one the caller may read under invoices_select (an admin, or the rep who created it or is its
  -- salesperson); a voided or deleted invoice the caller can read grants nothing.
  RETURN QUERY
    SELECT DISTINCT p.order_id
      FROM public.split_invoice_provenance p
      JOIN public.orders o ON o.id = p.order_id
     WHERE p.customer_id = p_customer_id
       AND o.customer_id IS DISTINCT FROM p_customer_id
       AND o.deleted_at IS NULL
       AND public._return_customer_is_split_payer(p.order_id, p_customer_id)
       AND (public.is_admin() OR NOT EXISTS (
         SELECT 1 FROM public.invoices hidden
          WHERE hidden.order_id = p.order_id
            AND hidden.customer_id = p_customer_id
            AND hidden.invoice_type <> 'credit_memo'
            AND hidden.deleted_at IS NULL
            AND hidden.status IN ('posted', 'overdue', 'paid')
            AND NOT (hidden.created_by IS NOT DISTINCT FROM auth.uid()
                     OR hidden.salesman_id IS NOT DISTINCT FROM auth.uid())
       ));
END;
$function$;

CREATE FUNCTION public.get_return_line_allowances(p_order_id uuid, p_customer_id uuid)
RETURNS TABLE (order_item_id uuid, share_mode boolean, returnable_qty numeric, share_left_qty numeric, share_left_cents bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
#variable_conflict use_column
DECLARE
  v_order_customer_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
  SELECT o.customer_id INTO v_order_customer_id
    FROM public.orders o WHERE o.id = p_order_id AND o.deleted_at IS NULL;
  IF NOT FOUND OR (
    v_order_customer_id IS DISTINCT FROM p_customer_id
    AND NOT public._return_customer_is_split_payer(p_order_id, p_customer_id)
  ) THEN
    RETURN;
  END IF;
  -- A share-mode allowance is derived from the returner's active invoices on this order, so it is
  -- shown only to a caller who may read every one of them under invoices_select (an admin, or the
  -- rep who created it or is its salesperson); a voided or deleted invoice the caller can read
  -- grants nothing, and anyone else gets nothing for a split order.
  IF NOT public.is_admin()
     AND (
       v_order_customer_id IS DISTINCT FROM p_customer_id
       OR EXISTS (
         SELECT 1 FROM public.order_items soi
          CROSS JOIN LATERAL public._return_customer_line_share(p_order_id, soi.id, p_customer_id, NULL) ss
          WHERE soi.order_id = p_order_id AND ss.share_mode
       )
     )
     AND (
       NOT EXISTS (
         SELECT 1 FROM public.invoices vi
          WHERE vi.order_id = p_order_id
            AND vi.customer_id = p_customer_id
            AND vi.invoice_type <> 'credit_memo'
            AND vi.deleted_at IS NULL
            AND vi.status IN ('posted', 'overdue', 'paid')
       )
       OR EXISTS (
         SELECT 1 FROM public.invoices hidden
          WHERE hidden.order_id = p_order_id
            AND hidden.customer_id = p_customer_id
            AND hidden.invoice_type <> 'credit_memo'
            AND hidden.deleted_at IS NULL
            AND hidden.status IN ('posted', 'overdue', 'paid')
            AND NOT (hidden.created_by IS NOT DISTINCT FROM auth.uid()
                     OR hidden.salesman_id IS NOT DISTINCT FROM auth.uid())
       )
     ) THEN
    RETURN;
  END IF;
  -- Delivered less every open return of the line; in share mode also the returner's own billed
  -- share less its own open returns (create_return's two caps). In share mode the credit follows
  -- the returner's own billed cents, not the order price, and create_return prices each return from
  -- what is left of them: share_left_qty and share_left_cents are the returner's billed quantity and
  -- cents less its open returns', so returning all of share_left_qty credits exactly
  -- share_left_cents (the screen shows these, not a per-unit average a later return would not get).
  RETURN QUERY
    SELECT oi.id,
           s.share_mode,
           greatest(0, CASE WHEN s.share_mode
                            THEN least(d.left_qty, s.billed_qty - s.other_returned_qty)
                            ELSE d.left_qty END),
           CASE WHEN s.share_mode THEN greatest(0, s.billed_qty - s.other_returned_qty) END,
           CASE WHEN s.share_mode THEN greatest(0, s.billed_cents - s.other_returned_cents)::bigint END
      FROM public.order_items oi
      CROSS JOIN LATERAL (
        SELECT coalesce(oi.quantity_delivered, 0) - coalesce((
                 SELECT sum(ri.quantity)
                   FROM public.return_items ri
                   JOIN public.returns r ON r.id = ri.return_id
                  WHERE ri.order_item_id = oi.id
                    AND r.deleted_at IS NULL
                    AND r.status NOT IN ('rejected', 'cancelled')
               ), 0) AS left_qty
      ) d
      CROSS JOIN LATERAL public._return_customer_line_share(p_order_id, oi.id, p_customer_id, NULL) s
     WHERE oi.order_id = p_order_id
       AND coalesce(oi.quantity_delivered, 0) > 0
     ORDER BY oi.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_split_payer_return_orders(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_return_line_allowances(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_split_payer_return_orders(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_return_line_allowances(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public._create_return_intent_impl_20260812(p_return jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_return_id uuid;
  v_return_number text;
  v_order_id uuid;
  v_customer_id uuid;
  v_order_status text;
  v_item jsonb;
  v_order_item record;
  v_qty numeric;
  v_prior_qty numeric;
  v_count integer := 0;
  v_existing jsonb;
  -- Phase 3 addition: sorted advisory locks cover all products in this request.
  v_product_ids uuid[];
  -- Split-payer return (20261021155000): see the order check and the per-line share below.
  v_order_customer_id uuid;
  v_share record;
  v_extended bigint;
  v_unit_price bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'create_return');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  v_customer_id := nullif(p_return->>'customer_id', '')::uuid;
  v_order_id := nullif(p_return->>'order_id', '')::uuid;
  IF v_customer_id IS NULL THEN RAISE EXCEPTION 'CUSTOMER_REQUIRED'; END IF;
  IF v_order_id IS NULL THEN RAISE EXCEPTION 'RETURN_ORDER_REQUIRED'; END IF;
  IF coalesce(btrim(p_return->>'reason'), '') = '' THEN RAISE EXCEPTION 'REASON_REQUIRED'; END IF;
  IF jsonb_array_length(COALESCE(p_items, '[]'::jsonb)) = 0 THEN RAISE EXCEPTION 'ITEMS_REQUIRED'; END IF;

  -- Split-payer return (20261021155000): the order's customer, or a customer a posted governed
  -- split invoice of this order bills (a field owner such as a landlord), may return its goods.
  SELECT status, customer_id INTO v_order_status, v_order_customer_id FROM public.orders
  WHERE id = v_order_id AND deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR (
    v_order_customer_id IS DISTINCT FROM v_customer_id
    AND NOT public._return_customer_is_split_payer(v_order_id, v_customer_id)
  ) THEN RAISE EXCEPTION 'RETURN_ORDER_CUSTOMER_MISMATCH'; END IF;
  IF v_order_status IN ('voided', 'cancelled') THEN
    RAISE EXCEPTION 'RETURN_SOURCE_ORDER_INACTIVE';
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_items) item WHERE nullif(item->>'order_item_id', '') IS NULL) THEN
    RAISE EXCEPTION 'RETURN_ORDER_ITEM_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
     (SELECT count(DISTINCT item->>'order_item_id') FROM jsonb_array_elements(p_items) item) THEN
    RAISE EXCEPTION 'DUPLICATE_RETURN_ORDER_ITEM';
  END IF;

  PERFORM 1
  FROM public.order_items oi
  JOIN jsonb_array_elements(p_items) item
    ON oi.id = (item->>'order_item_id')::uuid
  WHERE oi.order_id = v_order_id
  ORDER BY oi.id
  FOR UPDATE OF oi;
  IF (SELECT count(*) FROM jsonb_array_elements(p_items)) <>
     (SELECT count(*) FROM public.order_items oi
      JOIN jsonb_array_elements(p_items) item ON oi.id = (item->>'order_item_id')::uuid
      WHERE oi.order_id = v_order_id) THEN
    RAISE EXCEPTION 'RETURN_ORDER_ITEM_MISMATCH';
  END IF;

  -- Phase 3 addition: UUID-order locks and a policy re-read happen after all
  -- source order-item locks/validation and before creating any return rows.
  SELECT array_agg(DISTINCT oi.product_id ORDER BY oi.product_id)
    INTO v_product_ids
  FROM public.order_items oi
  JOIN jsonb_array_elements(p_items) item
    ON oi.id = (item->>'order_item_id')::uuid
  WHERE oi.order_id = v_order_id;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  PERFORM public.assert_phase3_return_policy(v_product_ids);

  v_return_number := public.next_return_number();
  INSERT INTO public.returns (
    return_number, customer_id, order_id, reason, reason_notes, notes, requested_by, status
  ) VALUES (
    v_return_number, v_customer_id, v_order_id, p_return->>'reason',
    p_return->>'reason_notes', p_return->>'notes', v_actor, 'requested'
  ) RETURNING id INTO v_return_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    SELECT * INTO v_order_item
    FROM public.order_items
    WHERE id = (v_item->>'order_item_id')::uuid AND order_id = v_order_id;

    v_qty := coalesce((v_item->>'quantity')::numeric, 0);
    IF v_qty <= 0 THEN RAISE EXCEPTION 'RETURN_QUANTITY_MUST_BE_POSITIVE'; END IF;
    IF coalesce(v_order_item.quantity_delivered, 0) <= 0 THEN
      RAISE EXCEPTION 'RETURN_SOURCE_NOT_DELIVERED';
    END IF;
    IF v_order_item.price_per_unit IS NULL THEN
      RAISE EXCEPTION 'RETURN_SOURCE_PRICE_MISSING';
    END IF;

    SELECT coalesce(sum(ri.quantity), 0) INTO v_prior_qty
    FROM public.return_items ri
    JOIN public.returns r ON r.id = ri.return_id
    WHERE ri.order_item_id = v_order_item.id
      AND r.deleted_at IS NULL
      AND r.status NOT IN ('rejected', 'cancelled');

    IF v_prior_qty + v_qty > v_order_item.quantity_delivered THEN
      RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS_DELIVERED';
    END IF;

    -- Split-payer return (20261021155000): on a split order, or when the returner is not the
    -- order's customer, the returner may return only what it was billed, and its credit is what is
    -- left of its own billed cents for that quantity, so its full share credits exactly.
    SELECT * INTO v_share
      FROM public._return_customer_line_share(v_order_id, v_order_item.id, v_customer_id, v_return_id);
    IF v_share.share_mode THEN
      -- A share-mode return stores a price derived from the returner's own invoices on this order,
      -- so a non-admin may create one only when invoices_select lets it read every active invoice
      -- billing the returner here (it created it or is its salesperson), as the Returns lookups do.
      IF NOT public.is_admin() AND EXISTS (
        SELECT 1 FROM public.invoices hidden
         WHERE hidden.order_id = v_order_id
           AND hidden.customer_id = v_customer_id
           AND hidden.invoice_type <> 'credit_memo'
           AND hidden.deleted_at IS NULL
           AND hidden.status IN ('posted', 'overdue', 'paid')
           AND NOT (hidden.created_by IS NOT DISTINCT FROM auth.uid()
                    OR hidden.salesman_id IS NOT DISTINCT FROM auth.uid())
      ) THEN RAISE EXCEPTION 'RETURN_SPLIT_INVOICE_NOT_VISIBLE'; END IF;
      -- A posted sale line of this order line whose unit differs from the return's (an order line
      -- with no unit is returned as 'ea', and its invoice lines carry no unit) can never back the
      -- credit: _issue_return_credit_impl refuses every such return with this same code. Refuse it
      -- here, before anything is restocked, rather than as "not billed".
      IF EXISTS (
        SELECT 1
          FROM public.invoice_items ii
          JOIN public.invoices i ON i.id = ii.invoice_id
         WHERE ii.order_item_id = v_order_item.id
           AND ii.product_id = v_order_item.product_id
           AND ii.quantity > 0
           AND i.invoice_type <> 'credit_memo'
           AND i.status IN ('posted', 'overdue', 'paid')
           AND i.deleted_at IS NULL
           AND ii.unit_size IS DISTINCT FROM coalesce(v_order_item.unit_size, 'ea')
      ) THEN RAISE EXCEPTION 'RETURN_CREDIT_UNIT_MISMATCH'; END IF;
      IF v_share.billed_qty <= 0 THEN RAISE EXCEPTION 'RETURN_SPLIT_SHARE_NOT_BILLED'; END IF;
      IF v_share.other_returned_qty + v_qty > v_share.billed_qty THEN
        RAISE EXCEPTION 'RETURN_QUANTITY_EXCEEDS_BILLED_SHARE';
      END IF;
      v_extended := greatest(0,
        round(v_share.billed_cents * (v_share.other_returned_qty + v_qty) / v_share.billed_qty)::bigint
        - v_share.other_returned_cents);
      IF v_share.other_returned_cents + v_extended > v_share.billed_cents THEN
        RAISE EXCEPTION 'RETURN_CREDIT_EXCEEDS_BILLED_SHARE';
      END IF;
      -- The unit price the return and its credit memo show is the returner's own billed rate, not
      -- the order price (a split invoice may bill a share at another rate).
      v_unit_price := round(v_share.billed_cents / v_share.billed_qty)::bigint;
    ELSE
      v_extended := round(v_qty * v_order_item.price_per_unit * 100)::bigint;
      v_unit_price := round(v_order_item.price_per_unit * 100)::bigint;
    END IF;

    INSERT INTO public.return_items (
      return_id, order_item_id, product_id, product_name, quantity, unit,
      unit_price_cents, extended_cents, condition, restock, sort_order, notes
    ) VALUES (
      v_return_id, v_order_item.id, v_order_item.product_id, v_order_item.product_name,
      v_qty, coalesce(v_order_item.unit_size, 'ea'),
      v_unit_price,  -- Split-payer return (20261021155000): priced above
      v_extended,
      coalesce(v_item->>'condition', 'unopened'),
      coalesce((v_item->>'restock')::boolean, false),
      coalesce((v_item->>'sort_order')::integer, v_count), v_item->>'notes'
    );
    v_count := v_count + 1;
  END LOOP;

  INSERT INTO public.activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'return_requested', 'Return ' || v_return_number || ' requested for ' || v_count || ' product(s)',
    v_actor, 'return', v_return_id, v_customer_id
  );

  v_existing := jsonb_build_object(
    'success', true, 'return_id', v_return_id,
    'return_number', v_return_number, 'item_count', v_count
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'create_return', v_existing);
  END IF;
  RETURN v_existing;
END;
$function$;

CREATE OR REPLACE FUNCTION public._receive_return_intent_impl_20260812(p_return_id uuid, p_received_by uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_order_id uuid;
  v_customer_id uuid;
  v_order_customer_id uuid;
  v_order_status text;
  v_is_legacy_unlinked boolean := false;
  -- Phase 3 addition: this wrapper takes the sorted multi-product lock set.
  v_product_ids uuid[];
  -- Split-payer return (20261021155000): see the per-line locks below.
  v_lock_order_item_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_received_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'receive_return');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT r.order_id, r.customer_id INTO v_order_id, v_customer_id
  FROM public.returns r
  WHERE r.id = p_return_id
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found: %', p_return_id; END IF;

  IF v_order_id IS NOT NULL THEN
    SELECT o.status, o.customer_id INTO v_order_status, v_order_customer_id
    FROM public.orders o
    WHERE o.id = v_order_id AND o.deleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND OR v_order_status IN ('voided', 'cancelled') THEN
      RAISE EXCEPTION 'RETURN_SOURCE_ORDER_INACTIVE';
    END IF;
    -- Split-payer return (20261021155000): or a customer a posted governed split invoice of this
    -- order bills.
    IF v_order_customer_id IS DISTINCT FROM v_customer_id
       AND NOT public._return_customer_is_split_payer(v_order_id, v_customer_id) THEN
      RAISE EXCEPTION 'RETURN_ORDER_CUSTOMER_MISMATCH';
    END IF;

    -- Split-payer return (20261021155000): on a split return, hold the per-order-line locks the
    -- credit takes before checking the share, so a source invoice cannot be voided or edited (that
    -- path try-takes them and fails fast) between this check and the restock; a change committed
    -- first is seen by the check below.
    IF v_order_customer_id IS DISTINCT FROM v_customer_id OR EXISTS (
      SELECT 1
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_customer_line_share(
          v_order_id, ri.order_item_id, v_customer_id, p_return_id
        ) s
       WHERE ri.return_id = p_return_id AND s.share_mode
    ) THEN
      FOR v_lock_order_item_id IN
        SELECT DISTINCT ri.order_item_id
          FROM public.return_items ri
         WHERE ri.return_id = p_return_id AND ri.order_item_id IS NOT NULL
         ORDER BY ri.order_item_id
      LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_order_item_id::text, 361));
      END LOOP;
      -- Each share line's stored credit must still be exactly what create_return would price it at
      -- now: an earlier return of the line cancelled or rejected after this one was created leaves it
      -- stale, so refuse before restocking (cancel and recreate the return to reprice it).
      IF EXISTS (
        SELECT 1
          FROM public.return_items ri
          CROSS JOIN LATERAL public._return_customer_line_share(
            v_order_id, ri.order_item_id, v_customer_id, p_return_id
          ) s
         WHERE ri.return_id = p_return_id
           AND s.share_mode
           AND s.billed_qty > 0
           AND (
             ri.extended_cents IS DISTINCT FROM greatest(0,
               round(s.billed_cents * (s.other_returned_qty + ri.quantity) / NULLIF(s.billed_qty, 0))::bigint
               - s.other_returned_cents)
             -- and the unit price shown is the returner's billed rate
             OR ri.unit_price_cents IS DISTINCT FROM round(s.billed_cents / NULLIF(s.billed_qty, 0))::bigint
           )
      ) THEN RAISE EXCEPTION 'RETURN_SPLIT_SHARE_REPRICED'; END IF;
    END IF;

    -- Older linked rows were writable through table policies, so re-derive and
    -- verify every source fact before the legacy implementation can restock.
    IF NOT EXISTS (
      SELECT 1 FROM public.return_items ri WHERE ri.return_id = p_return_id
    ) OR EXISTS (
      SELECT 1
      FROM public.return_items ri
      LEFT JOIN public.order_items oi
        ON oi.id = ri.order_item_id AND oi.order_id = v_order_id
      -- Split-payer return (20261021155000): the returner's billed share of the line.
      LEFT JOIN LATERAL public._return_customer_line_share(
        v_order_id, ri.order_item_id, v_customer_id, p_return_id
      ) s ON true
      WHERE ri.return_id = p_return_id
        AND (
          ri.order_item_id IS NULL
          OR oi.id IS NULL
          OR oi.price_per_unit IS NULL
          OR ri.product_id IS DISTINCT FROM oi.product_id
          OR ri.unit IS DISTINCT FROM coalesce(oi.unit_size, 'ea')
          OR ri.quantity <= 0
          OR ri.quantity > coalesce(oi.quantity_delivered, 0)
          OR (NOT s.share_mode
              AND (ri.unit_price_cents IS DISTINCT FROM round(oi.price_per_unit * 100)::bigint
                   OR ri.extended_cents IS DISTINCT FROM round(ri.quantity * oi.price_per_unit * 100)::bigint))
          -- Split-payer return (20261021155000): within the returner's billed share, in quantity and
          -- in cents (create_return priced it from what was left of its billed cents).
          OR (s.share_mode AND (
            s.billed_qty <= 0
            OR ri.extended_cents < 0
            OR s.other_returned_qty + ri.quantity > s.billed_qty
            OR s.other_returned_cents + ri.extended_cents > s.billed_cents
          ))
        )
    ) OR (
      SELECT count(*) <> count(DISTINCT ri.order_item_id)
      FROM public.return_items ri
      WHERE ri.return_id = p_return_id
    ) OR EXISTS (
      SELECT 1
      FROM public.return_items current_ri
      JOIN public.order_items oi
        ON oi.id = current_ri.order_item_id AND oi.order_id = v_order_id
      WHERE current_ri.return_id = p_return_id
        AND (
          SELECT coalesce(sum(other_ri.quantity), 0)
          FROM public.return_items other_ri
          JOIN public.returns other_r ON other_r.id = other_ri.return_id
          WHERE other_ri.order_item_id = oi.id
            AND other_r.deleted_at IS NULL
            AND other_r.status NOT IN ('rejected', 'cancelled')
        ) > coalesce(oi.quantity_delivered, 0)
    ) THEN
      RAISE EXCEPTION 'RETURN_SOURCE_NOT_VERIFIED';
    END IF;
  ELSE
    -- Exact one-time compatibility for the sole approved production RMA that
    -- predates order-line capture. IDs and immutable source/money fields were
    -- verified read-only immediately before this migration was authored.
    v_is_legacy_unlinked := p_return_id = '0cb556ed-467a-4949-866d-8d9edbb09522'::uuid
      AND EXISTS (
        SELECT 1
        FROM public.returns r
        WHERE r.id = p_return_id
          AND r.return_number = 'RMA-2026-0001'
          AND r.customer_id = 'df6087cb-232f-4962-bb33-c74580a06935'::uuid
          AND r.requested_by = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
          AND r.approved_by = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
          AND r.reason = 'overstock'
          AND r.created_at = timestamptz '2026-04-30 20:48:18.967975+00'
          AND r.requested_at = timestamptz '2026-04-30 20:48:18.967975+00'
          AND r.approved_at = timestamptz '2026-07-10 16:45:29.044351+00'
          AND r.total_credit_cents = 0
      )
      AND 1 = (
        SELECT count(*) FROM public.return_items ri WHERE ri.return_id = p_return_id
      )
      AND EXISTS (
        SELECT 1
        FROM public.return_items ri
        WHERE ri.return_id = p_return_id
          AND ri.id = 'c4f6cc7d-0bbd-4c25-8bc0-c2c9e84aaadd'::uuid
          AND ri.order_item_id IS NULL
          AND ri.product_id = 'fad3ea45-cd8c-4bb8-b0ce-8a515941586c'::uuid
          AND ri.product_name = 'Gen Capture LFR: (Batallion LFC, Seguro) - 2.5 Gal'
          AND ri.quantity = 15.00
          AND ri.unit = 'ea'
          AND ri.unit_price_cents = 7597
          AND ri.extended_cents = 113955
          AND ri.condition = 'unopened'
          AND ri.restock = true
          AND ri.restocked = false
          AND ri.sort_order = 0
          AND ri.notes IS NULL
          AND ri.created_at = timestamptz '2026-04-30 20:48:19.173027+00'
      );
    IF NOT v_is_legacy_unlinked THEN
      RAISE EXCEPTION 'RETURN_SOURCE_NOT_VERIFIED';
    END IF;
  END IF;

  -- Phase 3 addition: policy is checked after all source verification and
  -- immediately before invoking the untouched private receive implementation.
  SELECT array_agg(DISTINCT ri.product_id ORDER BY ri.product_id)
    INTO v_product_ids
    FROM public.return_items ri
   WHERE ri.return_id = p_return_id;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  PERFORM public.assert_phase3_return_policy(v_product_ids);
  RETURN public._receive_return_impl_20260714(p_return_id, v_actor, p_idempotency_key);
END;
$function$;

CREATE OR REPLACE FUNCTION public._issue_return_credit_intent_impl_20260812(p_return_id uuid, p_actor_id uuid, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing jsonb;
  v_order_id uuid;
  v_customer_id uuid;
  v_order_customer_id uuid;
  v_order_status text;
  v_is_legacy_unlinked boolean := false;
  -- Phase 3 addition: this wrapper takes the sorted multi-product lock set.
  v_product_ids uuid[];
  -- Split-payer return (20261021155000): see the re-check before the credit below.
  v_lock_order_item_id uuid;
  v_result jsonb;
  v_split_return boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_actor_id IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'ADMIN_REQUIRED'; END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'issue_return_credit');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT r.order_id, r.customer_id INTO v_order_id, v_customer_id
  FROM public.returns r
  WHERE r.id = p_return_id AND r.status = 'received'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RETURN_NOT_CREDITABLE'; END IF;

  IF v_order_id IS NULL THEN
    -- The same exact production record may be credited after receive_return
    -- advances it to received. No other source-free/caller-priced row qualifies.
    v_is_legacy_unlinked := p_return_id = '0cb556ed-467a-4949-866d-8d9edbb09522'::uuid
      AND EXISTS (
        SELECT 1
        FROM public.returns r
        WHERE r.id = p_return_id
          AND r.return_number = 'RMA-2026-0001'
          AND r.customer_id = 'df6087cb-232f-4962-bb33-c74580a06935'::uuid
          AND r.requested_by = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
          AND r.approved_by = '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f'::uuid
          AND r.reason = 'overstock'
          AND r.created_at = timestamptz '2026-04-30 20:48:18.967975+00'
          AND r.requested_at = timestamptz '2026-04-30 20:48:18.967975+00'
          AND r.approved_at = timestamptz '2026-07-10 16:45:29.044351+00'
          AND r.total_credit_cents = 0
      )
      AND 1 = (
        SELECT count(*) FROM public.return_items ri WHERE ri.return_id = p_return_id
      )
      AND EXISTS (
        SELECT 1
        FROM public.return_items ri
        WHERE ri.return_id = p_return_id
          AND ri.id = 'c4f6cc7d-0bbd-4c25-8bc0-c2c9e84aaadd'::uuid
          AND ri.order_item_id IS NULL
          AND ri.product_id = 'fad3ea45-cd8c-4bb8-b0ce-8a515941586c'::uuid
          AND ri.product_name = 'Gen Capture LFR: (Batallion LFC, Seguro) - 2.5 Gal'
          AND ri.quantity = 15.00
          AND ri.unit = 'ea'
          AND ri.unit_price_cents = 7597
          AND ri.extended_cents = 113955
          AND ri.condition = 'unopened'
          AND ri.restock = true
          AND ri.sort_order = 0
          AND ri.notes IS NULL
          AND ri.created_at = timestamptz '2026-04-30 20:48:19.173027+00'
      );
    IF NOT v_is_legacy_unlinked THEN
      RAISE EXCEPTION 'RETURN_SOURCE_NOT_VERIFIED';
    END IF;
  ELSE
    SELECT o.status, o.customer_id INTO v_order_status, v_order_customer_id
    FROM public.orders o
    WHERE o.id = v_order_id AND o.deleted_at IS NULL
    FOR UPDATE;
    IF NOT FOUND OR v_order_status IN ('voided', 'cancelled') THEN
      RAISE EXCEPTION 'RETURN_SOURCE_ORDER_INACTIVE';
    END IF;
    -- Split-payer return (20261021155000): or a customer a posted governed split invoice of this
    -- order bills.
    IF v_order_customer_id IS DISTINCT FROM v_customer_id
       AND NOT public._return_customer_is_split_payer(v_order_id, v_customer_id) THEN
      RAISE EXCEPTION 'RETURN_ORDER_CUSTOMER_MISMATCH';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.return_items ri WHERE ri.return_id = p_return_id
    ) OR EXISTS (
      SELECT 1
      FROM public.return_items ri
      LEFT JOIN public.order_items oi
        ON oi.id = ri.order_item_id AND oi.order_id = v_order_id
      -- Split-payer return (20261021155000): the returner's billed share of the line.
      LEFT JOIN LATERAL public._return_customer_line_share(
        v_order_id, ri.order_item_id, v_customer_id, p_return_id
      ) s ON true
      WHERE ri.return_id = p_return_id
        AND (
          ri.order_item_id IS NULL
          OR oi.id IS NULL
          OR oi.price_per_unit IS NULL
          OR ri.product_id IS DISTINCT FROM oi.product_id
          OR ri.unit IS DISTINCT FROM coalesce(oi.unit_size, 'ea')
          OR ri.quantity <= 0
          OR ri.quantity > coalesce(oi.quantity_delivered, 0)
          OR (NOT s.share_mode
              AND (ri.unit_price_cents IS DISTINCT FROM round(oi.price_per_unit * 100)::bigint
                   OR ri.extended_cents IS DISTINCT FROM round(ri.quantity * oi.price_per_unit * 100)::bigint))
          -- Split-payer return (20261021155000): within the returner's billed share, in quantity and
          -- in cents (create_return priced it from what was left of its billed cents).
          OR (s.share_mode AND (
            s.billed_qty <= 0
            OR ri.extended_cents < 0
            OR s.other_returned_qty + ri.quantity > s.billed_qty
            OR s.other_returned_cents + ri.extended_cents > s.billed_cents
          ))
        )
    ) OR (
      SELECT count(*) <> count(DISTINCT ri.order_item_id)
      FROM public.return_items ri
      WHERE ri.return_id = p_return_id
    ) OR EXISTS (
      SELECT 1
      FROM public.return_items current_ri
      JOIN public.order_items oi
        ON oi.id = current_ri.order_item_id AND oi.order_id = v_order_id
      WHERE current_ri.return_id = p_return_id
        AND (
          SELECT coalesce(sum(other_ri.quantity), 0)
          FROM public.return_items other_ri
          JOIN public.returns other_r ON other_r.id = other_ri.return_id
          WHERE other_ri.order_item_id = oi.id
            AND other_r.deleted_at IS NULL
            AND other_r.status NOT IN ('rejected', 'cancelled')
        ) > coalesce(oi.quantity_delivered, 0)
    ) THEN RAISE EXCEPTION 'RETURN_SOURCE_NOT_VERIFIED'; END IF;
  END IF;

  -- Phase 3 addition: policy is checked after all source verification and
  -- immediately before invoking the untouched private credit implementation.
  SELECT array_agg(DISTINCT ri.product_id ORDER BY ri.product_id)
    INTO v_product_ids
    FROM public.return_items ri
   WHERE ri.return_id = p_return_id;
  PERFORM public.lock_phase3_product_policy_products(v_product_ids);
  PERFORM public.assert_phase3_return_policy(v_product_ids);

  -- Split-payer return (20261021155000): re-check every line's billed share under the same
  -- per-order-line locks the credit takes (a source void or edit try-takes them), so the share
  -- cannot shrink between this check and the credit. The credit memo is created inside this
  -- return's claim: the invoice guards admit a return credit memo on a split order, or for a field
  -- owner who is not the order's customer, only inside it. On a split return every credited unit
  -- must come from the returner's own billed line (no zero-cost remainder without source lineage).
  IF v_order_id IS NOT NULL THEN
    FOR v_lock_order_item_id IN
      SELECT DISTINCT ri.order_item_id
        FROM public.return_items ri
       WHERE ri.return_id = p_return_id AND ri.order_item_id IS NOT NULL
       ORDER BY ri.order_item_id
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_order_item_id::text, 361));
    END LOOP;
    IF EXISTS (
      SELECT 1
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_customer_line_share(
          v_order_id, ri.order_item_id, v_customer_id, p_return_id
        ) s
       WHERE ri.return_id = p_return_id
         AND s.share_mode
         AND (
           s.billed_qty <= 0
           OR s.other_returned_qty + ri.quantity > s.billed_qty
           OR s.other_returned_cents + ri.extended_cents > s.billed_cents
         )
    ) THEN RAISE EXCEPTION 'RETURN_CREDIT_EXCEEDS_BILLED_SHARE'; END IF;
    -- And each share line's stored credit is still exactly what create_return would price it at
    -- now: an earlier return of the line cancelled or rejected after this one was created leaves it
    -- stale, so refuse rather than credit a stale price (cancel and recreate the return).
    IF EXISTS (
      SELECT 1
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_customer_line_share(
          v_order_id, ri.order_item_id, v_customer_id, p_return_id
        ) s
       WHERE ri.return_id = p_return_id
         AND s.share_mode
         AND s.billed_qty > 0
         AND (
           ri.extended_cents IS DISTINCT FROM greatest(0,
             round(s.billed_cents * (s.other_returned_qty + ri.quantity) / NULLIF(s.billed_qty, 0))::bigint
             - s.other_returned_cents)
           -- and the unit price shown is the returner's billed rate
           OR ri.unit_price_cents IS DISTINCT FROM round(s.billed_cents / NULLIF(s.billed_qty, 0))::bigint
         )
    ) THEN RAISE EXCEPTION 'RETURN_SPLIT_SHARE_REPRICED'; END IF;
    v_split_return := v_order_customer_id IS DISTINCT FROM v_customer_id OR EXISTS (
      SELECT 1
        FROM public.return_items ri
        CROSS JOIN LATERAL public._return_customer_line_share(
          v_order_id, ri.order_item_id, v_customer_id, p_return_id
        ) s
       WHERE ri.return_id = p_return_id AND s.share_mode
    );

    INSERT INTO public.return_credit_customer_claims (return_id, order_id, customer_id)
    VALUES (p_return_id, v_order_id, v_customer_id);
    v_result := public._issue_return_credit_impl(p_return_id, v_actor, p_idempotency_key);
    DELETE FROM public.return_credit_customer_claims
     WHERE return_id = p_return_id AND transaction_id = pg_current_xact_id();
    IF v_split_return AND EXISTS (
      SELECT 1
        FROM public.returns r
        JOIN public.invoice_items ii ON ii.invoice_id = r.credit_invoice_id
       WHERE r.id = p_return_id
         AND ii.quantity < 0
         AND ii.return_credit_source_item_id IS NULL
    ) THEN RAISE EXCEPTION 'RETURN_SPLIT_CREDIT_UNBACKED'; END IF;
    RETURN v_result;
  END IF;
  RETURN public._issue_return_credit_impl(p_return_id, v_actor, p_idempotency_key);
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_invoice_terminal_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_status text;
  v_order_number text;
  v_order_deleted_at timestamptz;
  v_order_customer_id uuid;
  v_canonical_cancel_cleanup boolean := false;
  v_canonical_void_cleanup boolean := false;
  v_canonical_delete_cleanup boolean := false;
  v_existing_accounting_update boolean := false;
  v_valid_delivery_lineage boolean := false;
  v_valid_completed_delivery boolean := false;
  v_has_writer_capability boolean := false;
  v_has_poster_capability boolean := false;
  -- Governed split (20261021150000): see the lineage test below.
  v_split_identity_kept boolean := false;
  v_governed_split_customer boolean := false;
  -- Split-payer return credit (20261021155000): see the lineage test below.
  v_split_payer_credit boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
  ) THEN
    RAISE EXCEPTION 'INVOICE_SOURCE_LINEAGE_IMMUTABLE: order_id and delivery_id cannot change after invoice creation';
  END IF;

  IF NEW.order_id IS NULL THEN
    IF NEW.delivery_id IS NOT NULL THEN
      RAISE EXCEPTION 'INVOICE_DELIVERY_ORDER_REQUIRED: a delivery-linked invoice must retain its source order';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT status, order_number, deleted_at, customer_id
      INTO v_order_status, v_order_number, v_order_deleted_at, v_order_customer_id
      FROM public.orders
     WHERE id = NEW.order_id
     FOR UPDATE;
  ELSE
    SELECT status, order_number, deleted_at, customer_id
      INTO v_order_status, v_order_number, v_order_deleted_at, v_order_customer_id
      FROM public.orders
     WHERE id = NEW.order_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot attach an invoice to missing order %', NEW.order_id;
  END IF;
  -- Governed split (20261021150000): a split invoice (invoice_group_id set) may name a field owner
  -- other than the customer of its order, and only that invoice. While the split RPC creates or
  -- totals it: inside its claim for this transaction and order, for a customer the field split of
  -- this order bills (the billing-default customers of a field, or the customer of the field when
  -- it has none, as the split implementation resolves them). Afterwards: only as the invoice its
  -- private provenance row names. Its customer and group never change through this exception.
  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id AND NEW.invoice_group_id IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      v_split_identity_kept := true;
    ELSE
      v_split_identity_kept := NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
        AND NEW.invoice_group_id IS NOT DISTINCT FROM OLD.invoice_group_id;
      v_governed_split_customer := v_split_identity_kept AND EXISTS (
        SELECT 1
          FROM public.split_invoice_provenance p
         WHERE p.invoice_id = NEW.id
           AND p.order_id = NEW.order_id
           AND p.customer_id = NEW.customer_id
           AND p.invoice_group_id = NEW.invoice_group_id
      );
    END IF;
    IF v_split_identity_kept AND NOT v_governed_split_customer THEN
      v_governed_split_customer := EXISTS (
        SELECT 1
          FROM public.split_invoice_creation_claims claim
         WHERE claim.transaction_id = pg_current_xact_id()
           AND claim.order_id = NEW.order_id
      ) AND EXISTS (
        SELECT 1
          FROM public.order_item_field_allocations oifa
          JOIN public.order_items oi ON oi.id = oifa.order_item_id
         WHERE oi.order_id = NEW.order_id
           AND (
             EXISTS (
               SELECT 1 FROM public.field_billing_defaults fbd
                WHERE fbd.field_id = oifa.field_id
                  AND fbd.customer_id = NEW.customer_id
             )
             OR (
               NOT EXISTS (SELECT 1 FROM public.field_billing_defaults fbd WHERE fbd.field_id = oifa.field_id)
               AND EXISTS (
                 SELECT 1 FROM public.fields f
                  WHERE f.id = oifa.field_id
                    AND f.customer_id = NEW.customer_id
               )
             )
           )
      );
    END IF;
  END IF;
  -- Split-payer return credit (20261021155000): the credit memo for a return by a field owner who
  -- is not the order's customer. Created: only inside issue_return_credit's claim for this
  -- transaction, order and customer. Afterwards (apply, unapply, void): only as the credit memo of a
  -- return for that order and customer, with its customer unchanged and never as a split invoice.
  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id AND NOT v_governed_split_customer
     AND NEW.invoice_type = 'credit_memo' AND NEW.invoice_group_id IS NULL
     AND (TG_OP = 'INSERT' OR (
       OLD.invoice_type = 'credit_memo'
       AND OLD.invoice_group_id IS NULL
       AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
     )) THEN
    v_split_payer_credit := EXISTS (
      SELECT 1
        FROM public.return_credit_customer_claims claim
       WHERE claim.transaction_id = pg_current_xact_id()
         AND claim.order_id = NEW.order_id
         AND claim.customer_id = NEW.customer_id
    ) OR (TG_OP = 'UPDATE' AND EXISTS (
      SELECT 1
        FROM public.returns r
       WHERE r.credit_invoice_id = NEW.id
         AND r.order_id = NEW.order_id
         AND r.customer_id = NEW.customer_id
    ));
  END IF;
  IF NEW.customer_id IS DISTINCT FROM v_order_customer_id AND NOT v_governed_split_customer
     AND NOT v_split_payer_credit THEN
    RAISE EXCEPTION 'INVOICE_ORDER_CUSTOMER_LINEAGE_INVALID: invoice and order customer must match';
  END IF;

  IF NEW.delivery_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.deliveries d
       WHERE d.id = NEW.delivery_id
         AND d.order_id = NEW.order_id
         AND d.customer_id = NEW.customer_id
         AND d.deleted_at IS NULL
    ), EXISTS (
      SELECT 1 FROM public.deliveries d
       WHERE d.id = NEW.delivery_id
         AND d.order_id = NEW.order_id
         AND d.customer_id = NEW.customer_id
         AND d.status = 'completed'
         AND d.deleted_at IS NULL
    ) INTO v_valid_delivery_lineage, v_valid_completed_delivery;
    IF NOT v_valid_delivery_lineage THEN
      RAISE EXCEPTION 'INVOICE_DELIVERY_LINEAGE_INVALID: delivery, order, and customer must match';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.invoice_delivery_recovery_capabilities c
     WHERE c.transaction_id = txid_current()
       AND c.purpose = 'writer'
       AND c.delivery_id = NEW.delivery_id
       AND c.actor_id = auth.uid()
  ), EXISTS (
    SELECT 1 FROM public.invoice_delivery_recovery_capabilities c
     WHERE c.transaction_id = txid_current()
       AND c.purpose = 'poster'
       AND c.delivery_id = NEW.delivery_id
       AND c.actor_id = auth.uid()
  ) INTO v_has_writer_capability, v_has_poster_capability;

  IF TG_OP = 'UPDATE' THEN
    v_canonical_cancel_cleanup :=
      OLD.status IN ('draft', 'unposted')
      AND NEW.status = 'cancelled'
      AND NEW.total_amount_cents = 0
      AND NEW.paid_amount_cents = 0
      AND NEW.prepay_applied_cents = 0
      AND NEW.write_off_cents = 0
      AND NEW.credit_applied_cents = 0
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

    v_canonical_void_cleanup :=
      OLD.status NOT IN ('cancelled', 'voided')
      AND NEW.status = 'voided'
      AND NEW.total_amount_cents = 0
      AND NEW.paid_amount_cents = 0
      AND NEW.prepay_applied_cents = 0
      AND NEW.write_off_cents = 0
      AND NEW.credit_applied_cents = 0
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

    v_canonical_delete_cleanup :=
      OLD.deleted_at IS NULL
      AND NEW.deleted_at IS NOT NULL
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_amount_cents IS NOT DISTINCT FROM OLD.total_amount_cents
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;

    -- A posted invoice may legitimately survive an order cancellation. Keep
    -- payment state, due dates, and other accounting metadata maintainable,
    -- while forbidding a draft from being activated or any source/amount rewrite.
    v_existing_accounting_update :=
      OLD.status IN ('posted', 'overdue', 'paid')
      AND NEW.status IN ('posted', 'overdue', 'paid')
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.invoice_number IS NOT DISTINCT FROM OLD.invoice_number
      AND NEW.invoice_type IS NOT DISTINCT FROM OLD.invoice_type
      AND NEW.total_amount_cents IS NOT DISTINCT FROM OLD.total_amount_cents
      AND NEW.total_cost_cents IS NOT DISTINCT FROM OLD.total_cost_cents;
  END IF;

  -- Exact historical exception: only the canonical recovery writer/poster may
  -- touch a matching completed-delivery invoice on a soft-deleted, otherwise
  -- fulfilled order. Cancelled and voided orders never receive this bypass.
  IF v_order_deleted_at IS NOT NULL
     AND v_order_status IN ('fulfilled', 'partially_fulfilled')
     AND v_valid_completed_delivery
     AND auth.uid() IS NOT NULL
     AND (
       (TG_OP = 'INSERT' AND v_has_writer_capability)
       OR (TG_OP = 'UPDATE' AND (v_has_writer_capability OR v_has_poster_capability))
     ) THEN
    RETURN NEW;
  END IF;

  IF v_order_status IN ('cancelled', 'voided') OR v_order_deleted_at IS NOT NULL THEN
    IF v_canonical_cancel_cleanup
       OR v_canonical_void_cleanup
       OR v_canonical_delete_cleanup
       OR v_existing_accounting_update THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ORDER_INVOICE_TERMINAL: cannot attach or update a nonterminal invoice on cancelled, voided, or deleted order %',
      COALESCE(v_order_number, NEW.order_id::text);
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_mono_invoice_split_billing_post()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_order_id    uuid;
  v_needs_split boolean := false;
  v_has_oifa    boolean := false;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.order_id IS NOT NULL
     AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    RAISE EXCEPTION
      'INVOICE_ORDER_IMMUTABLE: an existing order-backed invoice cannot clear or change order_id'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (OLD.status IN ('posted', 'paid', 'overdue')
          OR NEW.status IN ('posted', 'paid', 'overdue'))
     AND NEW.invoice_group_id IS DISTINCT FROM OLD.invoice_group_id THEN
    RAISE EXCEPTION
      'INVOICE_GROUP_IMMUTABLE_ON_POST: invoice_group_id cannot be assigned, cleared, or changed while an invoice enters or remains active'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status NOT IN ('posted', 'paid', 'overdue')
     OR (TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'paid', 'overdue')) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_order_id := COALESCE(NEW.order_id, OLD.order_id);
  ELSE
    v_order_id := NEW.order_id;
  END IF;

  IF v_order_id IS NULL THEN RETURN NEW; END IF;

  PERFORM 1
    FROM public.order_items oi
   WHERE oi.order_id = v_order_id
   ORDER BY oi.id
   FOR UPDATE;

  SELECT COALESCE(o.needs_split_billing, false)
    INTO v_needs_split
    FROM public.orders o
   WHERE o.id = v_order_id;

  SELECT EXISTS (
    SELECT 1
      FROM public.order_item_field_allocations oifa
      JOIN public.order_items oi ON oi.id = oifa.order_item_id
     WHERE oi.order_id = v_order_id
  ) INTO v_has_oifa;

  IF COALESCE(v_needs_split, false) OR COALESCE(v_has_oifa, false) THEN
    -- Split-payer return (20261021155000): a return's credit memo is not a mono bill of the order.
    -- issue_return_credit creates it posted, inside its claim for this transaction, order and
    -- customer, after capping every line at the returner's own billed share.
    IF TG_OP = 'INSERT'
       AND NEW.invoice_type = 'credit_memo'
       AND NEW.invoice_group_id IS NULL
       AND EXISTS (
         SELECT 1
           FROM public.return_credit_customer_claims claim
          WHERE claim.transaction_id = pg_current_xact_id()
            AND claim.order_id = v_order_id
            AND claim.customer_id = NEW.customer_id
       ) THEN
      RETURN NEW;
    END IF;
    IF NEW.invoice_group_id IS NULL THEN
      RAISE EXCEPTION
        'MONO_INVOICE_SPLIT_BILLING_CONFLICT: cannot post a mono invoice for an order with split-billing evidence; use the split invoice group flow instead'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM public.split_invoice_provenance p
       WHERE p.invoice_id = NEW.id
         AND p.order_id = v_order_id
         AND p.invoice_group_id = NEW.invoice_group_id
         AND p.customer_id = NEW.customer_id
         AND p.invoice_type = NEW.invoice_type
         AND p.season = NEW.season
         AND p.total_amount_cents = NEW.total_amount_cents
         AND p.content_claim = public._split_invoice_content_claim(NEW.id)
         AND p.contract_version = 'split_invoice_provenance_v1'
    ) OR EXISTS (
      SELECT 1
        FROM public.invoices member
       WHERE member.invoice_group_id = NEW.invoice_group_id
         AND member.order_id = v_order_id
         AND (
           member.deleted_at IS NOT NULL
           OR member.status IN ('voided', 'cancelled')
           OR NOT EXISTS (
             SELECT 1
               FROM public.split_invoice_provenance member_p
              WHERE member_p.invoice_id = member.id
                AND member_p.order_id = member.order_id
                AND member_p.invoice_group_id = member.invoice_group_id
                AND member_p.customer_id = member.customer_id
                AND member_p.invoice_type = member.invoice_type
                AND member_p.season = member.season
                AND member_p.total_amount_cents = member.total_amount_cents
                AND member_p.content_claim = public._split_invoice_content_claim(member.id)
                AND member_p.contract_version = 'split_invoice_provenance_v1'
           )
         )
    ) OR EXISTS (
      SELECT 1
        FROM public.split_invoice_provenance member_p
        LEFT JOIN public.invoices member ON member.id = member_p.invoice_id
       WHERE member_p.invoice_group_id = NEW.invoice_group_id
         AND member_p.order_id = v_order_id
         AND (
           member.id IS NULL
           OR member.order_id IS DISTINCT FROM member_p.order_id
           OR member.invoice_group_id IS DISTINCT FROM member_p.invoice_group_id
           OR member.customer_id IS DISTINCT FROM member_p.customer_id
           OR member.invoice_type IS DISTINCT FROM member_p.invoice_type
           OR member.season IS DISTINCT FROM member_p.season
           OR member.total_amount_cents IS DISTINCT FROM member_p.total_amount_cents
           OR member.deleted_at IS NOT NULL
           OR member.status IN ('voided', 'cancelled')
           OR member_p.content_claim IS DISTINCT FROM public._split_invoice_content_claim(member.id)
         )
    ) THEN
      RAISE EXCEPTION
        'SPLIT_INVOICE_GROUP_PROVENANCE_REQUIRED: active split-billing invoices must exactly match the private canonical group claim'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public._create_split_invoices_from_order_provenance_impl_20260719(p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT 'chemical_sale'::text, p_idempotency_key text DEFAULT NULL::text)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing text;
  v_order record;
  v_has_alloc boolean := false;
  v_existing_count int;
  v_delivery_count int;
  v_group_id uuid;
  v_invoice_id uuid;
  v_invoice_ids uuid[] := '{}';
  v_item record;
  v_alloc record;
  v_cust record;
  v_line_cents bigint;
  v_total_acres numeric;
  v_acre_pcts numeric[];
  v_field_cents bigint[];
  v_field_idx int;
  v_owner_ids uuid[];
  v_owner_pcts numeric[];
  v_owner_cents bigint[];
  v_owner_acres numeric;
  v_sum_pct numeric;
  v_oidx int;
  v_total_cents bigint;
  -- per-(customer, line) contribution accumulator; aggregated in pass 2.
  v_rows jsonb := '[]'::jsonb;
  -- Same Chicago business-date resolution as the single-invoice path above:
  -- every invoice minted by this call shares one explicit business date for
  -- both invoice_date and season, instead of the UTC CURRENT_DATE.
  v_business_date date := (now() AT TIME ZONE 'America/Chicago')::date;
BEGIN
  -- Authorization (mirror create_invoice_from_order): creating invoices is admin/sales_rep only.
  -- The old split path was unreachable (quote_sections.field_id was never persisted), so it had
  -- no gate; making it reachable means it MUST gate here or any authenticated user (driver/applicator)
  -- could mint invoices via this SECURITY DEFINER RPC (Codex P1).
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;

  -- Lock the order FIRST (mirror create_invoice_from_order's Codex-P1 lock): serializes against a
  -- concurrent delivery/invoice insert AND against a same-key retry, so the idempotency replay below
  -- runs only after any in-flight first call on this order has committed.
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found: %', p_order_id; END IF;

  -- Canonical operation-scoped idempotency replay, AFTER the order lock (draw_down_quote 2026-06-10
  -- pattern): a racing same-key retry blocks on the lock above, then resumes here and returns the
  -- cached invoice ids — instead of missing the still-uncommitted row pre-lock and then falsely
  -- erroring on the active-invoice guard below (Codex round-3 P2). result is a jsonb string; #>>'{}'
  -- extracts the bare "id1,id2" text so string_to_array sees no surrounding quotes.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result #>> '{}' INTO v_existing FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key AND operation = 'create_split_invoices_from_order';
    IF v_existing IS NOT NULL THEN RETURN string_to_array(v_existing, ',')::uuid[]; END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM order_item_field_allocations oifa
    JOIN order_items oi ON oi.id = oifa.order_item_id
    WHERE oi.order_id = p_order_id
  ) INTO v_has_alloc;

  -- No per-line field allocations anywhere on this order -> single invoice (unchanged).
  IF NOT v_has_alloc THEN
    v_invoice_id := create_invoice_from_order(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key);
    RETURN ARRAY[v_invoice_id];
  END IF;

  -- The split path inserts invoices DIRECTLY (the single-invoice path above delegates to
  -- create_invoice_from_order, which carries these guards). Replicate them so an allocated order
  -- that already has an active invoice or an active delivery cannot be double-billed (Codex P1).
  SELECT COUNT(*) INTO v_existing_count FROM invoices
    WHERE order_id = p_order_id AND status NOT IN ('voided', 'cancelled')
     AND invoice_type <> 'credit_memo'
     AND deleted_at IS NULL;
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'Active invoice already exists for order % (% existing invoice(s)). Void or cancel the existing invoice first if you need to recreate.', v_order.order_number, v_existing_count;
  END IF;
  SELECT COUNT(*) INTO v_delivery_count FROM deliveries
    -- U7 SAFE-SCOPE (#43): only an OPEN (scheduled/in_progress) delivery blocks now;
    -- a COMPLETED delivery on a field/acre-allocated order left NO auto-draft to
    -- double against (complete_delivery skipped the mono-bill), so the split can run.
    WHERE order_id = p_order_id AND status IN ('scheduled', 'in_progress');
  IF v_delivery_count > 0 THEN
    RAISE EXCEPTION 'Cannot create an order-level invoice for order % — it has % active delivery(ies); invoices are created per delivery on completion. Cancel/void those deliveries first to bill the whole order manually.', v_order.order_number, v_delivery_count;
  END IF;

  -- U7 SAFE-SCOPE (#43, refined R3 P2): this engine bills the WHOLE order (off
  -- order_items.total_price). Block ONLY the partial-delivery-in-progress case — a
  -- delivery has COMPLETED but product still remains — where whole-order billing would
  -- bill undelivered product. A PRE-delivery order (no completed delivery) can still be
  -- invoiced up front (invoice-on-order, like create_invoice_from_order), and a fully
  -- delivered order passes. (Per-delivery split billing would be a larger redesign.)
  IF EXISTS (SELECT 1 FROM deliveries WHERE order_id = p_order_id AND status = 'completed')
     AND EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id AND COALESCE(quantity_remaining, 0) > 0) THEN
    RAISE EXCEPTION 'Order % is partially delivered — split invoicing bills the whole order and would bill undelivered product. Finish delivering (or void the open deliveries) first.', v_order.order_number;
  END IF;

  -- Split-by-acre needs real line prices: a price-pending order would allocate $0 across fields
  -- (meaningless) and price_order cannot re-split a multi-customer invoice, so the single-invoice
  -- path's "create $0 drafts, sweep later" does not transfer here. Reject EXPLICITLY rather than
  -- silently produce no invoice (Codex round-2 P2). Price the order first, then split.
  IF EXISTS (SELECT 1 FROM order_items WHERE order_id = p_order_id AND pricing_pending) THEN
    RAISE EXCEPTION 'PRICING_INCOMPLETE: price the order before generating split invoices';
  END IF;

  -- Split-payer return (20261021155000): freeze who owns each allocated field, and in what
  -- percentages, for the rest of this transaction. Pass 1 reads the billing defaults field by field
  -- in separate statements, so an edit committed between them could mix old and new percentages,
  -- and the lineage guard checks only that each customer is still an owner (Codex App P1 on #1010).
  -- Same order as save_field (the field row, then its defaults): the allocated fields' rows, then
  -- the whole defaults table in SHARE mode (blocks every write to it until this split commits).
  PERFORM 1
     FROM fields f
    WHERE f.id IN (
      SELECT oifa.field_id
        FROM order_item_field_allocations oifa
        JOIN order_items oi ON oi.id = oifa.order_item_id
       WHERE oi.order_id = p_order_id
    )
    ORDER BY f.id
    FOR SHARE;
  LOCK TABLE public.field_billing_defaults IN SHARE MODE;

  -- PASS 1: compute every (customer, line) cents + prorated qty into v_rows.
  FOR v_item IN
    SELECT * FROM order_items WHERE order_id = p_order_id ORDER BY sort_order NULLS LAST, id
  LOOP
    v_line_cents := round(v_item.total_price * 100)::bigint;

    IF NOT EXISTS (SELECT 1 FROM order_item_field_allocations WHERE order_item_id = v_item.id) THEN
      -- Unallocated line: bill the whole line (incl. its full acres) to the order's own customer.
      v_rows := v_rows || jsonb_build_object(
        'c', v_order.customer_id, 'oi', v_item.id,
        'cents', v_line_cents, 'qty', COALESCE(v_item.total_units_needed, 0),
        'acres', COALESCE(v_item.acres, 0));
      CONTINUE;
    END IF;

    -- Split the line across its fields BY ACRES (stable order = field_id).
    SELECT sum(acres) INTO v_total_acres
      FROM order_item_field_allocations WHERE order_item_id = v_item.id;
    SELECT array_agg(acres / v_total_acres * 100 ORDER BY field_id) INTO v_acre_pcts
      FROM order_item_field_allocations WHERE order_item_id = v_item.id;
    v_field_cents := calculate_billing_splits(v_line_cents, v_acre_pcts);

    v_field_idx := 0;
    FOR v_alloc IN
      SELECT field_id, acres FROM order_item_field_allocations
      WHERE order_item_id = v_item.id ORDER BY field_id
    LOOP
      v_field_idx := v_field_idx + 1;

      -- Owners of this field, or fall back to the field's own customer at 100%.
      IF EXISTS (SELECT 1 FROM field_billing_defaults WHERE field_id = v_alloc.field_id) THEN
        SELECT array_agg(customer_id ORDER BY customer_id),
               array_agg(split_pct ORDER BY customer_id),
               sum(split_pct)
          INTO v_owner_ids, v_owner_pcts, v_sum_pct
          FROM field_billing_defaults WHERE field_id = v_alloc.field_id;
        IF v_sum_pct < 99.99 OR v_sum_pct > 100.01 THEN
          RAISE EXCEPTION 'FIELD_SPLIT_NOT_100: field % billing splits total % (must equal 100)',
            v_alloc.field_id, v_sum_pct;
        END IF;
        -- Normalize to sum EXACTLY 100 (order-preserving) so calculate_billing_splits — which assumes
        -- the percentages total 100 — cannot over-allocate within the tolerance band, e.g. 50.01+50.00
        -- would otherwise floor to MORE than the field's cents (Codex P2). v_owner_ids stays aligned.
        SELECT array_agg(p / v_sum_pct * 100 ORDER BY ord)
          INTO v_owner_pcts FROM unnest(v_owner_pcts) WITH ORDINALITY AS u(p, ord);
      ELSE
        SELECT ARRAY[customer_id] INTO v_owner_ids FROM fields WHERE id = v_alloc.field_id;
        v_owner_pcts := ARRAY[100::numeric];
      END IF;

      -- Split this field's portion among its owners BY split_pct (penny-exact).
      v_owner_cents := calculate_billing_splits(v_field_cents[v_field_idx], v_owner_pcts);

      FOR v_oidx IN 1..array_length(v_owner_ids, 1) LOOP
        -- This owner's slice of THIS field = field acres * their normalized pct. Bill that many
        -- acres to them (so split invoice items carry PRORATED acres, not the line's full acres —
        -- otherwise year-end/RUP acre reports double-count; Codex round-5 P2). qty is prorated by the
        -- same acre-share: well-defined even for a $0 line (v_total_acres > 0 for any allocated line)
        -- and it sums back to the line's total qty across owners.
        v_owner_acres := v_alloc.acres * v_owner_pcts[v_oidx] / 100;
        v_rows := v_rows || jsonb_build_object(
          'c', v_owner_ids[v_oidx], 'oi', v_item.id,
          'cents', v_owner_cents[v_oidx],
          'acres', round(v_owner_acres, 4),
          'qty', round(COALESCE(v_item.total_units_needed, 0) * v_owner_acres / v_total_acres, 4));
      END LOOP;
    END LOOP;
  END LOOP;

  -- A customer whose allocated subtotal is NEGATIVE (a discount line allocated to them exceeds their
  -- charges) cannot become a non-negative invoice; silently skipping them (the outer HAVING > 0 below)
  -- would make the OTHER customers' invoices over-sum the order total — breaking the penny-exact
  -- reconciliation guarantee. Fail loudly instead of mis-billing (Codex round-6 P2). A net-ZERO customer
  -- is safe to skip (contributes 0, reconciliation still holds); only a strictly-negative net is rejected.
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric, acres numeric)
    GROUP BY x.c HAVING sum(x.cents) < 0
  ) THEN
    RAISE EXCEPTION 'SPLIT_NET_NEGATIVE: a customer''s allocated subtotal is negative — cannot create split invoices (adjust the discount/allocation or issue a credit memo)';
  END IF;

  -- PASS 2: one invoice per customer, from the accumulated contributions.
  v_group_id := gen_random_uuid();

  FOR v_cust IN
    SELECT x.c AS customer_id, sum(x.cents) AS cust_total
    FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric)
    GROUP BY x.c
    HAVING sum(x.cents) > 0
    ORDER BY x.c
  LOOP
    INSERT INTO invoices (order_id, customer_id, invoice_type, status, season, salesman_id,
      created_by, total_amount_cents, invoice_date, invoice_group_id, header_notes)
    VALUES (p_order_id, v_cust.customer_id, p_invoice_type, 'draft',
      COALESCE(v_order.season, compute_season(v_business_date)),
      COALESCE(p_salesman_id, v_order.salesman_id), auth.uid(), 0, v_business_date, v_group_id,
      'Split invoice (by field/acre) from order ' || v_order.order_number)
    RETURNING id INTO v_invoice_id;

    v_total_cents := 0;
    FOR v_item IN
      SELECT oi.*, agg.cents AS cust_cents, agg.qty AS cust_qty, agg.acres AS cust_acres
      FROM (
        SELECT x.oi AS order_item_id, sum(x.cents)::bigint AS cents, sum(x.qty) AS qty, sum(x.acres) AS acres
        FROM jsonb_to_recordset(v_rows) AS x(c uuid, oi uuid, cents bigint, qty numeric, acres numeric)
        WHERE x.c = v_cust.customer_id
        GROUP BY x.oi
        -- Keep a line on the invoice if the customer has ANY contribution to it: non-zero cents
        -- (incl. a negative discount line, so the total reconciles to their net — Codex round-4 P2),
        -- OR non-zero qty/acres (so a legitimate $0 / no-charge product line still carries its product,
        -- quantity and acres for the PDF and year-end usage reports, matching create_invoice_from_order
        -- — Codex round-5 P2). The per-customer (outer) HAVING > 0 still gates which customers get a
        -- (CHECK-non-negative) invoice; a customer whose net is <= 0 is skipped (v1 — a net credit /
        -- a $0-only allocation would need a credit_memo / explicit $0 invoice, out of scope).
        HAVING sum(x.cents) <> 0 OR sum(x.qty) <> 0 OR sum(x.acres) <> 0
      ) agg
      JOIN order_items oi ON oi.id = agg.order_item_id
      ORDER BY oi.sort_order NULLS LAST, oi.id
    LOOP
      INSERT INTO invoice_items (invoice_id, order_item_id, product_id, description, quantity,
        unit_price_cents, extended_cents, cost_cents, sort_order, rate_per_acre, acres, unit_size)
      VALUES (v_invoice_id, v_item.id, v_item.product_id, COALESCE(v_item.product_name, ''),
        v_item.cust_qty, round(v_item.price_per_unit * 100)::bigint, v_item.cust_cents,
        round(v_item.cost_per_unit * 100)::bigint, COALESCE(v_item.sort_order, 0),
        v_item.actual_rate, v_item.cust_acres,
        -- Split-payer return (20261021155000): a line with no unit is billed as 'ea', the unit its
        -- return carries (create_return), so the return credit can trace the sale line it reverses
        -- (the credit refuses a source line whose unit differs: RETURN_CREDIT_UNIT_MISMATCH).
        COALESCE(v_item.unit_size, 'ea'));
      v_total_cents := v_total_cents + v_item.cust_cents;
    END LOOP;

    UPDATE invoices SET total_amount_cents = v_total_cents WHERE id = v_invoice_id;

    INSERT INTO financial_audit_log (operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description)
    VALUES ('invoice_created', 'invoice', v_invoice_id,
      COALESCE((SELECT role FROM profiles WHERE id = auth.uid()), 'admin'),
      jsonb_build_object('order_number', v_order.order_number, 'group_id', v_group_id,
        'split_basis', 'field_acre'),
      v_total_cents, 'Split invoice (by field/acre) from order ' || v_order.order_number);

    v_invoice_ids := v_invoice_ids || v_invoice_id;
  END LOOP;

  INSERT INTO activity_feed (event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id)
  VALUES ('split_invoices_created',
    COALESCE(array_length(v_invoice_ids, 1), 0) || ' split invoices from order ' || v_order.order_number,
    auth.uid(), 'order', p_order_id, v_order.customer_id);

  -- U7 SAFE-SCOPE (#43): the order is now split-billed per-owner — clear the
  -- "needs split billing" queue flag complete_delivery set when it skipped the mono-bill.
  UPDATE orders SET needs_split_billing = false, updated_at = now() WHERE id = p_order_id;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'create_split_invoices_from_order',
      to_jsonb(array_to_string(v_invoice_ids, ',')));
  END IF;

  RETURN v_invoice_ids;
END;
$function$;

DO $postflight$
BEGIN
  IF (SELECT create_oid IS DISTINCT FROM to_regprocedure('public._create_return_intent_impl_20260812(jsonb,jsonb,text)')::oid
          OR receive_oid IS DISTINCT FROM to_regprocedure('public._receive_return_intent_impl_20260812(uuid,uuid,text)')::oid
          OR issue_oid IS DISTINCT FROM to_regprocedure('public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)')::oid
          OR guard_oid IS DISTINCT FROM to_regprocedure('public.guard_invoice_terminal_order()')::oid
          OR mono_oid IS DISTINCT FROM to_regprocedure('public.guard_mono_invoice_split_billing_post()')::oid
          OR split_oid IS DISTINCT FROM to_regprocedure('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)')::oid
        FROM pg_temp.split_payer_return_tx) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_PAYER_RETURN_IDENTITY: each replace must preserve the function OID';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('_create_return_intent_impl_20260812', 'public._create_return_intent_impl_20260812(jsonb,jsonb,text)', '5a04a82127e6181aa8e95d74e23216c7', true),
        ('_receive_return_intent_impl_20260812', 'public._receive_return_intent_impl_20260812(uuid,uuid,text)', '67566a09967e74b1ee813354038955b0', true),
        ('_issue_return_credit_intent_impl_20260812', 'public._issue_return_credit_intent_impl_20260812(uuid,uuid,text)', '0d5209ab7179f36d71f548b55a6cf77d', true),
        ('guard_invoice_terminal_order', 'public.guard_invoice_terminal_order()', '3d76dae05876de46fd11233e7304af48', true),
        ('guard_mono_invoice_split_billing_post', 'public.guard_mono_invoice_split_billing_post()', 'b6fd2b19478801f6798c7b6e1fba737b', true),
        ('_create_split_invoices_from_order_provenance_impl_20260719', 'public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)', 'ccde51261dd8c5270b6dbd24f28981bd', true),
        ('_return_customer_is_split_payer', 'public._return_customer_is_split_payer(uuid,uuid)', NULL, false),
        ('_return_customer_line_share', 'public._return_customer_line_share(uuid,uuid,uuid,uuid)', NULL, false)
      ) AS pin(name, sig, body_md5, secdef)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc q JOIN pg_namespace n ON n.oid = q.pronamespace
             WHERE n.nspname = 'public' AND q.proname = pin.name) <> 1
        OR (pin.body_md5 IS NOT NULL AND md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5)
        OR p.proowner <> 'postgres'::regrole
        OR p.prosecdef IS DISTINCT FROM pin.secdef
        OR (NOT pin.secdef AND p.provolatile <> 's')
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM ARRAY['postgres']::text[]
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_PAYER_RETURN_CONTRACT: a replaced or new function body, owner, security mode, search_path or ACL is not the reviewed one';
  END IF;
  IF EXISTS (SELECT 1 FROM public.return_credit_customer_claims)
     OR NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.return_credit_customer_claims'::regclass)
     OR NOT EXISTS (
       SELECT 1 FROM pg_policy pol
        WHERE pol.polrelid = 'public.return_credit_customer_claims'::regclass
          AND pol.polname = 'return_credit_customer_claims_deny_all'
          AND pg_get_expr(pol.polqual, pol.polrelid) = 'false'
          AND pg_get_expr(pol.polwithcheck, pol.polrelid) = 'false'
     )
     OR EXISTS (
       SELECT 1
         FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS api_role
         CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS priv
        WHERE has_table_privilege(api_role, 'public.return_credit_customer_claims', priv)
           OR (priv IN ('SELECT', 'INSERT', 'UPDATE')
               AND has_any_column_privilege(api_role, 'public.return_credit_customer_claims', priv))
     ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_PAYER_CLAIMS_EXPOSED: the return credit claims table must be empty, RLS deny-all and unreachable from the Data API';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'trg_guard_invoice_terminal_order' AND t.tgrelid = 'public.invoices'::regclass AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER trg_guard_invoice_terminal_order BEFORE INSERT OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_invoice_terminal_order()'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'guard_mono_invoice_split_billing_post' AND t.tgrelid = 'public.invoices'::regclass AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER guard_mono_invoice_split_billing_post BEFORE INSERT OR UPDATE OF status, order_id, invoice_group_id ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_mono_invoice_split_billing_post()'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'require_split_invoice_creation_claim' AND t.tgrelid = 'public.invoices'::regclass AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER require_split_invoice_creation_claim BEFORE INSERT ON public.invoices FOR EACH ROW EXECUTE FUNCTION require_split_invoice_creation_claim()'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgname = 'guard_split_invoice_provenance_identity' AND t.tgrelid = 'public.invoices'::regclass AND t.tgenabled = 'O'
       AND pg_get_triggerdef(t.oid) = 'CREATE TRIGGER guard_split_invoice_provenance_identity BEFORE DELETE OR UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION guard_split_invoice_provenance_identity()'
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_PAYER_RETURN_TRIGGER: an invoice guard trigger changed';
  END IF;
  -- The two read-only lookups: one overload each, STABLE, SECURITY DEFINER, fixed search_path,
  -- EXECUTE for authenticated and service_role (and the owner), never anon.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('get_split_payer_return_orders', 'public.get_split_payer_return_orders(uuid)'),
        ('get_return_line_allowances', 'public.get_return_line_allowances(uuid,uuid)')
      ) AS pin(name, sig)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL
        OR (SELECT count(*) FROM pg_proc q JOIN pg_namespace n ON n.oid = q.pronamespace
             WHERE n.nspname = 'public' AND q.proname = pin.name) <> 1
        OR p.proowner <> 'postgres'::regrole
        OR NOT p.prosecdef
        OR p.provolatile <> 's'
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_PAYER_RETURN_LOOKUP_CONTRACT: a return lookup''s security mode, search_path or grants are not the reviewed ones';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.create_return(jsonb,jsonb,text)', 'd535f68ffd3ee478d0516a0eb65830f9'),
        ('public.receive_return(uuid,uuid,text)', 'bd4c4e9975c059301e0b3ee21678012f'),
        ('public.issue_return_credit(uuid,uuid,text)', 'f3fcab7980d1640501fc038b0c8ac902'),
        ('public._issue_return_credit_impl(uuid,uuid,text)', 'a1e3183c3b962501b810e64333313a7c'),
        ('public._issue_return_credit_header_only_impl_20260825(uuid,uuid,text)', '4b32da9a350ca22e9dece371b1985493'),
        ('public._receive_return_impl_20260714(uuid,uuid,text)', '731471d04684bb5897c57dffdd329272'),
        ('public.apply_credit_memo_to_invoice(uuid,uuid,bigint,uuid,text)', 'bcc242c8715aaed81b9455fbc905237f'),
        ('public.require_split_invoice_creation_claim()', 'e73daae16c5ff5432644060f2b34f925'),
        ('public.guard_split_invoice_provenance_identity()', '639875d6641556c78c25d633c67821f1'),
        ('public.create_split_invoices_from_order(uuid,uuid,text,text)', '0f1e36e8536fc56f08fcf6071ea76da8')
      ) AS pin(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
  ) THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_PAYER_RETURN_DEPENDENCY_DRIFT: a return or split function other than the replaced ones changed';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: a governed split payer may return its billed share and receive its own return credit';
END
$postflight$;
