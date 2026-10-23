## 2026-10-22 — "skip coderabbit" waiver: strict dates and session-plumbing tests

- A waiver file dated even a moment in the future, or claiming more than 24 hours, is no waiver
  (`.claude/hooks/coderabbit-skip-lib.mjs`; Luna round 1 on PR #1035 found a 60-second grace window).
- Tests now pin that the Codex gate binds the lookup to its hook payload's session id and that a migration
  apply hands the landing gate the applying session's id.
