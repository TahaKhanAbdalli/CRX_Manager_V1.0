## 2026-10-26 - One CodeRabbit review per PR: Luna round 2 fixes (#1125)

- Any other CodeRabbit review of the reviewed commit must also have an empty body; written text
  there could hold a finding with no severity label.
- `AGENTS.md`, `CLAUDE.md` and `.cursorrules` are excluded at every folder depth.
- A merge of main may change only the five shared status ledgers the PR also edits
  (KNOWN_ISSUES, TO_DO_LIST, CURRENT_STATE, migration-history, CHANGELOG), not policy or
  guidance documents; past PR #1017 is therefore no longer covered (its merge changed
  `docs/workflows/UI_PATTERNS.md`).
- The base comparisons must carry every file's status and blob, or nothing is proved.
- File paths in the Sol prompt section are JSON-quoted, so a line break in a path cannot escape
  the untrusted-data fence; the landing reminder mentions that Sol may run first.
