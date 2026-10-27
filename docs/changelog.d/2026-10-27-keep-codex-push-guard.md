## 2026-10-27 - Keep codex-push-guard wired

- Sol on the dead-guard cleanup (head 5a34e56) returned BLOCKERS on one point: unwiring `codex-push-guard.mjs` weakens a direct-push hook, which AGENTS.md forbids, and Sol cannot verify GitHub's `protect-main` ruleset from its packet. The guard is wired again in `.claude/settings.json` and back in `CLAUDE_ONLY_HOOKS`. The cleanup now unwires three hooks (`active-area-guard`, `rls-on-new-tables`, and Claude's `stop-verify`). Whether to unwire this one too is left to Mason.
