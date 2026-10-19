# Goal 6 ("A real safety net"): findings, 2026-10-18

Read-only investigation. Nothing was changed in the database, storage, secrets, billing or settings. No credentials were read. Method: the repo, the `masonwells1/CRX_Backups` repo and its GitHub Actions history (via `gh`, read-only), and read-only Supabase calls (`get_organization`, `get_project`, `SELECT`s).

## The one thing Mason must do

**Upgrade the Supabase organization "Crop RX Solutions" to Pro and turn on point-in-time recovery (PITR).** Live check today: the plan is `free` (`get_organization` → `plan: free`). On Free there is no PITR, and Supabase's own daily backups are not available to us (per Supabase's FAQ, as CodeRabbit cited it, Free projects may keep them but they only become accessible after upgrading to a paid plan), so the only off-site (project-loss) recovery copy today is a weekly dump (a same-database weekly snapshot also exists, but it is lost with the project): about 7 days old when every Sunday run succeeds, and older after a failed or missed run (the 2026-08-30 run failed, and no alert tells anyone, so there is no fixed upper limit). That does not meet the 2026-10-14 target ("lose minutes, not a day"). Pro alone does not turn PITR on: Supabase bills PITR as a separate add-on and, per its backup documentation, also requires at least Small compute, so the monthly cost is Pro plus the add-on plus any compute upgrade (check the exact figures on the billing page before clicking, and confirm afterwards that PITR shows as enabled). This is the one immediate step. Later steps also need Mason, and he should expect them: naming two recovery people and sharing passphrase access, approving a possibly paid throwaway/staging project, and authorizing a new storage-backup secret in `CRX_Backups`. Everything else in this note can be built by agents.

## Findings

### 1. Does the off-site backup run? Yes, database only. It has never been restore-tested.
- The architecture doc is right that it exists, but the workflow does not live in this repo. It is `.github/workflows/offsite-backup.yml` in the private repo `masonwells1/CRX_Backups`. This repo has no backup workflow (its four workflows are CI, CodeRabbit gate, landing summary, containment).
- Schedule: Sundays 08:00 UTC. It runs `pg_dump` (custom format, schema + data) with the secrets `SUPABASE_DB_URL` and `BACKUP_PASSPHRASE`, encrypts with AES-256 (gpg), commits to `backups/`, keeps the newest 8.
- **Last success: 2026-10-18 12:23 UTC** (commit "Off-site DB backup 2026-10-18", file `crx-backup-2026-10-18.dump.gpg`, 13.2 MB). Every Sunday run since 2026-09-06 succeeded (09-06, 09-13, 09-20, 09-27, 10-04, 10-11, 10-18), plus manual runs on 09-02 and 10-02.
- Failure history: 3 manual runs on 2026-07-13 (setup) and one scheduled run that ran and failed on 2026-08-30 (cause not examined; dumps were 08-23, then 09-02 by hand, so that gap was 10 days). No failure alerts are wired to anyone; GitHub emails are the only signal. The workflow only fails if the dump is under 10 KB, so a dump that is the wrong size but over 10 KB passes.
- **Never proven restorable.** `docs/operations/production-runbook.md` §4.2 says "Last drill: none yet". Nobody has decrypted a file and run `pg_restore` into a scratch database.
- **Files are not covered.** The dump is database rows only. `CRX_Backups/restore.md` says Auth and Storage files are separate. Whether the dump includes the `auth` schema (logins) is **unverified**: it needs a decrypt, which needs the passphrase that only Mason holds. The Storage file bytes are certainly not in it (only the `storage.objects` rows that point to them).
- Related, all disabled or secondary:
  - The in-database weekly snapshot (`pg_cron` job `weekly-db-backup`, `0 7 * * 0`, active) ran 2026-10-18 07:00 UTC and holds 1,418 snapshot rows. It sits in the same database, so it does not survive losing the project.
  - The local-JSON scheduled task `weekly-db-backup` is **disabled** (last run 2026-07-26). The `/backup-db` skill still describes it. The off-site Action is what actually runs now.
  - The runbook (§4.1) still says the off-site backup is made "by a GitHub Action" without saying the workflow lives in another repo, and §4.1 says uploads are "re-obtainable from the customer". The photos are staff delivery evidence, so that is no longer a safe assumption.

### 2. Live project status today
- Project `rhyzpcqhnizqbxphqdkr` ("CRX-DATABASE", us-west-2): `ACTIVE_HEALTHY`, Postgres 17.6. Database size 89 MB.
- Organization plan: **free** (tier `tier_free`). So **PITR is off** (Supabase sells it as a paid add-on on paid plans; a Free project has none; confirm the exact price on the billing page before clicking).
- Storage buckets (all private): `blend-ticket-images` 1 file, `customer-documents` 1, `delivery-photos` 15 (8.9 MB, newest 2026-07-20), `delivery-signatures` 21, and 0 files in `document-uploads`, `job-attachments`, `receiving-photos`, `supplier-price-evidence`, `team-note-attachments`. Total about 9.7 MB in 38 files. Goal 6 names three photo buckets, but **nine exist**; the full list should be backed up, because the empty ones will fill once the field features are used.

