## 2026-10-21 - CodeRabbit makes no automatic reviews

- **CodeRabbit makes no automatic reviews** (Mason, 2026-10-21: "Yes turn off auto review").
  `.coderabbit.yaml` sets `reviews.auto_review.enabled: false`, so marking a PR ready no longer
  spends one of the roughly one-an-hour CodeRabbit reviews. CodeRabbit now reviews only when an
  agent posts `@coderabbitai full review`, once per head on a money or Mason-named PR (unchanged
  rule and merge-gate enforcement). The config pin test now pins `enabled: false`, and its
  negative controls check every form that could switch automatic reviews back on. `AGENTS.md`,
  `.claude/commands/ship.md`, the codex-review and deploy-check skills, the landing reminder in
  `.claude/hooks/prompt-source-lib.mjs`, and the CodeRabbit, guardrail, gotchas, safe-development,
  current-state, owner-playbook and decision-log docs say the same.
