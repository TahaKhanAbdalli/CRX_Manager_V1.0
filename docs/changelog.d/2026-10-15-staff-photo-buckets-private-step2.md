## 2026-10-15 — Staff photos step 2: make the photo buckets private (migration `20261016030000`, not applied)

**Why.** Step 1 (`20261015230000`, PR #929) is live: viewing, uploading and deleting staff photos
follow per-role storage rules, and the app downloads every photo with the user's sign-in. The three
photo buckets stayed public so older installed app copies kept working, which means anyone holding a
photo's public link can still open it (checked live 2026-10-15: a delivery photo's public URL
returns the image). Mason decided on 2026-10-13 that these photos need a staff sign-in every time.

**What changed.**
- `supabase/migrations/20261016030000_staff_photo_buckets_private.sql`: sets `delivery-photos`,
  `receiving-photos` and `team-note-attachments` private, and adds a unique index on the
  storage path inside `team_note_attachments.file_url` (the Sol finding deferred from PR #929: two
  rows naming one file, even under different URL origins). Preflight pins step 1's eleven policies
  and the whole storage policy set (so no added or changed policy can keep photos open); verify
  checks the buckets and the index.
- `scripts/smoke/prove-staff-photo-storage-access-real-schema.mjs`: proves step 2 on top of step 1
  in the same disposable database.
- `docs/reference/migration-history.md` row 950, `docs/manual/KNOWN_ISSUES.md` photo entry.

**Still open.** Applying needs Mason's own approval. App copies installed before PR #929 show broken
photos until they reload the current release.
