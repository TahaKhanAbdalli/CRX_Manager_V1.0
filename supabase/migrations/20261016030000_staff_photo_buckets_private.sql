-- Staff photos: make the three photo buckets private (Goal 1, docs/plans/2026-10-13-direction-and-goals.md;
-- Mason 2026-10-13: delivery, receiving and team-note photos need a sign-in to view).
--
-- Step 2 of 2. Step 1 (20261015230000_staff_photo_storage_access, applied live 2026-10-15 21:06 UTC,
-- PR #929) added the per-request storage read, upload and delete policies, and the app released with
-- it downloads every photo with the signed-in user's session. The buckets stayed public so app copies
-- installed before that release kept working. This file sets delivery-photos, receiving-photos and
-- team-note-attachments to public = false, so Storage's public object endpoint stops serving them and
-- a copied public link no longer opens a photo. Viewing then goes only through the step 1 read
-- policies (an active staff sign-in with the right role).
--
-- Live state measured read-only immediately before this file was written (2026-10-15 UTC):
--   * the three buckets are public, 10 MB cap, image-only MIME list (20260615182721); no other
--     setting changes here.
--   * storage.buckets: owned by supabase_storage_admin, row-level security on, NO policy, so no app
--     role can change a bucket; postgres (BYPASSRLS) holds UPDATE. Its triggers guard only the
--     bucket name, lifecycle columns and deletes; none fires on an UPDATE of public.
--   * The app (main after PR #929) never loads a photo through its public URL: DeliveryDetail,
--     FieldStop and the team board download through usePrivatePhoto / PrivatePhoto, and receipt
--     emails carry no photos (Mason, 2026-10-14). The stored image_url / file_url values stay as they
--     are: the app reads only the object path out of them (src/lib/privatePhotos.ts), and
--     getPublicUrl, which builds that string, makes no network call. No Edge Function reads these
--     buckets.
--   * public.team_note_attachments: 0 rows; no unique index on file_url or its object path.
--
-- Also in this file (Codex Sol MED on PR #929, deferred here): two team_note_attachments rows could
-- name the same file in the uploader's own folder, and deleting either row removes the file the other
-- still names. A unique index on the object path inside file_url (everything after
-- /storage/v1/object/public/) makes one row per file. Not on file_url itself: step 1's insert policy
-- accepts any http(s) origin, so two URLs differing only in scheme or host would name one file, and
-- the app (teamNotePhotoPath) drops the origin (Codex on this PR). A file_url without that marker
-- indexes as NULL and is not unique-checked; step 1's policy refuses such rows, and none exist.
--
-- Behavior change to note: an app copy installed before PR #929 (2026-10-15) still shows photos by
-- their public URL; after this file those photos show as broken images until that copy reloads the
-- current release. Uploads from such a copy keep working (the policies, not the bucket flag, decide).
--
-- Not destructive: no row, object or policy is changed or removed; one bucket flag per bucket and one
-- new index. Access-changing (bucket visibility), so it needs Mason's own approval of this file.
-- Rollback: UPDATE storage.buckets SET public = true WHERE id IN ('delivery-photos',
-- 'receiving-photos', 'team-note-attachments'); DROP INDEX public.team_note_attachments_object_path_key;
-- sql-safety: exempt — storage.buckets is a Supabase-managed table (not in the public schema
-- registry); public is its real column.

-- Lock first so nothing changes between the preflight and the changes. The timeout keeps a long
-- storage transaction from parking every storage read behind this file: it fails fast and can be re-run.
SET LOCAL lock_timeout = '5s';
LOCK TABLE storage.buckets, storage.objects, public.team_note_attachments IN SHARE ROW EXCLUSIVE MODE;

-- Preflight: step 1 must be in place exactly as applied (a private bucket with no read policy would
-- hide every photo from everyone), the buckets must still be public, and no two rows may share a file.
DO $preflight$
DECLARE
  v_pin record;
  v_md5 text;
BEGIN
  -- Step 1's eleven policies, pinned to the text 20261015230000's verify block checked at apply.
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
      RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_PREFLIGHT: %.% policy "%" is missing or not as step 1 applied it (md5 %)',
        v_pin.schema_name, v_pin.table_name, v_pin.policy_name, v_md5;
    END IF;
  END LOOP;

  -- Permissive policies combine with OR, so the pins alone would let an added, broader policy keep
  -- photos readable once private (Codex Luna on this file). Repeat step 1's two exclusivity checks:
  -- no other storage policy names a photo bucket, and none skips the bucket test altogether.
  IF EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = 'storage' AND p.tablename = 'objects'
      AND coalesce(p.qual, '') || coalesce(p.with_check, '') ~ '(delivery-photos|receiving-photos|team-note-attachments)'
      AND p.policyname NOT IN ('staff_photos_delivery_select', 'staff_photos_receiving_select', 'staff_photos_team_note_select',
                               'delivery_photos_insert', 'delivery_photos_delete', 'recv_photos_storage_upload',
                               'recv_photos_storage_delete', 'Authenticated users can upload team note attachments',
                               'Users can delete own team note attachments')
  ) THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_PREFLIGHT: an unexpected storage policy names a photo bucket';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies p
    WHERE p.schemaname = 'storage' AND p.tablename = 'objects'
      AND coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') !~ 'bucket_id\s*='
  ) THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_PREFLIGHT: a storage.objects policy does not test bucket_id';
  END IF;
  -- The two text checks above cannot see a policy like USING (true OR bucket_id = 'other') (Codex
  -- Luna on this file), so the whole storage.objects policy set is pinned too: 25 policies, read
  -- live 2026-10-16 00:5x UTC, each non-photo one a top-level (bucket_id = '<its own bucket>') AND
  -- ... conjunction (document-uploads, blend-ticket-images, delivery-signatures, job-attachments,
  -- supplier-price-evidence). Any added, removed or changed storage policy refuses this file until
  -- it is re-read and re-pinned.
  IF (SELECT md5(string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || permissive || '|'
                            || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY policyname))
        FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects')
     IS DISTINCT FROM 'd40293d14ae8054e3b88e0dc5525987f' THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_PREFLIGHT: the storage.objects policy set changed since it was read; re-read and re-pin it';
  END IF;

  IF (SELECT count(*) FROM storage.buckets
       WHERE id IN ('delivery-photos', 'receiving-photos', 'team-note-attachments') AND public) <> 3 THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_PREFLIGHT: the three photo buckets must exist and still be public; this file has already been applied or a bucket changed';
  END IF;

  IF to_regclass('public.team_note_attachments_object_path_key') IS NOT NULL THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_PREFLIGHT: team_note_attachments_object_path_key already exists';
  END IF;

  IF EXISTS (SELECT 1 FROM public.team_note_attachments
              WHERE substring(file_url FROM '/storage/v1/object/public/(.+)$') IS NOT NULL
              GROUP BY substring(file_url FROM '/storage/v1/object/public/(.+)$') HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_PREFLIGHT: two or more team_note_attachments rows name the same file; resolve them first';
  END IF;
END
$preflight$;

UPDATE storage.buckets
   SET public = false,
       updated_at = now()
 WHERE id IN ('delivery-photos', 'receiving-photos', 'team-note-attachments');

CREATE UNIQUE INDEX team_note_attachments_object_path_key
  ON public.team_note_attachments ((substring(file_url FROM '/storage/v1/object/public/(.+)$')));

-- Verify inside the same transaction; any mismatch rolls the whole file back.
DO $verify$
BEGIN
  IF (SELECT count(*) FROM storage.buckets
       WHERE id IN ('delivery-photos', 'receiving-photos', 'team-note-attachments') AND public IS FALSE) <> 3 THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_VERIFY: the three photo buckets are not all private';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = 'public.team_note_attachments_object_path_key'::regclass
      AND i.indrelid = 'public.team_note_attachments'::regclass
      AND i.indisunique AND i.indisvalid AND i.indpred IS NULL
      AND i.indnkeyatts = 1 AND i.indkey[0] = 0
      AND pg_get_expr(i.indexprs, i.indrelid) LIKE '%file_url%/storage/v1/object/public/(.+)$%'
  ) THEN
    RAISE EXCEPTION 'STAFF_PHOTOS_PRIVATE_VERIFY: team_note_attachments_object_path_key is not a valid unique index on the file_url object path';
  END IF;
END
$verify$;
