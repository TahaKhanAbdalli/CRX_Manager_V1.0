## 2026-10-19 — CodeRabbit becomes advisory: one review per PR, no approval needed to merge

Mason's decision ("cut coderabbit volume" and "not force to have a review"):

- `.coderabbit.yaml`: `request_changes_workflow: false` (CodeRabbit comments only and never
  approves or blocks), `auto_incremental_review: false` (one review per PR, when it is marked
  ready, none on later pushes), `ignore_title_keywords: ["docs("]` (documentation PRs skipped).
- Merge gates (`.claude/hooks/pr-merge-guard.mjs`, `.codex/hooks/production-action-guard.mjs`)
  and the migration landing gate (`.claude/hooks/migration-landing-gate-lib.mjs`) no longer
  require CodeRabbit's APPROVED verdict on the exact head. `coderabbitApprovedHead` is removed
  from `codex-push-lib.mjs`. Still required: green checks, no CHANGES_REQUESTED, base
  containment, the `--match-head-commit` pin, and the exact-SHA Sol proof (documentation-only
  changes excepted).
- Rules and prompts updated: `AGENTS.md`, `.claude/commands/ship.md` (Step 8: handle CodeRabbit's
  comments if it reviews, never buy a re-review), session prompts, `scripts/check-agent-guidance.mjs`,
  the docs-only rules page, and the reference/manual docs that described the old approval rule.
- Mason removes the `protect-main` ruleset's required approving review in GitHub himself.
- Recorded in `docs/manual/DECISION_LOG.md` (2026-10-19).
