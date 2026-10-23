-- Written 2026-10-23. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 981). Stamp and row assigned by the CRX Coordinator
-- session 2026-10-23: lands after #1050 (20261022085000) and #1066 (20261022086000), before #1057
-- (20261022090000). Re-read the live ledger first.
--
-- idempotency-body-check: exempt -- this file adds a trigger function, not a callable RPC; no API
--   role may execute it. The hook only recognises check_idempotency().
--
-- WHAT: PR #1060 follow-up (Mason chose the database check, 2026-10-23). The Job Detail screen
--   now leaves a chemical line's price BLANK when its product states no price (no price for the
--   job customer's tier and no tier-1 price) and refuses the save until one is typed. The browser
--   still turns a blank price into 0 (buildJobChemicalsPayload), and job_chemicals has other
--   writers too (load_recipe_into_job, create_job_from_quote_section, and staff's direct
--   INSERT/UPDATE policies), so an older app or a direct call could store that line billing $0.
--   A trigger on job_chemicals now refuses it, whichever path writes the row:
--     CHEM_PRICE_REQUIRED: a line that bills (not customer supplied, quantity not 0) priced 0 (or
--     NULL) whose product states no price for the job customer's tier (own tier price, else
--     tier 1; a stated $0 counts as a price, as getStatedTierPriceCents in src/lib/quoteCalc.ts).
--   The tier is the line's job's customer; a missing tier counts as tier 1.
--
-- HOW: BEFORE INSERT OR UPDATE OF job_id, product_id, quantity, price_per_unit_cents,
--   customer_supplied ON job_chemicals, FOR EACH ROW. The function is SECURITY DEFINER so the
--   caller's row-level security cannot hide the customer or product and make a priced product
--   look unpriced; no API role may execute it directly. save_job writes its job row before its
--   chemical rows, so the job's customer is the one being saved. A save_job replay answered from
--   its receipt writes no rows, so it is unaffected. Only callers already allowed to write
--   job_chemicals can reach the refusal, and its text names only the product.
--
-- NOT CHANGED: save_job and every other function; RLS policies; grants on existing objects;
--   existing rows (an UPDATE that does not touch the five columns does not fire the trigger).
--   Live read 2026-10-23: 0 of the 4 job_chemicals rows on undeleted jobs, and 0 of the 21 open
--   quote lines (draft/sent/accepted), are an unpriced product at 0, so no current job or
--   scheduling from a quote is refused.
--
-- LIMITS (accepted): the rule is checked when a line is written. A line saved at $0 for a product
--   that had a price, whose price is later cleared (or whose job's customer later moves to a tier
--   with no price), stays as it is until the job is saved again; that save is then refused until
--   a price is typed. A quote line for an unpriced product at $0 is refused when the job is
--   scheduled from it; the message says to price the quote line. To give away a product CRX does
--   not price, give it a $0 price (a stated $0 is a price).
--
-- CALLERS (every app caller of a function whose behaviour changes here, checked 2026-10-23):
-- caller-analysis: save_job :: JobDetail.tsx; a billable line whose product states no price must carry a price, else CHEM_PRICE_REQUIRED (the screen already refuses it first)
-- caller-analysis: create_job_from_quote_section :: QuoteBuilder.tsx; an accepted quote line for a product with no price, priced $0, is refused when scheduled (0 such lines live)
-- caller-analysis: load_recipe_into_job :: none (the app loads recipes client-side)
--
-- LIVE EVIDENCE (read-only, 2026-10-23): job_chemicals has job_id uuid NOT NULL, product_id uuid
--   NOT NULL, quantity numeric NOT NULL, price_per_unit_cents bigint NULL, customer_supplied
--   boolean NOT NULL, and three triggers (trg_sync_job_holds_del/_ins/_upd); none named
--   job_chemicals_price_required.
--
-- ROLLBACK: DROP TRIGGER job_chemicals_price_required ON public.job_chemicals;
--   DROP FUNCTION public._job_chemical_price_required(). No data to restore.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE job_chemical_price_required_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.job_chemical_price_required_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.job_chemical_price_required_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF to_regproc('public._job_chemical_price_required') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.job_chemicals'::regclass
                  AND tgname = 'job_chemicals_price_required') THEN
    -- Already applied.
    RAISE EXCEPTION 'JOB_CHEMICAL_PRICE_REQUIRED_EXISTS: this migration has already run';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'job_chemicals'
         AND (column_name, data_type) IN (('job_id', 'uuid'), ('product_id', 'uuid'),
              ('quantity', 'numeric'), ('price_per_unit_cents', 'bigint'),
              ('customer_supplied', 'boolean'))) <> 5
     OR (SELECT count(*) FROM information_schema.columns
          WHERE table_schema = 'public'
            AND ((table_name = 'jobs' AND column_name = 'customer_id')
              OR (table_name = 'customers' AND column_name = 'assigned_tier')
              OR (table_name = 'products' AND column_name IN ('product_name', 'tier1_price', 'tier2_price', 'tier3_price')))) <> 6 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: job_chemicals, jobs, customers or products columns are not as read 2026-10-23';
  END IF;
