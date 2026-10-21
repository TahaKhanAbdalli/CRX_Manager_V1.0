-- Written 2026-10-21. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- idempotency-body-check: exempt -- post_invoice and post_invoice_group require p_idempotency_key
--   and bind it to the full request with check_idempotency/save_idempotency; batch_post_invoices
--   keeps the live bound lifecycle claim (_claim_bound_lifecycle_idempotency /
--   _bind_completed_lifecycle_idempotency). The inner posting chain is called with a NULL key on
--   purpose: the outer function owns the key.
--
-- WHAT: Goal 3 "Post uses what was saved and reviewed" (docs/plans/2026-10-13-direction-and-goals.md;
--   docs/manual/KNOWN_ISSUES.md "OPEN 2026-10-09 - the regular invoice editor posts the old saved
--   amounts"). Posting takes the version of the invoice the screen loaded and refuses, inside the
--   posting transaction, when the saved invoice changed since then. So a save from a second tab or
--   by another user just before Post can no longer be posted unseen.
--
--   1. invoice_post_version(invoices): a PostgREST computed field. A screen selects it in the same
--      query as the invoice row, so the version and the row come from one snapshot. It is a hash of
--      everything posting bills or prints: the invoice row, the customer's payment terms (they set
--      the due date when the invoice has none), its lines, invoice shares, line shares, line
--      allocations and field locations. Cost columns are left out, so the hash carries no cost
--      (cost and margin are admin-only, Mason 2026-10-15). Admins and sales reps get a value; any
--      other caller gets NULL.
--   2. post_invoice(p_invoice_id, p_expected_version, p_idempotency_key): locks the invoice, its
--      lines and shares, refuses INVOICE_CHANGED_SINCE_LOADED when its version differs from the one sent, posts
--      through the unchanged posting chain, then re-hashes the lines and refuses (rolling the post
--      back) if any changed while it posted.
--   3. post_invoice_group(p_invoice_group_id, p_performed_by, p_expected_versions, p_idempotency_key):
--      p_expected_versions is {invoice_id: version} for every member the screen loaded. Refuses
--      when a member was added or removed, or any member's version differs; after posting, refuses
--      if the posted set is not exactly those members or any member's lines changed.
--   4. batch_post_invoices(p_invoices, p_idempotency_key): p_invoices is
--      [{invoice_id, expected_version}]; each row posts through post_invoice and a changed row is
--      reported as that row's failure, one at a time (Mason, 2026-10-15).
--   The old signatures, which take no version, are dropped so nothing can post around the check.
--
-- REPLAY BINDING: each idempotency key is bound to its full request (invoice or group, actor and
--   the expected version(s)), contract version 2. A retry with the same key and the same request
--   replays the stored result without posting again, even though posting itself changed the
--   version; the same key with a different request is refused (IDEMPOTENCY_ARGUMENT_MISMATCH).
--   The key's advisory lock is taken before the replay lookup, so two same-key calls serialize.
--
-- DEPLOY ORDER: applied before the app merge (ship.md). Until the new app is live, the old screens
--   call the dropped signatures and posting fails with "function not found"; nothing posts unseen.
--   Every other screen and RPC keeps working.
--
-- CALLERS (every app caller, checked 2026-10-21):
-- caller-analysis: post_invoice :: InvoiceDetail.tsx, Invoices.tsx, OfficeCockpit.tsx, OrderDetail.tsx, FieldApplicationInvoice.tsx, FieldInvoicesUnpostedPanel.tsx; each now sends the version it loaded
-- caller-analysis: post_invoice_group :: InvoiceDetail.tsx, Invoices.tsx, OrderDetail.tsx, FieldApplicationInvoice.tsx, FieldAppSplitInvoiceEditor.tsx; each now sends every member's loaded version
-- caller-analysis: batch_post_invoices :: no app caller (Invoices.tsx posts one row at a time); database callers: none
--
-- ROLLBACK: revert the app first (it sends the new arguments), then
--   DROP FUNCTION public.batch_post_invoices(jsonb, text);
--   DROP FUNCTION public.post_invoice_group(uuid, uuid, jsonb, text);
--   DROP FUNCTION public.post_invoice(uuid, text, text);
--   DROP TRIGGER trg_serialize_invoice_group_writes ON public.invoices;
--   DROP TRIGGER trg_serialize_invoice_group_writes ON public.field_app_locations;
--   DROP FUNCTION public._serialize_invoice_group_writes();
--   DROP FUNCTION public._lock_invoice_post_inputs(uuid[]);
--   DROP FUNCTION public.invoice_post_version(public.invoices);
--   DROP FUNCTION public._invoice_post_version(uuid);
--   DROP FUNCTION public._invoice_post_content_version(uuid);
--   and replay only these CREATE blocks with their GRANTs: post_invoice and batch_post_invoices
--   from 20260721145936_require_money_lifecycle_idempotency_keys.sql (md5 6a5e3ab75bc63936f23eab85383ff6ad
--   and 482bd8cd15728ffc51f83900eaf89b3c), post_invoice_group from
--   20261013220000_reps_work_any_customer.sql (md5 0ca458d38af4051c9e9100a4180e5000).

