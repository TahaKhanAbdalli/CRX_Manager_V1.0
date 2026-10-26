-- Inventory: retired products stay on order, no unreleasable holds, and holds survive a product
-- delete attempt (To-Do rows 0.13, 0.14 and the holds half of 6.9; Mason "Go ahead with PR A",
-- 2026-10-25).
--
-- idempotency-body-check: exempt — create_inventory_hold below is the live 20260908130000
-- wrapper with one added refusal. It still calls public.check_idempotency_intent (advisory lock +
-- actor/intent comparison) BEFORE any mutation, the wrapped _create_inventory_hold_intent_impl_20260905
-- writes the receipt row, and the wrapper then binds that row with an UPDATE.
--
-- 1. Row 0.13. get_inventory_position() (through _get_inventory_position_cost_impl_20261019)
--    listed active products only, so a product retired while a purchase order line for it was
--    still open (submitted / partially_received, quantity not fully received) dropped out of the
--    on-order view and "what to order" undercounted. A retired product now stays listed while it
--    has on-order quantity above 0; once nothing is on order it drops out again, as before. A
--    retired product is never is_low_stock, so it cannot land in the reorder banner. The
--    output keys, the row order and the non-admin current_cost strip in get_inventory_position()
--    are unchanged (the wrapper is not touched). Live had 0 retired products with open PO lines on
--    2026-10-25, so this guards the future.
--
-- 2. Row 0.14 (the cause). The public create_inventory_hold() accepted p_hold_type
--    'crop_program', but it takes no quote, so such a hold had no source_id and
--    release_holds_on_quote_status_change could never release it. The app only ever sends
--    'manual' (src/pages/InventoryPage.tsx). The wrapper now refuses every other type with
--    HOLD_TYPE_NOT_ALLOWED before any work. Quote and job holds are written internally by
--    _sync_planned_holds / _sync_quote_job_reservations / _sync_job_holds, which do not call
--    this function and are unchanged. The rest of the wrapper is the live body from
--    20260908130000, unchanged.
--
-- 3. Row 0.14 (detection). run_data_integrity_sweep() gains two checks, so a stuck hold becomes
--    an integrity alert (Checks & Notifications / integrity cleanup):
--      stuck_job_hold     an active 'job' hold whose job is missing, deleted, or not
--                         scheduled / in_progress;
--      orphan_quote_hold  an active 'crop_program' hold with no source quote, or whose quote is
--                         missing, deleted, unplanned, or not draft / sent / revised -- except a
--                         quote in a terminal status, which the existing stale_quote_hold check
--                         already reports (no double alert).
--    Both counted 0 live on 2026-10-25. The alert_type CHECK gains the two values (a superset).
--    The rest of the sweep is the live body from 20260706030000, unchanged.
--
-- 4. Row 6.9 (holds half). inventory_holds.product_id was ON DELETE CASCADE, so hard-deleting a
--    product silently wiped its holds. It becomes NO ACTION, like inventory, order_items and
--    purchase_order_items: deleting a product that still has hold rows is refused. No app path
--    hard-deletes products (they are retired with is_active = false).
--
-- Non-destructive: no rows are changed, no hold is released or altered, no grant changes
-- (CREATE OR REPLACE keeps each function's owner and EXECUTE grants; the postflight checks them).
--
-- Rollback (new reviewed migration): restore the three function bodies from 20260908130000
-- (create_inventory_hold wrapper only), 20261019010000 (_get_inventory_position_cost_impl_20261019)
-- and 20260706030000 (run_data_integrity_sweep); put inventory_holds_product_id_fkey back to
-- ON DELETE CASCADE; and narrow the alert_type CHECK only after resolving any stuck_job_hold /
-- orphan_quote_hold alerts.

SET LOCAL lock_timeout = '5s';

-- Refuse to apply over anything that drifted from the live state this was written against
-- (2026-10-25): the three bodies replaced below, the FK and the alert_type CHECK.
DO $preflight$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public._get_inventory_position_cost_impl_20261019()', 'd05f13e24acd32425bb76b4114b60859'),
      ('public.create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)', '38957fa369e6575d980af8dbbad29d30'),
      ('public.run_data_integrity_sweep()', '635e708a5b9c2ec3c9d9310d8348ddf0')
    ) AS t(sig, pin)
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'INVENTORY_HOLDS_GUARDS_PREFLIGHT: % is missing', r.sig;
    END IF;
    IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.pin THEN
      RAISE EXCEPTION 'INVENTORY_HOLDS_GUARDS_PREFLIGHT: % changed since 2026-10-25', r.sig;
    END IF;
  END LOOP;

  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.inventory_holds'::regclass AND conname = 'inventory_holds_product_id_fkey')
     IS DISTINCT FROM 'FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE' THEN
    RAISE EXCEPTION 'INVENTORY_HOLDS_GUARDS_PREFLIGHT: inventory_holds_product_id_fkey changed since 2026-10-25';
  END IF;

  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.integrity_alerts'::regclass AND conname = 'integrity_alerts_alert_type_check')
     IS DISTINCT FROM 'CHECK ((alert_type = ANY (ARRAY[''negative_inventory''::text, ''negative_invoice_balance''::text, ''stale_quote_hold''::text, ''booking_overdraw''::text])))' THEN
    RAISE EXCEPTION 'INVENTORY_HOLDS_GUARDS_PREFLIGHT: integrity_alerts_alert_type_check changed since 2026-10-25';
  END IF;
