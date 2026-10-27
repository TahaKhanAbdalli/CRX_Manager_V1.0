## 2026-10-27 — GitHub org move prep: Luna round 1 fixes

- `coderabbit-skip-lib.mjs` no longer exports the single printed repo address, so no caller can use it as the app-repo identity check in place of `isSkipRepository` (which accepts both owners).
- `docs/operations/github-org-move.md` step 1: create the organization early to claim the name (Luna round 2 asked what happens if someone else registers it first; a waiver for a look-alike repo there cannot merge anything, because the agents' GitHub login has no write access to it).
- `docs/operations/github-org-move.md` step 2: keep the organization's OAuth app restrictions on and approve GitHub CLI only, instead of offering "No restrictions".