-- PREFLIGHT: the functions replaced or relied on must still be the bodies this file was written
-- against (read live 2026-10-21), and each public name must have exactly the one old overload.
DO $preflight$
DECLARE
  v_pin record;
  v_md5 text;
BEGIN
  FOR v_pin IN
    SELECT * FROM (VALUES
      ('public.post_invoice(uuid,text)', '6a5e3ab75bc63936f23eab85383ff6ad'),
      ('public.post_invoice_group(uuid,uuid,text)', '0ca458d38af4051c9e9100a4180e5000'),
      ('public.batch_post_invoices(uuid[],text)', '482bd8cd15728ffc51f83900eaf89b3c'),
      ('public._post_invoice_idem_impl_20260721(uuid,text)', '11626fd7f9d15ad9d507a6979068d5d7'),
      ('public._post_invoice_public_impl_20260718(uuid,text)', '6d01c09f033f8ae902c8f7f06b5d4101'),
      ('public._post_invoice_customer_scope_impl(uuid,text)', '19e42a65efb2f448880d7b9f33f5228a'),
      ('public._post_invoice_impl_20260714(uuid,text)', '9479af0a5477e89266e0264da44c766c'),
      ('public._post_invoice_group_customer_scope_impl(uuid,uuid,text)', 'e93f0592250fb22bb468182babd0cd63')
    ) AS pins(sig, md5)
  LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
      FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.sig);
    IF v_md5 IS DISTINCT FROM v_pin.md5 THEN
      RAISE EXCEPTION 'PREFLIGHT: % body drifted (md5 %), re-read it before applying', v_pin.sig, v_md5;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('post_invoice', 'post_invoice_group', 'batch_post_invoices',
                           'invoice_post_version', '_invoice_post_version', '_invoice_post_content_version', '_lock_invoice_post_inputs', '_serialize_invoice_group_writes')) <> 3 THEN
    RAISE EXCEPTION 'PREFLIGHT: unexpected overloads of the posting functions or the version helpers already exist';
  END IF;
END
$preflight$;

-- 1. The version.

-- The lines and everything tied to them. Posting never rewrites these, so the hash is the same
-- before and after a post; posting compares the two to catch a line write that raced it.
-- TimeZone is pinned so a timestamp renders the same whatever the caller's session sets
-- (PostgREST's Prefer: timezone header); otherwise load and post could hash differently.
CREATE FUNCTION public._invoice_post_content_version(p_invoice_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
  SELECT encode(sha256(convert_to(jsonb_build_array(
    (SELECT COALESCE(jsonb_agg(to_jsonb(ii) - ARRAY['cost_cents', 'return_credit_cogs_cents'] ORDER BY ii.id), '[]'::jsonb)
       FROM public.invoice_items ii WHERE ii.invoice_id = p_invoice_id),
    (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]'::jsonb)
       FROM public.invoice_shares s WHERE s.invoice_id = p_invoice_id),
    (SELECT COALESCE(jsonb_agg(to_jsonb(ls) ORDER BY ls.id), '[]'::jsonb)
       FROM public.invoice_line_shares ls
       JOIN public.invoice_items ii ON ii.id = ls.invoice_item_id
      WHERE ii.invoice_id = p_invoice_id),
    (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb)
       FROM public.invoice_line_allocations a
      WHERE a.invoice_id = p_invoice_id OR a.split_invoice_id = p_invoice_id),
    -- A split field invoice's locations are keyed by its group with invoice_id NULL.
    (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.id), '[]'::jsonb)
       FROM public.field_app_locations l
      WHERE l.invoice_id = p_invoice_id
         OR (l.invoice_id IS NULL
             AND l.invoice_group_id = (SELECT i.invoice_group_id FROM public.invoices i WHERE i.id = p_invoice_id)))
  )::text, 'UTF8')), 'hex')