END;
$preflight$;

CREATE FUNCTION public._job_chemical_price_required()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_tier integer;
  v_product_name text;
  v_stated numeric;
BEGIN
  -- Only a line that bills at 0 is checked (PR #1060).
  IF COALESCE(NEW.customer_supplied, false)
     OR COALESCE(NEW.quantity, 0) = 0
     OR COALESCE(NEW.price_per_unit_cents, 0) <> 0
     OR NEW.product_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT c.assigned_tier INTO v_tier
    FROM jobs j JOIN customers c ON c.id = j.customer_id
   WHERE j.id = NEW.job_id;
  SELECT p.product_name,
         COALESCE(CASE COALESCE(v_tier, 1) WHEN 3 THEN p.tier3_price WHEN 2 THEN p.tier2_price ELSE p.tier1_price END,
                  p.tier1_price)
    INTO v_product_name, v_stated
    FROM products p WHERE p.id = NEW.product_id;
  IF FOUND AND v_stated IS NULL THEN
    RAISE EXCEPTION
      'CHEM_PRICE_REQUIRED: % has no price for this customer''s tier, so its line would bill $0. Enter a price for the line (on a quote, the quote line''s price), tick Customer supplied if the grower supplied it, or give the product a $0 price if you give it away.',
      COALESCE(v_product_name, 'A product')
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION public._job_chemical_price_required() OWNER TO postgres;
REVOKE ALL ON FUNCTION public._job_chemical_price_required() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER job_chemicals_price_required
  BEFORE INSERT OR UPDATE OF job_id, product_id, quantity, price_per_unit_cents, customer_supplied
  ON public.job_chemicals
  FOR EACH ROW EXECUTE FUNCTION public._job_chemical_price_required();

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  IF to_regclass('pg_temp.job_chemical_price_required_tx') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.job_chemical_price_required_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
         md5(replace(p.prosrc, chr(13), '')) AS body_md5
    INTO v_fn
    FROM pg_proc p WHERE p.oid = to_regprocedure('public._job_chemical_price_required()');
  IF NOT FOUND OR NOT v_fn.prosecdef OR v_fn.owner <> 'postgres'
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.acl IS DISTINCT FROM '{postgres=X/postgres}'
     OR v_fn.body_md5 IS DISTINCT FROM '3a09059290d9bb1093b518e3dfd11649' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: public._job_chemical_price_required is not the expected body/attributes (md5 %, acl %)', v_fn.body_md5, v_fn.acl;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.job_chemicals'::regclass AND t.tgname = 'job_chemicals_price_required'
       AND t.tgenabled = 'O' AND t.tgfoid = to_regprocedure('public._job_chemical_price_required()')) THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: trigger job_chemicals_price_required is missing or not enabled';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: job_chemicals refuses a billable unpriced line at 0';
END;
$postflight$;
