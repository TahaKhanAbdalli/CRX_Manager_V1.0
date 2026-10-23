## 2026-10-23 - Recorded: payment-allocation tables lost direct Data API writes (row 970 live)

- Migration `20261022040000_payment_allocation_tables_no_direct_writes` (migration-history row 970, PR #1026, merged
  as `c5f596285`) was applied live 2026-10-23 03:33:11 UTC (10:33 PM Central, 2026-10-22), ledger version
  `20261023033311`, on Mason's in-chat `I approve`.
- Read-only live check 03:52 UTC: on `allocation_sets`, `invoice_line_allocations` and `order_line_allocations`,
  `anon` and `authenticated` hold only SELECT, with no column write privileges; `service_role` keeps its writes; only
  the three SELECT policies remain. A sales rep can no longer insert a payment-allocation row directly.
- Row 970, the `CURRENT_STATE.md` and `KNOWN_ISSUES.md` ledger headers, and the schema registry now reflect live.
