-- Bulk purchase-order import: the document content fingerprint leaves out cost
-- (unit_cost, unit_cost_cents) for everyone.
-- idempotency-body-check: exempt -- this internal writer checks the key for replay and delegates
-- recording it to _save_purchase_order_atomic_number_impl -> _save_purchase_order_cost_input_impl,
-- which calls save_idempotency; unchanged from 20260717112906 apart from the fingerprint step.
--
-- Why: since 20261021140000 (purchase cost is admin-only) save_purchase_order
-- strips unit_cost / unit_cost_cents from a non-admin's lines before this
-- writer runs, while an admin's lines keep them. The fingerprint hashed the
-- lines as received, so a sales rep's import and an admin's import of the same
-- vendor document no longer matched: the admin got
-- BULK_PO_DOCUMENT_CONTENT_CONFLICT instead of "already_imported". No second
-- purchase order was ever created; the refusal was only unfriendly.
--
-- Now both roles fingerprint the same reviewed content (invoice date, products,
-- quantities, units, notes). Cost is not document identity: an admin corrects
-- cost on the existing purchase order with set_purchase_order_item_costs. A real
-- content change (different quantity, product, unit or invoice date) still
-- raises BULK_PO_DOCUMENT_CONTENT_CONFLICT, and a same-key retry still compares
-- against the stored fingerprint.
--
-- Stored fingerprints: a claim stored before this migration from lines that
-- carried cost would keep its old hash, so a same-key retry of that request
-- would get the conflict refusal instead of its saved result. Live had 0 claims
-- on 2026-10-22, so the preflight locks the claim table (no import can commit a
-- claim while this applies) and refuses to apply while any claim exists; with
-- none, every stored fingerprint is computed by the new rule.
--
-- Only the canonical-items step of _save_purchase_order_ascii_identity_impl
-- changes; the rest of the body is the live 2026-10-22 body (from
-- 20260717112906) unchanged. Non-destructive: no rows, no grants widened.
--
-- Rollback: run only the CREATE OR REPLACE FUNCTION statement from
-- 20260717112906 (not that whole file: its preflight expects an older body).
-- It restores the cost-sensitive fingerprint; there is no data to undo. A claim
-- an admin stored with cost while this rule was live then conflicts on a later
-- re-import that carries cost (no duplicate, no write).

-- Held until this transaction commits: an import cannot store a claim under the
-- old rule between the check below and the new body.
LOCK TABLE public.purchase_order_import_intents IN SHARE MODE;

DO $preflight$
DECLARE
  v_md5 text;
  v_claims bigint;
