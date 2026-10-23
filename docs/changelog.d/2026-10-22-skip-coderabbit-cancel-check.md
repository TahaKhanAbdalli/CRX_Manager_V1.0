## 2026-10-22 — "use coderabbit" now confirms the waiver is really gone

- `withdrawCodeRabbitSkip()` (`.claude/hooks/coderabbit-skip-lib.mjs`) removes the waiver and then re-checks; if a
  copy could not be deleted, the prompt hook says "CODERABBIT SKIP NOT CANCELLED" instead of staying silent, so a
  waiver Mason withdrew is never left quietly live (Luna round 2 on PR #1035).
- The prompt hook reads the session id the same way the Codex gate does (`session_id`, else `sessionId`).
- The hook's note to the agent now says plainly that the waiver is Mason's own instruction recorded from his message.
