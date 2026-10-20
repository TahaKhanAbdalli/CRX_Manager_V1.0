## 2026-10-20 - Cost step 2 (#965) merged before its migration was applied

- PR #965 merged into `main` at 17:39 UTC (12:39 PM Central) before
  `20261019230000_cost_margin_admin_only_screens_step2` was applied, so the new screens briefly
  called `get_admin_cost_fields` and `get_quote_versions`, which the live database did not have yet.
- The migration landing gate refuses to apply for a PR that is no longer open, so this PR carries
  the apply: it is the open PR whose head contains the already-merged, byte-identical migration file
  (LF sha256 `54a39a53c179340262aad0a8a441636accb6beb880467f59ee7bd6f2b7afa4a8`). It changes no code.
- The apply follows the normal gated path: green checks, a fresh exact-head Sol review, Mason's
  "I approve" for this PR's head, then the merge.
