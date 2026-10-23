## 2026-10-22 — "skip coderabbit" now waives ONE named PR, not a whole session

- Mason (2026-10-22): "make sure we set that up for the Per PR version before merge, dont grant that session 24 free on
  any other pr." The command is now `skip coderabbit #<PR>` (a short list names each); a waiver file is per session AND
  per PR (`coderabbit-skip-<session>-pr<N>.json`, purpose `crx-coderabbit-skip-v2`), and `skip coderabbit` with no PR
  number records nothing.
- Both merge gates and the migration landing gate look the waiver up for the PR number GitHub returns for the PR being
  merged or applied, so a waiver for one PR never reaches another. `use coderabbit` cancels every waiver of the session.
- Docs (`AGENTS.md`, `docs/reference/coderabbit-native-review.md`, `docs/reference/agent-guardrails.md`) describe the
  per-PR form and note that hooks load from the main `C:/CRX_Manager` checkout, which must be fast-forwarded after merge.
