# Services and Accounts

Every outside service CRX Manager depends on, which key or secret each one uses, where that
secret is stored, who owns the account, and what it costs. Written for the incoming senior
developer and for Mason (Goal 10, `docs/plans/2026-10-13-direction-and-goals.md`).

**This repository is public.** This page lists secret **names** and **where they are stored**,
never their values. Do not add a value, a password, an account number, a card or invoice
figure, or a recovery code here. Prices below are public list prices, not CRX's bills.

Checked on 2026-10-23 from the code (`.env.example`, `supabase/functions/`, `vite.config.ts`,
`vercel.json`, `.github/workflows/`), from `gh secret list` (names only), and from read-only
account lookups. Anything not visible that way is marked **Mason to confirm**.

## Where secrets live

| Place | What is stored there | Who can see it |
|---|---|---|
| **Vercel project env** (`crx-manager-v1-0`) | Values baked into the browser app at build time, plus the Sentry upload token | Members of the Vercel team "Mason Wells' projects" |
| **Supabase Edge Function secrets** (project `rhyzpcqhnizqbxphqdkr`) | Keys the server-side functions use: email, OCR, error reporting, CORS | Supabase org members |
| **GitHub Actions secrets**, app repo `croprxsolutions/CRX_Manager_V1.0` | Values for CI builds and the paused browser tests | Repo admins (Mason) |
| **GitHub Actions secrets**, private backup repo `masonwells1/CRX_Backups` | Database and file-storage backup credentials, backup passphrase | Repo admins (Mason) |
| **Mason's Windows Credential Manager** | Mason's Supabase CLI login token (target `Supabase CLI:supabase`), used by agents to apply migrations | Mason's Windows login only |
| **Mason's password manager** | The backup decryption passphrase and account passwords | Mason only |

A local `.env` file (git-ignored) holds a developer's own copy of the browser values. The
template is `.env.example`.

## The services

### 1. GitHub (code, CI, backups)

- **Used for:** the code (`croprxsolutions/CRX_Manager_V1.0`, public), CI checks
  (`.github/workflows/ci.yml`), Dependabot updates, the daily landing summary, and the private
  backup repo `masonwells1/CRX_Backups`.
- **Owner:** the app repo belongs to the `croprxsolutions` organization (moved 2026-10-28), which
  Mason owns; an outside developer has read-only access. The backup repo stays on Mason's personal
  account `masonwells1`.
- **Secrets in the app repo:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_MAPBOX_TOKEN`, `VITE_SENTRY_DSN`, `E2E_TEST_EMAIL`, `E2E_TEST_PASSWORD`.
  The CI job "E2E Smoke Tests" also reads `STAGING_SUPABASE_URL` and
  `STAGING_SUPABASE_ANON_KEY`. Those two are **not set**; the job is switched off
  (`if: false`) until the staging system exists. CI otherwise uses GitHub's built-in token.
- **Secrets in `CRX_Backups`:** `SUPABASE_DB_URL` (database connection string for the weekly
  encrypted dump), `BACKUP_PASSPHRASE` (encrypts the dump; **losing it makes every backup
  unreadable**), `SUPABASE_S3_ACCESS_KEY_ID` and `SUPABASE_S3_SECRET_ACCESS_KEY` (copy the
  photo and document storage).
- **Plan / cost:** Mason to confirm (free personal plan is enough for a public repo).
- **Main branch protection:** the `protect-main` ruleset requires a pull request and three
  green checks.

### 2. Supabase (database, logins, file storage, server functions)

- **Used for:** the PostgreSQL database, staff logins, photo and document storage, nightly and
  weekly in-database jobs, and eight Edge Functions (`supabase/functions/`).
- **Owner:** organization "Crop RX Solutions", run by Mason. Production project
  `rhyzpcqhnizqbxphqdkr`.
- **Plan / cost:** **Free plan** (confirmed 2026-10-23). There is no point-in-time recovery and
  no leaked-password protection. Goal list: upgrade to Pro (public price US$25/month) before
  next season; Mason makes that billing change.
- **Browser keys** (Vercel env and GitHub secrets): `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_ANON_KEY`. The anon key is designed to be public; database access rules
  protect the data.
- **Edge Function secrets** (full table in `DEPLOYMENT.md`):
  `ALLOWED_ORIGIN`, `GOOGLE_VISION_API_KEY`, `RESEND_API_KEY`, `FROM_EMAIL`, `SENTRY_DSN`,
  `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`. Supabase supplies `SUPABASE_URL`,
  `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` itself.
  **Mason to confirm** which optional ones are set; the read-only check is
  `npx supabase secrets list --project-ref rhyzpcqhnizqbxphqdkr` (names and hashes only).
- **The service-role key** bypasses every access rule. It exists only inside Supabase and,
  optionally, in a developer's local environment for live-schema tests
  (`CRX_LIVE_SCHEMA_SERVICE_ROLE_KEY`). Never put it in Vercel or in browser code.
- **Management token:** Mason's Supabase CLI token sits in his Windows Credential Manager.
  Agents read it in memory to apply reviewed migrations. The developer should get their own
  Supabase login, not this token.
- **Staging project:** none yet (`.env.staging.example` is a template). Goal 6 builds it.

### 3. Vercel (hosting and deploys)

- **Used for:** hosting the app at `https://croprxsolutions.app` (also
  `crx-manager-v1-0.vercel.app`). Every merge to `main` deploys to production automatically.
  Pull requests get preview deploys, and the "Vercel" check is required on `main`.
