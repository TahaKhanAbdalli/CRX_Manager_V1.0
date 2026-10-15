-- Staff photos: who may view, upload and delete (Goal 1, docs/plans/2026-10-13-direction-and-goals.md;
-- Mason 2026-10-13: delivery, receiving and team-note photos need a sign-in to view).
--
-- Step 1 of 2. This file adds per-request storage READ policies and tightens upload and delete, while
-- the three buckets STAY PUBLIC, so the app released with it (which downloads photos with the
-- signed-in user's session instead of a public URL; it needs these read policies, so this file is
-- applied before that app ships) and the app before it both keep working. Step 2, a separate
-- migration once this release is live and old installed-app copies have updated, switches the
-- buckets to private so a copied public link stops working.
--
-- Live state measured read-only immediately before this file was written (2026-10-14):
--   * delivery-photos, receiving-photos and team-note-attachments are public with NO storage SELECT
--     policy (dropped in 20260511120100): the app reads them only through public URLs. An
--     authenticated download, which checks storage.objects SELECT policies, is refused today.
--   * Uploads: any signed-in user may upload to all three (bucket-name-only checks), including a
--     deactivated account with an unexpired token.
--   * Deletes: Storage deletes as the signed-in user, and a DELETE only reaches rows that user may
--     also SELECT, so with no SELECT policy no delete in these buckets removes anything, not even an
--     admin's (proven in the disposable-database prover with live's storage.protect_delete). The
--     team-note delete policy also read folder 1 (always the bucket name) as the user.
--   * Every storage.objects policy names a bucket (no bucket-agnostic policy exists).
--   * public.team_note_attachments: the insert policy checks only uploaded_by, so a row may name any
--     file_url, including another uploader's photo; 0 rows live.
--   * public.delivery_photos del_photos_select lets a driver read the photo rows of their assigned
--     deliveries without an active-profile check.
--   * Objects: delivery-photos 15 (every name is 'delivery-photos/<delivery id>/<file>'; 13 match a
--     delivery row), receiving-photos 0, team-note-attachments 0 (names are
--     'team-note-attachments/<uploader id>/<file>').
--
-- Rules (Mason 2026-10-14). They follow the matching table policies, except that team-note photos
-- leave out the commission-recipient profiles (the table read policy, is_active_profile(), lets them in):
--   * delivery-photos: view and upload = active admin or sales rep, or the active driver assigned to
--     the delivery in folder 2. Delete = active admin (was admin or sales rep), matching the
--     delivery_photos row policy so the file and its row can only be removed together.
--   * receiving-photos: view and upload = active admin or sales rep; delete = active admin.
--   * team-note-attachments: view = any active staff role (admin, sales rep, driver, applicator; not
--     the commission-recipient profiles); upload = active staff, into their own folder 2; delete =
--     the active uploader (folder 2) or an active admin.
--   * del_photos_select: the driver branch requires an active driver profile.
--   * team_note_attachments insert: file_url must be the public URL of a file in the inserting
--     uploader's own folder. Without it, once deletes take effect, an admin deleting a row that
--     names someone else's photo would delete that photo's file (Codex Sol on PR #929).
--
-- Behavior change to note: once applied, the delete policies take effect, so an admin's
-- delete of a delivery photo, an admin's delete of a receiving photo and an uploader's delete of
-- their own team-note photo really remove the file.
-- Accepted limitation (Mason, 2026-10-14, option A): a staff member who may view a photo can still
-- deliberately mint a temporary signed link to it through the Storage API (Storage checks only the
-- SELECT policy). Ordinary app use never creates one.
--
-- Non-destructive: no row, object or bucket setting changes. Access-changing (storage policies and
-- existing table policies), so it needs Mason's own approval of this file.
-- Rollback: revert the app first (it downloads through these read policies; without them every
-- photo shows as unavailable), then restore each policy's 2026-10-14 definition (preflight pins below):
--   DROP POLICY the three new *_select storage policies;
--   delivery_photos_insert / recv_photos_storage_upload / "Authenticated users can upload team note
--   attachments" WITH CHECK (bucket_id = '<bucket>'); recv_photos_storage_delete USING
--   (bucket_id = 'receiving-photos'); "Users can delete own team note attachments" USING
--   ((bucket_id = 'team-note-attachments') AND (((storage.foldername(name))[1] = ((SELECT auth.uid()))::text)
--   OR EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role = 'admin' AND is_active)));
--   del_photos_select USING (is_admin() OR is_sales_rep() OR EXISTS (SELECT 1 FROM deliveries d
--   WHERE d.id = delivery_photos.delivery_id AND d.assigned_driver = (SELECT auth.uid())));
--   "Authenticated users can insert own attachments" ON public.team_note_attachments WITH CHECK
--   (uploaded_by = (SELECT auth.uid())).

