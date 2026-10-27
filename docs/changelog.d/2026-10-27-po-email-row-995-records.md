## 2026-10-27 — Row 995 (purchase order email type) records

- `docs/reference/migration-history.md` row 995 names the real file, `20261027070000_email_type_purchase_order.sql` (it named a `20261027045000_…` file that does not exist). This PR also carries the live apply of that migration (To-Do 0.15, PR #1114) and its record.
- Row 995 applied live 2026-10-27 18:59:37 UTC (ledger `20261027185937`) from this PR's head; `docs/reference/migration-history.md` and `docs/manual/CURRENT_STATE.md` record it. The email log now accepts the `purchase_order` type. The `send-email` deploy that sends PO copies still waits for Mason's yes.
