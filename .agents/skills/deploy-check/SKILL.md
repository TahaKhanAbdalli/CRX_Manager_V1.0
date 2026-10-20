---
name: deploy-check
description: Pre-merge checklist for CRX Manager — verifies a branch is safe to land. Since `main` is protected (2026-07-14), landing means branch → draft PR → checks → mark ready (one advisory CodeRabbit review) → Sol → merge, and the merge is what deploys production via Vercel. Use before opening or merging a PR, or before applying migrations to Supabase.
---

# Pre-Deployment Check

A final gate before landing work on `main`. Checks code quality, unapplied migrations,
environment safety, and production readiness.

**How production actually deploys (updated 2026-07-14).** `main` is protected by the GitHub
`protect-main` ruleset, so **direct pushes to `main` are impossible for everyone** — Claude,
Codex, and Mason alike. The landing path is:

**push a branch → open a DRAFT PR → finish required checks → freeze the candidate → mark the PR
ready (CodeRabbit, advisory since 2026-10-19, reviews it once; fix or refute any comments that
arrive before the merge, but do not wait for it) → exact-SHA Sol proof → merge with
`--match-head-commit <reviewed-head-sha>`.** The **merge** is what deploys production via Vercel's
git integration; Vercel's one-click rollback is the accepted safety net.

Run this skill on the branch **before** opening the PR (and again before merging if the branch
moved).

## Step 1: Git Status

```bash
git status && git log --oneline -5
```

```bash
git fetch origin && git rev-list --left-right --count origin/main...HEAD
```

Check:
- Are there uncommitted changes? (WARN — should commit first)
- Are we on a **feature branch**? Being on `main` is the problem case here, not the goal — work
  cannot land from `main` because direct pushes are blocked. If HEAD is `main`, tell the user to
  branch first.
- Is the branch behind `origin/main`? (WARN — rebase or merge before opening the PR, or the
  reviewed diff and the Vercel check will not reflect what actually lands.)
- What was the last commit? (Show it to the user)

## Step 2: Code Quality Gate

Run these in sequence:

```bash
npm run lint && npm run typecheck && npm run build
```

ALL THREE must pass. If any fail, stop and report — do not proceed to deployment.

## Step 3: Unit Tests

```bash
npm run test -- --reporter=verbose 2>&1 | tail -20
```

Must have 0 failures. Report test count and any failures.

## Step 4: Check for Unapplied Migrations

```bash
# Count local migration files
echo "Local migrations: $(ls supabase/migrations/*.sql | wc -l)"
```

Compare against the live database (Supabase MCP `list_migrations`). If there are NEW migrations that haven't been applied to the live database yet, WARN the user:

```
⚠️  You have X new migration(s) not yet applied to production.
    Apply them through /migration-review → scripts/apply-migration-file.mjs
    BEFORE merging (non-destructive: under Mason's 2026-09-26 landing rule
    once the final reviews are clean; destructive, data-overwriting or access-changing: only after Mason's own `I approve` chat reply for that exact file (`scripts/owner-approve-migration.mjs` builds the request; the apply gate enforces the recorded reply)), or the
    app will reference tables/columns/functions that don't exist yet.
    NEVER `supabase db push` — it bypasses the review gate and is blocked.
```

## Step 5: Environment Check

Verify no secrets are exposed:

```bash
# Check for .env in git tracking
git ls-files | grep -i "\.env"
# Check for hardcoded keys in source
grep -r "service_role" src/ --include="*.ts" --include="*.tsx" -l
grep -r "sk_live\|sk_test\|SUPABASE_SERVICE" src/ --include="*.ts" --include="*.tsx" -l
```

If any results, BLOCK deployment and report.

## Step 6: Bundle Size Check

```bash
# Build already ran in step 2, check the output size
ls -lh dist/assets/*.js 2>/dev/null | head -5
```

Report the largest JS chunks. Warn if any single chunk is > 500KB.

## Step 7: Deployment Summary

```
╔══════════════════════════════════════════╗
║     PRE-DEPLOYMENT CHECK COMPLETE        ║
╠══════════════════════════════════════════╣
║                                          ║
║  Branch:          <feature branch>       ║
║  Behind origin/main: X commits           ║
║  Clean working tree: YES / NO            ║
║  Last commit:     <hash> <message>       ║
║                                          ║
║  Lint:            PASS                   ║
║  TypeScript:      PASS                   ║
║  Build:           PASS                   ║
║  Tests:           X/Y passed             ║
║  Secrets exposed: NONE                   ║
║  Unapplied migrations: X                 ║
║  Largest bundle:  XXX KB                 ║
║                                          ║
║  Verdict: READY FOR PR / BLOCKED         ║
╚══════════════════════════════════════════╝
```