- **Owner:** team "Mason Wells' projects" (Mason's account), project `crx-manager-v1-0`.
- **Env vars the build reads:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (required);
  `VITE_MAPBOX_TOKEN`, `VITE_SENTRY_DSN` (optional); `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`,
  `SENTRY_PROJECT` (source-map upload, `vite.config.ts`). **Mason to confirm** which are set in
  Production and Preview.
- **Plan / cost:** **Mason to confirm.** A personal team is usually on the free Hobby plan,
  which Vercel limits to non-commercial use. A business app normally needs Pro (public price
  US$20 per member per month).

### 4. Sentry (error reporting)

- **Used for:** catching errors in the browser app (`src/lib/sentry`) and in Edge Functions
  (`supabase/functions/_shared/sentry.ts`), and uploading source maps at build time so the
  errors point at real code.
- **Owner:** organization `crop-rx-solutions`. Account owner: Mason to confirm.
- **Keys:** `VITE_SENTRY_DSN` (browser; Vercel env and GitHub secret), `SENTRY_DSN` (Edge
  Function secret), `SENTRY_AUTH_TOKEN` (Vercel env, build-time upload only). A DSN only lets
  someone send errors in, so it is not sensitive; the auth token is.
- **Org name:** `vite.config.ts` defaults to `crop-rx-solutions` (fixed 2026-10-26; it used to
  default to `crx-solutions`, and every production source-map upload failed with "Project not
  found"). A `SENTRY_ORG` value in Vercel would override that default, so if the upload fails
  again, check that setting first. The Vercel build log shows the upload result.
- **Plan / cost:** Mason to confirm.

### 5. Resend (outgoing email)

- **Used for:** invoices, statements and other customer email, sent by the `send-email` Edge
  Function from a `croprxsolutions.app` address. Each send is recorded in `email_log`.
- **Keys:** `RESEND_API_KEY` and optional `FROM_EMAIL` (Edge Function secrets).
- **Domain:** `croprxsolutions.app` is verified for sending (Resend's DNS records are present).
- **Owner / plan / cost:** Mason to confirm.
- **Staff login emails** (password resets, invites) are sent by Supabase Auth, not by this
  function. Mason to confirm whether Supabase uses its built-in mailer or custom SMTP.

### 6. Google Cloud Vision (reading scanned tickets)

- **Used for:** text recognition on blend tickets and uploaded documents
  (`process-blend-ticket`, `process-document`).
- **Key:** `GOOGLE_VISION_API_KEY` (Edge Function secret only; never in the browser).
- **Owner:** the Google Cloud project and billing account behind the key. Mason to confirm
  which Google account owns it.
- **Plan / cost:** pay per use; Google's public pricing includes a free first 1,000 images a
  month. Mason to confirm the billing account.

### 7. Mapbox (maps and field boundaries)

- **Used for:** the map and field-boundary drawing screens (`mapbox-gl`).
- **Key:** `VITE_MAPBOX_TOKEN` (Vercel env and GitHub secret). It ships to the browser, so it
  should be a public token restricted to `croprxsolutions.app`. Mason to confirm the URL
  restriction is on.
- **Owner / plan / cost:** Mason to confirm (Mapbox has a free monthly allowance).

### 8. Domain names and company email

- **`croprxsolutions.app`** (the app): registrar **Squarespace Domains**; registered
  2026-02-17, **expires 2029-02-17**. DNS is served from Google Domains-era nameservers, and
  Vercel treats the domain as external. Mason to confirm auto-renew is on and who holds the
  Squarespace login.
- **`croprxsolutions.com`** (company email): registrar **Squarespace Domains**; **expires
  2027-10-22**. Its mail goes to Google, so company email is on Google Workspace. Mason to
  confirm the Workspace plan and auto-renew.

### 9. Keyless public data sources

No account or key. Listed so nobody hunts for credentials that do not exist.

| Source | Used for |
|---|---|
| EPA pesticide registration data (`ordspub.epa.gov`, `www3.epa.gov`) | `epa-lookup` Edge Function: product label lookup |
| Open-Meteo (`api.open-meteo.com`) | Weather captured with field applications |
| U.S. Bureau of Land Management (`gis.blm.gov`) | Legal land description (PLSS) lookup |
| OpenStreetMap static maps (`staticmap.openstreetmap.de`) | Map images in delivery-proof notifications |
| Google Fonts | Web fonts |

### 10. Development and review tools (agents)

None of these run in production. They are how the code gets written and reviewed today.

| Tool | Used for | Credential and where | Owner / plan |
|---|---|---|---|
| **Claude Code** (Anthropic) | Main coding agent | Mason's Claude login in the desktop app | Mason; plan Mason to confirm |
| **Codex CLI** (OpenAI) | Luna and Sol reviews before merge (`docs/reference/codex-model-tuning.md`) | Mason's ChatGPT login, stored in the local Codex config folder | Mason; plan Mason to confirm |
| **Codex GitHub App** | Reviews a PR when it leaves draft | GitHub App installed on the repo | Mason's account |
| **CodeRabbit** | Advisory PR reviews on request (`docs/reference/coderabbit-native-review.md`) | GitHub App installed on the repo | Mason; **Advanced plan** (since 2026-10-19), renewal Mason to confirm |
| **Agent connectors** (Supabase, Vercel, Sentry, GitHub) | Read-only checks and gated actions from Claude | Signed in through the Claude desktop app as Mason | Mason |
| **GitHub CLI** (`gh`) | PRs and merges from the terminal | Mason's `gh` login on his PC | Mason |
| **Graphify** | Local code map | None | Local only |

### 11. Planned, not built yet

QuickBooks Desktop and Stripe (Goal 7) will add credentials. Add them here when they exist.

## Costs and renewals at a glance

| Service | Plan | Renewal |
|---|---|---|
| Supabase | Free (Pro upgrade planned) | Not applicable on Free |
| Vercel | Mason to confirm | Mason to confirm |
| Sentry | Mason to confirm | Mason to confirm |
| Resend | Mason to confirm | Mason to confirm |
| Google Cloud (Vision) | Pay per use | Billing account: Mason to confirm |
| Mapbox | Mason to confirm | Mason to confirm |
| CodeRabbit | Advanced | Mason to confirm |
| Claude, ChatGPT/Codex | Mason to confirm | Mason to confirm |
| GitHub | Mason to confirm | Mason to confirm |
| `croprxsolutions.app` | Squarespace Domains | Expires 2029-02-17 |
| `croprxsolutions.com` + Google Workspace | Squarespace Domains; Workspace plan Mason to confirm | Domain expires 2027-10-22 |

## Access to grant the developer, in order

Each person gets their own login. Never share Mason's passwords, tokens or the backup
passphrase.

1. **Fork only.** The developer forks the public repo and opens pull requests from the fork.
   No secrets, no write access. They run the app locally against their own free Supabase
   project or, once it exists, the staging system.
2. **Staging access** (after Goal 6 builds it): their own login to the staging Supabase
   project and a staging Vercel preview. Test keys only.
3. **Read-only production visibility**: Sentry member, Vercel team viewer, and read-only
   access to the production Supabase project if the plan allows it, so they can see errors and
   deploys without changing anything.
4. **Write access to the GitHub repo**, after the trial period. Merges still go through the
   `protect-main` ruleset and the review gates.
5. **Production Supabase and Vercel admin**, only if Mason decides they will run the system.
   Rotate any key they handled when the engagement ends.

The backup repo `CRX_Backups`, the backup passphrase, the domain registrar, Google Workspace
and billing stay with Mason.
