## 2026-10-22 — "skip coderabbit" reaches the MCP apply hook too

- `.claude/hooks/migration-apply-guard.mjs` (the `apply_migration` hook) now passes its payload's session id to
  `evaluateMigrationApply()`, so Mason's session-bound waiver reaches the landing gate on that path as it does through
  `scripts/apply-migration-file.mjs` (Codex App P2 on PR #1035). It still never opens the owner-approval door, so a
  parked migration stays refused there.
