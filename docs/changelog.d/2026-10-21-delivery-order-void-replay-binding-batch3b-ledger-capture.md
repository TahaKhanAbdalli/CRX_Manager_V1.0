## 2026-10-21 — replay-binding batch 3b: pre-apply ledger re-read after main moved

- The migration-history page now leads with a 02:11 UTC read-only ledger capture, taken after
  main moved (schema-registry refresh, no database change). Nothing changed live since the 21:58 UTC
  capture, there are still zero replay receipts for the three bound operations, and no draft invoice
  carries a recorded payment, prepay, write-off or credit.
