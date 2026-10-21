## 2026-10-21 — Agent contract lean pass: Luna round 2 wording fixes

- `AGENTS.md` CodeRabbit bullet: the Codex GitHub App thread rule no longer reads as conditional on
  CodeRabbit having reviewed; the CodeRabbit thread rule says "on any commit" (as both merge gates
  check); and the `docs(` title skip is back in the always-loaded text so an agent does not wait for
  a review that will not come.
- `CLAUDE.md` restores the original trigger, "after schema changes", for refreshing
  `.claude/schema-registry.json` (the lean pass's "after a live schema change" had narrowed it).
