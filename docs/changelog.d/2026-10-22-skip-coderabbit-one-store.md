## 2026-10-22 — CodeRabbit waivers live in one place for every worktree

- `skipStateDirs()` in `coderabbit-skip-lib.mjs` resolves the MAIN checkout's `.claude/session-state` through git's
  shared folder (`git rev-parse --git-common-dir`), so the prompt hook, both merge gates and the migration landing gate
  all record, find and cancel waivers in one folder. Before, a waiver recorded in one worktree survived a
  `use coderabbit` sent from another (final Sol review on PR #1035). The folder stays under the review proof guard's
  `.claude/session-state` protection; a folder outside a normal git checkout holds no waiver.
