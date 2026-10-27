## 2026-10-26 — Price sheet warnings: Luna round 4 fix (To-Do 0.1, before apply)

From Luna round 4 on `20261026230000_price_sheet_warnings_and_approval.sql` (not yet applied):

- Approval also refuses a preview made before this migration whose per-acre rate row names no source
  (`PRICING_SOURCE_REQUIRED`: preview it again), not only one whose pricing rows have none. A preview lasts
  two hours, so this only matters right after the apply.
- Proof scenario 8 covers it.
- Not changed, stated in the migration and the PR: a quote change in the instant between apply's second
  read and its commit (closed by the sent-quote price lock, To-Do 1.2, PR #1105, which lands first); the
  product page's direct rate edit is logged but not approval-gated (a named follow-up); a manual cost-basis
  replacement names the source "Manual replacement cost" (pilot-only, supplier-evidence rollout parked);
  `rate_per_acre` is an application rate, not money.
