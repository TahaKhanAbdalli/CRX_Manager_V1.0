# Goal 6: restore a dump into a new project (DRAFT, unproven)

**Status:** draft plan, 2026-10-19. Moved out of `docs/operations/production-runbook.md` §4.6 because it
has never been run and review keeps finding gaps. The first restore drill (runbook §4.9) proves or fixes
it; only then does it move back into the runbook. Step and section numbers below (4.7, 4.9, 4.11) refer to
the runbook. The backup alert design is `docs/plans/2026-10-19-goal6-backup-health-alert-design.md`.

**DRILL ONLY.** Until a drill proves it, this draft is used only against a throwaway project. It is not an
approved procedure for restoring or replacing production; a real loss before then is escalated to Mason
and Supabase support (runbook 4.6).

**Open items from the final review (fold into the first drill):**
- **Independent schema check.** Before declaring a restore valid or cutting over, compare the restored
  constraints, triggers, indexes, functions, policies, **sequences** (see below) and **views** (with their security settings, such as
  `profile_public_view`, which the Team Board reads) with an *independent* expected schema (a
  schema-only capture saved beside the dump from the same snapshot, or the repository migrations rebuilt
  up to the dump's ledger version in a scratch database), not with the archive's own contents list. A dump
  missing its post-data section would not list those objects at all. Any schema error that is not on the
  known-platform-conflict list fails the restore.
  - **Security switches and grants, not just policy names.** PostgreSQL keeps a table's policies even
    when row-level security is switched off, so matching policy names proves nothing on its own (see
    `supabase/baselines/README.md`, the `relations_and_acl` row). The expected schema must also be compared
    for: each table's row-level security switches (`ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL
    SECURITY`); the grants on every table, column, sequence and function (their access lists, or ACLs; sequence grants decide who can draw document numbers such as invoice numbers); and the
    default privileges (`pg_default_acl`, the standing rule for what the *next* new object gets, which
    no grant on an existing object shows). A difference in any of these fails the restore.
  - **Sequences: compare the next number, not the stored value.** For each sequence, such as
    `invoice_number_seq` feeding `invoices.invoice_number`, work out the number it will hand out next:
    its `last_value` if `is_called` is false, otherwise `last_value` plus its increment. That next number
    must be higher than the highest number already stored (for invoice numbers, the numeric part after the
    prefix and year, for example `INV-2026-0042` is 42, among numbers with that sequence's prefix). Do not
    require `last_value` itself to be higher: a correctly restored sequence that has already handed out
    its last number has `is_called` true and `last_value` *equal* to that number, and would wrongly fail.
- **Jobs during replay.** Replaying migrations can recreate `pg_cron` jobs. Step 8's job-safe replay is
  the only allowed path; the CLI's normal push is not used.
- **Scheduled-job tables are not restored.** The restore deliberately leaves out `cron` table data, so
  those tables are a separate class in the count check: they must be empty after the restore, and they
  are not compared with the source counts.

## Procedure

> **UNPROVEN.** This procedure has never been run. Every review pass has found real gaps in it, so treat
> it as a checklist to be corrected by the first supervised drill (4.9), not as a tested recipe. Do not
> rely on it alone in an emergency; stop and escalate at any step that does not match what you see.
>
> **Known open review items (Mason chose to merge and settle these in the first drill, 2026-10-19):**
> (1) [Now covered in step 10.] While the replacement is reconciled, put the *old* application in read-only or maintenance mode (or
> capture and replay every write made after the freeze), or staff writes to the old project are silently lost
> at cutover. (2) A fresh Supabase project already has platform objects, so a plain `pg_restore` can show
> expected "already exists" and ownership errors: use the roles/schema/data split restore in Supabase's
> restore guide, or list the known platform conflicts while still failing on any COPY or data error. Step 5's
> "no errors" wording means no *data* errors. (3) Resend keeps only 30 days of email events, but a corruption
> archive can be about 8 weeks old: export the live `email_log` before cutover while the damaged project is
> still reachable, or stop and use another durable record when the interval exceeds 30 days.

1. Create a **new** Supabase project (never overwrite production). A second project may cost money: Mason approves.
   **Immediately after creating it, and before restoring any users or triggers, turn public signup off**
   (this is an authentication change, so get Mason's explicit yes in the current conversation when he
   approves the project in this same step)
   in its Auth settings and confirm a signup attempt is refused. Closing the Data API does not close the
   separate Auth signup endpoint, and the profile trigger copies a signup-supplied role into the profile,
   so someone who found the address could otherwise create an admin account that survives the restore.
   Before cutover, list the restored `auth.users` and `profiles` and confirm there are no accounts the dump
   did not contain.
2. Clone `masonwells1/CRX_Backups` and choose the archive `backups/crx-backup-YYYY-MM-DD.dump.gpg`:
   the **newest** when the project is lost; for **corruption**, the newest archive taken **before the bad
   change began** (the newest one may already contain the damage). The repo keeps the newest 8 archives (weekly, so about 8 weeks), so corruption older
   than about 8 weeks cannot be undone this way. If decryption, restore or validation of the chosen
   archive fails (a truncated dump can pass today's backup job), try the next older archive and keep going
   back, recording each failure in the drill log. Say which you chose and why in the drill log.
3. Decrypt with the passphrase from Mason's password manager. Never paste it into chat or a file. Stream the decrypted dump straight into `pg_restore` where possible; if a plaintext file is unavoidable, keep it in private temporary storage with owner-only permissions (not a shared folder) and delete it as soon as validation finishes unless Mason approves keeping it.
4. Restore with `pg_restore` using the **Session pooler** connection string (IPv4). Keep
   scheduled jobs **off during reconciliation**. The dump itself can carry the `cron.job` rows (the pg_cron
   extension marks that table for inclusion in dumps), and on a project with pg_cron enabled they would start
   running as soon as they load. So stop that before it can happen. `pg_restore` has no option to skip one
   table's data on the command line, so write the archive's contents list to a file (`pg_restore --list`),
   comment out every entry for `cron.job` (and any other `cron` table data) in that file, and restore with
   that edited list (`pg_restore --use-list`). The extension cannot be trusted to stay quiet by being left
   disabled, because the archive itself may enable it while loading. Afterwards, before the app is pointed
   at the project, run a query that confirms `cron.job` is empty and no job is active; if any job is present,
   stop and treat the restore as failed. The first drill must prove this on a real archive. Jobs are put back
   at the end (4.7, last item), not forgotten.
   **Keep the new project's API isolated for the whole restore window, independent of database privileges.**
   A restore adds grants and default privileges after the lockdown, so a privilege change alone cannot be
   relied on to keep the data private while it loads. Anyone who knows the new project's API address could
   otherwise read or change restored data, and pointing Vercel elsewhere does not stop direct requests.
   Use a control that does not depend on grants and leaves the database reachable: disable the project's
   Data API in its settings. (Do not pause the project: a paused project stops serving its address, so
   `pg_restore` and the database checks could not connect.)
   (Supabase's database network restrictions cover only direct database and pooler connections, not the
   HTTPS API, so they do not count as isolation.) Keep it off through the load, the schema replay and every
   check that can be done **inside the database** (privileges, policies, roles; see the next paragraph and
   step 11). Because the signed-out request and the browser role checks need the API to be on, there is one
   short, deliberate exposure: turn the API on only after the in-database proof passes (no `anon` or
   `authenticated` privilege or policy that exposes data beyond what production allows, row-level security
   on every table), distribute no project keys, run the signed-out refusal request immediately, and turn the
   API off again at once if anything unexpected is returned. Record the times it was on. Details of the
   access lockdown from `supabase/baselines/README.md` (step 3, "ACL lockdown"): a new
   Supabase project gives the anonymous (signed-out) role full read/write on every table and the right to
   run every function, and a restore only adds grants, never removes those. Changing privileges is a
   permission change and needs Mason's explicit approval first. The repository's lockdown file
   (`20260727174805_acl_lockdown.sql`) is a **July 2026 snapshot**: it revokes everything and re-grants only
   what existed then, so applying it blindly to a newer dump would leave later objects unusable and could
   restore July-era grants. Reproduce production's *current* grants and default privileges for the restored
   schema (from a grants capture taken from the live system while it exists, or by replaying the later
   permission migrations), under a reviewed plan. Then **verify** with a query that the `anon` role holds no
   table or function privileges it should not, and that a signed-out request to the new project's API is
   refused. Do this before the project is exposed to anyone.
5. Validate. **Future (once the alert design is built):** compare against the baseline file bound to the **exact selected archive** (its name and checksum are recorded in the file; a file merely dated earlier or later is not valid, because it cannot show that this archive holds all its rows)
   `baseline-YYYY-MM-DD.json` stored beside the dump. If the selected archive has no such bound file, count validation is unavailable for it and the live-count or lost-project method below applies. **As of 2026-10-19 no baseline exists.** If the project
   is **lost** (no live database to count), validate without live counts: the restore finishes with no
   errors; the key tables are not empty; no table's newest `created_at` is after the dump date, and the busiest tables (`invoices`, `inventory_transactions`) have one no more than 3 days before the dump date (a season runs October 1 through September 30; outside the busy part of the season a longer gap can be normal, so explain it rather than fail) (do not apply this to low-volume tables such as `allocation_sets` or `prepay_credits`, which may have no new rows for days);
   internal checks hold (for every invoice not in `voided` status, the total equals the sum of its lines; voided invoices keep their lines but have a zero total by design, so check that zero instead; if another status (for example a cancelled invoice) fails the total check, compare it with that status's rules in `.claude/schema-registry.json` and the workflow docs and record the finding rather than assuming corruption or assuming it is fine; every order and invoice points to
   a customer that exists, every profile has a matching login); and several of the most recent invoice
   numbers before the dump match an outside record (QuickBooks, Chem Man, email, paper tickets).
   Also, each Monday backup check below saves a dated list of live row counts for `customers`, `invoices`, `orders`,
   `inventory_transactions`, `allocation_sets`, `prepay_credits`, `auth.users`, `profiles` and every other
   identity table the restore needs, to a place that survives losing the project (the `CRX_Backups` repo),
   so a lost-project restore can compare to the most recent one and stops on any unexplained difference,
   including missing accounts.
   If the project is **still reachable** (a drill, or corruption), also use this fallback:
   read live row counts for `customers`, `invoices`, `orders`, `inventory_transactions`, `allocation_sets` and `prepay_credits` (the live payment tables; the old `payments` table is dead and must not be used)
   just before the drill and note the dump date. Treat a table as **append-only** only if no one can delete from it; today
   that is just `inventory_transactions` (confirm against the delete rules at drill time). For it, the restored
   count must equal the live count of rows whose `created_at` is at or before the dump time (a stricter, exact rule; rows written since the dump are the only ones missing, never extra). If the project is lost, compare with the most recent saved Monday count and explain any difference from the activity since.
   Everything else, including `allocation_sets` and `prepay_credits` (admins can delete from both; count
   voided rows too, since voiding changes status, not row count), `customers`, `orders` and `invoices`,
   is mutable: the restored count may be above live if records were deleted after the dump: list the difference and
   explain it from the activity log rather than failing the drill. In every table the newest `created_at`
   must not be after the dump time. Spot-check a few known recent invoices by number. Record the numbers
   in the drill log.
6. Check logins: confirm users exist in `auth.users` in the restored copy, with the **same IDs** as
   `profiles.id` (each profile's ID is its login's ID, so the two must match). If the dump lacks
   `auth.users`, do not just re-create logins: new logins get new IDs and would not inherit their restored
   profiles, roles or records. Either restore the original user IDs, or relink and validate every
   identity-dependent row before cutover (this needs its own reviewed plan and Mason's approval; stop and
   escalate rather than improvising). Record which case applied. Matching rows are not proof: before
   cutover, **sign in with a real password for one account of every active interactive role** (admin, sales rep, and
   each other human role in use; service-only profiles such as entity commission recipients have no usable
   password by design, so never make them login-capable: check them through their ID and commission
   invariants instead) and check each can open the screens and data that role should, and cannot open
   what it should not. One admin test is not enough. These checks describe the schema as restored, so they
   are **repeated as the final gate (step 11)** after the schema update, grants and Auth settings are done.
7. Work lost is everything written after the dump time: up to about 7 days (as of 2026-10-19, weekly dumps), more if a Sunday run was missed.
8. **Bring the restored schema up to date first.** (Some migrations call `cron.schedule`, so replay can
   recreate scheduled jobs. Do **not** replay through the CLI's normal push, which commits each file as
   written and would leave any job it schedules active. Use the job-safe replay below instead, then run the
   `cron.job` check from step 4 again; any active job stops the restore.) The dump is only as new as its date, but the current
   code and Edge Functions expect every later migration (RPCs, columns, grants, constraints). Deploying
   them against an older schema causes an immediate outage. Follow `supabase/baselines/README.md`
   (section on replay after restore). That script compares against the fixed July baseline, **not** against
   your dump, so its list is only a starting point: for an October dump it also lists migrations the dump
   already contains. Read the restored `supabase_migrations.schema_migrations` (version and name pairs) and
   compare it with the repository to get the migrations the dump is actually missing, then build the filtered
   set from that comparison (use `node scripts/list-post-baseline-migrations.mjs` as input only; never choose migrations by filename date alone, and
   never run the files directly with `psql`, which skips the migration ledger), review the dry run in an
   isolated Supabase CLI work directory, then apply that exact filtered set with the **job-safe replay**:
   one migration at a time, oldest first, each in a single transaction that runs the migration file, inserts
   its `(version, name)` row into `supabase_migrations.schema_migrations` (so the ledger stays correct),
   and ends with `UPDATE cron.job SET active = false` immediately before `COMMIT`. A job scheduled inside
   that transaction is invisible to the scheduler until commit and is committed already inactive, so it
   can never run. Check `SELECT count(*) FROM cron.job WHERE active` is zero after each one. The first drill
   must prove this sequence before it is ever used for real.
   Confirm the restored `supabase_migrations.schema_migrations` ledger matches the repository before going on.
   **One-shot migrations need special care.** That script deliberately withholds the entries in
   `supabase/baselines/one-shot-migrations.json` (data rewrites specific to production). If the archive is
   older than any of them, the restored data lacks that correction, and neither replaying it nor marking it
   applied in the ledger is safe on its own (marking it applied would leave the old, wrong rows in place).
   Compare the restored ledger with that registry, list every entry newer than the archive, and for each
   one require a reviewed, data-specific recovery plan with Mason's approval before cutover. If a plan is
   not ready, choose a newer archive or stop and escalate.
   Applying migrations to the new project needs Mason's approval in the current conversation.
9. A dump holds the database only. A new project has **no Edge Functions and no secrets**. Before going
   live on the restored copy: deploy every function directory under `supabase/functions/` to it, install
   every required secret (from the password manager, never pasted into chat). **Run the function smoke
   tests inside step 11's controlled API-on window, not here:** the functions use the Data API, which stays
   off until the in-database proof in step 11 passes. Use the same bounded API-on window described in
   step 4, record it, and turn the API off again before cleanup of the test records and before the row-count
   validation. Smoke-test each function **safely**: use isolated test fixtures (synthetic records), non-production recipients and sandbox
   credentials or stubbed integrations, because `send-email`, the user-management functions and the OCR
   functions have real external or database side effects, and OCR is not safe to repeat. Remove every test
   record before the row-count validation in step 11 so counts and email logs are not polluted. Deleting
   data needs Mason's explicit approval first, so list the exact test records and get his yes before
   deleting any; in the new, not-yet-live project, the cleaner route is to do the smoke tests before the
   final data load or to restart from a fresh restore
   (`send-email`, `create-user`, `reset-user-password`, `process-document`, `process-blend-ticket`,
   `customer-document-files`, `epa-lookup`, `setup-blend-tickets-storage`; the directory listing is
   authoritative). The Content Security Policy in `vercel.json` allows connections only to the current project's host
   (`rhyzpcqhnizqbxphqdkr.supabase.co`), so the new project's host must be added there and deployed through
   the normal PR path first, or browsers will block every request after cutover. Also set the new project's
   Auth **Site URL** to `https://croprxsolutions.app` and add `https://croprxsolutions.app/reset-password`
   (and any other redirect the app uses) to its redirect allow list, then test a password reset; otherwise
   password recovery fails after cutover. Also restore the **Realtime publications** the app depends on
   (`team_notes`, `team_note_comments`, `notifications`, `note_activity_log` use live updates, per
   `src/hooks/useRealtimeSubscription.ts`) and confirm in the project settings that they are active;
   a logical restore does not bring them back on its own. **Turn public signup off** in the new project's Auth settings
   and verify it (a direct signup request must be refused) before exposing it: a new project defaults to
   signup on, and the profile-creation trigger copies a role from the signup request, so open signup could
   let a stranger create an admin profile. Auth changes need Mason's explicit approval. Repoint the
   Vercel environment variables to the new project and redeploy only after the final gate (step 11) passes.
   Deploying functions, installing secrets and changing production configuration each need Mason's
   explicit approval in the current conversation.
10. **Freeze writers, then reconcile.** Before reconciliation starts, freeze every writer on the old
    project when it is still reachable: put the application in maintenance or read-only mode, pause the
    scheduled jobs, disable webhooks and integrations (payments, email, QuickBooks) and tell staff to stop,
    or else capture every write made after the freeze and replay it. Keep the restored project unreachable
    to staff until the post-restore checklist (4.7) is finished. Otherwise staff or jobs could write against
    week-old state, or writes to the old project could disappear at cutover, creating the duplicates 4.7
    exists to prevent. Write down which approach you used. Then carry over every legitimate change made on
    the old project between the dump time and the freeze, across **all** business tables (runbook 4.7,
    "Every other business record"), before cutover. A drill exercises this without touching production:
    restore a second throwaway copy from the same dump to act as the "old" project, make test changes there,
    and prove each one is found and carried over.
11. **Final gate before cutover.** First repeat the full table, function and default-privilege audit from
    step 4 for every object the schema replay (step 8) added or changed, including row-level-security
    policies as well as grants. **Do this audit inside the database first, with the API still off**
    (`has_table_privilege` and `has_function_privilege` for `anon` and `authenticated`, the policy list, and
    row-level security on every table; test role behavior with `SET ROLE` in a transaction that is rolled
    back). Only when that proof passes, turn the API on for the short window described in step 4, run the
    signed-out refusal request and the browser role checks from the isolated preview, and turn it off again
    at once if anything unexpected appears. Leave it on for cutover only with Mason's approval.
    The exact archive row-count comparison is done **once, in step 5, right after the raw restore**, and is
    not repeated here: the step 8 replay and recovery plans and the step 10 reconciliation legitimately
    change rows afterwards. After steps 4, 6, 8, 9 and 10, repeat on the finished project the step 5
    internal-consistency checks and recent invoice numbers, and check that every row change since step 5
    is explained by a planned migration or recovery plan or by reconciliation: validate the reconciled delta against the external records (payments, deliveries, stock, email logs)
    and the business invariants instead of expecting dump-time counts; a real sign-in and allow/deny check for
    one account of every active interactive role (service-only profiles are checked by invariants, not passwords) (run from an isolated Vercel preview deployment or test host that is
    configured with the restored project's environment variables and security policy, because production
    Vercel still points at the old project until cutover, so checks run from it would test the wrong
    project); the signed-out request refusal; the ledger match; and a password
    reset test; and a live-update test using a synthetic team-note fixture (post a team note in one browser and see it, and a notification, appear in another without reloading; delete the fixture and its notification and activity rows afterwards and record that they were removed). Only if all pass does the Vercel cutover go ahead, and the scheduled jobs go back last (4.7).

