## 2026-10-22 — the CodeRabbit waiver lookup stays inside each gate's time budget

- `skipStateDirs()` makes one `git` call per distinct folder and, given a gate's `deadlineMs`, starts a call only if it
  can finish before it, capped to the time left (at most 3 seconds); out of time, no waiver is found. Both merge gates
  pass their advisory deadline, so the lookup can no longer outlast the hook after slow GitHub reads (a killed hook emits
  nothing, which allows) (Codex App P2 on PR #1035).