-- Lock first so nothing changes between the preflight and the policy changes. The timeout keeps a
-- long-running storage transaction from parking every storage read behind this file: it fails fast
-- and can be re-run.
SET LOCAL lock_timeout = '5s';
LOCK TABLE storage.objects, public.delivery_photos, public.team_note_attachments IN SHARE ROW EXCLUSIVE MODE;

-- Preflight: refuse to run against policies that drifted since they were read, or with a bucket
-- already private (step 2 must not run before step 1).
DO $preflight$
DECLARE
  v_pin record;
  v_md5 text;
BEGIN
  FOR v_pin IN SELECT * FROM (VALUES
    ('storage', 'objects', 'delivery_photos_insert', 'a7275ecf0cfb561a7b64e521a6921503'),
    ('storage', 'objects', 'delivery_photos_delete', '23825b9adb39d1bc99987a641368945b'),
    ('storage', 'objects', 'recv_photos_storage_upload', '2cc78efe95bb2a0cf11bec0a30800acd'),
    ('storage', 'objects', 'recv_photos_storage_delete', '3ec914b0679a6c38a12d17a61ade6d10'),
    ('storage', 'objects', 'Authenticated users can upload team note attachments', '337aa4234a96ed605abe30dad6c03540'),
    ('storage', 'objects', 'Users can delete own team note attachments', '52637a7ec8666536e0ea383b5c8d5f9f'),
    ('public', 'delivery_photos', 'del_photos_select', '8ddd08ccd87e7e3ab2a24a4346aa3411'),
    ('public', 'team_note_attachments', 'Authenticated users can insert own attachments', 'de7e8786d42d0ec62c9c4bb896ae700e')
  ) AS t(schema_name, table_name, policy_name, pin) LOOP
    SELECT md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''))
      INTO v_md5
      FROM pg_policies
     WHERE schemaname = v_pin.schema_name AND tablename = v_pin.table_name AND policyname = v_pin.policy_name;
    IF v_md5 IS DISTINCT FROM v_pin.pin THEN
      RAISE EXCEPTION 'STAFF_PHOTOS_PREFLIGHT: %.% policy "%" is missing or drifted from 2026-10-14 (md5 %)',
        v_pin.schema_name, v_pin.table_name, v_pin.policy_name, v_md5;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM storage.buckets
       WHERE id IN ('delivery-photos', 'receiving-photos', 'team-note-attachments') AND public) <> 3 THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PREFLIGHT: the three photo buckets must exist and still be public for step 1';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
              AND policyname IN ('staff_photos_delivery_select', 'staff_photos_receiving_select', 'staff_photos_team_note_select')) THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PREFLIGHT: a staff photo read policy already exists; this file has already been applied';
  END IF;
END
$preflight$;

