## 2026-10-20 — replay-binding batch 3b: pre-apply ledger re-read

- The migration-history page now leads with a 21:58 UTC read-only ledger capture, taken just before
  the apply gate re-runs. Nothing changed since the 19:37 UTC capture (1038 rows, high-water
  `20261019230000`), and there are still zero replay receipts for the three operations this
  migration binds.
