## 2026-10-20 — Accounts Receivable summary strip asks for Chicago's date, not UTC's

The "Net Money Position" strip at the top of Accounts Receivable asked `get_ar_aging` for
`new Date().toISOString().slice(0, 10)`, a UTC date. From about 7pm Central UTC is already
tomorrow, so in the evening the strip asked for tomorrow's aging while the AR Aging table
under it (which used the browser's own date) asked for today's, and the two could disagree.

- `src/pages/AccountsReceivable.tsx`: the strip now uses `todayInBusinessTz()` (Chicago). Its
  paged read (every row, `count: 'exact'`, largest balance first then customer id) is unchanged.
- `src/pages/ARaging.tsx`: the table's default as-of date also uses `todayInBusinessTz()`, so the
  strip and the table ask for the same day whatever the viewer's computer clock says. The date
  box is still editable. Batch Print, and Print Statement opened from an aging row, now start on
  that same date (they used the browser's date, while Email Statements uses the table's date), and
  start afresh whenever the table's date is changed. Print Statement opened from the Customer
  Statement tab starts on that tab's end date, so the PDF covers the statement on screen.
  Reminder dates and the Statement tab's own date range are unchanged.
- `src/pages/AccountsReceivable.businessDate.test.tsx`: pins the clock to 8:30pm Central with the
  computer set to UTC and checks the strip, the table, both together, and the Batch Print
  pop-up all start on 2026-10-20. Each check fails if its screen goes back to its old clock.
- `docs/manual/KNOWN_ISSUES.md`: the UTC as-of-date note no longer lists the strip.
  `CustomerContextCard.tsx` still sends a UTC as-of date and stays listed there (follow-up).

Screen-only; no database change.
