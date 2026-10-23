## 2026-10-22 — "use coderabbit" with no session id says NOT CANCELLED

- `withdrawCodeRabbitSkip()` reports a cancel it cannot attribute to a session (no usable session id) as unconfirmed,
  so the prompt hook says "CODERABBIT SKIP NOT CANCELLED" instead of staying silent while the real session's waiver
  stays on disk (Codex App P2 on PR #1035).
