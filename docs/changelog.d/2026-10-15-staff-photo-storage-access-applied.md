## 2026-10-15 — Staff photo storage access (step 1) is live; records updated (migration `20261015230000`)

**Why.** PR #929 shipped `20261015230000_staff_photo_storage_access` with its records still reading
"not applied", because they were written before the apply. It applied live at 21:06:30 UTC (ledger
`20261015210630`, no B7 rename) on Mason's approval, and PR #929 merged as `cd7b796a4`. This change
brings the records in line with the live database.

**What changed.**
- `docs/reference/migration-history.md`: new live ledger capture (2026-10-15 23:12 UTC: 1031 rows /
  1024 names, `max(version)` `20261015210630`, effective high-water `20261015230000`). Row 949 now
  reads APPLIED LIVE with its post-apply check; the old text stays as the pre-apply record.
- `docs/manual/KNOWN_ISSUES.md`: ledger header; the public photo buckets entry says step 1 is live and
  step 2 is open, and records the deferred Sol MED (two team-note attachment rows naming the same file).
- `docs/manual/CURRENT_STATE.md`: ledger header, high-water, applied list and registry lines.
- `.claude/schema-registry.json`: delta refresh only (the applied name and `migrations_high_water`
  `20261015210630`). The migration changed storage and table policies, which the registry does not track.

**Still open.** The live chain `scripts/smoke/smoke-staff_photo_storage_access.sql` waits on Mason's
REAL-DATA-OK marker; step 2 (make the three buckets private) is a separate PR.
