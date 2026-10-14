-- Written 2026-10-13. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md.
--
-- WHAT: sales reps work with ANY customer, not only the customers assigned to them.
--   * Invoicing: a rep creates, saves, posts and emails invoices (single, field-application split
--     and invoice groups) for any customer, under their OWN name only: save_invoice now forces a
--     rep's salesman_id to the rep (like the split writer already does) and SALESMAN_SCOPE_DENIED
--     still refuses a rep who names someone else; admins may name anyone. An EXISTING invoice
--     or split set a rep edits or posts must also be under the rep's own name: the rep is its
--     salesperson, or it has no salesperson and the rep created it (INVOICE_SCOPE_DENIED /
--     SPLIT_SET_NOT_OWNED). "Own name" below always means exactly that.
--   * Customers: a rep reads and edits every customer and every customer-related record:
--     addresses, contacts, documents, facts, interactions and their transcripts, and external
--     identities; the dispatch board and dispatched list show reps every customer's name.
--   * What stays narrower for a rep (trigger customers_guard_rep_edit_20261013, every path):
--     only an ADMIN changes who a customer is assigned to (REP_CANNOT_REASSIGN; a rep still
--     creates customers assigned to themselves, REP_MUST_SELF_ASSIGN); only an ADMIN or the
--     customer's OWN assigned rep changes its default commission split
--     (COMMISSION_SPLIT_ADMIN_OR_ASSIGNED_REP); a customer with a posted or overdue invoice is not
--     deactivated (CUSTOMER_HAS_OPEN_INVOICES); and prepay_balance_cents changes only through the
--     server's prepay and payment functions, never a direct browser UPDATE, and a customer a rep
--     inserts directly starts at 0 (PREPAY_BALANCE_SERVER_ONLY).
--   * Reports: get_customer_statement (the 90-day activity ledger on a customer's page) and
--     get_customer_year_end_summary open to reps for any customer; so do the purchase-intelligence
--     readers (prep card, lapsed products, purchase summary). get_customer_balance_listing lists
--     any customer but still counts only invoices the rep created or is the salesperson on. The
--     printable / emailed statements (get_detailed_statement_data, AR Aging) stay admin-only.
--
-- WHY (Mason, 2026-10-13, in chat, this session): "reps should be able to make invoices or email
--   customers that arnt theirs" (session 9ff9e3), then in this session: reps "can see all and edit
--   all" customers; "Everything customer-related" opens; statements and year-end summaries open;
--   reps invoice under their own name only; only admins reassign a customer; the commission split
--   stays admin-or-assigned-rep. This reverses the 2026-10-09 admin-only plan (PR #902, closed
--   unmerged; its 20261013160000 was never applied) and the 2026-10-06 rep-scoping plan.
--   This WIDENS permissions, so it is applied only with Mason's explicit owner approval.
--
-- NOT CHANGED: everything an admin can do, and every action that is already admin-only stays
--   admin-only (write-offs, invoice deletion, delivery voids, assign_customers_sales_rep); the
--   other invoice functions reps can already call (unpost, payments, credit-memo and prepay
--   application, consolidation, transfer back to a job, the field-application billing updates)
--   keep exactly today's gates; drivers, applicators and every other role (their policy legs are
--   copied verbatim); invoices_select (a rep still reads only the invoices they created or are
--   the salesperson on; Mason chose on 2026-10-13 to let reps READ every invoice, which ships as
--   the next change together with own-name checks on those other invoice functions); the reps'
--   own work lists (call lists,
--   get_rep_customer_purchase_flags) and notification sweeps, which use assigned_sales_rep to mean
--   "my book", not as an access gate; create_quick_delivery's replay-only DELIVERY_SCOPE_DENIED;
--   the order-invoice RPCs (their salesperson gap is a separate follow-up); jobs.commission_split
--   (any active rep can already edit it; a separate follow-up). No table or column grant changes:
--   authenticated still holds no INSERT or UPDATE on customer_addresses, so its two widened
--   policies matter only once a grant exists (save_customer writes addresses). No data row changes.
--
-- HOW:
--  0  Preflight: the 20 function bodies and 20 policies (the 19 this file changes, plus the unchanged
--     customers_insert) must match their live
--     md5 of 2026-10-13, each function must have no overload, 20261010120000 must be applied, and
--     the trigger must not exist yet. The owner, grants and security of every replaced function
--     are recorded for the postflight.
--  1  CREATE OR REPLACE of 20 functions, each the verbatim live body with ONLY these hunks:
--       _save_invoice_split_provenance_impl_20260719 (save_invoice): the three CUSTOMER_SCOPE_DENIED
--         tests are removed; SALESMAN_SCOPE_DENIED stays; a rep editing or replaying an EXISTING
--         invoice must find it under their own name (INVOICE_SCOPE_DENIED); a rep's payload is
--         passed on with salesman_id set to the rep, so "No Salesman" or an omitted key can neither
--         leave a new invoice unattributed nor blank an existing one.
--       _save_invoice_below_cost_impl_20260810 (save_invoice wrapper): the two replay-branch
--         CUSTOMER_SCOPE_DENIED tests become the same own-name test, so a mismatched receipt's
--         invoice id is reported only to a rep the invoice belongs to.
--       _post_invoice_public_impl_20260718 (post_invoice) and post_invoice_group: the
--         CUSTOMER_SCOPE_DENIED test becomes INVOICE_SCOPE_DENIED (every invoice posted must be
--         under the rep's own name); the row locks before it stay.
--       _save_field_app_split_invoice_impl: SPLIT_SET_NOT_OWNED now means "an existing child is not
--         under the rep's own name"; the member and source-job tests
--         keep refusing a non-admin only a member that is not a customer row and a job with no
--         customer (SPLIT_CUSTOMER_NOT_ASSIGNED / SPLIT_JOB_NOT_ASSIGNED keep their codes).
--       resolve_line_split_vector: RESOLVER_NOT_AUTHORIZED (the direct-call assigned-rep test) is
--         removed; the active admin/sales_rep gate stays.
--       get_customer_statement, get_customer_year_end_summary: CUSTOMER_SCOPE_DENIED removed; the
--         role gates stay.
--       get_customer_balance_listing: the four customer-level assigned-rep filters are removed; the
--         invoice-level created_by/salesman_id filters stay.
--       save_customer: NOT_CUSTOMER_OWNER (twice) removed; REP_CANNOT_REASSIGN now compares the
--         payload with the STORED assigned_sales_rep under FOR UPDATE (the edit page always sends
--         the loaded value back), and only when the page's row_version is current (a stale page
--         gets the existing CUSTOMER_STALE_WRITE reload instead); a missing customer is
--         CUSTOMER_NOT_FOUND for a rep too.
--       soft_delete_customer_document, log_customer_fact, review_customer_fact,
--         supersede_customer_fact, log_customer_interaction, get_customer_prep_card,
--         get_customer_lapsed_products, get_customer_purchase_summary: the
--         "c.assigned_sales_rep = auth.uid()/v_actor" clause is removed (each still requires the
--         customer row to exist and the caller to be an active admin or sales rep).
--       get_dispatch_board_jobs, get_dispatched_list: a sales rep sees every customer's name (the
--         "is_sales_rep() AND assigned" leg becomes is_sales_rep()).
--  2  ALTER POLICY (names, commands and roles unchanged) on customers (select, update),
--     customer_addresses (insert, update), customer_contacts (select, insert, update),
--     customer_documents (rep select, insert, update), customer_facts (rep select, insert),
--     customer_interactions (rep select, insert, update), interaction_transcripts (rep select) and
--     external_identities (select, insert, update): the assigned-rep condition is removed; every
--     other condition (provenance, uploaded_by, created_by, verified_at, deleted_at, the driver
--     and applicator legs) is kept word for word. customers_insert is pinned and NOT changed.
--  3  _customer_has_open_invoice_20261013(uuid) (definer-rights boolean read, authenticated only)
--     and trigger customers_guard_rep_edit_20261013 (BEFORE INSERT OR UPDATE OF assigned_sales_rep,
--     default_commission_split, is_active, prepay_balance_cents ON customers; SECURITY INVOKER so
--     current_user tells a direct browser UPDATE from a server function) enforce the four rules
--     listed under "What stays narrower" for an active sales rep who is not an admin. The split is
--     compared after canonical recipient stamping on both sides, so re-saving an unchanged split
--     never trips it.
--  4  Postflight: no replaced function or policy still tests assigned_sales_rep (save_customer's
--     reassignment test and customers_insert excepted), every replaced function kept its owner,
--     grants, SECURITY DEFINER and search_path, and the trigger, its function and the open-invoice
--     reader are installed with the intended security, grants and column list.
--
-- ROLLBACK: re-apply the 20 live bodies and 19 policy expressions recorded in git at
--   origin/main 6384e62f7 (the md5 pins below identify them), then
--   DROP TRIGGER customers_guard_rep_edit_20261013 ON public.customers,
--   DROP FUNCTION public.guard_customer_rep_edit_20261013() and
--   DROP FUNCTION public._customer_has_open_invoice_20261013(uuid).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- 0. PREFLIGHT. Every object this file replaces must still be exactly what was reviewed (read
--    live 2026-10-13). A drifted body or policy aborts the whole file before anything changes.
DO $preflight$
DECLARE
  v_pin record;
  v_md5 text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE name = '20261010120000_cap_delivery_invoice_at_delivered'
  ) THEN
    RAISE EXCEPTION 'REPS_ANY_CUSTOMER_PREFLIGHT: apply 20261010120000_cap_delivery_invoice_at_delivered first';
  END IF;
  FOR v_pin IN SELECT * FROM (VALUES
    ('public._save_invoice_split_provenance_impl_20260719(jsonb,jsonb,text)', '99828f958e0539f1c5a0f95cac2fe099'),
    ('public._save_invoice_below_cost_impl_20260810(jsonb,jsonb,text)', '0b85b7449790d81ef6bb727244b4f615'),
    ('public._post_invoice_public_impl_20260718(uuid,text)', '39b9f427eb843e6cba859a1db62553a8'),
    ('public.post_invoice_group(uuid,uuid,text)', 'd9e36f0dfb055e3cc68c18793e70dbfc'),
    ('public._save_field_app_split_invoice_impl(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text,text)', '9288b8fb410f33b7c7d46ecfb76306fa'),
    ('public.resolve_line_split_vector(uuid[],uuid,jsonb)', '3f83bc790eec353083d3ea38ef059fb0'),
    ('public.get_customer_statement(uuid,date,date)', '5e5770d23be8d6af4fcaa54f9fcb3782'),
    ('public.get_customer_year_end_summary(uuid,integer)', '455b4bf2001b56485e739d41895a4c93'),
    ('public.get_customer_balance_listing(date)', '1c1ca213f6ae33f2086b8737382d53bb'),
    ('public.save_customer(uuid,jsonb,jsonb,uuid,text)', 'd831df8d955e7b5bfe1fc8c1bba85e42'),
    ('public.soft_delete_customer_document(uuid,uuid,text)', '121a46568ae9c0a96cd637172a513f0b'),
    ('public.log_customer_fact(uuid,text,text,text,jsonb,numeric,timestamp with time zone,boolean,text)', '07b14d890e1502b4bd0703ad938006f6'),
    ('public.review_customer_fact(uuid,text,text,text)', '90eb5fce97da996d9ed710f470757c28'),
    ('public.supersede_customer_fact(uuid,text,jsonb,numeric,timestamp with time zone,text)', '34d1b5f73ffc106775e563cd9a71ca50'),
    ('public.log_customer_interaction(uuid,text,text,timestamp with time zone,text,uuid,integer,text,text,text,uuid,date,text)', '39401baee9fd14578b2f8d520fed0694'),
    ('public.get_customer_prep_card(uuid)', '2a37df4d6375f9a872ac657e5349a6c7'),
    ('public.get_customer_lapsed_products(uuid)', '66c740d1a3525b73374c009621020cbc'),
    ('public.get_customer_purchase_summary(uuid,text)', '9bc8d13cf2e39ce0ac6cb7c8c51d56d3'),
    ('public.get_dispatch_board_jobs(uuid,text,date,date)', '5e327097ff2b0a080bfaf41252b3e04f'),
    ('public.get_dispatched_list(uuid,uuid)', 'd62626cd053875d2a20317ac3dd67b5c')
  ) AS t(signature, pin) LOOP
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
      FROM pg_proc p WHERE p.oid = to_regprocedure(v_pin.signature);
    IF v_md5 IS DISTINCT FROM v_pin.pin THEN
      RAISE EXCEPTION 'REPS_ANY_CUSTOMER_PREFLIGHT: % drifted from the reviewed body (md5 %, expected %)',
        v_pin.signature, v_md5, v_pin.pin;
    END IF;
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = substr(split_part(v_pin.signature, '(', 1), 8)) <> 1 THEN
      RAISE EXCEPTION 'REPS_ANY_CUSTOMER_PREFLIGHT: % has overloads', v_pin.signature;
    END IF;
  END LOOP;
  FOR v_pin IN SELECT * FROM (VALUES
    ('customers', 'customers_select', '4d86cb39838dc338ac722922bbb91b5f'),
    ('customers', 'customers_update', '59d8aef2229009d499185f5312b52238'),
    ('customers', 'customers_insert', '0a7feda96a200c68e780447837b79892'),
    ('customer_addresses', 'addresses_insert', '25379c1c246c04f0ff0a9af37237bb9a'),
    ('customer_addresses', 'addresses_update', 'ecdc022b3c7949fd2e85869c958dfee3'),
    ('customer_contacts', 'customer_contacts_select', '044e7971bdf9510b23329719ca62c605'),
    ('customer_contacts', 'customer_contacts_insert', '2d92d5bb2dec988d961b025c423cd38d'),
    ('customer_contacts', 'customer_contacts_update', '202367439e4dd83da68dd8c56b4382db'),
    ('customer_documents', 'customer_documents_rep_select', '7afb55ba83158110ced63040b37f8c60'),
    ('customer_documents', 'customer_documents_rep_insert', '32eda566822f8c7b9465a6d8f261bc8e'),
    ('customer_documents', 'customer_documents_rep_update', '0e75776455671e0648b31755954a1c6d'),
    ('customer_facts', 'customer_facts_rep_select', '499f1d0fb4c8990e466d86aa42b6f3a7'),
    ('customer_facts', 'customer_facts_rep_insert', 'b0fd3c4182d93143f316ad5f2843f5c8'),
    ('customer_interactions', 'customer_interactions_rep_select', 'c0c40b209fb00b3274c5d6f05b05811c'),
    ('customer_interactions', 'customer_interactions_rep_insert', '5a4d880dcbb8a8abca1563028225496e'),
    ('customer_interactions', 'customer_interactions_rep_update', '0251fe8910c5be72170afb2168601499'),
    ('interaction_transcripts', 'interaction_transcripts_rep_select', 'ac2e60662a0feb3a0d29b27db2559ede'),
    ('external_identities', 'external_identities_select', 'bf887ab0f83c34f4acf7e1f53c440978'),
    ('external_identities', 'external_identities_insert', 'f2b1c2edb985ab27fa5c2bfca61a4fc6'),
    ('external_identities', 'external_identities_update', '57c6bfcfd5267196724141e920a8ff9e')
  ) AS t(tbl, pol, pin) LOOP
    SELECT md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''))
      INTO v_md5
      FROM pg_policies WHERE schemaname = 'public' AND tablename = v_pin.tbl AND policyname = v_pin.pol;
    IF v_md5 IS DISTINCT FROM v_pin.pin THEN
      RAISE EXCEPTION 'REPS_ANY_CUSTOMER_PREFLIGHT: policy %.% drifted (md5 %, expected %)',
        v_pin.tbl, v_pin.pol, v_md5, v_pin.pin;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.customers'::regclass
              AND tgname = 'customers_guard_rep_edit_20261013') THEN
    RAISE EXCEPTION 'REPS_ANY_CUSTOMER_PREFLIGHT: customers_guard_rep_edit_20261013 already exists';
  END IF;
END
$preflight$;

-- Owner, grants and security of every function replaced below, for the postflight comparison.
-- ON COMMIT DROP: the table vanishes with this transaction; the file never drops anything itself.
CREATE TEMP TABLE reps_any_customer_security_20261013 ON COMMIT DROP AS
  SELECT p.oid AS fn, p.proowner AS owner, p.proacl::text AS acl, p.prosecdef AS secdef, p.proconfig AS config
    FROM pg_proc p
   WHERE p.oid IN (
     to_regprocedure('public._save_invoice_split_provenance_impl_20260719(jsonb,jsonb,text)'),
     to_regprocedure('public._save_invoice_below_cost_impl_20260810(jsonb,jsonb,text)'),
     to_regprocedure('public._post_invoice_public_impl_20260718(uuid,text)'),
     to_regprocedure('public.post_invoice_group(uuid,uuid,text)'),
     to_regprocedure('public._save_field_app_split_invoice_impl(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text,text)'),
     to_regprocedure('public.resolve_line_split_vector(uuid[],uuid,jsonb)'),
     to_regprocedure('public.get_customer_statement(uuid,date,date)'),
     to_regprocedure('public.get_customer_year_end_summary(uuid,integer)'),
     to_regprocedure('public.get_customer_balance_listing(date)'),
     to_regprocedure('public.save_customer(uuid,jsonb,jsonb,uuid,text)'),
     to_regprocedure('public.soft_delete_customer_document(uuid,uuid,text)'),
     to_regprocedure('public.log_customer_fact(uuid,text,text,text,jsonb,numeric,timestamp with time zone,boolean,text)'),
     to_regprocedure('public.review_customer_fact(uuid,text,text,text)'),
     to_regprocedure('public.supersede_customer_fact(uuid,text,jsonb,numeric,timestamp with time zone,text)'),
     to_regprocedure('public.log_customer_interaction(uuid,text,text,timestamp with time zone,text,uuid,integer,text,text,text,uuid,date,text)'),
     to_regprocedure('public.get_customer_prep_card(uuid)'),
     to_regprocedure('public.get_customer_lapsed_products(uuid)'),
     to_regprocedure('public.get_customer_purchase_summary(uuid,text)'),
     to_regprocedure('public.get_dispatch_board_jobs(uuid,text,date,date)'),
     to_regprocedure('public.get_dispatched_list(uuid,uuid)')
   );

-- ---------------------------------------------------------------------------------------------
-- 1. FUNCTIONS. Each body below is the live definition (read 2026-10-13) with ONLY the
--    assigned-rep checks removed or narrowed as listed in the header. CREATE OR REPLACE keeps
--    each function's OID, owner, grants, SECURITY DEFINER and search_path.

