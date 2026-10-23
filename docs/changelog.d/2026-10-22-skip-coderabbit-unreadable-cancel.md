## 2026-10-22 — "use coderabbit": an unreadable leftover waiver still counts

- `withdrawCodeRabbitSkip()` now treats any waiver file still on disk as live, readable or not, so a copy that can be
  neither deleted nor read is reported "NOT CANCELLED" rather than silently left for a gate to read later
  (Luna round 3 on PR #1035).
