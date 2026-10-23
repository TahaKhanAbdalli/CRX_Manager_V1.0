## 2026-10-23 — quote, order, delivery and return screens say a failed load could not be loaded (To-Do 10.5, second money PR)

- **Quote Builder:** a saved quote whose first load failed showed an empty form whose Save still
  pointed at the real quote, so picking a customer, adding a line and saving could replace its real
  sections and lines. It now shows "This quote could not be loaded" with Try again, and Save refuses
  until that quote has loaded. A sections or lines read that answers with no list counts as failed
  (it used to install an empty quote). A unit-conversion read with no list counts as failed too: lines
  would otherwise convert at a factor of 1. A failed booking settlement says so instead of hiding the
  booked / drawn / remaining card. A failed switch from one saved quote to another now shows the
  failed state too: it used to keep the first quote's form under the second quote's address, where
  Save was refused but Close and Revert were still offered and would have acted on the second quote.
- **Quotes:** a failed list said "No quotes yet"; a failed open-booking rollover said "No open
  bookings." Both now show the failed state with Try again.
- **Orders:** a failed list said "No orders yet"; a failed order-lines or deliveries read showed
  every order at 0% fulfilled with nothing scheduled; a failed farm-group read dropped the labels.
  All now fail the list with Try again. The shared invoice-coverage read
  (`src/lib/deliveryInvoiceCoverage.ts`, also used by Office Cockpit and the integrity panel) treats
  a page with no list as a failed read, so "Invoiced" says unavailable instead of 0%.
- **Quotes:** only the newest open-booking rollover read may set its rows.
- **Delivery Detail:** a failed lines read showed the delivery with no lines, where Edit offers every
  order line as new and saves over the real ones; a failed invoices read hid the invoices and could
  offer Create Invoice for a delivery already billed; a failed delivery read said "Delivery not
  found". Each now shows "This delivery could not be loaded" with Try again, as does a completed
  delivery whose remaining items fail to load. The order, invoices, sibling deliveries, quote link
  and remaining items are cleared on a move to another delivery, and only the newest load of a
  delivery may publish (an older failed refresh can no longer hide a newer page).
- **Returns:** a failed list said "No returns yet". A return whose lines failed showed an empty list
  and a $0 credit with Approve, Receive and Issue Credit still offered; it now shows the failed state
  with Try again and no actions until the lines load.
- **New Delivery:** a failed address read was silent, so the delivery was created with no address. It
  now says the addresses could not be loaded, with Retry, and Schedule Delivery stays off. After any
  failed order load the lines box says the items are not shown, not "No items found on this order".
- **Delivery Remainders:** a failed list said "No remainders" under 0 pending; the counts are hidden
  and the list shows the failed state with Try again. **Deliveries** already said a failed list could
  not be loaded; a read that answers with no list now does too.
- Every paged read on these screens uses `pageWithList`, so a page with no list fails the read.
- Not changed (low risk, left for later): empty pickers and dropdowns, hidden badges (email sent,
  planned holds, sibling deliveries), skipped warnings (duplicate order, credit limit, low stock).
  Bulk Quote Import already refuses any line whose unit has no conversion, so it needs no change.
- Proof: forced each failure against a local fake Supabase server in the dev app and watched the
  failed state, then Try again showing the record. New tests
  (`src/pages/QuotesOrdersDeliveries.loadFailed.test.tsx`, `src/pages/DeliveryDetail.loadFailed.test.tsx`,
  `src/pages/NewDelivery.loadFailed.test.tsx`, and a `QuoteBuilder load failures` block in
  `src/pages/QuoteBuilder.test.tsx`) fail on the old code: 26 of 26 checked.