$fn$;

-- The whole version: the invoice row (any change to it, including updated_at, is a change), the
-- customer's payment terms, and the lines. NULL when the invoice does not exist.
CREATE FUNCTION public._invoice_post_version(p_invoice_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
  SELECT 'v1:' || encode(sha256(convert_to(jsonb_build_array(
           to_jsonb(i) - 'total_cost_cents',
           (SELECT c.payment_terms FROM public.customers c WHERE c.id = i.customer_id),
           public._invoice_post_content_version(i.id)
         )::text, 'UTF8')), 'hex')
    FROM public.invoices i
   WHERE i.id = p_invoice_id
$fn$;

-- The computed field screens select (`invoice_post_version` in a PostgREST select). STABLE, so it
-- reads the same snapshot as the row it is returned with. It is also callable as an RPC with a
-- made-up row, so it answers only for an invoice the caller may post: any invoice for an admin,
-- one under the rep's own name for a rep (the posting own-name rule).
-- NOTE for Goal 1 step 3: a computed field receives the whole row, which needs SELECT on every
-- invoices column. Revoking a cost column from authenticated breaks every select of this field
-- (posting then refuses, it never mis-posts); that change must move it to a column-safe form.
CREATE FUNCTION public.invoice_post_version(p_invoice public.invoices)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT public._invoice_post_version(i.id)
    FROM public.invoices i
    JOIN public.profiles p ON p.id = auth.uid() AND p.is_active = true
   WHERE i.id = p_invoice.id
     AND (p.role = 'admin'
          OR (p.role = 'sales_rep'
              AND (i.salesman_id = p.id OR (i.salesman_id IS NULL AND i.created_by = p.id))))
$fn$;

COMMENT ON FUNCTION public.invoice_post_version(public.invoices) IS
  'Version of the saved invoice for posting (Goal 3, 2026-10-21). Select it with the invoice row and send it to post_invoice / post_invoice_group, which refuse INVOICE_CHANGED_SINCE_LOADED if the invoice changed since. Admins and sales reps only; carries no cost.';

-- The rest of what the version covers, locked by posting after the invoice, its lines and shares:
-- line shares, line allocations, field locations (also group-keyed ones) and the customer row
-- (payment terms), so a write to any of them either lands first and is seen, or waits.
CREATE FUNCTION public._lock_invoice_post_inputs(p_invoice_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  PERFORM 1 FROM public.invoice_line_shares ls
    JOIN public.invoice_items ii ON ii.id = ls.invoice_item_id
   WHERE ii.invoice_id = ANY (p_invoice_ids)
   ORDER BY ls.id FOR UPDATE OF ls;
  PERFORM 1 FROM public.invoice_line_allocations a
   WHERE a.invoice_id = ANY (p_invoice_ids) OR a.split_invoice_id = ANY (p_invoice_ids)
   ORDER BY a.id FOR UPDATE;
  PERFORM 1 FROM public.field_app_locations l
   WHERE l.invoice_id = ANY (p_invoice_ids)
      OR (l.invoice_id IS NULL AND l.invoice_group_id IN (
            SELECT i.invoice_group_id FROM public.invoices i WHERE i.id = ANY (p_invoice_ids)))
   ORDER BY l.id FOR UPDATE;
  PERFORM 1 FROM public.customers c
   WHERE c.id IN (SELECT i.customer_id FROM public.invoices i WHERE i.id = ANY (p_invoice_ids))
   ORDER BY c.id FOR SHARE;
END;
$fn$;

-- Row locks cannot stop an INSERT that references a group only by invoice_group_id (a new member,
-- or a group-keyed field location with invoice_id NULL). The posting RPCs and the group save RPCs
-- already serialize on the group advisory lock; this trigger makes every other write to a group's
-- membership or its locations take the same lock, so it waits for an in-flight group post.
CREATE FUNCTION public._serialize_invoice_group_writes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_group uuid;
BEGIN
  -- Both the old and the new group are locked, always in uuid order, so two writers moving rows
  -- between the same two groups cannot deadlock on each other's group lock.
  FOR v_group IN
    SELECT DISTINCT g FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.invoice_group_id END,
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.invoice_group_id END]) g
     WHERE g IS NOT NULL
     ORDER BY g
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_group::text, 0));
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;