-- delivery-photos ---------------------------------------------------------------------------------
CREATE POLICY "staff_photos_delivery_select"
ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'delivery-photos'
  AND (
    public.is_admin()
    OR public.is_sales_rep()
    OR (
      public.is_driver()
      AND EXISTS (
        SELECT 1 FROM public.deliveries d
        WHERE d.id::text = (storage.foldername(name))[2]
          AND d.assigned_driver = (SELECT auth.uid())
      )
    )
  )
);

ALTER POLICY "delivery_photos_insert" ON storage.objects
WITH CHECK (
  bucket_id = 'delivery-photos'
  AND (
    public.is_admin()
    OR public.is_sales_rep()
    OR (
      public.is_driver()
      AND EXISTS (
        SELECT 1 FROM public.deliveries d
        WHERE d.id::text = (storage.foldername(name))[2]
          AND d.assigned_driver = (SELECT auth.uid())
      )
    )
  )
);

-- Delete matches the delivery_photos row policy (del_photos_delete: admin only). Left at admin or
-- rep, a rep could remove a photo's file once the read policy above makes deletes effective,
-- leaving a row only an admin can delete pointing at nothing (Codex on PR #929). No screen lets a
-- rep delete a delivery photo.
ALTER POLICY "delivery_photos_delete" ON storage.objects
USING (
  bucket_id = 'delivery-photos'
  AND public.is_admin()
);

-- receiving-photos --------------------------------------------------------------------------------
CREATE POLICY "staff_photos_receiving_select"
ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'receiving-photos'
  AND (public.is_admin() OR public.is_sales_rep())
);

ALTER POLICY "recv_photos_storage_upload" ON storage.objects
WITH CHECK (
  bucket_id = 'receiving-photos'
  AND (public.is_admin() OR public.is_sales_rep())
);

ALTER POLICY "recv_photos_storage_delete" ON storage.objects
USING (
  bucket_id = 'receiving-photos'
  AND public.is_admin()
);

-- team-note-attachments ---------------------------------------------------------------------------
CREATE POLICY "staff_photos_team_note_select"
ON storage.objects
FOR SELECT TO authenticated
USING (
  bucket_id = 'team-note-attachments'
  AND (public.is_admin() OR public.is_sales_rep() OR public.is_driver() OR public.is_applicator())
);

ALTER POLICY "Authenticated users can upload team note attachments" ON storage.objects
WITH CHECK (
  bucket_id = 'team-note-attachments'
  AND (public.is_admin() OR public.is_sales_rep() OR public.is_driver() OR public.is_applicator())
  AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
);

ALTER POLICY "Users can delete own team note attachments" ON storage.objects
USING (
  bucket_id = 'team-note-attachments'
  AND (
    public.is_admin()
    OR (
      (public.is_sales_rep() OR public.is_driver() OR public.is_applicator())
      AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    )
  )
);

-- team_note_attachments rows: a row names only a file in its uploader's own folder ----------------
-- The app deletes the file a row names before the row, so an unbound file_url would let a staff
-- member point a row at another uploader's photo and have an admin's delete remove that file. The
-- uploader id is a uuid (no regex metacharacters); the file name matches what NotePhotoUpload writes
-- (<epoch ms>_<n>.<ext>), and nothing may follow it, so the path the app reads is the path checked.
ALTER POLICY "Authenticated users can insert own attachments" ON public.team_note_attachments
WITH CHECK (
  uploaded_by = (SELECT auth.uid())
  AND file_url ~ ('^https?://[^/?#]+/storage/v1/object/public/team-note-attachments/team-note-attachments/'
                  || uploaded_by::text || '/[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,10}$')
);

-- delivery_photos rows: the driver branch requires an active driver ------------------------------
ALTER POLICY "del_photos_select" ON public.delivery_photos
USING (
  public.is_admin()
  OR public.is_sales_rep()
  OR (
    public.is_driver()
    AND EXISTS (
      SELECT 1 FROM public.deliveries d
      WHERE d.id = delivery_photos.delivery_id
        AND d.assigned_driver = (SELECT auth.uid())
    )
  )
);

