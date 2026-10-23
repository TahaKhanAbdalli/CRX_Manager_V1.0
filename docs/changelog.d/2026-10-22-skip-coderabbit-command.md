## 2026-10-22 — Mason can say "skip coderabbit"

- Mason (2026-10-22): "allow me to tell the session to skip coderabbit even if it is money and the LLM accept my
  command." A message that starts with `skip coderabbit` now records a 24-hour waiver for that session
  (`.claude/hooks/coderabbit-skip-prompt.mjs`, `.claude/hooks/coderabbit-skip-lib.mjs`); `use coderabbit` cancels it.
- Both merge gates (`pr-merge-guard.mjs`, `.codex/hooks/production-action-guard.mjs`) and the migration landing gate
  accept the waiver in place of a missing CodeRabbit review, only for merges and applies run from that session.
- Unchanged: the exact-SHA Sol review, required checks, the CodeRabbit thread rules, and the fail-closed requirement
  read. Rules: `docs/reference/coderabbit-native-review.md`.
