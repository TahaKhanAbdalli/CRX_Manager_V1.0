## 2026-10-22 — the migration landing gate checks the waiver's repository too

- `migration-landing-gate-lib.mjs` now reads the PR's `url` and passes its number to the CodeRabbit waiver lookup only
  when the PR is in `masonwells1/CRX_Manager_V1.0`, like both merge gates. `GH_REPO` or a fork's remote could point
  `gh` at another repository whose PR numbers overlap, and a waiver for CRX #N would then have excused that PR's
  missing review before its migration applied (Codex App P2 on PR #1035). An unreadable `url` gets no waiver.