END
$preflight$;

-- ---------------------------------------------------------------------------------------------
-- 1. Row 0.13: a retired product with on-order quantity stays in the inventory position.
-- Only the base CTE's product filter changes.
CREATE OR REPLACE FUNCTION public._get_inventory_position_cost_impl_20261019()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_season_start date;
BEGIN
  PERFORM require_admin_or_sales_rep();

  IF EXTRACT(MONTH FROM CURRENT_DATE) >= 10 THEN
    v_season_start := DATE_TRUNC('year', CURRENT_DATE)::date + INTERVAL '9 months';
  ELSE
    v_season_start := (DATE_TRUNC('year', CURRENT_DATE) - INTERVAL '1 year')::date + INTERVAL '9 months';
  END IF;

  RETURN (
    WITH on_order AS (
      SELECT poi.product_id, SUM(GREATEST(poi.quantity_ordered - COALESCE(poi.quantity_received, 0), 0)) AS qty
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
      WHERE po.status IN ('submitted', 'partially_received')
      GROUP BY poi.product_id
    ),
    holds AS (
      SELECT ih.product_id,
             SUM(ih.quantity) AS qty,
             -- LAYER2<<< job-type subset broken out as its own column (§4B.2 #1)
             SUM(ih.quantity) FILTER (WHERE ih.hold_type = 'job') AS job_qty
             -- >>>LAYER2
      FROM inventory_holds ih
      WHERE ih.is_active = true
        AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
      GROUP BY ih.product_id
    ),
    planned_quotes AS (
      -- LAYER2<<< quantity-aware dedup (§4B.2 #2): unreserved remainder per booking line.
      -- Codex A+B round-2 P2: AGGREGATE the booking per (quote, product) FIRST, THEN
      -- subtract the product-level hold/draws ONCE. Subtracting them inside a per-line
      -- SUM over-deducts when a product appears on multiple quote lines (two 50-unit
      -- lines with a 60-unit job draw and no hold would report 0 instead of 40 unreserved).
      SELECT pq.product_id, SUM(pq.remainder) AS qty
      FROM (
        SELECT b.quote_id, b.product_id,
               GREATEST(
                 b.booked
                   - COALESCE(lh.linked_hold, 0)
                   - COALESCE(od.order_drawn, 0)
                   - COALESCE(jd.job_drawn, 0),
                 0) AS remainder
        FROM (
          SELECT qi.quote_id, qi.product_id, SUM(COALESCE(qi.total_units_needed, 0)) AS booked
          FROM quote_items qi
          JOIN quotes q ON q.id = qi.quote_id
          WHERE q.is_planned = true AND q.status IN ('draft', 'sent', 'revised')
          GROUP BY qi.quote_id, qi.product_id
        ) b
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(ih.quantity), 0) AS linked_hold
          FROM inventory_holds ih
          WHERE ih.source_id = b.quote_id
            AND ih.product_id = b.product_id
            AND ih.is_active = true
            AND (ih.expires_at IS NULL OR ih.expires_at >= CURRENT_DATE)
        ) lh ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(qpd.quantity_drawn), 0) AS order_drawn
          FROM quote_product_draws qpd
          WHERE qpd.quote_id = b.quote_id
            AND qpd.product_id = b.product_id
        ) od ON true
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(jpd.quantity_drawn), 0) AS job_drawn
          FROM job_product_draws jpd
          WHERE jpd.quote_id = b.quote_id
            AND jpd.product_id = b.product_id
        ) jd ON true
      ) pq
      GROUP BY pq.product_id
      -- >>>LAYER2
    ),
    order_voided_products AS (
      -- void_order records one product-level reversal for the entire order and
      -- intentionally has no delivery_id. Pair that row back to all delivery
      -- events for the same order/product so its later ledger timestamp cannot
      -- move old delivered volume across season boundaries.
      SELECT DISTINCT it.order_id, it.product_id
      FROM inventory_transactions it
      WHERE it.transaction_type = 'void_delivery_reversal'
        AND it.delivery_id IS NULL
        AND it.order_id IS NOT NULL
    ),
    delivered_ytd AS (
      SELECT it.product_id,
             GREATEST(SUM(
               CASE
                 WHEN it.transaction_type = 'delivered' THEN ABS(it.quantity)
                 WHEN it.transaction_type IN ('cancelled_delivery_reversal', 'void_delivery_reversal')
                   THEN -ABS(it.quantity)
                 ELSE 0
               END
              ), 0) AS qty
      FROM inventory_transactions it
      JOIN deliveries d ON d.id = it.delivery_id
      LEFT JOIN order_voided_products ovp
        ON ovp.order_id = it.order_id
       AND ovp.product_id = it.product_id
      WHERE it.transaction_type IN ('delivered', 'cancelled_delivery_reversal', 'void_delivery_reversal')
        -- Delivery-specific reversals retain delivery_id, so they use the
        -- original delivery business date. Order-level voids are excluded by
        -- the paired order/product key above instead of their reversal date.
        AND (COALESCE(d.completed_at, it.created_at) AT TIME ZONE 'America/Chicago')::date >= v_season_start
        AND ovp.order_id IS NULL
      GROUP BY it.product_id
    ),
    base AS (
      SELECT
        p.id AS product_id, p.product_name, p.inventory_unit,
        p.container_size, p.container_type, p.vendor, p.current_cost, p.is_active,
        i.id AS inventory_id, i.location, i.unit_size,
        COALESCE(i.quantity_available, 0) AS quantity_available,
        COALESCE(i.quantity_prebooked, 0) AS quantity_prebooked,
        COALESCE(i.reorder_point, 0) AS reorder_point,
        COALESCE(i.min_stock_level, 0) AS min_stock_level
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      -- To-Do 0.13: a retired product stays listed while it still has stock on an open PO, so
      -- "what to order" does not undercount. It drops out once nothing is on order.
      WHERE p.is_active = true
         OR EXISTS (SELECT 1 FROM on_order oo0 WHERE oo0.product_id = p.id AND oo0.qty > 0)
    )
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.product_name), '[]'::jsonb)
    FROM (
      SELECT
        b.inventory_id, b.product_id, b.product_name, b.inventory_unit,
        b.container_size, b.container_type, b.vendor, b.current_cost,
        b.location, b.unit_size,
        b.quantity_available, b.quantity_prebooked,
        COALESCE(oo.qty, 0) AS quantity_on_order,
        COALESCE(h.qty, 0)  AS holds_qty,
        COALESCE(h.job_qty, 0) AS job_holds_qty,   -- LAYER2: new column
        COALESCE(pq.qty, 0) AS planned_qty,
        COALESCE(dy.qty, 0) AS delivered_ytd,
        (b.quantity_available - b.quantity_prebooked + COALESCE(oo.qty, 0)) AS net_position,
        b.reorder_point, b.min_stock_level,
        -- U18 #90: negative on-hand is always a stock problem, reorder_point set or not.
        -- To-Do 0.13: a retired product is listed only for its on-order stock; it is never
        -- "low", so it cannot land in the reorder banner.
        (b.is_active AND ((b.reorder_point > 0 AND b.quantity_available <= b.reorder_point) OR b.quantity_available < 0)) AS is_low_stock
      FROM base b
      LEFT JOIN on_order       oo ON oo.product_id = b.product_id
      LEFT JOIN holds          h  ON h.product_id  = b.product_id
      LEFT JOIN planned_quotes pq ON pq.product_id = b.product_id
      LEFT JOIN delivered_ytd  dy ON dy.product_id = b.product_id
      WHERE b.inventory_id IS NOT NULL OR COALESCE(oo.qty, 0) > 0
    ) r
  );
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 2. Row 0.14: the public hold path creates manual holds only.
CREATE OR REPLACE FUNCTION public.create_inventory_hold(p_product_id uuid, p_customer_id uuid, p_quantity numeric, p_hold_type text, p_expires_at date, p_notes text, p_performed_by uuid, p_force boolean DEFAULT false, p_force_reason text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  -- Normalize the force flag ONCE, here, and use v_force for BOTH the
  -- fingerprint and the delegated call. The wrapped body tests p_force with
  -- bare `IF p_force` and `AND NOT p_force`, and a SQL/JSON NULL makes both
  -- three-valued: `IF NULL` takes the ELSE path, so FORCE_REQUIRES_ADMIN and
  -- FORCE_REQUIRES_REASON never fire, and `over_capacity AND NOT NULL` is NULL
  -- rather than true, so INSUFFICIENT_HOLD_INVENTORY never raises. A sales rep
  -- posting p_force: null could therefore book an unlimited over-capacity hold
  -- with no admin authorization, no force reason, and no 'WARNING: ... admin
  -- override' activity row. This wrapper is the only entrypoint `authenticated`
  -- can reach (the impl is postgres-only since the 20260908130000 rename), so
  -- normalizing here closes it without editing the wrapped body.
  v_force boolean := COALESCE(p_force, false);
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  -- Same rule as the wrapped body: the caller may name itself or nothing.
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;
  -- NULL-safe and active-only. A missing or deactivated profile is refused
  -- here; the wrapped body's own gate runs again afterwards and can only be
  -- stricter than a pass.
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- To-Do 0.14 (20261025090000): this path takes no quote or job, so a
  -- 'crop_program' or 'job' hold made here would have no source_id and nothing
  -- could ever release it. Quote and job holds are written only by
  -- _sync_planned_holds / _sync_quote_job_reservations / _sync_job_holds.
  IF p_hold_type IS DISTINCT FROM 'manual' THEN
    RAISE EXCEPTION 'HOLD_TYPE_NOT_ALLOWED: create_inventory_hold creates manual holds only (got %)', COALESCE(p_hold_type, 'NULL');
  END IF;

  -- A key is required so every hold is a receipt that a retry can find. Blank,
  -- whitespace-only, or non-printable keys are refused before any work.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" !~ '[!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_inventory_hold requires p_idempotency_key';
  END IF;

  -- Everything that shapes the hold. p_performed_by is not included: the
  -- guard above constrains it to {NULL, actor} and the wrapped body stamps
  -- created_by from auth.uid(), so it cannot change the outcome. That omission
  -- DEPENDS on the ACTOR_MISMATCH guard; if that guard is ever relaxed,
  -- p_performed_by must join the fingerprint (same warning as 20260811130000).
  -- trim_scale makes 5 and 5.0 the same request.
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'product_id', p_product_id,
    'customer_id', p_customer_id,
    'quantity', trim_scale(p_quantity),
    'hold_type', p_hold_type,
    'expires_at', p_expires_at,
    'notes', p_notes,
    'force', v_force,
    'force_reason', p_force_reason
  )::text, 'UTF8'), 'sha256'), 'hex');

  -- Publish the binding context BEFORE any receipt can be written. The
  -- BEFORE INSERT trigger installed by 20260908130000 rejects any
  -- create_inventory_hold receipt that arrives without it, which is what stops
  -- an old-body call that was already in flight at cutover from landing an
  -- unbound receipt. `true` = transaction-local, so it disappears on COMMIT or
  -- ROLLBACK and cannot leak into the connection's next transaction.
  PERFORM set_config('crx.create_inventory_hold_intent', jsonb_build_object(
    'operation', 'create_inventory_hold',
    'idempotency_key', p_idempotency_key,
    'actor_id', v_actor,
    'fingerprint', v_fingerprint
  )::text, true);

  -- Takes pg_advisory_xact_lock on the key for the rest of this transaction.
  -- A racing same-key call waits here until this one commits, then replays.
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'create_inventory_hold', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL OR jsonb_typeof(v_replay -> 'result') = 'null' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- Stock check under FOR UPDATE, hold insert, activity row, receipt insert —
  -- unchanged from the live body.
  v_result := public._create_inventory_hold_intent_impl_20260905(
    p_product_id, p_customer_id, p_quantity, p_hold_type, p_expires_at,
    p_notes, p_performed_by, v_force, p_force_reason, p_idempotency_key
  );

  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor, request_fingerprint = v_fingerprint
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'create_inventory_hold';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;

  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 3. Row 0.14: the sentinel reports stuck job holds and orphaned quote holds.
