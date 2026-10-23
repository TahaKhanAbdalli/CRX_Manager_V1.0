-- Written 2026-10-22. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 974).
--
-- WHAT: an inactive account can no longer reach four SECURITY DEFINER functions at its stored role.
--   Each read the caller's role with `SELECT role ... FROM profiles WHERE id = <caller>` and never
--   checked `is_active`, so a deactivated user (or a new, not-yet-activated one, 20261022023000)
--   whose token has not expired yet kept that role here:
--     get_team_board_deliveries     inactive admin/sales rep saw every delivery on the team board;
--     get_yesterday_delivery_recap  same, for yesterday's recap;
--     mark_inventory_row_verified   inactive admin could clear an inventory row's
--                                   manufactured-at-delivery flag;
--     get_ar_reminder_candidates    inactive admin could read the overdue-customer list (names,
--                                   emails, balances).
--   Live read-only survey 2026-10-22: every other function that reads profiles.role for the caller
--   either also requires is_active, gates first through is_admin()/is_sales_rep()/
--   require_admin()/require_admin_or_sales_rep() (all active-only), or reads the role only to
--   write an audit-log snapshot after such a gate. _batch_void_invoices_replay_impl_20261015 and
--   _create_app_record_from_bt_replay_impl_20261015 are of that last kind;
--   _create_inventory_hold_intent_impl_20260905 is postgres-only and reached only through
--   create_inventory_hold, which refuses an inactive caller first.
--
-- HOW: each role read adds `AND is_active = true`, and each gate tests the result NULL-safely, so a
--   missing or inactive profile is refused (`NULL NOT IN (...)` / `NULL != 'admin'` are not TRUE
--   and would let it through). The two delivery boards now refuse an inactive or profile-less
--   caller outright instead of falling back to "deliveries assigned to me".
--   mark_inventory_row_verified also moves its retry-key cache read below the caller check, so a
--   refused caller cannot read a cached result. get_ar_reminder_candidates drops its
--   `request.jwt.claims ->> 'user_role'` shortcut: no access-token hook sets that claim (live read
--   2026-10-22), and if one ever did it would skip the active check.
--
-- SOURCE OF THE BODIES: live, as pinned below, not the older files on disk. The two delivery boards'
--   last on-disk CREATE (20260315200000) names columns that no longer exist (c.name,
--   del.delivery_address, del.issue_description); live uses c.farm_name, customer_addresses and
--   del.issue_notes. mark_inventory_row_verified's live body is 20260507180000 without its comments.
--   Do not "restore" either from disk.
--
-- NOT CHANGED: what an active admin, sales rep, driver or applicator gets from any of the four;
--   return types, owner (postgres), ACLs, search_path, comments; no rows change. CREATE OR REPLACE
--   keeps each OID.
--
-- ORDERING: lands last of the queue assigned 2026-10-22, after row 973 (PR #1024); the signup-role fix
--   it follows up is 20261022023000_handle_new_user_ignores_signup_role.sql (row 969). Re-read the
--   live ledger first.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE role_reads_require_active_profile_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_pin record;
  v_md5 text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.role_reads_require_active_profile_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.role_reads_require_active_profile_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;

  FOR v_pin IN
    SELECT * FROM (VALUES
      ('get_team_board_deliveries',    'public.get_team_board_deliveries()',               '3f22992ef2e0b1c5e4ff18c2a0d399cd'),
      ('get_yesterday_delivery_recap', 'public.get_yesterday_delivery_recap()',            'a7a6c334f7706982f4f674a267284313'),
      ('mark_inventory_row_verified',  'public.mark_inventory_row_verified(uuid,uuid,text)', '38e4d8834f3d6530cfe3bde85557b3c8'),
      ('get_ar_reminder_candidates',   'public.get_ar_reminder_candidates()',              'aef0983aff530c6f9e54d690bf4e47c1')
    ) AS t(fn, sig, live_md5)
  LOOP
    IF (SELECT count(*) FROM pg_proc WHERE proname = v_pin.fn AND pronamespace = 'public'::regnamespace) <> 1 THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: public.% must have exactly one overload', v_pin.fn;
    END IF;
    SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(v_pin.sig);
    IF v_md5 IS DISTINCT FROM v_pin.live_md5 THEN
      -- Already applied, or live drifted from the body this file was written against.
      RAISE EXCEPTION 'ROLE_READS_BASELINE_DRIFT: % is %', v_pin.fn, v_md5;
    END IF;
  END LOOP;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.get_team_board_deliveries()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_role text;
  v_today date := CURRENT_DATE;
  v_tomorrow date := CURRENT_DATE + 1;
  v_result jsonb;
BEGIN
  -- Active profiles only: an inactive or missing profile is refused, not shown "my deliveries".
  SELECT role INTO v_role FROM profiles WHERE id = v_user_id AND is_active = true;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: active account required';
  END IF;

  SELECT jsonb_build_object(
    'today', COALESCE((
      SELECT jsonb_agg(row_to_json(d.*)::jsonb ORDER BY d.scheduled_time NULLS LAST, d.priority_sort)
      FROM (
        SELECT
          del.id,
          del.delivery_number,
          del.status,
          del.priority,
          CASE del.priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
            ELSE 4
          END AS priority_sort,
          del.scheduled_date,
          del.scheduled_time,
          ca.address_line AS delivery_address,
          del.delivery_notes,
          c.farm_name AS customer_name,
          p.full_name AS driver_name,
          del.assigned_driver,
          (SELECT count(*) FROM delivery_items di WHERE di.delivery_id = del.id) AS item_count
        FROM deliveries del
        JOIN customers c ON c.id = del.customer_id
        LEFT JOIN customer_addresses ca ON ca.id = del.delivery_address_id
        LEFT JOIN profiles p ON p.id = del.assigned_driver
        WHERE del.scheduled_date = v_today
          AND del.status IN ('scheduled', 'in_progress')
          AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
      ) d
    ), '[]'::jsonb),
    'tomorrow', COALESCE((
      SELECT jsonb_agg(row_to_json(d.*)::jsonb ORDER BY d.scheduled_time NULLS LAST, d.priority_sort)
      FROM (
        SELECT
          del.id,
          del.delivery_number,
          del.status,
          del.priority,
          CASE del.priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
            ELSE 4
          END AS priority_sort,
          del.scheduled_date,
          del.scheduled_time,
          ca.address_line AS delivery_address,
          c.farm_name AS customer_name,
          p.full_name AS driver_name,
          del.assigned_driver
        FROM deliveries del
        JOIN customers c ON c.id = del.customer_id
        LEFT JOIN customer_addresses ca ON ca.id = del.delivery_address_id
        LEFT JOIN profiles p ON p.id = del.assigned_driver
        WHERE del.scheduled_date = v_tomorrow
          AND del.status = 'scheduled'
          AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
      ) d
    ), '[]'::jsonb),
    'unassigned_count', (
      SELECT count(*)
      FROM deliveries
      WHERE scheduled_date = v_today
        AND status = 'scheduled'
        AND assigned_driver IS NULL
    ),
    'today_total', (
      SELECT count(*)
      FROM deliveries
      WHERE scheduled_date = v_today
        AND status IN ('scheduled', 'in_progress')
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_yesterday_delivery_recap()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_role text;
  v_yesterday date := CURRENT_DATE - 1;
  v_result jsonb;
BEGIN
  -- Active profiles only: an inactive or missing profile is refused, not shown "my deliveries".
  SELECT role INTO v_role FROM profiles WHERE id = v_user_id AND is_active = true;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: active account required';
  END IF;

  SELECT jsonb_build_object(
    'completed', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', del.id,
        'delivery_number', del.delivery_number,
        'customer_name', c.farm_name,
        'driver_name', p.full_name,
        'completed_at', del.updated_at,
        'item_count', (SELECT count(*) FROM delivery_items di WHERE di.delivery_id = del.id),
        'has_issues', (del.issue_type IS NOT NULL)
      ) ORDER BY del.updated_at)
      FROM deliveries del
      JOIN customers c ON c.id = del.customer_id
      LEFT JOIN profiles p ON p.id = del.assigned_driver
      WHERE del.scheduled_date = v_yesterday
        AND del.status = 'completed'
        AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
    ), '[]'::jsonb),
    'issues', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', del.id,
        'delivery_number', del.delivery_number,
        'customer_name', c.farm_name,
        'driver_name', p.full_name,
        'issue_type', del.issue_type,
        'issue_description', del.issue_notes
      ))
      FROM deliveries del
      JOIN customers c ON c.id = del.customer_id
      LEFT JOIN profiles p ON p.id = del.assigned_driver
      WHERE del.scheduled_date = v_yesterday
        AND del.issue_type IS NOT NULL
        AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'total_completed', (
        SELECT count(*) FROM deliveries
        WHERE scheduled_date = v_yesterday AND status = 'completed'
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
      ),
      'total_with_issues', (
        SELECT count(*) FROM deliveries
        WHERE scheduled_date = v_yesterday AND issue_type IS NOT NULL
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
      ),
      'total_cancelled', (
        SELECT count(*) FROM deliveries
        WHERE scheduled_date = v_yesterday AND status IN ('cancelled', 'voided')
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_inventory_row_verified(
  p_inventory_id uuid,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor    uuid;
  v_role     text;
  v_existing jsonb;
  v_row      record;
  v_result   jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by != v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  -- Active admins only; IS DISTINCT FROM so a missing or inactive profile (NULL) is refused.
  SELECT role INTO v_role FROM profiles WHERE id = v_actor AND is_active = true;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: admin required';
  END IF;

  -- The cached result is read only after the caller passes the gate above.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
     WHERE idempotency_key = p_idempotency_key
       AND operation = 'mark_inventory_row_verified';
    IF v_existing IS NOT NULL THEN
      RETURN v_existing;
    END IF;
  END IF;

  SELECT id, product_id, quantity_available, manufactured_at_delivery
    INTO v_row
    FROM inventory
   WHERE id = p_inventory_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVENTORY_NOT_FOUND: %', p_inventory_id;
  END IF;

  IF NOT v_row.manufactured_at_delivery THEN
    v_result := jsonb_build_object(
      'inventory_id', p_inventory_id,
      'cleared', false,
      'reason', 'already_verified'
    );
  ELSE
    UPDATE inventory
       SET manufactured_at_delivery = false,
           updated_at = now()
     WHERE id = p_inventory_id;

    INSERT INTO activity_feed (
      event_type, description, performed_by,
      related_entity_type, related_entity_id
    ) VALUES (
      'inventory_row_verified',
      'Manufactured-at-delivery flag cleared after admin physical-stock verification.',
      v_actor, 'inventory', p_inventory_id
    );

    v_result := jsonb_build_object(
      'inventory_id', p_inventory_id,
      'cleared', true,
      'reason', 'verified_by_admin'
    );
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result, expires_at)
    VALUES (p_idempotency_key, 'mark_inventory_row_verified', v_result,
            now() + interval '24 hours')
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_ar_reminder_candidates()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  result jsonb;
  _role  text;
  v_setting_raw text;
  v_num numeric;
  v_threshold int;
BEGIN
  -- Active admins only, from the profile (no JWT claim shortcut); NULL-safe.
  SELECT role INTO _role FROM public.profiles WHERE id = auth.uid() AND is_active = true;
  IF _role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'permission denied: admin role required';
  END IF;

  -- Configurable threshold (Settings > app_settings.ar_reminder_days). Robust: take the LEADING
  -- integer part (so '30', '30.0', ' 45 ' all read as 30/30/45 — NOT digit-stripping, which would
  -- turn '30.0'->300 or '1e2'->12), default 30 on blank/garbage/missing, clamp 1..3650 so a bad
  -- value can never break the report.
  SELECT setting_value INTO v_setting_raw FROM app_settings WHERE setting_key = 'ar_reminder_days';
  v_num := (regexp_match(COALESCE(v_setting_raw, ''), '^\s*(\d+)'))[1]::numeric;
  v_threshold := CASE WHEN v_num IS NULL THEN 30 ELSE LEAST(GREATEST(v_num, 1), 3650)::int END;

  SELECT COALESCE(jsonb_agg(row_to_json(cust_agg)::jsonb), '[]'::jsonb)
  INTO result
  FROM (
    SELECT
      c.id AS customer_id,
      c.farm_name,
      c.email,
      c.prepay_balance_cents,
      (SELECT COALESCE(-SUM(ci.balance_cents), 0)::bigint
         FROM invoices ci
        WHERE ci.customer_id = c.id
          AND ci.invoice_type = 'credit_memo'
          AND ci.status = 'posted'
          AND ci.balance_cents < 0
          AND ci.deleted_at IS NULL) AS open_credit_cents,
      MAX(EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int) AS max_days_past_due,
      COALESCE(SUM(GREATEST(i.balance_cents, 0)), 0) / 100.0 AS total_balance,
      jsonb_agg(jsonb_build_object(
        'invoice_id', i.id,
        'invoice_number', i.invoice_number,
        'invoice_date', i.invoice_date,
        'balance_cents', i.balance_cents,
        'days_past_due', EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int
      ) ORDER BY i.invoice_date) AS invoices
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status IN ('posted', 'overdue')
      AND i.balance_cents > 0
      AND EXTRACT(DAY FROM NOW() - COALESCE(i.due_date, i.invoice_date))::int > v_threshold
      AND c.email IS NOT NULL
      AND c.email <> ''
    GROUP BY c.id, c.farm_name, c.email, c.prepay_balance_cents
    ORDER BY max_days_past_due DESC
  ) cust_agg;

  RETURN result;
END;
$function$;

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  IF to_regclass('pg_temp.role_reads_require_active_profile_tx') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.role_reads_require_active_profile_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;

  FOR v_fn IN
    SELECT t.fn, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
           md5(replace(p.prosrc, chr(13), '')) AS body_md5, t.new_md5
      FROM (VALUES
        ('get_team_board_deliveries',    'public.get_team_board_deliveries()',               '6d7e0afa5977a5e3b85017b30435b75d'),
        ('get_yesterday_delivery_recap', 'public.get_yesterday_delivery_recap()',            '401fcbb6b0096a5b6b4c3c3cda8a91e6'),
        ('mark_inventory_row_verified',  'public.mark_inventory_row_verified(uuid,uuid,text)', '062fffe5f01fa1873255b7e5ade308cc'),
        ('get_ar_reminder_candidates',   'public.get_ar_reminder_candidates()',              'be574e829d67e9e4f26cf8b3c0a6f681')
      ) AS t(fn, sig, new_md5)
      JOIN pg_proc p ON p.oid = to_regprocedure(t.sig)
  LOOP
    IF NOT v_fn.prosecdef OR v_fn.owner <> 'postgres'
       OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
       OR v_fn.acl IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       OR v_fn.body_md5 IS DISTINCT FROM v_fn.new_md5 THEN
      RAISE EXCEPTION 'POSTFLIGHT_FAIL: % is not the expected body/attributes (md5 %)', v_fn.fn, v_fn.body_md5;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc WHERE oid IN (
        to_regprocedure('public.get_team_board_deliveries()'),
        to_regprocedure('public.get_yesterday_delivery_recap()'),
        to_regprocedure('public.mark_inventory_row_verified(uuid,uuid,text)'),
        to_regprocedure('public.get_ar_reminder_candidates()'))) <> 4 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not all four functions were found';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: four role reads require an active profile';
END;
$postflight$;
