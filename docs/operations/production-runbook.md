# CRX Manager — Production Runbook

**Last updated:** 2026-10-14 (deploy section now points at the current landing, migration and Edge Function procedures; stale counts and paths corrected). Earlier: 2026-07-16 (backup/recovery section rewritten to FREE-plan reality; revert path updated to the PR-only landing flow)
**Audience:** Mason (owner) and any future on-call admin.
**Scope:** day-to-day operations, deploys, rollbacks, incident response, and recurring maintenance for the production system.

---

## 1. System landscape

| Component | Where it runs | Dashboard / CLI |
|---|---|---|
| Frontend | Vercel (production) | https://vercel.com/dashboard |
| Live URL | https://croprxsolutions.app | — |
| Database | Supabase project `rhyzpcqhnizqbxphqdkr` | https://supabase.com/dashboard/project/rhyzpcqhnizqbxphqdkr |
| Edge Functions | Supabase (one per folder in `supabase/functions/`, excluding `_shared`) | Supabase → Edge Functions tab |
| Email | Resend (via `send-email` Edge Function) | https://resend.com/dashboard |
| OCR | Google Vision API (via `process-blend-ticket` and `process-document`) | https://console.cloud.google.com |
| Repo | GitHub `masonwells1/CRX_Manager_V1.0` | https://github.com/masonwells1/CRX_Manager_V1.0 |
| CI | GitHub Actions (`.github/workflows/ci.yml`) | Repo → Actions tab |
| Error tracking | Sentry | https://sentry.io |

**Stack:** React 19 + TypeScript + Vite + Tailwind + Supabase + Vercel.

---

## 2. Deploy

The step-by-step procedures live in `DEPLOYMENT.md` and `.claude/commands/ship.md` (the file
`AGENTS.md` routes pushes, merges and releases to); this section only summarizes them.

### 2.1 Normal deploy (frontend)

Vercel builds a preview for every PR and deploys production when a PR merges into `main`.
Nobody pushes to `main` directly — the `protect-main` ruleset rejects it.

1. Open a PR as a draft; CI runs the required checks. Mark it ready once the head is frozen:
   CodeRabbit then reviews it once, as advice only (since 2026-10-19 it never approves or blocks,
   and it skips PRs whose title contains `docs(`). Fix or answer its comments if they arrive before the merge.
2. The PR merges only through the protected path in `.claude/commands/ship.md` Step 8:
   every check green, no `CHANGES_REQUESTED`, a fresh exact-SHA Sol review
   (except a documentation-only change, `docs/reference/sol-exempt-paths.md`), then
   `gh pr merge <n> --squash --delete-branch --match-head-commit <sha>`.
