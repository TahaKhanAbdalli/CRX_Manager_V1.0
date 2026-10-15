-- Smoke chain: staff photo storage access (REQUIRES 20261015230000). One DO block; it always ends
-- in SMOKE_PASS_ROLLBACK, so none of the probe objects below is kept (they are catalog rows only;
-- no file is uploaded).
-- Proves, as real signed-in sessions (role authenticated with each live profile's claims) and as a
-- signed-out visitor (anon), exactly the storage.objects queries Supabase Storage runs for a
-- download (SELECT), an upload (INSERT) and a delete (DELETE):
--   * delivery-photos: an admin uploads a probe into a delivery assigned to an active driver; that
--     driver and a sales rep see it; another driver, an applicator, a commission-recipient profile
--     and a signed-out visitor do not; the driver cannot upload into another driver's delivery;
--     a rep's delete of it removes nothing, an admin's removes it (matching the admin-only row policy).
--   * receiving-photos: a rep sees an admin's probe; a driver and an applicator do not; a rep's
--     delete removes nothing, an admin's removes it.
--   * team-note-attachments: a driver uploads into their own folder and an applicator sees it; a
--     commission-recipient profile does not; the driver cannot upload into another user's folder;
--     the uploader deletes their own file. The driver records an attachment row for their own
--     file, but not one naming a file in another user's folder (an admin deleting such a row would
--     otherwise delete that file).
-- Deletes are made the way Storage makes them: storage.allow_delete_query set for the transaction,
-- then a DELETE as the signed-in user (live's storage.protect_delete refuses any other).
-- Deactivated accounts are proven by the disposable-database prover
-- (scripts/smoke/prove-staff-photo-storage-access-real-schema.mjs); no profile row is changed here.
DO $$
DECLARE
  v_admin uuid; v_rep uuid; v_driver uuid; v_driver_b uuid; v_applicator uuid; v_entity uuid;
  v_delivery uuid; v_delivery_b uuid; v_note uuid;
  v_note_url text := 'https://rhyzpcqhnizqbxphqdkr.supabase.co/storage/v1/object/public/team-note-attachments/';
  v_tag text := 'smoke-' || replace(gen_random_uuid()::text, '-', '');
  v_del_obj text; v_recv_obj text; v_note_obj text;
  v_rows bigint;
  v_denied boolean;
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
       AND policyname IN ('staff_photos_delivery_select', 'staff_photos_receiving_select', 'staff_photos_team_note_select')) <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL: the three staff photo read policies are not installed';
  END IF;

  SELECT id INTO v_admin FROM public.profiles WHERE role = 'admin' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_rep FROM public.profiles WHERE role = 'sales_rep' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_applicator FROM public.profiles WHERE role = 'applicator' AND is_active ORDER BY created_at LIMIT 1;
  SELECT id INTO v_entity FROM public.profiles WHERE role = 'entity_recipient' AND is_active ORDER BY created_at LIMIT 1;
  SELECT d.id, d.assigned_driver INTO v_delivery, v_driver
    FROM public.deliveries d JOIN public.profiles p ON p.id = d.assigned_driver
   WHERE p.role = 'driver' AND p.is_active
   ORDER BY d.created_at DESC LIMIT 1;
  SELECT id INTO v_driver_b FROM public.profiles
   WHERE role = 'driver' AND is_active AND id IS DISTINCT FROM v_driver ORDER BY created_at LIMIT 1;
  SELECT d.id INTO v_delivery_b FROM public.deliveries d
   WHERE d.assigned_driver IS DISTINCT FROM v_driver ORDER BY d.created_at DESC LIMIT 1;
  SELECT id INTO v_note FROM public.team_notes ORDER BY created_at DESC LIMIT 1;
  IF v_admin IS NULL OR v_rep IS NULL OR v_applicator IS NULL OR v_entity IS NULL OR v_driver IS NULL
     OR v_driver_b IS NULL OR v_delivery IS NULL OR v_delivery_b IS NULL OR v_note IS NULL THEN
    RAISE EXCEPTION 'SMOKE_SETUP: missing a live role, a delivery assigned to an active driver or a team note';
  END IF;
  -- Storage runs a delete as the signed-in user after setting storage.allow_delete_query (live's
  -- storage.protect_delete trigger refuses any other direct DELETE). Do the same, so row-level
  -- security alone decides which rows each DELETE below reaches. Transaction-local; rolled back.
  PERFORM set_config('storage.allow_delete_query', 'true', true);
  v_del_obj := 'delivery-photos/' || v_delivery::text || '/' || v_tag || '.jpg';
  v_recv_obj := 'receiving-photos/' || v_tag || '/' || v_tag || '.jpg';
  v_note_obj := 'team-note-attachments/' || v_driver::text || '/' || v_tag || '.jpg';

  -- Admin uploads the delivery and receiving probes.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO storage.objects (bucket_id, name, owner_id, metadata) VALUES
    ('delivery-photos', v_del_obj, v_admin::text, '{"mimetype":"image/jpeg","size":1}'::jsonb),
    ('receiving-photos', v_recv_obj, v_admin::text, '{"mimetype":"image/jpeg","size":1}'::jsonb);
  EXECUTE 'RESET ROLE';

  -- The assigned driver uploads a team-note probe into their own folder, and is refused elsewhere.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO storage.objects (bucket_id, name, owner_id, metadata)
    VALUES ('team-note-attachments', v_note_obj, v_driver::text, '{"mimetype":"image/jpeg","size":1}'::jsonb);
  SELECT count(*) INTO v_rows FROM storage.objects WHERE name = v_del_obj;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: the assigned driver cannot see their delivery photo'; END IF;
  SELECT count(*) INTO v_rows FROM storage.objects WHERE name = v_recv_obj;
  IF v_rows <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: a driver can see a receiving photo'; END IF;
  EXECUTE 'RESET ROLE';
  v_denied := false;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO storage.objects (bucket_id, name, owner_id)
      VALUES ('delivery-photos', 'delivery-photos/' || v_delivery_b::text || '/' || v_tag || '-x.jpg', v_driver::text);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'SMOKE_FAIL: a driver uploaded into another driver''s delivery'; END IF;
  v_denied := false;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO storage.objects (bucket_id, name, owner_id)
      VALUES ('team-note-attachments', 'team-note-attachments/' || v_rep::text || '/' || v_tag || '-x.jpg', v_driver::text);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'SMOKE_FAIL: a driver uploaded into another user''s team-note folder'; END IF;

  -- Attachment rows: the driver records their own probe, and is refused a row naming the rep's folder.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  INSERT INTO public.team_note_attachments (note_id, file_url, file_name, file_type, file_size_bytes, uploaded_by)
    VALUES (v_note, v_note_url || v_note_obj, v_tag || '.jpg', 'image/jpeg', 1, v_driver);
  EXECUTE 'RESET ROLE';
  v_denied := false;
  BEGIN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    INSERT INTO public.team_note_attachments (note_id, file_url, file_name, file_type, file_size_bytes, uploaded_by)
      VALUES (v_note, v_note_url || 'team-note-attachments/' || v_rep::text || '/' || v_tag || '.jpg', v_tag || '.jpg', 'image/jpeg', 1, v_driver);
    EXECUTE 'RESET ROLE';
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'SMOKE_FAIL: a driver recorded an attachment row naming another user''s photo'; END IF;

  -- Sales rep: sees all three; deleting the receiving probe removes nothing.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_rep::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM storage.objects WHERE name IN (v_del_obj, v_recv_obj, v_note_obj);
  IF v_rows <> 3 THEN RAISE EXCEPTION 'SMOKE_FAIL: a sales rep sees % of the 3 probes', v_rows; END IF;
  DELETE FROM storage.objects WHERE name = v_recv_obj;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: a sales rep deleted a receiving photo'; END IF;
  DELETE FROM storage.objects WHERE name = v_del_obj;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: a sales rep deleted a delivery photo file (its row is admin-only)'; END IF;
  EXECUTE 'RESET ROLE';

  -- Another driver: none of the delivery probe; the team-note probe yes.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver_b, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_driver_b::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM storage.objects WHERE name = v_del_obj;
  IF v_rows <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: another driver sees a delivery photo not assigned to them'; END IF;
  SELECT count(*) INTO v_rows FROM storage.objects WHERE name = v_note_obj;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: another driver cannot see a team-note photo'; END IF;
  EXECUTE 'RESET ROLE';

  -- Applicator: the team-note probe only.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_applicator, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_applicator::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM storage.objects WHERE name IN (v_del_obj, v_recv_obj);
  IF v_rows <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: an applicator sees a delivery or receiving photo'; END IF;
  SELECT count(*) INTO v_rows FROM storage.objects WHERE name = v_note_obj;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: an applicator cannot see a team-note photo'; END IF;
  EXECUTE 'RESET ROLE';

  -- Commission-recipient profile: nothing.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_entity, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_entity::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_rows FROM storage.objects WHERE name IN (v_del_obj, v_recv_obj, v_note_obj);
  IF v_rows <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: a commission-recipient profile sees % photo probes', v_rows; END IF;
  EXECUTE 'RESET ROLE';

  -- Signed-out visitor: nothing.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  EXECUTE 'SET LOCAL ROLE anon';
  SELECT count(*) INTO v_rows FROM storage.objects WHERE name IN (v_del_obj, v_recv_obj, v_note_obj);
  IF v_rows <> 0 THEN RAISE EXCEPTION 'SMOKE_FAIL: a signed-out visitor sees % photo probes', v_rows; END IF;
  EXECUTE 'RESET ROLE';

  -- Deletes that must work: the uploader's own team-note file, and an admin's receiving photo.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_driver, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_driver::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  DELETE FROM storage.objects WHERE name = v_note_obj;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: the uploader cannot delete their own team-note photo'; END IF;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', v_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  DELETE FROM storage.objects WHERE name = v_recv_obj;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: an admin cannot delete a receiving photo'; END IF;
  DELETE FROM storage.objects WHERE name = v_del_obj;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'SMOKE_FAIL: an admin cannot delete a delivery photo'; END IF;
  EXECUTE 'RESET ROLE';

  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK';
END
$$;