CREATE OR REPLACE FUNCTION public._save_invoice_split_provenance_impl_20260719(p_invoice jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_invoice_id uuid := NULLIF(p_invoice->>'id', '')::uuid;
  v_existing_customer_id uuid;
  v_requested_customer_id uuid := NULLIF(p_invoice->>'customer_id', '')::uuid;
  v_target_customer_id uuid;
  v_requested_salesman_id uuid := NULLIF(p_invoice->>'salesman_id', '')::uuid;
  v_cached jsonb;
  v_cached_invoice_id uuid;
  v_cached_customer_id uuid;
  v_owner_created_by uuid;
  v_owner_salesman_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('save_invoice:' || p_idempotency_key, 0)
    );
    v_cached := public.check_idempotency(p_idempotency_key, 'save_invoice');
    IF v_cached IS NOT NULL THEN
      v_cached_invoice_id := NULLIF(v_cached->>'invoice_id', '')::uuid;
      IF v_cached_invoice_id IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
      END IF;
      IF v_invoice_id IS NOT NULL
         AND v_invoice_id IS DISTINCT FROM v_cached_invoice_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;

      SELECT customer_id, created_by, salesman_id
        INTO v_cached_customer_id, v_owner_created_by, v_owner_salesman_id
        FROM public.invoices
       WHERE id = v_cached_invoice_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVOICE_NOT_FOUND';
      END IF;
      IF v_requested_customer_id IS NOT NULL
         AND v_requested_customer_id IS DISTINCT FROM v_cached_customer_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      -- Any customer (Mason, 2026-10-13): no assigned-rep check (20261013220000). A rep
      -- replays only an invoice under their own name (they are its salesperson, or it has
      -- none and they created it).
      IF v_actor_role = 'sales_rep'
         AND NOT (v_owner_salesman_id IS NOT DISTINCT FROM v_actor
             OR (v_owner_salesman_id IS NULL AND v_owner_created_by IS NOT DISTINCT FROM v_actor)) THEN
        RAISE EXCEPTION 'INVOICE_SCOPE_DENIED';
      END IF;
      RETURN v_cached_invoice_id;
    END IF;
  END IF;

  IF v_invoice_id IS NOT NULL THEN
    SELECT customer_id, created_by, salesman_id
      INTO v_existing_customer_id, v_owner_created_by, v_owner_salesman_id
      FROM public.invoices
     WHERE id = v_invoice_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'INVOICE_NOT_FOUND';
    END IF;
  END IF;

  v_target_customer_id := COALESCE(
    v_requested_customer_id,
    v_existing_customer_id
  );
  IF v_target_customer_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_REQUIRED';
  END IF;

  -- Reps save invoices for ANY customer (Mason, 2026-10-13; 20261013220000
  -- removed the two assigned-rep checks here), but only under their own name: an
  -- existing invoice only when they are its salesperson, or it has none and they
  -- created it.
  IF v_actor_role = 'sales_rep' THEN
    IF v_invoice_id IS NOT NULL
       AND NOT (v_owner_salesman_id IS NOT DISTINCT FROM v_actor
             OR (v_owner_salesman_id IS NULL AND v_owner_created_by IS NOT DISTINCT FROM v_actor)) THEN
      RAISE EXCEPTION 'INVOICE_SCOPE_DENIED';
    END IF;
    IF v_requested_salesman_id IS NOT NULL
       AND v_requested_salesman_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'SALESMAN_SCOPE_DENIED';
    END IF;
  END IF;

  -- A rep's invoice is always saved under the rep's own name: the writer stores the requested
  -- salesman_id as sent, so "No Salesman" or an omitted key would leave it unattributed or blank
  -- an existing one (Codex P1 on PR #907, Luna round 4). Same as the split writer, which forces a
  -- non-admin's salesman to self. Admins' payloads pass through unchanged.
  RETURN public._save_invoice_scoped_impl(
    CASE WHEN v_actor_role = 'sales_rep'
         THEN p_invoice || jsonb_build_object('salesman_id', v_actor)
         ELSE p_invoice
    END,
    p_items,
    p_idempotency_key
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._save_invoice_below_cost_impl_20260810(p_invoice jsonb, p_items jsonb DEFAULT '[]'::jsonb, p_idempotency_key text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_fingerprint text;
  v_existing public.idempotency_keys%ROWTYPE;
  v_invoice_id uuid;
  v_cached_invoice_id uuid;
  v_cached_customer_id uuid;
  v_cached_created_by uuid;
  v_cached_salesman_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  SELECT role INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NULL THEN
    RETURN public._save_invoice_intent_impl_20260802(p_invoice, p_items, NULL);
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'actor_id', v_actor,
        'invoice', p_invoice,
        'items', COALESCE(p_items, '[]'::jsonb)
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_idempotency_key, 0)
  );

  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = p_idempotency_key
     AND expires_at < now();

  SELECT * INTO v_existing
    FROM public.idempotency_keys
   WHERE idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.operation IS DISTINCT FROM 'save_invoice' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE';
    END IF;
    -- Deployment bridge: receipts written by the pre-migration implementation
    -- have neither binding column. Their original intent cannot be reconstructed,
    -- so validate entity scope and fail closed with the committed receipt. This
    -- avoids both duplicate creation and silently treating edited input as saved.
    IF v_existing.request_actor_id IS NULL
       AND v_existing.request_fingerprint IS NULL THEN
      v_cached_invoice_id := NULLIF(v_existing.result->>'invoice_id', '')::uuid;
      IF v_cached_invoice_id IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
      END IF;
      SELECT customer_id, created_by, salesman_id
        INTO v_cached_customer_id, v_cached_created_by, v_cached_salesman_id
        FROM public.invoices
       WHERE id = v_cached_invoice_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVOICE_NOT_FOUND';
      END IF;
      -- Any customer (Mason, 2026-10-13; 20261013220000 removed the assigned-rep
      -- check), but a rep sees the receipt only for an invoice under their own name
      -- (they are its salesperson, or it has none and they created it).
      IF v_actor_role = 'sales_rep'
         AND NOT (v_cached_salesman_id IS NOT DISTINCT FROM v_actor
             OR (v_cached_salesman_id IS NULL AND v_cached_created_by IS NOT DISTINCT FROM v_actor)) THEN
        RAISE EXCEPTION 'INVOICE_SCOPE_DENIED';
      END IF;
      RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
        USING ERRCODE = '22023',
              DETAIL = jsonb_build_object(
                'operation', v_existing.operation,
                'result', v_existing.result
              )::text;
    END IF;
    IF v_existing.request_actor_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'IDEMPOTENCY_ACTOR_MISMATCH';
    END IF;
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      v_cached_invoice_id := NULLIF(v_existing.result->>'invoice_id', '')::uuid;
      IF v_cached_invoice_id IS NULL THEN
        RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
      END IF;
      SELECT customer_id, created_by, salesman_id
        INTO v_cached_customer_id, v_cached_created_by, v_cached_salesman_id
        FROM public.invoices
       WHERE id = v_cached_invoice_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'INVOICE_NOT_FOUND';
      END IF;
      -- Any customer (Mason, 2026-10-13; 20261013220000 removed the assigned-rep
      -- check), but a rep sees the receipt only for an invoice under their own name
      -- (they are its salesperson, or it has none and they created it).
      IF v_actor_role = 'sales_rep'
         AND NOT (v_cached_salesman_id IS NOT DISTINCT FROM v_actor
             OR (v_cached_salesman_id IS NULL AND v_cached_created_by IS NOT DISTINCT FROM v_actor)) THEN
        RAISE EXCEPTION 'INVOICE_SCOPE_DENIED';
      END IF;
      RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
        USING ERRCODE = '22023',
              DETAIL = jsonb_build_object(
                'operation', v_existing.operation,
                'result', v_existing.result
              )::text;
    END IF;
    RETURN public._save_invoice_intent_impl_20260802(
      p_invoice, p_items, p_idempotency_key
    );
  END IF;

  v_invoice_id := public._save_invoice_intent_impl_20260802(
    p_invoice, p_items, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'save_invoice';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_invoice_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public._post_invoice_public_impl_20260718(p_invoice_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_customer_id uuid;
  v_created_by uuid;
  v_salesman_id uuid;
  v_cached jsonb;
  v_cached_invoice_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  SELECT role INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('post_invoice:' || p_idempotency_key, 0)
    );
    v_cached := public.check_idempotency(p_idempotency_key, 'post_invoice');
    IF v_cached IS NOT NULL THEN
      v_cached_invoice_id := NULLIF(v_cached->>'invoice_id', '')::uuid;
      IF v_cached_invoice_id IS NULL
         OR v_cached_invoice_id IS DISTINCT FROM p_invoice_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
    END IF;
  END IF;

  SELECT customer_id, created_by, salesman_id
    INTO v_customer_id, v_created_by, v_salesman_id
    FROM public.invoices
   WHERE id = p_invoice_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVOICE_NOT_FOUND'; END IF;

  -- Reps post invoices for ANY customer (Mason, 2026-10-13; 20261013220000 removed
  -- the assigned-rep check), but only an invoice under their own name: they are
  -- its salesperson, or it has none and they created it.
  IF v_actor_role = 'sales_rep'
     AND NOT (v_salesman_id IS NOT DISTINCT FROM v_actor
             OR (v_salesman_id IS NULL AND v_created_by IS NOT DISTINCT FROM v_actor)) THEN
    RAISE EXCEPTION 'INVOICE_SCOPE_DENIED';
  END IF;

  PERFORM public._post_invoice_customer_scope_impl(
    p_invoice_id,
    p_idempotency_key
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_invoice_group(p_invoice_group_id uuid, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_cached jsonb;
  v_cached_group_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  SELECT role INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  IF p_invoice_group_id IS NULL THEN
    RAISE EXCEPTION 'invoice_group_id is required';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('post_invoice_group:' || p_idempotency_key, 0)
    );
    v_cached := public.check_idempotency(
      p_idempotency_key,
      'post_invoice_group'
    );
    IF v_cached IS NOT NULL THEN
      v_cached_group_id := NULLIF(v_cached->>'invoice_group_id', '')::uuid;
      IF v_cached_group_id IS NULL
         OR v_cached_group_id IS DISTINCT FROM p_invoice_group_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
    END IF;
  END IF;

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

  -- Reps post invoice groups for ANY customer (Mason, 2026-10-13; 20261013220000
  -- removed the assigned-rep check), but only when every invoice in the group is
  -- under their own name (they are its salesperson, or it has none and they created it).
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

  RETURN public._post_invoice_group_customer_scope_impl(
    p_invoice_group_id,
    p_performed_by,
    p_idempotency_key
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public._save_field_app_split_invoice_impl(p_billing_set_id uuid, p_source_job_id uuid, p_invoice jsonb, p_fields jsonb, p_lines jsonb, p_performed_by uuid, p_application_service_id uuid, p_idempotency_key text, p_request_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor              uuid := auth.uid();
  v_req_salesman       uuid;
  v_salesman_id        uuid;
  v_field_ids          uuid[] := '{}';
  v_applied_acres_map  jsonb  := '{}'::jsonb;
  v_fld                jsonb;
  v_this_acres         numeric;
  v_vector             jsonb;          -- default vector [{customer_id, micro_pct}]
  v_micro_map          jsonb := '{}'::jsonb;
  v_members            text[];         -- billing-set member customer_ids, sorted ASC
  v_set_id             uuid;
  v_group_id           uuid;
  v_line               jsonb;
  v_idx                int := 0;
  v_line_id            uuid;
  v_line_kind          text;
  v_product_id         uuid;
  v_app_service_id     uuid;
  v_line_desc          text;
  v_src_qty            numeric;
  v_src_acres          numeric;
  v_src_unit_price     bigint;
  v_src_flat           bigint;
  v_base_source        text;
  v_eff_rate_unit      text;           -- display unit for the line (pricing unit after chemical conversion)
  v_chem_price_map     jsonb;          -- chemical Option B: customer_id -> that customer's own resolved unit price
  v_svc_price_map      jsonb;          -- service Option B: customer_id -> that customer's own per-acre service rate
  v_uniform_price      bigint;         -- chemical/service: the single price when ALL co-owners match (routes round-once)
  v_repr_base_price    bigint;         -- resolved representative base BEFORE the uniform-override penny guard (Codex r7 P2 audit base)
  v_inv_field_names    text[];         -- denormalized field names for the child invoice row (Codex r7 P2)
  v_inv_crop_type      text;           -- denormalized representative crop for the child invoice row (Codex r7 P2)
  v_inv_applicator_name text;          -- source-job applicator, denormalized onto the child (Codex r8 P2)
  v_inv_vehicle_name   text;           -- source-job vehicle, denormalized onto the child (Codex r8 P2)
  v_line_unit_cost     bigint;         -- per-unit COGS for the current line (Codex P1 #3)
  v_invoice_cost       bigint;         -- per-child accumulated total_cost_cents (Codex P1 #3)
  v_is_new_invoice     boolean;        -- true only when a child invoice row is freshly INSERTed (Codex P1 #8)
  v_total_applied_acres numeric := 0;  -- SUM(applied_acres) across p_fields (Codex P2 #9 acre derivation)
  v_shares             jsonb;
  v_line_customers     text[];
  v_calc               jsonb;
  v_app_service        record;
  v_svc_name           text;   -- safe copy of v_app_service.name (fix: unassigned-record crash)
  v_line_plans         jsonb := '[]'::jsonb;   -- [{meta..., alloc}]
  v_plan               jsonb;
  v_cust               text;
  v_customer_id        uuid;
  v_customer_name      text;
  v_is_primary         boolean;
  v_invoice_id         uuid;
  v_invoice_number     text;
  v_invoice_total      bigint;
  v_invoice_ids        uuid[] := '{}';
  v_alloc_row          jsonb;
  v_item_id            uuid;
  v_qty                numeric;
  v_acres_alloc        numeric;
  v_cust_acres         numeric;
  v_send_disposition   text;
  v_line_hashes        jsonb := '[]'::jsonb;
  v_item_price_source  text;
  v_item_cost_cents    bigint;   -- per-item cost_cents (per-unit for chemical, EXTENDED for fee) — Codex r2 #F
  -- #E source-job double-bill guard (Codex round-2 P1) + round-3 season/freeze
  v_job                record;
  v_other_set          uuid;
  v_set_child_ids      uuid[];    -- this set's child invoice ids captured BEFORE orphan-cancel (round-5 B1)
  v_set_source_job     uuid;     -- the set's frozen source_job_id on re-save (round-3 P1)
  v_season             integer;  -- job/invoice season for pricing + stamping (round-3 P1)
  v_job_app_date       date;     -- source job's application/scheduled date for child invoices (round-3 P2)
  -- Commissions on the split (Codex round-4 P1): mirror transfer_job_to_invoice per child
  v_commission_split   jsonb;
  v_child_id           uuid;
  v_child_customer     uuid;
  v_child_profit       numeric;
  -- Codex round-5 P1: per-child CHEMICAL profit using the LR-allocated COGS (not a re-rounded
  -- cost*qty), so commissions tie to the penny-exact allocation already in the header.
  v_invoice_chem_profit  bigint;
  v_chem_profit_by_child jsonb := '{}'::jsonb;   -- child invoice_id::text -> chemical profit cents
  -- #G canonical line COGS + its largest-remainder split (Codex round-2 P1)
  v_line_cogs          bigint;
  v_cogs_weights       jsonb;
  v_cogs_map           jsonb;
  -- #M audited-base + #L reason capture (Codex round-2 P2)
  v_caller_override    text[];   -- customers the caller priced as a genuine manual override
  v_svc_source_map     jsonb;    -- service: customer_id -> 'service_rate' | 'service_default'
  v_reasons_map        jsonb;    -- customer_id -> {split_reason, price_reason}
  v_share_base_price   bigint;
  v_share_base_source  text;
  v_share_price_mode   text;
  v_split_reason       text;
  v_price_reason       text;
  -- invariant probes
  v_sum_cents          bigint;
  v_src_line_cents     bigint;
  v_sum_qty            numeric;
  v_sum_micro          bigint;
  v_line_member_count  int;
  v_line_src_qty       numeric;
  v_result             jsonb;
BEGIN
  -- ---- GUARDS (defense-in-depth; the wrapper already checked these) -----------
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match the authenticated user';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = v_actor AND is_active = true
                   AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: active admin or sales role required';
  END IF;

  -- Codex round-4 P1 (posting-boundary integrity): mark THIS transaction as the legitimate
  -- split writer. The trg_guard_split_invoice_items trigger (below) blocks any other path —
  -- notably the generic save_invoice, whose FIELD_INVOICE_SPLIT_LOCKED guard does NOT fire for
  -- our single-compat-share children — from deleting a split child's invoice_items and
  -- cascading away its invoice_line_shares. is_local = true: auto-resets at txn end.
  PERFORM set_config('crx.split_writer', 'on', true);

  -- Salesman attribution: admin may name anyone; a sales_rep is forced to self.
  v_req_salesman := (p_invoice->>'salesman_id')::uuid;
  IF is_admin() THEN
    v_salesman_id := v_req_salesman;
  ELSE
    IF v_req_salesman IS NOT NULL AND v_req_salesman IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Not authorized: cannot attribute this invoice to another user';
    END IF;
    v_salesman_id := v_actor;
  END IF;

  -- ---- FIELDS + Mode-A rejection ---------------------------------------------
  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'array'
     OR jsonb_array_length(p_fields) = 0 THEN
    RAISE EXCEPTION 'SPLIT_NO_FIELDS: at least one field is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOR v_fld IN SELECT * FROM jsonb_array_elements(p_fields)
  LOOP
    v_this_acres := (v_fld->>'applied_acres')::numeric;
    IF v_this_acres IS NULL OR v_this_acres <= 0 THEN
      RAISE EXCEPTION 'SPLIT_ZERO_ACRES: applied acres must be > 0 for field %', v_fld->>'field_id'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_field_ids := array_append(v_field_ids, (v_fld->>'field_id')::uuid);
    v_applied_acres_map := v_applied_acres_map
      || jsonb_build_object(v_fld->>'field_id', v_this_acres);
  END LOOP;

  -- Codex round-4 P1: reject a field id appearing more than once. A duplicate would
  -- double-count its acres into the ownership vector / compat share AND write a duplicate
  -- field_app_locations snapshot for the group. (v_applied_acres_map would silently collapse
  -- dupes to one key, so the acres map and the raw field array could disagree.)
  IF (SELECT count(*) FROM unnest(v_field_ids)) <>
     (SELECT count(DISTINCT x) FROM unnest(v_field_ids) AS x) THEN
    RAISE EXCEPTION 'SPLIT_DUPLICATE_FIELD: a field id appears more than once in p_fields'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Mode-A: reject the ENTIRE feature for any grower-share field (spec §5).
  IF EXISTS (
    SELECT 1 FROM field_billing_defaults d
     WHERE d.field_id = ANY(v_field_ids)
       AND d.price_override_cents IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'MODE_A_UNSUPPORTED: per-line split billing is not available for grower-share (Mode A) fields'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ---- DEFAULT VECTOR + member set -------------------------------------------
  v_vector := resolve_line_split_vector(v_field_ids, p_source_job_id, v_applied_acres_map);

  SELECT array_agg(value->>'customer_id' ORDER BY value->>'customer_id')
    INTO v_members
    FROM jsonb_array_elements(v_vector) AS value;

  SELECT COALESCE(jsonb_object_agg(value->>'customer_id', (value->>'micro_pct')::bigint), '{}'::jsonb)
    INTO v_micro_map
    FROM jsonb_array_elements(v_vector) AS value;

  -- ---- CUSTOMER-SCOPE SECURITY (Codex P1 #4, 2026-07-18; widened 2026-10-13) ----
  -- Reps bill ANY customer (Mason, 2026-10-13): 20261013220000 removed the
  -- assigned-rep test. A non-admin is still refused a derived member that is not
  -- a customer row at all.
  IF NOT is_admin() THEN
    IF EXISTS (
      SELECT 1 FROM unnest(v_members) AS m(cust)
      LEFT JOIN customers c ON c.id = m.cust::uuid
      WHERE c.id IS NULL
    ) THEN
      RAISE EXCEPTION 'SPLIT_CUSTOMER_NOT_ASSIGNED: not authorized to bill one or more of these customers'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  -- Total applied acres across the fields — the acre basis for the per-customer compat
  -- share row (Codex P2 #9), derived ONCE here, independent of the billing lines.
  SELECT COALESCE(SUM((f->>'applied_acres')::numeric), 0) INTO v_total_applied_acres
    FROM jsonb_array_elements(p_fields) AS f;

  -- Codex round-7 P2: denormalized field context for the child invoice ROW. FieldInvoicesListPanel +
  -- buildInvoicePdfDataFromRow read invoices.field_names/crop_type/total_acres directly (the dedicated
  -- Drafts/Posted panels hydrate field_app_locations, but the COMBINED list + its PDFs use the row) —
  -- without these each split child shows blank acreage/fields/crop in the combined list and exports.
  SELECT array_agg(fl.field_name ORDER BY t.ord),
         (array_agg(fl.crop_type ORDER BY t.ord) FILTER (WHERE fl.crop_type IS NOT NULL))[1]
    INTO v_inv_field_names, v_inv_crop_type
    FROM jsonb_array_elements(p_fields) WITH ORDINALITY AS t(fld, ord)
    LEFT JOIN fields fl ON fl.id = (t.fld->>'field_id')::uuid;

  -- ---- LINES ------------------------------------------------------------------
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'SPLIT_NO_LINES: at least one billing line is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Codex round-7 P1 (RUP under-reporting): reject the SAME chemical product on more than one line.
  -- Two chemical lines with the same product create two invoice_items with the same
  -- (invoice_id, product_id); generate_rup_sales_records de-dups by (invoice_id, product_id) and
  -- inserts only the FIRST, silently under-reporting the regulated quantity + amount of the second.
  -- The operator must combine them into one line (mirrors the SPLIT_DUPLICATE_FIELD guard).
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_lines) AS l
     WHERE l->>'line_kind' = 'chemical' AND NULLIF(l->>'product_id', '') IS NOT NULL
     GROUP BY l->>'product_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'SPLIT_DUPLICATE_PRODUCT: the same chemical product appears on more than one line — combine them into a single line'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_application_service_id IS NOT NULL THEN
    SELECT * INTO v_app_service FROM application_services WHERE id = p_application_service_id;
    IF NOT FOUND OR NOT v_app_service.is_active THEN
      RAISE EXCEPTION 'Application service not found or inactive: %', p_application_service_id;
    END IF;
    v_svc_name := v_app_service.name;
  END IF;

  -- ---- RE-SAVE: reuse an existing DRAFT/UNPOSTED billing set -----------------
  -- The wrapper already advisory-locked the set's group and FOR UPDATE-locked the
  -- child invoices, and asserted all draft/unposted. Here we clear the prior child
  -- LINE DATA (invoice_items — cascades invoice_line_shares — plus compat shares and
  -- the billing lines) but we do NOT hard-delete the invoice ROWS: a child that was
  -- posted-then-unposted carries append-only invoice_line_share_snapshots whose FK is
  -- ON DELETE RESTRICT, so a hard invoice delete would abort the whole re-save
  -- (adversarial F1). Instead PASS 2 REUSES the existing child invoice per customer
  -- (UPDATE), preserving its invoice_number + snapshot history, and only INSERTs for a
  -- newly-added customer. The freeze trigger permits the share rewrite because every
  -- member is draft/unposted (not posted).
  IF p_billing_set_id IS NOT NULL THEN
    SELECT id, invoice_group_id, source_job_id INTO v_set_id, v_group_id, v_set_source_job
      FROM field_app_billing_sets WHERE id = p_billing_set_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Billing set not found: %', p_billing_set_id;
    END IF;

    -- Freeze the source job on re-save (Codex round-3 P1): the set's source_job_id is set
    -- once at first Save and drives the #E consume/guard below. Allowing it to change would
    -- let one billing set consume TWO jobs (the new one gets marked invoiced while the old
    -- stays invoiced and linked). Reject any change; the operator must start a new set.
    IF p_source_job_id IS DISTINCT FROM v_set_source_job THEN
      RAISE EXCEPTION 'SPLIT_JOB_IMMUTABLE: the source job cannot be changed on a saved split set (was %, got %)',
        v_set_source_job, p_source_job_id USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Ownership on re-save (Codex P1 #4; narrowed 2026-10-13 by 20261013220000): reps may
    -- re-save a split set for ANY customer (Mason, 2026-10-13), but only when every EXISTING
    -- child is under their own name: they are its salesperson, or it has none and they created
    -- it (before any delete/insert).
    IF NOT is_admin() AND EXISTS (
      SELECT 1 FROM invoices i
      WHERE i.field_app_billing_set_id = v_set_id AND i.deleted_at IS NULL
        AND NOT (i.salesman_id IS NOT DISTINCT FROM v_actor
             OR (i.salesman_id IS NULL AND i.created_by IS NOT DISTINCT FROM v_actor))
    ) THEN
      RAISE EXCEPTION 'SPLIT_SET_NOT_OWNED: not authorized to modify this billing set'
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Only EDITABLE children are cleared for the rebuild. A voided/cancelled child keeps its
    -- invoice_items/invoice_shares as the printed audit record of what was billed then reversed
    -- (RLS review M1) — its billing-line links are NULLed below so the line DELETE stays FK-safe.
    -- Posted/paid children can't reach here (the wrapper's already-posted block rejects the set).
    DELETE FROM invoice_items
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL
                              AND status IN ('draft', 'unposted'));
    DELETE FROM invoice_shares
      WHERE invoice_id IN (SELECT id FROM invoices
                            WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL
                              AND status IN ('draft', 'unposted'));
    -- Fable-adversarial BLOCKER: a SOFT-deleted child (via the live delete_invoices) is NOT in the
    -- delete above (deleted_at IS NOT NULL), but its invoice_items still reference this set's
    -- field_app_billing_lines (invoice_items.billing_line_id FK, NO ACTION) — so the DELETE below
    -- would 23503-abort and BRICK every future re-save. NULL those dangling refs first (the soft-
    -- deleted invoice keeps its items as history; only the now-meaningless billing-line link is
    -- cleared). PASS 2 then re-creates a child for that customer if they are still a member.
    UPDATE invoice_items SET billing_line_id = NULL
      WHERE billing_line_id IN (SELECT id FROM field_app_billing_lines WHERE billing_set_id = v_set_id);
    DELETE FROM field_app_billing_lines WHERE billing_set_id = v_set_id;
    -- Clear the prior group's field snapshots; PASS 3 re-creates them from p_fields (Codex P1 #7).
    DELETE FROM field_app_locations WHERE invoice_group_id = v_group_id;

    -- Round-5 B1: snapshot this set's current child ids BEFORE the orphan-cancel below detaches any
    -- dropped member (it nulls field_app_billing_set_id). The #E already-invoiced guard uses this so a
    -- re-save that drops the member currently stored in jobs.invoice_id still recognizes that anchor as
    -- OURS — otherwise the just-detached anchor looks like a foreign invoice and trips a false
    -- SPLIT_JOB_ALREADY_INVOICED, blocking the drop-member re-save entirely.
    SELECT array_agg(id) INTO v_set_child_ids
      FROM invoices WHERE field_app_billing_set_id = v_set_id AND deleted_at IS NULL;

    -- Any existing EDITABLE child whose customer is no longer a billing-set member is
    -- soft-cancelled + detached from the set (its snapshots stay pointing at it,
    -- audit intact) — never hard-deleted. Mirrors the live orphan-cancel path.
    -- Fable-adversarial: only draft/unposted children — a child already voided/cancelled via the
    -- live void_invoice must be skipped, since draft->cancelled is fine but voided->cancelled is a
    -- forbidden status transition that would abort the whole re-save.
    UPDATE invoices
       SET status = 'cancelled', invoice_group_id = NULL, field_app_billing_set_id = NULL,
           total_amount_cents = 0, total_cost_cents = 0, send_disposition = 'normal',
           updated_at = now()
     WHERE field_app_billing_set_id = v_set_id
       AND deleted_at IS NULL
       AND status IN ('draft', 'unposted')
       AND customer_id::text <> ALL (v_members);

    -- Codex round-6 P1: a child VOIDED/CANCELLED (or soft-deleted) via the live void/cancel/delete
    -- path stays attached to this set's invoice_group_id. PASS 2 skips it (reuse is draft/unposted +
    -- not-deleted only) and mints a fresh replacement, BUT post_invoice_group loops EVERY non-filtered
    -- member of the group and RAISES on any status not in (draft,unposted) — so leaving the terminal/
    -- deleted child in the group makes the rebuilt group permanently UNPOSTABLE. Detach such children
    -- from the group (invoice_group_id = NULL) so only active draft/unposted children remain postable;
    -- they keep field_app_billing_set_id as set/audit history and the replacement carries the group.
    UPDATE invoices
       SET invoice_group_id = NULL, updated_at = now()
     WHERE field_app_billing_set_id = v_set_id
       AND invoice_group_id IS NOT NULL
       AND (deleted_at IS NOT NULL OR status IN ('voided', 'cancelled'));
  ELSE
    -- New set. R7: ALWAYS assign an invoice_group_id (even single recipient) so
    -- posting is uniformly post_invoice_group and the set is the durable anchor.
    v_group_id := gen_random_uuid();
    INSERT INTO field_app_billing_sets (invoice_group_id, source_job_id, created_by)
    VALUES (v_group_id, p_source_job_id, p_performed_by)
    RETURNING id INTO v_set_id;
  END IF;

  -- ---- #E SOURCE-JOB DOUBLE-BILL GUARD (Codex round-2 P1, 2026-07-18) ---------
  -- source_job_id was recorded as provenance only, so the SAME job could be billed
  -- here AND again through the normal transfer_job_to_invoice flow (double-bill).
  -- Lock the job, refuse it if it was already billed elsewhere, and (after the child
  -- invoices exist) consume it exactly like transfer_job_to_invoice does — flipping
  -- jobs.status to 'invoiced' so that path's own "Job already invoiced" guard fires.
  -- All checks are re-save-safe: this set's own already-consumed job passes.
  IF p_source_job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM jobs WHERE id = p_source_job_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_FOUND: source job % not found', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Reps bill ANY customer's job (Mason, 2026-10-13; 20261013220000 removed the
    -- assigned-rep test). A job with a NULL or missing customer is still REFUSED for a
    -- non-admin (NOT EXISTS is true when customer_id is null).
    IF NOT is_admin()
       AND NOT EXISTS (SELECT 1 FROM customers c
                        WHERE c.id = v_job.customer_id) THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_ASSIGNED: not authorized to bill source job %', p_source_job_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Already tied to a DIFFERENT split billing set?
    SELECT id INTO v_other_set FROM field_app_billing_sets
      WHERE source_job_id = p_source_job_id AND id IS DISTINCT FROM v_set_id
      LIMIT 1;
    IF v_other_set IS NOT NULL THEN
      RAISE EXCEPTION 'SPLIT_JOB_ALREADY_BILLED: source job % is already on split billing set %',
        p_source_job_id, v_other_set USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Already invoiced by the normal flow (linked to an invoice that is NOT one of THIS set's children)?
    -- Round-5 B1: accept the anchor if it is STILL attached to this set OR was one of this set's
    -- children before the orphan-cancel above detached it (a drop-anchor re-save) — v_set_child_ids is
    -- the pre-cancel snapshot; NULL on a first save (COALESCE to empty, so the EXISTS still governs).
    IF v_job.status = 'invoiced' AND v_job.invoice_id IS NOT NULL
       AND NOT (v_job.invoice_id = ANY (COALESCE(v_set_child_ids, ARRAY[]::uuid[])))
       AND NOT EXISTS (SELECT 1 FROM invoices i
                        WHERE i.id = v_job.invoice_id AND i.field_app_billing_set_id = v_set_id) THEN
      RAISE EXCEPTION 'SPLIT_JOB_ALREADY_INVOICED: source job % was already invoiced (invoice %)',
        p_source_job_id, v_job.invoice_id USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Must be completed (or already this set's) to bill — mirrors transfer_job_to_invoice.
    IF v_job.status NOT IN ('completed', 'invoiced') THEN
      RAISE EXCEPTION 'SPLIT_JOB_NOT_COMPLETED: source job % must be completed to bill (status: %)',
        p_source_job_id, v_job.status USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Codex round-4 P1 + round-5 P1: the billed fields must EXACTLY EQUAL the job's job_fields.
    -- Consuming the job marks the WHOLE job 'invoiced', so billing only a subset (or unrelated
    -- fields) would silently orphan the job's other fields — normal transfer then refuses the
    -- now-invoiced job, so that work can never be billed. Enforce set equality (⊆ AND ⊇), exactly
    -- like transfer_job_to_invoice which always bills every job_field. (a) no billed field outside
    -- the job:
    IF EXISTS (
      SELECT 1 FROM unnest(v_field_ids) AS fid
       WHERE NOT EXISTS (SELECT 1 FROM job_fields jf
                          WHERE jf.job_id = p_source_job_id AND jf.field_id = fid)
    ) THEN
      RAISE EXCEPTION 'SPLIT_FIELD_NOT_ON_JOB: one or more billed fields do not belong to source job %', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- (b) no job field left unbilled:
    IF EXISTS (
      SELECT 1 FROM job_fields jf
       WHERE jf.job_id = p_source_job_id
         AND NOT (jf.field_id = ANY (v_field_ids))
    ) THEN
      RAISE EXCEPTION 'SPLIT_JOB_FIELDS_INCOMPLETE: billing a source job must include ALL of its fields (the whole job is consumed as invoiced); job % has fields not in this split', p_source_job_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_job_app_date := v_job.job_date;          -- carried onto each child (round-3 P2); the LIVE
                                               -- jobs table has job_date (no scheduled_date), and
                                               -- live transfer_job_to_invoice uses job_date too.
    v_season       := v_job.season;            -- capture here (v_job is a bare record, only assigned
                                               -- inside this guard; referencing v_job.season outside
                                               -- it — even in a not-taken CASE branch — raises 55000).
    -- Codex round-8 P2: denormalize the job's applicator + vehicle onto each child (like
    -- transfer_job_to_invoice) — field-invoice lists and PDFs read these invoice columns, so without
    -- them a split child loses who applied it and with what equipment. Job-less splits stay NULL.
    IF v_job.applicator_id IS NOT NULL THEN
      SELECT full_name INTO v_inv_applicator_name FROM profiles WHERE id = v_job.applicator_id;
    END IF;
    IF v_job.vehicle_id IS NOT NULL THEN
      SELECT vehicle_name INTO v_inv_vehicle_name FROM vehicles WHERE id = v_job.vehicle_id;
    END IF;
  END IF;

  -- Season for per-customer service-rate lookups AND the child invoice stamp (Codex round-3 P1):
  -- the SOURCE JOB's season if billing a job (captured above), else the invoice DATE's season, else
  -- current. current_season() alone mis-priced a backdated/prior-season job and filed the wrong year.
  v_season := COALESCE(
    v_season,
    compute_season(COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date)),  -- America/Chicago business date, never UTC (2026-09-03)
    current_season());

  -- ---- PASS 1: build billing lines + compute allocations ----------------------
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines)
  LOOP
    v_idx            := v_idx + 1;
    v_line_kind      := v_line->>'line_kind';
    v_product_id     := (v_line->>'product_id')::uuid;
    v_app_service_id := COALESCE((v_line->>'application_service_id')::uuid, p_application_service_id);
    v_line_desc      := v_line->>'description';
    v_src_qty        := (v_line->>'source_quantity')::numeric;
    v_src_acres      := (v_line->>'source_acres')::numeric;
    v_src_flat       := (v_line->>'source_flat_cents')::bigint;
    v_src_unit_price := (v_line->>'source_unit_price_cents')::bigint;
    v_base_source    := v_line->>'base_price_source';
    v_eff_rate_unit  := v_line->>'rate_unit';   -- default; chemical overrides to the pricing unit below
    v_chem_price_map := NULL;                    -- chemical-only; NULL keeps non-chemical lines untouched
    v_svc_price_map  := NULL;                    -- service-only; NULL keeps non-service lines untouched
    v_svc_source_map := NULL;                    -- service-only: customer_id -> resolved source (#M)
    v_line_unit_cost := 0;                       -- per-unit COGS for this line (Codex P1 #3)

    -- #M: customers the CALLER explicitly priced as a genuine manual per-person override
    -- (those stay audited as an 'override'; every other co-owner's resolved per-customer
    -- price is stored as their BASE, not an override vs the largest-share owner). #L: the
    -- operator's reason for a customized split / price, captured per co-owner.
    IF v_line ? 'shares' AND jsonb_typeof(v_line->'shares') = 'array' THEN
      -- Codex round-4 P1 (server defense-in-depth for the editor's per-share guard): a
      -- per-PERSON price override must be a POSITIVE amount. Below, a share flagged
      -- price_mode='override' with a non-null override_unit_price_cents is treated as a genuine
      -- caller override and billed at that price — so a 0 / negative value (e.g. the editor's
      -- "1e5" → 0 path, or a direct RPC call) would bill $0 and give product away. Reject it.
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_line->'shares') AS s
         WHERE s->>'price_mode' = 'override'
           AND s->'override_unit_price_cents' IS NOT NULL
           AND jsonb_typeof(s->'override_unit_price_cents') <> 'null'
           AND (s->>'override_unit_price_cents')::bigint <= 0
      ) THEN
        RAISE EXCEPTION 'SPLIT_SHARE_OVERRIDE_INVALID: a per-person price override on line % must be a positive amount', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      SELECT array_agg(s->>'customer_id')
        INTO v_caller_override
        FROM jsonb_array_elements(v_line->'shares') AS s
       WHERE s->>'price_mode' = 'override'
         AND s->'override_unit_price_cents' IS NOT NULL
         AND jsonb_typeof(s->'override_unit_price_cents') <> 'null';
      SELECT jsonb_object_agg(s->>'customer_id', jsonb_build_object(
               'split_reason', NULLIF(btrim(COALESCE(s->>'split_override_reason', '')), ''),
               'price_reason', NULLIF(btrim(COALESCE(s->>'price_override_reason', '')), '')))
        INTO v_reasons_map
        FROM jsonb_array_elements(v_line->'shares') AS s;
    ELSE
      v_caller_override := NULL;
      v_reasons_map     := '{}'::jsonb;
    END IF;

    IF v_line_kind IS NULL
       OR v_line_kind NOT IN ('chemical', 'service', 'fuel_surcharge', 'flat_fee') THEN
      RAISE EXCEPTION 'SPLIT_BAD_LINE_KIND: %', COALESCE(v_line_kind, '<null>')
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Base-price resolution by kind (see SCOPE NOTE at top for the chemical caveat).
    IF v_line_kind = 'service' THEN
      -- Per-line service record (Codex P1 #1): the editor sends the service id on the LINE
      -- (line.application_service_id); the old code only loaded v_app_service from the always-null
      -- top-level p_application_service_id, so v_app_service was never assigned. Load it per line.
      IF v_app_service_id IS NULL THEN
        RAISE EXCEPTION 'SPLIT_SERVICE_NO_SERVICE: service line % requires an application service', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      SELECT * INTO v_app_service FROM application_services WHERE id = v_app_service_id;
      IF NOT FOUND OR NOT v_app_service.is_active THEN
        RAISE EXCEPTION 'Application service not found or inactive: %', v_app_service_id;
      END IF;
      v_svc_name := v_app_service.name;

      IF v_src_acres IS NULL THEN
        v_src_acres := v_total_applied_acres;
      END IF;
      -- Fable-adversarial HIGH: service source_acres is the billable basis and was the one billable
      -- input with no positivity guard (round-5 covered chemical qty, service RATE, flat cents, per-
      -- share override). A direct/modified RPC call with a negative or zero value would mint a NEGATIVE
      -- (credit) invoice that reduces AR and passes every §5 invariant (signed LR; total<>0 so not $0-
      -- suppressed). The editor only sends positive acres; enforce it server-side.
      IF v_src_acres <= 0 THEN
        RAISE EXCEPTION 'SPLIT_SERVICE_ACRES_NONPOSITIVE: service line % requires source_acres > 0', v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;

      -- Service COGS: per-acre cost from the service record (mirrors the live field-app path,
      -- which uses application_services.cost_per_acre_cents). Codex P1 #3.
      v_line_unit_cost := COALESCE(v_app_service.cost_per_acre_cents, 0);

      IF COALESCE((v_line->>'manual_override')::boolean, false) THEN
        -- Explicit single negotiated per-acre rate for the whole line (applies to everyone).
        -- Codex round-5 P1: enforce a POSITIVE amount server-side (the editor rejects <=0, but a
        -- direct/modified RPC call could otherwise create a free or negative service line).
        IF v_src_unit_price IS NULL OR v_src_unit_price <= 0 THEN
          RAISE EXCEPTION 'SPLIT_SERVICE_RATE_NONPOSITIVE: a manual service rate must be a positive amount on line %', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_base_source := COALESCE(v_base_source, 'service_rate');
      ELSE
        -- Per-customer service rate (Codex P1 #2 — Option B for service): each co-owner at
        -- their OWN customer_application_rates(service, INVOICE/JOB season) → service default,
        -- exactly like the live per-child field-app save. v_season (round-3 P1) ensures a
        -- backdated/prior-season job uses that season's historical rate, not current_season().
        SELECT COALESCE(jsonb_object_agg(m.cust, COALESCE(
                 (SELECT car.rate_per_acre_cents FROM customer_application_rates car
                   WHERE car.customer_id            = m.cust::uuid
                     AND car.application_service_id = v_app_service_id
                     AND car.season                 = v_season
                   LIMIT 1),
                 v_app_service.default_rate_per_acre_cents, 0)), '{}'::jsonb)
          INTO v_svc_price_map
          FROM unnest(v_members) AS m(cust);
        -- #M: the precise per-customer source (a custom customer_application_rates row =>
        -- 'service_rate', otherwise the service default => 'service_default'), so each
        -- co-owner's audited base_price_source is their OWN resolved source. Same season (round-3).
        SELECT jsonb_object_agg(m.cust, CASE WHEN EXISTS (
                 SELECT 1 FROM customer_application_rates car
                  WHERE car.customer_id            = m.cust::uuid
                    AND car.application_service_id = v_app_service_id
                    AND car.season                 = v_season)
               THEN 'service_rate' ELSE 'service_default' END)
          INTO v_svc_source_map
          FROM unnest(v_members) AS m(cust);
        -- Representative (display + the calculator's default price): the largest-share owner's rate.
        v_src_unit_price := COALESCE((v_svc_price_map->>(
            SELECT (value->>'customer_id') FROM jsonb_array_elements(v_vector) AS value
             ORDER BY (value->>'micro_pct')::bigint DESC, value->>'customer_id' ASC LIMIT 1))::bigint, 0);
        v_base_source := COALESCE(v_base_source, 'service_default');
      END IF;
    ELSIF v_line_kind = 'chemical' THEN
      -- R8 (Option B — Mason 2026-07-18): resolve the price SERVER-SIDE and price EACH
      -- co-owner's share at THAT customer's OWN tier (manual override → field quote apply to
      -- everyone; only the tier fallback differs per customer — exactly like the live per-child
      -- field-app save). Also convert the applied quantity rate-unit → product sold unit.
      DECLARE
        v_chem_manual bigint  := NULL;
        v_rep_tier    integer;
        v_inv_unit    text;
        v_form        text;
        v_priced_qty  numeric;
        v_price_res   jsonb;
        v_rate_unit   text := NULLIF(btrim(coalesce(v_line->>'rate_unit', '')), '');
      BEGIN
        IF v_product_id IS NULL THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_NO_PRODUCT: chemical line % requires product_id', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF v_src_qty IS NULL OR v_src_qty <= 0 THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_NO_QUANTITY: chemical line % requires source_quantity > 0', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;

        -- Honor a caller price ONLY as an explicit manual override (a single negotiated price
        -- for the whole line — applies to every co-owner).
        IF COALESCE((v_line->>'manual_override')::boolean, false) THEN
          -- Codex round-5 P1: require a POSITIVE manual price server-side (the editor rejects
          -- <=0 / sci-notation, but a direct or modified-client RPC call could otherwise create a
          -- free or negative chemical line despite the UI invariant).
          IF v_src_unit_price IS NULL OR v_src_unit_price <= 0 THEN
            RAISE EXCEPTION 'SPLIT_CHEMICAL_OVERRIDE_PRICE_REQUIRED: manual_override set but source_unit_price_cents is missing or not positive on chemical line %', v_idx
              USING ERRCODE = 'invalid_parameter_value';
          END IF;
          v_chem_manual := v_src_unit_price;
        END IF;

        -- Product units for the rate -> pricing-unit conversion, plus the server-resolved
        -- unit COST (Codex P1 #3). current_cost is dollars per the product's inventory (sold)
        -- unit — the SAME unit as the priced quantity below — so per-unit cents = round(*100),
        -- exactly like _snapshot_order_item_cost and the parked save_invoice.
        SELECT p.inventory_unit, p.product_form,
               COALESCE(round(p.current_cost * 100)::bigint, 0)
          INTO v_inv_unit, v_form, v_line_unit_cost
          FROM products p WHERE p.id = v_product_id;

        -- Per-customer price map (Option B): each billing-set member priced at their OWN
        -- assigned_tier. resolve_field_app_chemical_price() naturally makes manual/quote shared
        -- (tier-independent) and only the tier fallback per-customer, so a manual/quote line
        -- yields identical prices for everyone (calculator collapses to source_lr) while a
        -- pure-tier line prices each co-owner at their own tier (calculator per_person).
        SELECT COALESCE(jsonb_object_agg(
                 m.cust,
                 (resolve_field_app_chemical_price(
                    v_product_id, v_field_ids,
                    COALESCE((SELECT c.assigned_tier FROM customers c WHERE c.id = m.cust::uuid), 1),
                    v_chem_manual)->>'unit_price_cents')::bigint), '{}'::jsonb)
          INTO v_chem_price_map
          FROM unnest(v_members) AS m(cust);

        -- Codex round-11 P1: reject an UNRESOLVED chemical price. Without a manual override, if any
        -- co-owner's resolved price (field quote → their assigned tier) is NULL or <= 0, the line would
        -- bill $0, be flagged suppressed_zero_total, and STILL post — consuming inventory + RUP records
        -- with NO receivable and no operator signal. Require a real positive price for EVERY member. A
        -- manual override (already validated > 0 above) resolves the same for everyone, so it passes.
        IF v_chem_manual IS NULL AND EXISTS (
          SELECT 1 FROM unnest(v_members) AS m(cust)
           WHERE COALESCE((v_chem_price_map->>m.cust)::bigint, 0) <= 0
        ) THEN
          RAISE EXCEPTION 'SPLIT_CHEMICAL_PRICE_UNRESOLVED: chemical line % has no resolvable price (no field quote and no tier price) for one or more co-owners — set the product''s tier pricing / a field quote, or enter a manual override, before saving', v_idx
            USING ERRCODE = 'invalid_parameter_value';
        END IF;

        -- Representative line base (display + the calculator's default price): the largest-share
        -- owner's price. The MONEY comes from the per-customer overrides injected below, not this.
        SELECT c.assigned_tier INTO v_rep_tier
          FROM customers c
         WHERE c.id = (
           SELECT (value->>'customer_id')::uuid
             FROM jsonb_array_elements(v_vector) AS value
            ORDER BY (value->>'micro_pct')::bigint DESC, value->>'customer_id' ASC
            LIMIT 1);
        v_price_res      := resolve_field_app_chemical_price(
                              v_product_id, v_field_ids, COALESCE(v_rep_tier, 1), v_chem_manual);
        v_src_unit_price := (v_price_res->>'unit_price_cents')::bigint;
        v_base_source    := v_price_res->>'price_source';

        -- Convert applied qty (rate unit) -> product sold unit so price x qty is per the
        -- SAME unit (the live 128x guard). No inventory_unit -> identity (price as entered).
        v_priced_qty := field_app_priced_quantity(
                          v_src_qty, v_rate_unit, COALESCE(v_inv_unit, v_rate_unit), v_form);
        IF v_priced_qty IS NULL THEN
          RAISE EXCEPTION 'FIELD_APP_UNIT_UNCONVERTIBLE: chemical line % — rate unit "%" does not convert to the product''s sold unit "%". Fix this product''s units before invoicing.',
            v_idx, coalesce(v_rate_unit, '<none>'), COALESCE(v_inv_unit, v_rate_unit, '<none>')
            USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_src_qty := round(v_priced_qty, 4);
        -- Quantity is now in the pricing (sold) unit; show that unit on the invoice line
        -- so the displayed quantity and its unit label agree.
        v_eff_rate_unit := COALESCE(v_inv_unit, v_rate_unit);
      END;
    ELSE
      -- flat_fee / fuel_surcharge: bill from source_flat_cents; unit price is 0.
      -- Codex round-5 P1: require a POSITIVE amount server-side. The editor rejects <=0
      -- ("credits aren't supported here yet"), but a direct RPC call must not create a free or
      -- negative flat charge (a negative flat_cents would post a CHARGE the operator never saw).
      IF v_src_flat IS NULL OR v_src_flat <= 0 THEN
        RAISE EXCEPTION 'SPLIT_FLAT_CENTS_REQUIRED: source_flat_cents must be a positive amount for % line %', v_line_kind, v_idx
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      v_src_unit_price := COALESCE(v_src_unit_price, 0);
      v_base_source    := 'flat';
    END IF;

    INSERT INTO field_app_billing_lines (
      billing_set_id, line_kind, product_id, application_service_id, description,
      source_quantity, source_acres, source_unit_price_cents, sort_order
    ) VALUES (
      v_set_id, v_line_kind, v_product_id, v_app_service_id, v_line_desc,
      -- Codex round-4 P2 #10: persist the source applied-acre basis alongside the quantity.
      -- Service lines bill on acres (source_quantity is NULL for them), so without this a
      -- post-time verifier had no acre basis for a service line. Now every line records both.
      v_src_qty, v_src_acres, v_src_unit_price, v_idx
    ) RETURNING id INTO v_line_id;

    -- Build the calculator share vector. If the caller omitted 'shares' the line
    -- uses the default vector; otherwise each share may override micro_pct/price
    -- (a null micro_pct on a field_default share is filled from the default map).
    IF v_line ? 'shares' AND jsonb_typeof(v_line->'shares') = 'array'
       AND jsonb_array_length(v_line->'shares') > 0 THEN
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', s->>'customer_id',
               'micro_pct',
                 CASE WHEN s->'micro_pct' IS NOT NULL AND jsonb_typeof(s->'micro_pct') <> 'null'
                      THEN (s->>'micro_pct')::bigint
                      ELSE (v_micro_map->>(s->>'customer_id'))::bigint END,
               'split_mode', COALESCE(s->>'split_mode', 'field_default'),
               'price_mode', COALESCE(s->>'price_mode', 'default'),
               'override_unit_price_cents', s->'override_unit_price_cents'
             ))
        INTO v_shares
        FROM jsonb_array_elements(v_line->'shares') AS s;
    ELSE
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', v->>'customer_id',
               'micro_pct',   (v->>'micro_pct')::bigint,
               'split_mode',  'field_default',
               'price_mode',  'default'
             ))
        INTO v_shares
        FROM jsonb_array_elements(v_vector) AS v;
    END IF;

    -- Option B (chemical): price each share at that customer's OWN resolved price from the map,
    -- UNLESS the caller already set an explicit per-person override (a manual draft adjustment,
    -- which wins). The override slot is how per-person prices reach the calculator. Uniform-price
    -- lines are then routed round-once via the penny guard below (source_lr); genuinely mixed
    -- per-customer prices use the calculator's per_person path (exact to its own SUM).
    IF COALESCE(v_chem_price_map, v_svc_price_map) IS NOT NULL THEN
      SELECT jsonb_agg(
               CASE
                 WHEN s->>'price_mode' = 'override'
                      AND s->'override_unit_price_cents' IS NOT NULL
                      AND jsonb_typeof(s->'override_unit_price_cents') <> 'null'
                 THEN s
                 ELSE jsonb_set(
                        jsonb_set(s, '{price_mode}', '"override"'::jsonb),
                        '{override_unit_price_cents}',
                        to_jsonb((COALESCE(v_chem_price_map, v_svc_price_map)->>(s->>'customer_id'))::bigint))
               END)
        INTO v_shares
        FROM jsonb_array_elements(v_shares) AS s;

      -- Penny guard: when EVERY co-owner ends up at the SAME effective price (a manual/quote
      -- line, all-same-tier, OR a uniform manual per-person adjustment that differs from the
      -- representative), align the calculator's source price to that shared value so it routes
      -- through the round-once source_lr path (penny-exact to a single parent total) instead of
      -- per_person (which can differ by up to n-1 cents on the group total). Mixed prices keep
      -- per_person. Adversarial LOW, 2026-07-18.
      SELECT CASE WHEN count(DISTINCT (s->>'override_unit_price_cents')::bigint) = 1
                  THEN max((s->>'override_unit_price_cents')::bigint) END
        INTO v_uniform_price
        FROM jsonb_array_elements(v_shares) AS s
       WHERE s->>'override_unit_price_cents' IS NOT NULL;
      -- Codex round-7 P2: preserve the RESOLVED representative base BEFORE the uniform penny guard may
      -- overwrite v_src_unit_price with a (uniform) caller override. An 'override' share's AUDITED base
      -- must stay the true tier/quote/service base, not the override value — otherwise the audit reads
      -- as if the override equalled the base and the real tier/quote/service price is lost.
      v_repr_base_price := v_src_unit_price;
      IF v_uniform_price IS NOT NULL THEN
        v_src_unit_price := v_uniform_price;
      END IF;
    ELSE
      v_repr_base_price := v_src_unit_price;
    END IF;

    -- Every line's customer set must EXACTLY equal the billing-set members (spec §3).
    SELECT array_agg(value->>'customer_id' ORDER BY value->>'customer_id')
      INTO v_line_customers
      FROM jsonb_array_elements(v_shares) AS value;
    IF v_line_customers IS DISTINCT FROM v_members THEN
      RAISE EXCEPTION 'SPLIT_LINE_MEMBER_MISMATCH: line % customers do not equal the billing-set members', v_idx
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The single shared engine — preview and save both call this exact function.
    v_calc := compute_line_split_allocation(jsonb_build_object(
      'billing_line_id',         v_line_id::text,
      'line_kind',               v_line_kind,
      'source_quantity',         v_src_qty,
      'source_acres',            v_src_acres,
      'source_unit_price_cents', v_src_unit_price,
      'source_flat_cents',       v_src_flat,
      'base_price_source',       v_base_source,
      'shares',                  v_shares
    ));

    -- Persist the canonical source-line total for the invariant check. Fable-adversarial MED: also
    -- re-persist source_unit_price_cents to the price the money ACTUALLY used — the billing line was
    -- INSERTed with the representative resolved price, but the uniform-override penny guard above may
    -- have re-pointed v_src_unit_price (e.g. a uniform per-person override that differs from the base),
    -- leaving the audit row's price × source inconsistent with its own source_line_cents.
    UPDATE field_app_billing_lines
       SET source_line_cents = (v_calc->>'source_line_cents')::bigint,
           source_unit_price_cents = v_src_unit_price
     WHERE id = v_line_id;

    -- #G (Codex round-2 P1): allocate the ONE canonical line COGS across co-owners with the
    -- SAME largest-remainder rule used for revenue, so the group total_cost ties EXACTLY to
    -- unit_cost x source — no per-child independent-rounding drift of up to n-1 cents. The
    -- line's micro_pct weights already sum to 100000000 (enforced by the invariant), so
    -- _lr_allocate_int sums the shares to v_line_cogs exactly. Zero cost => all-zero shares.
    v_line_cogs := CASE
      WHEN v_line_kind = 'service'  THEN safe_cents_qty(v_line_unit_cost, COALESCE(v_src_acres, 0))
      WHEN v_line_kind = 'chemical' THEN safe_cents_qty(v_line_unit_cost, COALESCE(v_src_qty, 0))
      ELSE 0 END;
    SELECT jsonb_agg(jsonb_build_object('customer_id', a->>'customer_id',
                                        'weight', (a->>'micro_pct')::bigint))
      INTO v_cogs_weights
      FROM jsonb_array_elements(v_calc->'allocations') AS a;
    SELECT jsonb_object_agg(x->>'customer_id', (x->>'amount')::bigint)
      INTO v_cogs_map
      FROM jsonb_array_elements(public._lr_allocate_int(v_line_cogs, v_cogs_weights)) AS x;

    v_line_plans := v_line_plans || jsonb_build_array(jsonb_build_object(
      'billing_line_id', v_line_id::text,
      'line_kind',       v_line_kind,
      'product_id',      v_product_id,
      'description',     v_line_desc,
      'rate_unit',       v_eff_rate_unit,
      'sort_order',      v_idx,
      'unit_cost_cents', v_line_unit_cost,   -- per-unit COGS (Codex P1 #3)
      'cogs_by_customer', v_cogs_map,        -- LR-allocated per-child COGS (Codex r2 #G)
      'per_customer_priced', (COALESCE(v_chem_price_map, v_svc_price_map) IS NOT NULL), -- Option B (#M)
      'caller_override_custs', COALESCE(to_jsonb(v_caller_override), '[]'::jsonb),       -- genuine overrides (#M)
      'repr_base_unit_price_cents', v_repr_base_price,   -- resolved representative base for the override audit (Codex r7 P2)
      'resolved_price_map', COALESCE(v_chem_price_map, v_svc_price_map, '{}'::jsonb),    -- customer_id -> OWN resolved pre-override price (Codex r8 P2)
      'svc_source_map',  COALESCE(v_svc_source_map, '{}'::jsonb),  -- per-customer service source (#M)
      'reasons_map',     COALESCE(v_reasons_map, '{}'::jsonb),     -- split/price reasons (#L)
      'service_name',    CASE WHEN v_line_kind = 'service' THEN v_svc_name ELSE NULL END, -- Codex r2 #N (via v_svc_name: referencing the record here crashed service-less saves)
      'alloc',           v_calc
    ));
    v_line_hashes := v_line_hashes || jsonb_build_array(v_calc->>'vector_hash');
  END LOOP;

  -- ---- PASS 2: one child invoice per customer --------------------------------
  FOREACH v_cust IN ARRAY v_members
  LOOP
    v_customer_id := v_cust::uuid;
    SELECT farm_name INTO v_customer_name FROM customers WHERE id = v_customer_id;
    -- Display-only "primary grower" flag on the compat share row.
    v_is_primary := EXISTS (
      SELECT 1 FROM field_billing_defaults d
       WHERE d.field_id = ANY(v_field_ids)
         AND d.customer_id = v_customer_id
         AND d.is_primary);

    -- sql-safety: exempt-registry — invoices.field_app_billing_set_id / send_disposition
    -- are created by the prior parked migration 20260718010000 (see file header).
    -- Reuse an existing child for this customer on re-save (preserves invoice_number
    -- + append-only snapshot history — adversarial F1 fix); INSERT only for a new customer.
    v_invoice_id := NULL;
    IF p_billing_set_id IS NOT NULL THEN
      -- Reuse only an EDITABLE (draft/unposted) child. Fable-adversarial BLOCKER: a child voided/
      -- cancelled via the live void_invoice stays attached to the set; reusing (reviving) it would be a
      -- forbidden voided->draft transition AND resurrect a dead invoice. Skip it — a fresh child is
      -- INSERTed below for this still-member customer; the terminal one stays as voided/cancelled history.
      SELECT id INTO v_invoice_id FROM invoices
       WHERE field_app_billing_set_id = v_set_id
         AND customer_id = v_customer_id
         AND deleted_at IS NULL
         AND status IN ('draft', 'unposted')
       LIMIT 1;
    END IF;

    IF v_invoice_id IS NULL THEN
      v_is_new_invoice := true;
      v_invoice_number := next_invoice_number('field_application');
      -- sql-safety: exempt-registry — invoices.field_app_billing_set_id is created by the prior
      -- parked migration 20260718010000 (not yet in the schema-registry); job_id / application_date
      -- / season are long-standing invoices columns (mirrors transfer_job_to_invoice).
      -- sql-safety: exempt-registry — field_app_billing_set_id is created by the parked migration
      -- 20260718010000 (not yet in the registry); field_names/crop_type/total_acres are long-standing
      -- invoices columns (20260219200000_invoice_statement_enrichment).
      INSERT INTO invoices (
        invoice_number, customer_id, invoice_type, status,
        invoice_date, salesman_id, header_notes, created_by,
        total_amount_cents, total_cost_cents,
        invoice_group_id, application_service_id, season,
        field_app_billing_set_id, job_id, application_date,
        field_names, crop_type, total_acres,   -- Codex r7 P2: denormalized field context for the combined list/PDFs
        applicator_name, vehicle_name           -- Codex r8 P2: source-job applicator/vehicle
      ) VALUES (
        v_invoice_number, v_customer_id, 'field_application', 'draft',
        COALESCE((p_invoice->>'invoice_date')::date, (now() AT TIME ZONE 'America/Chicago')::date),  -- fallback is the America/Chicago business date, never UTC (2026-09-03)
        v_salesman_id, p_invoice->>'header_notes', p_performed_by,
        0, 0,
        v_group_id, p_application_service_id, v_season,   -- season = job/invoice season (round-3 P1)
        -- job_id + application_date on EVERY child so field-invoice lists resolve Job # and the
        -- application date, not just the first child via jobs.invoice_id (round-3 P2).
        v_set_id, p_source_job_id, v_job_app_date,
        v_inv_field_names, v_inv_crop_type, v_total_applied_acres,
        v_inv_applicator_name, v_inv_vehicle_name
      ) RETURNING id INTO v_invoice_id;
    ELSE
      v_is_new_invoice := false;
      -- Load the existing invoice_number so it is never stale/null on a re-save (Codex P1 #8).
      SELECT invoice_number INTO v_invoice_number FROM invoices WHERE id = v_invoice_id;
      -- Keep status as-is (draft or unposted); a non-admin cannot reassign salesman.
      UPDATE invoices SET
        invoice_date           = COALESCE((p_invoice->>'invoice_date')::date, invoice_date),
        salesman_id            = CASE WHEN is_admin() THEN v_salesman_id ELSE salesman_id END,
        header_notes           = p_invoice->>'header_notes',
        application_service_id  = p_application_service_id,
        invoice_group_id       = v_group_id,
        season                 = v_season,               -- keep season in sync on re-save (round-3 P1)
        job_id                 = p_source_job_id,         -- round-3 P2 (frozen source job)
        application_date       = v_job_app_date,
        field_names            = v_inv_field_names,        -- Codex r7 P2: keep denormalized field context in sync on re-save
        crop_type              = v_inv_crop_type,
        total_acres            = v_total_applied_acres,
        applicator_name        = v_inv_applicator_name,    -- Codex r8 P2
        vehicle_name           = v_inv_vehicle_name,
        total_amount_cents     = 0,
        total_cost_cents       = 0,
        send_disposition       = 'normal',
        updated_at             = now()
      WHERE id = v_invoice_id;
    END IF;

    v_invoice_total := 0;
    v_invoice_cost  := 0;
    v_invoice_chem_profit := 0;   -- round-5 P1: this child's chemical profit (LR COGS), for commissions
    -- Compat share acres derived ONCE from the ownership vector × total applied acres
    -- (Codex P2 #9), independent of the billing lines — so it neither zeroes out on a
    -- no-service set nor double-counts across multiple service lines.
    v_cust_acres    := round(v_total_applied_acres
                             * COALESCE((v_micro_map->>v_cust)::numeric, 0) / 100000000.0, 2);

    FOR v_plan IN SELECT * FROM jsonb_array_elements(v_line_plans)
    LOOP
      v_line_kind := v_plan->>'line_kind';
      -- this customer's allocation row for this line
      SELECT a INTO v_alloc_row
        FROM jsonb_array_elements(v_plan->'alloc'->'allocations') AS a
       WHERE a->>'customer_id' = v_cust;
      IF v_alloc_row IS NULL THEN
        RAISE EXCEPTION 'SPLIT_MISSING_ALLOCATION: customer % missing on line %', v_cust, v_plan->>'billing_line_id'
          USING ERRCODE = 'internal_error';
      END IF;

      v_qty         := (v_alloc_row->>'allocated_quantity')::numeric;
      v_acres_alloc := (v_alloc_row->>'allocated_acres')::numeric;

      -- #M (Codex round-2 P2) + #L reasons: decide each co-owner's AUDITED base price / source /
      -- mode. A co-owner's OWN resolved per-customer price (Option B) is their BASE with its real
      -- source and price_mode='default'; only a genuine caller-supplied manual per-person override
      -- is audited as an 'override' against the representative base. Non-Option-B lines keep the
      -- calculator's values verbatim. Reasons are captured when the operator supplied them.
      v_split_reason := NULLIF(v_plan->'reasons_map'->v_cust->>'split_reason', '');
      v_price_reason := NULLIF(v_plan->'reasons_map'->v_cust->>'price_reason', '');
      IF (v_plan->'caller_override_custs') ? v_cust THEN
        -- Codex round-7/8 P2: audit THIS customer's OWN resolved pre-override price (Option B), falling
        -- back to the resolved representative base (round-7) then the calculator base. Never the override
        -- value itself — the audit must document what the price WOULD have been before the override.
        v_share_base_price  := COALESCE((v_plan->'resolved_price_map'->>v_cust)::bigint,
                                        (v_plan->>'repr_base_unit_price_cents')::bigint,
                                        (v_alloc_row->>'base_unit_price_cents')::bigint);
        v_share_base_source := CASE WHEN v_line_kind = 'service'
                                    THEN COALESCE(v_plan->'svc_source_map'->>v_cust, v_alloc_row->>'base_price_source')
                                    ELSE v_alloc_row->>'base_price_source' END;
        v_share_price_mode  := 'override';
      ELSIF COALESCE((v_plan->>'per_customer_priced')::boolean, false) THEN
        v_share_base_price  := (v_alloc_row->>'unit_price_cents')::bigint;        -- this co-owner's OWN price
        v_share_base_source := CASE WHEN v_line_kind = 'service'
                                    THEN COALESCE(v_plan->'svc_source_map'->>v_cust, v_alloc_row->>'base_price_source')
                                    ELSE v_alloc_row->>'base_price_source' END;
        v_share_price_mode  := 'default';
      ELSE
        v_share_base_price  := (v_alloc_row->>'base_unit_price_cents')::bigint;
        v_share_base_source := v_alloc_row->>'base_price_source';
        v_share_price_mode  := v_alloc_row->>'price_mode';
      END IF;

      -- Map the AUDITED per-customer source onto the invoice_items.price_source
      -- convention set ('manual'|'quoted'|'tier'); the exact source is preserved
      -- on invoice_line_shares.base_price_source.
      v_item_price_source := CASE v_share_base_source
        WHEN 'quoted' THEN 'quoted'
        WHEN 'tier'   THEN 'tier'
        WHEN 'service_rate'    THEN 'tier'
        WHEN 'service_default' THEN 'tier'
        ELSE 'manual' END;

      -- #G (Codex round-2 P1): this co-owner's LR-allocated COGS share for the line, so the
      -- GROUP total_cost ties EXACTLY to the canonical unit_cost x source (no per-child
      -- independent-round drift of up to n-1 cents). The invoice_items.cost_cents keeps its
      -- display convention (#F): a chemical item carries PER-UNIT cost (PDF/detail render unit
      -- economics), a fee (service) item carries this EXTENDED share. The header total_cost
      -- accumulates the LR share below, so the group total is exact regardless.
      v_item_cost_cents := COALESCE((v_plan->'cogs_by_customer'->>v_cust)::bigint, 0);

      -- sql-safety: exempt-registry — invoice_items.billing_line_id is created by the prior parked
      -- migration 20260718010000 (not yet in the registry); unit_size/total_applied/total_applied_unit
      -- are long-standing invoice_items columns (20260219200000_invoice_statement_enrichment).
      -- Codex round-8 P1: the field-application PDF/email renders the price unit from unit_size and the
      -- applied quantity from total_applied/total_applied_unit. For a chemical child, mirror the canonical
      -- field-app item: unit_size = the pricing unit, total_applied = this co-owner's billed quantity in
      -- that unit. Service/flat leave them null (service bills per acre; flat is flat).
      INSERT INTO invoice_items (
        invoice_id, product_id, description,
        quantity, unit_price_cents, extended_cents, cost_cents,
        sort_order, acres, rate_unit,
        unit_size, total_applied, total_applied_unit,
        is_application_fee, price_source, billing_line_id
      ) VALUES (
        v_invoice_id, (v_plan->>'product_id')::uuid,
        COALESCE(NULLIF(v_plan->>'description', ''),
                 (SELECT product_name FROM products WHERE id = (v_plan->>'product_id')::uuid),
                 NULLIF(v_plan->>'service_name', ''),      -- Codex r2 #N: real service name, not literal 'Service'
                 initcap(v_line_kind)),
        CASE WHEN v_line_kind = 'service' THEN COALESCE(v_acres_alloc, 0)
             WHEN v_line_kind = 'chemical' THEN COALESCE(v_qty, 0)
             ELSE 1 END,
        (v_alloc_row->>'unit_price_cents')::bigint,
        (v_alloc_row->>'amount_cents')::bigint,     -- extended = authoritative allocation
        CASE WHEN v_line_kind = 'chemical' THEN (v_plan->>'unit_cost_cents')::bigint
             ELSE v_item_cost_cents END,            -- chemical: PER-UNIT; fee: EXTENDED LR share (#F/#G)
        (v_plan->>'sort_order')::int,
        v_acres_alloc,
        CASE WHEN v_line_kind = 'service' THEN 'acre' ELSE v_plan->>'rate_unit' END,
        CASE WHEN v_line_kind = 'chemical' THEN NULLIF(v_plan->>'rate_unit', '') END,   -- unit_size = pricing unit
        CASE WHEN v_line_kind = 'chemical' THEN COALESCE(v_qty, 0) END,                  -- total_applied = billed qty
        CASE WHEN v_line_kind = 'chemical' THEN NULLIF(v_plan->>'rate_unit', '') END,   -- total_applied_unit
        (v_line_kind = 'service'),
        v_item_price_source,
        (v_plan->>'billing_line_id')::uuid
      ) RETURNING id INTO v_item_id;

      INSERT INTO invoice_line_shares (
        billing_line_id, invoice_item_id, customer_id,
        split_mode, split_micro_pct, allocated_quantity, allocated_acres,
        base_unit_price_cents, base_price_source, price_mode,
        unit_price_cents, amount_cents,
        split_override_reason, price_override_reason,
        calculation_hash, vector_hash, created_by
      ) VALUES (
        (v_plan->>'billing_line_id')::uuid, v_item_id, v_customer_id,
        v_alloc_row->>'split_mode', (v_alloc_row->>'micro_pct')::bigint,
        v_qty, v_acres_alloc,
        v_share_base_price,          -- #M: co-owner's OWN resolved price is the audited base
        v_share_base_source,         -- #M: their own resolved source (service_rate/tier/...)
        v_share_price_mode,          -- #M: 'default' for resolved pricing, 'override' only for a real one
        (v_alloc_row->>'unit_price_cents')::bigint,
        (v_alloc_row->>'amount_cents')::bigint,
        v_split_reason, v_price_reason,   -- #L: captured reasons when the operator supplied them
        v_alloc_row->>'calculation_hash',
        v_plan->'alloc'->>'vector_hash',
        p_performed_by
      );

      v_invoice_total := v_invoice_total + (v_alloc_row->>'amount_cents')::bigint;
      -- #G: accumulate this co-owner's LR-allocated COGS share directly; the GROUP total_cost
      -- now ties EXACTLY to the canonical unit_cost x source (no per-child rounding drift).
      v_invoice_cost  := v_invoice_cost + v_item_cost_cents;
      -- Codex round-5 P1: chemical-line profit for commissions uses the SAME LR-allocated COGS
      -- (v_item_cost_cents), NOT a re-rounded cost*qty on the per-unit item cost. Only product-
      -- backed chemical lines count toward commission (fees/service/flat are excluded), mirroring
      -- transfer_job_to_invoice's chemical-only profit basis.
      IF v_line_kind = 'chemical' THEN
        v_invoice_chem_profit := v_invoice_chem_profit
          + ((v_alloc_row->>'amount_cents')::bigint - v_item_cost_cents);
      END IF;
    END LOOP;

    -- Stash this child's chemical profit (cents) for the commission mint below (round-5 P1).
    v_chem_profit_by_child := v_chem_profit_by_child
      || jsonb_build_object(v_invoice_id::text, v_invoice_chem_profit);

    v_send_disposition := CASE WHEN v_invoice_total = 0 THEN 'suppressed_zero_total' ELSE 'normal' END;

    UPDATE invoices
       SET total_amount_cents = v_invoice_total,
           total_cost_cents   = v_invoice_cost,
           send_disposition   = v_send_disposition,
           updated_at         = now()
     WHERE id = v_invoice_id;

    -- R2: keep the compatibility invoice_shares self-100% row (statements/year-end
    -- read invoice_shares.amount_cents). Do NOT drop as "redundant".
    INSERT INTO invoice_shares (
      invoice_id, customer_id, customer_name,
      split_percentage, acres, amount_cents,
      is_primary, sort_order, price_per_acre_cents, pricing_note
    ) VALUES (
      v_invoice_id, v_customer_id, v_customer_name,
      100.0, v_cust_acres, v_invoice_total,
      v_is_primary, 0, NULL, NULL
    );

    -- Append-only ledger: emit the 'invoice_created' row ONLY when this child was freshly
    -- INSERTed (Codex P1 #8). On a re-save we reuse the existing child, so a creation row
    -- here would duplicate the invoice's financial impact and (previously) carry a stale/null
    -- invoice_number. A re-save changes draft line detail only; no creation event is due.
    IF v_is_new_invoice THEN
      INSERT INTO financial_audit_log (
        operation_type, entity_type, entity_id, actor_role,
        new_values, total_impact_cents, description
      ) VALUES (
        'invoice_created', 'invoice', v_invoice_id,
        (SELECT role FROM profiles WHERE id = v_actor),
        jsonb_build_object('invoice_number', v_invoice_number,
                           'customer_id', v_customer_id,
                           'total_cents', v_invoice_total,
                           'send_disposition', v_send_disposition),
        v_invoice_total,
        'Per-line split field application invoice created'
      );
    END IF;

    v_invoice_ids := array_append(v_invoice_ids, v_invoice_id);
  END LOOP;

  -- ---- #E CONSUME THE SOURCE JOB (Codex round-2 P1) --------------------------
  -- Now that the child invoices exist, mark the source job invoiced exactly like
  -- transfer_job_to_invoice does, so the normal flow's "Job already invoiced" guard
  -- fires and the same work can never be billed twice. Idempotent on re-save (a job
  -- already 'invoiced' by THIS set is left as-is; the guard above already allowed it).
  IF p_source_job_id IS NOT NULL THEN
    -- Resolve the commission split exactly like transfer_job_to_invoice: the job's own
    -- creation-time snapshot, else the parent quote's split, else the customer default (only
    -- pre-U8 jobs reach the fallback). v_job was loaded FOR UPDATE in the #E guard above.
    v_commission_split := v_job.commission_split;
    IF v_commission_split IS NULL THEN
      IF v_job.quote_id IS NOT NULL THEN
        SELECT q.commission_split INTO v_commission_split FROM quotes q WHERE q.id = v_job.quote_id;
      ELSE
        SELECT c.default_commission_split INTO v_commission_split FROM customers c WHERE c.id = v_job.customer_id;
      END IF;
    END IF;

    -- Consume the job: flip completed->invoiced, set the anchor invoice_id, AND persist the resolved
    -- split — ALL IN ONE statement while OLD.status='completed'. The live enforce_billed_job_immutability
    -- trigger early-returns for a not-yet-billed job, so this is the ONLY point a non-admin may set
    -- invoice_id (drift B1); it is exactly the single-statement shape of transfer_job_to_invoice.
    -- Idempotent: no-ops on re-save (status already 'invoiced').
    UPDATE jobs SET status = 'invoiced', invoice_id = v_invoice_ids[1],
        commission_split = COALESCE(commission_split, v_commission_split, '{"splits":[]}'::jsonb)
     WHERE id = p_source_job_id AND status <> 'invoiced';

    -- Codex round-5 P2 / drift B1: on a RE-SAVE that dropped the member previously stored in
    -- jobs.invoice_id, the anchor now points at a cancelled, detached child — repoint it to a surviving
    -- current child (v_invoice_ids only ever holds current members). The job is already 'invoiced', so
    -- the immutability trigger would block a non-admin from changing invoice_id — use the SAME
    -- app.admin_override hatch that trigger sanctions for definer-flow writers (as transfer_invoice_to_job
    -- does), scoped tightly around JUST this repoint, and ONLY when the stored anchor is no longer a live
    -- member child (a no-op when it is unchanged — the common re-save case, no override needed).
    IF NOT EXISTS (
      SELECT 1 FROM invoices i
       WHERE i.id = (SELECT j.invoice_id FROM jobs j WHERE j.id = p_source_job_id)
         AND i.field_app_billing_set_id = v_set_id
         AND i.deleted_at IS NULL AND i.status <> 'cancelled'
    ) THEN
      PERFORM set_config('app.admin_override', 'true', true);
      UPDATE jobs SET invoice_id = v_invoice_ids[1] WHERE id = p_source_job_id;
      PERFORM set_config('app.admin_override', 'false', true);
    END IF;

    -- application_records has no billed-immutability guard (triggers live only on jobs / job_applied_
    -- records) — repoint it unconditionally to the surviving anchor, matching live transfer_job_to_invoice.
    UPDATE application_records SET invoice_id = v_invoice_ids[1]
     WHERE source_type = 'job' AND source_id = p_source_job_id;

    -- ---- Per-child commissions (Codex round-4 P1) ----------------------------
    -- Mirror transfer_job_to_invoice's PER-OWNER GROUP path: each child invoice mints
    -- commissions on ITS OWN chemical-line profit, so the sum across children equals the
    -- whole job's chemical profit and each recipient is paid per invoice they touch. A
    -- split job billed here previously created NO commissions AND the status flip blocked
    -- the normal path from ever creating them.
    --
    -- Profit basis (Codex round-5 P1): each child's CHEMICAL profit accumulated in PASS 2 using the
    -- SAME largest-remainder-allocated COGS (v_item_cost_cents) that the header total_cost carries —
    -- NOT a re-rounded ROUND(cost × qty) on the per-unit item cost, which would drift on fractional
    -- child quantities (1¢/1u/50-50 rounds both 0.5¢ shares up to 1¢, understating profit). Service /
    -- flat / fee lines contribute 0. Sum across children == the whole job's chemical profit.
    --
    -- Re-save safe: a redraw rewrites every child's items (changing profit) and may DROP a member
    -- (whose child was orphan-cancelled above). The #E guard makes this job EXCLUSIVE to this set
    -- (it cannot be on another set or normally invoiced), so EVERY commission carrying this job_id
    -- belongs to this set — clear them ALL (including a dropped member's, which would otherwise leak
    -- a phantom pending commission on a cancelled invoice), then re-mint only for the current
    -- members. First REFUSE if any are already in an active payout batch or already paid (mirrors
    -- the U8 edit guards): the operator must void that commission payment before re-saving. On a
    -- first save there are none, so the guards pass and the clear is a no-op.
    IF EXISTS (
      SELECT 1 FROM commissions c
      JOIN commission_payment_items cpi ON cpi.commission_id = c.id
      JOIN commission_payments cp ON cp.id = cpi.commission_payment_id
      WHERE c.job_id = p_source_job_id AND c.status = 'pending' AND cp.status <> 'voided'
    ) THEN
      RAISE EXCEPTION 'JOB_HAS_BATCHED_COMMISSIONS: this split''s pending commissions are in an active payout batch — void that commission payment before re-saving';
    END IF;
    IF EXISTS (
      SELECT 1 FROM commissions c WHERE c.job_id = p_source_job_id AND c.status = 'paid'
    ) THEN
      RAISE EXCEPTION 'JOB_COMMISSIONS_PAID: this split''s commissions were already paid out — void that commission payment before re-saving';
    END IF;

    -- Fable-adversarial HIGH: SOFT-cancel (never hard-DELETE) the prior commissions, then re-mint.
    -- A hard DELETE FK-violates once any of the job's commissions were EVER in a payout batch — even a
    -- VOIDED one, which is exactly what JOB_HAS_BATCHED_COMMISSIONS tells the operator to do first
    -- (commission_payment_items.commission_id is NO ACTION and void_commission_payment leaves its cpi
    -- rows in place). Soft-cancel mirrors the live convention (delete_invoices / void_invoice cancel+zero
    -- commissions, never delete them) and preserves the audit trail. Re-mint below writes fresh rows.
    UPDATE commissions
       SET status = 'cancelled', commission_amount = 0, deleted_at = now()
     WHERE job_id = p_source_job_id AND deleted_at IS NULL;

    FOREACH v_child_id IN ARRAY v_invoice_ids
    LOOP
      -- Chemical profit for this child from the LR-allocated accumulator (cents -> dollars).
      v_child_profit := COALESCE((v_chem_profit_by_child->>v_child_id::text)::bigint, 0)::numeric / 100.0;

      SELECT customer_id INTO v_child_customer FROM invoices WHERE id = v_child_id;

      PERFORM _insert_commissions_for_job(
        p_source_job_id, v_child_id, v_child_customer,
        COALESCE(v_child_profit, 0), v_commission_split, CURRENT_DATE);
    END LOOP;
  END IF;

  -- ---- PASS 3: field snapshots for the group (Codex P1 #7) -------------------
  -- Grouped (multi-customer) field-app invoices carry their field/crop/acre snapshot at the
  -- GROUP level (invoice_id NULL, invoice_group_id set) — exactly how the live field-app save
  -- and the invoice-list panels read them. Without these, lists and PDFs show blank fields,
  -- crops, and zero acres. job_id carries source-job provenance AND satisfies fal_requires_parent
  -- when no invoice_id is present. The prior group's rows were cleared in the re-save block.
  INSERT INTO field_app_locations (
    invoice_group_id, job_id, field_id, applied_acres, total_acres, crop_type, sort_order
  )
  SELECT v_group_id, p_source_job_id, (t.fld->>'field_id')::uuid,
         (t.fld->>'applied_acres')::numeric,
         fl.total_acres, fl.crop_type, (t.ord - 1)::int
    FROM jsonb_array_elements(p_fields) WITH ORDINALITY AS t(fld, ord)
    LEFT JOIN fields fl ON fl.id = (t.fld->>'field_id')::uuid;

  -- ---- §5 INVARIANTS — check the STORED rows, never the allocator's self-report -
  FOR v_line_id, v_src_line_cents, v_line_src_qty IN
    SELECT id, source_line_cents, source_quantity
      FROM field_app_billing_lines WHERE billing_set_id = v_set_id
  LOOP
    SELECT COALESCE(SUM(amount_cents), 0),
           COALESCE(SUM(split_micro_pct), 0),
           count(DISTINCT customer_id),
           SUM(allocated_quantity)
      INTO v_sum_cents, v_sum_micro, v_line_member_count, v_sum_qty
      FROM invoice_line_shares WHERE billing_line_id = v_line_id;

    IF v_sum_cents IS DISTINCT FROM v_src_line_cents THEN
      RAISE EXCEPTION 'INVARIANT_CENTS: line % stored cents % <> source_line_cents %',
        v_line_id, v_sum_cents, v_src_line_cents USING ERRCODE = 'internal_error';
    END IF;
    IF v_sum_micro <> 100000000 THEN
      RAISE EXCEPTION 'INVARIANT_MICRO: line % micro_pct sum % <> 100000000', v_line_id, v_sum_micro
        USING ERRCODE = 'internal_error';
    END IF;
    IF v_line_member_count <> array_length(v_members, 1) THEN
      RAISE EXCEPTION 'INVARIANT_MEMBERS: line % has % customers, expected %',
        v_line_id, v_line_member_count, array_length(v_members, 1) USING ERRCODE = 'internal_error';
    END IF;
    -- quantity ties to source at 4dp when a source quantity was provided
    IF v_line_src_qty IS NOT NULL
       AND round(COALESCE(v_sum_qty, 0), 4) IS DISTINCT FROM round(v_line_src_qty, 4) THEN
      RAISE EXCEPTION 'INVARIANT_QTY: line % qty sum % <> source_quantity %',
        v_line_id, v_sum_qty, v_line_src_qty USING ERRCODE = 'internal_error';
    END IF;
  END LOOP;

  -- ---- RESULT + idempotency ---------------------------------------------------
  v_result := jsonb_build_object(
    'billing_set_id',     v_set_id,
    'invoice_group_id',   v_group_id,
    'invoice_ids',        to_jsonb(v_invoice_ids),
    'line_vector_hashes', v_line_hashes,
    'request_hash',       p_request_hash
  );

  INSERT INTO activity_feed (
    event_type, description, performed_by, related_entity_type, related_entity_id
  ) VALUES (
    'field_app_split_invoice_saved',
    'Per-line split field app billing set saved with ' || array_length(v_invoice_ids, 1) || ' invoice(s)',
    p_performed_by, 'invoice', v_invoice_ids[1]
  );

  -- Record the idempotency key (paired with the wrapper's check_idempotency; see the
  -- idempotency-body-check exemption note at the top — canonical wrapper/impl split).
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_field_app_split_invoice', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_line_split_vector(p_field_ids uuid[], p_source_job_id uuid, p_applied_acres_map jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_field       uuid;
  v_acres       numeric;
  v_field_rows  jsonb;
  v_weights     jsonb := '[]'::jsonb;
  v_result      jsonb;
BEGIN
  -- Authorization (RLS review M1): this is a SECURITY DEFINER read that bypasses the
  -- RLS on job_field_shares / field_billing_defaults / fields, so restrict the
  -- enumeration surface to the app's trust boundary — active admin/sales_rep — exactly
  -- like the save wrapper. (When called from the save writer the actor is already an
  -- admin/sales_rep, so this is a no-op there; it closes the direct-call surface.)
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles
                  WHERE id = auth.uid() AND is_active = true
                    AND role IN ('admin', 'sales_rep')) THEN
    RAISE EXCEPTION 'Not authorized: active admin or sales role required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_field_ids IS NULL OR array_length(p_field_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'RESOLVER_NO_FIELDS: at least one field_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  FOREACH v_field IN ARRAY p_field_ids
  LOOP
    v_acres := COALESCE((p_applied_acres_map->>v_field::text)::numeric, 0);
    IF v_acres <= 0 THEN
      RAISE EXCEPTION 'RESOLVER_ZERO_ACRES: applied acres must be > 0 for field %', v_field
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_source_job_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM job_field_shares s
                    WHERE s.job_id = p_source_job_id AND s.field_id = v_field) THEN
      -- 1) Job snapshot wins.
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', s.customer_id::text,
               'weight',      v_acres * (s.split_pct / 100.0)))
        INTO v_field_rows
        FROM job_field_shares s
       WHERE s.job_id = p_source_job_id AND s.field_id = v_field;
    ELSIF EXISTS (SELECT 1 FROM field_billing_defaults d WHERE d.field_id = v_field) THEN
      -- 2) Field ownership default.
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', d.customer_id::text,
               'weight',      v_acres * (d.split_pct / 100.0)))
        INTO v_field_rows
        FROM field_billing_defaults d
       WHERE d.field_id = v_field;
    ELSE
      -- 3) Fallback: the field's owner at 100%.
      SELECT jsonb_agg(jsonb_build_object(
               'customer_id', f.customer_id::text,
               'weight',      v_acres))
        INTO v_field_rows
        FROM fields f
       WHERE f.id = v_field;
    END IF;

    IF v_field_rows IS NOT NULL THEN
      v_weights := v_weights || v_field_rows;
    END IF;
  END LOOP;

  -- Largest-remainder conversion of the aggregate weights → micro_pct summing to
  -- exactly 100000000, tie-break customer_id ASC (identical rule to the calculator).
  WITH agg AS (
    SELECT e->>'customer_id' AS customer_id, SUM((e->>'weight')::numeric) AS w
      FROM jsonb_array_elements(v_weights) AS e
     GROUP BY e->>'customer_id'
  ),
  tot AS (SELECT SUM(w) AS total FROM agg),
  ideals AS (
    SELECT a.customer_id,
           (a.w / t.total) * 100000000::numeric AS ideal
      FROM agg a CROSS JOIN tot t
     WHERE t.total > 0
  ),
  bases AS (
    SELECT customer_id, floor(ideal)::bigint AS base, ideal - floor(ideal) AS frac
      FROM ideals
  ),
  resid AS (SELECT 100000000 - COALESCE(SUM(base), 0) AS residual FROM bases),
  ranked AS (
    SELECT customer_id, base,
           row_number() OVER (ORDER BY frac DESC, customer_id ASC) AS rn
      FROM bases
  ),
  allocated AS (
    SELECT customer_id,
           base + CASE WHEN rn <= (SELECT residual FROM resid) THEN 1 ELSE 0 END AS micro_pct
      FROM ranked
  )
  SELECT jsonb_agg(
           jsonb_build_object('customer_id', customer_id, 'micro_pct', micro_pct)
           ORDER BY customer_id ASC
         )
    INTO v_result
    FROM allocated;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'RESOLVER_EMPTY_VECTOR: no billing customers derived from fields'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The Codex round-12 assigned-rep boundary on direct calls is removed (20261013220000):
  -- reps bill and see ANY customer (Mason, 2026-10-13). The active admin/sales_rep gate at the
  -- top still closes this read to every other role.

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_statement(p_customer_id uuid, p_start_date date DEFAULT ((CURRENT_DATE - '90 days'::interval))::date, p_end_date date DEFAULT CURRENT_DATE)
 RETURNS TABLE(transaction_date date, transaction_type text, reference_number text, description text, amount_cents bigint, running_balance bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;

  -- Reps read ANY customer's statement (Mason, 2026-10-13); the assigned-rep
  -- check is removed by 20261013220000.
  IF v_actor_role IS DISTINCT FROM 'sales_rep'
     AND v_actor_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  RETURN QUERY
  SELECT *
    FROM public._get_customer_statement_scoped_impl(
      p_customer_id,
      p_start_date,
      p_end_date
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_year_end_summary(p_customer_id uuid, p_season integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cust record;
  v_season_start date;
  v_season_end date;
  v_financial jsonb;
  v_product_usage jsonb;
  v_acreage jsonb;
  v_invoices jsonb;
  v_shares jsonb;
  v_prior_season jsonb;
BEGIN
  PERFORM public.require_admin_or_sales_rep();
  -- Reps read ANY customer's year-end summary (Mason, 2026-10-13); the
  -- assigned-rep check is removed by 20261013220000.

  SELECT * INTO v_cust FROM public.customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;
  v_season_start := public.season_start_date(p_season);
  v_season_end := public.season_end_date(p_season);

  SELECT jsonb_build_object(
    'total_invoiced_cents', COALESCE(SUM(total_amount_cents), 0),
    'total_paid_cents', COALESCE(SUM(paid_amount_cents), 0),
    'prepay_applied_cents', COALESCE(SUM(prepay_applied_cents), 0),
    'outstanding_balance_cents', COALESCE(SUM(balance_cents), 0),
    'invoice_count', COUNT(*)
  ) INTO v_financial
  FROM public.invoices
  WHERE customer_id = p_customer_id AND season = p_season
    AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL;

  SELECT COALESCE(jsonb_agg(row_to_json(t)::jsonb ORDER BY t.category, t.product_name), '[]'::jsonb)
  INTO v_product_usage
  FROM (
    SELECT COALESCE(p.category, 'Uncategorized') AS category,
      COALESCE(p.product_name, ii.description) AS product_name,
      p.epa_registration, SUM(ii.quantity) AS total_quantity,
      MAX(ii.unit_size) AS unit_size,
      CASE WHEN SUM(COALESCE(ii.acres, 0)) > 0 THEN ROUND(AVG(ii.rate_per_acre)::numeric, 2) ELSE NULL END AS avg_rate_per_acre,
      MAX(ii.rate_unit) AS rate_unit, SUM(COALESCE(ii.acres, 0)) AS total_acres_treated,
      SUM(ii.extended_cents) AS total_cost_cents,
      SUM(COALESCE(ii.total_applied, 0)) AS total_applied,
      MAX(ii.total_applied_unit) AS total_applied_unit,
      SUM(COALESCE(ii.total_applied_gl_lb, 0)) AS total_applied_gl_lb,
      MAX(ii.gl_lb_unit) AS gl_lb_unit, ii.is_application_fee
    FROM public.invoice_items ii
    JOIN public.invoices i ON i.id = ii.invoice_id
    LEFT JOIN public.products p ON p.id = ii.product_id
    WHERE i.customer_id = p_customer_id AND i.season = p_season
      AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL
    GROUP BY COALESCE(p.category, 'Uncategorized'), COALESCE(p.product_name, ii.description),
      p.epa_registration, ii.is_application_fee
  ) t;

  SELECT jsonb_build_object(
    'total_acres', COALESCE(SUM(i.total_acres), 0),
    'by_crop', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('crop_type', sub.crop_type, 'acres', sub.total_acres) ORDER BY sub.total_acres DESC)
      FROM (
        SELECT COALESCE(crop_type, 'Unknown') AS crop_type, SUM(total_acres) AS total_acres
        FROM public.invoices
        WHERE customer_id = p_customer_id AND season = p_season AND invoice_type = 'field_application'
          AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL AND total_acres IS NOT NULL
        GROUP BY COALESCE(crop_type, 'Unknown')
      ) sub
    ), '[]'::jsonb)
  ) INTO v_acreage
  FROM public.invoices i
  WHERE i.customer_id = p_customer_id AND i.season = p_season AND i.invoice_type = 'field_application'
    AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'invoice_number', i.invoice_number, 'invoice_date', i.invoice_date, 'invoice_type', i.invoice_type,
    'field_names', i.field_names, 'total_acres', i.total_acres, 'crop_type', i.crop_type,
    'total_amount_cents', i.total_amount_cents, 'balance_cents', i.balance_cents, 'status', i.status
  ) ORDER BY i.invoice_date, i.created_at), '[]'::jsonb)
  INTO v_invoices
  FROM public.invoices i
  WHERE i.customer_id = p_customer_id AND i.season = p_season
    AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'invoice_number', i.invoice_number, 'field_names', i.field_names,
    'share_customer_name', s.customer_name, 'split_percentage', s.split_percentage,
    'acres', s.acres, 'amount_cents', s.amount_cents,
    'price_per_acre_cents', s.price_per_acre_cents, 'pricing_note', s.pricing_note
  ) ORDER BY i.invoice_date, s.sort_order), '[]'::jsonb)
  INTO v_shares
  FROM public.invoice_shares s JOIN public.invoices i ON i.id = s.invoice_id
  WHERE i.customer_id = p_customer_id AND i.season = p_season
    AND i.status IN ('posted', 'overdue', 'paid') AND i.deleted_at IS NULL;

  SELECT CASE WHEN COUNT(*) > 0 THEN jsonb_build_object(
    'total_invoiced_cents', COALESCE(SUM(total_amount_cents), 0),
    'total_paid_cents', COALESCE(SUM(paid_amount_cents), 0), 'invoice_count', COUNT(*),
    'total_acres', COALESCE((
      SELECT SUM(total_acres) FROM public.invoices
      WHERE customer_id = p_customer_id AND season = p_season - 1 AND invoice_type = 'field_application'
        AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL
    ), 0)
  ) ELSE NULL END INTO v_prior_season
  FROM public.invoices
  WHERE customer_id = p_customer_id AND season = p_season - 1
    AND status IN ('posted', 'overdue', 'paid') AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'customer', jsonb_build_object('id', v_cust.id, 'farm_name', v_cust.farm_name,
      'contact_name', v_cust.contact_name, 'account_number', v_cust.account_number,
      'email', v_cust.email, 'phone', v_cust.phone, 'billing_address', v_cust.billing_address,
      'city', v_cust.city, 'state', v_cust.state, 'zip', v_cust.zip,
      'assigned_tier', v_cust.assigned_tier, 'payment_terms', v_cust.payment_terms),
    'season', p_season, 'season_start', v_season_start, 'season_end', v_season_end,
    'financial', v_financial, 'product_usage', v_product_usage, 'acreage', v_acreage,
    'invoices', v_invoices, 'shares', v_shares, 'prior_season', v_prior_season
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_balance_listing(p_as_of_date date)
 RETURNS TABLE(customer_id uuid, farm_name text, total_invoiced numeric, total_paid numeric, prepay_applied numeric, outstanding_balance numeric, open_credit numeric, invoice_count bigint, oldest_unpaid_date date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_is_admin boolean;
  v_customer_id uuid;
BEGIN
  IF v_actor IS NULL OR p_as_of_date IS NULL THEN
    RAISE EXCEPTION 'INVALID_HISTORICAL_REPORT_INPUT';
  END IF;

  SELECT p.role
    INTO v_role
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.is_active = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'Permission denied: requires admin or sales_rep role';
  END IF;
  v_is_admin := v_role = 'admin';
  -- Reps list balances of ANY customer (Mason, 2026-10-13; 20261013220000 removed the
  -- assigned-rep filters), still counting only invoices they created or are the salesperson on.

  IF NOT v_is_admin
     AND p_as_of_date < (now() AT TIME ZONE 'America/Chicago')::date THEN
    RAISE EXCEPTION 'Admin access required for historical customer balance report';
  END IF;

  FOR v_customer_id IN
    SELECT DISTINCT i.customer_id
      FROM public.invoices i
      JOIN public.customers c ON c.id = i.customer_id
     WHERE i.invoice_date <= p_as_of_date
       AND (v_is_admin OR i.created_by = v_actor OR i.salesman_id = v_actor)
       AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
  LOOP
    PERFORM public.assert_customer_balance_reconstructable_as_of(v_customer_id, p_as_of_date);
  END LOOP;

  RETURN QUERY
  WITH eligible_invoices AS (
    SELECT
      i.id,
      i.customer_id,
      i.invoice_date::date,
      i.total_amount_cents,
      i.paid_amount_cents,
      i.prepay_applied_cents,
      (
        i.balance_cents
        + i.credit_applied_cents
        - credit_at_cutoff.applied_cents
      )::bigint AS statement_balance_cents
    FROM public.invoices i
    JOIN public.customers scoped_customer ON scoped_customer.id = i.customer_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(cma.amount_cents), 0)::bigint AS applied_cents
        FROM public.credit_memo_applications cma
       WHERE cma.target_invoice_id = i.id
         AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
         AND (
           cma.reversed_at IS NULL
           OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
         )
    ) credit_at_cutoff
    WHERE i.invoice_type <> 'credit_memo'
      AND i.invoice_date <= p_as_of_date
      AND (v_is_admin OR i.created_by = v_actor OR i.salesman_id = v_actor)
      AND public.statement_invoice_was_posted_as_of(i.id, i.posted_at, p_as_of_date)
      AND (i.voided_at IS NULL OR (i.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (i.deleted_at IS NULL OR (i.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
  ),
  open_credits AS (
    SELECT
      ci.customer_id,
      COALESCE(sum(
        greatest(
          -ci.total_amount_cents - COALESCE((
            SELECT sum(cma.amount_cents)
              FROM public.credit_memo_applications cma
             WHERE cma.credit_memo_id = ci.id
               AND (cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date
               AND (
                 cma.reversed_at IS NULL
                 OR (cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date
               )
          ), 0),
          0::bigint
        )
      ), 0)::bigint AS credit_cents
    FROM public.invoices ci
    JOIN public.customers scoped_customer ON scoped_customer.id = ci.customer_id
    WHERE ci.invoice_type = 'credit_memo'
      AND ci.invoice_date <= p_as_of_date
      AND (v_is_admin OR ci.created_by = v_actor OR ci.salesman_id = v_actor)
      AND public.statement_invoice_was_posted_as_of(ci.id, ci.posted_at, p_as_of_date)
      AND (ci.voided_at IS NULL OR (ci.voided_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
      AND (ci.deleted_at IS NULL OR (ci.deleted_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date)
    GROUP BY ci.customer_id
  )
  SELECT
    c.id,
    c.farm_name,
    round(COALESCE(sum(ei.total_amount_cents), 0) / 100.0, 2),
    round(COALESCE(sum(ei.paid_amount_cents), 0) / 100.0, 2),
    round(COALESCE(sum(ei.prepay_applied_cents), 0) / 100.0, 2),
    round(COALESCE(sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) / 100.0, 2),
    round(COALESCE(oc.credit_cents, 0) / 100.0, 2),
    count(ei.id),
    min(ei.invoice_date) FILTER (WHERE ei.statement_balance_cents > 0)
  FROM public.customers c
  LEFT JOIN eligible_invoices ei ON ei.customer_id = c.id
  LEFT JOIN open_credits oc ON oc.customer_id = c.id
  GROUP BY c.id, c.farm_name, oc.credit_cents
  HAVING COALESCE(sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) > 0
      OR COALESCE(oc.credit_cents, 0) > 0
  ORDER BY COALESCE(sum(ei.statement_balance_cents) FILTER (WHERE ei.statement_balance_cents > 0), 0) DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_customer(p_customer_id uuid, p_customer_payload jsonb, p_addresses jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_customer_id uuid;
  v_is_new boolean := (p_customer_id IS NULL);
  v_incoming_ids uuid[];
  v_result jsonb;
  v_existing jsonb;
  v_cached_customer_id uuid;
  v_cached_row_version bigint;
  v_old_commission_split jsonb;
  v_old_row_version bigint;
  v_expected_row_version bigint;
  v_request_fingerprint text;
  v_stored_sales_rep uuid;
  v_stored_row_version bigint;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role INTO v_actor_role
  FROM profiles
  WHERE id = v_actor
    AND is_active = true
    AND role IN ('admin', 'sales_rep');
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  v_request_fingerprint := md5(jsonb_build_object(
    'customer_id', p_customer_id,
    'customer_payload', p_customer_payload,
    'addresses', p_addresses,
    'performed_by', p_performed_by
  )::text);

  -- Ownership gates run BEFORE the idempotency early-return (Codex P2, 2026-07-17):
  -- check_idempotency is not actor/customer-scoped, so a cached result must never
  -- be released to an actor the gates below would reject.
  IF v_actor_role <> 'admin' THEN
    IF v_is_new THEN
      -- Mirrors customers_insert WITH CHECK: a sales rep may only create
      -- customers assigned to themselves; NULL/absent is rejected too.
      IF (p_customer_payload->>'assigned_sales_rep')::uuid IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'REP_MUST_SELF_ASSIGN';
      END IF;
    ELSE
      -- Reps edit ANY customer (Mason, 2026-10-13; 20261013220000 removed the
      -- customer-owner test). Only an admin changes who a customer is
      -- assigned to: the edit page always sends the loaded assigned_sales_rep
      -- back, so it is compared with the STORED value (an absent key leaves the
      -- column untouched). FOR UPDATE holds the row lock through the
      -- customer/address DML so a concurrent reassignment can't slip between
      -- this check and the UPDATE. The commission split rule (admin or the
      -- customer's own rep) is enforced by customers_guard_rep_edit_20261013.
      -- A page loaded before the row changed is left to the CUSTOMER_STALE_WRITE
      -- check below (reload dialog) instead of reading as a reassignment.
      SELECT assigned_sales_rep, row_version
        INTO v_stored_sales_rep, v_stored_row_version
        FROM customers
       WHERE id = p_customer_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'CUSTOMER_NOT_FOUND';
      END IF;
      IF p_customer_payload ? 'assigned_sales_rep'
         AND (p_customer_payload->>'assigned_sales_rep')::uuid IS DISTINCT FROM v_stored_sales_rep
         AND (p_customer_payload->>'row_version_expected') IS NOT DISTINCT FROM v_stored_row_version::text THEN
        RAISE EXCEPTION 'REP_CANNOT_REASSIGN';
      END IF;
    END IF;
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'save_customer');
    IF v_existing IS NOT NULL THEN
      -- Bind the replay to the cached target (Codex r2, 2026-07-17):
      -- check_idempotency is scoped only by key+operation, so the cached result
      -- must name the same customer as this request before it is released (same
      -- pattern as save_purchase_order's replay). Reps may edit any customer
      -- (Mason, 2026-10-13), so there is no ownership re-check here any more.
      v_cached_customer_id := NULLIF(v_existing->>'customer_id', '')::uuid;
      IF v_cached_customer_id IS NULL THEN
        RAISE EXCEPTION 'SAVE_CUSTOMER_RESULT_INVALID';
      END IF;
      IF p_customer_id IS NOT NULL
         AND p_customer_id IS DISTINCT FROM v_cached_customer_id THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      IF v_existing->>'_request_fingerprint' IS DISTINCT FROM v_request_fingerprint THEN
        RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT';
      END IF;
      IF jsonb_typeof(v_existing->'row_version') <> 'number'
         OR (v_existing->>'row_version') !~ '^(0|[1-9][0-9]*)$' THEN
        RAISE EXCEPTION 'SAVE_CUSTOMER_RESULT_INVALID';
      END IF;
      v_cached_row_version := (v_existing->>'row_version')::bigint;
      SELECT row_version
        INTO v_old_row_version
      FROM customers
      WHERE id = v_cached_customer_id
      FOR UPDATE;
      IF NOT FOUND OR v_old_row_version IS DISTINCT FROM v_cached_row_version THEN
        RAISE EXCEPTION 'CUSTOMER_STALE_WRITE: customer changed after the saved request completed — reload to review the current customer before continuing';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  IF p_customer_payload ? 'default_commission_split'
     AND p_customer_payload->'default_commission_split' IS NOT NULL
     AND p_customer_payload->'default_commission_split' <> 'null'::jsonb THEN
    PERFORM public.validate_commission_split_json(p_customer_payload->'default_commission_split');
  END IF;

  IF v_is_new THEN
    INSERT INTO customers (
      farm_name, contact_name, phone, email, billing_address,
      assigned_tier, assigned_sales_rep, total_acres, corn_acres,
      soybean_acres, other_acres, payment_terms,
      default_commission_split, notes, is_active,
      parent_customer_id, credit_limit_cents,
      finance_charge_rate, finance_charge_enabled, finance_charge_grace_days,
      default_application_service_id
    ) VALUES (
      p_customer_payload->>'farm_name',
      NULLIF(p_customer_payload->>'contact_name', ''),
      NULLIF(p_customer_payload->>'phone', ''),
      NULLIF(p_customer_payload->>'email', ''),
      NULLIF(p_customer_payload->>'billing_address', ''),
      COALESCE((p_customer_payload->>'assigned_tier')::integer, 1),
      (p_customer_payload->>'assigned_sales_rep')::uuid,
      (p_customer_payload->>'total_acres')::numeric,
      (p_customer_payload->>'corn_acres')::numeric,
      (p_customer_payload->>'soybean_acres')::numeric,
      (p_customer_payload->>'other_acres')::numeric,
      NULLIF(p_customer_payload->>'payment_terms', ''),
      CASE WHEN p_customer_payload ? 'default_commission_split'
        THEN (p_customer_payload->'default_commission_split') ELSE NULL END,
      NULLIF(p_customer_payload->>'notes', ''),
      COALESCE((p_customer_payload->>'is_active')::boolean, true),
      (p_customer_payload->>'parent_customer_id')::uuid,
      COALESCE((p_customer_payload->>'credit_limit_cents')::bigint, 0),
      COALESCE((p_customer_payload->>'finance_charge_rate')::numeric, 0),
      COALESCE((p_customer_payload->>'finance_charge_enabled')::boolean, true),
      COALESCE((p_customer_payload->>'finance_charge_grace_days')::integer, 0),
      (p_customer_payload->>'default_application_service_id')::uuid
    ) RETURNING id INTO v_customer_id;
  ELSE
    v_customer_id := p_customer_id;

    -- Lost-update guard (2026-07-22): lock the row and compare the stored split
    -- against the value the client loaded (default_commission_split_expected)
    -- before allowing a split overwrite from a stale tab. Callers that omit
    -- default_commission_split_expected behave exactly as before.
    SELECT default_commission_split, row_version
      INTO v_old_commission_split, v_old_row_version
    FROM customers WHERE id = v_customer_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_NOT_FOUND'; END IF;
    IF p_customer_payload ? 'default_commission_split_expected'
       AND p_customer_payload ? 'default_commission_split'
       AND COALESCE(v_old_commission_split, 'null'::jsonb) IS DISTINCT FROM COALESCE(p_customer_payload->'default_commission_split_expected', 'null'::jsonb)
       AND COALESCE(v_old_commission_split, 'null'::jsonb) IS DISTINCT FROM p_customer_payload->'default_commission_split' THEN
      RAISE EXCEPTION 'COMMISSION_SPLIT_CONFLICT: this customer''s default commission split was changed elsewhere after you opened it — reload the page and re-apply your change';
    END IF;

    IF NOT (p_customer_payload ? 'row_version_expected')
       OR jsonb_typeof(p_customer_payload->'row_version_expected') <> 'number'
       OR (p_customer_payload->>'row_version_expected') !~ '^(0|[1-9][0-9]*)$' THEN
      RAISE EXCEPTION 'CUSTOMER_STALE_WRITE: customer changed after this page opened — reload to review the current customer before saving';
    END IF;
    v_expected_row_version := (p_customer_payload->>'row_version_expected')::bigint;
    IF v_expected_row_version IS DISTINCT FROM v_old_row_version THEN
      RAISE EXCEPTION 'CUSTOMER_STALE_WRITE: customer changed after this page opened — reload to review the current customer before saving';
    END IF;

    UPDATE customers SET
      farm_name = COALESCE(p_customer_payload->>'farm_name', farm_name),
      contact_name = CASE WHEN p_customer_payload ? 'contact_name' THEN NULLIF(p_customer_payload->>'contact_name', '') ELSE contact_name END,
      phone = CASE WHEN p_customer_payload ? 'phone' THEN NULLIF(p_customer_payload->>'phone', '') ELSE phone END,
      email = CASE WHEN p_customer_payload ? 'email' THEN NULLIF(p_customer_payload->>'email', '') ELSE email END,
      billing_address = CASE WHEN p_customer_payload ? 'billing_address' THEN NULLIF(p_customer_payload->>'billing_address', '') ELSE billing_address END,
      assigned_tier = CASE WHEN p_customer_payload ? 'assigned_tier' THEN COALESCE((p_customer_payload->>'assigned_tier')::integer, 1) ELSE assigned_tier END,
      assigned_sales_rep = CASE WHEN p_customer_payload ? 'assigned_sales_rep' THEN (p_customer_payload->>'assigned_sales_rep')::uuid ELSE assigned_sales_rep END,
      total_acres = CASE WHEN p_customer_payload ? 'total_acres' THEN (p_customer_payload->>'total_acres')::numeric ELSE total_acres END,
      corn_acres = CASE WHEN p_customer_payload ? 'corn_acres' THEN (p_customer_payload->>'corn_acres')::numeric ELSE corn_acres END,
      soybean_acres = CASE WHEN p_customer_payload ? 'soybean_acres' THEN (p_customer_payload->>'soybean_acres')::numeric ELSE soybean_acres END,
      other_acres = CASE WHEN p_customer_payload ? 'other_acres' THEN (p_customer_payload->>'other_acres')::numeric ELSE other_acres END,
      payment_terms = CASE WHEN p_customer_payload ? 'payment_terms' THEN NULLIF(p_customer_payload->>'payment_terms', '') ELSE payment_terms END,
      default_commission_split = CASE WHEN p_customer_payload ? 'default_commission_split' THEN (p_customer_payload->'default_commission_split') ELSE default_commission_split END,
      notes = CASE WHEN p_customer_payload ? 'notes' THEN NULLIF(p_customer_payload->>'notes', '') ELSE notes END,
      is_active = COALESCE((p_customer_payload->>'is_active')::boolean, is_active),
      parent_customer_id = CASE WHEN p_customer_payload ? 'parent_customer_id' THEN (p_customer_payload->>'parent_customer_id')::uuid ELSE parent_customer_id END,
      credit_limit_cents = CASE WHEN p_customer_payload ? 'credit_limit_cents' THEN COALESCE((p_customer_payload->>'credit_limit_cents')::bigint, 0) ELSE credit_limit_cents END,
      finance_charge_rate = CASE WHEN p_customer_payload ? 'finance_charge_rate' THEN COALESCE((p_customer_payload->>'finance_charge_rate')::numeric, 0) ELSE finance_charge_rate END,
      finance_charge_enabled = CASE WHEN p_customer_payload ? 'finance_charge_enabled' THEN COALESCE((p_customer_payload->>'finance_charge_enabled')::boolean, true) ELSE finance_charge_enabled END,
      finance_charge_grace_days = CASE WHEN p_customer_payload ? 'finance_charge_grace_days' THEN COALESCE((p_customer_payload->>'finance_charge_grace_days')::integer, 0) ELSE finance_charge_grace_days END,
      default_application_service_id = CASE WHEN p_customer_payload ? 'default_application_service_id' THEN (p_customer_payload->>'default_application_service_id')::uuid ELSE default_application_service_id END,
      updated_at = now()
    WHERE id = v_customer_id;

    IF NOT FOUND THEN RAISE EXCEPTION 'CUSTOMER_NOT_FOUND'; END IF;

    SELECT array_agg((addr->>'id')::uuid) INTO v_incoming_ids
    FROM jsonb_array_elements(COALESCE(p_addresses, '[]'::jsonb)) AS addr
    WHERE addr->>'id' IS NOT NULL;

    DELETE FROM customer_addresses ca
    WHERE ca.customer_id = v_customer_id
      AND (v_incoming_ids IS NULL OR ca.id != ALL(v_incoming_ids))
      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.delivery_address_id = ca.id);
  END IF;

  IF p_addresses IS NOT NULL AND jsonb_array_length(p_addresses) > 0 THEN
    UPDATE customer_addresses ca SET
      label = COALESCE(addr->>'label', ''),
      address_line = NULLIF(addr->>'address_line', ''),
      city = NULLIF(addr->>'city', ''),
      state = NULLIF(addr->>'state', ''),
      zip = NULLIF(addr->>'zip', ''),
      delivery_notes = NULLIF(addr->>'delivery_notes', ''),
      is_default = COALESCE((addr->>'is_default')::boolean, false)
    FROM jsonb_array_elements(p_addresses) AS addr
    WHERE ca.id = (addr->>'id')::uuid AND ca.customer_id = v_customer_id;

    INSERT INTO customer_addresses (
      customer_id, label, address_line, city, state, zip, delivery_notes, is_default
    )
    SELECT
      v_customer_id,
      COALESCE(addr->>'label', ''),
      NULLIF(addr->>'address_line', ''),
      NULLIF(addr->>'city', ''),
      NULLIF(addr->>'state', ''),
      NULLIF(addr->>'zip', ''),
      NULLIF(addr->>'delivery_notes', ''),
      COALESCE((addr->>'is_default')::boolean, false)
    FROM jsonb_array_elements(p_addresses) AS addr
    WHERE addr->>'id' IS NULL
      AND (COALESCE(addr->>'label', '') != '' OR COALESCE(addr->>'address_line', '') != '');
  END IF;

  INSERT INTO activity_feed (
    event_type, description, performed_by,
    related_entity_type,
    related_entity_id,
    customer_id
  ) VALUES (
    CASE WHEN v_is_new THEN 'customer_created' ELSE 'customer_updated' END,
    CASE WHEN v_is_new
      THEN 'Customer ' || COALESCE(p_customer_payload->>'farm_name', '') || ' created'
      ELSE 'Customer ' || COALESCE(p_customer_payload->>'farm_name', '') || ' updated'
    END,
    v_actor, 'customer', v_customer_id, v_customer_id
  );

  v_result := jsonb_build_object(
    'status', 'saved',
    'customer_id', v_customer_id,
    '_request_fingerprint', v_request_fingerprint,
    'default_commission_split', (SELECT default_commission_split FROM customers WHERE id = v_customer_id),
    'row_version', (SELECT row_version FROM customers WHERE id = v_customer_id)
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'save_customer', v_result);
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.soft_delete_customer_document(p_document_id uuid, p_customer_id uuid, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_is_admin boolean;
  v_fingerprint text;
  v_replay jsonb;
  v_customer_id uuid;
  v_deleted_at timestamptz;
  v_result jsonb;
  v_helper_detail text;
BEGIN
  -- Who is calling. All of this runs BEFORE any receipt is looked at.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: Authentication required';
  END IF;

  -- Same predicates as is_admin() / is_sales_rep(): active profiles only.
  -- FOR SHARE holds off a concurrent deactivation or role change until this
  -- (permanent) removal has committed or rolled back.
  SELECT p.role = 'admin'
    INTO v_is_admin
    FROM public.profiles p
   WHERE p.id = v_actor
     AND p.role IN ('admin', 'sales_rep')
     AND p.is_active = true
     FOR SHARE;
  IF v_is_admin IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: Only active admins and sales reps can remove customer documents';
  END IF;

  IF p_idempotency_key IS NULL
     OR length(p_idempotency_key) > 255
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: soft_delete_customer_document requires a p_idempotency_key of at most 255 characters';
  END IF;

  IF p_document_id IS NULL OR p_customer_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
  END IF;

  -- The actor, the document AND its customer are the whole request. The
  -- customer is in the fingerprint as well as the WHERE clause, so the same
  -- key cannot be replayed against a different customer.
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'customer_id', p_customer_id,
    'document_id', p_document_id
  )::text, 'UTF8'), 'sha256'), 'hex');

  -- Takes pg_advisory_xact_lock on the key for the rest of this transaction
  -- and replays only a receipt bound to THIS actor and THIS document.
  -- The helper's IDEMPOTENCY_INTENT_MISMATCH carries the committed receipt in
  -- DETAIL. Here that receipt names an earlier document and customer the
  -- caller may no longer be allowed to see (a key reused on another document
  -- after a reassignment), so it is re-raised with the same message and
  -- SQLSTATE but no DETAIL. The page keys per document and never hits this.
  --
  -- The scrub is STRUCTURAL: no path below re-raises the helper's exception, so
  -- the DETAIL can never reach a client, and leak safety does NOT depend on the
  -- helper's message text. That is deliberate. An earlier revision of this
  -- round classified by message and called bare RAISE for the non-mismatch
  -- case; a later re-emit of the helper that renamed or prefixed its 22023
  -- message would then have leaked the receipt (rls-security-reviewer M1,
  -- 2026-09-23). The message is now used ONLY to pick which token to answer
  -- with, so a drifted message mislabels a fault and leaks nothing.
  --
  -- starts_with(), NOT LIKE: `_` is a LIKE single-character wildcard, so
  -- 'IDEMPOTENCY_INTENT_MISMATCH%' also matches 'IDEMPOTENCYxINTENTyMISMATCH'
  -- (measured on live 2026-09-23, both operators, same round).
  --
  -- Read from the live installed definition 2026-09-23: the helper's only 22023
  -- raises are its two IDEMPOTENCY_INTENT_MISMATCH branches, and
  -- IDEMPOTENCY_ACTOR_MISMATCH and IDEMPOTENCY_CROSS_OP_KEY_REUSE carry no
  -- ERRCODE (P0001), so the FAULT branch is unreachable today. The prover
  -- drives it anyway with a shadow helper, because a security branch no test
  -- can reach is a branch whose first execution is its first test.
  BEGIN
    v_replay := public.check_idempotency_intent(
      p_idempotency_key, 'soft_delete_customer_document', v_actor, v_fingerprint
    );
  EXCEPTION WHEN SQLSTATE '22023' THEN
    -- Keep the diagnostic on the SERVER side of the boundary, where it is not
    -- an oracle. Without this a real key collision leaves no record anywhere.
    GET STACKED DIAGNOSTICS v_helper_detail = PG_EXCEPTION_DETAIL;
    RAISE LOG 'soft_delete_customer_document: idempotency helper raised 22023 (%); detail: %',
      SQLERRM, coalesce(v_helper_detail, '(none)');
    IF starts_with(SQLERRM, 'IDEMPOTENCY_INTENT_MISMATCH') THEN
      RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH: This idempotency key was already used for a different request'
        USING ERRCODE = '22023';
    END IF;
    -- Any OTHER 22023 is an internal fault, not a client replay problem. A
    -- distinct token keeps the page from showing "we do not know whether your
    -- removal happened" for a failure that provably happened before the UPDATE.
    RAISE EXCEPTION 'IDEMPOTENCY_HELPER_FAULT: The idempotency check failed before anything was removed'
      USING ERRCODE = '22023';
  END;
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object'
       OR v_replay -> 'result' ->> 'customer_id' IS NULL
       OR v_replay -> 'result' ->> 'document_id' IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID: The stored receipt for this request is unusable';
    END IF;
    -- The fingerprint already binds BOTH ids, so these can only fail for a
    -- receipt written by an older version of this function or inserted by hand
    -- as postgres. Both are checked, not just the customer: a receipt naming
    -- another document would otherwise return a success envelope claiming that
    -- OTHER document was removed (migration-drift-reviewer L1, 2026-09-23).
    IF (v_replay -> 'result' ->> 'customer_id')::uuid IS DISTINCT FROM p_customer_id
       OR (v_replay -> 'result' ->> 'document_id')::uuid IS DISTINCT FROM p_document_id THEN
      RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
    END IF;
    -- Reps remove documents of ANY customer (Mason, 2026-10-13); the replay's
    -- assigned-rep re-check is removed by 20261013220000.
    RETURN v_replay -> 'result';
  END IF;

  -- One statement: find the active document and lock it (document FOR UPDATE,
  -- customer FOR SHARE). Reps remove documents of ANY customer (Mason,
  -- 2026-10-13; 20261013220000 removed the assignment test). Missing and
  -- removed are one error.
  SELECT d.customer_id
    INTO v_customer_id
    FROM public.customer_documents d
    JOIN public.customers c ON c.id = d.customer_id
   WHERE d.id = p_document_id
     AND d.customer_id = p_customer_id
     AND d.deleted_at IS NULL
     FOR UPDATE OF d
     FOR SHARE OF c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
  END IF;

  -- guard_customer_document_update still fires and requires deleted_by to be
  -- auth.uid(), which v_actor is.
  UPDATE public.customer_documents
     SET deleted_at = now(),
         deleted_by = v_actor
   WHERE id = p_document_id
     AND deleted_at IS NULL
  RETURNING deleted_at INTO v_deleted_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_DOCUMENT_NOT_FOUND: No active document you can remove was found';
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'document_id', p_document_id,
    'customer_id', v_customer_id,
    'deleted_at', v_deleted_at
  );

  -- The receipt, bound to the actor and the request. No row can exist for this
  -- key here: check_idempotency_intent returned NULL under the advisory lock.
  INSERT INTO public.idempotency_keys (
    idempotency_key, operation, result, request_actor_id, request_fingerprint
  ) VALUES (
    p_idempotency_key, 'soft_delete_customer_document', v_result, v_actor, v_fingerprint
  );

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.log_customer_fact(p_customer_id uuid, p_category text, p_fact_key text, p_value_text text DEFAULT NULL::text, p_value_json jsonb DEFAULT NULL::jsonb, p_confidence numeric DEFAULT NULL::numeric, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_save_verified boolean DEFAULT false, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_fact_id uuid;
  v_fact_key text;
  v_value_text text;
  v_status text;
  v_existing jsonb;
  v_result jsonb;
  v_fingerprint text;
BEGIN
  -- The idempotency key is REQUIRED: an omitted key would silently give the
  -- caller zero retry protection — the exact double-log this RPC exists to fix
  -- (pending_review facts have no unique index to catch the duplicate).
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'FACT_IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  -- Argument validation mirrors the customer_facts CHECK constraints so callers
  -- get stable machine-readable tokens instead of raw constraint errors. Every
  -- check below is deterministic on the arguments, so running them before the
  -- idempotency replay cannot reject a replay of a committed call. The one
  -- non-deterministic check — p_expires_at against now() — deliberately runs
  -- AFTER the replay return, or a committed call retried after a short expiry
  -- passed would error instead of replaying (the bug 20260716195012 fixed for
  -- supersede_customer_fact on this same table).
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_ID_REQUIRED';
  END IF;
  IF p_category IS NULL OR p_category NOT IN (
       'product_preference', 'constraint', 'operating_preference',
       'agronomy', 'relationship', 'communication') THEN
    RAISE EXCEPTION 'FACT_CATEGORY_INVALID';
  END IF;

  v_fact_key := lower(btrim(COALESCE(p_fact_key, '')));
  IF v_fact_key = '' OR v_fact_key !~ '^[a-z0-9]+(_[a-z0-9]+)*$' THEN
    RAISE EXCEPTION 'FACT_KEY_INVALID';
  END IF;

  v_value_text := CASE WHEN p_value_text IS NULL THEN NULL ELSE btrim(p_value_text) END;
  IF v_value_text = '' THEN
    v_value_text := NULL;
  END IF;
  -- customer_facts_value_check: exactly one of text/json, and text is nonblank.
  IF (v_value_text IS NULL) = (p_value_json IS NULL) THEN
    RAISE EXCEPTION 'FACT_VALUE_INVALID';
  END IF;
  IF p_value_json IS NOT NULL AND jsonb_typeof(p_value_json) NOT IN ('object', 'array') THEN
    RAISE EXCEPTION 'FACT_VALUE_INVALID';
  END IF;
  IF p_confidence IS NOT NULL AND (p_confidence < 0 OR p_confidence > 1) THEN
    RAISE EXCEPTION 'FACT_CONFIDENCE_INVALID';
  END IF;
  v_status := CASE WHEN COALESCE(p_save_verified, false) THEN 'verified' ELSE 'pending_review' END;

  IF NOT EXISTS (
       SELECT 1 FROM public.profiles p
       WHERE p.id = auth.uid() AND p.is_active
     )
     OR NOT (public.is_admin() OR (public.is_sales_rep() AND EXISTS (
       SELECT 1 FROM public.customers c
       WHERE c.id = p_customer_id
     ))) THEN
    RAISE EXCEPTION 'FACT_ACCESS_DENIED';
  END IF;

  -- Exact-request replay only (same rule as log_customer_interaction): a
  -- replayed key must carry the same payload, or the rep's edits between a
  -- lost-response commit and the retry would be silently discarded.
  v_fingerprint := md5(jsonb_build_object(
    'customer_id', p_customer_id,
    'category', p_category,
    'fact_key', v_fact_key,
    'value_text', v_value_text,
    'value_json', p_value_json,
    'confidence', p_confidence,
    'expires_at', CASE WHEN p_expires_at IS NULL THEN NULL
                  ELSE to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END,
    'status', v_status
  )::text);

  v_existing := public.check_idempotency(p_idempotency_key, 'log_customer_fact');
  IF v_existing IS NOT NULL THEN
    IF v_existing->>'request_fingerprint' IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'FACT_REPLAY_PAYLOAD_MISMATCH: this key already saved a fact with different values';
    END IF;
    RETURN v_existing;
  END IF;

  -- Non-deterministic (clock-dependent) check: must stay AFTER the replay
  -- return above — see the ordering note at the top of this function.
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'FACT_EXPIRY_INVALID';
  END IF;

  BEGIN
    INSERT INTO public.customer_facts (
      customer_id, category, fact_key, value_text, value_json, confidence,
      status, source, entered_by, reviewed_by, reviewed_at, expires_at
    ) VALUES (
      p_customer_id, p_category, v_fact_key, v_value_text, p_value_json, p_confidence,
      v_status, 'rep', auth.uid(),
      CASE WHEN v_status = 'verified' THEN auth.uid() END,
      CASE WHEN v_status = 'verified' THEN now() END,
      p_expires_at
    )
    RETURNING id INTO v_fact_id;
  EXCEPTION WHEN unique_violation THEN
    -- customer_facts_current_verified_key: one current verified fact per
    -- (customer, category, key). Correcting an existing one goes through
    -- supersede_customer_fact, so return a stable token the UI can explain.
    RAISE EXCEPTION 'FACT_DUPLICATE_CURRENT_VERIFIED: a current verified fact already exists for this category and key; correct it instead';
  END;

  v_result := jsonb_build_object(
    'success', true,
    'fact_id', v_fact_id,
    'status', v_status,
    'request_fingerprint', v_fingerprint
  );
  PERFORM public.save_idempotency(p_idempotency_key, 'log_customer_fact', v_result);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.review_customer_fact(p_fact_id uuid, p_verdict text, p_review_note text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_fact public.customer_facts%ROWTYPE;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF p_verdict NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'FACT_VERDICT_INVALID';
  END IF;

  SELECT * INTO v_fact FROM public.customer_facts WHERE id = p_fact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FACT_NOT_FOUND'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active)
     OR NOT (public.is_admin() OR (public.is_sales_rep() AND EXISTS (
       SELECT 1 FROM public.customers c
       WHERE c.id = v_fact.customer_id
     ))) THEN
    RAISE EXCEPTION 'FACT_ACCESS_DENIED';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'review_customer_fact');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  IF v_fact.status <> 'pending_review' THEN
    IF v_fact.status = p_verdict THEN
      v_result := jsonb_build_object('success', true, 'fact_id', v_fact.id, 'noop', true, 'status', v_fact.status);
    ELSE
      RAISE EXCEPTION 'FACT_ALREADY_REVIEWED';
    END IF;
  ELSE
    UPDATE public.customer_facts
    SET status = p_verdict, reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_review_note
    WHERE id = v_fact.id;
    v_result := jsonb_build_object('success', true, 'fact_id', v_fact.id, 'noop', false, 'status', p_verdict);
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'review_customer_fact', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.supersede_customer_fact(p_fact_id uuid, p_value_text text, p_value_json jsonb, p_confidence numeric, p_expires_at timestamp with time zone, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_fact public.customer_facts%ROWTYPE;
  v_new_fact_id uuid;
  v_existing jsonb;
  v_result jsonb;
BEGIN
  IF (p_value_text IS NULL) = (p_value_json IS NULL)
     OR (p_value_text IS NOT NULL AND btrim(p_value_text) = '')
     OR (p_value_json IS NOT NULL AND jsonb_typeof(p_value_json) NOT IN ('object', 'array'))
     OR (p_confidence IS NOT NULL AND p_confidence NOT BETWEEN 0 AND 1) THEN
    RAISE EXCEPTION 'FACT_VALUE_INVALID';
  END IF;

  SELECT * INTO v_fact FROM public.customer_facts WHERE id = p_fact_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'FACT_NOT_FOUND'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.is_active)
     OR NOT (public.is_admin() OR (public.is_sales_rep() AND EXISTS (
       SELECT 1 FROM public.customers c
       WHERE c.id = v_fact.customer_id
     ))) THEN
    RAISE EXCEPTION 'FACT_ACCESS_DENIED';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'supersede_customer_fact');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;
  -- Time-sensitive validation sits AFTER the idempotency replay (Codex r2): a committed call
  -- whose short expiry has since passed must replay its committed result on retry, not error.
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'FACT_EXPIRY_INVALID';
  END IF;
  IF v_fact.status <> 'verified' OR v_fact.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'FACT_NOT_CURRENT_VERIFIED';
  END IF;

  -- Three-step order: the self-FK on superseded_by is NOT deferrable, so the
  -- replacement row must exist before the old row can reference it — and the
  -- old row must leave the current-verified partial unique index before the
  -- replacement can enter it. (1) retire old, (2) insert new, (3) link.
  v_new_fact_id := gen_random_uuid();
  UPDATE public.customer_facts
  SET superseded_at = now()
  WHERE id = v_fact.id;

  INSERT INTO public.customer_facts (
    id,
    customer_id, category, fact_key, value_text, value_json, confidence,
    status, source, entered_by, reviewed_by, reviewed_at, expires_at
  ) VALUES (
    v_new_fact_id, v_fact.customer_id, v_fact.category, v_fact.fact_key, p_value_text, p_value_json, p_confidence,
    'verified', 'rep', auth.uid(), auth.uid(), now(), p_expires_at
  );

  UPDATE public.customer_facts
  SET superseded_by = v_new_fact_id
  WHERE id = v_fact.id;

  v_result := jsonb_build_object('success', true, 'fact_id', v_fact.id, 'replacement_fact_id', v_new_fact_id);
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'supersede_customer_fact', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.log_customer_interaction(p_customer_id uuid, p_interaction_type text, p_direction text, p_occurred_at timestamp with time zone, p_summary text, p_contact_id uuid DEFAULT NULL::uuid, p_duration_seconds integer DEFAULT NULL::integer, p_outcome text DEFAULT NULL::text, p_follow_up_title text DEFAULT NULL::text, p_follow_up_content text DEFAULT NULL::text, p_follow_up_assigned_to uuid DEFAULT NULL::uuid, p_follow_up_due_date date DEFAULT NULL::date, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_interaction_id uuid;
  v_note_id uuid;
  v_follow_up_error text;
  v_existing jsonb;
  v_result jsonb;
  v_fingerprint text;
BEGIN
  -- Argument validation mirrors the customer_interactions CHECK constraints so
  -- callers get stable machine-readable tokens instead of raw constraint
  -- errors. All checks are deterministic on the arguments, so running them
  -- before the idempotency replay cannot reject a replay of a committed call.
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'CUSTOMER_ID_REQUIRED';
  END IF;
  IF p_interaction_type IS NULL OR p_interaction_type NOT IN
     ('call', 'visit', 'meeting', 'text', 'email', 'voicemail') THEN
    RAISE EXCEPTION 'INTERACTION_TYPE_INVALID';
  END IF;
  IF p_direction IS NOT NULL AND p_direction NOT IN ('inbound', 'outbound') THEN
    RAISE EXCEPTION 'INTERACTION_DIRECTION_INVALID';
  END IF;
  IF p_occurred_at IS NULL THEN
    RAISE EXCEPTION 'INTERACTION_OCCURRED_AT_REQUIRED';
  END IF;
  IF p_summary IS NULL OR btrim(p_summary) = '' THEN
    RAISE EXCEPTION 'INTERACTION_SUMMARY_REQUIRED';
  END IF;
  IF p_duration_seconds IS NOT NULL AND p_duration_seconds < 0 THEN
    RAISE EXCEPTION 'INTERACTION_DURATION_INVALID';
  END IF;
  IF p_outcome IS NOT NULL AND p_outcome NOT IN
     ('connected', 'left_voicemail', 'no_answer', 'busy', 'follow_up_needed',
      'order_placed', 'resolved', 'other') THEN
    RAISE EXCEPTION 'INTERACTION_OUTCOME_INVALID';
  END IF;
  -- Follow-up fields are only meaningful with a title; fail closed rather than
  -- silently dropping an assignee or due date the caller thought was saved.
  IF p_follow_up_title IS NULL
     AND (p_follow_up_content IS NOT NULL
          OR p_follow_up_assigned_to IS NOT NULL
          OR p_follow_up_due_date IS NOT NULL) THEN
    RAISE EXCEPTION 'FOLLOW_UP_TITLE_REQUIRED';
  END IF;
  IF p_follow_up_title IS NOT NULL AND btrim(p_follow_up_title) = '' THEN
    RAISE EXCEPTION 'FOLLOW_UP_TITLE_REQUIRED';
  END IF;

  -- Authorization mirrors the customer_interactions rep INSERT policy: an
  -- active admin, or an active sales rep (any customer, Mason 2026-10-13). The row is
  -- always pinned to source = 'rep' and the caller's own identity below, so
  -- AI/web/system provenance is never writable through this path.
  IF NOT EXISTS (
       SELECT 1 FROM public.profiles p
       WHERE p.id = auth.uid() AND p.is_active
     )
     OR NOT (public.is_admin() OR (public.is_sales_rep() AND EXISTS (
       SELECT 1 FROM public.customers c
       WHERE c.id = p_customer_id
     ))) THEN
    RAISE EXCEPTION 'INTERACTION_ACCESS_DENIED';
  END IF;

  -- Same-customer contact check (the composite FK also enforces this; the
  -- explicit check returns a stable token instead of an FK error).
  IF p_contact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.customer_contacts cc
    WHERE cc.id = p_contact_id AND cc.customer_id = p_customer_id
  ) THEN
    RAISE EXCEPTION 'INTERACTION_CONTACT_INVALID';
  END IF;

  -- Exact-request replay only (Codex 2026-07-17, same pattern as the bulk-PO
  -- replay fix): a replayed key must carry the same payload. If the rep edited
  -- the form between a lost-response commit and the retry, silently returning
  -- the old result would discard the edits — raise instead so the UI can tell
  -- the rep the earlier attempt already saved.
  v_fingerprint := md5(jsonb_build_object(
    'customer_id', p_customer_id,
    'contact_id', p_contact_id,
    'interaction_type', p_interaction_type,
    'direction', p_direction,
    'occurred_at', to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'duration_seconds', p_duration_seconds,
    'outcome', p_outcome,
    'summary', btrim(p_summary),
    'follow_up_title', CASE WHEN p_follow_up_title IS NULL THEN NULL ELSE btrim(p_follow_up_title) END,
    'follow_up_content', p_follow_up_content,
    'follow_up_assigned_to', p_follow_up_assigned_to,
    'follow_up_due_date', p_follow_up_due_date
  )::text);

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := public.check_idempotency(p_idempotency_key, 'log_customer_interaction');
    IF v_existing IS NOT NULL THEN
      IF v_existing->>'request_fingerprint' IS DISTINCT FROM v_fingerprint THEN
        RAISE EXCEPTION 'INTERACTION_REPLAY_PAYLOAD_MISMATCH: this key already logged an interaction with different values';
      END IF;
      RETURN v_existing;
    END IF;
  END IF;

  INSERT INTO public.customer_interactions (
    customer_id, contact_id, interaction_type, direction, source,
    occurred_at, duration_seconds, outcome, summary,
    owner_user_id, created_by
  ) VALUES (
    p_customer_id, p_contact_id, p_interaction_type, p_direction, 'rep',
    p_occurred_at, p_duration_seconds, p_outcome, btrim(p_summary),
    auth.uid(), auth.uid()
  )
  RETURNING id INTO v_interaction_id;

  IF p_follow_up_title IS NOT NULL THEN
    -- Partial-success seam: the interaction is the record of truth. A failed
    -- follow-up insert (bad assignee, constraint change, ...) reports back in
    -- the result instead of rolling back the committed call log — the same
    -- behavior the modal had when these were two separate writes.
    BEGIN
      INSERT INTO public.team_notes (
        title, content, note_type, priority, assigned_to, due_date,
        created_by, linked_entity_type, linked_entity_id
      ) VALUES (
        btrim(p_follow_up_title), p_follow_up_content, 'todo', 'medium',
        p_follow_up_assigned_to, p_follow_up_due_date,
        auth.uid(), 'customer', p_customer_id
      )
      RETURNING id INTO v_note_id;
    EXCEPTION WHEN OTHERS THEN
      v_note_id := NULL;
      v_follow_up_error := SQLERRM;
    END;
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'interaction_id', v_interaction_id,
    'follow_up_requested', p_follow_up_title IS NOT NULL,
    'follow_up_note_id', v_note_id,
    'follow_up_error', v_follow_up_error,
    'request_fingerprint', v_fingerprint
  );
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM public.save_idempotency(p_idempotency_key, 'log_customer_interaction', v_result);
  END IF;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_prep_card(p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active
      AND (public.is_admin() OR (public.is_sales_rep() AND EXISTS (
        SELECT 1 FROM public.customers c
        WHERE c.id = p_customer_id
      )))
  ) THEN
    RAISE EXCEPTION 'PURCHASE_INTELLIGENCE_ACCESS_DENIED';
  END IF;

  RETURN (
    SELECT jsonb_build_object(
      'customer_id', c.id,
      'farm_name', c.farm_name,
      'contacts', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', cc.id, 'name', cc.name, 'role', cc.role,
          'phone_display', cc.phone_display, 'phone_e164', cc.phone_e164,
          'preferred_contact_method', cc.preferred_contact_method
        ) ORDER BY cc.is_primary DESC, cc.name)
        FROM public.customer_contacts cc
        WHERE cc.customer_id = c.id AND (cc.is_primary OR cc.is_active)
      ), '[]'::jsonb),
      'balance_credit', jsonb_build_object(
        'credit_limit_cents', COALESCE(c.credit_limit_cents, 0),
        'prepay_balance_cents', COALESCE(c.prepay_balance_cents, 0),
        'open_ar_cents', COALESCE((
          SELECT SUM(i.balance_cents)::bigint FROM public.invoices i
          WHERE i.customer_id = c.id AND i.deleted_at IS NULL
            AND i.status IN ('posted', 'overdue')
        ), 0)
      ),
      'last_invoice', (
        SELECT jsonb_build_object('date', i.invoice_date, 'total_cents', i.total_amount_cents)
        FROM public.invoices i
        WHERE i.customer_id = c.id AND i.deleted_at IS NULL
          AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
          AND i.status IN ('posted', 'paid', 'overdue')
        ORDER BY i.invoice_date DESC, i.created_at DESC LIMIT 1
      ),
      'last_interaction', (
        SELECT jsonb_build_object(
          'occurred_at', ci.occurred_at, 'type', ci.interaction_type,
          'outcome', ci.outcome, 'summary', ci.summary, 'contact_name', cc.name
        )
        FROM public.customer_interactions ci
        LEFT JOIN public.customer_contacts cc ON cc.id = ci.contact_id
        WHERE ci.customer_id = c.id
        ORDER BY ci.occurred_at DESC LIMIT 1
      ),
      'open_follow_ups_count', (
        SELECT COUNT(*) FROM public.team_notes tn
        WHERE tn.linked_entity_type = 'customer' AND tn.linked_entity_id = c.id
          AND tn.note_type = 'todo' AND NOT tn.is_completed AND tn.deleted_at IS NULL
      ),
      -- Open workflow counts (Sol amendment 8): what is in flight right now.
      'open_workflow_counts', jsonb_build_object(
        'quotes', (
          SELECT COUNT(*) FROM public.quotes q
          WHERE q.customer_id = c.id AND q.deleted_at IS NULL
            AND q.status IN ('draft', 'sent', 'revised')
        ),
        'orders', (
          SELECT COUNT(*) FROM public.orders o
          WHERE o.customer_id = c.id AND o.deleted_at IS NULL
            AND o.status IN ('confirmed', 'partially_fulfilled')
        ),
        'deliveries', (
          SELECT COUNT(*) FROM public.deliveries d
          WHERE d.customer_id = c.id AND d.deleted_at IS NULL
            AND d.status IN ('scheduled', 'in_progress')
        )
      ),
      'top_verified_facts', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'category', facts.category, 'fact_key', facts.fact_key,
          'value_text', facts.value_text, 'value_json', facts.value_json
        ) ORDER BY facts.reviewed_at DESC)
        FROM (
          SELECT cf.category, cf.fact_key, cf.value_text, cf.value_json, cf.reviewed_at
          FROM public.customer_facts cf
          WHERE cf.customer_id = c.id AND cf.status = 'verified'
            AND cf.superseded_at IS NULL AND (cf.expires_at IS NULL OR cf.expires_at > now())
          ORDER BY cf.reviewed_at DESC LIMIT 6
        ) facts
      ), '[]'::jsonb),
      -- ONLY addition vs the live 20260716182318 body: top products ranked by
      -- QUANTITY. Grouped per (product, unit) so a sum NEVER mixes units: a
      -- product invoiced in two units appears as two separate lines, each
      -- labeled with its own unit ("unit" is NULL when the invoice lines carry
      -- none -- the UI renders the quantity bare in that case). Units still
      -- differ ACROSS products (gal vs lb vs AC), so line magnitudes are not
      -- directly comparable -- the UI displays the unit on every line. Same
      -- invoice scope/filters/period as
      -- get_customer_purchase_summary.top_products (current season,
      -- posted|paid|overdue, non-credit, not-deleted, product lines only) and
      -- the same LIMIT 10.
      'top_products_by_quantity', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'product_id', ranked_qty.product_id,
          'product_name', ranked_qty.product_name,
          'total_quantity', ranked_qty.total_quantity,
          'unit', ranked_qty.unit
        ) ORDER BY ranked_qty.total_quantity DESC, ranked_qty.product_name, ranked_qty.unit, ranked_qty.product_id)
        FROM (
          SELECT
            ii.product_id AS product_id,
            p.product_name AS product_name,
            SUM(ii.quantity) AS total_quantity,
            -- Unit shown next to quantity on the invoice PDF line:
            -- invoice_items.unit_size, falling back to invoice_items.rate_unit.
            -- Part of the GROUP BY, so each output row is single-unit.
            COALESCE(NULLIF(ii.unit_size, ''), NULLIF(ii.rate_unit, '')) AS unit
          FROM public.invoices i
          JOIN public.invoice_items ii ON ii.invoice_id = i.id
          JOIN public.products p ON p.id = ii.product_id
          WHERE i.customer_id = c.id
            AND i.season = public.current_season()
            AND i.deleted_at IS NULL
            AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
            AND i.status IN ('posted', 'paid', 'overdue')
            -- Products only: service-fee / misc lines have no product_id and
            -- must not rank in "top products".
            AND ii.product_id IS NOT NULL
          GROUP BY ii.product_id, p.product_name,
            COALESCE(NULLIF(ii.unit_size, ''), NULLIF(ii.rate_unit, ''))
          ORDER BY SUM(ii.quantity) DESC, p.product_name,
            COALESCE(NULLIF(ii.unit_size, ''), NULLIF(ii.rate_unit, '')),
            ii.product_id
          LIMIT 10
        ) ranked_qty
      ), '[]'::jsonb),
      'acres_tier', jsonb_build_object(
        'total_acres', c.total_acres, 'corn_acres', c.corn_acres,
        'soybean_acres', c.soybean_acres, 'other_acres', c.other_acres,
        'assigned_tier', c.assigned_tier
      )
    )
    FROM public.customers c WHERE c.id = p_customer_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_lapsed_products(p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_season integer := public.current_season();
  v_last_season integer := v_season - 1;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.is_active
      AND (public.is_admin() OR (public.is_sales_rep() AND EXISTS (
        SELECT 1 FROM public.customers c
        WHERE c.id = p_customer_id
      )))
  ) THEN
    RAISE EXCEPTION 'PURCHASE_INTELLIGENCE_ACCESS_DENIED';
  END IF;

  RETURN jsonb_build_object(
    'season', v_season::text,
    'last_season', v_last_season::text,
    'products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'product_name', lapsed.product_name,
        'last_season_qty', lapsed.last_season_qty,
        'last_season_revenue_cents', lapsed.last_season_revenue_cents
      ) ORDER BY lapsed.last_season_revenue_cents DESC, lapsed.product_name)
      FROM (
        SELECT
          ii.product_id,
          COALESCE(p.product_name, ii.description) AS product_name,
          SUM(ii.quantity) AS last_season_qty,
          SUM(ii.extended_cents)::bigint AS last_season_revenue_cents
        FROM public.invoices i
        JOIN public.invoice_items ii ON ii.invoice_id = i.id
        LEFT JOIN public.products p ON p.id = ii.product_id
        WHERE i.customer_id = p_customer_id
          AND i.season = v_last_season
          AND i.deleted_at IS NULL
          AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
          AND i.status IN ('posted', 'paid', 'overdue')
          AND ii.product_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM public.invoices current_invoice
            JOIN public.invoice_items current_item ON current_item.invoice_id = current_invoice.id
            WHERE current_invoice.customer_id = p_customer_id
              AND current_invoice.season = v_season
              AND current_invoice.deleted_at IS NULL
              AND COALESCE(current_invoice.invoice_type, 'invoice') <> 'credit_memo'
              AND current_invoice.status IN ('posted', 'paid', 'overdue')
              AND current_item.product_id = ii.product_id
          )
        GROUP BY ii.product_id, COALESCE(p.product_name, ii.description)
      ) lapsed
    ), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_customer_purchase_summary(p_customer_id uuid, p_season text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_season integer := COALESCE(p_season::integer, public.current_season());
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.is_active
      AND (
        public.is_admin()
        OR (
          public.is_sales_rep()
          AND EXISTS (
            SELECT 1 FROM public.customers c
            WHERE c.id = p_customer_id
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'PURCHASE_INTELLIGENCE_ACCESS_DENIED';
  END IF;

  RETURN jsonb_build_object(
    'season', v_season::text,
    'total_invoiced_cents', COALESCE((
      SELECT SUM(i.total_amount_cents)::bigint
      FROM public.invoices i
      WHERE i.customer_id = p_customer_id
        AND i.season = v_season
        AND i.deleted_at IS NULL
        AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
        AND i.status IN ('posted', 'paid', 'overdue')
    ), 0),
    'invoice_count', (
      SELECT COUNT(*)
      FROM public.invoices i
      WHERE i.customer_id = p_customer_id
        AND i.season = v_season
        AND i.deleted_at IS NULL
        AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
        AND i.status IN ('posted', 'paid', 'overdue')
    ),
    'top_products', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'product_name', ranked.product_name,
        'total_qty', ranked.total_qty,
        'total_revenue_cents', ranked.total_revenue_cents
      ) ORDER BY ranked.total_revenue_cents DESC, ranked.product_name)
      FROM (
        SELECT
          p.product_name AS product_name,
          SUM(ii.quantity) AS total_qty,
          SUM(ii.extended_cents)::bigint AS total_revenue_cents
        FROM public.invoices i
        JOIN public.invoice_items ii ON ii.invoice_id = i.id
        JOIN public.products p ON p.id = ii.product_id
        WHERE i.customer_id = p_customer_id
          AND i.season = v_season
          AND i.deleted_at IS NULL
          AND COALESCE(i.invoice_type, 'invoice') <> 'credit_memo'
          AND i.status IN ('posted', 'paid', 'overdue')
          -- Products only: service-fee / misc lines have no product_id and
          -- must not rank in "top products".
          AND ii.product_id IS NOT NULL
        GROUP BY ii.product_id, p.product_name
        ORDER BY SUM(ii.extended_cents) DESC, p.product_name
        LIMIT 10
      ) ranked
    ), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_dispatch_board_jobs(p_applicator_id uuid, p_status text DEFAULT NULL::text, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date)
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- A dispatch row is VISIBLE to the caller (mirrors job_location_dispatches_select):
  --   admin/sales see all; the job's whole-job applicator sees every row on their job;
  --   otherwise a field user sees a row where they are the assignee or an active member
  --   of the assigned active crew.
  WITH matched AS (
    SELECT j.*
      FROM public.jobs j
     WHERE j.deleted_at IS NULL
       AND p_applicator_id IS NOT NULL
       AND (p_status IS NULL OR j.status = p_status)
       AND (p_start_date IS NULL OR j.job_date >= p_start_date)
       AND (p_end_date IS NULL OR j.job_date <= p_end_date)
       AND (
         -- (a) a CURRENT per-location dispatch to this applicator the CALLER can see
         EXISTS (
           SELECT 1 FROM public.job_location_dispatches d
            WHERE d.job_id = j.id
              AND d.dispatch_status = 'dispatched'
              AND d.applicator_id = p_applicator_id
              AND (
                is_admin()
                OR is_sales_rep()
                OR (is_applicator() AND j.applicator_id = (select auth.uid()))
                OR d.applicator_id = (select auth.uid())
              )
         )
         OR (
           -- (b) whole-job applicator = this one AND the job has NO per-location dispatch
           j.applicator_id = p_applicator_id
           AND NOT EXISTS (
             SELECT 1 FROM public.job_location_dispatches d2
              WHERE d2.job_id = j.id
                AND d2.dispatch_status = 'dispatched'
           )
         )
       )
       -- VISIBILITY GATE — the live jobs SELECT predicate. Never return a hidden job.
       AND (
         is_admin()
         OR is_sales_rep()
         OR (is_applicator() AND j.applicator_id = (select auth.uid()))
         OR public._is_dispatched_to_me(j.id)
       )
     ORDER BY j.job_date DESC NULLS LAST
     LIMIT 500
  )
  SELECT
    to_jsonb(m)
    || jsonb_build_object(
         -- CUSTOMER NAME — RLS-equivalent (Codex re-review-3 P2): this function is
         -- SECURITY DEFINER, so a raw `customers` read would bypass customers_select and
         -- could leak a farm_name the caller can't otherwise see (a sales_rep is limited
         -- to assigned customers; an applicator/driver to a time-windowed set). Return the
         -- name ONLY when the caller would pass customers_select OR
         -- customers_select_location_dispatchee for THIS job's customer; else farm_name
         -- is null (the board renders 'Unknown', exactly as the unfiltered RLS embed would).
         'customer',
         (SELECT jsonb_build_object(
                   'farm_name',
                   CASE WHEN (
                     is_admin()
                     OR is_sales_rep()  -- any customer since 20261013220000 (Mason, 2026-10-13)
                     OR (is_driver() AND EXISTS (
                           SELECT 1 FROM public.deliveries d
                            WHERE d.customer_id = c.id
                              AND d.assigned_driver = (select auth.uid())
                              AND d.scheduled_date >= (CURRENT_DATE - interval '1 day')))
                     OR (is_applicator() AND EXISTS (
                           SELECT 1 FROM public.jobs j2
                            WHERE j2.customer_id = c.id
                              AND j2.applicator_id = (select auth.uid())
                              AND j2.job_date >= (CURRENT_DATE - interval '7 days')))
                     OR EXISTS (
                           SELECT 1 FROM public.jobs j3
                            WHERE j3.customer_id = c.id
                              AND public._is_dispatched_to_me(j3.id))
                   ) THEN c.farm_name ELSE NULL END)
            FROM public.customers c WHERE c.id = m.customer_id),
         -- JOB_FIELDS — job_fields_select is satisfied for every job that passed this
         -- function's visibility gate (admin/sales_rep/whole-job applicator/_is_dispatched_to_me
         -- are exactly its conditions), so listing the rows leaks nothing. field_name is
         -- gated to the fields_select predicate (admin/sales_rep/applicator) so a dispatched
         -- crew member whose role is NOT applicator doesn't get a field name they couldn't
         -- read under RLS (null → the board falls back to 'Field'). (Codex re-review-3 P2.)
         'job_fields',
         coalesce((
           SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', jf.id,
                      'field_id', jf.field_id,
                      'acres_to_treat', jf.acres_to_treat,
                      'sort_order', jf.sort_order,
                      'field', jsonb_build_object(
                        'id', f.id,
                        'field_name', CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                                           THEN f.field_name ELSE NULL END)
                    ) ORDER BY jf.sort_order
                  )
             FROM public.job_fields jf
             JOIN public.fields f ON f.id = jf.field_id
            WHERE jf.job_id = m.id
         ), '[]'::jsonb),
         -- per-location dispatch rows the CALLER can see, for client-side label aggregation
         '_dispatches',
         coalesce((
           SELECT jsonb_agg(jsonb_build_object('applicator_id', d.applicator_id, 'crew_id', d.crew_id))
             FROM public.job_location_dispatches d
            WHERE d.job_id = m.id
              AND d.dispatch_status = 'dispatched'
              AND (
                is_admin()
                OR is_sales_rep()
                OR (is_applicator() AND m.applicator_id = (select auth.uid()))
                OR d.applicator_id = (select auth.uid())
                OR (
                  d.crew_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM public.ground_crew_members gcm
                      JOIN public.ground_crews gc ON gc.id = gcm.crew_id
                     WHERE gcm.crew_id = d.crew_id
                       AND gcm.profile_id = (select auth.uid())
                       AND gcm.is_active
                       AND gc.is_active
                  )
                )
              )
         ), '[]'::jsonb)
       )
    FROM matched m;
