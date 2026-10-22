## 2026-10-22 — Goal 6: off-site Storage file backup is live

- Mason added `SUPABASE_S3_ACCESS_KEY_ID` and `SUPABASE_S3_SECRET_ACCESS_KEY` to `CRX_Backups` and merged
  [PR #1](https://github.com/masonwells1/CRX_Backups/pull/1) and the one-line fix
  [PR #2](https://github.com/masonwells1/CRX_Backups/pull/2) (aws-cli's newer CRT download engine gets
  403 SignatureDoesNotMatch from Supabase Storage; the classic engine works).
- First successful storage run: 9 buckets, 38 files, 9,614,070 bytes, equal to live `storage.objects`, MD5 matched
  for all 38. A `drop-one-file` break test failed red, named the file and saved nothing. The hardened database
  backup and the freshness check each ran green once.
- `docs/operations/production-runbook.md` 4.1, 4.3 and 4.11 now say the file backup is live. Still open: Mason
  confirming the break-test failure email arrived, an outside watchdog, and a restore drill.
