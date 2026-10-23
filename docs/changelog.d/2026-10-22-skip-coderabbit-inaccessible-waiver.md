## 2026-10-22 — "use coderabbit": a waiver that cannot be checked counts as still live

- `withdrawCodeRabbitSkip()` checks for a leftover waiver with `mayExist()` (`lstat`), which reports a file as gone
  only on `ENOENT`/`ENOTDIR`. `existsSync` also returned false on a permission error, so a waiver in a temporarily
  inaccessible folder was reported cancelled and could come back into force (Codex App P2 on PR #1035).
