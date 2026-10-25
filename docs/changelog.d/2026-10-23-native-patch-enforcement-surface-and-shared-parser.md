## 2026-10-23 - native patch: enforcement-surface files stay denied; one shared parser

Sol gate review of PR #1083 (HIGH). The native `apply_patch` route checked destinations only against
the production guard's short protected list. A patch under `tool_input.command` aimed at another file
that decides whether the gates run (for example `.claude/hooks/migration-apply-guard.mjs`, `.husky/pre-push`,
`.github/workflows/*`, `.coderabbit.yaml`, `scripts/check-*`) was allowed, while every older patch
shape and the unfixed guard denied it. Measured with the full hook chain before the fix: allowed; after:
denied by both the production guard and `review-proof-guard.mjs`.

- The patch parser and envelope check moved to the shared `.claude/hooks/codex-push-lib.mjs`
  (`parseNativePatch`, `nativePatchEnvelope`, plus `ENFORCEMENT_SURFACE_PATH_RE`, which
  `review-proof-guard.mjs` used to hold inline). The production guard re-exports the parsers so its
  tests are unchanged.
- The production guard now also refuses native-patch destinations on the enforcement surface, as spelled
  and as reached through a symlink or junction.
- `review-proof-guard.mjs` now reads the same envelope: a complete patch contributes its destinations to
  the path checks (proof files, state directory, enforcement surface) and skips the shell scans, so a
  documentation patch that names a proof file in prose is no longer refused there; a malformed or
  conflicting `apply_patch` envelope is refused. A shell or MCP tool carrying patch text is still scanned
  as a shell command.
- Tests in both suites; each new safeguard was disabled in a scratch copy and a suite failed.
