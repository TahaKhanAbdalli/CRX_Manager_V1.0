-- Written 2026-10-23. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 979).
--
-- WHAT: two display fixes on the Team Board, follow-ups 1 and 2 from PR #1042.
--   get_team_board_deliveries     its priority sort ranked 'medium', a value deliveries.priority
--                                 cannot hold (deliveries_priority_check allows low, normal, high,
--                                 urgent). 'normal' fell to ELSE 4 and sorted AFTER 'low'. It now
--                                 ranks urgent 0, high 1, normal 2, low 3.
--   get_yesterday_delivery_recap  reported 'completed_at' as del.updated_at and sorted by it, so any
--                                 later edit to a completed delivery moved it in the recap. It now
--                                 uses COALESCE(del.completed_at, del.updated_at) for both.
--   Live read 2026-10-23: all 108 deliveries are 'normal' (no 'low'), and all 70 completed ones have
--   completed_at with no later edit, so nothing shown today changes. YesterdayRecap.tsx, the only
--   app caller, shows the summary counts and the issues list, not the completed list, so the recap
--   change corrects the data the RPC returns rather than anything on screen today.
--   The same 'medium' key in src/components/team/TodaysDeliveries.tsx (card border colour) is fixed
--   in the same PR, so 'normal' deliveries stop being drawn like 'low' ones.
--
-- SOURCE OF THE BODIES: live, as re-emitted by 20261022070000 (row 974) and pinned below by md5.
--
-- NOT CHANGED: who can call either function or what rows they see; return shapes; owner (postgres),
--   ACLs, search_path, comments; no rows change. CREATE OR REPLACE keeps each OID.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE team_board_display_fixes_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_pin record;
  v_md5 text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.team_board_display_fixes_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.team_board_display_fixes_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;

  -- The sort below assumes these four values; refuse if the constraint has moved on.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.deliveries'::regclass AND conname = 'deliveries_priority_check')
     IS DISTINCT FROM 'CHECK ((priority = ANY (ARRAY[''low''::text, ''normal''::text, ''high''::text, ''urgent''::text])))' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: deliveries_priority_check is not low/normal/high/urgent';
  END IF;

  FOR v_pin IN
    SELECT * FROM (VALUES
      ('get_team_board_deliveries',    'public.get_team_board_deliveries()',    '6d7e0afa5977a5e3b85017b30435b75d'),
      ('get_yesterday_delivery_recap', 'public.get_yesterday_delivery_recap()', '401fcbb6b0096a5b6b4c3c3cda8a91e6')
    ) AS t(fn, sig, live_md5)
  LOOP
    IF (SELECT count(*) FROM pg_proc WHERE proname = v_pin.fn AND pronamespace = 'public'::regnamespace) <> 1 THEN
      RAISE EXCEPTION 'PREFLIGHT_FAIL: public.% must have exactly one overload', v_pin.fn;
    END IF;
    SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(v_pin.sig);
    IF v_md5 IS DISTINCT FROM v_pin.live_md5 THEN
      -- Already applied, or live drifted from the body this file was written against.
      RAISE EXCEPTION 'TEAM_BOARD_DISPLAY_BASELINE_DRIFT: % is %', v_pin.fn, v_md5;
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
          -- deliveries_priority_check allows urgent, high, normal, low (or NULL, which sorts last).
          CASE del.priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'normal' THEN 2
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
            WHEN 'normal' THEN 2
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
      -- completed_at, not updated_at: a later edit to a completed delivery must not move it.
      SELECT jsonb_agg(jsonb_build_object(
        'id', del.id,
        'delivery_number', del.delivery_number,
        'customer_name', c.farm_name,
        'driver_name', p.full_name,
        'completed_at', COALESCE(del.completed_at, del.updated_at),
        'item_count', (SELECT count(*) FROM delivery_items di WHERE di.delivery_id = del.id),
        'has_issues', (del.issue_type IS NOT NULL)
      ) ORDER BY COALESCE(del.completed_at, del.updated_at))
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

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  IF to_regclass('pg_temp.team_board_display_fixes_tx') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.team_board_display_fixes_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;

  FOR v_fn IN
    SELECT t.fn, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
           md5(replace(p.prosrc, chr(13), '')) AS body_md5, t.new_md5
      FROM (VALUES
        ('get_team_board_deliveries',    'public.get_team_board_deliveries()',    '2dd884639ed907554532d420a2ad6676'),
        ('get_yesterday_delivery_recap', 'public.get_yesterday_delivery_recap()', '5994e38938f09c94a3b7fa1bb2f11e43')
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
        to_regprocedure('public.get_yesterday_delivery_recap()'))) <> 2 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: a function is missing';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK';
END;
$postflight$;