-- status-enum-check: exempt (adds the 'stuck_job_hold' and 'orphan_quote_hold' alert types to the CHECK below)
ALTER TABLE public.integrity_alerts
  DROP CONSTRAINT integrity_alerts_alert_type_check,
  ADD CONSTRAINT integrity_alerts_alert_type_check CHECK (alert_type = ANY (ARRAY[
    'negative_inventory'::text, 'negative_invoice_balance'::text, 'stale_quote_hold'::text,
    'booking_overdraw'::text, 'stuck_job_hold'::text, 'orphan_quote_hold'::text]));

CREATE OR REPLACE FUNCTION public.run_data_integrity_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_negative_inventory integer := 0;
  v_negative_invoices  integer := 0;
  v_stale_holds        integer := 0;
  v_overdraws          integer := 0;
  v_stuck_job_holds    integer := 0;
  v_orphan_quote_holds integer := 0;
BEGIN
  -- admin-only when an authenticated user calls this; pg_cron / service_role
  -- (auth.uid() = NULL) bypass. Same pattern as check_unpriced_orders.
  IF auth.uid() IS NOT NULL AND NOT is_admin() THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;

  -- (a) NEW negative inventory: per-product net position across locations,
  --     skipping the pre-existing negatives in the baseline (H1).
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'negative_inventory', 'products', neg.product_id,
         jsonb_build_object('net_quantity_available', neg.net_qty)
  FROM (
    SELECT product_id, SUM(quantity_available) AS net_qty
    FROM inventory
    GROUP BY product_id
    HAVING SUM(quantity_available) < 0
  ) neg
  WHERE NOT EXISTS (
    SELECT 1 FROM integrity_negative_baseline b WHERE b.product_id = neg.product_id
  )
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_negative_inventory = ROW_COUNT;

  -- (b) Invoices with a negative balance. balance_cents is GENERATED ALWAYS
  --     ((total - paid - prepay_applied - write_off)) — SELECT-only here.
  --     Negative means we over-collected — anomalous EXCEPT for credit memos,
  --     which are legitimately negative (the live invoices_balance_non_negative
  --     CHECK exempts invoice_type='credit_memo' for exactly this reason).
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'negative_invoice_balance', 'invoices', inv.id,
         jsonb_build_object(
           'invoice_number', inv.invoice_number,
           'status',         inv.status,
           'balance_cents',  inv.balance_cents)
  FROM invoices inv
  WHERE inv.balance_cents < 0
    AND inv.invoice_type <> 'credit_memo'  -- CHANGED (Codex 2026-07-05 P2): valid open credits are negative by design
    AND inv.deleted_at IS NULL
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_negative_invoices = ROW_COUNT;

  -- (c) Active crop_program holds whose parent quote is terminal — those holds
  --     should have been released by the decline/expire/cancel/close paths;
  --     a survivor silently shrinks Net Free forever.
  --     U5<<< 'closed_short' is a terminal booking whose crop_program remainder
  --     is released on close — a survivor is stale, same as the others. (#1)
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'stale_quote_hold', 'inventory_holds', h.id,
         jsonb_build_object(
           'quote_id',     q.id,
           'quote_status', q.status,
           'product_id',   h.product_id,
           'quantity',     h.quantity)
  FROM inventory_holds h
  JOIN quotes q ON q.id = h.source_id
  WHERE h.is_active = true
    AND h.hold_type = 'crop_program'
    AND q.status IN ('declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short')
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_stale_holds = ROW_COUNT;

  -- (d) Booking overdraw: drawn more than the booking cap. Cap = the same
  --     SUM(COALESCE(quote_items.total_units_needed, 0)) per (quote, product)
  --     that draw_down_quote's fully-drawn check uses (20260610145253).
  --     Also catches drawn > 0 rows whose quote_items lines were edited away
  --     (cap collapses to 0) — that IS drift worth flagging.
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'booking_overdraw', 'quote_product_draws', d.id,
         jsonb_build_object(
           'quote_id',       d.quote_id,
           'product_id',     d.product_id,
           'quantity_drawn', d.quantity_drawn,
           'booking_cap',    cap.booked)
  FROM quote_product_draws d
  JOIN quotes q ON q.id = d.quote_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(COALESCE(qi.total_units_needed, 0)), 0) AS booked
    FROM quote_items qi
    WHERE qi.quote_id = d.quote_id AND qi.product_id = d.product_id
  ) cap
  WHERE q.deleted_at IS NULL
    AND d.quantity_drawn > cap.booked
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_overdraws = ROW_COUNT;

  -- (e) To-Do 0.14 (20261025090000): an active job hold whose job is gone,
  --     deleted, or no longer scheduled / in_progress. _sync_job_holds and
  --     _sync_quote_job_reservations hold stock only for live jobs and delete
  --     the rest, so a survivor is stuck.
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'stuck_job_hold', 'inventory_holds', h.id,
         jsonb_build_object(
           'job_id',      h.source_id,
           'job_status',  j.status,
           'job_deleted', (j.id IS NOT NULL AND j.deleted_at IS NOT NULL),
           'job_missing', (j.id IS NULL),
           'product_id',  h.product_id,
           'quantity',    h.quantity)
  FROM inventory_holds h
  LEFT JOIN jobs j ON j.id = h.source_id
  WHERE h.is_active = true
    AND h.hold_type = 'job'
    AND (j.id IS NULL OR j.deleted_at IS NOT NULL OR j.status NOT IN ('scheduled', 'in_progress'))
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_stuck_job_holds = ROW_COUNT;

  -- (f) To-Do 0.14 (20261025090000): an active crop_program hold with no live
  --     planned quote behind it: no source_id (made through the public hold
  --     path before it was limited to manual holds), or a quote that is missing,
  --     deleted, unplanned, or not draft / sent / revised. _sync_planned_holds
  --     keeps holds only for an open planned quote. A quote in a terminal status
  --     is left to (c) so one hold never raises two alerts.
  INSERT INTO integrity_alerts (alert_type, entity_table, entity_id, details)
  SELECT 'orphan_quote_hold', 'inventory_holds', h.id,
         jsonb_build_object(
           'quote_id',      h.source_id,
           'quote_status',  q.status,
           'quote_deleted', (q.id IS NOT NULL AND q.deleted_at IS NOT NULL),
           'quote_missing', (q.id IS NULL),
           'is_planned',    q.is_planned,
           'product_id',    h.product_id,
           'quantity',      h.quantity)
  FROM inventory_holds h
  LEFT JOIN quotes q ON q.id = h.source_id
  WHERE h.is_active = true
    AND h.hold_type = 'crop_program'
    AND (q.id IS NULL
         OR q.deleted_at IS NOT NULL
         OR q.is_planned IS DISTINCT FROM true
         OR q.status NOT IN ('draft', 'sent', 'revised'))
    AND (q.id IS NULL
         OR q.status NOT IN ('declined', 'expired', 'cancelled', 'closed_by_application', 'closed_short'))
  ON CONFLICT (alert_type, entity_table, entity_id) WHERE resolved_at IS NULL
  DO NOTHING;
  GET DIAGNOSTICS v_orphan_quote_holds = ROW_COUNT;

  RETURN jsonb_build_object(
    'success', true,
    'new_negative_inventory', v_negative_inventory,
    'new_negative_invoice_balance', v_negative_invoices,
    'new_stale_quote_holds', v_stale_holds,
    'new_booking_overdraws', v_overdraws,
    'new_stuck_job_holds', v_stuck_job_holds,
    'new_orphan_quote_holds', v_orphan_quote_holds
  );