BEGIN
  SELECT count(*) INTO v_claims FROM public.purchase_order_import_intents;
  IF v_claims <> 0 THEN
    RAISE EXCEPTION 'BULK_PO_FINGERPRINT_PREFLIGHT: % stored import claim(s) were fingerprinted by the old rule; re-plan before applying', v_claims;
  END IF;
  SELECT md5(replace(prosrc, chr(13), ''))
    INTO v_md5
    FROM pg_proc
   WHERE oid = to_regprocedure('public._save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text)');
  IF v_md5 IS DISTINCT FROM 'f5b2c9e81df528a449881ecd339ee54a' THEN
    RAISE EXCEPTION 'BULK_PO_FINGERPRINT_PREFLIGHT: public._save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text) changed since 2026-10-22 (md5 %)', COALESCE(v_md5, 'missing');
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public._save_purchase_order_ascii_identity_impl(
  p_po_id uuid,
  p_po_payload jsonb,
  p_items jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_payload jsonb := COALESCE(p_po_payload, '{}'::jsonb);
  v_result jsonb;
  v_po_number text;
  v_bulk_import_requested boolean :=
    NULLIF(btrim(v_payload->>'bulk_import_intent_key'), '') IS NOT NULL;
  v_bulk_intent_key text;
  v_requested_vendor text := NULLIF(btrim(v_payload->>'vendor'), '');
  v_vendor_reference text := NULLIF(btrim(v_payload->>'bulk_import_vendor_reference'), '');
  v_invoice_date text := NULLIF(btrim(v_payload->>'bulk_import_invoice_date'), '');
  v_identity_vendor text;
  v_identity_vendor_reference text;
  v_expected_intent_key text;
  v_canonical_items jsonb;
  v_content_fingerprint text;
  v_existing_po_id uuid;
  v_existing_intent_key text;
  v_existing_content_fingerprint text;
  v_cached jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'Only admins or sales reps can manage purchase orders';
  END IF;

  IF v_bulk_import_requested THEN
    IF v_requested_vendor IS NULL THEN
      RAISE EXCEPTION 'BULK_PO_VENDOR_REQUIRED';
    END IF;
    IF v_vendor_reference IS NULL THEN
      RAISE EXCEPTION 'BULK_PO_VENDOR_REFERENCE_REQUIRED';
    END IF;

    v_identity_vendor := normalize(
      lower(normalize(v_requested_vendor, NFKC)),
      NFKC
    );
    v_identity_vendor_reference := normalize(
      lower(normalize(v_vendor_reference, NFKC)),
      NFKC
    );

    IF p_po_id IS NOT NULL
       OR p_idempotency_key IS NULL
       OR length(v_vendor_reference) > 512
       OR strpos(v_identity_vendor, chr(31)) > 0
       OR strpos(v_identity_vendor_reference, chr(31)) > 0 THEN
      RAISE EXCEPTION 'BULK_PO_INTENT_INVALID';
    END IF;
    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_items) = 0 THEN
      RAISE EXCEPTION 'PO_ITEMS_REQUIRED';
    END IF;

    v_expected_intent_key := 'bulk-po-document:' || encode(
      extensions.digest(
        convert_to(
          v_identity_vendor || chr(31) || v_identity_vendor_reference,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );
    v_bulk_intent_key := v_expected_intent_key;

    -- Cost is admin-only (20261021140000): save_purchase_order strips it from a
    -- non-admin's lines, so it is left out here for everyone. A rep's and an
    -- admin's import of one document then fingerprint the same content.
    SELECT COALESCE(
      jsonb_agg(item.value ORDER BY item.value::text),
      '[]'::jsonb
    )
      INTO v_canonical_items
      FROM (
        SELECT CASE
                 WHEN jsonb_typeof(raw.value) = 'object'
                   THEN raw.value - 'unit_cost' - 'unit_cost_cents'
                 ELSE raw.value
               END AS value
          FROM jsonb_array_elements(p_items) AS raw(value)
      ) AS item;

    v_content_fingerprint := encode(
      extensions.digest(
        convert_to(
          jsonb_build_object(
            'invoice_date', v_invoice_date,
            'items', v_canonical_items
          )::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );

    -- Replace any legacy browser digest with the server-derived key consumed
    -- by the atomic writer's claim insert. The marker itself is not persisted.
    v_payload := jsonb_set(
      jsonb_set(
        jsonb_set(
          v_payload - 'bulk_import_document',
          '{bulk_import_intent_key}',
          to_jsonb(v_bulk_intent_key),
          true
        ),
        '{vendor}',
        to_jsonb(v_requested_vendor),
        true
      ),
      '{bulk_import_vendor_reference}',
      to_jsonb(v_vendor_reference),
      true
    );
  END IF;

  -- A committed same-key replay is valid only for the exact server-derived
  -- document identity and reviewed content. Do not compare the PO's mutable
  -- current vendor: an edit after commit must not break a lost-response retry.
  IF p_idempotency_key IS NOT NULL THEN
    v_cached := public.check_idempotency(
      p_idempotency_key,
      'save_purchase_order'
    );
    IF v_cached IS NOT NULL THEN
      v_existing_po_id := NULLIF(v_cached->>'po_id', '')::uuid;
      IF v_existing_po_id IS NULL THEN
        RAISE EXCEPTION 'SAVE_PURCHASE_ORDER_RESULT_INVALID';
      END IF;
      IF p_po_id IS NOT NULL AND p_po_id IS DISTINCT FROM v_existing_po_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;

      SELECT po.po_number
        INTO v_po_number
        FROM public.purchase_orders AS po
       WHERE po.id = v_existing_po_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Purchase order not found after save: %', v_existing_po_id;
      END IF;

      IF v_bulk_intent_key IS NOT NULL THEN
        SELECT claim.intent_key, claim.content_fingerprint
          INTO v_existing_intent_key, v_existing_content_fingerprint
          FROM public.purchase_order_import_intents AS claim
         WHERE claim.purchase_order_id = v_existing_po_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'BULK_PO_IMPORT_CLAIM_MISSING';
        END IF;
        IF v_existing_intent_key IS DISTINCT FROM v_bulk_intent_key THEN
          RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
        END IF;
        IF v_existing_content_fingerprint IS DISTINCT FROM v_content_fingerprint THEN
          RAISE EXCEPTION 'BULK_PO_DOCUMENT_CONTENT_CONFLICT';
        END IF;
      END IF;

      RETURN v_cached || jsonb_build_object('po_number', v_po_number);
    END IF;
  END IF;

  IF v_bulk_intent_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('bulk_po:' || v_bulk_intent_key, 0)
    );
    SELECT
      claim.purchase_order_id,
      po.po_number,
      claim.content_fingerprint
      INTO
        v_existing_po_id,
        v_po_number,
        v_existing_content_fingerprint
      FROM public.purchase_order_import_intents AS claim
      JOIN public.purchase_orders AS po
        ON po.id = claim.purchase_order_id
     WHERE claim.intent_key = v_bulk_intent_key;
    IF FOUND THEN
      IF v_existing_content_fingerprint IS DISTINCT FROM v_content_fingerprint THEN
        RAISE EXCEPTION 'BULK_PO_DOCUMENT_CONTENT_CONFLICT';
      END IF;
      RETURN jsonb_build_object(
        'status', 'already_imported',
        'po_id', v_existing_po_id,
        'po_number', v_po_number
      );
    END IF;
  END IF;

  IF p_po_id IS NULL THEN
    v_po_number := public.next_po_number();
    v_payload := jsonb_set(
      v_payload,
      '{po_number}',
      to_jsonb(v_po_number),
      true
    );
  END IF;

  v_result := public._save_purchase_order_atomic_number_impl(
    p_po_id,
    v_payload,
    p_items,
    p_performed_by,
    p_idempotency_key
  );

  IF NULLIF(v_result->>'po_id', '') IS NOT NULL THEN
    v_existing_po_id := (v_result->>'po_id')::uuid;
    SELECT po_number
      INTO v_po_number
      FROM public.purchase_orders
     WHERE id = v_existing_po_id;
    IF v_po_number IS NOT NULL THEN
      v_result := v_result || jsonb_build_object('po_number', v_po_number);
    END IF;
  END IF;

  IF v_bulk_intent_key IS NOT NULL THEN
    UPDATE public.purchase_order_import_intents
       SET content_fingerprint = v_content_fingerprint
     WHERE purchase_order_id = v_existing_po_id
       AND intent_key = v_bulk_intent_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'BULK_PO_IMPORT_CLAIM_MISSING';
    END IF;
  END IF;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public._save_purchase_order_ascii_identity_impl(
  uuid, jsonb, jsonb, uuid, text
)
FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public._save_purchase_order_ascii_identity_impl(
  uuid, jsonb, jsonb, uuid, text
) IS 'Internal directly non-executable purchase-order writer. PostgreSQL derives the durable Unicode bulk identity, passes it to the atomic claim insert, and binds replay to reviewed content; the content fingerprint leaves out unit_cost and unit_cost_cents (cost is admin-only, 20261022100000).';

DO $verify$
DECLARE
  v_source text;
  v_config text[];
  v_security_definer boolean;
  v_sig constant text := 'public._save_purchase_order_ascii_identity_impl(uuid,jsonb,jsonb,uuid,text)';
BEGIN
  SELECT prosrc, proconfig, prosecdef
    INTO v_source, v_config, v_security_definer
    FROM pg_proc
   WHERE oid = v_sig::regprocedure;

  IF NOT v_security_definer
     OR v_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
    RAISE EXCEPTION 'Internal purchase-order writer security is incorrect';
  END IF;
  IF md5(replace(v_source, chr(13), '')) IS DISTINCT FROM '8abda47ee41b50063c45a6c181f90598' THEN
    RAISE EXCEPTION 'Bulk-PO cost-free fingerprint body is not the reviewed body';
  END IF;
  IF v_source NOT LIKE '%raw.value - ''unit_cost'' - ''unit_cost_cents''%'
     OR v_source NOT LIKE '%v_bulk_intent_key := v_expected_intent_key%'
     OR v_source NOT LIKE '%''{bulk_import_intent_key}''%to_jsonb(v_bulk_intent_key)%'
     OR (length(v_source) - length(replace(v_source, 'BULK_PO_DOCUMENT_CONTENT_CONFLICT', '')))
        / length('BULK_PO_DOCUMENT_CONTENT_CONFLICT') <> 2
     OR v_source NOT LIKE '%public.next_po_number()%' THEN
    RAISE EXCEPTION 'Bulk-PO cost-free fingerprint body is incomplete';
  END IF;
  IF has_function_privilege('anon', v_sig, 'EXECUTE')
     OR has_function_privilege('authenticated', v_sig, 'EXECUTE')
     OR has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'Internal purchase-order writer is directly executable';
  END IF;
END
$verify$;
