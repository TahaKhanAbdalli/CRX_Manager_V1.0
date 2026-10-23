## 2026-10-22 — an oversized CodeRabbit waiver file is refused unread

- `findCodeRabbitSkip()` checks a waiver file with `lstat` first and never reads one larger than 4096 bytes or one
  that is not a plain file, so a huge or corrupt file cannot run a gate out of time (a killed hook emits nothing,
  which allows) (Luna round 5 on PR #1035, HIGH).
