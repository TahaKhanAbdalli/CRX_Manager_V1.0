## 2026-10-28 — App repo moved to the `croprxsolutions` GitHub organization

- Mason transferred the repo from `masonwells1/CRX_Manager_V1.0` to `croprxsolutions/CRX_Manager_V1.0` (step 4 of `docs/operations/github-org-move.md`). The repo stays public and the old address redirects.
- After-move check against the recorded baseline: the six Actions secrets, both environments (`Preview`, `Production`), no variables, webhooks or deploy keys, ruleset `protect-main` active with required checks `Vercel`, `Lint, Type Check, Test, Build` and `SQL Migration Validation`, and `only-mason-merges-main` still disabled all came across unchanged.
- CodeQL's default setup read `not-configured` after the move, although CodeQL had analyzed `main` earlier the same morning; it needs turning back on.
- This entry's own pull request is the test that every required check, including `Vercel`, still runs from the new address.
