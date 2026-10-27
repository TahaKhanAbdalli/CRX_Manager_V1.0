## 2026-10-27 - Unwire four dead or duplicate project hooks

Guard cleanup item 4 (Mason, 2026-10-26: "looser guards"). Removed from `.claude/settings.json` and `.codex/hooks.json`:

- `codex-push-guard.mjs`: it judged only pushes to `main`, which GitHub's `protect-main` ruleset already refuses. `codex-push-lib.mjs` stays (the merge gates and autopilot use it). Dropped from the Claude-only list in `scripts/agent-manifest-parity.mjs`.
- `active-area-guard.mjs`: its config `.claude/active-areas.json` has never existed, so it allowed everything.
- `rls-on-new-tables.mjs`: `scripts/check-migration-hard-rules.mjs` refuses a new table without RLS and a policy in CI on every PR. Checked with probe migrations: no RLS refused, no policy refused, both passed.
- `stop-verify.mjs`, from Claude's manifest only: the owner's global verify-before-stop hook covers Claude sessions. Codex has no global equivalent, so `.codex/hooks.json` keeps it (now in `CODEX_ONLY_HOOKS`; Luna round 1).

The removed files stay on disk for now (the review-proof guard refuses shell deletes under `.claude/hooks/`); deleting them is a follow-up. Docs: `docs/reference/agent-guardrails.md` rows, `docs/manual/AI_TOOLING_GUIDE.md`, `docs/manual/AGENT_ONBOARDING.md`, `.claude/commands/ship.md`, `.claude/skills/codex-review/SKILL.md`.
