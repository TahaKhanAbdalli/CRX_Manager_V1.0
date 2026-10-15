-- Written 2026-10-14. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: a sales rep turning an order into invoices bills only under their own name.
--   create_invoice_from_order and create_split_invoices_from_order (both granted to authenticated,
--   both admitting admins and sales reps) stored COALESCE(p_salesman_id, orders.salesman_id) as
--   invoices.salesman_id with no check that a rep named themselves. invoices.salesman_id is a
--   read-access key (the invoices SELECT policy and its child-table policies,
--   get_customer_balance_listing, get_field_profitability), so naming another profile gave that
--   profile read access to the invoice. Both public wrappers now refuse a non-admin caller when that
--   effective salesperson, COALESCE(p_salesman_id, orders.salesman_id), is someone other than the
--   caller, with SALESMAN_SCOPE_DENIED (P0001), the code and test save_invoice uses
--   (20261013220000). So a rep may name themselves, or pass NULL on an order that is theirs or has
--   no salesperson; a NULL on another rep's order is refused (Sol on PR #928: a rep can insert an
--   order naming another rep, orders_insert has no salesperson test, and a NULL call would then
--   invoice under that name). Admins may name anyone. Customer scope is NOT added: reps invoice any
--   customer (Mason, 2026-10-13, DECISION_LOG.md).
--   ONE EXCEPTION, complete_delivery's automatic split (Mason, 2026-10-14, "Option A"): when a rep
--   completes another rep's field-allocated delivery, the split drafts keep the order's
--   salesperson. _complete_delivery_authorized_impl (re-emitted verbatim plus one marker) sets the
--   transaction-local setting crx.order_invoice_autosplit to that order's id around its own NULL-salesperson call, and
--   the split wrapper accepts a NULL salesperson for exactly that order. No Data API request can
--   set that setting (PostgREST sets only its own request.* settings; set_config is not exposed),
--   a failed split rolls it back with its sub-block, and a successful one clears it at once.
--   Error order: create_invoice_from_order runs the own-name test before its implementation's
--   authentication and role gate, so a caller with no user or a driver naming someone else gets
--   SALESMAN_SCOPE_DENIED rather than "Not authenticated"/"Not authorized"; both refuse.
--
-- WHY (Mason): the intended rule since 2026-10-06, narrowed 2026-10-13 to "reps bill any customer,
--   but only under their own name; admins unrestricted" (KNOWN_ISSUES.md, "Order-invoice RPCs let
--   a rep name another salesperson"); Mason chose this fix in chat on 2026-10-14.
--
-- ALSO, because the split wrapper is re-emitted (KNOWN_ISSUES.md asks whichever change re-emits it
-- to carry both):
--   * the CRX-LIFE-001 type allow-list (chemical_sale or misc_charge, ORDER_INVOICE_TYPE_NOT_ALLOWED,
--     23514) right after the role gate, before the claim and before any invoice number is drawn. A
--     refused field_application split used to fail on invoices_field_application_has_no_order only
--     after its first INSERT had drawn a number, leaving a gap in invoice numbering.
--   * the idempotency key is required (IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order,
--     22023), as create_invoice_from_order already requires. Both callers always send one: the
--     Order page (OrderDetail.tsx) and complete_delivery (its key, or the delivery id, + ':autosplit').
--
-- NOT CHANGED: the role gates, every lock, the replay and provenance logic, the private order-invoice
--   implementations (_create_invoice_from_order_idem_impl_20260721,
--   _create_invoice_from_order_impl_20260718, _create_split_invoices_from_order_provenance_impl_20260719),
--   and everything in _complete_delivery_authorized_impl except the two set_config lines around its
--   automatic split. Each re-emitted function is its verbatim live body of 2026-10-14 plus only the
--   hunks above. No rows change. No GRANT or REVOKE: CREATE OR REPLACE keeps each OID, owner and exact
--   ACL, and the postflight proves it. Remaining gap (KNOWN_ISSUES.md): blend tickets.
--
-- OVERLOADS: each re-emitted function has exactly one overload, so CREATE OR REPLACE replaces the
--   live OID (read-only on live, 2026-10-15 07:12 UTC, a separate read from the 06:48 UTC ledger capture: create_invoice_from_order(uuid,uuid,text,text),
--   create_split_invoices_from_order(uuid,uuid,text,text) and _complete_delivery_authorized_impl(uuid,
--   text,uuid,jsonb,text,text,text,timestamptz), one row each). The 2026-02-13 three-argument
--   create_invoice_from_order(uuid, uuid, text) was dropped by 20260311200000_wave2_audit_fixes.sql:1164.
--   The preflight and postflight refuse any second overload of the three names.
--
-- ORDERING: strict. Apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE order_invoice_own_name_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id,
       to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)')::oid AS single_oid,
       to_regprocedure('public.create_split_invoices_from_order(uuid,uuid,text,text)')::oid AS split_oid,
       to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)')::oid AS complete_oid;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change
  -- (a client that stops on the first error, as every sanctioned apply path does, then stops).
  IF to_regclass('pg_temp.order_invoice_own_name_tx') IS NULL THEN
    RAISE EXCEPTION 'ORDER_INVOICE_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.order_invoice_own_name_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'ORDER_INVOICE_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_invoice_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) = 'a1a91643bd8866823ae359f7e0ec290e'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_ORDER_INVOICE_WRAPPER_DRIFT: expected the exact reviewed public create_invoice_from_order';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_split_invoices_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid[]'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) = '398030fbb64006b4750e7e89a61b6cb9'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.create_split_invoices_from_order(uuid,uuid,text,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_SPLIT_INVOICE_WRAPPER_DRIFT: expected the exact reviewed public create_split_invoices_from_order';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_complete_delivery_authorized_impl') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone'
        AND md5(p.prosrc) = 'f8de9f000e40f7bfd8f792012f04fee0'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PREFLIGHT_COMPLETE_DELIVERY_DRIFT: expected the exact reviewed _complete_delivery_authorized_impl';
  END IF;
  -- What the own-name test relies on, pinned to its live body of 2026-10-14 (CR-insensitive: live
  -- stores one of them with CRLF): is_admin()/is_sales_rep() mean an ACTIVE admin/rep, and the
  -- private implementations keep the role gate and the COALESCE(p_salesman_id, orders.salesman_id)
  -- fallback the effective-salesperson test mirrors.
  IF EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.is_admin()', 'f76bf61116c3bd52bd9c6ea125079b73'),
        ('public.is_sales_rep()', 'fcb3133010fe3f4f56e3be31f709d102'),
        ('public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)', '3d393fb8639dbcb2aa38574ca9679eee'),
        ('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)', '454e04c4e199549a4f5be9975e397e17'),
        ('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)', 'f671f1a3f5406cff52aedd8a5fb40b31')
      ) AS pin(sig, body_md5)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(pin.sig)
     WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM pin.body_md5
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_DEPENDENCY_DRIFT: a role helper or an order-invoice implementation differs from its reviewed body';
  END IF;
  -- Only the wrappers may reach the implementations: none may be callable by a Data API role.
  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY[
        to_regprocedure('public._create_invoice_from_order_idem_impl_20260721(uuid,uuid,text,text)'),
        to_regprocedure('public._create_invoice_from_order_impl_20260718(uuid,uuid,text,text)'),
        to_regprocedure('public._create_split_invoices_from_order_provenance_impl_20260719(uuid,uuid,text,text)')
      ]::oid[]) AS impl
      CROSS JOIN unnest(ARRAY['anon', 'authenticated', 'service_role']) AS api_role
     WHERE has_function_privilege(api_role, impl, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_PRIVATE_IMPL_EXPOSED: an order-invoice implementation is executable by a Data API role';
  END IF;
  -- The autosplit marker must be unused elsewhere: no other function may set it.
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.prosrc LIKE '%crx.order_invoice_autosplit%'
       AND p.oid IS DISTINCT FROM to_regprocedure('public.create_split_invoices_from_order(uuid,uuid,text,text)')
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_AUTOSPLIT_MARKER_IN_USE: another function already references crx.order_invoice_autosplit';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.create_invoice_from_order(
  p_order_id uuid,
  p_salesman_id uuid DEFAULT NULL,
  p_invoice_type text DEFAULT 'chemical_sale',
  p_idempotency_key text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_invoice_from_order'
      USING ERRCODE = '22023';
  END IF;
  -- Field invoices come only from the field-application, job-transfer and blend-ticket
  -- workflows, and credit memos only from issue_return_credit (CRX-LIFE-001).
  IF p_invoice_type IS NULL OR p_invoice_type NOT IN ('chemical_sale', 'misc_charge') THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TYPE_NOT_ALLOWED: an invoice created from an order must be chemical_sale or misc_charge'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Own name (Mason, 2026-10-06, narrowed 2026-10-13): a sales rep bills any customer but only
  -- under their own name; an admin may name anyone. The salesperson the invoice will carry is
  -- COALESCE(p_salesman_id, orders.salesman_id), so a non-admin may pass NULL only when that
  -- resolves to them or to no one (Sol on PR #928). The order is locked first, so an admin
  -- reassigning it cannot change that salesperson between this test and the insert (Luna r2).
  PERFORM 1 FROM public.orders o WHERE o.id = p_order_id FOR UPDATE;
  IF NOT public.is_admin()
     AND COALESCE(p_salesman_id, (SELECT o.salesman_id FROM public.orders o WHERE o.id = p_order_id), auth.uid())
         IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
  END IF;
  RETURN public._create_invoice_from_order_idem_impl_20260721(
    p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_split_invoices_from_order(
  p_order_id uuid,
  p_salesman_id uuid DEFAULT NULL::uuid,
  p_invoice_type text DEFAULT 'chemical_sale'::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_contract CONSTANT text := 'create_split_invoices_from_order_v1';
  v_request jsonb;
  v_fingerprint text;
  v_replay jsonb;
  v_invoice_ids uuid[] := '{}'::uuid[];
  v_claim_nonce uuid := gen_random_uuid();
  v_has_split_evidence boolean := false;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_split_invoices_from_order'
      USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Not authorized: admin or sales role required to create invoices from orders';
  END IF;
  -- Field invoices come only from the field-application, job-transfer and blend-ticket
  -- workflows, and credit memos only from issue_return_credit (CRX-LIFE-001). Refused here,
  -- before the claim and before any invoice number is drawn.
  IF p_invoice_type IS NULL OR p_invoice_type NOT IN ('chemical_sale', 'misc_charge') THEN
    RAISE EXCEPTION 'ORDER_INVOICE_TYPE_NOT_ALLOWED: an invoice created from an order must be chemical_sale or misc_charge'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Own name (Mason, 2026-10-06, narrowed 2026-10-13): a sales rep bills any customer but only
  -- under their own name; an admin may name anyone. The salesperson the invoice will carry is
  -- COALESCE(p_salesman_id, orders.salesman_id), so a non-admin may pass NULL only when that
  -- resolves to them or to no one (Sol on PR #928). The order is locked first, so an admin
  -- reassigning it cannot change that salesperson between this test and the insert (Luna r2).
  -- complete_delivery's automatic split (Mason, 2026-10-14, "Option A") keeps the order's
  -- salesperson: it marks its own NULL-salesperson call for exactly this order with the
  -- transaction-local setting crx.order_invoice_autosplit, which no Data API request can set.
  PERFORM 1 FROM public.orders o WHERE o.id = p_order_id FOR UPDATE;
  IF NOT public.is_admin()
     AND COALESCE(p_salesman_id, (SELECT o.salesman_id FROM public.orders o WHERE o.id = p_order_id), v_actor)
         IS DISTINCT FROM v_actor
     AND NOT (p_salesman_id IS NULL
              AND current_setting('crx.order_invoice_autosplit', true) IS NOT DISTINCT FROM p_order_id::text) THEN
    RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
  END IF;

  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'order_id', p_order_id,
    'salesman_id', p_salesman_id,
    'invoice_type', p_invoice_type
  );
  v_fingerprint := md5(v_request::text);
  IF p_idempotency_key IS NOT NULL THEN
    v_replay := public._claim_bound_lifecycle_idempotency(
      p_idempotency_key,
      'create_split_invoices_from_order',
      v_contract,
      v_fingerprint,
      v_request
    );
  END IF;

  PERFORM 1
    FROM public.orders o
   WHERE o.id = p_order_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found: %', p_order_id;
  END IF;

  PERFORM 1
    FROM public.order_items oi
   WHERE oi.order_id = p_order_id
   ORDER BY oi.id
   FOR UPDATE;

  SELECT EXISTS (
    SELECT 1
      FROM public.order_item_field_allocations oifa
      JOIN public.order_items oi ON oi.id = oifa.order_item_id
     WHERE oi.order_id = p_order_id
  ) INTO v_has_split_evidence;

  IF v_replay IS NOT NULL THEN
    SELECT COALESCE(
             array_agg(replayed.invoice_id ORDER BY replayed.ordinality),
             '{}'::uuid[]
           )
      INTO v_invoice_ids
      FROM (
        SELECT value::uuid AS invoice_id, ordinality
          FROM jsonb_array_elements_text(v_replay) WITH ORDINALITY
      ) replayed;
  ELSE
    INSERT INTO public.split_invoice_creation_claims (
      transaction_id,
      order_id,
      claim_nonce
    ) VALUES (
      pg_current_xact_id(),
      p_order_id,
      v_claim_nonce
    );

    v_invoice_ids := public._create_split_invoices_from_order_provenance_impl_20260719(
      p_order_id,
      p_salesman_id,
      p_invoice_type,
      NULL::text
    );

    INSERT INTO public.split_invoice_provenance (
      invoice_id,
      order_id,
      invoice_group_id,
      customer_id,
      invoice_type,
      season,
      total_amount_cents,
      content_claim,
      provenance_nonce,
      created_by
    )
    SELECT
      i.id,
      i.order_id,
      i.invoice_group_id,
      i.customer_id,
      i.invoice_type,
      i.season,
      i.total_amount_cents,
      public._split_invoice_content_claim(i.id),
      gen_random_uuid(),
      v_actor
    FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
    JOIN public.invoices i ON i.id = returned.invoice_id
    WHERE i.order_id = p_order_id
      AND i.invoice_group_id IS NOT NULL
      AND v_has_split_evidence
    ON CONFLICT (invoice_id) DO NOTHING;
  END IF;

  IF EXISTS (
       SELECT 1
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
        WHERE returned.invoice_id IS NULL
     )
     OR cardinality(COALESCE(v_invoice_ids, '{}'::uuid[])) IS DISTINCT FROM (
       SELECT count(DISTINCT returned.invoice_id)::integer
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
     )
     OR cardinality(COALESCE(v_invoice_ids, '{}'::uuid[])) IS DISTINCT FROM (
       SELECT count(*)::integer
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
         JOIN public.invoices i ON i.id = returned.invoice_id
        WHERE i.order_id = p_order_id
     ) THEN
    RAISE EXCEPTION
      'SPLIT_INVOICE_IDEMPOTENCY_RESPONSE_MISMATCH: every returned invoice must belong exactly to the requested order';
  END IF;

  IF v_has_split_evidence
     AND cardinality(COALESCE(v_invoice_ids, '{}'::uuid[])) IS DISTINCT FROM (
       SELECT count(*)::integer
         FROM unnest(COALESCE(v_invoice_ids, '{}'::uuid[])) AS returned(invoice_id)
         JOIN public.invoices i ON i.id = returned.invoice_id
         JOIN public.split_invoice_provenance p ON p.invoice_id = i.id
        WHERE i.order_id = p_order_id
          AND i.invoice_group_id IS NOT NULL
          AND p.order_id = i.order_id
          AND p.invoice_group_id = i.invoice_group_id
          AND p.customer_id = i.customer_id
          AND p.invoice_type = i.invoice_type
          AND p.season = i.season
          AND p.total_amount_cents = i.total_amount_cents
          AND p.content_claim = public._split_invoice_content_claim(i.id)
          AND p.contract_version = 'split_invoice_provenance_v1'
     ) THEN
    RAISE EXCEPTION
      'SPLIT_INVOICE_PROVENANCE_REPLAY_MISMATCH: returned split invoice content does not match its exact private claim';
  END IF;

  IF v_replay IS NULL THEN
    DELETE FROM public.split_invoice_creation_claims
     WHERE transaction_id = pg_current_xact_id()
       AND order_id = p_order_id
       AND claim_nonce = v_claim_nonce;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPLIT_INVOICE_CREATION_CLAIM_LOST';
    END IF;

    PERFORM public._bind_completed_lifecycle_idempotency(
      p_idempotency_key,
      'create_split_invoices_from_order',
      v_contract,
      v_fingerprint,
      v_request,
      to_jsonb(v_invoice_ids)
    );
  END IF;

  RETURN v_invoice_ids;
END;
$function$;

CREATE OR REPLACE FUNCTION public._complete_delivery_authorized_impl(p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
DECLARE
  v_delivery record;
  v_item record;
  v_inv record;
  v_qty_to_deliver numeric;
  v_deduct_from_prebooked numeric;
  v_any_partial boolean := false;
  v_all_delivered boolean;
  v_linked_invoice record;
  v_result jsonb;
  v_existing jsonb;
  v_actor uuid;
  v_actor_role text;
  v_auto_invoice_id uuid;
  v_auto_invoice_number text;
  v_auto_total_cents bigint := 0;
  v_auto_cost_cents bigint := 0;
  -- CRX-MONEY-LIFECYCLE-001: cents allocated to THIS delivery from the order
  -- line's stored total, rather than re-extended from price x quantity.
  v_line_alloc_cents bigint := 0;
  v_existing_active_invoice_count int;
  v_closed_period record;
  v_admin record;
  -- U9 stock-policy WARN-NOT-BLOCK
  v_short_count int := 0;
  v_stock_warnings text[] := '{}';
  v_short_product_ids uuid[] := '{}';
  v_effective_completion_date date;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'p_performed_by does not match authenticated user';
  END IF;

  -- U15: optional backdate. Reject future timestamps (small clock-skew allowance);
  -- NULL = legacy behavior (now()/CURRENT_DATE).
  IF p_completed_at IS NOT NULL AND p_completed_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'COMPLETED_AT_IN_FUTURE: completion time cannot be in the future';
  END IF;

  v_effective_completion_date := COALESCE(
    (p_completed_at AT TIME ZONE 'America/Chicago')::date,
    (now() AT TIME ZONE 'America/Chicago')::date
  );

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'complete_delivery');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  SELECT * INTO v_delivery FROM deliveries WHERE id = p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found: %', p_delivery_id; END IF;

  SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR NOT (
    v_actor_role IN ('admin', 'sales_rep')
    OR (v_actor_role = 'driver' AND v_actor = v_delivery.assigned_driver)
  ) THEN
    RAISE EXCEPTION 'Not authorized to complete this delivery';
  END IF;

  IF v_delivery.status != 'in_progress' THEN
    RAISE EXCEPTION 'Delivery must be in_progress to complete (current status: %). Call confirm_delivery() first.', v_delivery.status;
  END IF;

  -- PR-01 fix: column is `scheduled_date`, not `delivery_date`.
  SELECT id, period_start, period_end
    INTO v_closed_period
    FROM accounting_periods
   WHERE status = 'closed'
     AND v_effective_completion_date BETWEEN period_start AND period_end
   LIMIT 1;

  IF FOUND THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'backdated_delivery_in_closed_period',
      'WARNING: Delivery ' || v_delivery.delivery_number ||
        ' completed for ' || v_effective_completion_date::text ||
        ' which falls in CLOSED accounting period ' ||
        v_closed_period.period_start::text || ' to ' ||
        v_closed_period.period_end::text || '. Operation proceeded; verify with finance.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );

    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Backdated Delivery Completion',
        'Delivery ' || v_delivery.delivery_number ||
          ' was completed for ' || v_effective_completion_date::text ||
          ' — that date is inside a CLOSED accounting period (' ||
          v_closed_period.period_start::text || ' to ' ||
          v_closed_period.period_end::text || '). Inventory and lifecycle ' ||
          'changes proceeded. Verify the financial impact.',
        'period_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  FOR v_item IN
    SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;
    IF v_qty_to_deliver < v_item.quantity THEN v_any_partial := true; END IF;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;
    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse' FOR UPDATE;
    -- U9: WARN-NOT-BLOCK (was: RAISE EXCEPTION 'Insufficient inventory ...').
    -- Same on-hand math; completion proceeds and stock is allowed to go negative.
    IF NOT FOUND OR COALESCE(v_inv.quantity_available, 0) < v_qty_to_deliver THEN
      v_short_count := v_short_count + 1;
      v_short_product_ids := array_append(v_short_product_ids, v_item.product_id);
      v_stock_warnings := array_append(v_stock_warnings,
        v_item.product_name || ': need ' || v_qty_to_deliver || ', only ' ||
        COALESCE(v_inv.quantity_available, 0) || ' on-hand');
      -- U9 (Codex R2 P2): seed a zero row when missing so the deduction UPDATE
      -- below lands and the on-hand aggregate goes visibly negative.
      IF NOT FOUND THEN
        INSERT INTO inventory (product_id, location, quantity_available, quantity_prebooked, manufactured_at_delivery)
        VALUES (v_item.product_id, 'Main Warehouse', 0, 0, true)  -- surfaces on /integrity-cleanup (P4-7 phantom-row flag)
        ON CONFLICT DO NOTHING;
      END IF;
    END IF;
  END LOOP;

  -- P2-D: authorize the post-completion delivery_items + lifecycle writes below.
  -- The enforce_delivery_items_parent_lock trigger blocks writes to a
  -- non-scheduled delivery's items; complete_delivery legitimately records
  -- quantity_delivered after flipping status to 'completed', so it sets the
  -- canonical admin_override escape hatch (transaction-local).
  SET LOCAL app.admin_override = 'true';

  UPDATE deliveries SET
    status = 'completed', completed_at = COALESCE(p_completed_at, now()), signed_by = p_signed_by,
    issue_type = COALESCE(p_issue_type, issue_type),
    issue_notes = CASE WHEN p_issue_notes IS NOT NULL THEN p_issue_notes ELSE issue_notes END
  WHERE id = p_delivery_id;

  FOR v_item IN
    SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
    WHERE di.delivery_id = p_delivery_id
  LOOP
    IF p_quantities IS NOT NULL AND p_quantities ? v_item.id::text THEN
      v_qty_to_deliver := GREATEST(0, LEAST((p_quantities->>v_item.id::text)::numeric, v_item.quantity));
    ELSE
      v_qty_to_deliver := v_item.quantity;
    END IF;
    UPDATE delivery_items SET quantity_delivered = v_qty_to_deliver WHERE id = v_item.id;
    IF v_qty_to_deliver = 0 THEN CONTINUE; END IF;

    UPDATE order_items SET
      quantity_delivered = quantity_delivered + v_qty_to_deliver,
      quantity_remaining = GREATEST(quantity_remaining - v_qty_to_deliver, 0)
    WHERE id = v_item.order_item_id;

    -- U9: flag the delivered ledger row for review when the product was short.
    INSERT INTO inventory_transactions (
      product_id, transaction_type, quantity, from_location,
      order_id, delivery_id, performed_by, notes, requires_review
    ) VALUES (
      v_item.product_id, 'delivered', v_qty_to_deliver, 'Main Warehouse',
      v_delivery.order_id, p_delivery_id, v_actor,
      'Delivery ' || v_delivery.delivery_number ||
        CASE WHEN v_qty_to_deliver < v_item.quantity
          THEN ' (partial: ' || v_qty_to_deliver || '/' || v_item.quantity || ')'
          ELSE '' END ||
        CASE WHEN v_item.product_id = ANY(v_short_product_ids)
          THEN ' [SHORT STOCK — review required]' ELSE '' END ||
        '. Signed by: ' || p_signed_by,
      v_item.product_id = ANY(v_short_product_ids)
    );

    SELECT * INTO v_inv FROM inventory WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
    v_deduct_from_prebooked := LEAST(v_qty_to_deliver, COALESCE(v_inv.quantity_prebooked, 0));

    UPDATE inventory SET
      quantity_available = quantity_available - v_qty_to_deliver,
      quantity_prebooked = quantity_prebooked - v_deduct_from_prebooked,
      updated_at = now()
    WHERE product_id = v_item.product_id AND location = 'Main Warehouse';
  END LOOP;

  -- U2 (Codex P2): with per-delivery invoices now possible on one order, the
  -- tote copy must NOT stamp a SIBLING delivery's invoice — scope it to this
  -- delivery's own invoice or an order-level one (delivery_id IS NULL), the
  -- same shape as the auto-invoice guard below. Return-credit lines are
  -- immutable accounting provenance, not delivery-sale lines to relabel.
  UPDATE invoice_items ii
  SET tote_number = di.tote_number
  FROM delivery_items di
  JOIN invoices inv ON inv.order_id = v_delivery.order_id AND inv.deleted_at IS NULL
    AND inv.invoice_type <> 'credit_memo'
    AND (inv.delivery_id = p_delivery_id OR inv.delivery_id IS NULL)
  WHERE di.delivery_id = p_delivery_id
    AND ii.invoice_id = inv.id
    AND di.order_item_id = ii.order_item_id
    AND di.tote_number IS NOT NULL;

  IF v_any_partial THEN
    FOR v_item IN
      SELECT di.*, p.product_name FROM delivery_items di JOIN products p ON p.id = di.product_id
      WHERE di.delivery_id = p_delivery_id AND di.quantity_delivered < di.quantity
    LOOP
      INSERT INTO delivery_remainders (
        original_delivery_id, order_id, order_item_id,
        customer_id, product_id, quantity_remaining, unit_size
      ) VALUES (
        p_delivery_id, v_delivery.order_id, v_item.order_item_id,
        v_delivery.customer_id, v_item.product_id,
        v_item.quantity - v_item.quantity_delivered, v_item.unit_size
      );
    END LOOP;
  END IF;

  -- U2 #39: close out the remainder rows THIS follow-up delivery was created to satisfy.
  -- create_followup_delivery flips the parent's remainders 'pending'->'scheduled' and stamps
  -- followup_delivery_id = this delivery. Now that this delivery has completed, mark them
  -- 'fulfilled'. Any lines this follow-up ITSELF shorted are already captured as fresh
  -- 'pending' remainder rows by the v_any_partial INSERT above (original_delivery_id = this
  -- delivery), so this flip never loses outstanding quantity — it prevents the same shortfall
  -- being double-counted as both a stale 'scheduled' row and a new 'pending' row. Idempotent
  -- (guarded by status = 'scheduled'); targets rows disjoint from the ones just inserted.
  UPDATE delivery_remainders
     SET status = 'fulfilled', updated_at = now()
   WHERE followup_delivery_id = p_delivery_id
     AND status = 'scheduled';

  -- P2 fix (Codex 2026-07-10): serialize concurrent same-day FINAL deliveries on the SAME
  -- order. Two deliveries completing at once each read v_all_delivered under READ COMMITTED
  -- without seeing the other's uncommitted order_items decrement, so both could compute
  -- false and skip the Feature A auto-split (order falls back to manual split-billing — safe,
  -- but the auto-split silently doesn't fire). Take the orders row lock BEFORE the read: the
  -- second completion blocks here until the first commits, then sees the committed decrement.
  -- Lock ORDER is unchanged (deliveries -> inventory -> orders): the UPDATE orders just below
  -- already acquired this same row lock — this only moves the acquisition ahead of the read,
  -- adding no new lock pair (no new deadlock surface).
  IF v_delivery.order_id IS NOT NULL THEN
    PERFORM 1 FROM orders WHERE id = v_delivery.order_id FOR UPDATE;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM order_items WHERE order_id = v_delivery.order_id AND quantity_remaining > 0
  ) INTO v_all_delivered;

  UPDATE orders SET
    status = CASE WHEN v_all_delivered THEN 'fulfilled' ELSE 'partially_fulfilled' END,
    updated_at = now()
  WHERE id = v_delivery.order_id;

  IF v_any_partial AND v_delivery.order_id IS NOT NULL THEN
    FOR v_linked_invoice IN
      SELECT * FROM invoices
      WHERE order_id = v_delivery.order_id AND status = 'draft' AND delivery_id = p_delivery_id
    LOOP
      UPDATE invoice_items ii SET
        quantity = di.quantity_delivered,
        extended_cents = public._allocated_delivery_cents(
                           ii.order_item_id, di.quantity_delivered, ii.invoice_id)
      FROM delivery_items di
      WHERE di.delivery_id = p_delivery_id AND ii.invoice_id = v_linked_invoice.id AND ii.order_item_id = di.order_item_id;
      -- Overnight bug-hunt LOW (20260620): also recompute the stored header cost so
      -- a partial completion doesn't leave total_cost_cents sized to the full qty.
      -- cost_cents is PER-UNIT cents; line cost = cost_cents * quantity (no *100).
      UPDATE invoices SET
        total_amount_cents = (SELECT COALESCE(SUM(extended_cents), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
        total_cost_cents = (SELECT COALESCE(SUM(cost_cents * quantity), 0) FROM invoice_items WHERE invoice_id = v_linked_invoice.id),
        updated_at = now()
      WHERE id = v_linked_invoice.id;
    END LOOP;
  END IF;

  IF v_delivery.order_id IS NOT NULL THEN
    -- U2 #34: per-DELIVERY-aware guard (was per-ORDER). Block only if THIS delivery already
    -- has an active invoice, or an ORDER-LEVEL invoice (delivery_id IS NULL) already covers
    -- the whole order. An active invoice tied to a DIFFERENT delivery must NOT block this
    -- delivery — otherwise a follow-up delivery of shorted product is never billed.
    SELECT COUNT(*) INTO v_existing_active_invoice_count
    FROM invoices
    WHERE order_id = v_delivery.order_id
      AND status NOT IN ('voided', 'cancelled')
      AND invoice_type <> 'credit_memo'
      AND deleted_at IS NULL
      AND (delivery_id = p_delivery_id OR delivery_id IS NULL);

    IF v_existing_active_invoice_count = 0 THEN
      -- U7 SAFE-SCOPE (#43): a field/acre-allocated order must NOT be mono-billed
      -- 100% to the primary customer (that dead-ends the landlord's payment). Skip the
      -- auto-draft, flag the order for a manual per-owner split-billing pass, and notify
      -- the office. Non-allocated orders keep the EXACT auto-draft in the ELSE below.
      IF EXISTS (
        SELECT 1 FROM order_item_field_allocations oifa
        JOIN order_items oi ON oi.id = oifa.order_item_id
        WHERE oi.order_id = v_delivery.order_id
      ) THEN
        -- Codex pre-ship HIGH fix: only auto-split when the delivery's EFFECTIVE date is TODAY.
        -- create_split_invoices_from_order stamps invoice_date = CURRENT_DATE and takes no date arg, so
        -- auto-splitting a BACKDATED completion (p_completed_at in a prior/closed period) would silently
        -- date the drafts today and shift AR aging/terms — while the mono-bill path (below) respects the
        -- backdate. A backdated allocated order falls through to flag+notify (the office creates the split
        -- manually, exactly as before Feature A); same-day completions (the common case) auto-split.
        IF v_all_delivered
           AND v_effective_completion_date = (now() AT TIME ZONE 'America/Chicago')::date THEN
          -- the whole order is now delivered TODAY -> auto-create the per-owner split DRAFTS via the proven engine.
          BEGIN
            -- Marks this automatic split so the split wrapper keeps the order's salesperson for a
            -- rep who completes another rep's delivery (20261014210000). Transaction-local; a failed
            -- split rolls it back with this block, and it is cleared right after a successful one.
            PERFORM set_config('crx.order_invoice_autosplit', v_delivery.order_id::text, true);
            PERFORM create_split_invoices_from_order(
              v_delivery.order_id, NULL, 'chemical_sale',
              COALESCE(p_idempotency_key, p_delivery_id::text) || ':autosplit'
            );
            PERFORM set_config('crx.order_invoice_autosplit', '', true);
            -- create_split_invoices_from_order creates draft invoices per owner, clears
            -- needs_split_billing, and writes its own activity_feed + financial_audit_log rows.
            -- Add ONE activity_feed row noting the auto-creation on this delivery completion.
            INSERT INTO activity_feed (event_type, description, performed_by, related_entity_type, related_entity_id, customer_id)
            VALUES (
              'split_invoices_auto_created',
              'Delivery ' || v_delivery.delivery_number || ' completed the order — per-owner split DRAFT invoices were auto-created (review + post them).',
              v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
            );
          EXCEPTION WHEN OTHERS THEN
            -- Any reason the split cannot run yet (order not priced -> PRICING_INCOMPLETE, an
            -- edge race, a still-open sibling delivery, etc.): fall back to today's flag+notify.
            -- The subtransaction rolls back any partial split work; the delivery completion is UNAFFECTED.
        UPDATE orders SET needs_split_billing = true, updated_at = now()
          WHERE id = v_delivery.order_id;
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'order_needs_split_billing',
          'Delivery ' || v_delivery.delivery_number || ' completed on a multi-owner (field/acre) order — auto-invoice skipped; create split invoices from the order to bill each owner.',
          v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
        );
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (
            user_id, title, message, notification_type,
            related_entity_type, related_entity_id
          ) VALUES (
            v_admin.id,
            'Order needs split billing',
            'Delivery ' || v_delivery.delivery_number || ' completed on a field/acre-allocated order. The mono-bill auto-invoice was skipped — open the order and use "Create Split Invoices" to bill each owner their own payable invoice.',
            'split_billing', 'order', v_delivery.order_id
          );
        END LOOP;
        END;
      ELSE
        -- Partial delivery of an allocated order (product still remains): keep today's
        -- skip-and-queue exactly. (Per-delivery split billing for partial orders is a separate redesign.)
        UPDATE orders SET needs_split_billing = true, updated_at = now()
          WHERE id = v_delivery.order_id;
        INSERT INTO activity_feed (
          event_type, description, performed_by,
          related_entity_type, related_entity_id, customer_id
        ) VALUES (
          'order_needs_split_billing',
          'Delivery ' || v_delivery.delivery_number || ' completed on a multi-owner (field/acre) order — auto-invoice skipped; create split invoices from the order to bill each owner.',
          v_actor, 'order', v_delivery.order_id, v_delivery.customer_id
        );
        FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
        LOOP
          INSERT INTO notifications (
            user_id, title, message, notification_type,
            related_entity_type, related_entity_id
          ) VALUES (
            v_admin.id,
            'Order needs split billing',
            'Delivery ' || v_delivery.delivery_number || ' completed on a field/acre-allocated order. The mono-bill auto-invoice was skipped — open the order and use "Create Split Invoices" to bill each owner their own payable invoice.',
            'split_billing', 'order', v_delivery.order_id
          );
        END LOOP;
      END IF;
      ELSE
      v_auto_invoice_number := next_invoice_number('chemical_sale');
      INSERT INTO invoices (
        invoice_number, invoice_type, order_id, customer_id, delivery_id,
        status, invoice_date, total_amount_cents, total_cost_cents, created_by
      ) VALUES (
        v_auto_invoice_number, 'chemical_sale', v_delivery.order_id, v_delivery.customer_id, p_delivery_id,
        'draft', v_effective_completion_date, 0, 0, v_actor
      ) RETURNING id INTO v_auto_invoice_id;

      v_auto_total_cents := 0;
      v_auto_cost_cents := 0;
      FOR v_item IN
        SELECT di.id AS di_id, di.product_id, di.quantity_delivered, di.unit_size, di.order_item_id, di.tote_number,
               oi.price_per_unit, oi.cost_per_unit, oi.product_name AS oi_product_name,
               p.product_name AS p_name
          FROM delivery_items di
          JOIN order_items oi ON oi.id = di.order_item_id
          JOIN products p ON p.id = di.product_id
         WHERE di.delivery_id = p_delivery_id
           AND COALESCE(di.quantity_delivered, 0) > 0
      LOOP
        v_line_alloc_cents := public._allocated_delivery_cents(
                                v_item.order_item_id, v_item.quantity_delivered, NULL);
        v_auto_total_cents := v_auto_total_cents + v_line_alloc_cents;
        v_auto_cost_cents  := v_auto_cost_cents  + ROUND(v_item.quantity_delivered * COALESCE(v_item.cost_per_unit, 0) * 100)::bigint;
        INSERT INTO invoice_items (
          invoice_id, order_item_id, product_id, description,
          quantity, unit_price_cents, extended_cents, cost_cents,
          unit_size, tote_number
        ) VALUES (
          v_auto_invoice_id, v_item.order_item_id, v_item.product_id,
          COALESCE(v_item.oi_product_name, v_item.p_name),
          v_item.quantity_delivered,
          ROUND(v_item.price_per_unit * 100)::bigint,
          v_line_alloc_cents,
          ROUND(COALESCE(v_item.cost_per_unit, 0) * 100)::bigint,
          v_item.unit_size,
          v_item.tote_number
        );
      END LOOP;

      UPDATE invoices
         SET total_amount_cents = v_auto_total_cents,
             total_cost_cents   = v_auto_cost_cents
       WHERE id = v_auto_invoice_id;

      -- Overnight bug-hunt MED (20260620): provenance breadcrumb. Write the same
      -- financial_audit_log 'invoice_created' row create_invoice_from_order /
      -- create_invoice_for_unbilled_delivery write, so the append-only ledger
      -- records this auto-creator too (it previously logged only activity_feed).
      -- Draft-stage provenance; post_invoice still writes 'invoice_posted' later.
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_auto_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object(
          'invoice_number', v_auto_invoice_number,
          'delivery_id', p_delivery_id,
          'order_id', v_delivery.order_id,
          'customer_id', v_delivery.customer_id,
          'total_cents', v_auto_total_cents
        ),
        v_auto_total_cents,
        'Invoice ' || v_auto_invoice_number || ' auto-created on completion of delivery ' || v_delivery.delivery_number
      );
      END IF;
    END IF;
  END IF;

  -- U9: short-stock WARN emit (mirrors the backdated-period warn+notify pattern above).
  IF v_short_count > 0 THEN
    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id, customer_id
    ) VALUES (
      'delivery_short_stock',
      'WARNING: Delivery ' || v_delivery.delivery_number || ' completed with ' || v_short_count ||
        ' product(s) short on stock: ' || array_to_string(v_stock_warnings, ' | ') ||
        '. Completion proceeded; on-hand inventory went negative — review with the warehouse.',
      v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
    );
    FOR v_admin IN SELECT id FROM profiles WHERE role = 'admin' AND is_active = true
    LOOP
      INSERT INTO notifications (
        user_id, title, message, notification_type,
        related_entity_type, related_entity_id
      ) VALUES (
        v_admin.id,
        'Short Stock — Delivery ' || v_delivery.delivery_number,
        'Delivery ' || v_delivery.delivery_number || ' was completed but ' || v_short_count ||
          ' product(s) did not have enough on-hand stock: ' || array_to_string(v_stock_warnings, ' | ') ||
          '. The completion proceeded and inventory went negative; please review.',
        'stock_warning', 'delivery', p_delivery_id
      );
    END LOOP;
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type, related_entity_id, customer_id
  ) VALUES (
    'delivery_completed',
    'Delivery ' || v_delivery.delivery_number || ' completed. Signed by: ' || p_signed_by ||
      CASE WHEN v_any_partial THEN ' (partial delivery — remainders created)' ELSE '' END ||
      CASE WHEN v_auto_invoice_id IS NOT NULL THEN ' [draft invoice ' || v_auto_invoice_number || ' auto-created]' ELSE '' END,
    v_actor, 'delivery', p_delivery_id, v_delivery.customer_id
  );

  -- U9: additive result fields — warnings[] + short_stock_count.
  v_result := jsonb_build_object(
    'status', CASE WHEN v_any_partial THEN 'partial' ELSE 'completed' END,
    'delivery_id', p_delivery_id,
    'order_fulfilled', v_all_delivered,
    'auto_invoice', CASE
      WHEN v_auto_invoice_id IS NOT NULL THEN
        jsonb_build_object('invoice_id', v_auto_invoice_id, 'invoice_number', v_auto_invoice_number, 'total_cents', v_auto_total_cents)
      ELSE NULL
    END,
    'stock_warning', (v_short_count > 0),
    'short_stock_count', v_short_count,
    'warnings', to_jsonb(v_stock_warnings)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'complete_delivery', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

DO $postflight$
BEGIN
  IF to_regclass('pg_temp.order_invoice_own_name_tx') IS NULL THEN
    RAISE EXCEPTION 'ORDER_INVOICE_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  -- Two IFs, not one OR: the second reads the marker table, which must exist to be planned.
  IF (SELECT transaction_id FROM pg_temp.order_invoice_own_name_tx)
       IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'ORDER_INVOICE_OWN_NAME_NOT_IN_TRANSACTION: stop: apply this file as one transaction (scripts/apply-migration-file.mjs, or psql -1 -v ON_ERROR_STOP=1)';
  END IF;
  IF to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)')::oid
       IS DISTINCT FROM (SELECT single_oid FROM pg_temp.order_invoice_own_name_tx)
     OR to_regprocedure('public.create_split_invoices_from_order(uuid,uuid,text,text)')::oid
       IS DISTINCT FROM (SELECT split_oid FROM pg_temp.order_invoice_own_name_tx)
     OR to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)')::oid
       IS DISTINCT FROM (SELECT complete_oid FROM pg_temp.order_invoice_own_name_tx) THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_INVOICE_IDENTITY: the replace must preserve all three function OIDs';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_invoice_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) = 'c97b2be8bee9dd8baaaab92bc24b92e7'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.create_invoice_from_order(uuid,uuid,text,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_ORDER_INVOICE_WRAPPER_CONTRACT: public create_invoice_from_order body, signature or access drifted';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'create_split_invoices_from_order') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'uuid[]'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_order_id uuid, p_salesman_id uuid DEFAULT NULL::uuid, p_invoice_type text DEFAULT ''chemical_sale''::text, p_idempotency_key text DEFAULT NULL::text'
        AND md5(p.prosrc) = '0f1e36e8536fc56f08fcf6071ea76da8'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['authenticated', 'postgres', 'service_role']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public.create_split_invoices_from_order(uuid,uuid,text,text)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_SPLIT_INVOICE_WRAPPER_CONTRACT: public create_split_invoices_from_order body, signature or access drifted';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = '_complete_delivery_authorized_impl') <> 1
     OR (SELECT p.proowner = 'postgres'::regrole AND p.prosecdef AND p.provolatile = 'v'
        AND NOT p.proisstrict AND p.prorettype = 'jsonb'::regtype AND NOT p.proretset
        AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
        AND pg_get_function_arguments(p.oid) =
          'p_delivery_id uuid, p_signed_by text, p_performed_by uuid DEFAULT NULL::uuid, p_quantities jsonb DEFAULT NULL::jsonb, p_issue_type text DEFAULT NULL::text, p_issue_notes text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone'
        AND md5(p.prosrc) = '35737fb8d9f2dff727f8230c60781747'
        AND ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
            FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
           IS NOT DISTINCT FROM ARRAY['postgres']::text[]
        AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
        FROM pg_proc p WHERE p.oid = to_regprocedure('public._complete_delivery_authorized_impl(uuid,text,uuid,jsonb,text,text,text,timestamp with time zone)')) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTFLIGHT_COMPLETE_DELIVERY_CONTRACT: _complete_delivery_authorized_impl body, signature or access drifted';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: order invoices carry only the calling rep as salesperson (admins unrestricted; the delivery autosplit keeps the order''s); split invoices refuse other types and a missing key before any number is drawn';
END
$postflight$;
