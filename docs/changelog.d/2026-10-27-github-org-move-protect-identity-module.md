## 2026-10-27 — Codex may not edit the app-repo identity module (Codex App P1 on PR #1149)

- `.claude/hooks/app-repo-identity.mjs` is now on the Codex production guard's protected harness list (`PROTECTED_HARNESS_SOURCE` and `PROTECTED_HARNESS_FILES`). It loads at guard startup through `codex-push-lib.mjs`, so an unprotected edit (for example a top-level `process.exit(0)`) could have silenced every later guard check.
- The guard's tests now walk startup imports transitively, not just one level, so the next library pulled in by a protected module fails the test until it is protected too.
