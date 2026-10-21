## 2026-10-21 — the Prepayment Manager's potential-apply figure adds up each customer

- **Problem.** The Prepayment Manager's "Potential Auto-Apply" card showed the smaller of total
  prepay and total unpaid across all customers, labelled "can be applied now". A customer's prepay
  can only pay that customer's own invoices, so this overstated it: customer A with $100 prepay and
  nothing owed plus customer B with $1 prepay owing $100 showed $100.00, though only $1.00 could
  apply. It also said "now" while one-click and bulk apply are switched off
  (`apply_remaining_prepayments` and `batch_apply_all_prepayments` raise
  `PREPAY_BULK_APPLY_DISABLED`, and their "Quick" and "Apply All" buttons are greyed out). The
  "Apply All" confirm box showed the same figure. Raised by the compliance reviewer on the 2026-10-20
  prepay overdue-invoices fix.
- **Change.** `PrepaymentManagerPanel.tsx` adds up each customer's smaller of prepay balance and
  unpaid balance, and both the card and the confirm box show that. The card is now "Potential Apply",
  "could be applied (one-click apply is off; use Allocate)". The confirm box cannot be opened while
  "Apply All" is disabled; its figure is fixed so it is right if the button returns.
  `docs/reference/pages-routes.md` no longer calls the Manager tab "auto-apply". Screen only; no
  database change.
- **Proof.** Two new tests in `src/pages/MoneyScreens.paging.test.tsx`. The first loads customers A
  and B above: it failed on the old screen, which showed $100.00, and passes with the fix, which
  shows $1.00 and no "applied now" wording. The second has both customers owing (A: $100 prepay,
  $10 owed; B: $1 prepay, $100 overdue): it failed on the old screen, which showed $101.00, and
  passes with the fix, which shows $11.00. The rest of that file still passes.
