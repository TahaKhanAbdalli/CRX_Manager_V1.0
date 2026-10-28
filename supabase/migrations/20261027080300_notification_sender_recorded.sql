-- Written 2026-10-27. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 999). Stamp and row are PLACEHOLDERS from Taha's
-- fork: the CRX Coordinator session should assign the final stamp/row. Lands after
-- 20261027080200 (row 998). Re-read the live ledger first.
--
-- idempotency-body-check: exempt -- new trigger function; it takes no p_idempotency_key and writes no row.
--
-- WHAT: every notification records who sent it (Mason 2026-10-26). New column
--   notifications.created_by, set by a BEFORE INSERT trigger to auth.uid() whenever the insert runs
--   as a signed-in (or anon) API user, whatever the client sent. Server functions (SECURITY DEFINER,
--   run as postgres) and service_role keep what they set, normally NULL = a system notice. The
--   app's ~12 screen flows that alert other staff (src/lib/notificationTriggers.ts, notifyAdmins)
--   keep working. The notification list and panel show "From <name>" when the sender is not the
--   recipient. Server-built notification text (one RPC) is a possible follow-up.
--
-- NOT CHANGED: every policy and grant on notifications; existing rows (created_by NULL, shown as
--   before); every function that inserts notifications.
--
-- CALLERS (checked 2026-10-27 on main fe258c2f): src/lib/activityLogger.ts createNotification /
--   notifyAdmins insert without created_by and get it stamped; SECURITY DEFINER inserters are
--   unaffected. The new trigger function is not callable by app roles (EXECUTE revoked; a trigger
--   does not need it at fire time).
--
-- EVIDENCE: read on a local replay of main d5fd2bf8 (no live access from the fork); Mason to re-read
--   live before applying: notifications has no created_by column and no triggers.
--
-- ROLLBACK: DROP TRIGGER notifications_stamp_sender ON public.notifications;
--   DROP FUNCTION public.stamp_notification_sender(); ALTER TABLE public.notifications DROP COLUMN
--   created_by; (drops only the recorded senders; no other data.)

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE notification_sender_recorded_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.notification_sender_recorded_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.notification_sender_recorded_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'created_by') THEN
    RAISE EXCEPTION 'NOTIFICATION_SENDER_ALREADY_APPLIED: notifications.created_by already exists';
  END IF;
  IF to_regprocedure('public.stamp_notification_sender()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.notifications'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: notifications already has a trigger, or stamp_notification_sender exists';
  END IF;
END;
$preflight$;

ALTER TABLE public.notifications ADD COLUMN created_by uuid;
COMMENT ON COLUMN public.notifications.created_by IS
  'Who sent it: auth.uid() for any insert by a signed-in user (forced by notifications_stamp_sender); NULL = a system notice from a server function.';

CREATE FUNCTION public.stamp_notification_sender()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- An API user cannot choose (or blank) the sender; server functions run as their owner and keep theirs.
  IF current_user IN ('authenticated', 'anon') THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.stamp_notification_sender() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER notifications_stamp_sender
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.stamp_notification_sender();

DO $postflight$
BEGIN
  IF to_regclass('pg_temp.notification_sender_recorded_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.notification_sender_recorded_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'notifications'
                    AND column_name = 'created_by' AND data_type = 'uuid' AND is_nullable = 'YES')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
                     WHERE tgname = 'notifications_stamp_sender' AND tgrelid = 'public.notifications'::regclass
                       AND tgfoid = 'public.stamp_notification_sender()'::regprocedure AND tgenabled = 'O')
     OR (SELECT NOT p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
                AND p.proconfig = ARRAY['search_path=public, pg_temp']
           FROM pg_proc p WHERE p.oid = 'public.stamp_notification_sender()'::regprocedure) IS NOT TRUE
     OR has_function_privilege('anon', 'public.stamp_notification_sender()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.stamp_notification_sender()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: notifications.created_by / notifications_stamp_sender not as expected';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: every notification a person sends records its real sender';
END;
$postflight$;
