# Moving the app repo into the `croprxsolutions` GitHub organization

**Status:** prepared 2026-10-27, not started. Mason does the clicks marked **YOU**; an agent session does the
steps marked **AGENT**.

## Why

The repo lives on Mason's personal GitHub account. A personal-account repo can only give a collaborator full
write access, which includes the Merge button, and the Sol review and other merge rules run only on the
agents' side, so a person with write access could merge past them. A free GitHub organization can give
**read-only** access instead. The repo stays **public**, so the automatic checks and CodeQL scans stay free.
The paid Team plan is only needed if the repo later goes private (a free plan turns off `main`'s protection
on private repos).

## What does not change

- The repo name, its history, issues, pull requests, Actions secrets, rulesets (`protect-main`), and the
  Vercel environments all move with it.
- GitHub redirects the old address (`github.com/masonwells1/CRX_Manager_V1.0`) to the new one.
- Mason keeps his personal account and login. `masonwells1/CRX_Backups` stays private on the personal
  account and does not move.
- The agents' guards already accept both addresses (PR adding `.claude/hooks/app-repo-identity.mjs`), so
  nothing goes unguarded during or after the move. That PR must be merged **before** step 4.

## Baseline (read 2026-10-27, for the after-move check)

- Actions secrets (6): `E2E_TEST_EMAIL`, `E2E_TEST_PASSWORD`, `VITE_MAPBOX_TOKEN`, `VITE_SENTRY_DSN`,
  `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL`. No Actions variables, no repo webhooks, no deploy keys.
- Environments: `Preview`, `Production`. CodeQL default setup: configured.
- Ruleset `protect-main` (active): required checks `Vercel`, `Lint, Type Check, Test, Build`,
  `SQL Migration Validation`. Ruleset `only-mason-merges-main`: disabled.

## Before you start

Pick a quiet time: no pull request waiting on a CodeRabbit review, and no agent mid-merge or mid-migration.
CodeRabbit reviews done under the old address won't count for those PRs after the move.

## Steps

1. **YOU: create the organization — soon, even before the rest.** This claims the name; until it exists,
   someone else could register `croprxsolutions`. On github.com, click your picture (top right) → **Your organizations** →
   **New organization** → **Free**. Name: `croprxsolutions`. Contact email: Mason@croprxsolutions.com.
   "Belongs to": **A business or institution**, name **Crop RX Solutions**. Skip inviting anyone.
2. **YOU: lock down default access.** In the new organization: **Settings → Member privileges → Base
   permissions → No permission**. Under **Settings → Third-party access → OAuth app policy**, keep the
   restrictions on and approve **GitHub CLI** only (it appears there after its first request; the agent
   session in step 7 triggers that request and tells you when to click). Without it the agents' `gh`
   commands can't reach the repo after the move. Don't choose "No restrictions": that would let any app
   a member authorizes reach the organization's repos.
3. **YOU: install the apps on the organization** (each asks you to pick the organization and "Only select
   repositories"; the repo can be picked after step 4, or choose "All repositories"):
   - Vercel: vercel.com → your project → **Settings → Git** → it shows the connected repo; use **Install
     GitHub App** / **Configure** for `croprxsolutions`.
   - CodeRabbit: app.coderabbit.ai → **Add organization** → `croprxsolutions`.
   - Codex (ChatGPT) GitHub connector: github.com/apps → the ChatGPT Codex Connector app → **Configure** →
     `croprxsolutions`.
   - Sentry: crop-rx-solutions.sentry.io → **Settings → Integrations → GitHub** → **Add Installation** →
     `croprxsolutions`. This is what links an error to the commit that likely caused it ("Suspect
     Commit"). After step 4, if you picked "Only select repositories": github.com/organizations/croprxsolutions
     → **Settings → GitHub Apps** → Sentry → **Configure** → **Repository access** → add `CRX_Manager_V1.0`.
4. **YOU: move the repo.** github.com/masonwells1/CRX_Manager_V1.0 → **Settings → General** → bottom of the
   page, **Transfer ownership** → choose `croprxsolutions` → type the repo name to confirm.
5. **YOU: reconnect Vercel if needed.** Vercel → project → **Settings → Git**. It should show
   `croprxsolutions/CRX_Manager_V1.0`. If it shows "disconnected", click **Connect Git Repository** and pick it.
   The production branch stays `main`; don't change environment variables.
6. **YOU: add Taha read-only.** github.com/croprxsolutions/CRX_Manager_V1.0 → **Settings → Collaborators
   and teams → Add people** → `TahaKhanAbdalli` → role **Read**.
7. **AGENT: check everything came across**, in a fresh session ("check the GitHub org move"):
   - point the local checkout's `origin` at `https://github.com/croprxsolutions/CRX_Manager_V1.0.git`
     (every worktree shares it) and confirm `git fetch` works;
   - compare secrets, environments, rulesets, required checks and CodeQL against the baseline above;
   - open a small docs-only PR and watch every required check, including `Vercel`, go green on it;
   - after that PR merges, confirm Vercel deployed production from the new address, that Sentry's
     GitHub integration lists `croprxsolutions/CRX_Manager_V1.0`, and that the first Sentry error from
     production after the move shows a **Suspect Commit** (listing the repo alone does not prove the link
     works). Errors are rare, so this item may stay open for days; nothing else waits on it;
   - confirm Taha's access shows as **Read**.
8. **AGENT: follow-up PR** that switches the remaining fixed references to the new address:
   `scripts/land-pr.mjs`, `scripts/daily-landing-summary.mjs` (default only; Actions already passes the
   real name), the command text in `.claude/hooks/coderabbit-skip-prompt.mjs`, the badge comment in
   `.github/workflows/ci.yml`, and the repo address in `AGENTS.md`, `README.md` and the manual docs.

## If something goes wrong

A transfer can be reversed the same way (Transfer ownership back to `masonwells1`). If Vercel stops deploying,
the live site keeps serving the last deploy; reconnect it in step 5. Any fine-grained GitHub token limited to
"masonwells1" repositories won't reach the moved repo and has to be re-scoped to the organization.
