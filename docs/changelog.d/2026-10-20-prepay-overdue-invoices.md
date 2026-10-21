## 2026-10-20 — the prepay screens count overdue invoices

- **Problem.** The Prepayment Manager's unpaid-invoice totals and the prepay workspace's Apply step
  read only `posted` invoices. The daily cron job `mark-overdue-invoices` (06:00 UTC, 1 AM Central)
  flips a past-due posted invoice to `overdue`. So a prepay customer's past-due invoices dropped out
  of the manager's totals and could not be picked in the Apply step. Payment Allocation already had
  this fix (U1 #41). The gap was first listed in the 2026-10-15 Goal 4 audit and raised again by the
  compliance reviewer on PR #988.
- **Check before the change (live, read-only).** The Apply step saves through `batch_apply_prepayments`,
  which applies each line through `apply_prepay_to_invoice`. Its body accepts `posted` or `overdue`
  invoices and refuses anything else. The manager's two bulk-apply functions,
  `apply_remaining_prepayments` and `batch_apply_all_prepayments`, read `posted` only. Both raise
  `PREPAY_BULK_APPLY_DISABLED` as their first statement, and their "Quick" and "Apply All" buttons
  are already greyed out.
- **Change.** `PrepaymentManagerPanel.tsx` and `PrepayWorkspacePanel.tsx` read
  `status in ('posted', 'overdue')`. The paged reads from PR #988 are unchanged. No database change.
- **Proof.**
  - `src/pages/MoneyScreens.paging.test.tsx` has two new tests. Each screen gets one invoice in each
    status that can carry a balance: posted, overdue, voided, draft, unposted and cancelled.
  - Both tests fail on the old `posted`-only reads.
  - With the fix, the manager counts 2 invoices and $3.00. The workspace's Apply box offers the posted
    and overdue invoices and none of the others.
  - The new filter was run read-only against live on 2026-10-20. It finds 2 unpaid invoices
    ($41,737.40), both overdue. The old filter found 0. The invoice status constraint allows both
    values.
  - Both of those customers have no prepay balance today, so the live screens look the same until a
    prepay customer's invoice goes past due.
- **Not changed (follow-ups).**
  - The manager's "Potential Auto-Apply … can be applied now" card shows the smaller of total prepay
    and total unpaid across all customers. That overstates what could be applied: it should add up
    each customer's own smaller figure. It also says "now" while bulk apply is disabled. The "Apply
    All" confirm box has the same figure.
  - If the two bulk functions are ever turned back on, they must also take `overdue` invoices.
    Otherwise their confirm boxes, which now include overdue, would promise more than they apply.