$function$;

CREATE OR REPLACE FUNCTION public.get_dispatched_list(p_applicator_id uuid DEFAULT NULL::uuid, p_crew_id uuid DEFAULT NULL::uuid)
 RETURNS SETOF jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'dispatch_id',     d.id,
    'job_field_id',    d.job_field_id,
    'job_id',          d.job_id,
    'job_number',      j.job_number,
    'job_status',      j.status,
    -- U12 addition: the job's scheduled date, so the FieldView card shows it
    -- and can sort Today-first / group a Done section without an extra fetch.
    'job_date',        j.job_date,
    -- U12 addition (Codex R1 P1): the underlying fields.id, so the FieldView
    -- completion form can send per-field applied acres keyed by the REAL field id
    -- (job_field_id is the join-row id — application_record_fields.field_id
    -- references fields.id, so the client needs this to build 'field_acres').
    -- Gated to the same role set as field_name (RLS R2 M3): the only consumer
    -- (the completion form) requires is_applicator() anyway, and a dispatched
    -- non-applicator crew member shouldn't get a dereferenceable fields.id when
    -- field_name is deliberately withheld from them.
    'field_id',        CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                            THEN jf.field_id ELSE NULL END,
    'dispatch_status', d.dispatch_status,
    'dispatched_at',   d.dispatched_at,
    'assignee_kind',   CASE WHEN d.applicator_id IS NOT NULL THEN 'applicator' ELSE 'crew' END,
    'applicator_id',   d.applicator_id,
    'crew_id',         d.crew_id,
    -- assignee NAME resolved server-side. field_name gated to the fields_select roles
    -- (admin/sales_rep/applicator) so a dispatched crew member whose role is not
    -- applicator never receives a field name they couldn't read under RLS (null ->
    -- the client falls back to 'Field'). Customer name gated likewise.
    'assignee_name',   CASE WHEN d.applicator_id IS NOT NULL
                            THEN (SELECT p.full_name FROM profiles p WHERE p.id = d.applicator_id)
                            ELSE (SELECT g.name FROM ground_crews g WHERE g.id = d.crew_id) END,
    'field_name',      CASE WHEN (is_admin() OR is_sales_rep() OR is_applicator())
                            THEN (SELECT f.field_name FROM fields f WHERE f.id = jf.field_id)
                            ELSE NULL END,
    'customer_name',   CASE WHEN (
                              is_admin()
                              OR is_sales_rep()  -- any customer since 20261013220000 (Mason, 2026-10-13)
                              OR (is_applicator() AND EXISTS (
                                    SELECT 1 FROM public.jobs j2
                                     WHERE j2.customer_id = c.id
                                       AND j2.applicator_id = (select auth.uid())
                                       AND j2.job_date >= (CURRENT_DATE - interval '7 days')))
                              OR EXISTS (
                                    SELECT 1 FROM public.jobs j3
                                     WHERE j3.customer_id = c.id
                                       AND public._is_dispatched_to_me(j3.id))
                            ) THEN c.farm_name ELSE NULL END,
    'location_acres',  jf.acres_to_treat,
    'job_applied_acres', j.applied_acres,
    'job_total_acres',   j.total_acres
  )
    FROM public.job_location_dispatches d
    JOIN public.jobs j        ON j.id = d.job_id AND j.deleted_at IS NULL
    JOIN public.job_fields jf ON jf.id = d.job_field_id
    JOIN public.customers c   ON c.id = j.customer_id
   WHERE (
       d.dispatch_status = 'dispatched'
       -- A1: also return RECENTLY-completed dispatch rows (the job-terminal trigger
       -- flips rows to 'completed' when the job completes) so a just-finished job
       -- moves to the FieldView "Done" section instead of vanishing. 7-day window
       -- bounds the tail; 'cancelled' rows stay EXCLUDED — an undispatched
       -- applicator must not keep seeing the job (undispatch_job_locations also
       -- writes 'cancelled').
       OR (d.dispatch_status = 'completed' AND d.updated_at >= now() - interval '7 days')
     )
     AND (p_applicator_id IS NULL OR d.applicator_id = p_applicator_id)
     AND (p_crew_id IS NULL OR d.crew_id = p_crew_id)
     -- VISIBILITY GATE — mirrors job_location_dispatches_select, with ONE deliberate
     -- A1 relaxation: the table policy's assignee/crew branches require
     -- dispatch_status='dispatched', but this gate intentionally does NOT — otherwise
     -- a per-location assignee's just-completed rows would never reach their Done
     -- section (the whole point of the 7-day completed tail). The rows are still
     -- bounded to the caller's OWN dispatches (or their active crew's) — data they
     -- could already read while the row was 'dispatched'. is_admin()/is_sales_rep()/
     -- is_applicator() each re-check profiles.is_active internally, BUT the bare
     -- `applicator_id = auth.uid()` and crew-member branches must ALSO re-check is_active
     -- — this is a SECURITY DEFINER read that bypasses RLS, so without the re-check a
     -- DEACTIVATED user with a still-valid token would keep seeing their dispatch rows
     -- (the #36 policy includes this active-profile guard for exactly this reason —
     -- Codex #37 P1).
     AND (
       is_admin()
       OR is_sales_rep()
       OR (is_applicator() AND j.applicator_id = (select auth.uid()))
       OR (
         d.applicator_id = (select auth.uid())
         AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
       )
       OR (
         d.crew_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.is_active)
         AND EXISTS (
           SELECT 1 FROM public.ground_crew_members gcm
             JOIN public.ground_crews gc ON gc.id = gcm.crew_id
            WHERE gcm.crew_id = d.crew_id
              AND gcm.profile_id = (select auth.uid())
              AND gcm.is_active
              AND gc.is_active
         )
       )
     )
   -- d.id is the UNIQUE tiebreaker that makes this a TOTAL order — without it two
   -- same-job/same-transaction rows (equal dispatched_at) can be skipped/duplicated
   -- across a .range() page boundary (Codex #37 follow-up LOW).
   ORDER BY j.job_number, d.dispatched_at DESC, d.id;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 2. POLICIES. Only the assigned-rep condition is removed; names, commands and roles stay, and
--    every other condition is copied from the live expression (2026-10-13).

-- customers: reps read and edit every customer (reassignment and the commission split are
-- guarded by the trigger in section 3). customers_insert (self-assign) is unchanged.
ALTER POLICY customers_select ON public.customers
  USING (
    is_admin()
    OR is_sales_rep()
    OR (is_driver() AND (EXISTS (
      SELECT 1 FROM public.deliveries d
       WHERE d.customer_id = customers.id
         AND d.assigned_driver = (SELECT auth.uid() AS uid)
         AND d.scheduled_date >= (CURRENT_DATE - '1 day'::interval))))
    OR (is_applicator() AND (EXISTS (
      SELECT 1 FROM public.jobs j
       WHERE j.customer_id = customers.id
         AND j.applicator_id = (SELECT auth.uid() AS uid)
         AND j.job_date >= (CURRENT_DATE - '7 days'::interval))))
  );
ALTER POLICY customers_update ON public.customers
  USING (is_admin() OR is_sales_rep())
  WITH CHECK (is_admin() OR is_sales_rep());

-- customer_addresses
ALTER POLICY addresses_insert ON public.customer_addresses
  WITH CHECK (is_admin() OR is_sales_rep());
ALTER POLICY addresses_update ON public.customer_addresses
  USING (is_admin() OR is_sales_rep())
  WITH CHECK (is_admin() OR is_sales_rep());

-- customer_contacts
ALTER POLICY customer_contacts_select ON public.customer_contacts
  USING (is_admin() OR is_sales_rep());
ALTER POLICY customer_contacts_insert ON public.customer_contacts
  WITH CHECK (is_admin() OR is_sales_rep());
ALTER POLICY customer_contacts_update ON public.customer_contacts
  USING (is_admin() OR is_sales_rep())
  WITH CHECK (is_admin() OR is_sales_rep());

-- customer_documents (the rep policies; the admin policies are unchanged)
ALTER POLICY customer_documents_rep_select ON public.customer_documents
  USING (is_sales_rep() AND deleted_at IS NULL);
ALTER POLICY customer_documents_rep_insert ON public.customer_documents
  WITH CHECK (
    is_sales_rep()
    AND uploaded_by = (SELECT auth.uid() AS uid)
    AND source = 'rep'::text
    AND deleted_at IS NULL
    AND deleted_by IS NULL
  );
ALTER POLICY customer_documents_rep_update ON public.customer_documents
  USING (is_sales_rep() AND deleted_at IS NULL)
  WITH CHECK (is_sales_rep());

-- customer_facts (the rep policies)
ALTER POLICY customer_facts_rep_select ON public.customer_facts
  USING (is_sales_rep());
ALTER POLICY customer_facts_rep_insert ON public.customer_facts
  WITH CHECK (
    is_sales_rep()
    AND source = 'rep'::text
    AND entered_by = (SELECT auth.uid() AS uid)
    AND (status = 'pending_review'::text
         OR (status = 'verified'::text
             AND reviewed_by = (SELECT auth.uid() AS uid)
             AND reviewed_at IS NOT NULL))
    AND superseded_at IS NULL
    AND superseded_by IS NULL
  );

-- customer_interactions and interaction_transcripts (the rep policies)
ALTER POLICY customer_interactions_rep_select ON public.customer_interactions
  USING (is_sales_rep());
ALTER POLICY customer_interactions_rep_insert ON public.customer_interactions
  WITH CHECK (
    is_sales_rep()
    AND created_by = (SELECT auth.uid() AS uid)
    AND source = 'rep'::text
    AND provider IS NULL
  );
ALTER POLICY customer_interactions_rep_update ON public.customer_interactions
  USING (is_sales_rep())
  WITH CHECK (
    is_sales_rep()
    AND (created_by = (SELECT auth.uid() AS uid) OR created_by IS NULL)
  );
ALTER POLICY interaction_transcripts_rep_select ON public.interaction_transcripts
  USING (
    is_sales_rep()
    AND EXISTS (
      SELECT 1 FROM public.customer_interactions ci
       WHERE ci.id = interaction_transcripts.interaction_id)
  );

-- external_identities
ALTER POLICY external_identities_select ON public.external_identities
  USING (is_admin() OR is_sales_rep());
ALTER POLICY external_identities_insert ON public.external_identities
  WITH CHECK (is_admin() OR (is_sales_rep() AND verified_at IS NULL AND verified_by IS NULL));
ALTER POLICY external_identities_update ON public.external_identities
  USING (is_admin() OR (is_sales_rep() AND verified_at IS NULL AND verified_by IS NULL))
  WITH CHECK (is_admin() OR (is_sales_rep() AND verified_at IS NULL AND verified_by IS NULL));

-- ---------------------------------------------------------------------------------------------
-- 3. What stays narrower for an active sales rep (who is not an admin) on a customer row, on
--    every path that reaches customers (save_customer runs as its owner, so the trigger covers
--    it too; its own REP_CANNOT_REASSIGN test answers first):
--      a. assigned_sales_rep never changes (REP_CANNOT_REASSIGN);
--      b. default_commission_split changes only on a customer assigned to the rep
--         (COMMISSION_SPLIT_ADMIN_OR_ASSIGNED_REP);
--      c. a customer with an open (posted or overdue) invoice is not deactivated
--         (CUSTOMER_HAS_OPEN_INVOICES; the Customers page checked this only in React, against the
--         invoices the rep can read);
--      d. prepay_balance_cents changes only through the server's prepay and payment functions,
--         never by a direct table UPDATE from the browser, and a customer the rep INSERTs directly
--         starts at 0 (PREPAY_BALANCE_SERVER_ONLY). Those
--         functions are SECURITY DEFINER, so inside them current_user is their owner; a direct
--         PostgREST UPDATE runs as authenticated. This trigger function is deliberately NOT
--         SECURITY DEFINER, so current_user still names the caller's role here.
--    Admins, service-side callers with no auth.uid() and every non-rep role pass through untouched.
--    _customer_has_open_invoice_20261013 is the definer-rights read behind (c): under the rep's
--    own rights invoices_select would hide other reps' and admins' invoices.
CREATE OR REPLACE FUNCTION public._customer_has_open_invoice_20261013(p_customer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $open$
  SELECT (public.is_admin() OR public.is_sales_rep())
     AND EXISTS (
       SELECT 1 FROM public.invoices i
        WHERE i.customer_id = p_customer_id
          AND i.status IN ('posted', 'overdue')
          AND i.deleted_at IS NULL
     );
$open$;
REVOKE ALL ON FUNCTION public._customer_has_open_invoice_20261013(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._customer_has_open_invoice_20261013(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_customer_rep_edit_20261013()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $guard$
BEGIN
  IF public.is_admin() OR NOT public.is_sales_rep() THEN
    RETURN NEW;
  END IF;
  -- A customer a rep creates directly starts with no prepay balance (prepayments add it later).
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.prepay_balance_cents, 0) <> 0 AND current_user = 'authenticated' THEN
      RAISE EXCEPTION 'PREPAY_BALANCE_SERVER_ONLY: a prepay balance changes only through prepayments and payments';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.assigned_sales_rep IS DISTINCT FROM OLD.assigned_sales_rep THEN
    RAISE EXCEPTION 'REP_CANNOT_REASSIGN';
  END IF;
  -- Compared after canonical recipient stamping on both sides, so a rep re-saving a split they
  -- did not change (with or without stamped recipient ids) is never refused.
  -- SQL NULL and JSON null both mean "no split".
  IF COALESCE(NEW.default_commission_split, 'null'::jsonb) IS DISTINCT FROM COALESCE(OLD.default_commission_split, 'null'::jsonb)
     AND OLD.assigned_sales_rep IS DISTINCT FROM (SELECT auth.uid())
     AND COALESCE(public.commission_split_with_recipient_ids(NEW.default_commission_split), 'null'::jsonb)
         IS DISTINCT FROM COALESCE(public.commission_split_with_recipient_ids(OLD.default_commission_split), 'null'::jsonb) THEN
    RAISE EXCEPTION 'COMMISSION_SPLIT_ADMIN_OR_ASSIGNED_REP: only an admin or this customer''s assigned sales rep can change its default commission split';
  END IF;
  IF OLD.is_active IS TRUE AND NEW.is_active IS NOT TRUE
     AND public._customer_has_open_invoice_20261013(OLD.id) THEN
    RAISE EXCEPTION 'CUSTOMER_HAS_OPEN_INVOICES: this customer has posted or overdue invoices; resolve them before deactivating it';
  END IF;
  IF NEW.prepay_balance_cents IS DISTINCT FROM OLD.prepay_balance_cents
     AND current_user = 'authenticated' THEN
    RAISE EXCEPTION 'PREPAY_BALANCE_SERVER_ONLY: a prepay balance changes only through prepayments and payments';
  END IF;
  RETURN NEW;
END;
$guard$;
REVOKE ALL ON FUNCTION public.guard_customer_rep_edit_20261013() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER customers_guard_rep_edit_20261013
  BEFORE INSERT OR UPDATE OF assigned_sales_rep, default_commission_split, is_active, prepay_balance_cents
  ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.guard_customer_rep_edit_20261013();

-- ---------------------------------------------------------------------------------------------
-- 4. POSTFLIGHT.
DO $postflight$
DECLARE
  v_sig text;
  v_src text;
  v_row record;
BEGIN
  FOREACH v_sig IN ARRAY ARRAY[
    'public._save_invoice_split_provenance_impl_20260719(jsonb,jsonb,text)',
    'public._save_invoice_below_cost_impl_20260810(jsonb,jsonb,text)',
    'public._post_invoice_public_impl_20260718(uuid,text)',
    'public.post_invoice_group(uuid,uuid,text)',
    'public._save_field_app_split_invoice_impl(uuid,uuid,jsonb,jsonb,jsonb,uuid,uuid,text,text)',
    'public.resolve_line_split_vector(uuid[],uuid,jsonb)',
    'public.get_customer_statement(uuid,date,date)',
    'public.get_customer_year_end_summary(uuid,integer)',
    'public.get_customer_balance_listing(date)',
    'public.soft_delete_customer_document(uuid,uuid,text)',
    'public.log_customer_fact(uuid,text,text,text,jsonb,numeric,timestamp with time zone,boolean,text)',
    'public.review_customer_fact(uuid,text,text,text)',
    'public.supersede_customer_fact(uuid,text,jsonb,numeric,timestamp with time zone,text)',
    'public.log_customer_interaction(uuid,text,text,timestamp with time zone,text,uuid,integer,text,text,text,uuid,date,text)',
    'public.get_customer_prep_card(uuid)',
    'public.get_customer_lapsed_products(uuid)',
    'public.get_customer_purchase_summary(uuid,text)',
    'public.get_dispatch_board_jobs(uuid,text,date,date)',
    'public.get_dispatched_list(uuid,uuid)'
  ] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = to_regprocedure(v_sig);
    IF v_src IS NULL THEN
      RAISE EXCEPTION 'REPS_ANY_CUSTOMER_POSTFLIGHT: % is missing', v_sig;
    END IF;
    IF v_src ~* 'assigned_sales_rep' THEN
      RAISE EXCEPTION 'REPS_ANY_CUSTOMER_POSTFLIGHT: % still names assigned_sales_rep', v_sig;
    END IF;
  END LOOP;
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.save_customer(uuid,jsonb,jsonb,uuid,text)'))
     ~ 'NOT_CUSTOMER_OWNER' THEN
    RAISE EXCEPTION 'REPS_ANY_CUSTOMER_POSTFLIGHT: save_customer still raises NOT_CUSTOMER_OWNER';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.save_customer(uuid,jsonb,jsonb,uuid,text)'))
       !~ 'REP_CANNOT_REASSIGN'
     OR (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.save_customer(uuid,jsonb,jsonb,uuid,text)'))
       !~ 'REP_MUST_SELF_ASSIGN' THEN
    RAISE EXCEPTION 'REPS_ANY_CUSTOMER_POSTFLIGHT: save_customer lost REP_CANNOT_REASSIGN or REP_MUST_SELF_ASSIGN';
  END IF;

  -- Every replaced function keeps the owner, grants, SECURITY DEFINER and search_path recorded by
  -- the preflight.
  IF (SELECT count(*) FROM pg_temp.reps_any_customer_security_20261013) <> 20 OR EXISTS (
    SELECT 1 FROM pg_temp.reps_any_customer_security_20261013 b
      LEFT JOIN pg_proc p ON p.oid = b.fn
     WHERE p.oid IS NULL
        OR p.proowner IS DISTINCT FROM b.owner OR p.proacl::text IS DISTINCT FROM b.acl
        OR p.prosecdef IS DISTINCT FROM b.secdef OR p.proconfig IS DISTINCT FROM b.config
        OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'REPS_ANY_CUSTOMER_POSTFLIGHT: a replaced function changed owner, grants or security';
  END IF;

  -- No widened policy still names assigned_sales_rep; customers_insert (self-assign) still does.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('customers', 'customer_addresses', 'customer_contacts', 'customer_documents',
                         'customer_facts', 'customer_interactions', 'interaction_transcripts',
                         'external_identities')
       AND policyname <> 'customers_insert'
       AND (coalesce(qual, '') || coalesce(with_check, '')) ~ 'assigned_sales_rep'
  ) THEN
    RAISE EXCEPTION 'REPS_ANY_CUSTOMER_POSTFLIGHT: a widened policy still tests assigned_sales_rep';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_insert'
       AND with_check ~ 'assigned_sales_rep'
  ) THEN
    RAISE EXCEPTION 'REPS_ANY_CUSTOMER_POSTFLIGHT: customers_insert lost its self-assign rule';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'customers' AND policyname = 'customers_select'
       AND qual ~ 'is_driver\(\)' AND qual ~ 'is_applicator\(\)'
  ) THEN
    RAISE EXCEPTION 'REPS_ANY_CUSTOMER_POSTFLIGHT: customers_select lost its driver or applicator leg';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.customers'::regclass
       AND tgname = 'customers_guard_rep_edit_20261013'
       AND tgenabled = 'O'
       AND tgfoid = 'public.guard_customer_rep_edit_20261013()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'REPS_ANY_CUSTOMER_POSTFLIGHT: customers_guard_rep_edit_20261013 is not installed';
  END IF;
  IF has_function_privilege('authenticated', 'public.guard_customer_rep_edit_20261013()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.guard_customer_rep_edit_20261013()', 'EXECUTE') THEN
    RAISE EXCEPTION 'REPS_ANY_CUSTOMER_POSTFLIGHT: the guard trigger function is executable by an API role';
  END IF;
  -- The guard must run with the CALLER's rights (its prepay rule reads current_user) and a pinned
  -- search_path; the open-invoice reader must be definer-rights, executable by authenticated only.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.guard_customer_rep_edit_20261013()'::regprocedure
       AND NOT prosecdef AND proconfig = ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'REPS_ANY_CUSTOMER_POSTFLIGHT: the guard trigger function must be SECURITY INVOKER with search_path public, pg_temp';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public._customer_has_open_invoice_20261013(uuid)'::regprocedure
       AND prosecdef AND proconfig = ARRAY['search_path=public, pg_temp']
  ) OR NOT has_function_privilege('authenticated', 'public._customer_has_open_invoice_20261013(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public._customer_has_open_invoice_20261013(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public._customer_has_open_invoice_20261013(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'REPS_ANY_CUSTOMER_POSTFLIGHT: _customer_has_open_invoice_20261013 security or grants are wrong';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.customers'::regclass AND t.tgname = 'customers_guard_rep_edit_20261013'
       AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM unnest(t.tgattr) k JOIN pg_attribute a
              ON a.attrelid = t.tgrelid AND a.attnum = k)
           = ARRAY['assigned_sales_rep', 'default_commission_split', 'is_active', 'prepay_balance_cents']
       AND (t.tgtype::int & 4) <> 0    -- fires on INSERT
       AND (t.tgtype::int & 16) <> 0   -- and on UPDATE
       AND (t.tgtype::int & 3) = 3     -- ROW level, BEFORE
  ) THEN
    RAISE EXCEPTION 'REPS_ANY_CUSTOMER_POSTFLIGHT: customers_guard_rep_edit_20261013 is not BEFORE INSERT OR UPDATE OF the four guarded columns';
  END IF;
END
$postflight$;
