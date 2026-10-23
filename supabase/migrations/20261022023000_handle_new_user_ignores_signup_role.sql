-- Written 2026-10-22. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 969).
--
-- WHAT: a new login no longer picks its own role. `handle_new_user` (AFTER INSERT ON auth.users)
--   copied `raw_user_meta_data->>'role'` into the new profile, and profiles start active. That
--   metadata is exactly what a public `signUp({ options: { data } })` call lets the caller write,
--   so with public signup enabled anyone could sign up as an active admin. Today only the Auth
--   dashboard setting that disables public signup stands in the way (KNOWN_ISSUES / CHANGELOG,
--   "Critical #2"; the second half of that chain, a user editing their own role, is already closed
--   by `_guard_profile_role_lock`, 20260511090000 and 20260807215532).
--
-- HOW: every user the Auth service creates (public signup, OTP or OAuth signup, and the admin API
--   that the `create-user` Edge Function calls) now gets role 'driver', is_active = false, its
--   placeholder name 'Pending user <id>', and a login ban (auth.users.banned_until, as deactivation sets it), whatever
--   the metadata says (Supabase dashboard Add/Invite user lands here too). The ban refuses later
--   sign-ins and refreshes; a token issued during the signup request itself (autoconfirm on)
--   lives until it expires, so the inactive profile is the real boundary. An inactive profile passes none of is_admin / is_sales_rep /
--   is_driver / is_applicator, and every RLS policy that reads profiles.role also reads is_active
--   (live read 2026-10-22); 'driver' is the narrowest role for the five SECURITY DEFINER functions
--   that read role without is_active (live bodies read 2026-10-22): get_team_board_deliveries and
--   get_yesterday_delivery_recap give a non-admin, non-sales caller only deliveries assigned to
--   them (none for a new user; the board's unassigned count is shown to any role, unchanged),
--   mark_inventory_row_verified requires admin, and the two _replay_impl_20261015 bodies are not
--   executable by authenticated. So the role grants a new login nothing those functions hide. The Settings
--   page's Create User flow then sets the role and name the admin chose and activates the user
--   through `admin_update_profile` (admin-only, idempotent), in the same click; activation clears
--   the ban through the existing `_sync_auth_access_on_profile_active` trigger.
--
--   The two signals look the same in the metadata, so the trigger tells them apart by who is
--   connected: `session_user` (current_user is the owner inside SECURITY DEFINER). The Auth service
--   writes as `supabase_auth_admin` (live pg_stat_statements, 2026-10-22: every INSERT/UPDATE on
--   auth tables runs as that role). Only a direct SQL session as `postgres` or `supabase_admin`,
--   principals that can already write profiles.role directly, keeps the old metadata behaviour
--   (the real-schema provers' user seeds use it), and only while no SET ROLE is in effect
--   (current_setting('role') = 'none'): a service that logs in as postgres/supabase_admin and then
--   switches role is not trusted (Luna, 2026-10-22).
--   Any other session, including an unknown one, gets the safe default: the test fails closed.
--
-- NOT CHANGED: the `create-user` Edge Function (it still sends the role as metadata; the trigger
--   ignores it), Auth settings, `_guard_profile_role_lock`, `admin_update_profile`, the trigger
--   `on_auth_user_created`, and existing profiles (no rows change). CREATE OR REPLACE keeps the
--   function's OID, owner (postgres) and ACL.
--
-- DEPLOY WINDOW: between this apply and the Settings page deploy, a user an admin creates arrives
--   as an inactive driver named 'Pending user <id>'; the admin opens the user, sets name and role and marks
--   them active.
--
-- ORDERING: lands right after #1018 (20261022022000, row 968) and before 025000 (swap A), 030000 (cost lock B),
--   040000 (#1026) and 050000 (#1024) (Mason, 2026-10-22: "Move #1039 ahead"). Re-read the live ledger first.

SET LOCAL lock_timeout = '5s';
-- pg_get_triggerdef omits a schema only when it is on the search_path; fix it for this transaction
-- so the trigger pin reads the same on every client.
SET LOCAL search_path = public, pg_temp;

CREATE TEMP TABLE handle_new_user_signup_role_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  v_src text;
  v_trg text;
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  -- Two IFs: PL/pgSQL plans the whole OR, so the table must exist before it is read.
  IF to_regclass('pg_temp.handle_new_user_signup_role_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.handle_new_user_signup_role_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;

  -- ORDERING (Codex App P1 on #1039): this stamp sits right after #1018's 20261022022000, which
  -- is not in this branch. Applying first would move the live high-water past it and strand it,
  -- so refuse until its ledger row exists (by name: the apply-time version differs).
  IF NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
     WHERE name IN ('20261022022000_post_binds_reviewed_invoice_version', 'post_binds_reviewed_invoice_version')
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: apply 20261022022000_post_binds_reviewed_invoice_version (#1018) first';
  END IF;

  IF (SELECT count(*) FROM pg_proc WHERE proname = 'handle_new_user' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: public.handle_new_user must have exactly one overload';
  END IF;

  SELECT md5(replace(prosrc, chr(13), '')) INTO v_src
    FROM pg_proc WHERE oid = to_regprocedure('public.handle_new_user()');
  IF v_src IS DISTINCT FROM '7a7df4959435e28126e1c4ad14f6c26a' THEN
    -- Already applied, or live drifted from the body this file was written against.
    RAISE EXCEPTION 'HANDLE_NEW_USER_BASELINE_DRIFT: %', v_src;
  END IF;

  SELECT pg_get_triggerdef(t.oid) INTO v_trg
    FROM pg_trigger t
   WHERE t.tgrelid = 'auth.users'::regclass AND t.tgname = 'on_auth_user_created' AND NOT t.tgisinternal
     AND t.tgenabled IN ('O', 'A');
  IF v_trg IS DISTINCT FROM 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user()' THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: on_auth_user_created is not the expected enabled AFTER INSERT trigger: %', v_trg;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  -- session_user, not current_user: inside SECURITY DEFINER current_user is the owner. Only a
  -- direct SQL session as postgres or supabase_admin may set the role through metadata; the Auth
  -- service (supabase_auth_admin) and anything else get an inactive driver until an admin assigns
  -- the role. The role setting must also be unset: a session that logged in as postgres or
  -- supabase_admin and then ran SET ROLE (to supabase_auth_admin or anyone) is not trusted.
  IF session_user IN ('postgres', 'supabase_admin') AND current_setting('role') = 'none' THEN
    INSERT INTO profiles (id, email, full_name, role)
    VALUES (
      NEW.id,
      NEW.email,
      COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
      COALESCE(NEW.raw_user_meta_data->>'role', 'sales_rep')
    );
  ELSE
    -- A placeholder name derived from the new id, not the metadata name: a stranger must not be
    -- able to pose as an expected hire or take a real person's name, and the placeholder must not
    -- collide with any existing name (uq_profiles_full_name_ci is global and case-insensitive; an
    -- email can equal another profile's name). Settings sets the real name on activation.
    INSERT INTO profiles (id, email, full_name, role, is_active)
    VALUES (NEW.id, NEW.email, 'Pending user ' || NEW.id::text, 'driver', false);

    -- Ban the login too, as deactivation does (_sync_auth_access_on_profile_active fires on
    -- UPDATE only): later sign-ins and token refreshes are refused. A token the Auth service
    -- issues inside this same signup request is not; the inactive profile is the guard there.
    -- Activation (is_active false -> true) clears the ban through that trigger.
    -- A finite far-future timestamp, not 'infinity', which GoTrue cannot decode.
    UPDATE auth.users
       SET banned_until = timestamptz '9999-12-31 23:59:59+00'
     WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'AFTER INSERT ON auth.users: creates the profile. Users created through the Auth service (signup or admin API) start as an inactive driver whatever their metadata says; an admin sets the role and activates them (admin_update_profile). Only direct postgres/supabase_admin SQL with no SET ROLE in effect may set the role through metadata.';

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  IF to_regclass('pg_temp.handle_new_user_signup_role_tx') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.handle_new_user_signup_role_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;

  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
         md5(replace(p.prosrc, chr(13), '')) AS body_md5
    INTO v_fn
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.handle_new_user()');
  IF NOT v_fn.prosecdef OR v_fn.owner <> 'postgres'
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.body_md5 IS DISTINCT FROM '737785431fdbfc9b6b38c1ed6f2cd0f4' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: handle_new_user is not the expected body/attributes';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: handle_new_user ignores signup metadata role (acl %)', v_fn.acl;
END;
$postflight$;
