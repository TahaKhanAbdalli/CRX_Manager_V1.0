## 2026-10-22 - split billing to field owners and split-payer returns are live

- Migrations `20261021150000_split_invoice_cross_customer_lineage` (ledger `20261022114024`) and
  `20261021155000_split_payer_return_credit` (ledger `20261022115547`) were applied live with Mason's
  in-chat approval before PR #1010 merged (`d8dd88a6d`). Migration history rows 964 and 965 now say so.
  A split order can now bill a field owner who is not the order's customer, and that owner can return
  its billed share and receive its own return credit.
