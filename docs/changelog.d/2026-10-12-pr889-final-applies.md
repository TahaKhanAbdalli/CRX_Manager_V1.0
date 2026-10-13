## 2026-10-12 - PR #889's last two migrations applied live

- `20261007150200_release_reservations_of_deleted_spring_orders` applied at 23:41 UTC (ledger
  `20261012234157`) after Mason's in-chat yes and his `approve <code>` reply. It released the stock
  still reserved by the four orders deleted in spring (ORD-2026-0181/0184/0185/0187) and by the
  deleted test order ORD-2026-0345; every one of the 28 products now reserves exactly what live open
  orders owe. On-hand stock was not changed.
- `20261010120000_cap_delivery_invoice_at_delivered` applied at 23:46 UTC (ledger
  `20261012234633`): a delivery invoice can bill only what its delivery delivered, and an order is
  billed per delivery or whole-order, never both. Its preflight found nothing already over the cap.
- Records updated: migration-history rows 941 and 942, a fresh row-by-row ledger capture, CURRENT_STATE,
  KNOWN_ISSUES, the schema registry and `src/types/supabase.ts`. All 29 db-invariant sweeps passed.