3. Watch [Vercel deployments](https://vercel.com/dashboard) until the new build is "Ready."
4. Hit https://croprxsolutions.app → hard refresh → confirm the new build.

A preview deployment talks to the live database (there is no staging project yet), so do
not create or change records while checking one.

### 2.2 Database migration deploy

Migrations are SQL files in `supabase/migrations/`. An agent applies them through
`scripts/apply-migration-file.mjs` (dry run first, then `--confirm`) after the PR's reviews
pass — not by `npx supabase db push`, and not through the MCP `apply_migration` tool, which
cannot pass the apply guard. The full sequence, including which migrations wait for Mason's
own approval, is in `DEPLOYMENT.md` and `.claude/commands/ship.md` Step 5. Record each
change in a new `docs/changelog.d/<YYYY-MM-DD>-<slug>.md` entry and in
`docs/reference/migration-history.md`.

### 2.3 Edge Function deploy

Edge Functions live in `supabase/functions/<function-name>/` (`_shared/` is shared code, not
a function). Each has its own `index.ts` and runs on Deno. **Every Edge Function deploy
needs Mason's explicit approval in the current conversation** (`AGENTS.md`). Agents use the
`deploy-edge-function` skill, which runs the pre-flight checks and a post-deploy smoke test.

### 2.4 Required environment variables

**Vercel project:** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are required;
`VITE_MAPBOX_TOKEN` and `VITE_SENTRY_DSN` are optional (`.env.example`).

**Supabase Edge Function secrets:** see the "Edge Function secrets" table in `DEPLOYMENT.md`,
which is the single list. `SUPABASE_SERVICE_ROLE_KEY` is present automatically; never expose
it to the frontend. When `SENTRY_DSN` is unset, `captureEdgeException` logs a
`SENTRY_MISCONFIG` warning instead of reporting.

---

## 3. Rollback

### 3.1 Rolling back the frontend

**Fastest path — Vercel "Promote to Production":**
1. Vercel Dashboard → Deployments tab.
2. Find the last known-good deployment (look at commit hash).
3. Click "..." → "Promote to Production."
4. Confirm. Live URL points at the old build within ~30 seconds.

**Alternative — git revert via a PR** (direct pushes to `main` are impossible — the
`protect-main` ruleset rejects them for everyone):
```bash
git checkout -b revert/<short-name> origin/main
git revert <bad-commit-sha>
git push -u origin revert/<short-name>
gh pr create --fill
```
The revert PR then lands through the normal protected path (`.claude/commands/ship.md`
Step 8; `--auto` is refused by the merge gates). The merge to `main` auto-deploys the revert via Vercel. (The Vercel dashboard
rollback above is faster — prefer it mid-incident.)

### 3.2 Rolling back a database migration

**Migrations are append-only — there is no "down" script.** If a migration introduced a bug:

1. **DO NOT** delete or modify the bad migration file in git history.
2. Write a NEW migration that reverses the bad changes (drop columns added, restore prior function definitions, etc.).
3. Apply it through the normal migration path (§2.2).
4. Confirm app works against the reversed state.

**Worst-case (data corruption):** restore from the `CRX_Backups` dump or the in-database
`backup_snapshots` (see §4.2). There is no Supabase point-in-time recovery on the FREE plan.

### 3.3 Rolling back an Edge Function

Edge Functions are versioned by deploy. To roll back, redeploy the prior version's source code
(a redeploy is an Edge Function deploy, so it needs Mason's explicit approval first):

```bash
git checkout <good-sha> -- supabase/functions/<fn-name>/
npx supabase functions deploy <fn-name> --project-ref rhyzpcqhnizqbxphqdkr
git checkout HEAD -- supabase/functions/<fn-name>/
```

---

## 4. Backups and disaster recovery

> **Rewritten 2026-07-16.** The old text here described Supabase Pro-plan daily backups
> and point-in-time recovery. **The org is on the FREE plan — there are NO Supabase
> daily backups and NO PITR, and no "Restore" button in the dashboard.** The two paths
> below are the ONLY recovery paths (settled 2026-07-12/13, see `docs/manual/DECISION_LOG.md`).

### 4.1 What's actually backed up

- **Database (primary, off-site):** a weekly encrypted `pg_dump` pushed to the private
  GitHub repo `masonwells1/CRX_Backups` by a GitHub Action. This is the real
  disaster-recovery copy. Trigger a fresh one anytime with the `/backup-db` skill
  (deterministic half: `node scripts/backup-db.mjs --plan`).
- **Database (secondary, in-DB):** a weekly `pg_cron` job snapshots every table into the
  `backup_snapshots` table (migration `20260713050000`), keeping 8 weeks, pruned only on
  full success. Protects against bad-data mistakes, NOT against losing the database itself.
- **Edge Function source:** stored in this repo only — git is the backup.
- **Vercel deployments:** retained ~30 days; you can promote any past deployment.
- **Storage buckets** (blend ticket images, signature uploads): NOT covered by either
  backup path above — treat uploads as re-obtainable from the customer if lost.

### 4.2 Restoring

**Bad data written (table intact):** query `backup_snapshots` for the affected table's
last-known-good rows and write a compensating fix through the normal migration gate.

**Database lost/corrupted:** clone `masonwells1/CRX_Backups`, decrypt the newest dump
(key location: Mason's password manager), and restore with `pg_restore`/`psql` against a
fresh project using the Session-pooler connection string (IPv4). Restore to a NEW
project first — never overwrite production directly.

**Restore drill (recommended quarterly):** run the database-lost path against a throwaway
project, verify representative rows (`customers`, `invoices`, recent
`inventory_transactions`), document the time it took here.

**Last drill:** _none yet (still open as item 8 in `TODO.md`)_

### 4.3 What's NOT in the backup

- `.env` secrets (live in Vercel + Supabase, NOT in any database backup)
- Resend email logs (Resend's own retention — 30 days)
- Sentry error history (Sentry's own retention)
- GitHub Actions logs (90 days)

Keep an offline copy of:
- Supabase service role key (in a password manager)
- Resend API key
- Mapbox token
- Sentry DSN
- Vercel deploy hooks (if any)

---

## 5. Month-end close

**Cadence:** First weekday of every month, for the previous calendar month.

1. **Confirm all deliveries are completed or cancelled** for the closing month. Open `Deliveries` page → filter status = `in_progress` or `scheduled` with delivery date in the closing month → resolve each.
2. **Confirm all invoices are posted or voided** for the closing month. `Invoices` page → filter status = `unposted` or `draft` with invoice date in the closing month → post or void.
3. **Generate finance charges** for overdue customers (Customers → Statements → Generate Finance Charges).
4. **Run the period close:** Month-End Close page (`/month-end`, admin only) → close the month. The `close_accounting_period()` RPC checks for any blocking open transactions and refuses if anything is incomplete.
5. **Generate statements** (Customers → Statements → Generate Batch Statements) and review/email.
6. **Apply remaining prepayments:** Customers → Prepay → Apply Remaining → confirm balances.
7. **Reconcile commissions:** Commissions page → review the prior month → mark paid where applicable.
8. **Export reports** (Reports page → P&L, Balance Sheet, AR Aging) for record keeping.

If the close RPC rejects: read the error message — it names the open transaction. Resolve the transaction first, then retry.

---

## 6. Common incidents

### 6.1 "The site is down"

1. **Check Vercel status:** dashboard shows current deployment health.
2. **Check Supabase status:** https://status.supabase.com
3. **Hit the health endpoint:** `curl -I https://croprxsolutions.app/` should return `200`.
4. **Check Sentry:** look for spikes in unhandled errors in the past hour.

If Vercel is fine but the app errors:
- 401/403 errors → Supabase anon key likely changed; verify env var.
- 500 errors from RPC calls → check Supabase logs for the function name.
- Blank screen → check browser console. Likely a missing build asset or CSP violation.

### 6.2 "Emails aren't going out"

1. Open Sentry → filter `edge_function:send-email` (alerts auto-fire on Resend send failures since Sprint F #7).
2. Check Resend dashboard → look for failed sends.
3. Verify `RESEND_API_KEY` in Supabase Edge Function secrets (rotated keys are the most common cause).
4. Manually call `send-email` from the live app with a test recipient; the response includes any error body.

### 6.3 "A git hook is taking too long"

The pre-commit hook is fast: it checks the ledger requirement, private-artifact containment
and the staged high-risk files only. The pre-push hook runs typecheck and build, so it is the
slow one. Full lint, unit/guard tests and coverage run in GitHub CI on the PR. If a hook is slow:
- `npm ci` to ensure clean dependencies
- Restart your terminal
- `--no-verify` is never allowed (`AGENTS.md`); fix the slow step instead.

### 6.4 "I broke a migration that's already applied"

See §3.2 — write a forward-fix migration, never edit history.

### 6.5 "Customer reports their data is wrong"

1. Check `activity_feed` for the customer + date range — every meaningful mutation is logged with `performed_by`.
2. Check `financial_audit_log` for any payment/invoice mutations — append-only, never deleted.
3. If the bug is a system bug, write the fix migration; if it's user error, walk them through the correct flow.

---

## 7. Routine maintenance

| Task | Cadence | How |
|---|---|---|
| Restore drill | Quarterly | §4.2 |
| Month-end close | Monthly (first weekday) | §5 |
| Vercel + Supabase + Resend usage check | Monthly | Each dashboard's billing tab |
| Sentry triage | Weekly | Sentry → Issues → unresolved |
| Dependency audit (`npm audit`) | Weekly | Run `npm audit --audit-level=critical` |
| `pg_cron` job health (after Sprint F #3) | Monthly | Supabase → Database → cron schedules |
| Reconciliation report (after Sprint F #4) | Monthly, before close | Admin dashboard → Integrity Report |

---

## 8. Hard rules (from `AGENTS.md`, repeated here for ops)

- **NEVER** modify or delete an existing migration file. Only add new ones.
- **NEVER** drop RLS from a table. Every table must have RLS.
- **NEVER** expose `service_role` key in the frontend.
- **NEVER** modify `financial_audit_log` records — append-only.
- **NEVER** use binary floating point for money. New storage uses `bigint` cents.
  Legacy PostgreSQL numeric-dollar storage is not an approved exception until exact
  `numeric` arithmetic, clean finite whole-cent values, and an active finite whole-cent
  CHECK are verified. Dirty or unconstrained columns remain tracked findings.
- **NEVER** commit or push with `--no-verify` (bypasses the git hooks).
- **NEVER** push to `main` directly; every change lands through a PR.

---

## 9. Quick reference — files & docs

| Doc | Purpose |
|---|---|
| `AGENTS.md` | Project rules shared by every agent (`CLAUDE.md` adds Claude-only routing) |
| `docs/manual/CURRENT_STATE.md` / `KNOWN_ISSUES.md` | What is live now / what is known broken |
| `DEPLOYMENT.md` | How changes reach production; Edge Function secrets |
| `docs/workflows/SAFE_DEVELOPMENT_RULES.md` | Mandatory pre-commit safety checklist |
| `docs/workflows/DATABASE_CHANGE_CHECKLIST.md` | Step-by-step for schema changes |
| `docs/changelog.d/` | One file per change (new entries); `docs/CHANGELOG.md` is the history up to 2026-08-26 |
| `docs/reference/migration-history.md` | Every migration with description |
| `docs/reference/rpc-functions.md` | All RPCs + signatures |
| `docs/reference/database-schema.md` | All tables + RLS matrix |
| `docs/audits/` | Codex audit findings (current and past) |

---

## 10. When to update this runbook

After any of:
- New Edge Function deployed
- New external service integrated (replace Resend, add Stripe, etc.)
- Disaster recovery drill performed (record outcome in §4.2)
- Incident that revealed a missing playbook step
- New month-end procedure or accounting period rule
