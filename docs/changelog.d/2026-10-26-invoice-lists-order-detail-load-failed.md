## 2026-10-26 — the invoice lists and Order Detail say a failed load could not be loaded (To-Do 10.5, fifth money PR)

- **Invoices list:** a failed refresh (for example after a void) kept the previous rows with Post,
  Void, Print and Delete still live; a read with no list showed "No invoices yet" and $0 cards; a
  read that was not a list left the skeleton up for good. Now it clears the rows and the selection
  and shows "This list could not be loaded" with Try again; the summary cards show "—".
- **Field Invoices (All, Posted, Drafts):** each panel showed "Reload to try again" with no button,
  and a read with no list showed "No … invoices" and $0. Each now shows its "could not be loaded"
  message with Try again. The Drafts / Posted tab badges show no number, not 0, when a count comes
  back missing.
- **Customer Invoice Summary:** a failed report kept the previous report on screen, or showed "No
  unposted …" and a $0 Combined Balance. It now shows "The invoice summary could not be loaded"
  with Try again, and Print is not offered.
- **Unbilled Applications:** a failed refresh kept the previous rows with Create Invoice enabled, or
  said "all caught up". It now clears the rows and shows "Unbilled applications could not be
  loaded" with Try again; only the newest read may fill the lists.
- **Finance-charge preview:** a preview read with no list said "No finance charges to generate". It
  now says the preview could not be loaded, with Try again in the window (it said to close and
  reopen).
- **Order Detail:** a failed linked-invoices read showed $0 invoiced and offered Create Invoice
  again; failed line, delivery and share reads were ignored; a failed order read said "Order not
  found". Each now shows "This order could not be loaded" with Try again. A missing order still says
  "Order not found".
- `pageWithList` (src/lib/pagedRead.ts) now also fails a page that answers with something other
  than a list; `fetchAllRows` alone threw on one.
- Not changed here: A/P, commissions, rebates, month-end and the Financial Dashboard; the
  restricted-use and credit-limit checks before Post; the address and shares on a printed invoice;
  Order Detail's related blend tickets and driver names (display only).
- Proof: `src/components/field-invoices/InvoiceLists.loadFailed.test.tsx`,
  `src/pages/Invoices.loadFailed.test.tsx`, `src/pages/OrderDetail.loadFailed.test.tsx` and new
  checks in the finance-charge, Field Invoices page and `pagedRead` tests fail on the code before
  this change. Each screen was checked in the dev app, working and failing (error, no list, not a
  list), against a local fake Supabase server.
