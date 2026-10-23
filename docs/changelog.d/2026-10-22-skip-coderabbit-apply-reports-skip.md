## 2026-10-22 — a migration apply on a waived PR says CodeRabbit was SKIPPED

- `evaluateMigrationApply()` carries the landing gate's `coderabbitSkippedBy` on its allow verdict, and
  `scripts/apply-migration-file.mjs` prints "CODERABBIT SKIPPED" and no longer tells the operator the PR's CodeRabbit
  review is clean when Mason's waiver stood in for it (Codex App P2 on PR #1035).
- The gates' suggested PR comment for a waived merge names the repository
  (`gh pr comment <n> --repo masonwells1/CRX_Manager_V1.0`), so it lands on the merged PR even from another checkout
  (Codex App P2 on PR #1035).
