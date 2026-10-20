## 2026-10-20 - Cost step 2 (#965) merged before its migration was applied

- PR #965 merged into `main` at 17:39 UTC (12:39 PM Central) before
  `20261019230000_cost_margin_admin_only_screens_step2` was applied, so the new screens briefly
  called `get_admin_cost_fields` and `get_quote_versions`, which the live database did not have yet.
- The migration landing gate refuses to apply for a PR that is no longer open, so PR #976 carried
  the apply: it was the open PR whose head contained the already-merged, byte-identical migration file
  (LF sha256 `54a39a53c179340262aad0a8a441636accb6beb880467f59ee7bd6f2b7afa4a8`). It changed no code.
- The apply followed the normal gated path, in this order: green checks, a fresh exact-head Sol
  review, Mason's "I approve" for that PR's head, then the live apply while #976 was still open,
  and only then the merge. Merging first would have closed the carrying PR and the gate would have
  refused the apply again.
- Done: applied live 2026-10-20 19:36:10 UTC (2:36 PM Central, ledger `20261020193610`); #976 merged
  35 seconds later, at 19:36:45 UTC, as `2c448ce4e`.
