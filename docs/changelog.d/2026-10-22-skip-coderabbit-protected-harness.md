## 2026-10-22 — the CodeRabbit-skip module is protected from Codex edits

- `.claude/hooks/coderabbit-skip-lib.mjs` joins the Codex production gate's protected-harness list
  (`PROTECTED_HARNESS_SOURCE` / `PROTECTED_HARNESS_FILES`): it is imported at startup and decides whether Mason waived
  a money PR's CodeRabbit review, so a Codex session may not write, patch or overwrite it (Codex App P1 on PR #1035).
- The module now uses only Node built-ins and carries its own `skipStateDirs()` (the same folder rule as
  `ownerRequestDirs`), so the Codex gate no longer imports `owner-approval-lib.mjs`; the prompt hook and all three gates
  resolve the waiver's folders through that one function. A new test fails if any `.claude/hooks/` module the Codex gate
  imports at startup is missing from the protected list.
