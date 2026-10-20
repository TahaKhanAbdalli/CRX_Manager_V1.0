## 2026-10-19 - start_and_complete_delivery is live; its actor-forgery scanner flag is a reviewed exception

- **Applied live** `20261019220000_start_and_complete_delivery`: ledger version `20261020022222` at
  02:22:22 UTC on 2026-10-20 (9:22 PM Central on 2026-10-19). It went in through the gated
  `apply-migration-file.mjs` and BEFORE the exact-head merge of PR #964 (`b0cd83b0a`). The
  pg_proc read-back shows SECURITY DEFINER, `search_path=public, pg_temp`, owner postgres,
  EXECUTE for authenticated only, and the one-year bound after the receipt lookup. The live
  Deliveries bundle calls `start_and_complete_delivery`. Records updated: KNOWN_ISSUES, the goals
  doc, and migration-history row 955 plus a new live capture.
- **Post-apply sweeps:** 28 of 29 predicates ran. `quote-versions-rpc-owned` did not run because
  the permission layer declined it, so this is not a complete gate pass. The new function appeared
  only in `actor-forgery`, flagged on `p_signed_by`, the receiver's printed name, not a user
  identity. That is the same shape as the reviewed `complete_delivery` exception. A
  fingerprint-bound allowlist entry now covers it, pinned to the live contracts of the function,
  `confirm_delivery`, `complete_delivery`, the two private bodies behind `complete_delivery`
  that hold its authorization (`_complete_delivery_replay_impl_20261015`,
  `_complete_delivery_period_preflight_impl`), and `auth.uid()`. The allowlist test count is 22. Four other
  `actor-forgery` rows are pre-existing and untouched by this change: three `p_group_by` report
  functions (one never reviewed, two with drifted pins) and `save_quote` with a drifted pin. They
  are left visible for their own review.
