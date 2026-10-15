-- ============================================================================
-- CONTAINER ONLY smoke chain for 20261015200000_quotes_rep_own_name.
-- Run through scripts/smoke/prove-quotes-rep-own-name-real-schema.mjs, never against the live
-- database: season rollover draws a customer-visible quote number from a sequence that a rollback
-- does not return.
--
-- Rule under test (Mason, 2026-10-15): a sales rep records only themselves (or no one) as a
-- quote's salesperson and changes one only from blank to themselves; admins are unrestricted; an
-- update that leaves the salesperson alone is never refused; season rollover keeps the original
-- rep on the new season's quote, and that exception cannot be claimed outside the rollover.
--
-- Runs as the table owner with request.jwt.claims switched between an admin and a rep, so the
-- guard sees the same auth.uid() it sees on live; the rep's INSERT and UPDATE are also tried as the
-- authenticated role through Row Level Security, the way the browser reaches them. Terminal
-- SMOKE_PASS_ROLLBACK.
-- ============================================================================
DO $smoke$
DECLARE
  v_admin uuid;
  v_rep uuid;
  v_other_rep uuid;
  v_suffix text := substr(md5(random()::text), 1, 8);
  v_customer uuid;
  v_q_other uuid;
  v_q_blank uuid;
  v_q_own uuid;
  v_res jsonb;
  v_new uuid;
  v_err text;
