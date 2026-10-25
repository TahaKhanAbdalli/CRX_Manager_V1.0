## 2026-10-23 - native patch: links into the review state directory; Linux-safe tests

Codex GitHub App review of `e0eb873` on PR #1083.

- **P1.** A directory link inside the repository pointing at `.claude/session-state` let a native patch
  create a CodeRabbit waiver file (`coderabbit-skip-<session>-pr<N>.json`) there: the waiver filename matches
  no protected basename, and `review-proof-guard.mjs` judges only the spelled path. The production guard now
  refuses a destination that is spelled outside the state directory but resolves into it. A destination
  spelled inside it stays with `review-proof-guard.mjs`, which keeps its single acknowledgment-file exception.
- **P2.** Two test cases assumed Windows path rules (`C:/Users/...` and a backslash UNC path are relative names
  elsewhere), which would fail the Linux CI job. Those cases now run only on Windows.
