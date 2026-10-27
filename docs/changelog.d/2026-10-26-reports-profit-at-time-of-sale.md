## 2026-10-26 — Reports profitability uses the cost at the time of sale (To-Do 0.6)

No database change. Admins only, as before.

- Reports > Profitability **By Customer**, **By Product** and **Revenue Summary** now read
  `get_profitability_report` (grouped by customer, product and month) instead of adding up the stored
  `orders.total_profit` / `order_items.profit` in the browser. Each line uses the cost saved when it was
  sold (`cost_at_time_cents`), the same rule as the Sales Reports and the Financial Dashboard.
- Numbers change: By Product no longer counts lines on cancelled, voided or deleted orders (the old read
  of order lines had no status or deleted filter), which can lower its totals noticeably; every tab
  leaves out unpriced rush lines and takes each line's cost from when it was sold; and an order with no
  order date falls in the month it was created. The orders counted are the same confirmed, partially
  fulfilled and fulfilled ones as before.
- The report is read page by page (ordered by its group key) and a failed page shows an error, never part
  of the report; the order tables are no longer read for these tabs.
- Tests: `Reports.paging.test.tsx` covers 1,500 customer groups across two pages, the date range reaching
  the report, all three groupings, and a failed page. Checked in the running app on 2026-10-26.
- Closes KNOWN_ISSUES KI-15 and the rest of To-Do 0.6 once live; those two records are updated in the
  session's records PR, not here (every queued PR edits them).
