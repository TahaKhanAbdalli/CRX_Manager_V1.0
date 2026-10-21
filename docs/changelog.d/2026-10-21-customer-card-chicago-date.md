## 2026-10-21 — Customer card and customer Financials tab ask for the aging on Chicago's date

The customer card on Team Board notes asked `get_ar_aging` for
`new Date().toISOString().slice(0, 10)`, a UTC date, so from about 7pm Central its AR balance
was tomorrow's. The customer page's Financials tab asked for the browser's own date, so a computer
outside Central time could show a different balance than the Accounts Receivable pages.

- `src/components/team/CustomerContextCard.tsx`: the aging call now uses `todayInBusinessTz()`
  (Chicago), the same date the Accounts Receivable strip and AR Aging table use since #991.
- `src/pages/CustomerDetail.tsx`: the Financials tab's aging call uses `todayInBusinessTz()` too.
  The tab's 90-day statement range is unchanged.
- `src/components/team/CustomerContextCard.businessDate.test.tsx` and a new block in
  `src/pages/CustomerDetail.test.tsx`: pin the clock to 8:30pm Central with the computer set to UTC
  and check both ask for 2026-10-20. Both fail on the old code, which asked for 2026-10-21.
- `docs/manual/KNOWN_ISSUES.md`: the UTC as-of-date note no longer lists the customer card.

Screen-only; no database change.