If ready, state the remaining landing steps explicitly — this skill does **not** land anything:

1. Push the **branch** (never `main` — the `protect-main` ruleset rejects it).
2. Open the PR as a **draft**.
3. Finish implementation, bring the branch up to date, and wait for required checks;
   **Vercel is a required check**.
4. Once required checks are green, freeze the candidate, record its head SHA, and mark the PR
   ready. CodeRabbit is **advisory** since 2026-10-19 (Mason): it reviews each PR ONCE, when it is
   marked ready or opened non-draft, never on later pushes; it never submits APPROVED or
   CHANGES_REQUESTED; and it skips PRs whose title contains `docs(`. GitHub's `protect-main`
   ruleset no longer requires an approving review (required status checks stay). If CodeRabbit's
   review arrives before the merge, fix or refute with evidence every comment, in one push. Do not
   wait for it if it has not reviewed by the time checks are green and Sol is clean, and never post
   `@coderabbitai review` to buy a re-review. A failed CodeRabbit pre-merge "error" check is a
   finding to fix or refute, not a blocker. **A fix goes on the SAME PR** — no replacement PR. Never
   use `@coderabbitai resume` or any other `@coderabbitai` command. The legacy `ready-for-coderabbit`
   label route no longer triggers a review; `docs/reference/coderabbit-native-review.md` describes it.
5. Run the exact-SHA `gpt-6-sol` high-effort proof LAST (every change, since 2026-09-26, except a documentation-only
   change as defined in `docs/reference/sol-exempt-paths.md`, which the merge gates accept without
   it; run Sol only if a gate refuses saying "documentation-only exemption does not apply",
   and fix any other refusal's own failing condition), then apply the change's
   non-destructive migration if it has one, then merge with `--match-head-commit`. Both agent
   merge gates enforce Mason's autonomous-landing rule: the newest run of every reported check
   green with `mergeStateStatus` CLEAN, the head containing GitHub's real base, and the Sol proof
   bound to that head and that base (or the documentation-only exception); CodeRabbit approval is
   no longer required (2026-10-19). `CHANGES_REQUESTED` (from anyone), `--auto` and `--admin` are
   refused. The `protect-main` ruleset has no bypass actors, so its required checks bind admins too;
   no agent uses `--admin` either way. **The merge
   is the deploy.**

Landing under Mason's autonomous-landing rule (2026-09-26) needs no in-chat ask once those gates
pass; report the merge explicitly rather than silently. A direct `vercel --prod` deploy outside the
merge path or an Edge Function deploy still needs Mason's explicit yes. A non-destructive live
migration applies under the same rule through migration-apply-guard's full proof gate (hash-bound
dual-reviewer proof + hash-bound Sol proof, both fresh ≤30 min) in any session; a destructive,
data-overwriting or access-changing one applies only after Mason's own `I approve` chat reply for that exact file (`scripts/owner-approve-migration.mjs` builds the request; the apply gate enforces the recorded reply), through `scripts/apply-migration-file.mjs`.
If blocked: List every issue that needs fixing first.

## Rules

- NEVER push a branch, open a PR, or merge if lint, typecheck, or build fails
- NEVER merge if tests have new failures
- NEVER push/merge if secrets are found in source code
- NEVER merge with unapplied migrations pending without surfacing them (warn — Mason decides the ordering)
- NEVER attempt to push directly to `main`; the ruleset blocks it and the attempt is a bug in the plan
- NEVER mark the PR ready (which triggers CodeRabbit's single review) while implementation or Codex review is still changing the branch
- NEVER merge over a `CHANGES_REQUESTED` verdict; CodeRabbit approval is not required (advisory since 2026-10-19), but every CodeRabbit comment that arrived before the merge must be fixed or refuted with evidence
- Edge Function deploys and direct Vercel CLI deploys always need Mason's explicit approval; only the reviewed merge path is covered by the autonomous-landing rule. Non-destructive live migrations apply under that rule once migration-apply-guard's full proof + Sol gate passes; destructive, data-overwriting or access-changing migrations apply only after Mason's own `I approve` chat reply for that exact file (`scripts/owner-approve-migration.mjs` builds the request; the apply gate enforces the recorded reply), through `scripts/apply-migration-file.mjs`
