## 2026-10-23 — A/R and payment screens say a failed load could not be loaded (To-Do 10.5, first money PR)

- **A/R Workspace:** a failed money-summary read showed nothing at all; it now says "The money
  summary could not be loaded" with Try again.
- **A/R Aging:** a failed customer statement said "Select a customer and date range…"; a failed
  season comparison kept the previous seasons' figures under the new labels (and an older reply
  could overwrite a newer one). Both now show the failed state with Try again; the aging tab's
  own failure message gains Try again.
- **Payment History:** a failed list read said "No payments yet" under $0 totals; opening a
  payment whose allocations failed kept the previously opened payment's invoices. The totals are
  hidden and CSV export is off after a failed read; the allocations show their own failed state,
  and only the latest opened payment's reply is used.
- **Prepay Manager:** the same previous-customer problem for a customer's individual credits
  (shown with Edit and Delete); fixed the same way. A failed bucket-label read now says so under
  the bucket pickers.
- **Record Payments:** a failed customer search showed no dropdown at all; it now says "Customer
  search failed" with Try again. Failed open invoices gain Try again.
- **Customer Transactions** and **Prepay Workspace:** a failed customer dropdown says so with Try
  again; the transaction and per-customer failures gain Try again. Customer Transactions no longer
  shows (or exports) the previous customer's totals while the next one loads, and clearing the
  customer clears the rows and any failed state.
- Payment History closes an open payment's allocations when the list read fails; Payment History
  and Prepay Manager hide their $0 summary cards while loading; a malformed bucket-label setting
  shows the failed note instead of throwing.
- Proof: forced each failure against a local fake Supabase server in the dev app and watched the
  failed state, then Try again showing the list. New tests (`src/pages/ARPayments.loadFailed.test.tsx`,
  `src/components/prepay/PrepayPanels.loadFailed.test.tsx`) fail on the old code.
- New `pageWithList` (`src/lib/pagedRead.ts`): wraps one page of a `fetchAllRows` read so a page
  that answers with no list (and no error) fails the read instead of counting as empty. Every paged
  read on these screens uses it. `fetchAllRows` itself is unchanged, so other screens still read
  such a page as empty; changing it for every caller is left for its own PR.
