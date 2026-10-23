## 2026-10-21 — Goal 6: off-site Storage file backup and backup freshness check built (not yet live)

- `masonwells1/CRX_Backups` [PR #1](https://github.com/masonwells1/CRX_Backups/pull/1) adds
  `storage-backup.yml` (Sundays 08:30 UTC: copies every Storage bucket, compares a manifest of names
  and sizes with `storage.objects`, fails and saves nothing on any difference, encrypts with the
  existing passphrase) and `backup-freshness.yml` (daily 20:00 UTC lateness check for both backups).
- Not running yet: Mason must add the secrets `SUPABASE_S3_ACCESS_KEY_ID` and
  `SUPABASE_S3_SECRET_ACCESS_KEY`, then the PR merges and one manual run plus one break-test run prove it.
- `docs/operations/production-runbook.md` §4.1, §4.3 and §4.11 record this state.
