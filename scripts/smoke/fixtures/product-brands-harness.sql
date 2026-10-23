-- Real-shape harness for prove-product-brands.mjs: the roles, auth.uid(), tables and helper
-- functions 20261022086500_product_brands.sql depends on. Helper bodies are the live definitions
-- read with pg_get_functiondef on 2026-10-22; tables carry only the columns the migration touches.
-- Default privileges copy Supabase's (every new table and function granted to the API roles), so
-- the migration's own REVOKEs and its postflight are exercised for real.

-- Roles are cluster-wide; the prover loads this harness into more than one database.
DO $roles$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'metabase_ro'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', v_role);
    END IF;
  END LOOP;
END;
$roles$;

CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto SCHEMA extensions;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth, extensions TO anon, authenticated, service_role, metabase_ro;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, metabase_ro;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO metabase_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  role text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.products (
  id uuid PRIMARY KEY,
  product_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  operation text NOT NULL,
  result jsonb,
  created_at timestamptz DEFAULT now(),
  expires_at timestamptz DEFAULT (now() + '24:00:00'::interval),
  request_fingerprint text,
  request_actor_id uuid
);
REVOKE ALL ON TABLE public.idempotency_keys FROM anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = (SELECT auth.uid())
       AND role = 'admin'
       AND is_active = true
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_active_profile()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = (SELECT auth.uid())
       AND is_active = true
  )
$function$;

CREATE OR REPLACE FUNCTION public._replay_fingerprint_20261015(p_request jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT encode(extensions.digest(convert_to(p_request::text, 'UTF8'), 'sha256'), 'hex');
$function$;

CREATE OR REPLACE FUNCTION public.check_idempotency_intent(p_key text, p_operation text, p_actor uuid, p_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_existing public.idempotency_keys%ROWTYPE;
BEGIN
  IF p_key IS NULL THEN
    RETURN NULL;
  END IF;
  IF btrim(p_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_REQUIRED';
  END IF;
  IF p_fingerprint IS NULL OR btrim(p_fingerprint) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_FINGERPRINT_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_key, 0)
  );

  DELETE FROM public.idempotency_keys
   WHERE idempotency_key = p_key
     AND expires_at < now();

  SELECT * INTO v_existing
    FROM public.idempotency_keys
   WHERE idempotency_key = p_key;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_existing.operation IS DISTINCT FROM p_operation THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
      p_key, v_existing.operation, p_operation;
  END IF;

  IF v_existing.request_actor_id IS NULL
     AND v_existing.request_fingerprint IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object(
              'operation', v_existing.operation,
              'result', v_existing.result
            )::text;
  END IF;

  IF v_existing.request_actor_id IS DISTINCT FROM p_actor THEN
    RAISE EXCEPTION 'IDEMPOTENCY_ACTOR_MISMATCH';
  END IF;

  IF v_existing.request_fingerprint IS DISTINCT FROM p_fingerprint THEN
    RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'
      USING ERRCODE = '22023',
            DETAIL = jsonb_build_object(
              'operation', v_existing.operation,
              'result', v_existing.result
            )::text;
  END IF;

  RETURN jsonb_build_object('found', true, 'result', v_existing.result);
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_idempotency(p_key text, p_operation text, p_result jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_existing_op text;
BEGIN
  IF p_key IS NULL OR btrim(p_key) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED';
  END IF;
  IF p_operation IS NULL OR btrim(p_operation) = '' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_OPERATION_REQUIRED';
  END IF;

  SELECT operation INTO v_existing_op
  FROM public.idempotency_keys
  WHERE idempotency_key = p_key
    AND operation <> p_operation
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_CROSS_OP_KEY_REUSE: idempotency_key % is already in use for operation %; cannot reuse it for operation %',
      p_key, v_existing_op, p_operation;
  END IF;

  INSERT INTO public.idempotency_keys (idempotency_key, operation, result)
  VALUES (p_key, p_operation, p_result)
  ON CONFLICT (idempotency_key) DO NOTHING;
END;
$function$;

CREATE OR REPLACE FUNCTION public._bind_replay_receipt_20261015(p_key text, p_operation text, p_fingerprint text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  UPDATE public.idempotency_keys
     SET request_actor_id = v_actor,
         request_fingerprint = p_fingerprint
   WHERE idempotency_key = p_key
     AND operation = p_operation
     AND request_actor_id IS NULL
     AND request_fingerprint IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING'
      USING DETAIL = format('%s wrote no receipt to bind for this key', p_operation);
  END IF;
END;
$function$;

-- Live grants on the helpers: the API roles may not call the receipt writers directly.
REVOKE ALL ON FUNCTION public.check_idempotency_intent(text, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.save_idempotency(text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._bind_replay_receipt_20261015(text, text, text) FROM PUBLIC, anon, authenticated, service_role;

-- People and products the tests act as / on.
INSERT INTO public.profiles (id, role, is_active) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'admin', true),
  ('00000000-0000-0000-0000-00000000000b', 'admin', false),
  ('00000000-0000-0000-0000-00000000000c', 'sales_rep', true),
  ('00000000-0000-0000-0000-00000000000d', 'driver', false);
INSERT INTO public.products (id, product_name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4) - 2.5 Gal'),
  ('00000000-0000-0000-0000-0000000000a2', 'Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4) - Bulk');
