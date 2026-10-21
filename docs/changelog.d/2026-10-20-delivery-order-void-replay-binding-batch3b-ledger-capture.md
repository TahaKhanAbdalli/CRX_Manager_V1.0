## 2026-10-20 — replay-binding batch 3b: fresh live ledger capture (not yet applied)

- The migration-history page now leads with a read-only ledger capture from 2026-10-20 13:06 UTC
  (1037 rows, highest name timestamp `20261019220000`). The migration-drift reviewer requires a
  capture taken after this candidate was written before it will clear an apply; the previous newest
  capture predated it. Row 956's `20261019235000` sorts above that high-water.
