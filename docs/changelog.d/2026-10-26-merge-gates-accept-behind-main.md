## 2026-10-26 — A pull request may merge behind main

- GitHub's "branch must be up to date" rule on `main` is off (Mason, 2026-10-26: classic branch
  protection `strict: false`; the `protect-main` ruleset already had it off).
- Both agent merge gates (`.claude/hooks/pr-merge-guard.mjs`, `.codex/hooks/production-action-guard.mjs`)
  stop refusing a head that does not contain GitHub's base. A clean Sol proof of the exact head keeps
  counting when main has only moved forward from the base it was reviewed against
  (`proofValidForMerge()` in `.claude/hooks/codex-push-lib.mjs`).
- Unchanged: the migration landing gate, direct pushes to main, and the documentation-only exemption.
- Docs: `AGENTS.md`, `.claude/commands/ship.md`, the codex-review and deploy-check skills,
  `docs/reference/agent-guardrails.md`, `docs/manual/DECISION_LOG.md`.