BEGIN
  SELECT id INTO v_admin FROM public.profiles
   WHERE role = 'admin' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_rep FROM public.profiles
   WHERE role = 'sales_rep' AND is_active = true ORDER BY created_at, id LIMIT 1;
  SELECT id INTO v_other_rep FROM public.profiles
   WHERE role = 'sales_rep' AND is_active = true AND id IS DISTINCT FROM v_rep
   ORDER BY created_at, id LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL OR v_other_rep IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: an active admin and two active sales reps are required';
  END IF;

  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);

  INSERT INTO public.customers (farm_name, assigned_sales_rep, assigned_tier)
  VALUES ('[E2E] Quote Salesman Farm ' || v_suffix, v_other_rep, 1) RETURNING id INTO v_customer;

  -- Quotes the rep created, inserted by the admin: one naming the other rep, one blank, one the
  -- rep's own. The admin naming a rep is itself a check: only sales reps are held to their own name.
  BEGIN
    INSERT INTO public.quotes (quote_number, customer_id, created_by, status, season, salesman_id)
    VALUES ('E2E-QSN-OTHER-' || v_suffix, v_customer, v_rep, 'draft', public.current_season(), v_other_rep)
    RETURNING id INTO v_q_other;
    INSERT INTO public.quotes (quote_number, customer_id, created_by, status, season, salesman_id)
    VALUES ('E2E-QSN-BLANK-' || v_suffix, v_customer, v_rep, 'draft', public.current_season(), NULL)
    RETURNING id INTO v_q_blank;
    INSERT INTO public.quotes (quote_number, customer_id, created_by, status, season, salesman_id)
    VALUES ('E2E-QSN-OWN-' || v_suffix, v_customer, v_rep, 'draft', public.current_season(), v_rep)
    RETURNING id INTO v_q_own;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: an admin could not name a sales rep on a new quote';
    END IF;
    RAISE;
  END;

  -- From here on, the rep.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);

  -- 1. A rep cannot create a quote naming another rep: as the owner (the path every definer RPC
  --    takes) and as the authenticated role through quotes_insert (the browser's path).
  BEGIN
    INSERT INTO public.quotes (quote_number, customer_id, created_by, status, season, salesman_id)
    VALUES ('E2E-QSN-1-' || v_suffix, v_customer, v_rep, 'draft', public.current_season(), v_other_rep);
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep created a quote under another rep''s name';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong quote-insert refusal: %', v_err;
    END IF;
  END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO public.quotes (quote_number, customer_id, created_by, status, season, salesman_id)
    VALUES ('E2E-QSN-1B-' || v_suffix, v_customer, v_rep, 'draft', public.current_season(), v_admin);
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep created a quote naming an admin through the Data API';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong Data API quote-insert refusal: %', v_err;
    END IF;
  END;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'SMOKE_SETUP: SET LOCAL ROLE did not end with its sub-block (current_user %)', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM public.quotes WHERE quote_number IN ('E2E-QSN-1-' || v_suffix, 'E2E-QSN-1B-' || v_suffix)) THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused quote insert left a row';
  END IF;

  -- 2. A rep creates quotes under their own name or none, also through the Data API.
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, season, salesman_id)
  VALUES ('E2E-QSN-2A-' || v_suffix, v_customer, v_rep, 'draft', public.current_season(), v_rep);
  INSERT INTO public.quotes (quote_number, customer_id, created_by, status, season, salesman_id)
  VALUES ('E2E-QSN-2B-' || v_suffix, v_customer, v_rep, 'draft', public.current_season(), NULL);
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO public.quotes (quote_number, customer_id, created_by, status, season, salesman_id)
    VALUES ('E2E-QSN-2C-' || v_suffix, v_customer, v_rep, 'draft', public.current_season(), v_rep);
    RAISE EXCEPTION 'SMOKE_STEP_OK';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err IS DISTINCT FROM 'SMOKE_STEP_OK' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: a sales rep could not create a quote under their own name through the Data API: %', v_err;
    END IF;
  END;
  IF (SELECT count(*) FROM public.quotes WHERE quote_number IN ('E2E-QSN-2A-' || v_suffix, 'E2E-QSN-2B-' || v_suffix)) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep could not create a quote under their own name or none';
  END IF;

  -- 3. A rep's salesperson changes: another rep's name is never replaced or cleared, a blank is
  --    never filled with someone else, the rep's own name is never handed to someone else. Tried
  --    through quotes_update as the authenticated role (the rep created all three quotes).
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.quotes SET salesman_id = v_rep WHERE id = v_q_other;
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep took over another rep''s quote';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong take-over refusal: %', v_err;
    END IF;
  END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.quotes SET salesman_id = NULL WHERE id = v_q_other;
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep cleared another rep''s name from a quote';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong clear refusal: %', v_err;
    END IF;
  END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.quotes SET salesman_id = v_other_rep WHERE id = v_q_blank;
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep filled a blank quote salesperson with another rep';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong blank-fill refusal: %', v_err;
    END IF;
  END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.quotes SET salesman_id = v_other_rep WHERE id = v_q_own;
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep handed their own quote to another rep';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong hand-off refusal: %', v_err;
    END IF;
  END;
  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
    UPDATE public.quotes SET salesman_id = NULL WHERE id = v_q_own;
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep cleared their own name from a quote';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong own-clear refusal: %', v_err;
    END IF;
  END;
  IF (SELECT salesman_id FROM public.quotes WHERE id = v_q_other) IS DISTINCT FROM v_other_rep
     OR (SELECT salesman_id FROM public.quotes WHERE id = v_q_blank) IS NOT NULL
     OR (SELECT salesman_id FROM public.quotes WHERE id = v_q_own) IS DISTINCT FROM v_rep THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a refused quote salesperson change left a row changed';
  END IF;
  -- A blank is filled with the rep's own name.
  UPDATE public.quotes SET salesman_id = v_rep WHERE id = v_q_blank;
  IF (SELECT salesman_id FROM public.quotes WHERE id = v_q_blank) IS DISTINCT FROM v_rep THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep could not fill a blank quote salesperson with themselves';
  END IF;

  -- 4. An update that leaves another rep's salesperson alone is never refused (definer RPCs update
  --    quotes for other reasons while a rep is signed in).
  BEGIN
    UPDATE public.quotes SET salesman_id = salesman_id, header_notes = '[E2E] touched' WHERE id = v_q_other;
  EXCEPTION WHEN raise_exception THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an update that left another rep''s salesperson alone was refused: %', SQLERRM;
  END;

  -- 5. Season rollover keeps the original rep, also when a rep rolls over another rep's quote.
  BEGIN
    v_res := public.rollover_quote_to_season(v_q_other, public.current_season() + 1, v_rep, NULL);
  EXCEPTION WHEN raise_exception THEN
    RAISE EXCEPTION 'SMOKE_FAIL: a sales rep could not roll over another rep''s quote: %', SQLERRM;
  END;
  v_new := (v_res->>'quote_id')::uuid;
  IF v_new IS NULL OR (SELECT salesman_id FROM public.quotes WHERE id = v_new) IS DISTINCT FROM v_other_rep THEN
    RAISE EXCEPTION 'SMOKE_FAIL: season rollover did not keep the original rep: %', v_res;
  END IF;

  -- 6. The rollover exception cannot be claimed outside the rollover: the marker is cleared once
  --    the rollover's insert is done, and a marker accepts only its source quote's salesperson.
  BEGIN
    INSERT INTO public.quotes (quote_number, customer_id, created_by, status, season, salesman_id)
    VALUES ('E2E-QSN-6A-' || v_suffix, v_customer, v_rep, 'draft', public.current_season(), v_other_rep);
    RAISE EXCEPTION 'SMOKE_FAIL: the rollover exception outlived the rollover';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong after-rollover refusal: %', v_err;
    END IF;
  END;
  -- The chain sets the marker itself here (no Data API request can): a marker accepts only the
  -- salesperson its source quote carries.
  BEGIN
    PERFORM set_config('crx.quote_rollover_source', v_q_own::text, true);
    INSERT INTO public.quotes (quote_number, customer_id, created_by, status, season, salesman_id)
    VALUES ('E2E-QSN-6B-' || v_suffix, v_customer, v_rep, 'draft', public.current_season(), v_other_rep);
    RAISE EXCEPTION 'SMOKE_FAIL: a rollover marker accepted a salesperson its source quote does not carry';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_err LIKE 'SMOKE_FAIL:%' THEN RAISE; END IF;
    IF v_err IS DISTINCT FROM 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: wrong source-quote marker refusal: %', v_err;
    END IF;
  END;
  PERFORM set_config('crx.quote_rollover_source', '', true);

  -- 7. An admin is unrestricted: rolls over, reassigns and names anyone.
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  v_res := public.rollover_quote_to_season(v_q_own, public.current_season() + 1, v_admin, NULL);
  IF (SELECT salesman_id FROM public.quotes WHERE id = (v_res->>'quote_id')::uuid) IS DISTINCT FROM v_rep THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an admin''s season rollover did not keep the original rep: %', v_res;
  END IF;
  BEGIN
    UPDATE public.quotes SET salesman_id = v_rep WHERE id = v_q_other;
    UPDATE public.quotes SET salesman_id = NULL WHERE id = v_q_own;
    INSERT INTO public.quotes (quote_number, customer_id, created_by, status, season, salesman_id)
    VALUES ('E2E-QSN-7-' || v_suffix, v_customer, v_admin, 'draft', public.current_season(), v_other_rep);
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'SALESMAN_SCOPE_DENIED' THEN
      RAISE EXCEPTION 'SMOKE_FAIL: an admin could not reassign a quote''s salesperson';
    END IF;
    RAISE;
  END;
  IF (SELECT salesman_id FROM public.quotes WHERE id = v_q_other) IS DISTINCT FROM v_rep
     OR (SELECT salesman_id FROM public.quotes WHERE id = v_q_own) IS NOT NULL THEN
    RAISE EXCEPTION 'SMOKE_FAIL: an admin could not reassign a quote''s salesperson';
  END IF;

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$smoke$;
