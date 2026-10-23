## 2026-10-22 — "skip coderabbit #<PR>" never splits one number into two PRs

- The PR-number parser in `coderabbit-skip-lib.mjs` requires every number to end where its digits end and to be
  followed by a real separator; a run-together, glued or over-long number ("99999991018", "#1018#1020") waives nothing
  instead of being read as two PRs (Luna round 4 on PR #1035, HIGH).
- The Claude merge gate reads the session id as `session_id`, else `sessionId`, the same as the prompt hook and the
  Codex gate (Luna round 4, LOW).