### 3. Gap list against Goal 6's "Done when"

| "Done when" bullet | Status today | Gap |
|---|---|---|
| Live check confirms Pro with PITR on | **Not met.** Plan is free. | Mason's billing click, then an agent re-checks live. |
| Restore drill restores database, permissions, user access and each protected bucket into an isolated copy; photos open and match records | **Not met.** No drill ever run; no file backup exists. | Build the file backup, then run the drill. |
| One rewind-to-a-time recovery practiced on a throwaway copy | **Not met.** Impossible before Pro + PITR. | After Pro. |
| Reconcile payments, QuickBooks entries and emails before sync resumes after a restore | **Not met.** No written procedure. | Write the checklist. Needs the Goal 7 integrations to be fully specified, so draft now and complete later. |
| Recovery meets Mason's target (back by next business morning, minutes of loss) | **Not met.** Today: about 7 days of loss at best, more after a missed run, untested restore time. | Pro + PITR, plus a timed drill. |
| A named person and a backup can run the recovery; paper fallback rehearsed | **Not met.** The passphrase lives in Mason's password manager only, so he is currently the single point of failure. | Mason names two people (the senior developer from Goal 6d is a natural candidate); one agent-written runbook; a paper-fallback rehearsal. |
| CI runs money/inventory browser tests per role against staging; a failure blocks the change | **Not met.** No staging system exists. | Build staging, then wire CI. |
| (Section text) Photos and uploads backed up | **Not met.** | See plan step 2. |
| (Section text) A quarterly timed, logged restore test | **Not met**; the first is overdue. | Runbook + log file. |
| (Section text) Check the off-site backup actually runs | **Met by this note:** it runs. Restorability still unproven. | Drill. |

## Ordered plan

**Only Mason can do:**
1. Upgrade Supabase to Pro and enable PITR (billing clicks; minutes). PITR is a separate paid add-on and needs at least Small compute, so budget for all three. *Do this first: PITR only covers time from the moment it is on.* Tell an agent when done so it can re-check live.
2. Name the recovery person and a backup (and decide where the backup passphrase is also kept, e.g. a second password manager entry for that person).
3. (Later) Approve the throwaway project used for restore drills and staging, since a second Supabase project may cost money.
**Agents can build (in this order):**
1. **Restore drill #1, database only (about 1 day).** Needs the passphrase from Mason once, or Mason runs one decrypt command that an agent writes for him. Restore the 2026-10-18 dump into a throwaway project, compare row counts with a baseline captured when the dump ran (the restored database must match that baseline, not today's live counts, because ordinary writes after the dump would otherwise look like missing data), record the time, and settle the open question of whether the `auth` schema is in the dump. Writes `docs/operations/` log entry. Do this soon; it is the cheapest proof that the existing backup is real.
2. **Off-site file backup job (about 2–3 days).** A scheduled GitHub Action in `CRX_Backups` that copies every Storage bucket (all nine, not just three) off-site, encrypted, with a manifest of object names and sizes that is compared to `storage.objects` after each run, and that fails loudly (email via GitHub plus a staleness flag the nightly watchdog reads). Needs a read-only storage credential as a new secret in `CRX_Backups` — adding a secret is Mason's gated action. Whole data set is under 10 MB today.
3. **Backup health alert (about half a day).** Make a failed or missed Sunday run visible to Mason, not just in GitHub email; raise the "suspiciously small" floor to a check against the previous dump size.
4. **Written recovery runbook (about 1–2 days).** Rewrite runbook §4 for Pro + PITR: rewind steps, restore-to-new-project steps, post-restore reconciliation checklist (payments, QuickBooks, emails), the paper fallback for dispatch, delivery and payments, and a quarterly drill log with a timing table. Fix the stale lines noted in finding 1.
5. **Rewind drill and full restore drill (about 1 day each, after Mason's Pro upgrade and step 2).** Include files and logins; confirm photos open and match their records.
6. **Staging system (about 1–2 weeks; largest piece).** Separate Supabase project built from `supabase/baselines/README.md` plus later migrations, its own accounts, test payment keys, captured test email, scheduled jobs and integrations pointed away from real systems. Then re-enable the browser tests in CI against it. Needs Mason's approval for the extra project and its secrets.

**Not changed by this note:** nothing in the database, storage, secrets, billing or settings. No decrypt or restore was attempted.

## Evidence used
- `gh run list` / `gh api` on `masonwells1/CRX_Backups` (workflow runs, commits, `backups/` listing, workflow file, `README.md`, `restore.md`), and on this repo's workflow list.
- Supabase: `get_organization`, `get_project`, and read-only `SELECT`s on `storage.buckets`/`storage.objects`, `public.backup_snapshots` and `cron.job`.
- Repo: `docs/manual/ARCHITECTURE.md` §7, `docs/operations/production-runbook.md` §4, `.claude/commands/backup-db.md`, `scripts/backup-db.mjs`, scheduled-task list (`weekly-db-backup` disabled).
