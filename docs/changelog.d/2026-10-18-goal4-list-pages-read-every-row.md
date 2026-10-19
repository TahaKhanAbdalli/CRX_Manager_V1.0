## 2026-10-18 — List pages read every record instead of silently stopping at 500–2,000 (Goal 4, part 1)

Screen-only change; no database change.

- **What was wrong.** Fifteen list pages read their records in one request capped at 200, 500 or
  2,000 rows, or with no cap at all, which still meant the server's silent 1,000-row cap. Past that,
  records disappeared from the list, its filters and its totals with no warning (Orders and Invoices
  only showed a toast that disappeared after a few seconds). Live volumes on 2026-10-18 were far
  below every cap (58 orders, 34 purchase orders, 151 active customers), so nothing was being lost yet.
- **The fix.** `src/lib/pagedRead.ts` holds the shared pager. `fetchAllRows` (moved from
  `reconciliation.ts`, which re-exports it) reads 1,000 rows at a time until the end. Each paged
  query adds `id` as its last sort key, so the row order is stable between pages. `fetchAllRowsForIds` sends a long id
  list in chunks of 200 and pages each chunk. Any failed page returns the error, so a page never shows
  a short list as if it were complete. The old "Showing first N" toasts are gone.
- **Pages:** Invoices, Orders (including its print and pick-list reads), Quotes, Blend Tickets,
  Purchase Orders (and outstanding items), Vendor Bills, Returns, Vendors, Application Records,
  Delivery Remainders, Customer Transaction Review, Commission Payments, Payment History, To Ship
  and Rebates.
- **Totals now complete:** the Invoices cards, the Vendor Bills status cards, Purchase Orders'
  outstanding value, Customer Transaction Review's debits, credits and ending balance, To Ship's
  owed amounts, and the unpaid-commission total.
- **Commission Payments item counts.** One paged read of the payment items replaces one count
  request per payment. If that read fails, every row's count shows as unverified and Post stays
  disabled on all of them (before, only the failed row was disabled).
- **Rows moving during a load (Luna and GPT-6.1 Sol advisory reviews).** Pages are separate
  requests. A record added ahead of the read position would repeat the row at the page seam, and
  rows with an `id` are now kept once. A record deleted ahead of it would skip a row, so when every
  row has an `id`, each page after the first starts 50 rows early. Up to 50 deletions between two
  pages therefore miss nothing. Orders' item, delivery and inventory lookups now select `id` so this
  applies to them. Customer Transaction Review's rows come from a database function and have no
  `id`, so they page without the overlap.
- **Every read is checked against the server's count (review round 2).**
  - Each list read asks for the exact row count. If the distinct rows read don't match it, the list
    changed mid-read: a record's sort date edited into the part already read, or a burst of
    inserts. The read is repeated up to three times, then shown as "The list changed while it was
    loading", never as a wrong list. `src/lib/pagedReadCallSites.test.ts` fails if a list read
    leaves the count out.
  - Customer Transaction Review also checks that each row's running balance equals the sum so far
    (`src/lib/transactionLedger.ts`, matching the live `get_customer_transaction_review`), and
    re-reads once if not.
- **Stale loads can't overwrite newer ones.** Each converted list ignores a load that finished after
  a newer one started, for example a refresh after posting.
- **Failures are visible.**
  - To Ship's open-delivery and inbound purchase-order reads, the customer lists on Returns,
    Application Records and Customer Transaction Review, the Orders print buttons, and Quotes'
    product-name search now show an error instead of an empty list.
  - Customer Transaction Review shows "Transactions could not be loaded" instead of "No
    transactions".
  - Purchase Orders' Outstanding tab no longer re-reads forever when empty or failed, and it
    retries when reopened after a failure.
- **Not in this change — follow-up:** Deliveries and Reports / Sales Reports keep their caps for now,
  because open PRs #954, #955 and #957 change those files. They get the same fix after those land.
  Recorded in `docs/manual/KNOWN_ISSUES.md` (list-page row caps) and under Goal 4 in
  `docs/plans/2026-10-13-direction-and-goals.md`.
