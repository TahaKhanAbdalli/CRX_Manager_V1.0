## 2026-10-25 — Order page no longer tells reps a paid order is unbilled

- `src/pages/OrderDetail.tsx`: non-admins can only see invoices they created or are the salesman on
  (invoices RLS), so the AR strip showed "Total Invoiced $0.00 / Amount Paid $0.00" on orders the
  office had billed and collected in full. With no visible invoices a non-admin now sees "You can't
  view any invoices for this order. Ask the office whether it has been billed or paid." (true whether
  the order is unbilled or billed by someone else — the app cannot tell which); with some, the tiles
  stay with a note that they cover only the user's own invoices. Admins see no change.
- `src/components/ui/TransactionThread.tsx`: optional `invoicesMayBeHidden` prop; the order page sets
  it for non-admins so the trail reads "No invoices you can view" instead of "No invoices".
- Why: found in the 2026-10-25 cost-lock rep pass (ORD-2026-0486 showed $0.00 to [E2E] Test Rep);
  Mason: "fix the rep invoice display". Display only — no data, money math or permission change.
- Proof: `OrderDetail.repInvoiceTotals.test.tsx` (admin / rep with none / rep with some) and a
  `TransactionThread` case, plus the rep view on the PR preview.