CREATE TRIGGER trg_serialize_invoice_group_writes
  BEFORE INSERT OR UPDATE OF invoice_group_id, deleted_at ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._serialize_invoice_group_writes();
CREATE TRIGGER trg_serialize_invoice_group_writes
  BEFORE INSERT OR UPDATE OR DELETE ON public.field_app_locations
  FOR EACH ROW EXECUTE FUNCTION public._serialize_invoice_group_writes();

REVOKE ALL ON FUNCTION public._serialize_invoice_group_writes() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._lock_invoice_post_inputs(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._invoice_post_content_version(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._invoice_post_version(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoice_post_version(public.invoices) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invoice_post_version(public.invoices) TO authenticated, service_role;

-- 2. Single invoice.
DROP FUNCTION public.post_invoice(uuid, text);

CREATE FUNCTION public.post_invoice(
  p_invoice_id uuid,
  p_expected_version text,
  p_idempotency_key text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_request jsonb;
  v_existing jsonb;
  v_number text;
  v_salesman_id uuid;
  v_created_by uuid;
  v_current text;
  v_content text;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: post_invoice' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  v_request := jsonb_build_object(
    'version', 2,
    'invoice_id', p_invoice_id,
    'actor_id', v_actor,
    'expected_version', p_expected_version
  );

  PERFORM pg_advisory_xact_lock(hashtextextended('post_invoice:' || p_idempotency_key, 0));
  v_existing := public.check_idempotency(p_idempotency_key, 'post_invoice');
  IF v_existing IS NOT NULL THEN
    IF NOT (v_existing ? 'request' AND v_existing ? 'response') THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_FORMAT_INVALID: post_invoice';
    END IF;
    IF v_existing->'request' IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: post_invoice key was already used for a different invoice, actor or invoice version';
    END IF;
    RETURN;
  END IF;

  IF p_expected_version IS NULL OR p_expected_version !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'INVOICE_VERSION_REQUIRED: post_invoice needs the version of the invoice the screen loaded'
      USING ERRCODE = '22023';
  END IF;

  SELECT invoice_number, salesman_id, created_by INTO v_number, v_salesman_id, v_created_by
    FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_NOT_FOUND'; END IF;
  -- The rep own-name rule (enforced again by the posting chain below) is checked before the
  -- version, so a rep is told the invoice is not theirs rather than to reload it.
  IF v_actor_role = 'sales_rep'
     AND NOT (v_salesman_id IS NOT DISTINCT FROM v_actor
             OR (v_salesman_id IS NULL AND v_created_by IS NOT DISTINCT FROM v_actor)) THEN
    RAISE EXCEPTION 'INVOICE_SCOPE_DENIED';
  END IF;
  -- Lock the lines and shares too, so a write to one that does not lock the invoice row (a direct
  -- line update) finishes first and is seen below, or waits for this post.
  PERFORM 1 FROM public.invoice_items WHERE invoice_id = p_invoice_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.invoice_shares WHERE invoice_id = p_invoice_id ORDER BY id FOR UPDATE;
  PERFORM public._lock_invoice_post_inputs(ARRAY[p_invoice_id]);

  -- The rows are locked: a save now waits for this post. A save that committed since the screen
  -- loaded changed the version.
  v_current := public._invoice_post_version(p_invoice_id);
  IF v_current IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'INVOICE_CHANGED_SINCE_LOADED: invoice % was changed after this screen loaded it. Reload it, check it, then post again.', v_number;
  END IF;
  v_content := public._invoice_post_content_version(p_invoice_id);

  PERFORM public._post_invoice_idem_impl_20260721(p_invoice_id, NULL);

  -- A line write that does not lock the invoice row could have committed while this posted.
  IF public._invoice_post_content_version(p_invoice_id) IS DISTINCT FROM v_content THEN
    RAISE EXCEPTION 'INVOICE_CHANGED_SINCE_LOADED: invoice % was changed while it was being posted. Reload it, check it, then post again.', v_number;
  END IF;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'post_invoice',
    jsonb_build_object(
      'request', v_request,
      'response', jsonb_build_object('success', true, 'invoice_id', p_invoice_id)
    )
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.post_invoice(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice(uuid, text, text) TO authenticated, service_role;

-- 3. Invoice group.
DROP FUNCTION public.post_invoice_group(uuid, uuid, text);

CREATE FUNCTION public.post_invoice_group(
  p_invoice_group_id uuid,
  p_performed_by uuid,
  p_expected_versions jsonb,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_request jsonb;
  v_existing jsonb;
  v_expected_ids uuid[];
  v_current_ids uuid[];
  v_posted_ids uuid[];
  v_member record;
  v_content jsonb := '{}'::jsonb;
  v_expected jsonb;
  v_result jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: post_invoice_group' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'ACTOR_MISMATCH'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  IF p_invoice_group_id IS NULL THEN RAISE EXCEPTION 'invoice_group_id is required'; END IF;

  -- {invoice_id: version} for every member the screen loaded. Validated and normalized to
  -- canonical (lower-case) uuid keys first, so the replay binding below compares the same request
  -- however the caller spelled the ids, and two spellings of one id are refused.
  IF p_expected_versions IS NULL OR jsonb_typeof(p_expected_versions) <> 'object'
     OR p_expected_versions = '{}'::jsonb
     OR EXISTS (
       SELECT 1 FROM jsonb_each(p_expected_versions) e
        WHERE e.key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) <> 'string'
           OR (e.value #>> '{}') !~ '[^[:space:]]'
     ) THEN
    RAISE EXCEPTION 'INVOICE_VERSION_REQUIRED: post_invoice_group needs the version of every invoice in the group the screen loaded'
      USING ERRCODE = '22023';
  END IF;
  -- Only now are the keys known to be uuids, so they can be cast.
  IF (SELECT count(DISTINCT e.key::uuid) <> count(*) FROM jsonb_each(p_expected_versions) e) THEN
    RAISE EXCEPTION 'INVOICE_VERSION_REQUIRED: post_invoice_group was sent the same invoice twice'
      USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_object_agg(e.key::uuid::text, e.value) INTO v_expected
    FROM jsonb_each(p_expected_versions) e;
  SELECT array_agg(e.key::uuid ORDER BY e.key::uuid) INTO v_expected_ids
    FROM jsonb_each(v_expected) e;

  v_request := jsonb_build_object(
    'version', 2,
    'invoice_group_id', p_invoice_group_id,
    'actor_id', v_actor,
    'expected_versions', v_expected
  );

  PERFORM pg_advisory_xact_lock(hashtextextended('post_invoice_group:' || p_idempotency_key, 0));
  v_existing := public.check_idempotency(p_idempotency_key, 'post_invoice_group');
  IF v_existing IS NOT NULL THEN
    IF NOT (v_existing ? 'request' AND v_existing ? 'response') THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_FORMAT_INVALID: post_invoice_group';
    END IF;
    IF v_existing->'request' IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'IDEMPOTENCY_ARGUMENT_MISMATCH: post_invoice_group key was already used for a different group, actor or invoice versions';
    END IF;
    RETURN v_existing->'response';
  END IF;

  -- The group advisory lock: every RPC that writes a group's members or group-keyed field
  -- locations takes it, and so does trg_serialize_invoice_group_writes for a direct write, so the
  -- membership and those rows cannot change while this posts.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_invoice_group_id::text, 0));
  PERFORM 1
    FROM public.invoices
   WHERE invoice_group_id = p_invoice_group_id
     AND deleted_at IS NULL
   ORDER BY id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No invoices found in group %', p_invoice_group_id;
  END IF;

  -- Reps post invoice groups for ANY customer (Mason, 2026-10-13; 20261013220000 removed
  -- the assigned-rep check), but only when every invoice in the group is under their own name
  -- (they are its salesperson, or it has none and they created it). Checked before the line locks.
  IF v_actor_role = 'sales_rep'
     AND EXISTS (
       SELECT 1
         FROM public.invoices invoice_row
        WHERE invoice_row.invoice_group_id = p_invoice_group_id
          AND invoice_row.deleted_at IS NULL
          AND NOT (invoice_row.salesman_id IS NOT DISTINCT FROM v_actor
             OR (invoice_row.salesman_id IS NULL AND invoice_row.created_by IS NOT DISTINCT FROM v_actor))
     ) THEN
    RAISE EXCEPTION 'INVOICE_SCOPE_DENIED';
  END IF;

  PERFORM 1 FROM public.invoice_items
   WHERE invoice_id IN (SELECT id FROM public.invoices
                         WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL)
   ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.invoice_shares
   WHERE invoice_id IN (SELECT id FROM public.invoices
                         WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL)
   ORDER BY id FOR UPDATE;
  PERFORM public._lock_invoice_post_inputs(ARRAY(
    SELECT id FROM public.invoices WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL));

  SELECT array_agg(id ORDER BY id) INTO v_current_ids
    FROM public.invoices
   WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL;
  IF v_current_ids IS DISTINCT FROM v_expected_ids THEN
    RAISE EXCEPTION 'INVOICE_CHANGED_SINCE_LOADED: invoices were added to or removed from this split group after this screen loaded it. Reload it, check it, then post again.';
  END IF;

  FOR v_member IN
    SELECT id, invoice_number
      FROM public.invoices
     WHERE invoice_group_id = p_invoice_group_id AND deleted_at IS NULL
     ORDER BY invoice_number
  LOOP
    IF public._invoice_post_version(v_member.id) IS DISTINCT FROM (v_expected ->> v_member.id::text) THEN
      RAISE EXCEPTION 'INVOICE_CHANGED_SINCE_LOADED: invoice % in this split group was changed after this screen loaded it. Reload it, check it, then post again.', v_member.invoice_number;
    END IF;
    v_content := v_content || jsonb_build_object(v_member.id::text, public._invoice_post_content_version(v_member.id));
  END LOOP;

  v_result := public._post_invoice_group_customer_scope_impl(p_invoice_group_id, p_performed_by, NULL);

  SELECT array_agg(x::uuid ORDER BY x::uuid) INTO v_posted_ids
    FROM jsonb_array_elements_text(v_result->'posted_invoice_ids') x;
  IF v_posted_ids IS DISTINCT FROM v_expected_ids THEN
    RAISE EXCEPTION 'INVOICE_CHANGED_SINCE_LOADED: this split group changed while it was being posted. Reload it, check it, then post again.';
  END IF;
  FOR v_member IN
    SELECT id, invoice_number FROM public.invoices WHERE id = ANY (v_expected_ids)
  LOOP
    IF public._invoice_post_content_version(v_member.id) IS DISTINCT FROM (v_content ->> v_member.id::text) THEN
      RAISE EXCEPTION 'INVOICE_CHANGED_SINCE_LOADED: invoice % in this split group was changed while it was being posted. Reload it, check it, then post again.', v_member.invoice_number;
    END IF;
  END LOOP;

  PERFORM public.save_idempotency(
    p_idempotency_key,
    'post_invoice_group',
    jsonb_build_object('request', v_request, 'response', v_result)
  );
  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.post_invoice_group(uuid, uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice_group(uuid, uuid, jsonb, text) TO authenticated, service_role;

-- 4. Batch: each row posts through post_invoice with its own version; a refused row is reported
-- as that row's failure and the others still post. The body is the live one with the loop
-- reading {invoice_id, expected_version} items.
DROP FUNCTION public.batch_post_invoices(uuid[], text);

CREATE FUNCTION public.batch_post_invoices(p_invoices jsonb, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_item jsonb; v_id uuid; v_count int := 0; v_total bigint := 0; v_actor uuid;
  v_actor_role text; v_existing jsonb; v_failures jsonb := '[]'::jsonb;
  v_first_posted uuid; v_posted_ids uuid[] := '{}'; v_err text;
  v_result jsonb; v_index int := 0;
  v_contract CONSTANT text := 'batch_post_invoices_v3';
  v_request jsonb; v_fingerprint text;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '[^[:space:]]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: batch_post_invoices'
      USING ERRCODE = '22023';
  END IF;
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor AND is_active = true AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'Not authorized to batch post invoices'; END IF;
  SELECT role INTO v_actor_role FROM public.profiles WHERE id = v_actor;
  IF p_invoices IS NULL OR jsonb_typeof(p_invoices) <> 'array' OR jsonb_array_length(p_invoices) = 0 THEN
    RAISE EXCEPTION 'No invoice IDs provided';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_invoices) e
     WHERE jsonb_typeof(e) <> 'object'
        OR (e ->> 'invoice_id') IS NULL
        OR (e ->> 'invoice_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(e -> 'expected_version') IS DISTINCT FROM 'string'
        OR (e ->> 'expected_version') !~ '[^[:space:]]'
  ) THEN
    RAISE EXCEPTION 'INVOICE_VERSION_REQUIRED: batch_post_invoices takes [{invoice_id, expected_version}]'
      USING ERRCODE = '22023';
  END IF;
  v_request := jsonb_build_object(
    'contract_version', v_contract,
    'actor_id', v_actor,
    'invoices', p_invoices
  );
  v_fingerprint := md5(v_request::text);
  v_existing := public._claim_bound_lifecycle_idempotency(
    p_idempotency_key, 'batch_post_invoices', v_contract,
    v_fingerprint, v_request
  );
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  FOR v_item IN SELECT e FROM jsonb_array_elements(p_invoices) e LOOP
    v_index := v_index + 1;
    v_id := (v_item ->> 'invoice_id')::uuid;
    BEGIN
      PERFORM public.post_invoice(
        -- The child key is namespaced to the batch, so a direct post_invoice call can never have
        -- used it and the batch never counts someone else's replay as its own post.
        v_id, v_item ->> 'expected_version', 'batch_post_invoices:' || p_idempotency_key || ':post:' || v_index::text
      );
      v_count := v_count + 1;
      IF v_first_posted IS NULL THEN v_first_posted := v_id; END IF;
      v_posted_ids := array_append(v_posted_ids, v_id);
      v_total := v_total + COALESCE((
        SELECT total_amount_cents FROM public.invoices WHERE id = v_id
      ), 0);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      v_failures := v_failures || jsonb_build_object('invoice_id', v_id, 'error', v_err);
    END;
  END LOOP;

  IF v_count > 0 THEN
    INSERT INTO public.financial_audit_log (
      operation_type, entity_type, entity_id, actor_role,
      new_values, total_impact_cents, description
    ) VALUES (
      'invoice_posted', 'invoice', v_first_posted, v_actor_role,
      jsonb_build_object('batch_count', v_count,
        'failed_count', jsonb_array_length(v_failures),
        'invoice_ids', to_jsonb(v_posted_ids)),
      v_total,
      'Batch posted ' || v_count || ' invoice(s) totaling $' ||
        (v_total / 100.0)::numeric(12,2) ||
        CASE WHEN jsonb_array_length(v_failures) > 0
          THEN ' (' || jsonb_array_length(v_failures) || ' failed)' ELSE '' END
    );
  END IF;
  v_result := jsonb_build_object('success', jsonb_array_length(v_failures) = 0,
    'count', v_count, 'total_cents', v_total, 'failed', v_failures);
  PERFORM public._bind_completed_lifecycle_idempotency(
    p_idempotency_key, 'batch_post_invoices', v_contract,
    v_fingerprint, v_request, v_result
  );
  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.batch_post_invoices(jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.batch_post_invoices(jsonb, text) TO authenticated, service_role;

-- POSTFLIGHT: exactly one overload of each public name, the right grants, and no anon access.
DO $postflight$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('post_invoice', 'post_invoice_group', 'batch_post_invoices', 'invoice_post_version')) <> 4 THEN
    RAISE EXCEPTION 'POSTFLIGHT: expected exactly one overload of each posting function';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.post_invoice(uuid,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.post_invoice_group(uuid,uuid,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.batch_post_invoices(jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.invoice_post_version(public.invoices)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.post_invoice(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.post_invoice_group(uuid,uuid,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.batch_post_invoices(jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.invoice_post_version(public.invoices)', 'EXECUTE')
     OR EXISTS (
       -- The helpers and the inner posting chain stay out of every API role's reach, so nothing
       -- can post around the version check.
       SELECT 1
         FROM unnest(ARRAY[
                'public._invoice_post_version(uuid)', 'public._invoice_post_content_version(uuid)',
                'public._lock_invoice_post_inputs(uuid[])', 'public._serialize_invoice_group_writes()',
                'public._post_invoice_idem_impl_20260721(uuid,text)', 'public._post_invoice_public_impl_20260718(uuid,text)',
                'public._post_invoice_customer_scope_impl(uuid,text)', 'public._post_invoice_impl_20260714(uuid,text)',
                'public._post_invoice_group_customer_scope_impl(uuid,uuid,text)',
                'public._post_deleted_delivery_recovery_invoice_20260719(uuid)']) fn,
              unnest(ARRAY['anon', 'authenticated', 'public']) r
        WHERE has_function_privilege(r, fn, 'EXECUTE')) THEN
    RAISE EXCEPTION 'POSTFLIGHT: posting function grants are wrong';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';
