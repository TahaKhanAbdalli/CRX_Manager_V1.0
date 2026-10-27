## 2026-10-27 - Tooling guide says Codex still runs stop-verify

- Luna round 2 (LOW) on the dead-guard cleanup: `docs/manual/AI_TOOLING_GUIDE.md` now says Codex keeps `stop-verify` and only Claude's wiring was dropped.
- Refuted in the same round, with live evidence: the `protect-main` ruleset is active with zero bypass actors and requires a pull request, so no one can push straight to `main` (the reason `codex-push-guard` was unwired); and no `.claude/active-areas.json` exists in any checkout on the workstation.