-- Verify inside the same transaction; any mismatch rolls the whole file back.
DO $verify$
DECLARE
  v_pin record;
  v_md5 text;
BEGIN
  -- Each policy is exactly the text this file writes (md5 of cmd|roles|qual|with_check as
  -- PostgreSQL 17 prints it, read from the disposable-database prover after apply; the seven
  -- preflight pins of untouched text matched live in the same prover), and each is PERMISSIVE.
  FOR v_pin IN SELECT * FROM (VALUES
    ('storage', 'objects', 'staff_photos_delivery_select', '90f32dc6545185303ce7388cef4c2df1'),
    ('storage', 'objects', 'staff_photos_receiving_select', '8f1d00d9e18358df1e9a6238ff96538f'),
    ('storage', 'objects', 'staff_photos_team_note_select', '27cfe714de7b43154732c07162393db4'),
    ('storage', 'objects', 'delivery_photos_insert', '77226f37b06516baf3fa3d72b43b2b80'),
    ('storage', 'objects', 'delivery_photos_delete', '18eaabc7bfae3c43d6b922f8b24c6ac4'),
    ('storage', 'objects', 'recv_photos_storage_upload', '49d68cd4f3a03332c5658e15ab30d8c6'),
    ('storage', 'objects', 'recv_photos_storage_delete', '11e5f2acbee2538208d484c955df1aae'),
    ('storage', 'objects', 'Authenticated users can upload team note attachments', '2591f94e1b2b6a55126914a4868fecf1'),
    ('storage', 'objects', 'Users can delete own team note attachments', '23557263186d9cbcd1d27ae89d184e04'),
    ('public', 'delivery_photos', 'del_photos_select', '106bd925a2a96c428f96a21261d44410'),
    ('public', 'team_note_attachments', 'Authenticated users can insert own attachments', '5c30ffc8fc80002944e161c929b63b7e')
  ) AS t(schema_name, table_name, policy_name, pin) LOOP
    SELECT md5(cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''))
      INTO v_md5
      FROM pg_policies
     WHERE schemaname = v_pin.schema_name AND tablename = v_pin.table_name AND policyname = v_pin.policy_name
       AND permissive = 'PERMISSIVE';
    IF v_md5 IS DISTINCT FROM v_pin.pin THEN
      RAISE EXCEPTION 'STAFF_PHOTOS_VERIFY: %.% policy "%" is not exactly as intended (md5 %)',
        v_pin.schema_name, v_pin.table_name, v_pin.policy_name, v_md5;
    END IF;
  END LOOP;

  -- No other storage policy may open these buckets to a role this file does not intend.
  IF EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = 'storage' AND p.tablename = 'objects'
      AND coalesce(p.qual, '') || coalesce(p.with_check, '') ~ '(delivery-photos|receiving-photos|team-note-attachments)'
      AND p.policyname NOT IN ('staff_photos_delivery_select', 'staff_photos_receiving_select', 'staff_photos_team_note_select',
                               'delivery_photos_insert', 'delivery_photos_delete', 'recv_photos_storage_upload',
                               'recv_photos_storage_delete', 'Authenticated users can upload team note attachments',
                               'Users can delete own team note attachments')
  ) THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_VERIFY: an unexpected storage policy names a photo bucket';
  END IF;
  -- Nor may any policy that never tests bucket_id (USING (true), owner-only rules): it would open
  -- every bucket, these included. None exists live on 2026-10-14.
  IF EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = 'storage' AND p.tablename = 'objects'
      AND coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') !~ 'bucket_id\s*='
  ) THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_VERIFY: a storage.objects policy does not test bucket_id';
  END IF;

  IF (SELECT count(*) FROM storage.buckets
       WHERE id IN ('delivery-photos', 'receiving-photos', 'team-note-attachments') AND public) <> 3 THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_VERIFY: step 1 must leave the photo buckets public';
  END IF;
END
$verify$;
