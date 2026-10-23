## 2026-10-22 — "use coderabbit" says NOT CANCELLED when it cannot find the waiver folder

- `withdrawCodeRabbitSkip()` reports a waiver still live when no waiver folder could be resolved (the git lookup
  failed), and the prompt hook then tells the agent "CODERABBIT SKIP NOT CANCELLED" instead of staying silent while
  the waiver stays on disk for a later merge (final Sol review on PR #1035, HIGH).