END;
$function$;

-- ---------------------------------------------------------------------------------------------
-- 4. Row 6.9: deleting a product no longer wipes its holds; it is refused while hold rows exist.
ALTER TABLE public.inventory_holds
  DROP CONSTRAINT inventory_holds_product_id_fkey,
  ADD CONSTRAINT inventory_holds_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id);

-- ---------------------------------------------------------------------------------------------
-- Postflight: the new rules are in place and no grant moved.
DO $postflight$
DECLARE
  r record;
BEGIN
  IF (SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'public.inventory_holds'::regclass AND conname = 'inventory_holds_product_id_fkey') IS DISTINCT FROM 'a' THEN
    RAISE EXCEPTION 'INVENTORY_HOLDS_GUARDS_POSTFLIGHT: inventory_holds_product_id_fkey is not ON DELETE NO ACTION';
  END IF;
  IF position('HOLD_TYPE_NOT_ALLOWED' IN (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'INVENTORY_HOLDS_GUARDS_POSTFLIGHT: create_inventory_hold does not refuse non-manual holds';
  END IF;
  IF position('oo0.product_id = p.id AND oo0.qty > 0' IN (SELECT prosrc FROM pg_proc
       WHERE oid = 'public._get_inventory_position_cost_impl_20261019()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'INVENTORY_HOLDS_GUARDS_POSTFLIGHT: the inventory position does not keep retired products on order';
  END IF;
  IF position('''stuck_job_hold''' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.run_data_integrity_sweep()'::regprocedure)) = 0
     OR position('''orphan_quote_hold''' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.run_data_integrity_sweep()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'INVENTORY_HOLDS_GUARDS_POSTFLIGHT: the sweep lacks the stuck_job_hold / orphan_quote_hold checks';
  END IF;
  FOR r IN
    SELECT * FROM (VALUES
      ('public._get_inventory_position_cost_impl_20261019()', false, false, false),
      ('public.create_inventory_hold(uuid,uuid,numeric,text,date,text,uuid,boolean,text,text)', false, true, true),
      ('public.run_data_integrity_sweep()', false, false, true)
    ) AS t(sig, want_anon, want_auth, want_service)
  LOOP
    IF has_function_privilege('anon', r.sig, 'EXECUTE') IS DISTINCT FROM r.want_anon
       OR has_function_privilege('authenticated', r.sig, 'EXECUTE') IS DISTINCT FROM r.want_auth
       OR has_function_privilege('service_role', r.sig, 'EXECUTE') IS DISTINCT FROM r.want_service THEN
      RAISE EXCEPTION 'INVENTORY_HOLDS_GUARDS_POSTFLIGHT: EXECUTE grants on % moved', r.sig;
    END IF;
    IF (SELECT prosecdef AND proconfig = ARRAY['search_path=public, pg_temp'] AND pg_get_userbyid(proowner) = 'postgres'
          FROM pg_proc WHERE oid = r.sig::regprocedure) IS NOT TRUE THEN
      RAISE EXCEPTION 'INVENTORY_HOLDS_GUARDS_POSTFLIGHT: % lost SECURITY DEFINER, its search_path or its postgres owner', r.sig;
    END IF;
  END LOOP;
END
$postflight$;
