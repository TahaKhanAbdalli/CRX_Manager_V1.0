## 2026-10-20 — replay-binding batch 3b: ledger capture after cost step 2 applied

- The migration-history page now leads with a read-only ledger capture from 2026-10-20 19:37 UTC,
  taken after `20261019230000_cost_margin_admin_only_screens_step2` was applied (1038 rows, highest
  name timestamp `20261019230000`). Batch 3b's `20261019235000` still sorts strictly above it, so
  it applies after cost step 2 as intended.
