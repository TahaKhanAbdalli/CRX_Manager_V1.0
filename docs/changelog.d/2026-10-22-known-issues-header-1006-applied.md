## 2026-10-22 — KNOWN_ISSUES header records PR #1006 as applied

- `docs/manual/KNOWN_ISSUES.md`'s "Last verified" line still called
  `20261022021000_order_invoice_refuses_field_split` (row 967, PR #1006) a pending candidate. It
  now records the live read-only check of 2026-10-22 16:35 UTC: 1049 ledger rows, `max(version)`
  `20261022163441` for that migration, applied before #1006 merged as `afe1dadb5`. Documentation
  only; row 967 and the schema registry were already updated by #1033.
